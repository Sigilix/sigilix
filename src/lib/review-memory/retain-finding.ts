// sig-training-retention-wiring — the review-finding capture seam (flagged off).
//
// Offers the "was Sigilix right" signal — {finding, verdict, human correction,
// context} — to the consent-gated training store, for BOTH accepted and dismissed
// verdicts (the corpus needs the right calls as much as the wrong ones). Split out
// of capture.ts so that file stays within its size budget and the record shape
// lives next to the other retention wiring.
//
// INERT by default: retainTrainingRecordForRepo returns immediately (no tenancy
// lookup, no record build, no I/O) while SIGILIX_TRAINING_RETENTION_MODE is off,
// and even flipped on writes only for a consenting org into the SEPARATE R2
// partition, redacted first — never the operational review-memory KV. Best-effort;
// never throws.

import { retainTrainingRecordForRepo } from "@/src/lib/training-retention/retain-training"
import type { Env } from "@/src/shared/types/env"
import type { ParsedReviewFeedback } from "./parse-dismissal"
import type { TrustedSigilixSource } from "./capture"

export async function retainReviewFindingSignal(args: {
  env: Env
  owner: string
  repo: string
  prNumber: number
  commentId: number
  source: string
  /** The verified, App-authored Sigilix finding (body + marker). */
  trusted: TrustedSigilixSource
  /** The parsed accept/dismiss verdict. */
  feedback: ParsedReviewFeedback
  /** The human's raw reply/correction text — the preference signal. */
  humanReplyBody: string
}): Promise<void> {
  const verdict = args.feedback.outcome === "dismissed" ? "dismissed" : "accepted"
  // dismissReason lives only on the "dismissed" variant of the discriminated union.
  const dismissReason = args.feedback.outcome === "dismissed" ? args.feedback.dismissReason : undefined
  const marker = args.trusted.marker
  await retainTrainingRecordForRepo(args.env, args.owner, args.repo, () => ({
    kind: "review-finding",
    id: `${args.owner}/${args.repo}#${args.prNumber}:${args.commentId}`,
    payload: JSON.stringify({
      finding: args.trusted.body,
      verdict,
      correction: args.humanReplyBody,
      ...(dismissReason !== undefined ? { dismissReason } : {}),
    }),
    meta: {
      owner: args.owner,
      repo: args.repo,
      prNumber: String(args.prNumber),
      source: args.source,
      ...(marker?.cat !== undefined ? { category: marker.cat } : {}),
      ...(marker?.sev !== undefined ? { severity: marker.sev } : {}),
      ...(marker?.fid !== undefined ? { fid: marker.fid } : {}),
    },
  }))
}
