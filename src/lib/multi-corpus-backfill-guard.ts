// Once-ever guard for the `pr:` corpus backfill.
//
// WHY THIS EXISTS — this is a live cost bug, not a hypothetical. Today
// `handleCorpusPrBackfill` embeds up to 300 PRs with NO guard, and the job is
// enqueued from an ungated producer on BOTH `installation.created` AND
// `installation_repositories.added`. So:
//   • add repos to an existing installation      → each ADDED repo backfills again
//     (the producer iterates `repositories_added`, so it is the delta, not every repo)
//   • webhook redelivery after our 503           → re-backfills
//   • queue retry (max_retries=3) mid-run        → re-backfills from the top
// Each re-run is a full Workers AI re-embed. Re-embedding is NOT free: the embed
// happens before the content-addressed id is computed, so identical content pays
// full price and merely overwrites the same vector. This is the exact shape of the
// graph-index incident that cost ~$85 in six days (see wrangler.toml's
// SIGILIX_GRAPH_INDEX note).
//
// DESIGN — deliberately consumer-side, not producer-side. The job is enqueued from
// several places, so gating any one of them leaves the others open. The only place
// that reliably sees every attempt is the handler.
//
// The claim is written BEFORE the work so a retry storm can't restart a full embed.
// ⚠️ That is ONLY safe because the caller RELEASES the claim when the work throws
// (releaseCorpusPrBackfillClaim). Without the release the guard is far worse than the
// bug it fixes: a transient GitHub failure writes a claim, the queue retries within
// seconds, every retry sees `in-flight` and acks cleanly, all 3 retries burn inside
// the stale window — and since the backfill only fires on install, NOTHING ever runs
// again. Result: zero PRs backfilled, permanently, with only an info log. The stale
// window can never rescue it because no event re-fires after 30 minutes.
//
// Releasing on failure caps the cost exposure at max_retries (3) full re-runs, and
// only on genuine errors. The incident this guards against was an UNBOUNDED cron
// re-fire, not a bounded retry — so 3 is an acceptable ceiling and permanent silent
// data loss is not.

import type { Env } from "@/src/shared/types/env"
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "@/src/shared/adapters/model"

/** An in-flight claim older than this is assumed dead and may be re-claimed. */
const STALE_CLAIM_MS = 30 * 60 * 1000

export interface CorpusBackfillRecord {
  startedAtMs: number
  completedAtMs?: number
  found?: number
  upserted?: number
  /** Recorded so a deliberate embedding-model migration can invalidate the guard. */
  modelId: string
  embeddingDim: number
}

/** No TTL — this is a once-ever marker. A TTL expiring is exactly how a "run once"
 *  job runs twice. Keyed on owner/repo (the job carries no immutable repo id). */
function guardKey(owner: string, repo: string): string {
  return `corpus-pr-backfill:${owner.toLowerCase()}/${repo.toLowerCase()}`
}

export type ClaimResult =
  | { ok: true }
  | { ok: false; reason: "already-completed" | "in-flight"; record: CorpusBackfillRecord }

/**
 * Try to claim the backfill for a repo. Returns `{ok:true}` only when this caller
 * should do the work.
 *
 * THROWS on a KV read error rather than failing open or silently skipping. Failing
 * open looks safe but is an UNBOUNDED cost path: during a persistent KV fault every
 * delivery would run a full backfill with nothing to stop it. Silently skipping is
 * worse still — the corpus goes dark with no signal. Throwing hands the decision to
 * the queue, which retries with backoff and eventually surfaces the failure. A
 * coordination outage should delay loudly, not authorize unlimited expensive work.
 */
export async function claimCorpusPrBackfill(
  env: Pick<Env, "OPENCLAW_STATE">,
  args: { owner: string; repo: string; nowMs: number; force?: boolean },
): Promise<ClaimResult> {
  const key = guardKey(args.owner, args.repo)
  let existing: CorpusBackfillRecord | null = null
  let raw: string | null
  try {
    raw = await env.OPENCLAW_STATE.get(key)
  } catch (error) {
    // Can't read the guard → can't safely spend. Let the queue retry. See docstring.
    throw new Error(`corpus-pr-backfill guard unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    existing = raw ? (JSON.parse(raw) as CorpusBackfillRecord) : null
  } catch {
    existing = null // corrupt record — treat as absent and re-claim over it
  }

  if (existing && !args.force) {
    // A deliberate model migration invalidates the guard: vectors from a different
    // model/dimension are not interchangeable, so that IS a legitimate re-run.
    const sameModel = existing.modelId === EMBEDDING_MODEL && existing.embeddingDim === EMBEDDING_DIMENSIONS
    if (sameModel) {
      if (existing.completedAtMs !== undefined) {
        return { ok: false, reason: "already-completed", record: existing }
      }
      if (args.nowMs - existing.startedAtMs < STALE_CLAIM_MS) {
        return { ok: false, reason: "in-flight", record: existing }
      }
      // Stale + incomplete → a previous attempt died. Fall through and re-claim.
    }
  }

  const claim: CorpusBackfillRecord = {
    startedAtMs: args.nowMs,
    modelId: EMBEDDING_MODEL,
    embeddingDim: EMBEDDING_DIMENSIONS,
  }
  try {
    await env.OPENCLAW_STATE.put(key, JSON.stringify(claim))
  } catch {
    // Couldn't record the claim. Proceed anyway (fail open) — the work is still
    // useful; we just lose the protection for this one attempt.
  }
  return { ok: true }
}

/**
 * Release a claim after the work FAILED, so the queue's retry can actually re-run.
 *
 * Deletes rather than writing a failure marker: the next retry should behave exactly
 * like a first attempt. Best-effort — if this fails the stale window is the backstop.
 */
export async function releaseCorpusPrBackfillClaim(
  env: Pick<Env, "OPENCLAW_STATE">,
  args: { owner: string; repo: string },
): Promise<void> {
  try {
    await env.OPENCLAW_STATE.delete(guardKey(args.owner, args.repo))
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "corpus-pr-backfill-release-failed",
        owner: args.owner,
        repo: args.repo,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

/** Mark the backfill complete. Best-effort: a failure here costs at most one extra
 *  run later, never correctness. */
export async function markCorpusPrBackfillComplete(
  env: Pick<Env, "OPENCLAW_STATE">,
  args: { owner: string; repo: string; nowMs: number; startedAtMs: number; found: number; upserted: number },
): Promise<void> {
  const record: CorpusBackfillRecord = {
    startedAtMs: args.startedAtMs,
    completedAtMs: args.nowMs,
    found: args.found,
    upserted: args.upserted,
    modelId: EMBEDDING_MODEL,
    embeddingDim: EMBEDDING_DIMENSIONS,
  }
  try {
    await env.OPENCLAW_STATE.put(guardKey(args.owner, args.repo), JSON.stringify(record))
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "corpus-pr-backfill-mark-complete-failed",
        owner: args.owner,
        repo: args.repo,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}
