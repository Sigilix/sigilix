// SIG-147: per-repo PrecisionProfile KV store. Best-effort, never throws — a
// profile read/write failure must never block a review or a dismissal.
//
// Storage: one KV value per repo at `precision-profile:repo:<repoId>`, refreshed
// with a rolling 90-day TTL so active repos persist and dormant ones expire.
// KV has no CAS, so concurrent `recordOutcome` writes can lose an update (same
// caveat as review-memory's `appendSignal`); the EMA + MIN_OBSERVATIONS gate
// absorbs the occasional lost fold.

import type { Env } from "../../index"
import { emptyProfile, foldOutcomeIntoProfile } from "./ema"
import {
  PRECISION_PROFILE_SCHEMA_VERSION,
  type OutcomeEvent,
  type PrecisionProfile,
} from "./types"

const TTL_SECONDS = 90 * 24 * 60 * 60 // 90 days

function profileKey(repoId: string): string {
  return `precision-profile:repo:${repoId}`
}

/** Defensive structural check on a parsed KV value. */
function isValidProfile(v: unknown): v is PrecisionProfile {
  if (typeof v !== "object" || v === null) return false
  const p = v as Partial<PrecisionProfile>
  return (
    p.schemaVersion === PRECISION_PROFILE_SCHEMA_VERSION &&
    typeof p.repoId === "string" &&
    // `typeof [] === "object"` — reject arrays explicitly so an array-shaped
    // payload can't pass as a `patterns`/`categories` map.
    typeof p.patterns === "object" &&
    p.patterns !== null &&
    !Array.isArray(p.patterns) &&
    typeof p.categories === "object" &&
    p.categories !== null &&
    !Array.isArray(p.categories)
  )
}

/**
 * Load a repo's PrecisionProfile, or `null` on miss / parse failure / KV error.
 * `null` is the safe default — the apply gate treats it as "no signal yet".
 */
export async function loadPrecisionProfile(
  env: Env,
  repoId: string,
): Promise<PrecisionProfile | null> {
  try {
    const raw = await env.OPENCLAW_STATE.get(profileKey(repoId))
    if (raw === null) return null
    const parsed = JSON.parse(raw) as unknown
    return isValidProfile(parsed) ? parsed : null
  } catch (err) {
    console.error(JSON.stringify({
      event: "precision-profile-load-failed",
      repo_id: repoId,
      error: err instanceof Error ? err.message : String(err),
    }))
    return null
  }
}

/**
 * Record one finding outcome into the repo's profile (EMA read-modify-write).
 * Best-effort: returns `false` and logs on any failure, never throws. `nowMs`
 * is injectable for deterministic tests.
 */
export async function recordOutcome(
  env: Env,
  event: OutcomeEvent,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const nowIso = new Date(nowMs).toISOString()
  try {
    // Read raw HERE rather than via loadPrecisionProfile: that swallows a KV
    // GET failure to `null`, which we'd then treat as "no profile yet" and
    // OVERWRITE the real (still-present) profile with an empty one. Reading
    // directly lets a transient GET error throw into our catch, so we skip the
    // write and leave the existing profile intact. A genuine miss (null) or a
    // corrupt/invalid stored value still starts fresh (acceptable recovery).
    const raw = await env.OPENCLAW_STATE.get(profileKey(event.repoId))
    let existing: PrecisionProfile | null = null
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as unknown
        existing = isValidProfile(parsed) ? parsed : null
      } catch {
        existing = null // corrupt JSON → start fresh
      }
    }
    const base = existing ?? emptyProfile(event.repoId, nowIso)
    const updated = foldOutcomeIntoProfile(base, event, nowIso)
    await env.OPENCLAW_STATE.put(profileKey(event.repoId), JSON.stringify(updated), {
      expirationTtl: TTL_SECONDS,
    })
    console.log(JSON.stringify({
      event: "precision-profile-outcome-recorded",
      repo_id: event.repoId,
      category: event.category,
      outcome: event.outcome,
      pattern_count: Object.keys(updated.patterns).length,
    }))
    return true
  } catch (err) {
    console.error(JSON.stringify({
      event: "precision-profile-record-failed",
      repo_id: event.repoId,
      outcome: event.outcome,
      error: err instanceof Error ? err.message : String(err),
    }))
    return false
  }
}
