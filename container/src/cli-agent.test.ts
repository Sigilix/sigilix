import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  mkdtemp: vi.fn(),
  writeFile: vi.fn(),
  rm: vi.fn(),
  emitFileEdit: vi.fn(),
  createAgentMcpBridge: vi.fn(),
  closeAgentMcpBridge: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
  execFile: mocks.execFile,
}));

vi.mock("node:fs", () => ({
  promises: { mkdtemp: mocks.mkdtemp, writeFile: mocks.writeFile, rm: mocks.rm },
}));

vi.mock("./events.js", () => ({ emitFileEdit: mocks.emitFileEdit }));
vi.mock("./mcp-bridge.js", () => ({ createAgentMcpBridge: mocks.createAgentMcpBridge }));

import {
  buildOpencodeConfig,
  buildCliEnv,
  buildPrompt,
  buildCliArgs,
  isGroundingActive,
  parseCliEvents,
  parseEditFilePath,
  runCliAgent,
  type CliAgentArgs,
} from "./cli-agent.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MODEL = { id: "glm-5.2:cloud", key: "sk-secret-key", baseUrl: "https://ollama.com/v1" };

function makeArgs(over?: Partial<CliAgentArgs>): CliAgentArgs {
  return {
    dir: "/tmp/clone",
    ticket: { identifier: "SIG-1", title: "Do a thing", body: "details" },
    model: MODEL,
    caps: { maxModelCalls: 12, maxTokens: 800_000, timeoutMs: 60_000 },
    ...over,
  };
}

/** A fake ChildProcess that emits the given NDJSON then closes with `code`. */
function fakeChild(stdout: string, code: number) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  // Emit asynchronously so listeners attach first.
  setTimeout(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    child.emit("close", code);
  }, 0);
  return child;
}

/** Like fakeChild but emits several stdout chunks (to exercise line buffering). */
function fakeChildChunks(chunks: string[], code: number) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  setTimeout(() => {
    for (const c of chunks) child.stdout.emit("data", Buffer.from(c));
    child.emit("close", code);
  }, 0);
  return child;
}

// ── isGroundingActive (no-rebuild kill switch) ────────────────────────────────

describe("isGroundingActive", () => {
  const full = { endpoint: "https://api.sigilix.ai", apiKey: "k", repoSlug: "o/r" };
  it("active only when the plugin is provisioned AND complete grounding config is present", () => {
    expect(isGroundingActive("/app/dist/grounding-plugin.js", full)).toBe(true);
  });
  it("dark when the image did not provision the plugin (empty path)", () => {
    expect(isGroundingActive("", full)).toBe(false);
  });
  it("dark when the Worker passed no grounding config (kill switch: flag off → no sigilix)", () => {
    expect(isGroundingActive("/p", undefined)).toBe(false);
  });
  it("fail-closed on PARTIAL grounding config (missing any of endpoint/apiKey/repoSlug)", () => {
    expect(isGroundingActive("/p", { endpoint: "https://x", apiKey: "k" })).toBe(false);
    expect(isGroundingActive("/p", { endpoint: "https://x", repoSlug: "o/r" })).toBe(false);
    expect(isGroundingActive("/p", { apiKey: "k", repoSlug: "o/r" })).toBe(false);
    expect(isGroundingActive("/p", { endpoint: "", apiKey: "k", repoSlug: "o/r" })).toBe(false);
  });
});

// ── buildOpencodeConfig ───────────────────────────────────────────────────────

describe("buildOpencodeConfig", () => {
  it("is deny-by-default: a '*' catch-all deny with only the editing core allowed", () => {
    const cfg = buildOpencodeConfig(MODEL, "/opt/sigilix/grounding/index.js");
    const perm = cfg.permission as Record<string, string>;
    // The catch-all is the security posture AND the headless invariant (no "ask").
    expect(perm["*"]).toBe("deny");
    // The editing core is explicitly allowed (opencode collapses edit/write/apply_patch).
    for (const allowed of ["read", "edit", "write", "grep", "glob", "list", "todowrite"]) {
      expect(perm[allowed]).toBe("allow");
    }
    // Out-of-repo mutation is explicitly denied even though edit/write are allowed.
    expect(perm.external_directory).toBe("deny");
    // The grounding tool is allowed here because this call wires the plugin — without
    // the allow, deny-by-default filters it out of the model's toolset (the plugin
    // loads but the model never sees `retrieve_codebase`, so it can't ground).
    expect(perm.retrieve_codebase).toBe("allow");
    // Nothing else is allowed. A dangerous tool must be strictly absent — not
    // even "ask" (which would hang a headless run, the very failure the catch-all
    // exists to prevent). toBeUndefined() catches an accidental allow OR ask.
    for (const denied of ["bash", "webfetch", "websearch", "task", "skill", "lsp", "plan_exit"]) {
      expect(perm[denied]).toBeUndefined();
    }
    // Lock the allow-list to EXACTLY these keys — adding a new allow must fail here.
    expect(new Set(Object.keys(perm))).toEqual(
      new Set([
        "*",
        "read",
        "edit",
        "write",
        "grep",
        "glob",
        "list",
        "todowrite",
        "retrieve_codebase",
        "external_directory",
      ]),
    );
  });

  it("allows retrieve_codebase ONLY when the grounding plugin is wired (same gate as the plugin entry)", () => {
    // Plugin wired → tool exists → must be allowed, or it is filtered from the toolset.
    const grounded = buildOpencodeConfig(MODEL, "/opt/sigilix/grounding/index.js");
    expect((grounded.permission as Record<string, string>).retrieve_codebase).toBe("allow");
    // No plugin → tool doesn't exist → no allow (and no stray key in the map).
    const bare = buildOpencodeConfig(MODEL, "");
    expect((bare.permission as Record<string, string>).retrieve_codebase).toBeUndefined();
  });

  it("wires the packet model as an OpenAI-compatible provider", () => {
    const cfg = buildOpencodeConfig(MODEL, "/p/index.js");
    expect(cfg.model).toBe("runner/glm-5.2:cloud");
    const provider = (cfg.provider as Record<string, { options: { baseURL: string; apiKey: string } }>).runner;
    expect(provider.options.baseURL).toBe("https://ollama.com/v1");
    // Gate (c): the config references the key by env, NEVER embeds it. Assert the
    // reference is present and the real key is absent from the whole rendered config.
    expect(provider.options.apiKey).toBe("{env:SIGILIX_MODEL_KEY}");
    expect(JSON.stringify(cfg)).not.toContain("sk-secret-key");
    expect(cfg.plugin).toEqual(["/p/index.js"]);
  });

  it("omits the plugin entry when NO plugin is provisioned (grounding + toolcap both empty)", () => {
    const cfg = buildOpencodeConfig(MODEL, "", undefined, "");
    expect(cfg.plugin).toBeUndefined();
  });

  it("always wires the tool-output-cap plugin, even on an ungrounded run", () => {
    // Ungrounded (grounding path empty) but toolcap provisioned → cap still loads.
    const cfg = buildOpencodeConfig(MODEL, "", undefined, "/app/dist/tool-output-cap-plugin.js");
    expect(cfg.plugin).toEqual(["/app/dist/tool-output-cap-plugin.js"]);
  });

  it("loads toolcap BEFORE grounding when both are provisioned", () => {
    const cfg = buildOpencodeConfig(MODEL, "/g/grounding.js", undefined, "/c/toolcap.js");
    expect(cfg.plugin).toEqual(["/c/toolcap.js", "/g/grounding.js"]);
  });

  it("defaults baseURL to OpenRouter when the model has none", () => {
    const cfg = buildOpencodeConfig({ id: "z-ai/glm-5.2", key: "k" }, "/p");
    const provider = (cfg.provider as Record<string, { options: { baseURL: string } }>).runner;
    expect(provider.options.baseURL).toBe("https://openrouter.ai/api/v1");
  });

  it("wires only a loopback MCP endpoint and exact MCP permission — never a capability", () => {
    const rawCapability = "c".repeat(64);
    const cfg = buildOpencodeConfig(MODEL, "", "http://127.0.0.1:4567/");
    const mcp = cfg.mcp as Record<string, Record<string, unknown>>;
    const permission = cfg.permission as Record<string, string>;

    expect(mcp.sigilix).toEqual({
      type: "remote",
      url: "http://127.0.0.1:4567/",
      enabled: true,
      oauth: false,
      timeout: 12_000,
    });
    expect(permission["sigilix_mcp_*"]).toBe("allow");
    expect(JSON.stringify(cfg)).not.toContain(rawCapability);
  });
});

// ── buildCliEnv ───────────────────────────────────────────────────────────────

describe("buildCliEnv", () => {
  it("sets the sealed-container hardening flags", () => {
    const env = buildCliEnv({}, {});
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
    expect(env.OPENCODE_DISABLE_LSP_DOWNLOAD).toBe("1");
    expect(env.OPENCODE_DISABLE_SHARE).toBe("1");
    expect(env.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe("1");
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
  });

  it("disables the file watcher (Linux inotify handle blocks process exit → runner hang)", () => {
    // Regression guard: without this the run's inotify watcher keeps the process
    // alive after the headless run completes, we SIGKILL at the timeout, and the
    // completed edit is discarded as "no-change". Do not remove — it's what makes
    // the full engine terminate at all on the Linux container. Verified in docker.
    const env = buildCliEnv({}, {});
    expect(env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER).toBe("1");
  });

  it("wires grounding vars when provided and omits them otherwise", () => {
    const withG = buildCliEnv({ sigilix: { endpoint: "https://w.dev", apiKey: "sk-g", repoSlug: "o/r" } }, {});
    expect(withG.SIGILIX_ENDPOINT).toBe("https://w.dev");
    expect(withG.SIGILIX_API_KEY).toBe("sk-g");
    expect(withG.SIGILIX_REPO_SLUG).toBe("o/r");

    const without = buildCliEnv({}, {});
    expect(without.SIGILIX_ENDPOINT).toBeUndefined();
    expect(without.SIGILIX_API_KEY).toBeUndefined();
  });

  it("omits the grounding secret when grounding is inactive (plugin unprovisioned)", () => {
    const env = buildCliEnv({ sigilix: { endpoint: "https://w.dev", apiKey: "sk-g", repoSlug: "o/r" } }, {}, false);
    expect(env.SIGILIX_ENDPOINT).toBeUndefined();
    expect(env.SIGILIX_API_KEY).toBeUndefined();
    expect(env.SIGILIX_REPO_SLUG).toBeUndefined();
  });

  it("preserves the base env", () => {
    const env = buildCliEnv({}, { PATH: "/usr/bin", HOME: "/root" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/root");
  });
});

// ── buildPrompt ───────────────────────────────────────────────────────────────

describe("buildPrompt", () => {
  it("includes the ticket and appends grounding context when present", () => {
    const p = buildPrompt({ identifier: "SIG-9", title: "Title", body: "Body here" }, "ground-slice");
    expect(p).toContain("# Ticket: SIG-9 — Title");
    expect(p).toContain("Body here");
    expect(p).toContain("## Context");
    expect(p).toContain("ground-slice");
  });

  it("omits the Context section when grounding is empty/absent", () => {
    expect(buildPrompt({ identifier: "S", title: "T", body: "B" })).not.toContain("## Context");
    expect(buildPrompt({ identifier: "S", title: "T", body: "B" }, "")).not.toContain("## Context");
  });

  it("nudges the model to use retrieve_codebase ONLY when the grounding tool is available", () => {
    const t = { identifier: "S", title: "T", body: "B" };
    expect(buildPrompt(t, undefined, false, true)).toContain("retrieve_codebase");
    // default (tool absent) → no nudge, so runs without the plugin are unchanged
    expect(buildPrompt(t)).not.toContain("retrieve_codebase");
    expect(buildPrompt(t, "ctx", false, false)).not.toContain("retrieve_codebase");
  });
});

// ── buildCliArgs ──────────────────────────────────────────────────────────────

describe("buildCliArgs", () => {
  it("NEVER includes --dangerously-skip-permissions (no bypass exists)", () => {
    const args = buildCliArgs(MODEL, "/tmp/clone", "prompt");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).toEqual(["run", "prompt", "-m", "runner/glm-5.2:cloud", "--format", "json", "--dir", "/tmp/clone"]);
  });
});

// ── parseCliEvents ────────────────────────────────────────────────────────────

describe("parseCliEvents", () => {
  it("counts step_finish events and flags errors", () => {
    const ndjson = [
      '{"type":"step_start"}',
      '{"type":"tool_use","name":"edit"}',
      '{"type":"step_finish"}',
      '{"type":"step_finish"}',
      "not json — skipped",
      '{"type":"text","text":"done"}',
    ].join("\n");
    const r = parseCliEvents(ndjson);
    expect(r.modelCalls).toBe(2);
    expect(r.errored).toBe(false);
  });

  it("flags errored on an error event", () => {
    expect(parseCliEvents('{"type":"error","message":"boom"}').errored).toBe(true);
    expect(parseCliEvents('{"type":"text","error":{"x":1}}').errored).toBe(true);
  });

  it("handles empty / whitespace output", () => {
    expect(parseCliEvents("")).toEqual({ modelCalls: 0, errored: false, retrieveCodebaseCalls: 0 });
    expect(parseCliEvents("\n  \n")).toEqual({ modelCalls: 0, errored: false, retrieveCodebaseCalls: 0 });
  });

  it("counts DISTINCT retrieve_codebase tool calls, deduped by part id", () => {
    // Two calls (parts p1, p2), each with multiple NDJSON lines sharing the part id.
    const ndjson = [
      JSON.stringify({ type: "part", part: { tool: "retrieve_codebase", id: "p1", state: "running" } }),
      JSON.stringify({ type: "part", part: { tool: "retrieve_codebase", id: "p1", state: "completed" } }),
      JSON.stringify({ type: "step_finish" }),
      JSON.stringify({ type: "part", part: { tool: "edit", id: "p9" } }),
      JSON.stringify({ type: "part", part: { tool: "retrieve_codebase", id: "p2", state: "completed" } }),
    ].join("\n");
    expect(parseCliEvents(ndjson).retrieveCodebaseCalls).toBe(2);
    // A run that never calls the tool → 0 (the "why isn't it firing" signal).
    expect(parseCliEvents(JSON.stringify({ type: "part", part: { tool: "edit", id: "x" } })).retrieveCodebaseCalls).toBe(
      0,
    );
  });
});

// ── parseEditFilePath ─────────────────────────────────────────────────────────

describe("parseEditFilePath", () => {
  const line = (o: unknown) => JSON.stringify(o);
  const editEvt = (tool: string, status: string, filePath?: string) =>
    line({ type: "tool_use", part: { type: "tool", tool, state: { status, input: filePath ? { filePath } : {} } } });

  it("returns the filePath for a completed edit/write/apply_patch tool call", () => {
    expect(parseEditFilePath(editEvt("edit", "completed", "/work/a.ts"))).toBe("/work/a.ts");
    expect(parseEditFilePath(editEvt("write", "completed", "/work/b.ts"))).toBe("/work/b.ts");
    expect(parseEditFilePath(editEvt("apply_patch", "completed", "/work/c.ts"))).toBe("/work/c.ts");
  });

  it("returns null for non-edit tools, incomplete states, and non-tool events", () => {
    expect(parseEditFilePath(editEvt("read", "completed", "/work/a.ts"))).toBeNull(); // read isn't a mutation
    expect(parseEditFilePath(editEvt("edit", "error", "/work/a.ts"))).toBeNull(); // denied/failed
    expect(parseEditFilePath(editEvt("edit", "running", "/work/a.ts"))).toBeNull(); // not done yet
    expect(parseEditFilePath(editEvt("edit", "completed"))).toBeNull(); // no filePath
    expect(parseEditFilePath(line({ type: "step_finish" }))).toBeNull();
    expect(parseEditFilePath("not json")).toBeNull();
    expect(parseEditFilePath("")).toBeNull();
  });
});

// ── runCliAgent ───────────────────────────────────────────────────────────────

describe("runCliAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mkdtemp.mockResolvedValue("/tmp/sigilix-cfg-x");
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.rm.mockResolvedValue(undefined);
    mocks.closeAgentMcpBridge.mockResolvedValue(undefined);
    mocks.createAgentMcpBridge.mockResolvedValue({
      endpoint: "http://127.0.0.1:4567/",
      close: mocks.closeAgentMcpBridge,
    });
  });

  it("happy path: parses events, detects changes via git, returns done", async () => {
    mocks.spawn.mockReturnValue(fakeChild('{"type":"step_finish"}\n{"type":"text"}', 0));
    // git status --porcelain → non-empty (changes present)
    mocks.execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, " M file.ts\n", ""));

    const result = await runCliAgent(makeArgs());
    expect(result).toMatchObject({ changed: true, modelCalls: 1, tokens: 0, stoppedReason: "done" });
    expect(result.diag).toEqual({ retrieveCodebaseCalls: 0, stderrTail: expect.any(String) });
    // config written to a 0600 file OUTSIDE the repo dir (cfgDir under tmp)
    expect(mocks.writeFile).toHaveBeenCalledWith("/tmp/sigilix-cfg-x/opencode-config.json", expect.any(String), {
      mode: 0o600,
    });
    expect(mocks.rm).toHaveBeenCalledWith("/tmp/sigilix-cfg-x", { recursive: true, force: true });
  });

  it("gate (c): the model key is in the child env, NEVER in the written config", async () => {
    mocks.spawn.mockReturnValue(fakeChild('{"type":"step_finish"}', 0));
    mocks.execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "", ""));

    await runCliAgent(makeArgs());

    // The rendered config must reference the key by env, not embed it.
    const writtenConfig = mocks.writeFile.mock.calls[0]?.[1] as string;
    expect(writtenConfig).toContain("{env:SIGILIX_MODEL_KEY}");
    expect(writtenConfig).not.toContain("sk-secret-key");
    // The real key is set only in the child process env passed to spawn.
    const spawnEnv = (mocks.spawn.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv }).env;
    expect(spawnEnv.SIGILIX_MODEL_KEY).toBe("sk-secret-key");
    // End-to-end guard (through runCliAgent, not just buildCliEnv): the file-watcher
    // disable flag must reach the actual spawn — without it the CLI hangs past run
    // completion on Linux and the completed edit is discarded as "no-change".
    expect(spawnEnv.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER).toBe("1");
  });

  it("spawns the CLI with stdin ignored (primary hang fix)", async () => {
    // Node's default stdio gives the child an open, empty stdin pipe; the CLI
    // blocks probing stdin at startup, produces no output, and never runs → we
    // SIGKILL at the timeout → "no-change". stdin MUST be "ignore" (/dev/null →
    // immediate EOF); stdout/stderr stay piped for streaming + capture.
    mocks.spawn.mockReturnValue(fakeChild('{"type":"step_finish"}', 0));
    mocks.execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "", ""));

    await runCliAgent(makeArgs());

    const spawnOpts = mocks.spawn.mock.calls[0]?.[2] as { stdio?: unknown };
    expect(spawnOpts.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("keeps the tenant MCP capability out of child config, env, and argv, then closes the bridge", async () => {
    const capability = "d".repeat(64);
    mocks.spawn.mockReturnValue(fakeChild('{"type":"step_finish"}', 0));
    mocks.execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "", ""));

    await runCliAgent(
      makeArgs({ mcp: { endpoint: "https://api.sigilix.ai/internal/agent-runs/r/mcp", capability } }),
    );

    expect(mocks.createAgentMcpBridge).toHaveBeenCalledWith({
      endpoint: "https://api.sigilix.ai/internal/agent-runs/r/mcp",
      capability,
    });
    const writtenConfig = mocks.writeFile.mock.calls[0]?.[1] as string;
    const spawnArgs = mocks.spawn.mock.calls[0] ?? [];
    expect(writtenConfig).toContain("http://127.0.0.1:4567/");
    expect(writtenConfig).not.toContain(capability);
    expect(JSON.stringify(spawnArgs)).not.toContain(capability);
    expect(mocks.closeAgentMcpBridge).toHaveBeenCalledOnce();
  });

  it("fails soft when the loopback MCP bridge cannot start", async () => {
    mocks.createAgentMcpBridge.mockRejectedValueOnce(new Error("loopback unavailable"));
    mocks.spawn.mockReturnValue(fakeChild('{"type":"step_finish"}', 0));
    mocks.execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "", ""));

    const result = await runCliAgent(
      makeArgs({
        mcp: {
          endpoint: "https://api.sigilix.ai/internal/agent-runs/r/mcp",
          capability: "d".repeat(64),
        },
      }),
    );

    expect(result.stoppedReason).toBe("done");
    const writtenConfig = mocks.writeFile.mock.calls[0]?.[1] as string;
    expect(writtenConfig).not.toContain('"mcp"');
    expect(mocks.spawn).toHaveBeenCalledOnce();
  });

  it("streams a diff-pane event for each completed in-repo edit, skipping out-of-repo", async () => {
    const events = { url: "https://api.sigilix.ai/internal/agent-runs/r/events", secret: "s" };
    const edit = (filePath: string) =>
      JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "edit", state: { status: "completed", input: { filePath } } } });
    // in-repo edit + an out-of-repo write + a noise line, split across chunks.
    mocks.spawn.mockReturnValue(
      fakeChild([edit("/tmp/clone/foo.ts"), edit("/etc/passwd"), '{"type":"step_finish"}'].join("\n"), 0),
    );
    mocks.execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "", ""));
    mocks.emitFileEdit.mockResolvedValue(undefined);

    await runCliAgent(makeArgs({ events }));

    // Only the in-repo edit is emitted, with the repo-relative path.
    expect(mocks.emitFileEdit).toHaveBeenCalledTimes(1);
    expect(mocks.emitFileEdit).toHaveBeenCalledWith(events, "/tmp/clone", "foo.ts");
  });

  it("reassembles an edit line split across chunks and flushes a final unterminated edit", async () => {
    const events = { url: "https://api.sigilix.ai/internal/agent-runs/r/events", secret: "s" };
    const edit = (filePath: string) =>
      JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "edit", state: { status: "completed", input: { filePath } } } });
    const first = edit("/tmp/clone/foo.ts");
    const mid = Math.floor(first.length / 2);
    // chunk 1 = first half of foo's edit line (no newline); chunk 2 = its second
    // half + newline + a SECOND edit line with NO trailing newline (flush path).
    mocks.spawn.mockReturnValue(
      fakeChildChunks([first.slice(0, mid), first.slice(mid) + "\n" + edit("/tmp/clone/bar.ts")], 0),
    );
    mocks.execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "", ""));
    mocks.emitFileEdit.mockResolvedValue(undefined);

    await runCliAgent(makeArgs({ events }));

    expect(mocks.emitFileEdit).toHaveBeenCalledTimes(2);
    expect(mocks.emitFileEdit).toHaveBeenCalledWith(events, "/tmp/clone", "foo.ts"); // reassembled across chunks
    expect(mocks.emitFileEdit).toHaveBeenCalledWith(events, "/tmp/clone", "bar.ts"); // final unterminated → flushed
  });

  it("keeps emitting after an emitFileEdit failure — the chain recovers", async () => {
    const events = { url: "https://api.sigilix.ai/internal/agent-runs/r/events", secret: "s" };
    const edit = (filePath: string) =>
      JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "edit", state: { status: "completed", input: { filePath } } } });
    mocks.spawn.mockReturnValue(
      fakeChild([edit("/tmp/clone/foo.ts"), edit("/tmp/clone/bar.ts"), '{"type":"step_finish"}'].join("\n"), 0),
    );
    mocks.execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "", ""));
    // The FIRST emit rejects; the chain's `.catch` must not stall it — the second still fires.
    mocks.emitFileEdit.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);

    await runCliAgent(makeArgs({ events }));

    expect(mocks.emitFileEdit).toHaveBeenCalledTimes(2);
    expect(mocks.emitFileEdit).toHaveBeenCalledWith(events, "/tmp/clone", "bar.ts"); // emitted despite the earlier failure
  });

  it("no-change: clean tree → changed:false (no spurious PR)", async () => {
    mocks.spawn.mockReturnValue(fakeChild('{"type":"step_finish"}', 0));
    mocks.execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "", ""));

    const result = await runCliAgent(makeArgs());
    expect(result.changed).toBe(false);
    expect(result.stoppedReason).toBe("done");
  });

  it("non-zero exit → error", async () => {
    mocks.spawn.mockReturnValue(fakeChild('{"type":"error"}', 1));
    mocks.execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "", ""));

    const result = await runCliAgent(makeArgs());
    expect(result.stoppedReason).toBe("error");
  });

  it("does not leak the model key in the returned result", async () => {
    mocks.spawn.mockReturnValue(fakeChild('{"type":"step_finish"}', 0));
    mocks.execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, " M f\n", ""));

    const result = await runCliAgent(makeArgs());
    expect(JSON.stringify(result)).not.toContain("sk-secret-key");
  });

  it("timeout: SIGKILLs the run and returns stoppedReason 'timeout'", async () => {
    // A child that never closes on its own; kill() resolves it (simulates SIGKILL → close).
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => child.emit("close", null));
    mocks.spawn.mockReturnValue(child);
    mocks.execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "", ""));

    const result = await runCliAgent(makeArgs({ caps: { maxModelCalls: 12, maxTokens: 1, timeoutMs: 20 } }));
    expect(child.kill).toHaveBeenCalled();
    expect(result.stoppedReason).toBe("timeout");
  });
});
