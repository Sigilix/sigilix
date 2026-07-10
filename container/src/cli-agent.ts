/**
 * Full Sigilix CLI agent engine (SIG-545 B2).
 *
 * Runs the compiled Sigilix CLI (the opencode fork) headless to implement a
 * ticket, as an alternative to the minimal 5-tool loop (agent-loop.ts). Returns
 * the SAME EditLoopResult contract so server.ts can switch engines transparently.
 *
 * SECURITY: the full agent has a wide tool surface. On untrusted input the
 * container is the only boundary, so this renders a HARDENED OPENCODE_CONFIG
 * (deny-by-default allow-list) + hardening env flags, and runs with a per-run
 * timeout. See the B2 design doc for the full threat model.
 *
 * ⚠️ PERMISSION MODEL — the deny-by-default allow-list (Part-2 (a), DONE). The
 * config allows ONLY the editing core (read/edit/write/grep/glob/list/todowrite)
 * with a `"*": "deny"` catch-all; NO `--dangerously-skip-permissions`. Verified
 * against the real binary (@sigilix/cli 1.17.14, Ollama Turbo, node:22-slim
 * linux/amd64): allowed in-repo edits auto-approve headless with no hang;
 * `{"*":"deny"}` blocks the same edit; a forced bash task never runs; and an
 * out-of-repo write (`filepath:/tmp/…`) is ATTEMPTED by the model and REJECTED
 * at runtime (NDJSON tool part `state.status:"error"`, file never created) —
 * the observed execute-time negative. Runtime rejection is belt-and-suspenders
 * in the fork: a `"*"`-denied tool is filtered out of the model's toolset
 * (registry `whollyDisabled`) AND hard-fails `DeniedError` at execute
 * (`permission.assert`). This is verified manually against a live model; it is
 * NOT in this offline unit suite (which has no model) — the automated live
 * runtime-rejection test belongs in a key-gated e2e (cf. the logic-recall
 * evals), tracked as a follow-up.
 *
 * ⚠️ STILL OPEN before ANY untrusted use (keep engine flag-gated OFF):
 *   (b) container network EGRESS isolation — block the cloud metadata endpoint
 *       (169.254.169.254) + every non-allowlisted host. A config deny does not
 *       stop a compromised runtime reaching the network. Genuinely hard on an
 *       unprivileged CF Container (no NET_ADMIN/iptables) → likely a broker
 *       re-arch. This is the primary remaining gate.
 *   (c) secret-scoping — read/write are unrestricted within the run, and the
 *       model.key sits in the 0600 OPENCODE_CONFIG the same-user agent can read.
 *       So an attacker-controlled ticket can read a secret and WRITE it into a
 *       repo file that surfaces in the PR diff — a network-free exfil path that
 *       egress isolation does NOT close. Mitigations (broker the model call so
 *       the agent never holds the key; scrub secrets from the diff pre-PR) land
 *       with (b). Bounded today only by the engine being flag-gated off.
 *
 * TOKEN SAFETY: model.key and the grounding apiKey are written only to a
 * 0600 temp config (outside the repo) and the child env — NEVER logged.
 *
 * NOTE: ships dark (server.ts selects this only when packet.engine === "full",
 * which is gated to trusted callers). The CLI binary is now provisioned into the
 * image (@sigilix/cli, SIGILIX_CLI_BIN); the grounding plugin is provisioned in a
 * follow-up (until then GROUNDING_PLUGIN_PATH is empty and the plugin is omitted).
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
const CLI_BIN = process.env.SIGILIX_CLI_BIN ?? "sigilix";

/**
 * Absolute path to the pre-bundled sigilix-grounding plugin in the image. Empty
 * until the plugin is provisioned — the Dockerfile ships the CLI binary but NOT
 * yet the grounding plugin, so this defaults empty and buildOpencodeConfig omits
 * the `plugin` entry rather than pointing opencode at a missing file (a crash).
 * Set SIGILIX_GROUNDING_PLUGIN in the image once the plugin is provisioned.
 */
const GROUNDING_PLUGIN_PATH = process.env.SIGILIX_GROUNDING_PLUGIN ?? "";

/** Synthetic provider id the rendered config registers for the packet's model. */
const PROVIDER_ID = "runner";

/** OpenAI-compatible default (OpenRouter), mirroring agent-loop.ts. */
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/** Cap on captured stdout (bytes) so a verbose run can't balloon memory. */
const STDOUT_CAP = 5_000_000;

// ── Config / env / prompt builders (pure, unit-tested) ────────────────────────

/**
 * Render the hardened OPENCODE_CONFIG for one run. Registers the packet's model
 * as an OpenAI-compatible provider and applies a DENY-BY-DEFAULT (allow-list)
 * permission map — the container is the only boundary on untrusted input.
 *
 * The `"*": "deny"` catch-all is the security posture AND a headless invariant:
 * opencode's unmatched-tool default is "ask" (which, with no interactive prompter
 * in `run`, would hang). Catching all with deny makes every tool resolve to
 * allow|deny, never ask. Only the editing core is explicitly allowed; everything
 * else (bash, webfetch, websearch, task/subagents, skill, lsp, …) falls through
 * the catch-all to deny — filtered out of the model's toolset AND hard-rejected
 * at execute-time (opencode `permission.assert` → DeniedError).
 *
 * Verified against the real binary (@sigilix/cli 1.17.14, Ollama Turbo): the
 * allow-list runs headless without `--dangerously-skip-permissions` and without
 * hanging (allowed edits auto-approve), `"*":"deny"` blocks the same edit, and a
 * forced bash task never runs. Note opencode collapses edit/write/apply_patch
 * into the "edit" key. model.key is embedded — write to a 0600 file only.
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
        // (OpenAI-compatible chat-completions).
        npm: "@ai-sdk/openai-compatible",
        name: "Sigilix agent-runner",
        options: { baseURL, apiKey: model.key },
        models: { [model.id]: { name: model.id } },
      },
    },
    // Only wire the grounding plugin when it is actually provisioned — pointing
    // opencode at a missing plugin file would crash the run.
    ...(groundingPluginPath ? { plugin: [groundingPluginPath] } : {}),
    permission: {
      // Deny-by-default: catch-all first, then the editing core allow-list.
      "*": "deny",
      read: "allow",
      edit: "allow",
      write: "allow",
      grep: "allow",
      glob: "allow",
      list: "allow",
      todowrite: "allow",
      // Keep edit/write inside the cloned repo — deny mutation of any directory
      // outside the active Location (opencode gates out-of-dir writes on this).
      external_directory: "deny",
    },
  };
}

/**
 * Build the child-process env: hardening flags + grounding wiring layered over a
 * base env. Secrets (grounding apiKey) are included but this object is NEVER
 * logged. OPENCODE_CONFIG is set by the caller (it points at the temp file).
 *
 * `groundingActive` gates the grounding secret: when the grounding plugin is not
 * provisioned nothing consumes SIGILIX_*, so injecting the secret is dead wiring
 * and a needless secret in an untrusted-input process's env (see header (c)).
 */
export function buildCliEnv(
  args: Pick<CliAgentArgs, "sigilix">,
  base: NodeJS.ProcessEnv = process.env,
  groundingActive = true,
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
  if (groundingActive) {
    if (args.sigilix?.endpoint) env.SIGILIX_ENDPOINT = args.sigilix.endpoint;
    if (args.sigilix?.apiKey) env.SIGILIX_API_KEY = args.sigilix.apiKey;
    if (args.sigilix?.repoSlug) env.SIGILIX_REPO_SLUG = args.sigilix.repoSlug;
  }
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
 * Build the `opencode run` argv. Deliberately NEVER passes
 * `--dangerously-skip-permissions`: the run relies entirely on the config's
 * deny-by-default allow-list (which auto-approves the allowed editing core
 * headless). No bypass exists, so the catch-all deny cannot be overridden by an
 * env flip. Pure + exported so the no-bypass posture is unit-tested.
 */
export function buildCliArgs(model: CliAgentArgs["model"], dir: string, prompt: string): string[] {
  return ["run", prompt, "-m", `${PROVIDER_ID}/${model.id}`, "--format", "json", "--dir", dir];
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

    // Only carry the grounding secret into the child env when the plugin that
    // consumes it is actually provisioned (see header (c) + buildCliEnv).
    const env = buildCliEnv(args, process.env, GROUNDING_PLUGIN_PATH !== "");
    env.OPENCODE_CONFIG = configPath;

    const cliArgs = buildCliArgs(model, dir, buildPrompt(ticket, grounding));

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
