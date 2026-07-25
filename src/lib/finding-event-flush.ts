// SIG-606 — the dispatcher's one-shot finding-event flush.
//
// Extracted from index-dispatch.ts to keep that file inside the size budget, and
// because the reconcile-then-append sequence is the part with real semantics worth
// reading in one place.
//
// Non-fatal by construction: instrumentation must never affect the review it
// measures. The caller still wraps this, and `appendFindingEvents` is itself
// fail-soft, so a D1 outage costs labels — never a review.

import {
  appendFindingEvents,
  reconcileFindingOutcomes,
  type FindingEventReviewIdentity,
} from "@/src/features/finding-events"
import {
  materializeFindingEvents,
  buildPostedFindingRecords,
  type FindingEventCapture,
  type PostedFindingCapture,
} from "@/src/lib/ensemble/app/finding-event-capture"
import type { Env } from "@/src/shared/types/env"

/**
 * Materialize the captured candidates, resolve each outcome against what
 * publication actually did, and append the rows.
 *
 * ⚠️ The null-vs-empty distinction on the posted set is load-bearing:
 *   • `postedFindingSink` non-empty → the real posted set; absent candidates were
 *     genuinely suppressed.
 *   • `postedFindingSink` EMPTY → we never observed publication (errored/aborted
 *     review, or a path that never submitted), so we pass `null` and every row
 *     records `unknown`. Passing an empty Map instead would label every candidate
 *     `suppressed` — inventing false negatives for a review that may have posted
 *     everything. That is the exact corruption this log exists to avoid.
 *
 * A review that legitimately posts nothing still yields `unknown` rows here rather
 * than `suppressed`; that is the deliberately conservative side of the trade.
 */
export async function flushFindingEventLog(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  job: { installationId: number; repoId?: number | undefined; prNumber: number; headSha: string },
  captures: readonly FindingEventCapture[],
  posted: readonly PostedFindingCapture[],
): Promise<void> {
  if (captures.length === 0) return
  try {
    const identity: FindingEventReviewIdentity = {
      installationId: job.installationId,
      repoId: job.repoId ?? 0,
      prNumber: job.prNumber,
      headSha: job.headSha,
    }
    const drafts = await materializeFindingEvents(captures)
    const postedRecords = posted.length > 0 ? buildPostedFindingRecords(posted) : null
    await appendFindingEvents(env, identity, reconcileFindingOutcomes(drafts, postedRecords), new Date().toISOString())
  } catch (err) {
    // Swallowed here (not at the call site) so the dispatcher stays at its size
    // budget and the non-fatal guarantee lives with the code it protects.
    console.log(
      JSON.stringify({
        event: "finding-event-log-flush-error",
        prNumber: job.prNumber,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}
