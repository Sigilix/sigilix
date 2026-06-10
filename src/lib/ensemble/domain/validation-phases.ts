// SIG-318 (PR 8) / SIG-386 (PR2) — the ORCHESTRATION phases of
// `validateForSubmission`: Phase 1 init (resolve args → id/evidence/rationale
// maps → accumulators → gate-context maps), Phase 3 advisory-nit aggregation,
// Phase 4 out-of-PR-scope tagging. The Phase 2 per-finding walk lives in
// `./validation-walk.ts` (size); the args + phase-state types in
// `./validation-args.ts`. PR2 is a PURE extract-method refactor under the golden
// harness — behavior is byte-identical to the pre-decomposition function.
//
// Leaf discipline (SIG-318): never VALUE-import the core (`./validation`).

import type { PrReviewFinding } from "@/shared/domain/pr-review-finding"
import { type LineSpan } from "@/features/ast-rules"
import type { ReviewableMap } from "@/shared/util/diff-positions"
import {
  buildSourceFindingSecurityEvidenceById,
  buildSourceFindingRationaleById,
} from "./validation-internals"
import type { SigilixProfile } from "../../sigilix-config"
import {
  MAX_ADVISORY_NITS,
  type ValidateForSubmissionArgs,
  type ValidationState,
  type ValidationContext,
  type ResolvedValidationArgs,
} from "./validation-args"

/**
 * SIG-386 (PR2) — Phase 1 init. Resolves the args defaults, builds the valid-id
 * set + the per-lens evidence/rationale maps, allocates the accumulators, and
 * precomputes the absence-/window- gate context maps (lazily, exactly as the
 * original: in `off` mode the key iteration is skipped). No telemetry fires
 * here. Byte-identical to the original lines 906–1016.
 */
export function initializeValidationState(args: ValidateForSubmissionArgs): {
  resolved: ResolvedValidationArgs
  state: ValidationState
  context: ValidationContext
} {
  const {
    synthOutput,
    reviewable,
    specialistVerdicts,
    testingEvidence,
    onTestingFindingDropped,
    securityManifest,
    durableObjectClassSpans: doClassSpans = new Map<string, readonly LineSpan[]>(),
    securityValidatorMode = "shadow",
    onSecurityFindingDropped,
    testsValidatorMode = "shadow",
    onTestFindingDropped,
    coverageGaps = new Set<string>(),
    testToSourceRatio = 0,
    logicEvidence,
    logicValidatorMode = "shadow",
    onLogicFindingDropped,
    logicRefutationMode = "off",
    refutationSurvivalMode = "off",
    onLogicRefutationFindingDropped,
    onRefutationSurvivalFindingDropped,
    logicClaimRefutationMode = "off",
    onLogicClaimRefutationFindingDropped,
    perfEvidence,
    perfValidatorMode = "shadow",
    addedLineTextByLine,
    onPerfFindingDropped,
    inlineGroundingValidatorMode = "shadow",
    onInlineGroundingFindingDropped,
    absenceClaimValidatorMode = "off",
    wasTruncated = false,
    droppedPaths = [],
    onAbsenceFindingDropped,
    windowBlindnessValidatorMode = "off",
    fullFileByPath = new Map<string, string>(),
    astCache,
    onWindowBlindnessFindingDropped,
    securityGroundingValidatorMode = "off",
    onSecurityGroundingFindingDropped,
    securityUsageValidatorMode = "off",
    onSecurityUsageFindingDropped,
    profile = "chill",
    trustLedgerEnabled = false,
    astFindingIds = [],
  } = args
  const validIds = new Set<string>()
  const sourceEvidenceById = buildSourceFindingSecurityEvidenceById(specialistVerdicts)
  const sourceRationaleById = buildSourceFindingRationaleById(specialistVerdicts, "logic")
  // SIG-325 (CodeRabbit PR #364): per-lens rationale maps so the security/perf
  // refutation gates judge against a SAME-LENS rationale instead of the
  // logic-scoped global backfill (no cross-lens contamination / false demotes).
  const sourceRationaleByIdSecurity = buildSourceFindingRationaleById(specialistVerdicts, "security")
  const sourceRationaleByIdPerf = buildSourceFindingRationaleById(specialistVerdicts, "performance")
  for (const v of specialistVerdicts) {
    if (!v.verdict) continue
    for (const f of v.verdict.findings) validIds.add(f.id)
  }
  // SIG-314: a deterministic AST emit (emitWhenUnmatched) is a LEGITIMATE source
  // the synth may cite as `ast/<ruleId>/<hash>/<line>` provenance — that is the
  // whole point of the unmatched path (the specialist missed it, the scanner
  // proved it). Without this, the hallucination guard below drops every
  // unmatched emit (SIG-309/310/312/314 all relied on this and were silently
  // dropped in the specialist-missed case — Codex caught it). Only REAL scanned
  // ids are admitted, so a hallucinated `ast/…` still fails the guard.
  for (const id of astFindingIds) validIds.add(id)

  const cleanFindings: PrReviewFinding[] = []
  const cleanFindingProvenance: ValidationState["cleanFindingProvenance"] = []
  const provenanceDropped: ValidationState["provenanceDropped"] = [
    ...synthOutput.provenance.dropped,
  ]
  const unanchoredFindings: PrReviewFinding[] = []
  const advisoryNits: PrReviewFinding[] = []

  // SIG-290 v1: the reviewable diff's path set for the absence-grounding
  // gate's context. Built once, but only when the gate runs — in `off`
  // mode we skip the key iteration entirely (zero cost).
  const reviewablePaths: ReadonlySet<string> =
    absenceClaimValidatorMode === "off" ? new Set<string>() : new Set(reviewable.keys())

  // Cross-cutting over-fire Option B: the NEW-side (RIGHT) line numbers the
  // specialist actually saw per path — its diff window (changed + context
  // lines). A guard at a full-file line NOT in this set was outside the model's
  // window. Built once, but only when the gate runs (`off` skips entirely).
  const windowLinesByPath: ReadonlyMap<string, ReadonlySet<number>> =
    windowBlindnessValidatorMode === "off"
      ? new Map<string, ReadonlySet<number>>()
      : new Map(
          [...reviewable.entries()].map(([path, positions]) => [
            path,
            new Set(positions.filter((p) => p.side === "RIGHT").map((p) => p.line)),
          ]),
        )

  const resolved: ResolvedValidationArgs = {
    synthOutput,
    reviewable,
    specialistVerdicts,
    testingEvidence,
    onTestingFindingDropped,
    securityManifest,
    doClassSpans,
    securityValidatorMode,
    onSecurityFindingDropped,
    testsValidatorMode,
    onTestFindingDropped,
    coverageGaps,
    testToSourceRatio,
    logicEvidence,
    logicValidatorMode,
    onLogicFindingDropped,
    logicRefutationMode,
    refutationSurvivalMode,
    onLogicRefutationFindingDropped,
    onRefutationSurvivalFindingDropped,
    logicClaimRefutationMode,
    onLogicClaimRefutationFindingDropped,
    perfEvidence,
    perfValidatorMode,
    addedLineTextByLine,
    onPerfFindingDropped,
    inlineGroundingValidatorMode,
    onInlineGroundingFindingDropped,
    absenceClaimValidatorMode,
    wasTruncated,
    droppedPaths,
    onAbsenceFindingDropped,
    windowBlindnessValidatorMode,
    fullFileByPath,
    astCache,
    onWindowBlindnessFindingDropped,
    securityGroundingValidatorMode,
    onSecurityGroundingFindingDropped,
    securityUsageValidatorMode,
    onSecurityUsageFindingDropped,
    profile,
    trustLedgerEnabled,
    astFindingIds,
  }
  const state: ValidationState = {
    cleanFindings,
    cleanFindingProvenance,
    provenanceDropped,
    unanchoredFindings,
    advisoryNits,
    droppedForInvalidLine: 0,
    remappedInvalidLineToInline: 0,
    droppedForHallucination: 0,
    demotedScore1: 0,
    droppedForVaguePrefix: 0,
    droppedForUncitedTestingEvidence: 0,
    droppedForFailedValidation: 0,
    droppedForFailedTestValidation: 0,
    droppedForFailedLogicValidation: 0,
    droppedForFailedLogicRefutation: 0,
    droppedForFailedLogicClaimRefutation: 0,
    droppedForFailedRefutationSurvival: 0,
    droppedForFailedPerfValidation: 0,
    droppedForFailedInlineGroundingValidation: 0,
    droppedForFailedAbsenceGroundingValidation: 0,
    droppedForFailedWindowBlindnessValidation: 0,
    droppedForFailedSecurityGroundingValidation: 0,
    droppedForFailedSecurityUsageValidation: 0,
  }
  const context: ValidationContext = {
    validIds,
    sourceEvidenceById,
    sourceRationaleById,
    sourceRationaleByIdSecurity,
    sourceRationaleByIdPerf,
    reviewablePaths,
    windowLinesByPath,
  }
  return { resolved, state, context }
}

/**
 * SIG-386 (PR2) — Phase 3: aggregate the score-1 advisory nits into the summary,
 * but only under the `assertive` review-tone preset (chill/default keeps them
 * out of customer-visible output entirely while preserving audit provenance).
 * Returns the (possibly augmented) summary. Byte-identical to the original lines
 * 1706–1717.
 */
export function aggregateAdvisoryNits(
  baseSummary: string,
  advisoryNits: PrReviewFinding[],
  profile: SigilixProfile,
): string {
  let summary = baseSummary
  if (profile === "assertive" && advisoryNits.length > 0) {
    advisoryNits.sort((a, b) => b.score - a.score || a.headline.localeCompare(b.headline))
    const top = advisoryNits.slice(0, MAX_ADVISORY_NITS)
    const rest = advisoryNits.length - top.length
    const headlines = top.map((n) => n.headline).join("; ")
    const tail = rest > 0 ? `; plus ${rest} more advisory nits` : ""
    summary = `${summary}\n\n**Advisory nits:** ${headlines}${tail}`
  }
  return summary
}

/**
 * SIG-386 (PR2) — Phase 4: tag every finding whose `path` is NOT a changed file
 * as out-of-PR-scope (founder ask, Codex #333) — it's about code the model
 * raised from graph/retrieval context, not this PR's changes. Mutates the
 * findings in place (sets `outOfPrScope = true`). Byte-identical to the original
 * lines 1719–1735.
 */
export function tagOutOfPrScopeFindings(
  cleanFindings: PrReviewFinding[],
  unanchoredFindings: PrReviewFinding[],
  reviewable: ReviewableMap,
): void {
  // Inlines-only / outside-diff (founder ask, Codex #333): tag every finding
  // whose `path` is NOT a changed file as out-of-PR-scope — it's about code the
  // model raised from graph/retrieval context, not this PR's changes. Computed
  // from the reviewable changed-file set, INDEPENDENT of the trust-ledger flag.
  // An inline finding always anchored to a changed line, so its path is in the
  // set → never tagged. A body finding on a CHANGED file that merely failed to
  // anchor stays in-scope and still blocks — only a truly different file is
  // out-of-scope, which closes the recall hole of treating anchor-failure as
  // out-of-PR.
  // Normalize both sides with `.trim()` — the path-handling convention across
  // this module (triage-pr-review.ts:702/865, ensemble.ts:9218) — so a model
  // path with stray whitespace can't mismatch a changed-file key and wrongly
  // mark a real blocker out-of-scope (CodeRabbit #334 — recall-relevant).
  const normPath = (p: string): string => p.trim()
  const changedFilePaths = new Set([...reviewable.keys()].map(normPath))
  for (const f of cleanFindings) if (!changedFilePaths.has(normPath(f.path))) f.outOfPrScope = true
  for (const f of unanchoredFindings) if (!changedFilePaths.has(normPath(f.path))) f.outOfPrScope = true
}
