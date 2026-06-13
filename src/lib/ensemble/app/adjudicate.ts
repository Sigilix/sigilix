// SIG-318 (PR 12a) — the ADJUDICATE phase of the PR-review orchestrator (app
// layer). Carved verbatim from `handlePrReviewEnsemble`: the post-synthesis
// validation block that runs `validateForSubmission`, applies the AST-emit +
// performance severity clamps, and computes the consensus re-ranking. The moved
// statements are byte-identical; only the function wrapper + the explicit
// arg/result plumbing is new. ZERO behavior change.
//
// Dependency rule: this module imports each dependency from its canonical NON-
// god-file home (the domain modules + the lib leaves), never from
// `../../triage-pr-review-ensemble`. The block has no `await`, so the function
// is synchronous.

import { durableObjectClassSpans, buildAddedLineTextByLine, type AstCache } from "@/src/features/ast-rules"
import { runAstRules } from "@/src/features/ast-rules"
import type { Env } from "@/src/shared/types/env"
import type { PrReviewVerdict } from "@/src/shared/domain/pr-review-finding"
import type { ValidationRejectionEvent } from "@/src/do/validation-metrics"
import { computeTestToSourceAddedRatio } from "@/src/lib/ensemble/domain/gates/test-ratio-damper"
import { buildSecurityFactManifest } from "@/src/lib/security-evidence-manifest"
import type { TestingEvidencePack } from "@/src/lib/testing-evidence-pack"
import { isFindingEvidenceVisible, type SigilixConfig } from "@/src/lib/sigilix-config"
import { captureGolden } from "@/src/lib/ensemble-golden-capture"
import { buildChangedLineTextByPath } from "@/src/lib/ensemble/domain/gates/validate-logic-finding"
import {
  clampTrivialSyncIoSeverity,
  clampIntentionalLiveEvalSerialLoopSeverity,
} from "@/src/lib/ensemble/domain/gates/validate-perf-finding"
import { computeConsensusRanking, clampAstEmitScores } from "@/src/lib/ensemble/domain/findings"
import {
  validateForSubmission as validateForSubmissionDomain,
  type ValidateForSubmissionArgs,
  type ValidatedOutput,
  type SynthesizerProvenance,
  type CollectedVerdict,
} from "@/src/lib/ensemble/domain/validation"
import type { EnsembleConfig } from "@/src/lib/ensemble/domain/config"

type AstResult = Awaited<ReturnType<typeof runAstRules>>
type SecurityManifest = Awaited<ReturnType<typeof buildSecurityFactManifest>>
type ChangedLineTextByPath = ReturnType<typeof buildChangedLineTextByPath>
type ReviewableMap = ValidateForSubmissionArgs["reviewable"]
type SynthesizerProvenanceFindings = SynthesizerProvenance["findings"]

/**
 * Minimal structural slice of `EnsembleTelemetry` the adjudicate phase touches.
 * Re-pointing `synthesizer.verdict`/`.provenance` and writing `postValidation`
 * mutate the caller's telemetry object by reference — so the orchestrator's
 * `telemetry` satisfies this shape and the writes land on the same object.
 */
export interface AdjudicateTelemetry {
  synthesizer: {
    verdict: PrReviewVerdict | null
    provenance: SynthesizerProvenance | null
  } | null
  postValidation: PostValidationCounts
}

type PostValidationCounts = {
  droppedForInvalidLine: number
  remappedInvalidLineToInline: number
  droppedForHallucination: number
  demotedScore1: number
  droppedForVaguePrefix: number
  droppedForUncitedTestingEvidence: number
  droppedForFailedValidation: number
  droppedForFailedTestValidation: number
  droppedForFailedLogicValidation: number
  droppedForFailedLogicRefutation: number
  droppedForFailedLogicClaimRefutation: number
  droppedForFailedRefutationSurvival: number
  droppedForFailedPerfValidation: number
  droppedForFailedInlineGroundingValidation: number
  droppedForFailedAbsenceGroundingValidation: number
  droppedForFailedWindowBlindnessValidation: number
  droppedForFailedSecurityGroundingValidation: number
  droppedForFailedSecurityUsageValidation: number
}

export interface AdjudicateArgs {
  env: Env
  owner: string
  repo: string
  prNumber: number
  headSha: string
  ensembleConfig: EnsembleConfig
  /** Mutated by reference: synthesizer re-point + postValidation write. */
  telemetry: AdjudicateTelemetry
  /** The dispatcher's mutable validation-rejection sink (the `on*FindingDropped` callbacks push to it). */
  validationSink: ValidationRejectionEvent[] | undefined
  sigilixConfig: SigilixConfig
  fullPrDiff: string
  wasTruncated: boolean
  droppedTooLarge: string[]
  reviewable: ReviewableMap
  astFilesByPath: Map<string, string>
  astCache: AstCache
  astResult: AstResult
  coverageGapSet: Set<string>
  securityManifest: SecurityManifest
  changedLineTextByPath: ChangedLineTextByPath
  testingEvidencePackWithCoverage: TestingEvidencePack
  synthInputVerdicts: CollectedVerdict[]
  effectiveSynthVerdict: PrReviewVerdict
  effectiveSynthProvenance: SynthesizerProvenance
}

export interface AdjudicateResult {
  trustLedgerMode: EnsembleConfig["flags"]["trustLedgerMode"]
  showEvidence: boolean
  validated: ValidatedOutput
  consensusVerdict: PrReviewVerdict
  consensusProvenance: SynthesizerProvenanceFindings
  consensusByIndex: number[]
}

export function adjudicateFindings(a: AdjudicateArgs): AdjudicateResult {
  const {
    env,
    owner,
    repo,
    prNumber,
    headSha,
    ensembleConfig,
    telemetry,
    validationSink,
    sigilixConfig,
    fullPrDiff,
    wasTruncated,
    droppedTooLarge,
    reviewable,
    astFilesByPath,
    astCache,
    astResult,
    coverageGapSet,
    securityManifest,
    changedLineTextByPath,
    testingEvidencePackWithCoverage,
    synthInputVerdicts,
    effectiveSynthVerdict,
    effectiveSynthProvenance,
  } = a
  // ─── Post-synthesis validation ─────────────────────────────
  // SIG-141: line spans of DurableObject class declarations in the changed
  // files, parsed from the AST (not raw text). Authz findings inside a DO
  // class body are false (the binding is the trust boundary). Best-effort:
  // derived from the already-fetched changed JS/TS head content
  // (astFilesByPath) — empty when AST features are off, which is fail-safe
  // (no suppression → findings kept, never hidden).
  const doClassSpans = durableObjectClassSpans(astFilesByPath, astCache)
  // SIG Trust Ledger v0: read the mode here (before validateForSubmission) so the
  // demote sites can tag body-routed findings with their reason when enabled.
  const trustLedgerMode = ensembleConfig.flags.trustLedgerMode
  const showEvidence = isFindingEvidenceVisible(sigilixConfig, env)
  // Re-point the synth telemetry at the SAME (verdict, provenance) pair fed to
  // validateForSubmission. telemetry.synthesizer.verdict was captured from the
  // raw synthOutput (above), but the post-synth augmentations (SIG-317 recovery
  // and the SIG-287 degraded floor) replace effectiveSynth* with the pair that
  // is actually validated and posted. Without this, the `validated.provenance`
  // assignment below leaves synthesizer.verdict (raw, shorter) index-MISALIGNED
  // with synthesizer.provenance, breaking fp-rate dismissal attribution and
  // recall-alarm counts (both pair verdict.findings[i] <-> provenance[i] by
  // index). No-op when nothing augmented (effectiveSynth* === synthOutput.*);
  // restores the pre-recovery invariant when they did (CodeRabbit #304).
  if (telemetry.synthesizer) {
    telemetry.synthesizer.verdict = effectiveSynthVerdict
    telemetry.synthesizer.provenance = effectiveSynthProvenance
  }
  // SIG-347 (AC #3): compute the diff-wide test-to-source added-line ratio
  // once from the FULL PR diff (reused as the addedLineTextByLine arg below,
  // so the map is built once). The gate damps kept testing findings when
  // the ratio is positive (> THRESHOLD).
  const fullPrAddedLineText = buildAddedLineTextByLine(fullPrDiff)
  const testToSourceRatio = computeTestToSourceAddedRatio(fullPrAddedLineText)
  // SIG-318 (PR 0b): bind the validate args so the golden-capture hook below
  // records the EXACT object passed to validateForSubmission (no behavior
  // change — same object, same call). The hook is a no-op unless
  // OPENCLAW_GOLDEN_CAPTURE === "on".
  const validateArgs = {
    trustLedgerEnabled: trustLedgerMode !== "off",
    synthOutput: { verdict: effectiveSynthVerdict, provenance: effectiveSynthProvenance },
    reviewable,
    specialistVerdicts: synthInputVerdicts,
    // SIG-314: admit the (post-shadow-strip) deterministic AST emit ids as
    // valid provenance so an unmatched emit survives the hallucination guard.
    astFindingIds: astResult.findings.map((f) => f.astFindingId),
    // SIG-113: thread the testing-evidence pack through so the
    // citation gate fires on uncited `category: "testing"` findings.
    // Empty pack (no source/test files) → gate no-ops via the
    // pure helper's "pack undefined or empty" branch.
    testingEvidence: testingEvidencePackWithCoverage,
    onTestingFindingDropped: (finding, reason) => {
      console.log(
        JSON.stringify({
          event: "pr-review-testing-finding-dropped",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          dropReason: reason,
          findingPath: finding.path,
          findingLine: finding.line,
          findingHeadline: finding.headline.slice(0, 120),
          inspectedTestFiles_count: finding.inspectedTestFiles?.length ?? 0,
          evidenceRefs_count: finding.evidenceRefs?.length ?? 0,
        }),
      )
    },
    // SIG-108: thread the security fact manifest + mode through so
    // the evidence gate fires on sev>=4 security findings. Default
    // `shadow` — the gate only counts/telemeters what WOULD drop
    // until the operator flips OPENCLAW_SECURITY_VALIDATOR_MODE to
    // "enforce".
    securityManifest: securityManifest.manifest,
    // SIG-141: DurableObject class spans — authz findings inside a DO class
    // body are suppressed (the binding is the trust boundary).
    durableObjectClassSpans: doClassSpans,
    securityValidatorMode: ensembleConfig.validatorModes.securityValidatorMode,
    securityReclassEnabled: ensembleConfig.validatorModes.securityReclassEnabled,
    onSecurityFindingDropped: (finding, info) => {
      console.log(
        JSON.stringify({
          event: "pr-review-finding-rejected-validation",
          gate: "security",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          reason: info.reason,
          dropped: info.dropped,
          path: finding.path,
          line: finding.line,
          cweId: finding.cweId ?? null,
          evidenceId: finding.evidenceId ?? null,
          category: finding.category,
        }),
      )
      validationSink?.push({
        kind: "gate-rejection",
        gate: "security",
        reason: info.reason,
        dropped: info.dropped,
        category: finding.category,
      })
    },
    // SIG-111: thread the tests-finding specificity gate mode +
    // telemetry through. Default `shadow` — counts/telemeters the
    // would-drop until the operator flips OPENCLAW_TESTS_VALIDATOR_MODE
    // to "enforce". Reuses the `pr-review-finding-rejected-validation`
    // event with a `gate: "tests"` discriminator.
    testsValidatorMode: ensembleConfig.validatorModes.testsValidatorMode,
    // SIG-118: thread the real coverage-gap set so both the SIG-113
    // citation gate and the SIG-111 specificity gate accept a
    // `coverageGap:<path>:<line>` ref as a genuine missing-coverage
    // citation. Empty when coverage ingestion is off / yielded nothing.
    coverageGaps: coverageGapSet,
    // SIG-347 (AC #3): diff-wide test-to-source ratio drives the damper.
    testToSourceRatio,
    addedLineTextByLine: fullPrAddedLineText,
    onTestFindingDropped: (finding, info) => {
      console.log(
        JSON.stringify({
          event: "pr-review-finding-rejected-validation",
          gate: "tests",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          reason: info.reason,
          dropped: info.dropped,
          path: finding.path,
          line: finding.line,
          inspectedTestFiles_count: finding.inspectedTestFiles?.length ?? 0,
          evidenceRefs_count: finding.evidenceRefs?.length ?? 0,
          category: finding.category,
        }),
      )
      validationSink?.push({
        kind: "gate-rejection",
        gate: "tests",
        reason: info.reason,
        dropped: info.dropped,
        category: finding.category,
      })
    },
    // SIG-109: thread the logic evidence + mode. Evidence is built
    // PR-A-contained — added-line text from the FULL PR diff +
    // roleHint:logic AST findings (NO symbol retrieval; that's SIG-121).
    // Default `shadow` — the gate only counts/telemeters what WOULD
    // drop until the operator flips OPENCLAW_LOGIC_VALIDATOR_MODE to
    // "enforce". Reuses the `pr-review-finding-rejected-validation`
    // event with a `gate: "logic"` discriminator.
    logicEvidence: {
      changedLineTextByPath,
      astLogicFindings: astResult.findings.filter((f) => f.roleHint === "logic"),
    },
    logicValidatorMode: ensembleConfig.validatorModes.logicValidatorMode,
    onLogicFindingDropped: (finding, info) => {
      console.log(
        JSON.stringify({
          event: "pr-review-finding-rejected-validation",
          gate: "logic",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          reason: info.reason,
          dropped: info.dropped,
          path: finding.path,
          line: finding.line,
          score: finding.score,
          category: finding.category,
        }),
      )
      validationSink?.push({
        kind: "gate-rejection",
        gate: "logic",
        reason: info.reason,
        dropped: info.dropped,
        category: finding.category,
      })
    },
    // SIG-308: logic-refutation backstop. Default `off` in code; wrangler
    // sets `shadow` so production counts/telemeters the would-flag rate
    // (a sev>=4 logic finding lacking a survival rationale) until the
    // operator flips OPENCLAW_LOGIC_REFUTATION_MODE to "enforce". Reuses the
    // `pr-review-finding-rejected-validation` event (`gate: "logic-refutation"`).
    logicRefutationMode: ensembleConfig.validatorModes.logicRefutationMode,
    onLogicRefutationFindingDropped: (finding, info) => {
      console.log(
        JSON.stringify({
          event: "pr-review-finding-rejected-validation",
          gate: "logic-refutation",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          reason: info.reason,
          dropped: info.dropped,
          path: finding.path,
          line: finding.line,
          score: finding.score,
          category: finding.category,
        }),
      )
      validationSink?.push({
        kind: "gate-rejection",
        gate: "logic-refutation",
        reason: info.reason,
        dropped: info.dropped,
        category: finding.category,
      })
    },
    // SIG-325: generalized refutation-survival gate. Default `off` in code;
    // wrangler sets `shadow` so production counts/telemeters the would-demote
    // (a sev>=4 self-originated security finding lacking a mechanism rationale)
    // until the operator flips OPENCLAW_REFUTATION_SURVIVAL_MODE to "enforce".
    // Reuses the `pr-review-finding-rejected-validation` event (`gate:
    // "refutation-survival"`). `dropped` here = "demoted to body".
    refutationSurvivalMode: ensembleConfig.validatorModes.refutationSurvivalMode,
    onRefutationSurvivalFindingDropped: (finding, info) => {
      console.log(
        JSON.stringify({
          event: "pr-review-finding-rejected-validation",
          gate: "refutation-survival",
          lens: info.lens,
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          reason: info.reason,
          dropped: info.dropped,
          path: finding.path,
          line: finding.line,
          score: finding.score,
          cweId: finding.cweId ?? null,
          evidenceId: finding.evidenceId ?? null,
          category: finding.category,
        }),
      )
      validationSink?.push({
        kind: "gate-rejection",
        gate: "refutation-survival",
        reason: info.reason,
        dropped: info.dropped,
        category: finding.category,
      })
    },
    // SIG-328/SIG-334: logic-claim refutation gate. Drops a sev>=4 logic
    // finding only when its claim (control-flow / sync-race / retry
    // idempotency / literal-string regex hallucination) is PROVABLY false
    // against the AST of the cited file (`fullFileByPath` =
    // `astFilesByPath`). Default
    // `shadow` — counts/telemeters the would-drop until the operator flips
    // OPENCLAW_LOGIC_CLAIM_REFUTATION_MODE to "enforce".
    logicClaimRefutationMode: ensembleConfig.validatorModes.logicClaimRefutationMode,
    logicClaimRefutationEnforceReasons: ensembleConfig.validatorModes.logicClaimRefutationEnforceReasons,
    onLogicClaimRefutationFindingDropped: (finding, info) => {
      console.log(
        JSON.stringify({
          event: "pr-review-finding-rejected-validation",
          gate: "logic-claim-refutation",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          reason: info.reason,
          dropped: info.dropped,
          path: finding.path,
          line: finding.line,
          score: finding.score,
          category: finding.category,
        }),
      )
      validationSink?.push({
        kind: "gate-rejection",
        gate: "logic-claim-refutation",
        reason: info.reason,
        dropped: info.dropped,
        category: finding.category,
      })
    },
    // SIG-110: thread perf evidence + mode. Evidence is the same
    // changed-line text + the roleHint:performance AST findings. Default
    // `shadow` — counts/telemeters the would-drop until the operator
    // flips OPENCLAW_PERF_VALIDATOR_MODE to "enforce". Reuses the
    // `pr-review-finding-rejected-validation` event (`gate: "perf"`).
    perfEvidence: {
      changedLineTextByPath,
      astPerfFindings: astResult.findings.filter((f) => f.roleHint === "performance"),
    },
    perfValidatorMode: ensembleConfig.validatorModes.perfValidatorMode,
    profile: sigilixConfig.profile ?? "chill",
    onPerfFindingDropped: (finding, info) => {
      console.log(
        JSON.stringify({
          event: "pr-review-finding-rejected-validation",
          gate: "perf",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          reason: info.reason,
          dropped: info.dropped,
          path: finding.path,
          line: finding.line,
          score: finding.score,
          category: finding.category,
        }),
      )
      validationSink?.push({
        kind: "gate-rejection",
        gate: "perf",
        reason: info.reason,
        dropped: info.dropped,
        category: finding.category,
      })
    },
    // SIG-281 PR C (Rec 4): inline-grounding gate. Default `shadow` —
    // counts/telemeters the would-demote until the operator flips
    // OPENCLAW_INLINE_GROUNDING_VALIDATOR_MODE to "enforce". Reuses the
    // `pr-review-finding-rejected-validation` event (`gate:
    // "inline-grounding"`). `dropped` here = "demoted to body".
    inlineGroundingValidatorMode: ensembleConfig.validatorModes.inlineGroundingValidatorMode,
    onInlineGroundingFindingDropped: (finding, info) => {
      console.log(
        JSON.stringify({
          event: "pr-review-finding-rejected-validation",
          gate: "inline-grounding",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          reason: info.reason,
          dropped: info.dropped,
          path: finding.path,
          line: finding.line,
          score: finding.score,
          category: finding.category,
        }),
      )
      validationSink?.push({
        kind: "gate-rejection",
        gate: "inline-grounding",
        reason: info.reason,
        dropped: info.dropped,
        category: finding.category,
      })
    },
    // SIG-290 v1: absence-claim grounding gate. Default `off` — the gate
    // doesn't run at all until the operator flips
    // OPENCLAW_ABSENCE_CLAIM_VALIDATOR_MODE to "shadow" (count/telemeter,
    // keep inline) or "enforce" (demote ungrounded absence-claims to the
    // body). `wasTruncated` + `droppedTooLarge` are the in-scope diff-
    // packing signals from `handlePrReviewEnsemble`. Reuses the
    // `pr-review-finding-rejected-validation` event (`gate:
    // "absence-grounding"`). `dropped` here = "demoted to body".
    absenceClaimValidatorMode: ensembleConfig.validatorModes.absenceClaimValidatorMode,
    wasTruncated,
    droppedPaths: droppedTooLarge,
    onAbsenceFindingDropped: (finding, info) => {
      console.log(
        JSON.stringify({
          event: "pr-review-finding-rejected-validation",
          gate: "absence-grounding",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          reason: info.reason,
          dropped: info.dropped,
          path: finding.path,
          line: finding.line,
          score: finding.score,
          category: finding.category,
        }),
      )
      validationSink?.push({
        kind: "gate-rejection",
        gate: "absence-grounding",
        reason: info.reason,
        dropped: info.dropped,
        category: finding.category,
      })
    },
    // Cross-cutting over-fire Option B: window-blindness gate. Default off
    // until OPENCLAW_WINDOW_BLINDNESS_VALIDATOR_MODE is flipped to shadow
    // (count/telemeter, keep inline) or enforce (demote a sev>=4 logic
    // positive-misread whose guard is provably out-of-window). Threads
    // `astFilesByPath` as the full-file source. Reuses the
    // `pr-review-finding-rejected-validation` event (`gate: "window-blindness"`).
    // `dropped` here = "demoted to body".
    windowBlindnessValidatorMode: ensembleConfig.validatorModes.windowBlindnessValidatorMode,
    fullFileByPath: astFilesByPath,
    astCache,
    onWindowBlindnessFindingDropped: (finding, info) => {
      console.log(
        JSON.stringify({
          event: "pr-review-finding-rejected-validation",
          gate: "window-blindness",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          reason: info.reason,
          dropped: info.dropped,
          path: finding.path,
          line: finding.line,
          score: finding.score,
          category: finding.category,
          // Shadow-validation payload (Kimi nit): the cited subject + the
          // out-of-window guard line a human checks before the enforce flip.
          matchedIdentifier: info.matchedIdentifier,
          guardLine: info.guardLine,
        }),
      )
      validationSink?.push({
        kind: "gate-rejection",
        gate: "window-blindness",
        reason: info.reason,
        dropped: info.dropped,
        category: finding.category,
      })
    },
    // SIG-293 v1: security-grounding gate (secrets-exposure). Default
    // `off` — the gate doesn't run until the operator flips
    // OPENCLAW_SECURITY_GROUNDING_VALIDATOR_MODE to "shadow" (count/
    // telemeter, keep inline) or "enforce" (demote a secrets-exposure
    // finding whose cited line holds no credential token). Reuses the
    // `securityManifest` + `addedLineTextByLine` already threaded above,
    // and the `pr-review-finding-rejected-validation` event (`gate:
    // "security-grounding"`). `dropped` here = "demoted to body".
    securityGroundingValidatorMode: ensembleConfig.validatorModes.securityGroundingValidatorMode,
    onSecurityGroundingFindingDropped: (finding, info) => {
      console.log(
        JSON.stringify({
          event: "pr-review-finding-rejected-validation",
          gate: "security-grounding",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          reason: info.reason,
          dropped: info.dropped,
          path: finding.path,
          line: finding.line,
          score: finding.score,
          cweId: finding.cweId ?? null,
          category: finding.category,
        }),
      )
      validationSink?.push({
        kind: "gate-rejection",
        gate: "security-grounding",
        reason: info.reason,
        dropped: info.dropped,
        category: finding.category,
      })
    },
    // SIG-311 Layers A+B: security usage-vs-mention gate. Default off until
    // OPENCLAW_SECURITY_USAGE_VALIDATOR_MODE is flipped to shadow/enforce.
    securityUsageValidatorMode: ensembleConfig.validatorModes.securityUsageValidatorMode,
    onSecurityUsageFindingDropped: (finding, info) => {
      console.log(
        JSON.stringify({
          event: "pr-review-finding-rejected-validation",
          gate: "security-usage",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          reason: info.reason,
          dropped: info.dropped,
          path: finding.path,
          line: finding.line,
          score: finding.score,
          cweId: finding.cweId ?? null,
          category: finding.category,
        }),
      )
      validationSink?.push({
        kind: "gate-rejection",
        gate: "security-usage",
        reason: info.reason,
        dropped: info.dropped,
        category: finding.category,
      })
    },
    // SIG-318 (PR 12a): the orchestrator originally targeted
    // `Parameters<typeof validateForSubmission>[0]` (the god-file's
    // optional-astCache wrapper). Here we call the domain fn directly — the
    // literal sets `astCache` definitely (assigned once, unconditionally, at
    // the orchestrator's `createAstCache()` before this phase runs), so it is
    // runtime-identical to the original wrapper call.
  } satisfies ValidateForSubmissionArgs
  const validated = validateForSubmissionDomain(validateArgs)
  // SIG-318 (PR 0b): golden-output capture seam #1 (validate). No-op unless
  // OPENCLAW_GOLDEN_CAPTURE === "on"; off/unset → byte-identical behavior.
  captureGolden(env, "validate", { args: validateArgs, output: validated })
  if (telemetry.synthesizer) {
    telemetry.synthesizer.provenance = validated.provenance
  }
  telemetry.postValidation = {
    droppedForInvalidLine: validated.droppedForInvalidLine,
    remappedInvalidLineToInline: validated.remappedInvalidLineToInline,
    droppedForHallucination: validated.droppedForHallucination,
    demotedScore1: validated.demotedScore1,
    droppedForVaguePrefix: validated.droppedForVaguePrefix,
    droppedForUncitedTestingEvidence: validated.droppedForUncitedTestingEvidence,
    droppedForFailedValidation: validated.droppedForFailedValidation,
    droppedForFailedTestValidation: validated.droppedForFailedTestValidation,
    droppedForFailedLogicValidation: validated.droppedForFailedLogicValidation,
    droppedForFailedLogicRefutation: validated.droppedForFailedLogicRefutation,
    droppedForFailedLogicClaimRefutation: validated.droppedForFailedLogicClaimRefutation,
    droppedForFailedRefutationSurvival: validated.droppedForFailedRefutationSurvival,
    droppedForFailedPerfValidation: validated.droppedForFailedPerfValidation,
    droppedForFailedInlineGroundingValidation: validated.droppedForFailedInlineGroundingValidation,
    droppedForFailedAbsenceGroundingValidation: validated.droppedForFailedAbsenceGroundingValidation,
    droppedForFailedWindowBlindnessValidation: validated.droppedForFailedWindowBlindnessValidation,
    droppedForFailedSecurityGroundingValidation: validated.droppedForFailedSecurityGroundingValidation,
    droppedForFailedSecurityUsageValidation: validated.droppedForFailedSecurityUsageValidation,
  }

  // SIG-310: a deterministic_emit AST rule's SEVERITY is a HARD score ceiling
  // on any finding it produces. The synth picks `score` freely (advisory text
  // only), so a warning-severity type smell — the optional-alias drift — could
  // otherwise be emitted at P0/P1, breaking the zero-P0/P1-FP bar (code-review
  // MAJOR). Deterministically clamp any finding co-located (±2 lines, same
  // path, same category) with a NON-`error` emitWhenUnmatched AST finding to
  // that rule's tier (warning→3/P2, info→2). `error` security emit rules are
  // never clamped — a P0/P1 injection/TLS sink is the correct outcome there.
  const astEmitClamped = clampAstEmitScores(
    validated.verdict.findings,
    astResult.findings,
    validated.cleanFindingProvenance,
  )
  if (astEmitClamped > 0) {
    console.log(
      JSON.stringify({
        event: "ast-emit-score-clamped",
        owner,
        repo,
        prNumber,
        headSha: headSha.slice(0, 7),
        count: astEmitClamped,
      }),
    )
  }

  // BT1/SIG-342: deterministic performance severity clamps. These do NOT
  // drop findings; they only cap narrow proof-backed FP shapes below the
  // P0/P1 blocker tier. Clamp BOTH the inline verdict findings AND the
  // body-only (unanchored) findings (CodeRabbit #298): a demoted-to-body
  // finding would otherwise keep its sev>=4 score in the body/event output.
  const perfClampLines = buildAddedLineTextByLine(fullPrDiff)
  const trivialSyncIoClamped =
    clampTrivialSyncIoSeverity(validated.verdict.findings, perfClampLines) +
    clampTrivialSyncIoSeverity(validated.unanchoredFindings, perfClampLines)
  if (trivialSyncIoClamped > 0) {
    console.log(
      JSON.stringify({
        event: "perf-trivial-sync-io-clamped",
        owner,
        repo,
        prNumber,
        headSha: headSha.slice(0, 7),
        count: trivialSyncIoClamped,
      }),
    )
  }
  const liveEvalSerialClamped =
    clampIntentionalLiveEvalSerialLoopSeverity(validated.verdict.findings, perfClampLines) +
    clampIntentionalLiveEvalSerialLoopSeverity(validated.unanchoredFindings, perfClampLines)
  if (liveEvalSerialClamped > 0) {
    console.log(
      JSON.stringify({
        event: "perf-live-eval-serial-clamped",
        owner,
        repo,
        prNumber,
        headSha: headSha.slice(0, 7),
        count: liveEvalSerialClamped,
      }),
    )
  }

  // ARC-270 — consensus-aware re-ranking. Strictly additive: we
  // don't change the verdict gate (`chooseReviewEvent`), drop
  // findings, or touch scores. Just reorder so multi-specialist
  // findings surface first and capture a consensus count per
  // finding for the body annotation below.
  const consensusRanked = computeConsensusRanking(validated.verdict, validated.cleanFindingProvenance)
  const consensusVerdict = consensusRanked.verdict
  const consensusProvenance = consensusRanked.provenance
  const consensusByIndex = consensusRanked.consensusByIndex
  const highConsensusCount = consensusByIndex.filter((c) => c >= 2).length
  if (consensusVerdict.findings.length > 0) {
    console.log(
      JSON.stringify({
        event: "pr-review-consensus-rerank",
        owner,
        repo,
        prNumber,
        headSha: headSha.slice(0, 7),
        finding_count: consensusVerdict.findings.length,
        high_consensus_count: highConsensusCount,
        max_consensus: consensusByIndex.reduce((m, c) => Math.max(m, c), 0),
      }),
    )
  }

  return {
    trustLedgerMode,
    showEvidence,
    validated,
    consensusVerdict,
    consensusProvenance,
    consensusByIndex,
  }
}
