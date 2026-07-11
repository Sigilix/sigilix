// SIG-545 B1: AgentRunnerContainer — Cloudflare Container DO scaffold (dark).
//
// Manages one container instance per runId. The container clones a target
// repo, runs a coding step via GLM-5.2/OpenRouter, commits a branch, and
// opens a PR. This file is the thin DO shell; dispatch + in-container logic
// arrive in later tasks (B2/B3).
//
// Spec: docs/superpowers/specs/2026-06-27-b1-cf-container-task-to-pr-design.md
//
// ⚠️  The new DO migration needs a one-time non-versioned `wrangler deploy`
//     before/alongside a `wrangler versions upload` — see infra gotcha 10211.

import { Container } from "@cloudflare/containers"
import type { DurableObject } from "cloudflare:workers"
import type { Env } from "@/src/shared/types/env"
import { normalizeEnv } from "@/src/shared/util/normalize-env"

const RUN_RECORD_KEY = "run-record"
const RUN_EVENTS_KEY = "run-events"
const RUN_EVENTS_SEQ_KEY = "run-events-seq"
const RUN_EVENT_SECRET_KEY = "run-event-secret"
// Cap the live event log so a runaway run can't grow DO storage unbounded. The
// diff pane only needs the latest per-file state, so dropping the oldest events
// past the cap is safe (a full run edits far fewer than this many files).
const MAX_RUN_EVENTS = 1000

// ── Egress isolation (phase-2 security gate B) ────────────────────────────────
// The container runs untrusted-input agent work, so its outbound network is
// deny-by-default: it may reach ONLY the hosts a run genuinely needs, and
// nothing else (every other host — incl. the cloud-metadata IP — is blocked with
// HTTP 520 by the CF Containers platform). This governs BOTH engines, including
// the LIVE minimal make-PR runner, so the list must cover its real reach:
//   • github.com / api.github.com — clone, push, open the PR (+ *.githubusercontent
//     for any raw/redirect fetch during clone)
//   • openrouter.ai / ollama.com — the model host (per-run model.baseUrl)
//   • api.sigilix.ai — grounding + the live-diff event ingest. ⚠️ COUPLING: the
//     events endpoint (SIGILIX_AGENT_EVENTS_ENDPOINT) and the full engine's
//     grounding endpoint are env-configurable — if either is ever repointed off
//     api.sigilix.ai (e.g. a *.workers.dev fallback), add that host here or it is
//     silently 520-blocked. Grounding is full-engine-only + fails gracefully, so
//     verify its prod host is api.sigilix.ai BEFORE the full engine is un-gated.
//   • registry.npmjs.org — the FULL engine's provider package (@ai-sdk/openai-
//     compatible) is fetched at runtime; the untrusted model can't drive npm
//     itself (no bash tool), so this entry is opencode's loader only.
export const AGENT_RUNNER_ALLOWED_HOSTS: readonly string[] = [
  "github.com",
  "api.github.com",
  "*.githubusercontent.com",
  "openrouter.ai",
  "ollama.com",
  "api.sigilix.ai",
  "registry.npmjs.org",
]

// Belt-and-suspenders: deny the cloud-metadata endpoint explicitly. CF does not
// document a default block, and deniedHosts is evaluated first (unconditional).
export const AGENT_RUNNER_DENIED_HOSTS: readonly string[] = ["169.254.169.254"]

/**
 * Durable run-state record stored in the DO's SQLite storage.
 * Written before dispatch and updated on completion / error.
 * Never logs tokens, keys, or installation secrets.
 */
export interface AgentRunRecord {
  runId: string
  status: "started" | "opened" | "no-change" | "error"
  prUrl?: string
  error?: string
}

/**
 * A live event emitted BY THE CONTAINER as a run works, for the portal's live
 * diff pane. `seq` is a monotonic per-run cursor the portal polls against.
 * Today only "file-edit" (a unified-diff patch for one file); the union is left
 * open for later event kinds (commands, status).
 */
export interface RunEvent {
  seq: number
  ts: number
  type: "file-edit"
  path: string
  patch: string
  additions: number
  deletions: number
}

/** Timing-safe string compare (avoids leaking the secret via early-return). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * AgentRunnerContainer — one instance per runId.
 *
 * Configured in wrangler.toml under `[[containers]]` (instance_type
 * "standard-1", max_instances 3) and `[[durable_objects.bindings]]`
 * (AGENT_RUNNER). The DO's SQLite storage holds the run record so the
 * Worker-side poller can read status without keeping the container alive.
 *
 * Dark: only dispatched when OPENCLAW_AGENT_RUNNER_MODE === "on".
 */
export class AgentRunnerContainer extends Container<Env> {
  // sig-worker-debrand-openclaw: SIGILIX_-preferred / OPENCLAW_-fallback env on
  // `this.env` (see normalize-env.ts). Dark until OPENCLAW_/SIGILIX_ AGENT_RUNNER_MODE=on.
  constructor(ctx: DurableObject<Env>["ctx"], env: Env) {
    super(ctx, normalizeEnv(env))
  }

  // Port the in-container HTTP task-runner listens on (POST / → start job).
  override defaultPort = 8080

  // One-shot runs should not idle; sleep quickly after the job completes.
  override sleepAfter = "2m"

  // Egress isolation (phase-2 gate B) — TEMPORARILY REVERTED to base network.
  // Setting enableInternet=false + allowedHosts (PR #858) broke the container in
  // prod: dispatch returns "container responded 500" for BOTH engines / any repo,
  // i.e. the container never boots (the CF platform's boot-time outbound is not
  // governed by allowedHosts, so deny-by-default starved boot). This restores the
  // pre-#858 known-good network so the LIVE minimal make-PR runner works again.
  // The allowlist/denylist consts are kept for a corrected re-add (denylist-only,
  // keeping enableInternet=true, verified with a live boot test) BEFORE the full
  // engine is ever enabled — the minimal loop is bounded and needs no egress gate.
  override enableInternet = true

  // -------------------------------------------------------------------------
  // Run-record helpers — thin SQLite accessors over the DO's durable storage.
  // The record survives container restarts and lets the Worker poll status
  // without hitting the container directly.
  // -------------------------------------------------------------------------

  /**
   * Read the current run record for this DO instance.
   * Returns null when no record has been written yet (pre-dispatch state).
   */
  async getRunRecord(): Promise<AgentRunRecord | null> {
    const record = await this.ctx.storage.get<AgentRunRecord>(RUN_RECORD_KEY)
    return record ?? null
  }

  /**
   * Persist the run record for this DO instance.
   * Called by the Worker before dispatching to the container (status: "started")
   * and by the container on completion (status: "opened" | "no-change" | "error").
   */
  async setRunRecord(r: AgentRunRecord): Promise<void> {
    await this.ctx.storage.put(RUN_RECORD_KEY, r)
  }

  // -------------------------------------------------------------------------
  // Live event log — the container streams file-edit events here as it works
  // (authenticated by a per-run secret the Worker minted at dispatch), and the
  // portal polls them via the Worker's session-authed events route. Kept apart
  // from the run record so streaming never races the terminal-status write.
  // -------------------------------------------------------------------------

  /** Store the per-run ingest secret (set by the Worker before dispatch). */
  async setRunEventSecret(secret: string): Promise<void> {
    await this.ctx.storage.put(RUN_EVENT_SECRET_KEY, secret)
  }

  /**
   * Append a container-emitted event IF the presented secret matches the one
   * stored for this run. The secret never leaves the DO — the ingest route hands
   * it in and only learns ok/rejected. Returns the assigned `seq` on success.
   */
  async appendRunEventAuthed(
    secret: string,
    event: Omit<RunEvent, "seq">,
  ): Promise<{ ok: true; seq: number } | { ok: false }> {
    const stored = await this.ctx.storage.get<string>(RUN_EVENT_SECRET_KEY)
    if (!stored || !safeEqual(stored, secret)) return { ok: false }
    const seq = ((await this.ctx.storage.get<number>(RUN_EVENTS_SEQ_KEY)) ?? 0) + 1
    const events = (await this.ctx.storage.get<RunEvent[]>(RUN_EVENTS_KEY)) ?? []
    events.push({ ...event, seq })
    // Drop the oldest beyond the cap (the diff pane keeps latest-per-file state).
    const trimmed = events.length > MAX_RUN_EVENTS ? events.slice(events.length - MAX_RUN_EVENTS) : events
    await this.ctx.storage.put(RUN_EVENTS_SEQ_KEY, seq)
    await this.ctx.storage.put(RUN_EVENTS_KEY, trimmed)
    return { ok: true, seq }
  }

  /** Read events with `seq > afterSeq`, plus the latest cursor for the next poll. */
  async getRunEvents(afterSeq: number): Promise<{ events: RunEvent[]; cursor: number }> {
    const events = (await this.ctx.storage.get<RunEvent[]>(RUN_EVENTS_KEY)) ?? []
    const cursor = (await this.ctx.storage.get<number>(RUN_EVENTS_SEQ_KEY)) ?? 0
    return { events: events.filter((e) => e.seq > afterSeq), cursor }
  }
}
