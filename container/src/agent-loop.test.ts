import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runEditLoop } from "./agent-loop.js";
import type { EditLoopArgs } from "./agent-loop.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal OpenRouter response with tool_calls. */
function toolCallResponse(
  id: string,
  name: string,
  toolArgs: Record<string, unknown>,
  totalTokens = 100,
): unknown {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: { name, arguments: JSON.stringify(toolArgs) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { total_tokens: totalTokens, prompt_tokens: 80, completion_tokens: 20 },
  };
}

/** OpenRouter response that calls `done`. */
function doneResponse(totalTokens = 50): unknown {
  return toolCallResponse("done-id", "done", {}, totalTokens);
}

/**
 * Stub `globalThis.fetch` to return `responses` in order.
 * If all responses are consumed the last one is repeated.
 */
function stubFetch(...responses: unknown[]): void {
  let i = 0;
  vi.stubGlobal("fetch", async (_url: string | URL, _init?: RequestInit): Promise<Response> => {
    const body = i < responses.length ? responses[i++] : responses[responses.length - 1];
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  });
}

function makeArgs(overrides: Partial<EditLoopArgs> & { dir: string }): EditLoopArgs {
  const { dir, ...rest } = overrides;
  return {
    dir,
    ticket: { identifier: "SIG-999", title: "Test ticket", body: "Fix the thing." },
    model: {
      id: "z-ai/glm-5.2",
      key: "sk-test-key",
      baseUrl: "https://openrouter.ai/api/v1",
    },
    caps: { maxModelCalls: 5, maxTokens: 10_000, timeoutMs: 30_000 },
    ...rest,
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

describe("runEditLoop", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigilix-agent-test-"));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── happy path ──────────────────────────────────────────────────────────────

  it("writes a file, returns changed:true and stoppedReason:done", async () => {
    stubFetch(
      // turn 1 — model calls write_file
      toolCallResponse("tc-1", "write_file", {
        path: "output.txt",
        content: "hello from agent",
      }),
      // turn 2 — model calls done
      doneResponse(),
    );

    const result = await runEditLoop(makeArgs({ dir: tmpDir }));

    // File must actually exist on disk with the correct content
    const contents = await fs.readFile(path.join(tmpDir, "output.txt"), "utf8");
    expect(contents).toBe("hello from agent");

    expect(result.changed).toBe(true);
    expect(result.stoppedReason).toBe("done");
    expect(result.modelCalls).toBe(2);
    expect(result.tokens).toBeGreaterThan(0);
  });

  it("includes grounding in the first user message when provided", async () => {
    const captured: string[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL, init?: RequestInit): Promise<Response> => {
      if (init?.body) {
        const body = JSON.parse(init.body as string) as { messages: Array<{ content: string }> };
        captured.push(body.messages.map((m) => m.content ?? "").join("\n"));
      }
      return {
        ok: true,
        status: 200,
        json: async () => doneResponse(),
        text: async () => "{}",
      } as Response;
    });

    await runEditLoop(
      makeArgs({ dir: tmpDir, grounding: "## Context\nfoo bar context" }),
    );

    expect(captured[0]).toContain("foo bar context");
  });

  // ── cap-calls ───────────────────────────────────────────────────────────────

  it("stops at maxModelCalls when done is never called", async () => {
    // Model always returns list_files — never done
    stubFetch(toolCallResponse("tc-x", "list_files", {}));

    const result = await runEditLoop(
      makeArgs({
        dir: tmpDir,
        caps: { maxModelCalls: 3, maxTokens: 100_000, timeoutMs: 30_000 },
      }),
    );

    expect(result.stoppedReason).toBe("cap-calls");
    expect(result.modelCalls).toBe(3);
    expect(result.changed).toBe(false);
  });

  // ── cap-tokens ──────────────────────────────────────────────────────────────

  it("stops when cumulative token count exceeds maxTokens", async () => {
    // 600 tokens per call; cap = 1 000 → first call brings total to 600, second to 1200,
    // so the cap is exceeded before the third iteration starts.
    stubFetch(toolCallResponse("tc-x", "list_files", {}, 600));

    const result = await runEditLoop(
      makeArgs({
        dir: tmpDir,
        caps: { maxModelCalls: 10, maxTokens: 1_000, timeoutMs: 30_000 },
      }),
    );

    expect(result.stoppedReason).toBe("cap-tokens");
    expect(result.changed).toBe(false);
  });

  // ── path guard ──────────────────────────────────────────────────────────────

  it("rejects a path-escape write_file('../evil') — no file written outside dir", async () => {
    stubFetch(
      // turn 1 — model tries to escape
      toolCallResponse("tc-1", "write_file", {
        path: "../evil.txt",
        content: "pwned",
      }),
      // turn 2 — model then finishes
      doneResponse(),
    );

    const result = await runEditLoop(makeArgs({ dir: tmpDir }));

    // Loop should have continued after rejecting the escape and reached done
    expect(result.stoppedReason).toBe("done");
    // write was rejected → changed is still false
    expect(result.changed).toBe(false);

    // Confirm the evil file does NOT exist next to tmpDir
    const evilPath = path.join(path.dirname(tmpDir), "evil.txt");
    const exists = await fs
      .access(evilPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("rejects a path-escape read_file('../../etc/passwd')", async () => {
    stubFetch(
      toolCallResponse("tc-1", "read_file", { path: "../../etc/passwd" }),
      doneResponse(),
    );

    // Should not throw; loop continues and reaches done
    const result = await runEditLoop(makeArgs({ dir: tmpDir }));
    expect(result.stoppedReason).toBe("done");
  });

  // ── symlink traversal guard (Fix 1) ─────────────────────────────────────────

  it("rejects read_file through a symlink inside the sandbox that points outside", async () => {
    // Plant a symlink inside tmpDir pointing to the OS temp root (outside sandbox)
    const linkPath = path.join(tmpDir, "escape-link");
    await fs.symlink(os.tmpdir(), linkPath);

    stubFetch(
      // Model tries to read through the symlink
      toolCallResponse("tc-1", "read_file", { path: "escape-link/some-secret" }),
      // After rejection, model calls done
      doneResponse(),
    );

    const result = await runEditLoop(makeArgs({ dir: tmpDir }));

    // The loop must continue (not crash) after the rejected read
    expect(result.stoppedReason).toBe("done");
    expect(result.changed).toBe(false);
  });

  it("rejects write_file when the parent directory component is a symlink escaping the sandbox", async () => {
    // Create a real directory outside the sandbox
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigilix-outside-"));
    try {
      // Plant a symlink inside tmpDir whose realpath is outside
      const linkPath = path.join(tmpDir, "escaped-parent");
      await fs.symlink(outsideDir, linkPath);

      stubFetch(
        // Model tries to write through the escaped parent
        toolCallResponse("tc-1", "write_file", {
          path: "escaped-parent/newfile.txt",
          content: "pwned",
        }),
        doneResponse(),
      );

      const result = await runEditLoop(makeArgs({ dir: tmpDir }));

      // The loop must continue after the rejected write
      expect(result.stoppedReason).toBe("done");
      // write was rejected — changed must remain false
      expect(result.changed).toBe(false);

      // Confirm the file was NOT created inside the outside directory
      const attackedFile = path.join(outsideDir, "newfile.txt");
      const exists = await fs
        .access(attackedFile)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  // ── prototype-safe allow-list (Fix 3) ────────────────────────────────────────

  it('rejects run_cmd with cmd="__proto__" cleanly — no TypeError, loop continues', async () => {
    // Before the fix, ALLOWED_EXECUTABLES["__proto__"] returned Object.prototype
    // (truthy), then allowed.has(subCmd) threw TypeError: allowed.has is not a function.
    // The outer catch would have set stoppedReason:"error". With the fix, Object.hasOwn
    // returns false and we get a clean reject message; the loop continues to done.
    stubFetch(
      toolCallResponse("tc-1", "run_cmd", { cmd: "__proto__", args: ["test"] }),
      doneResponse(),
    );

    const result = await runEditLoop(makeArgs({ dir: tmpDir }));

    expect(result.stoppedReason).toBe("done"); // not "error"
    expect(result.changed).toBe(false);
  });

  it('rejects run_cmd with cmd="constructor" cleanly — no TypeError, loop continues', async () => {
    // "constructor" is another prototype chain key that would resolve to Function
    stubFetch(
      toolCallResponse("tc-1", "run_cmd", { cmd: "constructor", args: ["test"] }),
      doneResponse(),
    );

    const result = await runEditLoop(makeArgs({ dir: tmpDir }));

    expect(result.stoppedReason).toBe("done"); // not "error"
    expect(result.changed).toBe(false);
  });

  // ── run_cmd allow-list ──────────────────────────────────────────────────────

  it("rejects a non-allow-listed executable in run_cmd", async () => {
    stubFetch(
      toolCallResponse("tc-1", "run_cmd", { cmd: "rm", args: ["-rf", "/"] }),
      doneResponse(),
    );

    // Loop should survive the rejected command and reach done
    const result = await runEditLoop(makeArgs({ dir: tmpDir }));
    expect(result.stoppedReason).toBe("done");
  });

  it("rejects a non-allow-listed sub-command for npm", async () => {
    stubFetch(
      toolCallResponse("tc-1", "run_cmd", { cmd: "npm", args: ["publish"] }),
      doneResponse(),
    );

    const result = await runEditLoop(makeArgs({ dir: tmpDir }));
    expect(result.stoppedReason).toBe("done");
  });

  // ── error handling ──────────────────────────────────────────────────────────

  it("returns stoppedReason:error on fetch failure without throwing", async () => {
    vi.stubGlobal("fetch", async (): Promise<Response> => {
      throw new Error("network failure");
    });

    const result = await runEditLoop(makeArgs({ dir: tmpDir }));

    expect(result.stoppedReason).toBe("error");
    expect(result.changed).toBe(false);
    expect(result.modelCalls).toBe(0);
  });

  it("returns stoppedReason:error on non-ok HTTP response without throwing", async () => {
    vi.stubGlobal("fetch", async (): Promise<Response> => ({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => "rate limit",
    }as Response));

    const result = await runEditLoop(makeArgs({ dir: tmpDir }));
    expect(result.stoppedReason).toBe("error");
  });

  // ── timeout ─────────────────────────────────────────────────────────────────

  it("returns stoppedReason:timeout immediately when timeoutMs is 0", async () => {
    // fetch is never called — timeout fires before the first iteration's model call
    const result = await runEditLoop(
      makeArgs({
        dir: tmpDir,
        caps: { maxModelCalls: 100, maxTokens: 1_000_000, timeoutMs: 0 },
      }),
    );

    expect(result.stoppedReason).toBe("timeout");
  });

  // ── token safety ────────────────────────────────────────────────────────────

  it("never logs the model key in any console output", async () => {
    const SECRET = "sk-super-secret-key-never-log-this";
    const captured: string[] = [];

    const origLog = console.log;
    const origError = console.error;
    const origWarn = console.warn;

    console.log = (...a: unknown[]) => captured.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => captured.push(a.map(String).join(" "));
    console.warn = (...a: unknown[]) => captured.push(a.map(String).join(" "));

    try {
      stubFetch(
        toolCallResponse("tc-1", "write_file", { path: "x.txt", content: "hi" }),
        doneResponse(),
      );
      await runEditLoop(
        makeArgs({
          dir: tmpDir,
          model: { id: "z-ai/glm-5.2", key: SECRET, baseUrl: "https://openrouter.ai/api/v1" },
        }),
      );
    } finally {
      console.log = origLog;
      console.error = origError;
      console.warn = origWarn;
    }

    for (const line of captured) {
      expect(line).not.toContain(SECRET);
    }
  });

  // ── text-only response (no tool_calls) ────────────────────────────────────

  it("treats a text-only response (no tool_calls) as done", async () => {
    stubFetch({
      choices: [
        {
          message: { role: "assistant", content: "All done!", tool_calls: undefined },
          finish_reason: "stop",
        },
      ],
      usage: { total_tokens: 30, prompt_tokens: 20, completion_tokens: 10 },
    });

    const result = await runEditLoop(makeArgs({ dir: tmpDir }));
    expect(result.stoppedReason).toBe("done");
    expect(result.modelCalls).toBe(1);
  });
});
