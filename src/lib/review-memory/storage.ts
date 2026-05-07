// ARC-189 — KV storage layer (Task 4).
//
// Two parallel keyspaces over the existing `OPENCLAW_STATE` namespace:
//
//   review-memory:<owner>/<repo>:cat:<category>
//   review-memory:<owner>/<repo>:path:<sha256>:cat:<category>
//
// Both store the same `ReviewMemoryRecord` shape with
// `schemaVersion: 1` so future schema changes are value-driven and
// don't require re-keying (spec §4.4).
//
// Concurrency contract (spec §4.2):
//   - Workers KV does NOT provide CAS. `appendSignal` is a
//     read-modify-write that loses one signal under same-key
//     concurrent deliveries. The 90d activation window + threshold-3
//     absorbs the loss.
//   - Failures (KV throw, JSON parse, schema-version mismatch) NEVER
//     propagate. Capture errors are logged-and-swallowed; lookup
//     errors return null. The webhook path stays best-effort.
//
// Privacy contract (spec §9):
//   - Raw repo-relative paths are NOT stored. Path scoping uses the
//     full SHA-256 in the key + value's `pathSha256` field.
//   - No reviewer identity, no PR title/body, no `evidenceQuote`.

import type {
  ReviewMemoryRecord,
  ReviewMemorySignal,
  ReviewMemoryStorageScope,
} from "./types"
import type { Env } from "../../index"

const TTL_DAYS = 90
const RETENTION_HARD_DAYS = 180
const SIGNAL_FIFO_CAP = 50
const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60

// ─── Key derivation ──────────────────────────────────────────

/**
 * Canonical KV key per spec §4.4. Note the FULL `pathSha256` lands
 * in the key for path-scoped records — the 12-hex truncation is
 * reserved for human-readable display in markers + prompts.
 */
export function buildKey(
  owner: string,
  repo: string,
  scope: ReviewMemoryStorageScope,
): string {
  const base = `review-memory:${owner}/${repo}`
  if (scope.kind === "category") {
    return `${base}:cat:${scope.category}`
  }
  return `${base}:path:${scope.pathSha256}:cat:${scope.category}`
}

// ─── Telemetry helper ────────────────────────────────────────

function emitTelemetry(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }))
}

// ─── Pure pruning helper ─────────────────────────────────────

/**
 * Drop signals older than `retentionDaysHard` (default 180). Pure:
 * returns a fresh record, never mutates the input.
 */
export function pruneStaleSignals(
  record: ReviewMemoryRecord,
  nowMs: number,
  retentionDaysHard: number = RETENTION_HARD_DAYS,
): ReviewMemoryRecord {
  const cutoffMs = nowMs - retentionDaysHard * 24 * 60 * 60 * 1000
  const kept: ReviewMemorySignal[] = []
  for (const s of record.signals) {
    const ts = Date.parse(s.ts)
    if (Number.isFinite(ts) && ts >= cutoffMs) {
      kept.push(s)
    }
  }
  return {
    ...record,
    signals: kept,
  }
}

// ─── readMemory ──────────────────────────────────────────────

function isValidRecord(value: unknown): value is ReviewMemoryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  if (r.schemaVersion !== 1) return false
  if (typeof r.category !== "string") return false
  if (!Array.isArray(r.signals)) return false
  if (typeof r.lastUpdatedTs !== "string") return false
  return true
}

/**
 * Read a `ReviewMemoryRecord` from KV. Returns `null` on:
 *   - missing key (no telemetry — common path)
 *   - corrupt JSON (`review-memory-corrupt-record` telemetry)
 *   - schema-version mismatch (`review-memory-corrupt-record` telemetry)
 *   - KV throw (`review-memory-lookup-failed` telemetry)
 *
 * Never throws.
 */
export async function readMemory(
  env: Env,
  owner: string,
  repo: string,
  scope: ReviewMemoryStorageScope,
): Promise<ReviewMemoryRecord | null> {
  const key = buildKey(owner, repo, scope)
  let raw: string | null
  try {
    raw = await env.OPENCLAW_STATE.get(key)
  } catch (err) {
    emitTelemetry("review-memory-lookup-failed", {
      owner, repo, key,
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  }
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    emitTelemetry("review-memory-corrupt-record", {
      owner, repo, key,
      reason: "json-parse-failed",
    })
    return null
  }
  if (!isValidRecord(parsed)) {
    emitTelemetry("review-memory-corrupt-record", {
      owner, repo, key,
      reason: "schema-mismatch",
    })
    return null
  }
  return parsed
}

// ─── appendSignal ────────────────────────────────────────────

interface AppendSignalResult {
  written: boolean
  signalCount: number
}

/**
 * Read-modify-write: load existing record (or create fresh),
 * prune-then-append, FIFO-cap at 50, refresh 90d TTL.
 *
 * Best-effort under KV no-CAS: concurrent appends on the same key
 * can lose one signal. Spec §4.2 documents this; threshold-3
 * activation absorbs single-write-loss races. Never throws.
 */
export async function appendSignal(
  env: Env,
  owner: string,
  repo: string,
  scope: ReviewMemoryStorageScope,
  signal: ReviewMemorySignal,
): Promise<AppendSignalResult> {
  const key = buildKey(owner, repo, scope)
  const existing = await readMemory(env, owner, repo, scope)
  const nowMs = Date.now()
  // Build the fresh record. Treat corrupt/missing existing as fresh
  // so a corrupted record self-heals on the next write rather than
  // blocking new captures forever.
  const base: ReviewMemoryRecord = existing ?? {
    schemaVersion: 1,
    category: scope.category,
    ...(scope.kind === "path-category" ? { pathSha256: scope.pathSha256 } : {}),
    signals: [],
    lastUpdatedTs: new Date(nowMs).toISOString(),
  }
  // Prune before append + cap.
  const pruned = pruneStaleSignals(base, nowMs)
  // FIFO-cap at 50 BEFORE appending the new signal — drop oldest
  // first. After append, exactly SIGNAL_FIFO_CAP entries.
  const overflow = pruned.signals.length - (SIGNAL_FIFO_CAP - 1)
  const trimmed = overflow > 0
    ? pruned.signals.slice(overflow)
    : pruned.signals
  const next: ReviewMemoryRecord = {
    ...pruned,
    signals: [...trimmed, signal],
    lastUpdatedTs: new Date(nowMs).toISOString(),
  }
  try {
    await env.OPENCLAW_STATE.put(key, JSON.stringify(next), {
      expirationTtl: TTL_SECONDS,
    })
  } catch (err) {
    emitTelemetry("review-memory-capture-failed", {
      owner, repo, key,
      stage: "kv-write",
      err: err instanceof Error ? err.message : String(err),
    })
    return { written: false, signalCount: next.signals.length }
  }
  return { written: true, signalCount: next.signals.length }
}
