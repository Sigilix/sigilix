// SIG-318 (PR 8) / SIG-360 — the PR-review post-synthesis VALIDATION domain.
//
// The believability core: the hallucination guard, the per-lens evidence gates,
// scope/anchor normalization, and `validateForSubmission`. Recall-safety is the
// load-bearing invariant — a real P0/P1 never disappears SILENTLY: it is conserved
// inline or demoted to the body, OR hard-dropped by one of the 5 positively-judging
// gates (logic-evidence / logic-refutation / logic-claim-refutation / perf-evidence /
// testing-citation) WITH a recorded drop counter; every gate fails CLOSED to KEEP
// when uncertain. Behavior is pinned by
// tests/validation-golden-matrix + tests/validation-never-drop; do not regenerate
// those fixtures. The `validate-*` / trust-ledger gate family now lives in-domain
// under `./gates/` (SIG-385); the only residual laterals are the pure lib helpers
// (secret-scan reached via the gates; the type-only evidence/config leaves), which
// are shared with the orchestrator and stay at the edge.
//
// SIG-386 (PR2): `validateForSubmission` is now a readable skeleton orchestrating
// named PHASE functions in `./validation-phases.ts` (init → per-finding walk →
// advisory aggregation → out-of-PR-scope tagging → return assembly). PR2 is a PURE
// extract-method refactor under the golden harness — behavior (findings, every
// counter, unanchoredFindings, provenance, and the ORDERED telemetry sequence) is
// byte-identical. The vague-prefix + testing-citation public helpers + the
// `ValidateForSubmissionArgs` type moved to the phases sibling and are re-exported
// from here so this module's export surface is unchanged.

import type {
  PrReviewVerdict,
  PrReviewFinding,
  EvidenceRecord,
} from "@/shared/domain/pr-review-finding"
import type { SpecialistRole } from "@/shared/domain/specialist-role"
import type { PrReviewVerdictWithIds } from "./findings"
import {
  initializeValidationState,
  aggregateAdvisoryNits,
  tagOutOfPrScopeFindings,
} from "./validation-phases"
import { processFindings } from "./validation-walk"
// PR2: re-exported (below) to preserve this module's public surface — the
// barrel (`triage-pr-review-ensemble.ts`) + the orchestrator import them from
// here. Moved byte-identical to the args sibling; no behavior change.
import {
  VAGUE_PREFIXES,
  hasVaguePrefix,
  evaluateTestingFindingCitation,
  type ValidateForSubmissionArgs,
} from "./validation-args"

// PR2: re-export the moved public symbols so importers of `./validation` (the
// barrel + the orchestrator) keep resolving exactly as before.
export {
  VAGUE_PREFIXES,
  hasVaguePrefix,
  evaluateTestingFindingCitation,
}
export type { ValidateForSubmissionArgs }

export interface SynthesizerProvenance {
  findings: Array<{
    sourceSpecialists: SpecialistRole[]
    sourceFindingIds: string[]
    action: "kept" | "merged" | "rewritten"
    verifiedViaRetrieval: boolean
  }>
  dropped: Array<{
    specialist: SpecialistRole
    sourceFindingId: string
    headline: string
    reason: string
  }>
  /**
   * ARC-189: findings the synth softened in response to a [REVIEW
   * MEMORY] block (matched on category, optionally on pathSha12 for
   * path-scoped memories). Optional + sparse: synths emitting
   * pre-v2 outputs (no review memory) omit this field, which
   * `isValidProvenance` accepts. The renderer applies a one-tier
   * `score` decrement on the matched finding before posting.
   */
  softened?: Array<{
    specialist: SpecialistRole
    sourceFindingId: string
    headline: string
    reason: string
  }>
}

export interface CollectedVerdict {
  role: SpecialistRole
  verdict: PrReviewVerdictWithIds | null
  failureReason?: string
  failureRawAnswer?: string
  elapsedMs: number
  /** ARC-284: per-specialist accounting threaded through for the
   *  `specialist-fanout-summary` telemetry event. Undefined when the
   *  Promise.allSettled wrapper rejected before runSpecialist could
   *  emit (e.g. orchestrator-signal abort BEFORE the first attempt). */
  attemptsUsed?: number
  modelUsed?: string
}

// ─── post-synthesis validation ────────────────────────────────────────

export interface ValidatedOutput {
  verdict: PrReviewVerdict
  /**
   * Findings that passed the hallucination guard and the score-1 demotion
   * check but failed `deriveSide()` (line not in the PR diff). Empty in
   * the success path; the submit-review fallback uses this list to
   * recover findings whose value survives without an inline anchor.
   */
  unanchoredFindings: PrReviewFinding[]
  droppedForInvalidLine: number
  /**
   * Count of line-scoped findings whose model-chosen line was not
   * reviewable but was repaired to a nearby substantive added line.
   * These stay inline instead of falling into the body-only section.
   */
  remappedInvalidLineToInline: number
  droppedForHallucination: number
  demotedScore1: number
  /**
   * ARC-156: count of findings dropped because their headline or
   * body started with a vague prefix word (Ensure / Verify /
   * Validate / Consider / Review / Confirm). Surfaced to shadow
   * telemetry so the filter's real-world impact is measurable.
   */
  droppedForVaguePrefix: number
  /**
   * SIG-113: count of `category: "testing"` findings dropped because
   * the specialist failed to cite evidence via `inspectedTestFiles`
   * or `evidenceRefs`. Eliminates the PR #110 / PR #111 hallucination
   * class where the specialist asserted "missing tests" without
   * inspecting any test file. Surfaced to telemetry so the gate's
   * hit rate is observable in the SIG-86 aggregator.
   */
  droppedForUncitedTestingEvidence: number
  /**
   * SIG-108: count of security-applicable findings the security
   * evidence gate flagged for drop (sev>=4 security finding with
   * fabricated / non-linking / absent evidence that auto-enrich
   * couldn't rescue). In `shadow` mode this counts what WOULD be
   * dropped without actually dropping (the finding stays in
   * `verdict.findings`); in `enforce` mode the finding is dropped.
   * Surfaced to telemetry so the gate's would-drop rate is observable
   * before enforcement is enabled.
   */
  droppedForFailedValidation: number
  /**
   * SIG-111: count of sev>=4 `category: "testing"` findings the
   * specificity gate flagged for drop (uncited missing-coverage claim
   * or vague insufficient-test claim that named no concrete
   * source/API/branch). In `shadow` mode this counts what WOULD be
   * dropped without dropping; in `enforce` mode the finding is dropped.
   * Surfaced to telemetry so the gate's would-drop rate is observable
   * before enforcement is enabled.
   */
  droppedForFailedTestValidation: number
  /**
   * SIG-109: count of sev>=4 logic-sourced findings the evidence gate
   * flagged for drop (unanchored claim — not on a changed path, or
   * quoting no concrete code token on an added line and unbacked by any
   * co-located AST hit; or missing path). In `shadow` mode this counts
   * what WOULD be dropped without dropping; in `enforce` mode the finding
   * is dropped. Surfaced to telemetry so the gate's would-drop rate is
   * observable before enforcement is enabled.
   */
  droppedForFailedLogicValidation: number
  /**
   * SIG-308: count of sev>=4 logic findings the refutation backstop flagged
   * for missing a survival rationale (would-drop in shadow, actual-drop in
   * enforce). Surfaced so the would-flag rate is observable before enforce.
   */
  droppedForFailedLogicRefutation: number
  /** SIG-328: logic findings whose AST-provably-false claim the gate flagged. */
  droppedForFailedLogicClaimRefutation: number
  /**
   * SIG-325: count of sev>=4 self-originated findings (currently security with
   * no resolving manifest evidenceId) the refutation-survival gate flagged for
   * a missing mechanism rationale (would-demote shadow / actual-demote enforce).
   */
  droppedForFailedRefutationSurvival: number
  /**
   * SIG-110: count of sev>=4 perf findings the evidence gate flagged
   * (unanchored perf claim, perf finding on an unchanged path, or missing
   * path). Shadow counts the would-drop; enforce drops. Surfaced to
   * telemetry so the gate's would-drop rate is observable before enforce.
   */
  droppedForFailedPerfValidation: number
  /**
   * SIG-281 PR C: count of score 2-3 findings the inline-grounding gate
   * flagged as ungrounded (would-demote-to-body in shadow, actual-demote
   * in enforce). Surfaced to telemetry so the gate's would-demote rate is
   * observable before enforce.
   */
  droppedForFailedInlineGroundingValidation: number
  /**
   * SIG-290 v1: count of absence-claim findings the absence-grounding
   * gate flagged as ungrounded — the evidence that would confirm-or-
   * refute the absence was PROVABLY not in the specialist's window
   * (would-demote-to-body in shadow, actual-demote in enforce). 0 when
   * the gate is `off`. Surfaced to telemetry so the gate's would-demote
   * rate is observable before enforce.
   */
  droppedForFailedAbsenceGroundingValidation: number
  /**
   * Cross-cutting over-fire Option B: count of window-blindness gate hits
   * (would-demote-to-body in shadow, actual-demote in enforce). 0 when the gate
   * is `off`. Surfaced to telemetry so the would-demote rate is observable
   * before enforce.
   */
  droppedForFailedWindowBlindnessValidation: number
  /**
   * SIG-293 v1: count of secrets-exposure findings the security-grounding
   * gate flagged as ungrounded — the cited line held no credential token
   * and no scanner fact corroborated it (would-demote-to-body in shadow,
   * actual-demote in enforce). 0 when the gate is `off`. Surfaced to
   * telemetry so the gate's would-demote rate is observable before enforce.
   */
  droppedForFailedSecurityGroundingValidation: number
  droppedForFailedSecurityUsageValidation: number
  /**
   * ARC-189: per-clean-finding provenance, aligned by INDEX with
   * `verdict.findings`. Captured during the same walk that filters
   * findings so the ensemble caller can derive the source specialist
   * for each surviving finding without re-walking with the same
   * filter rules. Used by Task 2.5 marker emission to map each
   * finding to its `ReviewMemoryCategory`.
   */
  cleanFindingProvenance: SynthesizerProvenance["findings"]
  /**
   * Synth provenance plus validation-layer drops that are not safe to
   * send inline, such as score-1 advisories under the default profile.
   */
  provenance: SynthesizerProvenance
}

export function evidencePieceCountForTelemetry(record: EvidenceRecord | undefined): number {
  if (!record) return 0
  return (
    record.specialistsThatFlagged.length +
    record.deterministicFactIds.length +
    record.retrievalChunkIds.length +
    record.relatedPriorPRs.length
  )
}

/**
 * SIG-386 (PR2): the readable skeleton — orchestrates the named phases in
 * `./validation-phases.ts`. Phase 1 `initializeValidationState` resolves the
 * args + builds the id/evidence/rationale + gate-context maps + allocates the
 * accumulators; Phase 2 `processFindings` runs the per-finding walk (hard-drop
 * gates → score-1/demote gates → routing), threading the single mutable `state`;
 * Phase 3 `aggregateAdvisoryNits` folds the advisory nits into the summary;
 * Phase 4 `tagOutOfPrScopeFindings` tags off-PR-scope findings in place; Phase 5
 * assembles the return object from `state`. Behavior — including the ORDERED
 * telemetry-callback sequence the golden harness pins — is byte-identical to the
 * pre-decomposition function.
 */
export function validateForSubmission(args: ValidateForSubmissionArgs): ValidatedOutput {
  const { resolved, state, context } = initializeValidationState(args)

  processFindings(resolved, context, state)

  const summary = aggregateAdvisoryNits(
    resolved.synthOutput.verdict.summary,
    state.advisoryNits,
    resolved.profile,
  )

  tagOutOfPrScopeFindings(state.cleanFindings, state.unanchoredFindings, resolved.reviewable)

  return {
    verdict: { ...resolved.synthOutput.verdict, summary, findings: state.cleanFindings },
    unanchoredFindings: state.unanchoredFindings,
    droppedForInvalidLine: state.droppedForInvalidLine,
    remappedInvalidLineToInline: state.remappedInvalidLineToInline,
    droppedForHallucination: state.droppedForHallucination,
    demotedScore1: state.demotedScore1,
    droppedForVaguePrefix: state.droppedForVaguePrefix,
    droppedForUncitedTestingEvidence: state.droppedForUncitedTestingEvidence,
    droppedForFailedValidation: state.droppedForFailedValidation,
    droppedForFailedTestValidation: state.droppedForFailedTestValidation,
    droppedForFailedLogicValidation: state.droppedForFailedLogicValidation,
    droppedForFailedLogicRefutation: state.droppedForFailedLogicRefutation,
    droppedForFailedLogicClaimRefutation: state.droppedForFailedLogicClaimRefutation,
    droppedForFailedRefutationSurvival: state.droppedForFailedRefutationSurvival,
    droppedForFailedPerfValidation: state.droppedForFailedPerfValidation,
    droppedForFailedInlineGroundingValidation: state.droppedForFailedInlineGroundingValidation,
    droppedForFailedAbsenceGroundingValidation: state.droppedForFailedAbsenceGroundingValidation,
    droppedForFailedWindowBlindnessValidation: state.droppedForFailedWindowBlindnessValidation,
    droppedForFailedSecurityGroundingValidation: state.droppedForFailedSecurityGroundingValidation,
    droppedForFailedSecurityUsageValidation: state.droppedForFailedSecurityUsageValidation,
    cleanFindingProvenance: state.cleanFindingProvenance,
    provenance: {
      ...resolved.synthOutput.provenance,
      dropped: state.provenanceDropped,
    },
  }
}
