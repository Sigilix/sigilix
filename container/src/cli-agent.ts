/**
 * Full Sigilix CLI agent engine (SIG-545 B2).
 *
 * Runs the compiled Sigilix CLI (the opencode fork) headless to implement a
 * ticket, as an alternative to the minimal 5-tool loop (agent-loop.ts). Returns
 * the SAME EditLoopResult contract so server.ts can switch engines transparently.
 *
 * SECURITY: the full agent has a wide tool surface. On untrusted input the
 * container is the only boundary, so this renders a HARDENED OPENCODE_CONFIG
 * (deny bash/webfetch/websearch/subagents) + hardening env flags, and runs with
 * a per-run timeout. See the B2 design doc for the full threat model.
 *
 * ⚠️ PERMISSION MODEL — Part-2 security gate (DO NOT expose to untrusted input
 * until resolved). This Part-1 foundation uses a deny-LIST config; the agent
 * only edits headless when run with opencode's `--dangerously-skip-permissions`,
 * which auto-approves every NOT-explicitly-denied tool — making the deny list
 * the sole boundary. That bypass is therefore OPT-IN (off by default; gated on
 * SIGILIX_AGENT_SKIP_PERMISSIONS), never unconditionally baked in. Part 2 MUST,
 * before any trusted OR untrusted use, against the real binary:
 *   (a) replace the bypass with a config-respecting non-interactive / deny-by-
 *       default (allow-LIST) permission mode, and add a negative test asserting a
 *       `bash` tool_use in the NDJSON stream is rejected by the runtime; and
 *   (b) enforce container network egress isolation (block the cloud metadata
 *       endpoint + every non-allowlisted host), since a config deny alone does
 *       not stop a compromised runtime from reaching the network.
 *
 * TOKEN SAFETY: model.key and the grounding apiKey are written only to a
 * 0600 temp config (outside the repo) and the child env — NEVER logged.
 *
 * NOTE: ships dark (server.ts selects this only when packet.engine === "full",
 * which is gated to trusted callers). The compiled CLI binary + bundled grounding
 * plugin are provisioned into the image in a follow-up (B2 Part 2).
 */

import { spawn, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EditLoopArgs, EditLoopResult, StoppedReason } from "./agent-loop.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface CliAgentArgs extends EditLoopArgs {
  /** Grounding endpoint for the sigilix-grounding plugin. Keys NEVER logged. */
  sigilix?: {
    endpoint?: string;
    apiKey?: string;
    repoSlug?: string;
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** The CLI executable. Overridable for tests / image layout. */
const CLI_BIN = process.env.SIGILIX_CLI_BIN ?? "opencode";

/** Absolute path to the pre-bundled sigilix-grounding plugin in the image. */
const GROUNDING_PLUGIN_PATH = process.env.SIGILIX_GROUNDING_PLUGIN ?? "/opt/sigilix/grounding/index.js";

/** Synthetic provider id the rendered config registers for the packet's model. */
const PROVIDER_ID = "runner";

/** OpenAI-compatible default (OpenRouter), mirroring agent-loop.ts. */
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/** Cap on captured stdout (bytes) so a verbose run can't balloon memory. */
const STDOUT_CAP = 5_000_000;

/**
 * Whether to pass opencode's `--dangerously-skip-permissions` (auto-approve every
 * not-explicitly-denied tool). OFF by default — the full bypass is never baked in
 * unconditionally. Part 2 replaces this with a config-respecting deny-by-default
 * mode verified against the real binary (see the header security gate).
 */
const SKIP_PERMISSIONS = process.env.SIGILIX_AGENT_SKIP_PERMISSIONS === "1";

// ── Config / env / prompt builders (pure, unit-tested) ────────────────────────

/**
 * Render the hardened OPENCODE_CONFIG for one run. Registers the packet's model
 * as an OpenAI-compatible provider and applies the deny-default ruleset.
 *
 * Deny list (the container is the only boundary on untrusted input):
 *   bash      — no arbitrary shell (founder decision; a build/test allow-list
 *               is a later refinement against the real binary).
 *   webfetch / websearch — no outbound model-driven network.
 *   task      — no subagents.
 *   skill / lsp / plan_exit — peripheral surface.
 * The editing core (read/edit/write/grep/glob) is left at the default (allow);
 * note opencode collapses edit/write/apply_patch into the "edit" key, so it is
 * deliberately NOT denied. model.key is embedded — write to a 0600 file only.
 */
export function buildOpencodeConfig(
  model: CliAgentArgs["model"],
  groundingPluginPath: string,
): Record<string, unknown> {
  const baseURL = model.baseUrl ?? DEFAULT_BASE_URL;
  return {
    $schema: "https://opencode.ai/config.json",
    model: `${PROVIDER_ID}/${model.id}`,
    provider: {
      [PROVIDER_ID]: {
        // npm tells opencode how to instantiate this otherwise-unknown provider id
        // (OpenAI-compatible chat-completions). Verify against the real binary in Part 2.
        npm: "@ai-sdk/openai-compatible",
        name: "Sigilix agent-runner",
        options: { baseURL, apiKey: model.key },
        models: { [model.id]: { name: model.id } },
      },
    },
    plugin: [groundingPluginPath],
    permission: {
      bash: "deny",
      webfetch: "deny",
      websearch: "deny",
      task: "deny",
      skill: "deny",
      lsp: "deny",
      plan_exit: "deny",
    },
  };
}

/**
 * Build the child-process env: hardening flags + grounding wiring layered over a
 * base env. Secrets (grounding apiKey) are included but this object is NEVER
 * logged. OPENCODE_CONFIG is set by the caller (it points at the temp file).
 */
export function buildCliEnv(
  args: Pick<CliAgentArgs, "sigilix">,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    // Sealed-container hardening (no autoupdate / LSP download / share / drive-by config).
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_SHARE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  };
  if (args.sigilix?.endpoint) env.SIGILIX_ENDPOINT = args.sigilix.endpoint;
  if (args.sigilix?.apiKey) env.SIGILIX_API_KEY = args.sigilix.apiKey;
  if (args.sigilix?.repoSlug) env.SIGILIX_REPO_SLUG = args.sigilix.repoSlug;
  return env;
}

/** Compose the run prompt from the ticket (+ optional packet grounding fallback). */
export function buildPrompt(ticket: CliAgentArgs["ticket"], grounding?: string): string {
  return [
    `# Ticket: ${ticket.identifier} — ${ticket.title}`,
    "",
    ticket.body,
    ...(grounding != null && grounding !== "" ? ["", "## Context", grounding] : []),
    "",
    "Implement this ticket with the minimal change, then stop.",
  ].join("\n");
}

/**
 * Parse the CLI's `--format json` NDJSON event stream.
 * Counts `step_finish` events as model turns and flags any error event.
 * Lines that don't parse are skipped (robust to partial/non-JSON output).
 */
export function parseCliEvents(stdout: string): { modelCalls: number; errored: boolean } {
  let modelCalls = 0;
  let errored = false;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (ev.type === "step_finish") modelCalls++;
    if (ev.type === "error" || ev.error != null) errored = true;
  }
  return { modelCalls, errored };
}

/**
 * Build the `opencode run` argv. `--dangerously-skip-permissions` is included
 * ONLY when skipPermissions is true (opt-in) — otherwise opencode falls back to
 * its config-respecting permission gating (the rendered deny list / future
 * deny-by-default). Pure + exported so the default-off posture is unit-tested.
 */
export function buildCliArgs(
  model: CliAgentArgs["model"],
  dir: string,
  prompt: string,
  skipPermissions: boolean,
): string[] {
  return [
    "run",
    prompt,
    "-m",
    `${PROVIDER_ID}/${model.id}`,
    ...(skipPermissions ? ["--dangerously-skip-permissions"] : []),
    "--format",
    "json",
    "--dir",
    dir,
  ];
}

// ── Subprocess + git helpers ──────────────────────────────────────────────────

interface SpawnResult {
  stdout: string;
  code: number | null;
  timedOut: boolean;
}

/** Spawn the CLI, capture stdout, and SIGKILL it past timeoutMs. Never rejects. */
function spawnCli(
  bin: string,
  cliArgs: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let timedOut = false;
    let settled = false;
    const finish = (r: SpawnResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    // detached → the child leads its own process group, so we can SIGKILL the
    // WHOLE group on timeout and not orphan opencode-spawned subprocesses.
    const child = spawn(bin, cliArgs, { cwd: opts.cwd, env: opts.env, detached: true });
    const killGroup = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      // Size-cap the buffer so a runaway-verbose run can't balloon memory.
      if (stdout.length < STDOUT_CAP) stdout += d.toString();
    });
    // stderr may carry the model body on failure — drained but NOT captured/logged.
    child.stderr?.on("data", () => {});
    child.on("error", () => finish({ stdout, code: -1, timedOut }));
    child.on("close", (code) => finish({ stdout, code, timedOut }));
  });
}

/** True iff the working tree has uncommitted changes (porcelain non-empty). */
function hasChanges(dir: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["status", "--porcelain"], { cwd: dir }, (err, stdout) => {
      resolve(err ? false : stdout.trim().length > 0);
    });
  });
}

// ── Engine entry point ────────────────────────────────────────────────────────

/**
 * Run the full CLI agent against an already-cloned repo dir. Returns the
 * EditLoopResult contract; `changed` reflects the real working-tree diff so a
 * no-op run never produces a spurious PR. Never throws.
 */
export async function runCliAgent(args: CliAgentArgs): Promise<EditLoopResult> {
  const { dir, ticket, grounding, model, caps } = args;
  let cfgDir: string | undefined;
  let modelCalls = 0;
  let stoppedReason: StoppedReason = "error";

  try {
    // Write the hardened config OUTSIDE the repo so it never shows up in git status.
    cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigilix-cfg-"));
    const configPath = path.join(cfgDir, "opencode-config.json");
    await fs.writeFile(configPath, JSON.stringify(buildOpencodeConfig(model, GROUNDING_PLUGIN_PATH)), {
      mode: 0o600,
    });

    const env = buildCliEnv(args);
    env.OPENCODE_CONFIG = configPath;

    const cliArgs = buildCliArgs(model, dir, buildPrompt(ticket, grounding), SKIP_PERMISSIONS);

    // CAPS GAP (Part 2): unlike the minimal loop, this enforces only caps.timeoutMs
    // (via the SIGKILL below). caps.maxModelCalls / maxTokens are NOT yet enforced and
    // tokens is reported as 0 — Part 2 wires opencode's own step/token budget + parses
    // usage from the event stream so the wider engine has a call/cost ceiling.
    const { stdout, code, timedOut } = await spawnCli(CLI_BIN, cliArgs, {
      cwd: dir,
      env,
      timeoutMs: caps.timeoutMs,
    });

    const parsed = parseCliEvents(stdout);
    modelCalls = parsed.modelCalls;
    stoppedReason = timedOut ? "timeout" : code === 0 && !parsed.errored ? "done" : "error";

    const changed = await hasChanges(dir);
    return { changed, modelCalls, tokens: 0, stoppedReason };
  } catch {
    return { changed: false, modelCalls, tokens: 0, stoppedReason: "error" };
  } finally {
    if (cfgDir !== undefined) {
      try {
        await fs.rm(cfgDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}
