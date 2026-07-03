// sig-training-data-consent — the PHYSICALLY SEPARATE training store (R2).
//
// WHY R2 (vs a separate D1): a training corpus is an append-only pile of large
// text blobs (diffs, findings, chat turns, code chunks) that grows without bound
// and is read in bulk offline, never transactionally. R2 fits that shape (cheap,
// unbounded object storage) where D1 does not (row/db size limits, SQL semantics
// we do not need). More importantly for THIS feature, a dedicated bucket is a
// DIFFERENT binding from every operational store, with its own lifecycle,
// retention policy, and access grants — the separation guarantee is structural,
// not a WHERE clause someone can forget.
//
// LEAK-PROOF BY CONSTRUCTION: this module is imported ONLY by retain.ts (the
// gated writer) + the purge path. There is no operational code path — review,
// learnings, chat, indexing — that references SIGILIX_TRAINING_DATA, so
// non-consented data has nowhere to flow in. When the binding is ABSENT (the
// launch default) every write no-ops → retention is impossible regardless of any
// flag.
//
// PER-ORG ISOLATION: every object key is prefixed `installation/<id>/`. Reads,
// writes, and purges are all scoped to one installation's prefix, so one org's
// corpus can never be listed, written, or deleted under another org's partition.

import type { TrainingRecord } from "@/src/features/training-consent/domain/types"
import type { Env } from "@/src/shared/types/env"

/** The per-installation key prefix — the isolation + purge boundary. */
export function installationPrefix(installationId: number): string {
  return `installation/${installationId}/`
}

/** Build the object key for a record within its installation partition. */
export function trainingObjectKey(installationId: number, record: TrainingRecord, nowMs: number): string {
  const safeId = record.id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128) || "rec"
  return `${installationPrefix(installationId)}${record.kind}/${nowMs}-${safeId}.json`
}

/**
 * Write ONE (already-redacted) record into the installation's partition. Returns
 * true on a real write, false when the bucket binding is absent (inert launch
 * state). Never throws — a store fault is logged and swallowed (the caller,
 * retainForTraining, is best-effort and must never break a capture path).
 *
 * PRECONDITION: `record` MUST already have passed through redactTrainingRecord.
 * That ordering is guaranteed by retain.ts, the sole caller.
 */
export async function storeTrainingRecord(
  env: Pick<Env, "SIGILIX_TRAINING_DATA">,
  installationId: number,
  record: TrainingRecord,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const bucket = env.SIGILIX_TRAINING_DATA
  if (!bucket) return false
  const key = trainingObjectKey(installationId, record, nowMs)
  try {
    await bucket.put(key, JSON.stringify({ installationId, ...record, storedAt: new Date(nowMs).toISOString() }), {
      customMetadata: { installationId: String(installationId), kind: record.kind },
    })
    console.log(JSON.stringify({ event: "training-store-write", installationId, kind: record.kind, key }))
    return true
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "training-store-write-failed",
        installationId,
        kind: record.kind,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    return false
  }
}

/**
 * RIGHT-TO-FORGET: delete ALL of an installation's training data. Lists + deletes
 * every object under `installation/<id>/` (paginated by R2 cursor), so it removes
 * ONLY the target org's partition and never touches another org's. Returns the
 * count deleted. Called on consent revocation (granted → denied) and on an
 * explicit deletion request. No-ops (returns 0) when the binding is absent.
 * Never throws.
 */
export async function purgeTrainingData(
  env: Pick<Env, "SIGILIX_TRAINING_DATA">,
  installationId: number,
): Promise<number> {
  const bucket = env.SIGILIX_TRAINING_DATA
  if (!bucket) return 0
  if (!Number.isInteger(installationId) || installationId <= 0) return 0
  const prefix = installationPrefix(installationId)
  let deleted = 0
  let cursor: string | undefined
  try {
    // Bounded loop: R2 list is capped per page; we page via the cursor until
    // the listing reports it is no longer truncated.
    for (let page = 0; page < 10_000; page++) {
      const listing = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) })
      const keys = listing.objects.map((o) => o.key)
      if (keys.length > 0) {
        await bucket.delete(keys)
        deleted += keys.length
      }
      if (!listing.truncated) break
      cursor = listing.cursor
    }
    console.log(JSON.stringify({ event: "training-store-purge", installationId, deleted }))
    return deleted
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "training-store-purge-failed",
        installationId,
        deleted,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    return deleted
  }
}
