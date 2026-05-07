// ARC-190: PrReviewRunDO class + pure decision helpers.
//
// Spec: docs/superpowers/specs/2026-05-07-arc-190-durable-objects-webhook-ingest-design.md
// Plan: docs/superpowers/plans/2026-05-07-arc-190-durable-objects-webhook-ingest.md
//
// Task 2 lands the helpers. Route dispatch + storage I/O lands in
// Task 5. Until Task 5, fetch() returns 501 — the env gate
// (OPENCLAW_PR_REVIEW_MODE === "off") guarantees no traffic.

import { DurableObject } from "cloudflare:workers"
import type { Env } from "../index"
import type {
  EnqueueAction,
  EnqueueRequest,
  RunRecord,
  RunResultRequest,
  RunState,
} from "./types"

// ─── Class ────────────────────────────────────────────────────

export class PrReviewRunDO extends DurableObject<Env> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override async fetch(_request: Request): Promise<Response> {
    return new Response(
      JSON.stringify({ error: "not-implemented", reason: "ARC-190 Task 5 pending" }),
      { status: 501, headers: { "content-type": "application/json" } },
    )
  }
}

// ─── Pure decision helpers ────────────────────────────────────

/** Spec §4.5 — same SHA = same logical run. */
export function isSupersededByNewSha(state: RunState, incomingHeadSha: string): boolean {
  return state.headSha !== incomingHeadSha
}

/**
 * Spec §4.5 enqueue decision tree (pure).
 * - null state → first run for this PR → create
 * - same SHA + active state (queued | running) → dedupe-active
 * - same SHA + terminal (done | failed) → dedupe-terminal
 * - different SHA → supersede (caller archives old run + starts fresh)
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
  // Same SHA from here.
  if (state.state === "queued" || state.state === "running" || state.state === "failed-transient") {
    return { action: "dedupe-active", reason: `same-sha-active-${state.state}` }
  }
  // done | failed | idle — terminal for this SHA.
  return { action: "dedupe-terminal", reason: `same-sha-terminal-${state.state}` }
}

export type PickupActionKind =
  | "claim"
  | "stale-runId-410"
  | "terminal-410"
  | "duplicate-409"

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
  // queued | failed-transient | idle → claim is allowed.
  return { action: "claim" }
}

/**
 * Spec §4.6 backoff schedule. attempts is 1-indexed (the failed
 * attempt's count). Schedule: 30s / 90s / 270s, then clamps at 270s.
 */
const BACKOFF_TABLE = [30000, 90000, 270000] as const

export function nextBackoffMs(attempts: number): number {
  if (attempts <= 1) return BACKOFF_TABLE[0]
  if (attempts === 2) return BACKOFF_TABLE[1]
  return BACKOFF_TABLE[2]
}

/**
 * Spec §4.6 /run-result decision tree (pure).
 *
 * Inputs:
 *   - state: current RunState (null treated as missing)
 *   - payload: caller's result claim
 *   - maxRetries: from resolveDoConfig
 *   - nowMs: clock injection for deterministic tests
 *
 * Outputs:
 *   - transition: target RunState.state OR "history" (write to
 *     historical record, do NOT mutate current state)
 *   - nextAlarmAt: ms timestamp when retry alarm should fire (only
 *     set when transition === "failed-transient")
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
  // Stale runId or stale consumerId → write to history, don't touch
  // current state (spec §4.6 superseded-consumer late post).
  if (state.runId !== payload.runId) {
    return { transition: "history" }
  }
  if (state.consumerId && state.consumerId !== payload.consumerId) {
    return { transition: "history" }
  }
  if (payload.status === "success") {
    return { transition: "done" }
  }
  if (payload.status === "terminal") {
    return { transition: "failed" }
  }
  // Transient
  if (state.attempts >= maxRetries) {
    return { transition: "failed" }
  }
  return {
    transition: "failed-transient",
    nextAlarmAt: nowMs + nextBackoffMs(state.attempts),
  }
}

/**
 * Spec §4.10 — FIFO eviction of oldest history records once `limit`
 * is exceeded. "Oldest" = lowest `finishedAt` ISO string (lexically
 * sortable). Pure.
 */
export function pruneHistoryRecords(
  records: Record<string, RunRecord>,
  limit: number,
): { kept: Record<string, RunRecord>; evicted: number } {
  const all = Object.entries(records)
  if (all.length <= limit) {
    return { kept: { ...records }, evicted: 0 }
  }
  // Sort by finishedAt ASC; keep the LAST `limit` (newest).
  all.sort((a, b) => a[1].finishedAt.localeCompare(b[1].finishedAt))
  const keep = all.slice(all.length - Math.max(0, limit))
  const kept: Record<string, RunRecord> = {}
  for (const [k, v] of keep) kept[k] = v
  return { kept, evicted: all.length - keep.length }
}
