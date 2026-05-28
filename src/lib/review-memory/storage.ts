// ARC-189 — KV storage layer (Task 4).
//
// Two parallel keyspaces over the existing `OPENCLAW_STATE` namespace:
//
//   review-memory:<owner>/<repo>:cat:<category>                     (legacy)
//   review-memory:<owner>/<repo>:path:<sha256>:cat:<category>       (legacy)
//
// SIG-247 Phase 1 added the immutable-id keyspace (transfer-proof):
//
//   review-memory:repo:<github_repo_id>:cat:<category>
//   review-memory:repo:<github_repo_id>:path:<sha256>:cat:<category>
//
// During the Phase 1 → Phase 5 transition, every write is a DUAL-WRITE
// (both keys) and every read is a UNION (both keys, dedupe by
// `commentId`). Phase 5 drops the legacy reads and runs a final
// reconciliation backfill before deleting the legacy writes.
//
// Both store the same `ReviewMemoryRecord` shape with
// `schemaVersion: 1` so future schema changes are value-driven and
// don't require re-keying (spec §4.4).
//
// Concurrency contract (spec §4.2):
//   - Workers KV does NOT provide CAS. `appendSignal` is a
//     read-modify-write that loses one signal under same-key
//     concurrent deliveries. The 90d activation window + threshold-3
//     absorbs the loss. SIG-247 adds `commentId` idempotent dedup so
//     redundant deliveries of the same dismissal are no-ops.
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
 * Legacy canonical KV key per spec §4.4. Note the FULL `pathSha256`
 * lands in the key for path-scoped records — the 12-hex truncation is
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

/**
 * SIG-247 Phase 1: immutable-id keyspace. Same shape as `buildKey` but
 * keyed by GitHub's immutable `repo.id` instead of mutable `(owner,
 * repo)` strings. Used in parallel with the legacy key under the
 * dual-write contract.
 */
export function buildRepoIdKey(
  repoId: number,
  scope: ReviewMemoryStorageScope,
): string {
  const base = `review-memory:repo:${repoId}`
  if (scope.kind === "category") {
    return `${base}:cat:${scope.category}`
  }
  return `${base}:path:${scope.pathSha256}:cat:${scope.category}`
}

function isValidRepoId(repoId: number | undefined): repoId is number {
  return (
    typeof repoId === "number" && Number.isInteger(repoId) && repoId > 0
  )
}

interface ResolvedKeys {
  legacy: string
  repoId: string | null
}

function resolveKeys(
  owner: string,
  repo: string,
  scope: ReviewMemoryStorageScope,
  repoId: number | undefined,
): ResolvedKeys {
  return {
    legacy: buildKey(owner, repo, scope),
    repoId: isValidRepoId(repoId) ? buildRepoIdKey(repoId, scope) : null,
  }
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

// ─── Pure union helper (SIG-247 Phase 1) ─────────────────────

/**
 * Union two `ReviewMemoryRecord` values by `commentId` dedup. The
 * survivor for any duplicate `commentId` is the one with the most
 * recent `ts` (in practice they should be identical when dual-write
 * succeeds — divergence happens on partial-write failure or
 * mid-migration captures). Result is sorted by `ts` descending and
 * capped to `SIGNAL_FIFO_CAP` newest. Pure; returns a fresh record.
 *
 * Callers MUST pass records produced from the same `scope`. The
 * returned record's `category` + `pathSha256` are taken from `scope`.
 */
export function unionRecords(
  a: ReviewMemoryRecord | null,
  b: ReviewMemoryRecord | null,
  scope: ReviewMemoryStorageScope,
): ReviewMemoryRecord | null {
  if (a === null && b === null) return null
  if (a === null) return b
  if (b === null) return a
  const byCommentId = new Map<number, ReviewMemorySignal>()
  for (const s of [...a.signals, ...b.signals]) {
    const existing = byCommentId.get(s.commentId)
    if (existing === undefined) {
      byCommentId.set(s.commentId, s)
      continue
    }
    // NaN-safe ts compare: if the existing signal's `ts` is malformed
    // (Date.parse → NaN), prefer the candidate when its `ts` IS finite
    // — otherwise a malformed-existing would stick forever because
    // `candidateTs > NaN` evaluates to false.
    const existingTs = Date.parse(existing.ts)
    const candidateTs = Date.parse(s.ts)
    const candidateValid = Number.isFinite(candidateTs)
    const existingValid = Number.isFinite(existingTs)
    if (candidateValid && (!existingValid || candidateTs > existingTs)) {
      byCommentId.set(s.commentId, s)
    }
  }
  // NaN-safe descending sort (CR-2): `Date.parse` returns NaN on
  // malformed input; a naive `y-x` comparator returning NaN makes
  // Array.prototype.sort behavior engine-defined. Push malformed
  // timestamps to the end so the FIFO cap evicts them first.
  const merged = Array.from(byCommentId.values())
    .sort((x, y) => {
      const xTs = Date.parse(x.ts)
      const yTs = Date.parse(y.ts)
      const xValid = Number.isFinite(xTs)
      const yValid = Number.isFinite(yTs)
      if (xValid && yValid) return yTs - xTs
      if (xValid) return -1
      if (yValid) return 1
      return 0
    })
    .slice(0, SIGNAL_FIFO_CAP)
  const lastUpdatedTs =
    a.lastUpdatedTs > b.lastUpdatedTs ? a.lastUpdatedTs : b.lastUpdatedTs
  // SIG-247 Phase 1 PR B: preserve the `migratedAt` sentinel across
  // union cycles. Pick the EARLIER of any present timestamps — this
  // is the "first migrated" semantic, not "most-recently touched".
  // Without this, every post-migration read-modify-write would
  // silently drop the sentinel, breaking Phase 5's "was this record
  // migrated?" advisory.
  const aMigratedAt = a.migratedAt
  const bMigratedAt = b.migratedAt
  const migratedAt =
    aMigratedAt !== undefined && bMigratedAt !== undefined
      ? aMigratedAt < bMigratedAt
        ? aMigratedAt
        : bMigratedAt
      : (aMigratedAt ?? bMigratedAt)
  const base: ReviewMemoryRecord = {
    schemaVersion: 1,
    category: scope.category,
    signals: merged,
    lastUpdatedTs,
    ...(migratedAt !== undefined ? { migratedAt } : {}),
    ...(scope.kind === "path-category"
      ? { pathSha256: scope.pathSha256 }
      : {}),
  }
  return base
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

async function readSingleKey(
  env: Env,
  owner: string,
  repo: string,
  key: string,
): Promise<ReviewMemoryRecord | null> {
  let raw: string | null
  try {
    raw = await env.OPENCLAW_STATE.get(key)
  } catch (err) {
    emitTelemetry("review-memory-lookup-failed", {
      owner,
      repo,
      key,
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
      owner,
      repo,
      key,
      reason: "json-parse-failed",
    })
    return null
  }
  if (!isValidRecord(parsed)) {
    emitTelemetry("review-memory-corrupt-record", {
      owner,
      repo,
      key,
      reason: "schema-mismatch",
    })
    return null
  }
  return parsed
}

/**
 * Read a `ReviewMemoryRecord` from KV. Returns `null` on:
 *   - missing key (no telemetry — common path)
 *   - corrupt JSON (`review-memory-corrupt-record` telemetry)
 *   - schema-version mismatch (`review-memory-corrupt-record` telemetry)
 *   - KV throw (`review-memory-lookup-failed` telemetry)
 *
 * SIG-247 Phase 1: when `repoId` is provided AND positive-integer, reads
 * BOTH the legacy key and the repo-id key, unions the records on
 * `commentId`, and returns the merged record. Naive new-first/legacy-
 * fallback would mask a fresher legacy record when the new key is
 * stale during the dual-write window — union semantics are mandatory.
 *
 * Never throws.
 */
export async function readMemory(
  env: Env,
  owner: string,
  repo: string,
  scope: ReviewMemoryStorageScope,
  repoId?: number,
): Promise<ReviewMemoryRecord | null> {
  const keys = resolveKeys(owner, repo, scope, repoId)
  const [legacyRecord, repoIdRecord] = await Promise.all([
    readSingleKey(env, owner, repo, keys.legacy),
    keys.repoId !== null
      ? readSingleKey(env, owner, repo, keys.repoId)
      : Promise.resolve(null),
  ])
  if (keys.repoId === null) return legacyRecord
  return unionRecords(legacyRecord, repoIdRecord, scope)
}

// ─── appendSignal ────────────────────────────────────────────

interface AppendSignalResult {
  written: boolean
  signalCount: number
  /** SIG-247 Phase 1 telemetry surface — present in tests + canary metrics. */
  legacyWritten: boolean
  newWritten: boolean
  /** True when a repoId was supplied AND legacy/new write outcomes diverged. */
  partialDualWrite: boolean
  repoIdPresent: boolean
  /** True when the signal's `commentId` was already in the merged record. */
  skippedDuplicate: boolean
}

/**
 * Read-modify-write: load existing record (or create fresh),
 * prune-then-append, FIFO-cap at 50, refresh 90d TTL.
 *
 * SIG-247 Phase 1: when `repoId` is provided AND positive-integer, the
 * write goes to BOTH the legacy key and the new repo-id key with the
 * same payload (dual-write). The read step already produces a unioned
 * record via `readMemory`, so both keys converge over time even when
 * one write fails. Appends are idempotent on `commentId` — redundant
 * webhook deliveries of the same dismissal don't double-count.
 *
 * Best-effort under KV no-CAS: concurrent appends on the same key can
 * still lose one signal. Spec §4.2 documents this; threshold-3
 * activation absorbs single-write-loss races. Never throws.
 */
export async function appendSignal(
  env: Env,
  owner: string,
  repo: string,
  scope: ReviewMemoryStorageScope,
  signal: ReviewMemorySignal,
  repoId?: number,
): Promise<AppendSignalResult> {
  const keys = resolveKeys(owner, repo, scope, repoId)
  const repoIdPresent = keys.repoId !== null
  const existing = await readMemory(env, owner, repo, scope, repoId)
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  // Build the fresh record. Treat corrupt/missing existing as fresh
  // so a corrupted record self-heals on the next write rather than
  // blocking new captures forever.
  const base: ReviewMemoryRecord = existing ?? {
    schemaVersion: 1,
    category: scope.category,
    signals: [],
    lastUpdatedTs: nowIso,
    ...(scope.kind === "path-category"
      ? { pathSha256: scope.pathSha256 }
      : {}),
  }
  // Idempotent dedup on commentId — redundant deliveries no-op.
  // Note: a duplicate-only path SKIPS pruning + cap-trimming. The
  // existing record was already valid (just-read), so leaving its
  // signals untouched is correct; a stale-signal cleanup only fires
  // on the next real (non-duplicate) append. Trade-off: a record can
  // briefly carry >180d signals if every subsequent write is a dup,
  // which is impossible in practice (each dismissal has a fresh
  // commentId). Lookup-side `isMemoryActive` re-filters by 90d
  // window anyway, so stale carry has zero observable effect.
  const skippedDuplicate = base.signals.some(
    (s) => s.commentId === signal.commentId,
  )
  let nextSignals: ReviewMemorySignal[]
  if (skippedDuplicate) {
    nextSignals = base.signals
  } else {
    const pruned = pruneStaleSignals(base, nowMs)
    // FIFO-cap at 50 BEFORE appending the new signal — drop oldest
    // first. After append, exactly SIGNAL_FIFO_CAP entries.
    const overflow = pruned.signals.length - (SIGNAL_FIFO_CAP - 1)
    const trimmed =
      overflow > 0 ? pruned.signals.slice(overflow) : pruned.signals
    nextSignals = [...trimmed, signal]
  }
  const next: ReviewMemoryRecord = {
    ...base,
    signals: nextSignals,
    lastUpdatedTs: nowIso,
  }
  const payload = JSON.stringify(next)
  // Dual-write — both keys get the same payload. Promise.allSettled
  // so a single-key failure is recoverable: the next append + Phase 5
  // reconciliation backfill close the divergence.
  const [legacyResult, repoIdResult] = await Promise.allSettled([
    env.OPENCLAW_STATE.put(keys.legacy, payload, {
      expirationTtl: TTL_SECONDS,
    }),
    keys.repoId !== null
      ? env.OPENCLAW_STATE.put(keys.repoId, payload, {
          expirationTtl: TTL_SECONDS,
        })
      : Promise.resolve(),
  ])
  const legacyWritten = legacyResult.status === "fulfilled"
  const newWritten = repoIdPresent && repoIdResult.status === "fulfilled"
  const partialDualWrite = repoIdPresent && legacyWritten !== newWritten
  if (legacyResult.status === "rejected") {
    emitTelemetry("review-memory-capture-failed", {
      owner,
      repo,
      key: keys.legacy,
      stage: "kv-write",
      key_mode: "legacy",
      err:
        legacyResult.reason instanceof Error
          ? legacyResult.reason.message
          : String(legacyResult.reason),
    })
  }
  if (repoIdPresent && repoIdResult.status === "rejected") {
    emitTelemetry("review-memory-capture-failed", {
      owner,
      repo,
      key: keys.repoId,
      stage: "kv-write",
      key_mode: "repo-id",
      err:
        repoIdResult.reason instanceof Error
          ? repoIdResult.reason.message
          : String(repoIdResult.reason),
    })
  }
  if (repoIdPresent) {
    // Three-way event split so dashboards counting `succeeded` as a
    // positive metric don't double-count on the both-fail case (where
    // `partialDualWrite` is false because legacy === new === false).
    const dualWriteEvent =
      !legacyWritten && !newWritten
        ? "review-memory-dual-write-failed"
        : partialDualWrite
          ? "review-memory-dual-write-partial"
          : "review-memory-dual-write-succeeded"
    emitTelemetry(dualWriteEvent, {
      owner,
      repo,
      repoId,
      legacy_written: legacyWritten,
      new_written: newWritten,
      skipped_duplicate: skippedDuplicate,
    })
  }
  return {
    written: legacyWritten || newWritten,
    signalCount: next.signals.length,
    legacyWritten,
    newWritten,
    partialDualWrite,
    repoIdPresent,
    skippedDuplicate,
  }
}
