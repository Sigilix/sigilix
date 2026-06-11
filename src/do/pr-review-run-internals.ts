// SIG-376 (SIG-318 Tier-1 5/8): the PrReviewRunDO's pure internals — its
// IO-free module-level utility helpers (repo-id normalization, the
// structured-log emitter, the ISO clock, the JSON-response builder) and the
// spec §4.5/§4.6/§4.10 decision functions + their backoff schedule — lifted
// out of `pr-review-run.ts` so that DO file stays under the 1,000-line
// budget. Bodies are byte-identical to their prior in-file definitions; only
// the `export` keywords (so the DO can import them) and the type-import path
// differ.
//
// The DO re-exports the six previously-public decision functions
// (`isSupersededByNewSha`, `decideEnqueueAction`, `decidePickupAction`,
// `nextBackoffMs`, `decideRunResultAction`, `pruneHistoryRecords`) and the
// `PickupActionKind` type so every importer of `@/do/pr-review-run` —
// including the co-located helpers test — is unchanged.
//
// Leaf module: imports ONLY types from `./types` (RunState, RunRecord,
// EnqueueAction, EnqueueRequest, RunResultRequest). It does NOT import
// `./pr-review-run`, so there is no cycle — the DO internals lifted out stay
// a pure leaf below the DO class.

import type { EnqueueAction, EnqueueRequest, RunRecord, RunResultRequest, RunState } from "./types"

/**
 * SIG-247 Phase 1 (CodeRabbit CR-1): defense-in-depth normalization
 * for `repoId` at the DO trust boundary. The webhook handler validates
 * `payload.repository.id` before enqueue, but the DO must not blindly
 * trust the EnqueueRequest body — a buggy or malicious caller could
 * post `NaN` / `0` / `-1` and poison the dual-write keyspace. Gate
 * every persist + queue.send through this helper.
 */
export function normalizeRepoId(repoId: number | undefined): number | undefined {
  return typeof repoId === "number" && Number.isInteger(repoId) && repoId > 0 ? repoId : undefined
}

export function emit(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, dedupe_system: "do", ...fields }))
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

// ─── Pure decision helpers ────────────────────────────────────

/** Spec §4.5 — same SHA = same logical run. */
export function isSupersededByNewSha(state: RunState, incomingHeadSha: string): boolean {
  return state.headSha !== incomingHeadSha
}

/**
 * Spec §4.5 enqueue decision tree (pure).
 * - null state → first run for this PR → create
 * - same SHA + active state (queued | running | failed-transient) → dedupe-active
 * - same SHA + terminal (done | failed | idle) → dedupe-terminal
 * - different SHA → supersede
 */
export function decideEnqueueAction(
  state: RunState | null,
  incoming: EnqueueRequest,
): { action: EnqueueAction; reason: string } {
  if (!state) {
    return { action: "create", reason: "no-existing-state" }
  }
  if (isSupersededByNewSha(state, incoming.headSha)) {
    return { action: "supersede", reason: "different-headSha" }
  }
  if (state.state === "queued" || state.state === "running" || state.state === "failed-transient") {
    return { action: "dedupe-active", reason: `same-sha-active-${state.state}` }
  }
  return { action: "dedupe-terminal", reason: `same-sha-terminal-${state.state}` }
}

export type PickupActionKind = "claim" | "stale-runId-410" | "terminal-410" | "duplicate-409"

/**
 * Spec §4.3 + §4.5 pickup decision tree (pure).
 * - null state OR runId mismatch → 410 stale-runId
 * - state running + same consumerId → 200 claim (idempotent re-pickup)
 * - state running + different consumerId → 409 duplicate-consumer
 * - state done | failed → 410 terminal
 * - state queued | failed-transient + matching runId → 200 claim
 */
export function decidePickupAction(
  state: RunState | null,
  runId: string,
  consumerId: string,
): { action: PickupActionKind } {
  if (!state) return { action: "stale-runId-410" }
  if (state.runId !== runId) return { action: "stale-runId-410" }
  if (state.state === "done" || state.state === "failed") {
    return { action: "terminal-410" }
  }
  if (state.state === "running") {
    if (state.consumerId === consumerId) return { action: "claim" }
    return { action: "duplicate-409" }
  }
  return { action: "claim" }
}

/**
 * Spec §4.6 backoff schedule. attempts is 1-indexed.
 */
const BACKOFF_TABLE = [30000, 90000, 270000] as const

export function nextBackoffMs(attempts: number): number {
  if (attempts <= 1) return BACKOFF_TABLE[0]
  if (attempts === 2) return BACKOFF_TABLE[1]
  return BACKOFF_TABLE[2]
}

/**
 * Spec §4.6 /run-result decision tree (pure).
 */
export function decideRunResultAction(
  state: RunState,
  payload: RunResultRequest,
  maxRetries: number,
  nowMs: number = Date.now(),
): {
  transition: "done" | "failed" | "failed-transient" | "history"
  nextAlarmAt?: number
} {
  if (state.runId !== payload.runId) {
    return { transition: "history" }
  }
  if (state.consumerId && state.consumerId !== payload.consumerId) {
    return { transition: "history" }
  }
  // Only an actively-running attempt can submit /run-result. If the
  // current state is anything else (idle | queued | failed-transient
  // | done | failed), the caller is a late post from an abandoned
  // attempt — its watchdog already classified it as transient and
  // either scheduled a retry (queued | failed-transient) or
  // finalized the run (done | failed). Accepting the late result
  // here would either cancel a scheduled retry, reset backoff, or
  // overwrite a terminal verdict.
  if (state.state !== "running") {
    return { transition: "history" }
  }
  if (payload.status === "success") {
    return { transition: "done" }
  }
  if (payload.status === "terminal") {
    return { transition: "failed" }
  }
  if (state.attempts >= maxRetries) {
    return { transition: "failed" }
  }
  return {
    transition: "failed-transient",
    nextAlarmAt: nowMs + nextBackoffMs(state.attempts),
  }
}

/**
 * Spec §4.10 — FIFO history eviction. Pure.
 */
export function pruneHistoryRecords(
  records: Record<string, RunRecord>,
  limit: number,
): { kept: Record<string, RunRecord>; evicted: number } {
  const all = Object.entries(records)
  if (all.length <= limit) {
    return { kept: { ...records }, evicted: 0 }
  }
  all.sort((a, b) => a[1].finishedAt.localeCompare(b[1].finishedAt))
  const keep = all.slice(all.length - Math.max(0, limit))
  const kept: Record<string, RunRecord> = {}
  for (const [k, v] of keep) kept[k] = v
  return { kept, evicted: all.length - keep.length }
}
