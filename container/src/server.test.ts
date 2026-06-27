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
});
