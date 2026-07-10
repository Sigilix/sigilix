import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  mkdtemp: vi.fn(),
  writeFile: vi.fn(),
  rm: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
  execFile: mocks.execFile,
}));

vi.mock("node:fs", () => ({
  promises: { mkdtemp: mocks.mkdtemp, writeFile: mocks.writeFile, rm: mocks.rm },
}));

import {
  buildOpencodeConfig,
  buildCliEnv,
  buildPrompt,
  buildCliArgs,
  parseCliEvents,
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
    // Nothing else is allowed. A dangerous tool must be strictly absent — not
    // even "ask" (which would hang a headless run, the very failure the catch-all
    // exists to prevent). toBeUndefined() catches an accidental allow OR ask.
    for (const denied of ["bash", "webfetch", "websearch", "task", "skill", "lsp", "plan_exit"]) {
      expect(perm[denied]).toBeUndefined();
    }
    // Lock the allow-list to EXACTLY these keys — adding a new allow must fail here.
    expect(new Set(Object.keys(perm))).toEqual(
      new Set(["*", "read", "edit", "write", "grep", "glob", "list", "todowrite", "external_directory"]),
    );
  });

  it("wires the packet model as an OpenAI-compatible provider", () => {
    const cfg = buildOpencodeConfig(MODEL, "/p/index.js");
    expect(cfg.model).toBe("runner/glm-5.2:cloud");
    const provider = (cfg.provider as Record<string, { options: { baseURL: string; apiKey: string } }>).runner;
    expect(provider.options.baseURL).toBe("https://ollama.com/v1");
    expect(provider.options.apiKey).toBe("sk-secret-key");
    expect(cfg.plugin).toEqual(["/p/index.js"]);
  });

  it("omits the plugin entry when the grounding plugin is not provisioned", () => {
    const cfg = buildOpencodeConfig(MODEL, "");
    expect(cfg.plugin).toBeUndefined();
  });

  it("defaults baseURL to OpenRouter when the model has none", () => {
    const cfg = buildOpencodeConfig({ id: "z-ai/glm-5.2", key: "k" }, "/p");
    const provider = (cfg.provider as Record<string, { options: { baseURL: string } }>).runner;
    expect(provider.options.baseURL).toBe("https://openrouter.ai/api/v1");
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
    expect(parseCliEvents("")).toEqual({ modelCalls: 0, errored: false });
    expect(parseCliEvents("\n  \n")).toEqual({ modelCalls: 0, errored: false });
  });
});

// ── runCliAgent ───────────────────────────────────────────────────────────────

describe("runCliAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mkdtemp.mockResolvedValue("/tmp/sigilix-cfg-x");
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.rm.mockResolvedValue(undefined);
  });

  it("happy path: parses events, detects changes via git, returns done", async () => {
    mocks.spawn.mockReturnValue(fakeChild('{"type":"step_finish"}\n{"type":"text"}', 0));
    // git status --porcelain → non-empty (changes present)
    mocks.execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, " M file.ts\n", ""));

    const result = await runCliAgent(makeArgs());
    expect(result).toEqual({ changed: true, modelCalls: 1, tokens: 0, stoppedReason: "done" });
    // config written to a 0600 file OUTSIDE the repo dir (cfgDir under tmp)
    expect(mocks.writeFile).toHaveBeenCalledWith("/tmp/sigilix-cfg-x/opencode-config.json", expect.any(String), {
      mode: 0o600,
    });
    expect(mocks.rm).toHaveBeenCalledWith("/tmp/sigilix-cfg-x", { recursive: true, force: true });
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
