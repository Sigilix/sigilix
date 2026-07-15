// Write-time verification-provenance classification (SIG-600 PR2).
//
// Pure domain logic: given the deterministic evidence (if any) that backed a
// memory when it was captured, decide its `LearningVerification`. Today every
// capture site is a human instructive teaching (a `@sigilix` mention reply, a
// Slack teach, a `@sigilix remember` command) with nothing runnable to check, so
// they classify as `unverified`. The function accepts evidence so a future
// capture path that carries a finding's deterministic backing (AST/CWE/SARIF/
// secret/depvuln/test/specialist) records `verified` without a new writer.
//
// SHADOW-SAFE: the output is only recorded on the entry — retrieval,
// trust-weighting, and training-label export do not read it in this slice.

import type { LearningEvidenceKind, LearningVerification } from "./types"

export interface ClassifyLearningVerificationInput {
  /** Deterministic-evidence classes that backed the memory at capture, if any. */
  evidence?: readonly LearningEvidenceKind[]
  /** Source finding/evidence ids that carried that evidence (attribution). */
  sourceFindingIds?: readonly string[]
}

/**
 * Classify a memory's verification provenance from the evidence available at
 * write time. A real evidence class present ⇒ `verified`; nothing runnable ⇒
 * `unverified` with the `none` sentinel. Called with no evidence for the human
 * teachings that are the only capture path today.
 */
export function classifyLearningVerification(input: ClassifyLearningVerificationInput = {}): LearningVerification {
  // The `none` sentinel is not a real evidence class — drop it before deciding.
  const evidence = dedupe((input.evidence ?? []).filter((kind) => kind !== "none"))

  if (evidence.length === 0) {
    // No runnable check backed it — a plain human decision.
    return { status: "unverified", evidence: ["none"] }
  }

  const verification: LearningVerification = { status: "verified", evidence }
  const sourceFindingIds = dedupe(input.sourceFindingIds ?? [])
  if (sourceFindingIds.length > 0) verification.sourceFindingIds = sourceFindingIds
  return verification
}

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}
