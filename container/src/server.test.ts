import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks (created before vi.mock factories run) ──────────────────────

const mocks = vi.hoisted(() => ({
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  cloneRepo: vi.fn(),
  createBranch: vi.fn(),
  commitAll: vi.fn(),
  pushBranch: vi.fn(),
  runEditLoop: vi.fn(),
  runCliAgent: vi.fn(),
  openPullRequest: vi.fn(),
}));

// Mock node:fs so we control the temp-dir lifecycle without touching the FS.
vi.mock("node:fs", () => ({
  promises: {
    mkdtemp: mocks.mkdtemp,
    rm: mocks.rm,
  },
}));

vi.mock("./git.js", () => ({
  cloneRepo: mocks.cloneRepo,
  createBranch: mocks.createBranch,
  commitAll: mocks.commitAll,
  pushBranch: mocks.pushBranch,
}));

vi.mock("./agent-loop.js", () => ({
  runEditLoop: mocks.runEditLoop,
}));

vi.mock("./cli-agent.js", () => ({
  runCliAgent: mocks.runCliAgent,
}));

vi.mock("./github-pr.js", () => ({
  openPullRequest: mocks.openPullRequest,
}));

// Import after mocks are declared so vi.mock hoisting applies.
import { runTask } from "./server.js";
import type { TaskPacket } from "./server.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FAKE_TMP_DIR = "/tmp/sigilix-run-test";

const TOKEN = "ghp_installation_token_abc";

function makePacket(overrides?: Partial<TaskPacket>): TaskPacket {
  return {
    runId: "run-123",
    repo: {
      owner: "acme",
      name: "my-service",
      installationToken: TOKEN,
      baseBranch: "main",
    },
    ticket: {
      identifier: "SIG-456",
      title: "Fix the critical bug",
      body: "The bug is in src/foo.ts",
      url: "https://linear.app/acme/issue/SIG-456",
    },
    model: {
      id: "z-ai/glm-5.2",
      key: "sk-model-key-never-log",
    },
    caps: { maxModelCalls: 20, maxTokens: 1_500_000, timeoutMs: 1_200_000 },
    ...overrides,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();

  // Default implementations
  mocks.mkdtemp.mockResolvedValue(FAKE_TMP_DIR);
  mocks.rm.mockResolvedValue(undefined);
  mocks.cloneRepo.mockResolvedValue(undefined);
  mocks.createBranch.mockResolvedValue(undefined);
  mocks.commitAll.mockResolvedValue({ committed: true });
  mocks.pushBranch.mockResolvedValue(undefined);
  mocks.runCliAgent.mockResolvedValue({ changed: false, modelCalls: 0, tokens: 0, stoppedReason: "done" });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runTask", () => {
  // ── opened path ─────────────────────────────────────────────────────────────

  it("returns status 'opened' with prUrl when the loop makes changes", async () => {
    mocks.runEditLoop.mockResolvedValue({
      changed: true,
      modelCalls: 5,
      tokens: 1000,
      stoppedReason: "done",
    });
    mocks.openPullRequest.mockResolvedValue({
      url: "https://github.com/acme/my-service/pull/42",
      number: 42,
    });

    const result = await runTask(makePacket());

    expect(result.status).toBe("opened");
    expect(result.prUrl).toBe("https://github.com/acme/my-service/pull/42");
    expect(result.runId).toBe("run-123");
    expect(result.modelCalls).toBe(5);
    expect(result.tokens).toBe(1000);
    expect(result.stoppedReason).toBe("done");
    expect(result.error).toBeUndefined();
  });

  it("calls clone, createBranch, runEditLoop, commitAll, pushBranch, openPullRequest in the opened path", async () => {
    mocks.runEditLoop.mockResolvedValue({
      changed: true,
      modelCalls: 1,
      tokens: 100,
      stoppedReason: "done",
    });
    mocks.openPullRequest.mockResolvedValue({
      url: "https://github.com/acme/my-service/pull/1",
      number: 1,
    });

    await runTask(makePacket());

    expect(mocks.cloneRepo).toHaveBeenCalledOnce();
    expect(mocks.createBranch).toHaveBeenCalledOnce();
    expect(mocks.runEditLoop).toHaveBeenCalledOnce();
    expect(mocks.commitAll).toHaveBeenCalledOnce();
    expect(mocks.pushBranch).toHaveBeenCalledOnce();
    expect(mocks.openPullRequest).toHaveBeenCalledOnce();
  });

  it("creates the branch named sigilix/<ticket.identifier>", async () => {
    mocks.runEditLoop.mockResolvedValue({
      changed: true,
      modelCalls: 1,
      tokens: 50,
      stoppedReason: "done",
    });
    mocks.openPullRequest.mockResolvedValue({
      url: "https://github.com/acme/my-service/pull/1",
      number: 1,
    });

    await runTask(makePacket());

    expect(mocks.createBranch).toHaveBeenCalledWith(FAKE_TMP_DIR, "sigilix/SIG-456");
  });

  it("opens the PR with the correct owner, repo, head, and base", async () => {
    mocks.runEditLoop.mockResolvedValue({
      changed: true,
      modelCalls: 1,
      tokens: 50,
      stoppedReason: "done",
    });
    mocks.openPullRequest.mockResolvedValue({
      url: "https://github.com/acme/my-service/pull/1",
      number: 1,
    });

    await runTask(makePacket());

    expect(mocks.openPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "my-service",
        head: "sigilix/SIG-456",
        base: "main",
      }),
    );
  });

  it("includes the ticket URL in the PR body as provenance", async () => {
    mocks.runEditLoop.mockResolvedValue({
      changed: true,
      modelCalls: 1,
      tokens: 50,
      stoppedReason: "done",
    });
    mocks.openPullRequest.mockResolvedValue({
      url: "https://github.com/acme/my-service/pull/1",
      number: 1,
    });

    await runTask(makePacket());

    const { body } = (mocks.openPullRequest.mock.calls[0] as [{ body: string }])[0];
    expect(body).toContain("https://linear.app/acme/issue/SIG-456");
  });

  it("cleans up the temp dir after a successful run", async () => {
    mocks.runEditLoop.mockResolvedValue({
      changed: true,
      modelCalls: 1,
      tokens: 50,
      stoppedReason: "done",
    });
    mocks.openPullRequest.mockResolvedValue({
      url: "https://github.com/acme/my-service/pull/1",
      number: 1,
    });

    await runTask(makePacket());

    expect(mocks.rm).toHaveBeenCalledWith(FAKE_TMP_DIR, { recursive: true, force: true });
  });

  // ── no-change path ───────────────────────────────────────────────────────────

  it("returns status 'no-change' when the loop makes no changes", async () => {
    mocks.runEditLoop.mockResolvedValue({
      changed: false,
      modelCalls: 3,
      tokens: 500,
      stoppedReason: "cap-calls",
    });

    const result = await runTask(makePacket());

    expect(result.status).toBe("no-change");
    expect(result.prUrl).toBeUndefined();
    expect(result.modelCalls).toBe(3);
    expect(result.tokens).toBe(500);
    expect(result.stoppedReason).toBe("cap-calls");
  });

  it("does NOT call openPullRequest in the no-change path", async () => {
    mocks.runEditLoop.mockResolvedValue({
      changed: false,
      modelCalls: 2,
      tokens: 200,
      stoppedReason: "done",
    });

    await runTask(makePacket());

    expect(mocks.openPullRequest).not.toHaveBeenCalled();
  });

  it("does NOT call commitAll or pushBranch in the no-change path", async () => {
    mocks.runEditLoop.mockResolvedValue({
      changed: false,
      modelCalls: 1,
      tokens: 100,
      stoppedReason: "done",
    });

    await runTask(makePacket());

    expect(mocks.commitAll).not.toHaveBeenCalled();
    expect(mocks.pushBranch).not.toHaveBeenCalled();
  });

  // ── no-change via commitAll ──────────────────────────────────────────────────

  it("returns status 'no-change' when loop reports changed but commitAll finds a clean tree", async () => {
    mocks.runEditLoop.mockResolvedValue({
      changed: true,
      modelCalls: 3,
      tokens: 600,
      stoppedReason: "done",
    });
    mocks.commitAll.mockResolvedValue({ committed: false });

    const result = await runTask(makePacket());

    expect(result.status).toBe("no-change");
    expect(result.prUrl).toBeUndefined();
    expect(result.modelCalls).toBe(3);
    expect(result.tokens).toBe(600);
    expect(result.stoppedReason).toBe("done");
  });

  it("does NOT call pushBranch or openPullRequest when commitAll returns committed:false", async () => {
    mocks.runEditLoop.mockResolvedValue({
      changed: true,
      modelCalls: 2,
      tokens: 400,
      stoppedReason: "done",
    });
    mocks.commitAll.mockResolvedValue({ committed: false });

    await runTask(makePacket());

    expect(mocks.pushBranch).not.toHaveBeenCalled();
    expect(mocks.openPullRequest).not.toHaveBeenCalled();
  });

  it("cleans up the temp dir when commitAll returns committed:false", async () => {
    mocks.runEditLoop.mockResolvedValue({
      changed: true,
      modelCalls: 1,
      tokens: 200,
      stoppedReason: "done",
    });
    mocks.commitAll.mockResolvedValue({ committed: false });

    await runTask(makePacket());

    expect(mocks.rm).toHaveBeenCalledWith(FAKE_TMP_DIR, { recursive: true, force: true });
  });

  it("cleans up the temp dir in the no-change path", async () => {
    mocks.runEditLoop.mockResolvedValue({
      changed: false,
      modelCalls: 1,
      tokens: 50,
      stoppedReason: "done",
    });

    await runTask(makePacket());

    expect(mocks.rm).toHaveBeenCalledWith(FAKE_TMP_DIR, { recursive: true, force: true });
  });

  // ── error path ───────────────────────────────────────────────────────────────

  it("returns status 'error' when clone fails", async () => {
    mocks.cloneRepo.mockRejectedValueOnce(new Error("git clone failed"));

    const result = await runTask(makePacket());

    expect(result.status).toBe("error");
    expect(result.error).toContain("git clone failed");
    expect(result.modelCalls).toBe(0);
  });

  it("returns status 'error' when pushBranch fails after a successful loop", async () => {
    mocks.runEditLoop.mockResolvedValue({
      changed: true,
      modelCalls: 4,
      tokens: 800,
      stoppedReason: "done",
    });
    mocks.pushBranch.mockRejectedValueOnce(new Error("push rejected"));

    const result = await runTask(makePacket());

    expect(result.status).toBe("error");
    expect(result.error).toContain("push rejected");
    // Preserves the loop's token count even on a post-loop error
    expect(result.modelCalls).toBe(4);
    expect(result.tokens).toBe(800);
  });

  it("redacts the installation token from error messages", async () => {
    // The mocked cloneRepo throws with the raw token in the message —
    // server.ts must redact it before returning.
    mocks.cloneRepo.mockRejectedValueOnce(
      new Error(`clone failed: remote rejected ${TOKEN} as invalid`),
    );

    const result = await runTask(makePacket());

    expect(result.status).toBe("error");
    expect(result.error).not.toContain(TOKEN);
    expect(result.error).toContain("***");
  });

  it("redacts model.key from error messages", async () => {
    const MODEL_KEY = "sk-model-key-never-log";
    // Simulate an OpenRouter error that echoes the key back in the message.
    mocks.cloneRepo.mockRejectedValueOnce(
      new Error(`API request failed: Authorization key=${MODEL_KEY} rejected`),
    );

    const result = await runTask(makePacket());

    expect(result.status).toBe("error");
    expect(result.error).not.toContain(MODEL_KEY);
    expect(result.error).toContain("***");
  });

  it("redacts every MCP capability from surfaced errors", async () => {
    const capability = "d".repeat(64);
    mocks.cloneRepo.mockRejectedValueOnce(new Error(`unexpected MCP header ${capability}`));

    const result = await runTask(
      makePacket({ mcp: { endpoint: "https://api.sigilix.ai/internal/agent-runs/r/mcp", capability } }),
    );

    expect(result.status).toBe("error");
    expect(result.error).not.toContain(capability);
    expect(result.error).toContain("***");
  });

  it("returns status 'error' (does NOT throw) when mkdtemp fails, and does NOT call rm", async () => {
    mocks.mkdtemp.mockRejectedValueOnce(new Error("EACCES: permission denied, mkdtemp"));

    const result = await runTask(makePacket());

    expect(result.status).toBe("error");
    expect(result.error).toContain("EACCES");
    // tmpDir was never created — rm must not be called (would crash on undefined).
    expect(mocks.rm).not.toHaveBeenCalled();
  });

  it("cleans up the temp dir even when a stage throws", async () => {
    mocks.cloneRepo.mockRejectedValueOnce(new Error("network error"));

    await runTask(makePacket());

    expect(mocks.rm).toHaveBeenCalledWith(FAKE_TMP_DIR, { recursive: true, force: true });
  });

  it("returns status 'error' when openPullRequest fails, and still cleans up", async () => {
    mocks.runEditLoop.mockResolvedValue({
      changed: true,
      modelCalls: 2,
      tokens: 300,
      stoppedReason: "done",
    });
    mocks.openPullRequest.mockRejectedValueOnce(new Error("GitHub API 422: already exists"));

    const result = await runTask(makePacket());

    expect(result.status).toBe("error");
    expect(result.error).toContain("422");
    expect(mocks.rm).toHaveBeenCalledWith(FAKE_TMP_DIR, { recursive: true, force: true });
  });

  // ── engine switch (SIG-545 B2) ────────────────────────────────────────────────

  it("default engine (unset) runs the minimal loop, NOT the CLI agent", async () => {
    mocks.runEditLoop.mockResolvedValue({ changed: false, modelCalls: 1, tokens: 10, stoppedReason: "done" });

    await runTask(makePacket());

    expect(mocks.runEditLoop).toHaveBeenCalledOnce();
    expect(mocks.runCliAgent).not.toHaveBeenCalled();
  });

  it('engine "minimal" runs the minimal loop, NOT the CLI agent', async () => {
    mocks.runEditLoop.mockResolvedValue({ changed: false, modelCalls: 1, tokens: 10, stoppedReason: "done" });

    await runTask(makePacket({ engine: "minimal" }));

    expect(mocks.runEditLoop).toHaveBeenCalledOnce();
    expect(mocks.runCliAgent).not.toHaveBeenCalled();
  });

  it("threads the same opaque MCP endpoint into the minimal engine", async () => {
    mocks.runEditLoop.mockResolvedValue({ changed: false, modelCalls: 1, tokens: 10, stoppedReason: "done" });
    const mcp = { endpoint: "https://api.sigilix.ai/internal/agent-runs/r/mcp", capability: "e".repeat(64) };

    await runTask(makePacket({ engine: "minimal", mcp }));

    expect(mocks.runEditLoop).toHaveBeenCalledWith(expect.objectContaining({ mcp }));
  });

  it('engine "full" runs the CLI agent, NOT the minimal loop, and forwards sigilix grounding', async () => {
    mocks.runCliAgent.mockResolvedValue({ changed: true, modelCalls: 3, tokens: 0, stoppedReason: "done" });
    mocks.openPullRequest.mockResolvedValue({ url: "https://github.com/acme/my-service/pull/7", number: 7 });

    const sigilix = { endpoint: "https://w.dev", apiKey: "sk-g", repoSlug: "acme/my-service" };
    const result = await runTask(makePacket({ engine: "full", sigilix }));

    expect(mocks.runCliAgent).toHaveBeenCalledOnce();
    expect(mocks.runEditLoop).not.toHaveBeenCalled();
    expect(mocks.runCliAgent.mock.calls[0]![0]).toMatchObject({ sigilix });
    expect(result.status).toBe("opened");
  });

  it("threads the same opaque MCP endpoint into the full engine", async () => {
    mocks.runCliAgent.mockResolvedValue({ changed: false, modelCalls: 1, tokens: 0, stoppedReason: "done" });
    const mcp = { endpoint: "https://api.sigilix.ai/internal/agent-runs/r/mcp", capability: "f".repeat(64) };

    await runTask(makePacket({ engine: "full", mcp }));

    expect(mocks.runCliAgent).toHaveBeenCalledWith(expect.objectContaining({ mcp }));
  });

  it('engine "full": a non-"done" stop (timeout) does NOT open a PR even with changes', async () => {
    // A SIGKILLed CLI run can leave a half-applied edit (changed:true) — must not become a PR.
    mocks.runCliAgent.mockResolvedValue({ changed: true, modelCalls: 2, tokens: 0, stoppedReason: "timeout" });

    const result = await runTask(makePacket({ engine: "full" }));

    expect(result.status).toBe("no-change");
    expect(mocks.commitAll).not.toHaveBeenCalled();
    expect(mocks.openPullRequest).not.toHaveBeenCalled();
  });
});
