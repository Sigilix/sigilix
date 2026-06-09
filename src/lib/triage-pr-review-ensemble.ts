// Phase 4 ensemble PR-review orchestrator. Per v3.1 LOCKED spec.
//
// Lifecycle (shadow + post modes):
//
//   1. Routing decision (mode + repo allowlist + budget gate)
//   2. Stale-head guard #1 (before fanout)
//   3. Pre-flight retrieval snapshot (cached)
//   4. Router decides which specialists to invoke (default: all 4)
//   5. Fan out specialists in parallel via runAgentLoop, each wrapped in
//      withComposedTimeout(90s). Promise.allSettled captures failures.
//   6. Quorum check (post mode requires ≥1 of logic/security succeeded)
//   7. Truncate each specialist verdict to 8k tokens before fan-in
//   8. Assign stable IDs (logic-0, security-1, ...) so synthesizer can
//      reference them in provenance.sourceFindingIds
//   9. Synthesizer (Kimi K2.6) runs on specialist verdicts plus
//      precomputed context blocks, with no follow-up tool calls.
//      120s timeout
//  10. Post-synthesis validation:
//      - Hallucination guard: provenance.findings[i].sourceFindingIds
//        must reference real specialist findings
//      - Line validity: drop findings whose (path, line) isn't a
//        reviewable position in the diff
//      - Side derivation: orchestrator picks LEFT/RIGHT from parsed diff
//      - Score-1 demotion: dropped from inline output; optionally
//        aggregated into Advisory nits only for assertive profiles
//  11. Stale-head guard #2 (before posting)
//  12. Submit OR skip (shadow mode = telemetry-only)
//  13. Write ensemble telemetry record (paired with any Phase 3 record
//      for the same {owner, repo, prNumber, headSha})
//
// In `shadow` mode this runs IN PARALLEL TO Phase 3 — Phase 3 posts the
// customer-facing review, ensemble writes telemetry only. In `post` mode
// the ensemble verdict gets posted to GitHub.

import type { ChatMessage } from "../shared/ports/model"
// ARC-283 Phase B1b: re-export ChatMessage so the shadow runner can
// type its `runWithRetryAndFallback` calls without reaching past
// this module into ./ollama-chat.
export type { ChatMessage }
import { retrieveChunks, formatChunksForPrompt, type RetrievedChunk } from "./retrieval"
import {
  multiCorpusEnabled,
  retrieveMultiCorpus,
  formatMultiCorpusForPrompt,
  type MultiCorpusResult,
} from "./multi-corpus"
import { indexNamespace } from "./repo-index-manifest"
import {
  buildPerfRetrievalQuery,
  extractChangedFunctionNames,
  shouldRunPerfRetrieval,
  resolvePerfSnapshot,
  selectRetrievalSnapshotForRole,
} from "./perf-retrieval"
import {
  extractChangedSymbols,
  buildSymbolRetrievalQuery,
  computeChunkOverlap,
  shouldRunSymbolRetrieval,
  mergeLogicSnapshot,
} from "./symbol-retrieval"
import {
  shouldRunBranchAwareRetrieval,
  prepareBranchSet,
  retrieveBranchChunks,
  mergeBranchAware,
  buildBranchRetrievalEvent,
  type BranchVector,
} from "./branch-retrieval"
import {
  buildDynamicReviewEvidencePack,
  dynamicReviewEvidenceEnabled,
  dynamicReviewEvidenceMode,
  renderDynamicReviewEvidenceBlock,
  type DynamicReviewEvidenceEnv,
  type DynamicReviewEvidenceMode,
  type DynamicReviewEvidencePack,
} from "./review-evidence-pack"
import { embedText } from "../shared/adapters/model"
import {
  buildAddedLineTextByLine,
  buildChangedLines,
  buildDeletedLineTextByLine,
  type ChangedLines,
} from "@/features/ast-rules"
import { mapWithConcurrency } from "../shared/util/bounded-concurrency"
import {
  loadWithdrawals,
  filterWithdrawnFindings,
  filterWithdrawnFindingsDetailed,
  computeContentFingerprint,
  type WithdrawalRecord,
} from "./review-withdrawal-store"
import { recordRepeatFpMetrics, type RepeatFpEvent } from "./validation-metrics-client"
import { GitHubClient, GitHubHttpError } from "../shared/adapters/github"
import type { CheckRunAnnotation } from "../shared/types/github"
import { applyOutputSurfaceToSubmission, selectPrimarySubmitAnnotations } from "./pr-review-check-run"
import {
  type PrReviewVerdict,
  type PrReviewFinding,
  type CoverageRoles,
  type DeltaBadgeCounts,
  buildClearedLogicCandidateTelemetry,
  buildBodyOnlyCheckAnnotations,
  buildFallbackSubmission,
  buildReviewSubmissionWithMetadata,
  getProposedChangeScopeMismatch,
  previewFallbackSubmissionEvent,
  previewReviewSubmissionEvent,
  type ReviewSuggestionEmission,
} from "./triage-pr-review"
// SIG-361 (PR 9): the verdict domain. The moved names import directly from the
// leaf (the inward direction per the dependency rule); `severityTier` is
// import-back (was private here — NOT re-exported), while
// `LOW_CONFIDENCE_COMMENT_THRESHOLD` + `resolveReviewEventOverride` were exported
// at HEAD (tests import the latter from this path), so both are re-exported to
// preserve this module's public surface.
import {
  chooseReviewEvent,
  computeShadowGateDivergence,
  severityTier,
  LOW_CONFIDENCE_COMMENT_THRESHOLD,
  resolveReviewEventOverride,
  type ReviewEvent,
} from "./ensemble/domain/verdict"
export { LOW_CONFIDENCE_COMMENT_THRESHOLD, resolveReviewEventOverride }
// SIG-360: `isSubstantiveAnchorLine` relocated to a shared/util leaf so the
// validation domain can reference it without importing this god-file's sibling.
import { isSubstantiveAnchorLine } from "@/shared/util/anchor-lines"
import {
  assessApprovalReadiness,
  buildApprovalReadinessSummary,
  type ApprovalReadinessSourceFinding,
} from "./approval-readiness"
import { readGateMode, readGateThreshold } from "./gate-config"
import { buildPrUrl, preparePrReviewCounter } from "./pr-review-counter"
import {
  buildTestingEvidencePack,
  fetchTestFileContentsWithBudget,
  filterTestingEvidenceForSuppressedMissingCoverage,
  mergeInspectedTestFileContents,
  mergeHelperCoverage,
  mergeTestingFocusHints,
  renderTestingEvidenceBlock,
  type TestingEvidencePack,
  type InspectedTestFileFetchResult,
} from "./testing-evidence-pack"
import { detectHelperCoverage } from "./helper-coverage"
import {
  buildSecurityFactManifest,
} from "./security-evidence-manifest"
import {
  evaluateScanFactDismissal,
} from "./validate-security-finding"
import {
  buildChangedLineTextByPath,
} from "./validate-logic-finding"
import { postReviewCommentFallback, postReviewSkipNotice, type SkipNoticeReason } from "./review-comment-fallback"
import {
  decideSpecialists,
  ALL_SPECIALISTS,
  type SpecialistRole,
  type RouterDecision,
} from "./ensemble-router"
import { decideSpecialistsDynamic } from "./dynamic-dispatcher"
import {
  createRetrievalCache,
  type RetrievalCacheStats,
} from "./retrieval-cache"
import {
  parseDiffToReviewablePositions,
} from "./diff-positions"
import {
  SPECIALIST_PROMPTS,
  SYNTHESIZER_PROMPT,
  buildSpecialistInitialMessage,
  buildSynthesizerInitialMessage,
  renderSpecialistVerdictsForSynth,
} from "../prompts/pr-review-specialists"
import {
  detectStack,
  computeFileOverlap,
  type FileOverlap,
  type StackContext,
} from "./pr-stack"
import { renderStackPromptBlock } from "../prompts/pr-stack-prompt"
import type { ListOpenPullsItem } from "../shared/types/github"
import { withComposedTimeout } from "./agent-loop"
import {
  applyLogicPromptBudget,
} from "./logic-prompt-budget"
import {
  isPrOverviewEnabled,
  loadSigilixConfig,
  passesLabelGate,
  renderPathInstructionsForPrompt,
  resolvePathInstructionsForChangedPaths,
  resolveCostControlsConfig,
  resolveDocsReviewConfig,
  resolveCommandConfig,
  resolveAstRulesConfig,
  resolveCoverageConfig,
  resolvePerfBudgetsConfig,
  type SigilixConfig,
} from "./sigilix-config"
import {
  buildAiInstructionGuidance,
  filterAiInstructionsForChangedPaths,
  loadAiInstructions,
  shouldIngestAiInstructions,
} from "./ai-instructions"
import {
  renderScopedRulesForPrompt,
  resolveScopedRulesForChangedPaths,
} from "./scoped-rules"
import { loadCompiledScopedRulesManifest } from "./scoped-rules-kv"
import {
  runPerfBudgetsCheck,
  renderPerfBudgetsForPrompt,
  type PerfBudgetsHit,
} from "../shared/domain/perf-budgets"
import { ingestCoverage, renderCoverageGapBlock } from "./coverage-ingest"
import {
  handlePrOverview,
  type PrOverviewArgs,
  type PrOverviewReviewContext,
} from "./triage-pr-overview"
import {
  runDocsCoverageCheck,
  renderDocsCoverageForPrompt,
  type DocsCoverageHit,
} from "./docs-coverage-check"
import {
  splitDiffByFile,
  packFilesIntoBatches,
  batchToDiff,
  estimateTokens,
} from "./diff-packing"
import {
  classifyDiffFiles,
  renderDiffFileClassificationBlock,
} from "./diff-file-classify"
import { shouldReview } from "../shared/util/path-glob"
import {
  runDeterministicChecks,
  renderHitsForPrompt,
  type DeterministicCheckHit,
} from "../shared/domain/deterministic-checks"
import {
  runSecretScan,
  renderSecretHitsForPrompt,
  type SecretHit,
} from "./secret-scan"
import {
  readLastReviewedSha,
  writeLastReviewedSha,
  selectDiff,
  type DiffMode,
} from "./incremental-review"
import { recordReviewedDiffHash } from "./noop-merge-detect"
import {
  readReviewManifest,
  type ReviewManifestFinding,
} from "./review-manifest"
import { dismissPriorSigilixReviews } from "./dismiss-prior-reviews"
import { runDepVulnScan, type ScanSkipReason as DepVulnSkipReason } from "@/features/dep-vulns"
import { runAstRules } from "@/features/ast-rules"
import { createAstCache, type AstCache } from "@/features/ast-rules"
import { analyzeHelperBypass, renderAsymmetryHints } from "@/features/ast-rules"
import { analyzeToctouRace, renderToctouHints } from "@/features/ast-rules"
import { renderAstFindingsAsJsonForSynth } from "@/features/ast-rules"
import { buildFactsByRole } from "./role-scoped-facts"
import { postAstInlineFindings } from "@/features/ast-rules"
import { runSarifEvidence, type ScanSkipReason as SarifSkipReason } from "@/features/sarif-evidence"
import { lookupRunnerEvidence, readRunnerEvidenceMode, type RunnerEvidenceState } from "./runner-evidence/lookup"
import { recordRunnerEvidenceMetric } from "./runner-evidence-metrics-client"
import { readVerificationMode, readReanchorEnabled } from "./verification/mode"
import { verifyFinding, findingKey, selectRefutedInlineDemotions, applyRefutedDemotion, planReanchor, applyReanchors } from "./verification/verify-finding"
import {
  verifyFindingAgainstReceipt,
  buildReceiptIndex,
  extractReceiptScanResults,
  type ReceiptScanResult,
} from "./verification/verify-finding-receipt"
import { parseSarif } from "@/features/sarif-evidence"
import { normalizeSarifPath } from "@/features/sarif-evidence"
import { recordVerificationMetricsBounded } from "./verification-metrics-client"
import { RECEIPTJOIN_CATEGORY, TRUSTLEDGER_CATEGORY, type RecordVerificationArgs } from "../do/verification-metrics"
import { annotateFindingTrust } from "./trust-ledger-thread"
import {
  renderSarifFindingsForPrompt,
  renderSarifFindingsAsJsonForSynth,
} from "@/features/sarif-evidence"
import { buildSarifCheckAnnotations } from "@/features/sarif-evidence"
import { resolveSarifEvidenceConfig } from "./sigilix-config"
import { renderDepVulnFindingsForPrompt } from "@/features/dep-vulns"
import {
  buildSigilixMarker,
  categoryFromRoleHint,
  computeFid,
  computePathSha256,
  markerSeverityFromScore,
} from "./review-memory/marker"
import {
  extractClaims,
  CLAIM_EXTRACTION_SCHEMA,
  type ClaimExtractionFinding,
} from "./review-memory/claim-extractor"
import {
  shadowMatchReviewMemoryClaims,
  type ShadowMatchFinding,
} from "./review-memory/shadow-match"
import { isSoftenActive, softenScoreWithFloor } from "./review-memory/soften-gate"
import { applyDegradedCoverageFindingFloor, applySynthSourceFindingFloor, recoverTruncatedSynthFindings, injectUnmatchedAstEmits } from "./degraded-finding-floor"
import {
  readCalibrationParams,
  shouldKeepSoften,
  decideWarmSoftenSurvival,
  type WarmSoftenCandidate,
  type WarmSoftenDecision,
} from "./review-memory/calibration"
import { runReviewMemoryLookup } from "./review-memory/lookup"
import { renderReviewMemoryForPrompt } from "./review-memory/render"
import { resolveReviewMemoryConfig } from "./sigilix-config"
// SIG-147: per-repo precision-profile feedback loop (suppress repeatedly-dismissed
// patterns, record outcome signal). Shadow-gated; recall-safe.
import { loadPrecisionProfile, recordOutcome, applyPrecisionProfile } from "@/features/precision-profile"
import type {
  ReviewMemoryClaimMarkerData,
  ReviewMemoryClaimType,
  ReviewMemoryFinding,
  ReviewMemorySkipReason,
} from "./review-memory/types"
import { handleStaleHead } from "./stale-head"
import { checkIsPrMerged, submitMergedOnApprove } from "./merge-guard"
import {
  type EnsembleRunCtx,
  type SynthSummary,
  computeSpecialistFanoutSummary,
  emitPhaseCompleted,
  emitSpecialistFanoutSummary,
  emitSynthSummary,
  narrowSynthRetryOutcome,
} from "./ensemble-perf-telemetry"
import {
  type TokenUsageByModel,
  emitReviewSlo,
  makeTokenRecorder,
} from "./ensemble-slo-telemetry"
// ARC-283 Phase B1b — shadow-mode bake-off harness. Imports are
// no-ops when `env.SHADOW_BAKEOFF_ROLES` is unset/empty (the only
// code path that fires is `parseShadowEnabledRoles("")` → empty
// Set → every `resolveShadowConfig` returns null → no fan-out).
import {
  parseShadowEnabledRoles,
  resolveShadowConfig,
} from "./shadow-bakeoff-config"
import {
  type FindingForOverlap,
} from "./shadow-bakeoff-telemetry"
import {
  runShadowSpecialist,
  runShadowSynth,
  type ShadowRunResult,
} from "./shadow-bakeoff-runner"
import type { Env } from "../shared/types/env"
// SIG-318 (PR 0b): golden-output safety harness capture hook. Flag-gated
// (OPENCLAW_GOLDEN_CAPTURE), off by default → byte-identical behavior.
import { captureGolden } from "./ensemble-golden-capture"
// SIG-138 Phase 2 — graph expansion.
import { graphContextFor, blastRadiusByNamesFor } from "./repo-graph-client"
// SIG-286 — graph-context body expansion (shadow-only in PR1).
import { contextExpansionForChangedSymbolsFor } from "./repo-graph-client"
import {
  buildGraphContextExpansion,
  renderGraphExpansionForPrompt,
  netNewCrossFileBodies,
} from "./graph-context-expansion"
import type { ValidationRejectionEvent } from "../do/validation-metrics"
import type { GraphRetrievalSample } from "../do/graph-metrics"
import type { GraphExpansionSample } from "../do/graph-expansion-metrics"
import { graphExpansionMode, injectArm } from "./graph-expansion-mode"
import type { GraphContextNode } from "../do/repo-graph"
import { edgeWeight, hopDecay } from "./graph-scoring"
import { withTimeout } from "../shared/util/with-timeout"
// SIG-318: the ensemble timeout schedule + its load-time budget invariants now
// live in the domain layer (src/lib/ensemble/domain/budget.ts). Value-imported
// (NOT type-only) so budget.ts's module-load assertion fires whenever this
// module graph loads — preserving the original fail-fast-at-import behavior —
// and re-exported below so existing importers (tests + siblings) are unaffected.
import {
  SPECIALIST_TIMEOUT_MS,
  SYNTHESIZER_TIMEOUT_MS,
  SYNTHESIZER_RETRY_TIMEOUT_MS,
  RESERVED_HEADROOM_MS,
  ORCHESTRATOR_TIMEOUT_MS,
  RETRIEVAL_PREFLIGHT_TIMEOUT_MS,
  PER_ATTEMPT_TIMEOUT_MS,
  GRAPH_RPC_TIMEOUT_MS,
  GRAPH_EXPANSION_TIMEOUT_MS,
  SYNTH_RETRY_FINALIZE_RESERVE_MS,
  SHADOW_FINALIZE_GRACE_MS,
} from "./ensemble/domain/budget"
export {
  SPECIALIST_TIMEOUT_MS,
  SYNTHESIZER_TIMEOUT_MS,
  SYNTHESIZER_RETRY_TIMEOUT_MS,
  RESERVED_HEADROOM_MS,
  ORCHESTRATOR_TIMEOUT_MS,
  RETRIEVAL_PREFLIGHT_TIMEOUT_MS,
  PER_ATTEMPT_TIMEOUT_MS,
  GRAPH_RPC_TIMEOUT_MS,
  GRAPH_EXPANSION_TIMEOUT_MS,
  SYNTH_RETRY_FINALIZE_RESERVE_MS,
  SHADOW_FINALIZE_GRACE_MS,
}
// SIG-318 (PR 2): the FINDINGS domain (stable IDs, consensus ranking +
// annotation, the stable (path, headline) key, and cross-push deltas) moved to
// ./ensemble/domain/findings. Value-imported for internal use + re-exported so
// existing importers (tests) are unaffected. PrReviewVerdictWithIds is
// type-imported for internal use only — it was god-file-private; its home is now
// the domain, so it is NOT re-exported here (surface unchanged).
import {
  assignStableFindingIds,
  computeConsensusRanking,
  annotateWithConsensus,
  computeFindingKey,
  computeFindingDelta,
  clampAstEmitScores,
} from "./ensemble/domain/findings"
import type { PrReviewVerdictWithIds } from "./ensemble/domain/findings"
import { parseEnsembleConfig } from "./ensemble/config"
import type { EnsembleConfig } from "./ensemble/domain/config"
export {
  assignStableFindingIds,
  computeConsensusRanking,
  annotateWithConsensus,
  computeFindingKey,
  computeFindingDelta,
  clampAstEmitScores,
}
export type { ConsensusRanked, FindingDelta } from "./ensemble/domain/findings"
// SIG-318 (PR 7): the fan-out POLICY domain (min-specialists early-exit mode +
// gate action, and the degraded-coverage split) moved to ./ensemble/domain/policy.
// Value-imported for internal use + re-exported so existing importers (tests) are
// unaffected.
import {
  parseMinSpecialistsEarlyExitMode,
  decideEarlyExitAction,
  computeDegradedCoverage,
} from "./ensemble/domain/policy"
export {
  parseMinSpecialistsEarlyExitMode,
  decideEarlyExitAction,
  computeDegradedCoverage,
}
export type { MinSpecialistsEarlyExitMode, EarlyExitAction } from "./ensemble/domain/policy"
// SIG-318 (PR 8) / SIG-360: the post-synthesis VALIDATION domain (the believability
// core — hallucination guard, per-lens evidence gates, scope/anchor normalization,
// and validateForSubmission) moved to ./ensemble/domain/validation. The domain
// `validateForSubmission` requires a definite `astCache`; the god-file keeps the
// original optional-astCache public signature via the thin wrapper below (the one
// permitted body delta). The pure helpers stay god-file-private (import-backs);
// VAGUE_PREFIXES / hasVaguePrefix / evaluateTestingFindingCitation / ValidatedOutput
// / SynthesizerProvenance are re-exported so existing importers (tests) are unaffected.
import {
  validateForSubmission as validateForSubmissionDomain,
  evidencePieceCountForTelemetry,
  type ValidateForSubmissionArgs,
  type ValidatedOutput,
  type SynthesizerProvenance,
  type CollectedVerdict,
} from "./ensemble/domain/validation"
export {
  VAGUE_PREFIXES,
  hasVaguePrefix,
  evaluateTestingFindingCitation,
} from "./ensemble/domain/validation"
export type { ValidatedOutput, SynthesizerProvenance } from "./ensemble/domain/validation"
// SIG-318 (PR 12a): the post-synthesis ADJUDICATE phase (validateForSubmission +
// the AST-emit/perf severity clamps + consensus re-ranking) moved to the app
// layer. It imports each dependency from its canonical domain/leaf home, so the
// dependency rule holds (app → domain, never back into this orchestrator).
import { adjudicateFindings } from "./ensemble/app/adjudicate"
// SIG-318 (PR 12b): the shadow-bakeoff SETTLE phase (the outer-finally shadow
// comparison emit) + the ShadowBakeoffState holder moved to the app layer.
import {
  settleShadowBakeoff,
  type ShadowBakeoffState,
  type ProdSpecialistSnapshot,
} from "./ensemble/app/shadow-settle"

// ─── tunables (defaults — env-overridable) ─────────────────────────────

// SIG-361 (PR 9): `LOW_CONFIDENCE_COMMENT_THRESHOLD` moved to the verdict domain
// (imported + re-exported above).
// SIG-129: branch chunks to consider per pass before merge dedup/re-rank.
// Matches retrieval.ts TOP_K (6) so a pass can be fully branch-sourced.
const TOP_K_BRANCH = 6
// SIG-143: max blast-radius paths folded into the prompt graph-context block.
// Mirrors the ≤4 cap on BFS graph-node additions — keeps the additive context
// from crowding out the primary vector-hit retrieval.
const GRAPH_BLAST_PROMPT_CAP = 4
const SPECIALIST_VERDICT_TOKEN_CAP = 8_000
export interface ResolveDynamicEvidencePromptBlockArgs {
  env: DynamicReviewEvidenceEnv
  filesByPath: ReadonlyMap<string, string>
  changedLines: ChangedLines
  reviewablePaths: readonly string[]
  retrievalChunks: readonly RetrievedChunk[]
  graphNodes: readonly GraphContextNode[]
  blastCallerPaths: readonly string[]
  blastDependentPaths: readonly string[]
  testingEvidence: TestingEvidencePack | undefined
  /** SIG-336: shared per-review parse-once cache (the evidence pack parses each
   *  changed file via extractFileGraph — reuse the runner's AST). */
  astCache?: AstCache
}

export interface ResolvedDynamicEvidencePromptBlock {
  mode: DynamicReviewEvidenceMode
  pack: DynamicReviewEvidencePack | null
  rendered: string
  promptBlock: string
}

export function resolveDynamicEvidencePromptBlock(
  args: ResolveDynamicEvidencePromptBlockArgs,
): ResolvedDynamicEvidencePromptBlock {
  const mode = dynamicReviewEvidenceMode(args.env)
  if (mode === "off") {
    return { mode, pack: null, rendered: "", promptBlock: "" }
  }

  const pack = buildDynamicReviewEvidencePack({
    filesByPath: args.filesByPath,
    changedLines: args.changedLines,
    reviewablePaths: args.reviewablePaths,
    retrievalChunks: args.retrievalChunks,
    graphNodes: args.graphNodes,
    blastCallerPaths: args.blastCallerPaths,
    blastDependentPaths: args.blastDependentPaths,
    ...(args.testingEvidence !== undefined ? { testingEvidence: args.testingEvidence } : {}),
    ...(args.astCache !== undefined ? { astCache: args.astCache } : {}),
  })
  const rendered = renderDynamicReviewEvidenceBlock(pack)

  return {
    mode,
    pack,
    rendered,
    promptBlock: mode === "post" ? rendered : "",
  }
}

// ─── SIG-216 fix-up: inline-overview budgeting ───────────────────────────
//
// The inline pr-overview call inside `handlePrReviewEnsemble` (added in
// SIG-216) runs an additional Ollama generate ON TOP of the ensemble's
// 895s orchestrator budget. The full review handler must finish inside
// the 900s `CF_QUEUE_CONSUMER_CEILING_MS` queue-consumer wall — a stalled
// overview can otherwise push the consumer past the platform ceiling,
// leaving the queue message in the in_progress state and triggering a
// re-delivery + duplicate review.
//
// Floor: when the remaining review budget drops below this, skip the
// inline overview entirely. The overview will fire on the next push or
// can be re-attempted via warmup. 30s reserves enough room for the
// post-overview stale-head re-check + submitReview round-trip + the
// finally cleanup paths.
export const INLINE_OVERVIEW_MIN_BUDGET_MS = 30_000

// Ceiling: even on a generous budget surplus, cap the inline overview
// wall-time at 90s so a single slow overview can never starve the rest
// of the submit pipeline. Matches the same order-of-magnitude as a
// SPECIALIST_TIMEOUT_MS attempt.
export const INLINE_OVERVIEW_MAX_BUDGET_MS = 90_000

// Reserved tail for the post-overview stale-head re-check (~1s),
// `submitReview` GitHub roundtrip (~3-10s typical, allow headroom for
// 422 + fallback), and the `dismissPriorSigilixReviews` call ahead of
// it. Subtracted from the wall-clock budget the inline overview gets.
const INLINE_OVERVIEW_SUBMIT_RESERVE_MS = 30_000

// ─── SIG-138 Phase 2: graph-retrieval pure helpers ────────────────────────
//
// Exported for unit-testing (no DO/network access — pure env-flag reads
// and string formatting). All three follow the env-flag conventions used
// by OPENCLAW_SYMBOL_RETRIEVAL / OPENCLAW_BRANCH_AWARE_RETRIEVAL.

// SIG-143: blast-radius name resolution is implemented — the graph block calls
// `blastRadiusByNamesFor` with the PR's changed symbol names, which the DO
// resolves to symbol_ids in the active version. With resolution live, a raw
// `post` is honored (no longer coerced to `shadow`).
export const BLAST_RADIUS_RESOLUTION_READY = true

/** Returns true when OPENCLAW_GRAPH_RETRIEVAL is "shadow" or "post". */
export function graphRetrievalEnabled(env: Env): boolean {
  const v = (env.OPENCLAW_GRAPH_RETRIEVAL ?? "").trim().toLowerCase()
  return v === "shadow" || v === "post"
}

/**
 * SIG-228 Phase 3c: returns true when `OPENCLAW_SYNTH_BYPASS_ENABLED` is
 * `"on"`. Default-off keeps the always-synth legacy behavior in dev/test
 * and in any production environment where the flag was never flipped.
 * Production wrangler.toml ships this `"on"` so the bypass fires for
 * single-specialist no-major reviews (the dispatcher's hot path).
 */
export function isSynthBypassEnabled(env: Env): boolean {
  return (env.OPENCLAW_SYNTH_BYPASS_ENABLED ?? "").trim().toLowerCase() === "on"
}

/**
 * SIG-228 Phase 3c: pure eligibility predicate, extracted so unit tests
 * can pin the gate without spinning up the full ensemble. Returns true
 * iff ALL of:
 *
 *   1. `OPENCLAW_SYNTH_BYPASS_ENABLED === "on"`.
 *   2. The DISPATCHER decided to fan out to exactly 1 specialist
 *      (`dispatchedCount === 1`). The hot path is "router narrowed
 *      to 1 on purpose" — NOT "router fanned out to N, only 1 came
 *      back." The latter is a degraded-coverage run and MUST run
 *      synth so it can render the `[DEGRADED COVERAGE]` block.
 *   3. Exactly 1 candidate verdict came back non-null (sanity-check;
 *      the only way this differs from #2 is if the single dispatched
 *      specialist itself failed, which makes the bypass impossible).
 *   4. None of that candidate's findings have `score >= 4`.
 *
 * Here `score >= 4` is the major/critical SEVERITY threshold (P0/P1) — this is
 * a synth-skip optimization, NOT the posted verdict. The verdict rule
 * (`chooseReviewEventForRenderedFindings` / `isTrivialFinding`) now blocks on
 * ANY substantive finding regardless of severity; the bypass only avoids the
 * synthesizer when a lone specialist has no P0/P1, which never changes the
 * posted event. The orchestrator's inline bypass branch reads the predicate
 * verbatim — keep these in sync.
 */
export function isSynthBypassEligible(
  env: Env,
  dispatchedCount: number,
  candidates: ReadonlyArray<{ verdict: { findings: ReadonlyArray<{ score: number }> } | null }>,
): boolean {
  if (!isSynthBypassEnabled(env)) return false
  if (dispatchedCount !== 1) return false
  if (candidates.length !== 1) return false
  const sole = candidates[0]
  if (!sole || !sole.verdict) return false
  return sole.verdict.findings.every((f) => f.score < 4)
}

/**
 * Returns the effective graph-retrieval mode: "off" | "shadow" | "post".
 *
 * While BLAST_RADIUS_RESOLUTION_READY is false, a raw value of "post" is
 * coerced to "shadow" — blast-radius resolution is inert (SIG-143) and the
 * graph-routed path is not ready for production. A config flip to "post"
 * will take effect only after the constant is flipped true.
 */
export function graphRetrievalMode(env: Env): "off" | "shadow" | "post" {
  const v = (env.OPENCLAW_GRAPH_RETRIEVAL ?? "").trim().toLowerCase()
  const raw = v === "post" ? "post" : v === "shadow" ? "shadow" : "off"
  if (raw === "post" && !BLAST_RADIUS_RESOLUTION_READY) {
    return "shadow"
  }
  return raw
}

// SIG-286: graphExpansionMode moved to ./graph-expansion-mode (a light module
// the metrics route can import without pulling this ensemble). Re-exported here
// so existing importers keep working.
export { graphExpansionMode }

/**
 * Render graph-expansion nodes as the `[GRAPH CONTEXT]` content string.
 * Each line is `<path> (hopN, <edgeKind>)`. Empty array → empty string.
 */
export function formatGraphContext(
  nodes: { path: string; hop: number; edgeKind: string }[],
): string {
  return nodes.map((n) => `${n.path} (hop${n.hop}, ${n.edgeKind})`).join("\n")
}

/**
 * Render blast-radius file paths (callers + import dependents of the changed
 * symbols) as additional `[GRAPH CONTEXT]` lines for folding into the prompt
 * alongside the BFS-neighbor lines (SIG-143). Each line is
 * `<path> (blast, caller|importer)`.
 *
 * Paths in `exclude` (vector-hit seeds + BFS graph nodes) are skipped so the
 * block never repeats context already present, a path that is both a caller
 * and a dependent appears once (caller wins), and the result is capped at
 * `cap` lines for prompt-size safety. Callers are listed before importers;
 * within each group, input order is preserved. Empty input → empty string.
 */
export function formatGraphBlastContext(args: {
  callerPaths: string[]
  dependentPaths: string[]
  exclude: ReadonlySet<string>
  cap: number
}): string {
  const seen = new Set(args.exclude)
  const lines: string[] = []
  const add = (path: string, role: string): void => {
    if (lines.length >= args.cap || seen.has(path)) return
    seen.add(path)
    lines.push(`${path} (blast, ${role})`)
  }
  for (const p of args.callerPaths) add(p, "caller")
  for (const p of args.dependentPaths) add(p, "importer")
  return lines.join("\n")
}

/**
 * Compute overlap statistics between vector-hit seed paths and
 * graph-expanded node paths for the SIG-86 bake-off.
 *
 * - `jaccard`: |intersection| / |union|. 0 when both sets are empty.
 * - `addedCount`: paths in graph that were NOT in vector hits (net-new context).
 */
export function graphOverlapStats(a: {
  vectorPaths: string[]
  graphPaths: string[]
}): { jaccard: number; addedCount: number } {
  const v = new Set(a.vectorPaths)
  const g = new Set(a.graphPaths)
  const inter = [...g].filter((p) => v.has(p)).length
  const union = new Set([...a.vectorPaths, ...a.graphPaths]).size
  return {
    jaccard: union === 0 ? 0 : inter / union,
    addedCount: [...g].filter((p) => !v.has(p)).length,
  }
}

// ──────────────────────────────────────────────────────────────────────────

// SIG-318 (PR 12b): the shadow-bakeoff GRACE primitives (the race sentinels,
// `composeSignals`, the run-failed wrapper + guard, and `raceWithShadowGrace`)
// moved to ./ensemble/domain/shadow-grace — they are pure (Web globals only) and
// the app-layer shadow-settle phase needs them without importing this god-file.
// Value-imported for the orchestrator's own use + re-exported so existing
// importers (the shadow-grace-race test) are unaffected.
import {
  SHADOW_GRACE_EXPIRED,
  SHADOW_RUN_FAILED,
  composeSignals,
  isShadowRunFailed,
  raceWithShadowGrace,
  type ShadowRunFailedOutcome,
} from "./ensemble/domain/shadow-grace"
export {
  SHADOW_GRACE_EXPIRED,
  SHADOW_RUN_FAILED,
  composeSignals,
  isShadowRunFailed,
  raceWithShadowGrace,
}
export type { ShadowRunFailedOutcome }

// SIG-362 (PR 10): the model-call core moved out — the per-role model lineups +
// the retry executor + the specialist/synth runners → ensemble/adapters/
// model-provider; the pure retry knobs (ModelConfig / backoff / maxAttempts) →
// ensemble/domain/model-policy. Re-exported / imported-back here so existing
// importers + the orchestrator below are unchanged.
//
//   - `ModelConfig` was exported here → imported (the synth config-override
//     reads it) AND re-exported from the domain (type).
//   - `SPECIALIST_CONFIGS`/`SYNTHESIZER_CONFIG` were exported here → imported
//     (the orchestrator + finalize telemetry read them) AND re-exported.
//   - `SYNTHESIZER_MODEL`/`SPECIALIST_MODELS`/`CLAIM_EXTRACTOR_CONFIG`/
//     `CLAIM_EXTRACTOR_TIMEOUT_MS` were private here → import-back only.
import type { ModelConfig } from "./ensemble/domain/model-policy"
export type { ModelConfig }
import {
  SPECIALIST_CONFIGS,
  SYNTHESIZER_CONFIG,
  SYNTHESIZER_MODEL,
  SPECIALIST_MODELS,
  CLAIM_EXTRACTOR_CONFIG,
  CLAIM_EXTRACTOR_TIMEOUT_MS,
} from "./ensemble/adapters/model-provider"
export { SPECIALIST_CONFIGS, SYNTHESIZER_CONFIG }

// ─── public types ──────────────────────────────────────────────────────

export interface EnsembleHandlerArgs {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  installationId: number
  env: Env
  /**
   * SIG-318 (PR 5a): the typed, parse-once ensemble settings, produced at the
   * Worker edge (`parseEnsembleConfig(env)` in src/index.ts) and injected here so
   * the handler reads config instead of `env.OPENCLAW_*`. Optional: when omitted
   * (tests / non-edge callers) the handler falls back to parsing `env` itself — a
   * transitional safety net removed when the orchestrator is thinned (PR 12).
   */
  ensembleConfig?: EnsembleConfig
  /**
   * ARC-251: prior stale-head requeue depth, threaded through by the
   * dispatcher from the JobMessage. Undefined = 0. Forwarded to
   * `handleStaleHead` when either ensemble guard fires.
   */
  staleHeadRequeueDepth?: number
  /**
   * SIG-119: the dispatcher's mutable telemetry sink. Each evidence-gate
   * callback (security/tests/logic/perf `on*FindingDropped`) pushes a
   * {gate, reason, dropped} event here; the dispatcher flushes it once to
   * ValidationMetricsDO after the review. Optional so non-dispatcher callers
   * (tests) can omit it.
   */
  validationSink?: ValidationRejectionEvent[]
  /**
   * SIG-152: dispatcher's single-sample sink for the per-review
   * `pr-review-graph-retrieval` telemetry. The graph block pushes one sample
   * (0 elements if graph retrieval is off / errored); flushed to
   * GraphMetricsDO in the dispatcher's finally. Optional for non-dispatcher
   * callers (tests).
   */
  graphMetricsSink?: GraphRetrievalSample[]
  /**
   * SIG-286 PR2.5: the graph-context-expansion block pushes one
   * `graph-expansion-shadow` sample here (0 elements if expansion is off /
   * errored); flushed to GraphExpansionMetricsDO in the dispatcher's finally so
   * the CONTROL-vs-TREATMENT netNewTokens median is readable at
   * GET /metrics/graph-expansion. Optional for non-dispatcher callers (tests).
   */
  graphExpansionMetricsSink?: GraphExpansionSample[]
  /**
   * SIG-247 Phase 1: GitHub's immutable `repo.id`, threaded from
   * the webhook payload via JobMessage → baseArgs → here. Passed
   * to `runReviewMemoryLookup` so it reads BOTH the legacy and
   * repo-id keyspaces with read-union semantics. Absent on legacy
   * queue messages and slash-command raw-sends pre-SIG-247 Phase 1;
   * the lookup falls back to legacy-only reads.
   */
  repoId?: number
}

export interface SubmissionAffordance {
  reviewCounter?: number
  retriggerUrl?: string
  persistReviewCounter: () => Promise<void>
}

function withSubmissionAffordance<T extends object>(
  value: T,
  affordance: SubmissionAffordance,
): T & { reviewCounter?: number; retriggerUrl?: string } {
  return {
    ...value,
    ...(affordance.reviewCounter !== undefined ? { reviewCounter: affordance.reviewCounter } : {}),
    ...(affordance.retriggerUrl !== undefined ? { retriggerUrl: affordance.retriggerUrl } : {}),
  }
}

export interface SuggestionEmissionLogContext {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  commentsSubmitted: boolean
}

export interface SuggestionEmissionLogEvent {
  event: "pr-review-suggestion-emitted"
  owner: string
  repo: string
  prNumber: number
  headSha: string
  path: string
  line: number
  startLine?: number
}

export function buildSuggestionEmissionLogEvents(
  context: SuggestionEmissionLogContext,
  suggestions: readonly ReviewSuggestionEmission[],
): SuggestionEmissionLogEvent[] {
  if (!context.commentsSubmitted) return []
  return suggestions.map((suggestion) => ({
    event: "pr-review-suggestion-emitted",
    owner: context.owner,
    repo: context.repo,
    prNumber: context.prNumber,
    headSha: context.headSha.slice(0, 7),
    path: suggestion.path,
    line: suggestion.line,
    ...(suggestion.startLine !== undefined ? { startLine: suggestion.startLine } : {}),
  }))
}

export async function prepareSubmissionAffordance(args: {
  env: Env
  owner: string
  repo: string
  prNumber: number
  event: ReviewEvent
}): Promise<SubmissionAffordance> {
  if (args.event !== "REQUEST_CHANGES") {
    return { persistReviewCounter: async () => undefined }
  }
  const counter = await preparePrReviewCounter(args.env, args.owner, args.repo, args.prNumber)
  return {
    reviewCounter: counter.value,
    retriggerUrl: buildPrUrl(args.owner, args.repo, args.prNumber),
    persistReviewCounter: counter.persist,
  }
}

// ARC-280: `routeReview` + `RouteDecision` + the shadow/post/off
// mode-routing layer were deleted. The dispatcher now performs an
// inline sensitive-repo skip check and otherwise calls
// `handlePrReviewEnsemble` directly. Daily-budget exhaustion is
// handled inside the ensemble itself (an early `skipped` return
// with `fellBackReason: "daily_budget_exhausted"` once it lands).

// SIG-361 (PR 9): `resolveReviewEventOverride` moved to the verdict domain
// (imported + re-exported above).

/**
 * Build the `[AST RULE FINDINGS]` synth-prompt block (pure, exported for test).
 * ARC-181 + SIG-245: the SUPERSEDE-and-drop instruction (drop a specialist
 * finding that matches an AST entry on (path,line,role_hint)) is only safe when the
 * AST version will actually be POSTED — i.e. when `astRules.autoInline` is ON.
 * With autoInline OFF (the DEFAULT) the AST findings are never posted anywhere,
 * so telling the synth to drop the matching specialist finding silently loses a
 * real issue that BOTH engines caught. Verified in prod telemetry (e2e-backend
 * PR#1): the security specialist EMITTED shell-injection + disabled-TLS findings
 * on src/services/exec.ts, the synth dropped them as `superseded_by_ast/*`, and
 * the AST version was never re-injected — 2 real P0/P1 bugs vanished. So when
 * autoInline is OFF, the synth must KEEP its matching findings and use the AST
 * entries only for confidence + Fix-Plan ordering. Genuine cross-specialist
 * duplicates are still merged via the synth's separate `duplicate` drop reason.
 */
export function buildAstFindingsSynthBlock(astFindingsJson: string, autoInline: boolean): string {
  if (astFindingsJson.length === 0) return ""
  // SIG-309 PR2 note: the emit rule's "already covered" test uses (path, line)
  // — deliberately BROADER than the confirmation rule's (path, line, role_hint).
  // A same-line specialist finding of ANY role almost certainly concerns the
  // same security sink, so the broader key biases toward "already covered" →
  // suppress the synth emit. That's the FP-safe direction (fewer emits, never
  // a double-post), at a marginal recall cost on the rare cross-role same-line case.
  const instruction = autoInline
    ? `Match these against specialist findings on \`(path, line, role_hint)\` triple. When a specialist finding shares ALL THREE with an AST entry, drop it from your output and include \`{ specialist, sourceFindingId, headline, reason: "superseded_by_ast/<id>" }\` in \`provenance.dropped[]\`. Cross-role matches (e.g. AST=security vs specialist=performance) do NOT supersede.`
    : `These are deterministic confirmations. When a specialist finding matches an AST entry on \`(path, line, role_hint)\`, KEEP the specialist finding (the AST version is NOT posted separately) and treat the match as raised confidence. Do NOT drop AST-matched findings as superseded. Use the AST entries to order the Fix Plan — deterministically-confirmed issues outrank speculative ones. (Genuine cross-specialist duplicate findings are still merged via the \`duplicate\` drop reason.)\n\nSIG-309/310: an AST entry with \`"deterministic_emit": true\` is a high-confidence finding the scanner PROVED is present — a security sink (command/shell injection, disabled TLS) or a contract-drift type smell. EMIT a finding for it yourself in the entry's \`role_hint\` category, using the entry's \`message\` and a concrete fix — UNLESS a specialist finding already covers it: for a \`role_hint:"security"\` entry, "covers it" = any finding at the same \`(path, line)\`; for any OTHER role (e.g. \`logic\`), "covers it" = a finding at the same \`(path, line, role_hint)\` (a different-role finding on the same line must NOT suppress it). Do NOT omit an uncovered entry just because no specialist raised it; that is exactly the case this flag exists for. SEVERITY by the entry's \`severity\` field: an \`error\` entry is a PROVEN-dangerous sink — score it on its merits (typically P0/P1 for security). A \`warning\` entry is an ADVISORY the scanner surfaced but can't fully prove (a dynamic HTML sink whose value might be a trusted constant; a \`role_hint:"logic"\` type-design smell) — emit it at score 2-3 (P2/P3), anchored at the entry's path+line, NEVER as a P0/P1 blocker, whatever its \`role_hint\`. (If your own specialist independently judges a \`warning\` security advisory to be a real P0/P1, that specialist finding 'covers' the entry per the rule above and stands on its merits — the P2 ceiling applies only to the deterministic advisory.) (Entries WITHOUT \`deterministic_emit\` stay confirmation/ordering only, per above. A \`deterministic_emit\` entry that a specialist DID match is still just a confirmation — keep the specialist finding, don't double-post.)`
  return `\n\n[AST RULE FINDINGS — pre-LLM, structured]\n\n${instruction}\n\n\`\`\`json\n${astFindingsJson}\n\`\`\``
}

/**
 * Shadow-first gate for a deterministic AST security floor. In `post` mode the
 * rule's findings flow through untouched; in any other mode (`off`/`shadow`) they
 * are STRIPPED from the submission (and their `perFinding` provenance dropped),
 * and the stripped anchors are returned so the caller can emit a `shadow`
 * measurement log. Extracted so the off/shadow/post contract is unit-testable
 * (a regression that drops `post` findings or mis-strips is caught). Mirrors the
 * inline IDOR / weak-random / open-redirect / SSRF gates.
 */
export function applyAstScanGate<
  F extends { ruleId: string; astFindingId: string; path: string; line: number },
>(
  astResult: { findings: F[]; perFinding: { delete(key: string): void } },
  ruleId: string,
  mode: string,
): Array<{ path: string; line: number }> {
  if (mode === "post") return []
  const emits = astResult.findings.filter((f) => f.ruleId === ruleId)
  if (emits.length === 0) return []
  astResult.findings = astResult.findings.filter((f) => f.ruleId !== ruleId)
  for (const f of emits) astResult.perFinding.delete(f.astFindingId)
  return emits.map((f) => ({ path: f.path, line: f.line }))
}

// ─── orchestrator ──────────────────────────────────────────────────────

/**
 * SIG-318 (PR 5a): resolve the typed ensemble config. The Worker edge
 * (src/index.ts) parses it once via `parseEnsembleConfig(env)` and injects it as
 * `args.ensembleConfig`; callers that omit it (tests / non-edge paths) fall back to
 * parsing `env` here. The fallback is transitional and is removed when the
 * orchestrator is thinned (PR 12). Exported so the inject-vs-parse contract is
 * unit-tested directly.
 */
export function resolveEnsembleConfig(
  args: Pick<EnsembleHandlerArgs, "env" | "ensembleConfig">,
): EnsembleConfig {
  return args.ensembleConfig ?? parseEnsembleConfig(args.env)
}

export async function handlePrReviewEnsemble(
  args: EnsembleHandlerArgs,
): Promise<EnsembleResult> {
  // ARC-280: `mode` parameter removed. The pre-ARC-275 dual-mode
  // routing (shadow vs post) is gone; this handler is the only
  // production review path. The `EnsembleTelemetry.mode` field is
  // pinned to `"post"` for back-compat with downstream analytics
  // queries that may filter on it.
  const mode = "post" as const
  const { owner, repo, prNumber, headSha, installationId, env } = args
  // SIG-318 (PR 5a): typed config parsed once at the Worker edge and injected via
  // args (fallback parses env for non-edge callers — transitional, see PR 12).
  const ensembleConfig = resolveEnsembleConfig(args)
  const staleHeadRequeueDepth = args.staleHeadRequeueDepth ?? 0
  const startMs = Date.now()
  const orchCtrl = new AbortController()
  const orchTimer = setTimeout(() => orchCtrl.abort(), ORCHESTRATOR_TIMEOUT_MS)
  // ARC-284: correlation fields for the perf-telemetry events emitted
  // throughout this handler. headSha is truncated at log time inside
  // the helper. Stamped here once so every emit gets the same shape.
  const perfCtx: EnsembleRunCtx = { owner, repo, prNumber, headSha }
  // SIG-149: per-review token accumulator. Shared by reference with
  // `telemetry.tokenUsageByModel` below — the recorder mutates this
  // object in place from every settled model attempt, so by the time
  // `finalize()` reads `telemetry.tokenUsageByModel` it holds the full
  // review's spend without any further plumbing.
  const tokenUsageByModel: TokenUsageByModel = {}
  perfCtx.recordTokens = makeTokenRecorder(tokenUsageByModel)

  // Lifted out of the try block so the finally cleanup can read cache
  // stats into telemetry on every exit path (success, failure, throw).
  let cache: ReturnType<typeof createRetrievalCache> | null = null

  // SIG-184: runner-evidence trust state for the check-run badge, set once the
  // receipt is consulted (the SARIF-evidence section, below) and read by every
  // POSTED finalize() so the summary can render the VERIFIED/PENDING pill.
  // Function-scoped (like `cache`) so it crosses the inner try-block boundaries.
  // `undefined` = `runner-absent` = no badge (the default, flag-off path).
  let runnerEvidenceBadge: "verified" | "evidence-pending" | undefined = undefined
  let deterministicCheckAnnotations: CheckRunAnnotation[] | undefined
  const deterministicCheckAnnotationMeta = () =>
    deterministicCheckAnnotations !== undefined && deterministicCheckAnnotations.length > 0
      ? { deterministicCheckAnnotations: [...deterministicCheckAnnotations] }
      : {}
  const deterministicErroredReviewMeta = (): ReviewMeta | undefined =>
    deterministicCheckAnnotations !== undefined && deterministicCheckAnnotations.length > 0
      ? {
          // Generic `errored` check-run rendering ignores `event` and
          // `findingsCount`; ReviewMeta requires them only for success titles.
          // These placeholders carry Lane A annotations through post-SARIF
          // failure paths without pretending a model review was posted.
          event: "REQUEST_CHANGES",
          findingsCount: 0,
          deterministicCheckAnnotations: [...deterministicCheckAnnotations],
        }
      : undefined

  // ARC-258: the in-progress check run is owned by `dispatchJob`,
  // not by this orchestrator. Reason: when ensemble-post fails
  // non-stale-head and the dispatcher falls back to Phase 3, the
  // ensemble can't know whether to complete the check (a `failure`
  // here would contradict a successful Phase 3 review). Lifecycle
  // owned at the dispatcher level → single source of truth for the
  // final outcome.

  // ARC-283 Phase B1b — shadow-mode bake-off state. Lifted out of
  // the try block so the `finally` cleanup can settle every shadow
  // promise + emit comparison telemetry regardless of which return
  // path the prod orchestrator took (success, bail-with-skip-notice,
  // outer-catch). When `SHADOW_BAKEOFF_ROLES` is unset/empty the
  // maps stay empty, the synth promise stays null, and the finally
  // block runs a zero-cost no-op.
  //
  // Snapshots are written as soon as the corresponding prod outcome
  // settles — by the time `finally` runs, each entry is either:
  //   - present (prod settled → shadow comparison can fire)
  //   - absent (prod errored before settle → shadow still emits with
  //     a synthetic "prod did not run" prod outcome)
  // The shadow promise itself never throws — `runShadowSpecialist` /
  // `runShadowSynth` catch + return structured failure on every path.
  //
  // SIG-318 (PR 12b): the four loose containers (`specialistPromises`,
  // `prodSnapshots`, `abortControllers`, `synthPromise`) are bundled into one
  // `ShadowBakeoffState` holder threaded by reference into `settleShadowBakeoff`.
  // `abortControllers` (ARC-283 Phase B1b CR-2): per-shadow AbortController so the
  // finally block can `.abort(reason)` any shadow request that didn't settle
  // before the grace deadline / orch tear-down (pre-CR-2 we emitted
  // `shadow-cut-short` but left the in-flight HTTP request alive, silently
  // doubling provider rate-limit pressure past the cut). Keyed by the role the
  // controller belongs to; `"synth"` is the single shadow synth controller. Map
  // cleared as each entry settles so the finally loop only sees still-pending
  // shadows.
  const shadowState: ShadowBakeoffState = {
    specialistPromises: new Map<SpecialistRole, Promise<ShadowRunResult>>(),
    prodSnapshots: new Map<SpecialistRole, ProdSpecialistSnapshot>(),
    abortControllers: new Map<SpecialistRole | "synth", AbortController>(),
    synthPromise: null,
  }

  // Telemetry skeleton — populated as we go so we can write a record
  // even on early failure paths.
  const telemetry: EnsembleTelemetry = {
    schemaVersion: 3,
    owner,
    repo,
    prNumber,
    headSha,
    mode,
    fellBackToPhase3: false,
    routerDecision: null,
    specialistVerdicts: [],
    synthesizer: null,
    postValidation: { droppedForInvalidLine: 0, remappedInvalidLineToInline: 0, droppedForHallucination: 0, demotedScore1: 0, droppedForVaguePrefix: 0, droppedForUncitedTestingEvidence: 0, droppedForFailedValidation: 0, droppedForFailedTestValidation: 0, droppedForFailedLogicValidation: 0, droppedForFailedLogicRefutation: 0, droppedForFailedLogicClaimRefutation: 0, droppedForFailedRefutationSurvival: 0, droppedForFailedPerfValidation: 0, droppedForFailedInlineGroundingValidation: 0, droppedForFailedAbsenceGroundingValidation: 0, droppedForFailedWindowBlindnessValidation: 0, droppedForFailedSecurityGroundingValidation: 0, droppedForFailedSecurityUsageValidation: 0 },
    retrievalCacheStats: null,
    tokenUsageByModel,
    startMs,
    totalMs: 0,
  }

  try {
    const client = await buildClient(env, installationId)

    // ARC-280 follow-up: bail with a customer-visible skip-notice
    // comment + an `errored` result. Used by the silent-skip paths
    // that used to fall through to Phase 3 (router_no_specialists,
    // specialists_all_failed, synth retry exhausted). The
    // dispatcher already maps `errored` to a `failure` Check Run;
    // the reviewMeta.surface signal flips the title to "Couldn't
    // review — see PR comment."
    //
    // CR Major / Sigilix Logic catch on PR #92: gate the
    // `surface: "skip-notice"` reviewMeta on the post actually
    // succeeding. If `postReviewSkipNotice` returned !ok (or
    // dedupe-hit'd with no comment), we have no comment to point
    // the user at — the Check Run should render the generic
    // "Review failed" title instead of the misleading
    // "Couldn't review — see PR comment" one.
    const bailWithSkipNotice = async (
      reason: SkipNoticeReason,
      opts?: { dispatchedRoles?: readonly string[] },
    ): Promise<EnsembleResult> => {
      const out = await postReviewSkipNotice({
        env, client, owner, repo, prNumber, headSha, reason,
        ...(opts?.dispatchedRoles !== undefined ? { dispatchedRoles: opts.dispatchedRoles } : {}),
      })
      // `ok && reason === "posted"` → a fresh comment is on the PR.
      // `ok && reason === "dedupe-hit"` → a prior run already
      //   posted one for this head; safe to claim "see PR comment".
      // `!ok` → no comment; don't lie to the customer.
      if (out.ok) {
        return finalize(telemetry, env, "errored", cache, {
          event: "REQUEST_CHANGES",
          findingsCount: 0,
          surface: "skip-notice",
          ...deterministicCheckAnnotationMeta(),
        })
      }
      return finalize(telemetry, env, "errored", cache, deterministicErroredReviewMeta())
    }

    // ─── Stale-head guard #1 ───────────────────────────────────
    const meta = await client.getPullRequest(owner, repo, prNumber)
    if (meta.head?.sha && meta.head.sha !== headSha) {
      // CodeRabbit catch (phase-end): do NOT set `fellBackToPhase3` —
      // the dispatcher short-circuits Phase 3 on `stale_head`, so this
      // path doesn't actually fall back. Leaving it true would
      // overcount Phase 3 saves and blur stale-head telemetry.
      telemetry.fellBackReason = "stale_head_before_fanout"
      // ARC-250: hand off to the helper for structured telemetry + a
      // user-visible sticky comment. ARC-251: helper auto-requeues
      // against the live SHA when depth < cap; falls through to the
      // sticky on exhaustion. Either way we return `stale_head` so
      // the dispatcher does NOT fall through to Phase 3 (which would
      // also stale-head and post a duplicate sticky / second requeue).
      await handleStaleHead({
        env, owner, repo, prNumber, installationId,
        queuedHeadSha: headSha,
        currentHeadSha: meta.head.sha,
        baseSha: meta.base?.sha ?? null,
        depth: staleHeadRequeueDepth,
        source: "ensemble-before-fanout",
        ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
      })
      return finalize(telemetry, env, "stale_head", cache)
    }

    // ─── SIG-88: pre-fanout merged-on-approve short-circuit ────
    //
    // When the PR is already merged at fan-out time (e.g. the webhook
    // was queued after a long delay and the human merged in the
    // meantime), short-circuit to a marker-only APPROVE. CodeRabbit's
    // behavior: GitHub's native "approved these changes" one-liner
    // stands in for a review on already-merged code instead of running
    // the full ensemble + posting REQUEST_CHANGES on a merged PR.
    //
    // We reuse the `meta.merged_at` value we already fetched for the
    // stale-head guard above — no extra GET round-trip. The pre-submit
    // guard further down (post-synth) still calls `checkIsPrMerged`
    // because by then the cached `meta` is ~30-60s old and the merge
    // may have happened during fan-out.
    if (meta.merged_at !== null && meta.merged_at !== undefined) {
      const mergedAtMs = new Date(meta.merged_at).getTime()
      telemetry.fellBackReason = "merged_before_fanout"
      const out = await submitMergedOnApprove({
        client, owner, repo, prNumber, headSha,
        stage: "pre-fanout",
        mergedAtMs,
        startMs,
      })
      if (out.ok) {
        // CR PR #104 Major catch: mirror the standard ensemble flow's
        // post-submit verification so a silently-rejected merged-on-
        // approve POST gets the same diagnostic surface (`pr-review-
        // verify-missing` / `-pending` / `-error` telemetry) as the
        // primary path. The verify is best-effort — on inconclusive
        // results we still claim `posted` (matches the standard
        // path's semantics on capped/error returns).
        await verifyReviewPersisted(
          client, owner, repo, prNumber, out.reviewId,
          "merged-on-approve-pre-fanout", out.state,
        )
        return finalize(telemetry, env, "posted", cache, {
          event: "APPROVE",
          findingsCount: 0,
          ...deterministicCheckAnnotationMeta(),
        })
      }
      // Submit failed — fall through to `errored` without a surface
      // (we have no comment to point the customer at, and the PR is
      // already merged so a skip-notice is pointless).
      return finalize(telemetry, env, "errored", cache, deterministicErroredReviewMeta())
      // SIG-89 note: this merged-on-approve short-circuit intentionally
      // does NOT write a noop-merge diff hash. `fullPrDiff` isn't
      // fetched on this path (the diff fetch lives below at the start
      // of the normal pipeline), and the PR is already merged — no
      // future `synchronize` webhook is expected, so there's nothing
      // a noop-merge skip would help with anyway.
    }

    // ARC-182: fetch open PRs in parallel with the full PR diff. Stack
    // detection needs the open-PR list to find downstack/upstack peers;
    // running the fetch here (after the stale-head guard, in parallel
    // with the diff) avoids an extra serial round-trip. Best-effort
    // with `.catch` → empty list = no-stack review (degraded but
    // correct).
    const [fullPrDiff, openPrsForStack] = await Promise.all([
      client.getPullRequestDiff(owner, repo, prNumber),
      client.listOpenPullRequests(owner, repo).catch((err) => {
        console.warn(
          JSON.stringify({
            event: "pr-stack-open-prs-fetch-failed",
            owner, repo, prNumber,
            error: err instanceof Error ? err.message : String(err),
          }),
        )
        return [] as ListOpenPullsItem[]
      }),
    ])

    // ARC-194 / SIG-10: read prior-review marker for telemetry only.
    // The diff fed to specialists + synth is always the cumulative
    // full PR diff (PR.base.sha..headSha) — SIG-10 removed the
    // incremental compare-diff path because on multi-commit PRs the
    // push-delta diff produced false-positive "undefined export"-class
    // findings against symbols introduced in an earlier commit. See
    // `selectDiff` in incremental-review.ts for the full rationale.
    // The compareDiff fetch is gone too: its result is no longer
    // consumed, so spending the round-trip would be pure waste.
    const lastReviewed = await readLastReviewedSha(env, owner, repo, prNumber)
    const diffSelection = selectDiff({
      fullDiff: fullPrDiff,
      compareDiff: null,
      previousSha: lastReviewed?.reviewedSha ?? null,
      currentHeadSha: headSha,
    })
    telemetry.incrementalReview = {
      mode: diffSelection.mode,
      ...(diffSelection.previousSha ? { previousSha: diffSelection.previousSha } : {}),
      ...(diffSelection.reason ? { reason: diffSelection.reason } : {}),
    }
    const fullDiff = diffSelection.diff

    // ARC-174: per-repo `sigilix.json` config. Read at the PR head SHA
    // so the guidance reflects whatever the PR author committed (lets
    // them iterate on the rules in the same PR). Always resolves —
    // missing or malformed config falls back to EMPTY_CONFIG. Loaded
    // BEFORE the diff split so ARC-176 pathFilters can drop files
    // before packing decides what to send to specialists.
    let sigilixConfig = await loadSigilixConfig(client, owner, repo, headSha)
    const shouldLoadAiInstructions = shouldIngestAiInstructions(
      sigilixConfig.guidance,
      ensembleConfig.flags.ingestAiInstructions,
    )

    // ARC-273: label gate. When the operator configures
    // `costControls.runOnLabels`, pr-review only fires on PRs
    // carrying at least one of those labels. Empty config = no
    // gating (current behavior). Returns `skipped` so the
    // dispatcher-owned Check Run completes as `neutral` rather
    // than misclassifying as a failed review.
    const costControls = resolveCostControlsConfig(sigilixConfig)
    if (costControls.runOnLabels.length > 0) {
      const labelNames = (meta.labels ?? [])
        .map((l) => l.name)
        .filter((n): n is string => typeof n === "string")
      if (!passesLabelGate(labelNames, costControls.runOnLabels)) {
        console.log(JSON.stringify({
          event: "pr-review-skipped",
          reason: "label-gate",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          pr_labels: labelNames,
          run_on_labels: [...costControls.runOnLabels],
        }))
        telemetry.fellBackReason = "label_gate_skip"
        // SIG-224 Phase 0 follow-along: thread `reviewMeta` so the
        // Check Run renders "Approved — no issues found · Sigilix
        // approved · [View PR]" instead of falling through to the
        // legacy "Review posted · [View review]" title that links to
        // a nonexistent review. Same shape as the empty-router branch
        // below — both are "we successfully reviewed and chose not to
        // run specialists." The customer-visible effect: green check,
        // honest "View PR" link, no broken review URL.
        return finalize(telemetry, env, "skipped", cache, {
          event: "APPROVE",
          findingsCount: 0,
        })
      }
    }

    // ARC-192 + ARC-176: hunk-level diff packing with config-aware
    // filtering. Split the diff by file, drop files matched by
    // `sigilixConfig.pathFilters` (lockfiles, generated content, etc.
    // that shouldn't burn token budget), pack the remainder greedily
    // into batches under the per-call token cap. v1 reviews only the
    // FIRST batch; files in subsequent batches are recorded in
    // telemetry as `filesNotReviewed`. Files larger than the cap
    // individually are dropped via `filesDroppedTooLarge`. Multi-batch
    // with parallel specialist calls + verdict merge is the v2
    // enhancement; v1 ships the bound + telemetry.
    const splitFiles = splitDiffByFile(fullDiff)
    // Lane D: when the repo configured NO explicit sigilix.json guidance, fall
    // back to its own AI-instruction files as ADVISORY review guidance — parity
    // with CodeRabbit/Greptile-style context ingestion, without requiring a
    // sigilix.json. sigilix.json always takes precedence
    // (`shouldLoadAiInstructions`). GitHub `.github/instructions/**` files may
    // carry `applyTo:` path scopes, so binding happens against the full selected
    // diff's changed-file set (not the post-packing reviewed batch) for stable
    // per-PR semantics.
    if (shouldLoadAiInstructions) {
      const aiInstructions = await loadAiInstructions(client, owner, repo, headSha)
      const applicableAiInstructions = aiInstructions
        ? filterAiInstructionsForChangedPaths(aiInstructions, splitFiles.map((f) => f.path))
        : null
      if (applicableAiInstructions) {
        sigilixConfig = {
          ...sigilixConfig,
          guidance: buildAiInstructionGuidance(applicableAiInstructions),
        }
        console.log(JSON.stringify({
          event: "pr-review-ai-instructions-ingested",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          source_count: applicableAiInstructions.chunks.length,
          sources: applicableAiInstructions.chunks.map((chunk) => chunk.source),
          scoped_source_count: applicableAiInstructions.chunks.filter((chunk) =>
            chunk.applyTo !== undefined && chunk.applyTo.length > 0
          ).length,
        }))
      }
    }
    const filterPatterns = sigilixConfig.pathFilters ?? []
    const filesAfterFilter = filterPatterns.length === 0
      ? splitFiles
      : splitFiles.filter((f) => shouldReview(f.path, filterPatterns))
    const filesDroppedByFilter = filterPatterns.length === 0
      ? []
      : splitFiles.filter((f) => !shouldReview(f.path, filterPatterns)).map((f) => f.path)
    const { batches, droppedTooLarge } = packFilesIntoBatches(filesAfterFilter)
    const reviewedFiles = batches[0] ?? []
    const filesNotReviewed: string[] = batches.slice(1).flatMap((b) => b.map((f) => f.path))
    const baseDiff = reviewedFiles.length === splitFiles.length && droppedTooLarge.length === 0
      ? fullDiff
      : batchToDiff(reviewedFiles)
    const matchedPathInstructions = resolvePathInstructionsForChangedPaths(
      sigilixConfig,
      reviewedFiles.map((f) => f.path),
    )
    if (matchedPathInstructions.length > 0) {
      console.log(JSON.stringify({
        event: "pr-review-path-instructions-matched",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        instruction_count: matchedPathInstructions.length,
        matched_file_count: new Set(matchedPathInstructions.flatMap((i) => i.matchedPaths)).size,
      }))
    }
    // SIG-172: load the per-repo scoped-rules manifest (SIGILIX.md +
    // .sigilix/rules/*.md, persisted at index time) and pick the
    // rules that apply to this PR's changed files. Closest-ancestor
    // walk + glob matching. Cached compiled matchers are reused
    // across roles in this run (one matcher build per PR, not per
    // changed file).
    const scopedRulesManifest = await loadCompiledScopedRulesManifest(env, owner, repo)
    const scopedRuleSelection = resolveScopedRulesForChangedPaths(
      scopedRulesManifest,
      reviewedFiles.map((f) => f.path),
    )
    const scopedRulesBlock = renderScopedRulesForPrompt(scopedRuleSelection)
    if (scopedRulesBlock.length > 0) {
      console.log(JSON.stringify({
        event: "pr-review-scoped-rules-matched",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        per_directory_rules: scopedRuleSelection.perDirectoryRules.length,
        glob_rules: scopedRuleSelection.globRules.length,
      }))
    }
    // ARC-273: hard cap on the diff string passed to specialists.
    // `packFilesIntoBatches` already bounds total-file budget; this
    // is a belt-and-suspenders char-level cap for pathological cases
    // (one enormous file, or operator-narrowed budget). Truncates
    // from the END so the diff header + leading hunks survive. A
    // trailing sentinel notes the truncation so the model knows it
    // didn't see everything.
    //
    // code-reviewer M1 catch: `slice(0, negative)` would silently
    // produce an empty string if the operator set `maxPatchLength`
    // below the sentinel length. `MAX_PATCH_LENGTH_MIN = 1_000`
    // makes that impossible today, but the relationship is implicit
    // — `Math.max(0, …)` codifies the invariant defensively.
    const PATCH_TRUNCATION_NOTE = "\n\n[…diff truncated to costControls.maxPatchLength…]"
    const wasTruncated = baseDiff.length > costControls.maxPatchLength
    const diff = wasTruncated
      ? baseDiff.slice(0, Math.max(0, costControls.maxPatchLength - PATCH_TRUNCATION_NOTE.length)) +
        PATCH_TRUNCATION_NOTE
      : baseDiff
    if (wasTruncated) {
      console.log(JSON.stringify({
        event: "pr-review-diff-truncated",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        original_chars: baseDiff.length,
        max_patch_length: costControls.maxPatchLength,
        final_chars: diff.length,
      }))
    }

    telemetry.diffPacking = {
      diffTokensEstimated: estimateTokens(fullDiff),
      totalFiles: splitFiles.length,
      batchCount: batches.length,
      filesReviewed: reviewedFiles.map((f) => f.path),
      filesDroppedTooLarge: droppedTooLarge,
      filesNotReviewed,
      ...(filesDroppedByFilter.length > 0 ? { filesDroppedByFilter } : {}),
      // ARC-273 (code-reviewer M2 catch): when the char-level cap
      // truncated the post-packing diff, surface the post-truncation
      // size so operators can correlate "diff packing said X files
      // reviewed" with "model actually saw Y chars."
      ...(wasTruncated ? { diffTruncatedToChars: diff.length } : {}),
    }

    const reviewable = parseDiffToReviewablePositions(diff)
    const filePaths = [...reviewable.keys()]

    // ARC-193: deterministic regex checks run BEFORE specialist fanout.
    // Hits become structured findings prepended to specialist prompts
    // as authoritative facts (LLM still weighs context). Cheap +
    // deterministic — closes the well-known LLM miss-rate gap on flat
    // patterns (TODO markers, console.log, hardcoded API-key shapes).
    const deterministicRunResult = runDeterministicChecks(
      diff,
      sigilixConfig.deterministicChecks ?? [],
    )
    const deterministicHits: DeterministicCheckHit[] = deterministicRunResult.hits
    if (deterministicHits.length > 0 || deterministicRunResult.compiledRegexFailures.length > 0) {
      telemetry.deterministicChecks = {
        hits: deterministicHits,
        compiledRegexFailures: deterministicRunResult.compiledRegexFailures,
      }
    }

    // ARC-187: secret scan. Built-in baseline rule set (AWS, GitHub,
    // Slack, Stripe, OpenAI, Anthropic keys + private-key PEM headers
    // + a generic high-entropy safety net). Hits are redacted before
    // anything reaches logs / prompts / telemetry — raw secrets never
    // leave the runner. Always-on; no config knob in v1 because secret
    // detection is baseline behavior, not opt-in.
    const secretHits: SecretHit[] = runSecretScan(diff)
    if (secretHits.length > 0) {
      telemetry.secretScan = {
        hitCount: secretHits.length,
        // Telemetry stores fingerprints (path:line:redacted) — never
        // the raw values. Lets post-hoc analysis dedupe across runs
        // without exposing the secret to KV reads.
        fingerprints: secretHits.map((h) => h.fingerprint),
      }
    }

    // ─── Router decision ───────────────────────────────────────
    const totalLinesChanged = countLines(diff)
    // CR PR #35 catch: pass diffText so the router can content-aware
    // check markdown fenced code blocks before taking the docs-only
    // shortcut.
    let router = decideSpecialists({ paths: filePaths, totalLinesChanged, diffText: diff }, env)
    telemetry.routerDecision = router

    // ─── SIG-226 / SIG-224 Phase 1 — dispatcher (shadow + enforce_rules) ─
    // Default mode = "off" → the whole block is a no-op (single env
    // string compare).
    //
    // Modes:
    //   "shadow"        — dispatcher computes picks + LLM call, but the
    //                     legacy router still drives fan-out. Pure data
    //                     collection for SIG-227b / SIG-228 graduation.
    //   "enforce_rules" — SIG-227a. Dispatcher runs the RULE LAYER only
    //                     (no LLM call, 0s overhead) and its picks
    //                     REPLACE `router.specialists` for fan-out.
    //                     Activates the new safe-skip rules
    //                     (lockfile-only, .d.ts-only, test-files-only)
    //                     that the legacy router doesn't have.
    //   "enforce"       — Phase 2/3 (SIG-227b / SIG-228). Dispatcher
    //                     runs rules + LLM and the picks drive fan-out.
    //                     Logged but not yet honored in Phase 1 / 227a.
    //
    // Dispatcher is wrapped in try/catch so a defense-in-depth throw
    // can't poison the legacy review pipeline (CR M3 fix from PR #183).
    const dispatcherMode = ensembleConfig.flags.dynamicDispatcherMode
    if (
      dispatcherMode === "shadow"
      || dispatcherMode === "enforce"
      || dispatcherMode === "enforce_rules"
    ) {
      try {
        const dispatcherClassified = classifyDiffFiles(filePaths)
        const dispatcherCommitMessage = `${meta.title}\n\n${meta.body ?? ""}`
        const dispatcherDecision = await decideSpecialistsDynamic({
          signals: { paths: filePaths, totalLinesChanged, diffText: diff },
          classified: dispatcherClassified,
          commitMessage: dispatcherCommitMessage,
          // SIG-230: thread separated title/body through so the LLM
          // prompt sees them inside the `<pr_metadata>` envelope. The
          // sanitizer + envelope are the two-layer defense against
          // prompt-injection in PR titles/bodies.
          prTitle: meta.title,
          prBody: meta.body ?? "",
          repoConfig: sigilixConfig,
          env,
          signal: orchCtrl.signal,
        })
        telemetry.dispatcherDecision = dispatcherDecision
        console.log(JSON.stringify({
          event: "dispatcher-shadow-decision",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          mode: dispatcherMode,
          routerSpecialists: router.specialists,
          dispatcherSpecialists: dispatcherDecision.specialists,
          perRole: dispatcherDecision.perRole,
          layerVotes: dispatcherDecision.layerVotes,
          reasoning: dispatcherDecision.reasoning,
          elapsedMs: dispatcherDecision.elapsedMs,
        }))
        if (dispatcherMode === "enforce_rules") {
          // SIG-227a: rules-only enforcement. Replace the legacy
          // router's picks with the dispatcher's.
          //
          // Safe-skip COVERAGE is a strict superset: the dispatcher
          // adds lockfile-only, .d.ts-only, and test-files-only on
          // top of the legacy router's docs-only-no-fences and CSS-
          // only. So for PRs that hit a safe-skip case, the dispatcher
          // matches OR shrinks the fan-out vs the legacy router.
          //
          // END-TO-END behavior on shape+force collisions differs.
          // Example: a docs-only PR that ALSO touches an auth path
          // (e.g. `auth-spec.md`). Legacy router: `forced.size > 0`
          // → docs shortcut is SKIPPED → all 4 specialists run.
          // Dispatcher: docs safe-skip fires → security force adds
          // security back → fan-out = `{security}` only. This is
          // intentionally more aggressive — a markdown change to an
          // auth spec doesn't need logic/perf/tests review — but it
          // IS a behavior change reviewers will see in shadow
          // telemetry.
          //
          // CodeRabbit M1 fix: preserve the legacy router decision
          // on `telemetry.legacyRouterDecision` so `/metrics/validation`
          // can compute the "would-have-fanned-out vs actually-fanned-
          // out" delta. The console.log captures both sides too.
          telemetry.legacyRouterDecision = router
          router = {
            specialists: dispatcherDecision.specialists,
            reason: `dispatcher_enforce_rules:${dispatcherDecision.reasoning.slice(0, 200)}`,
            routerEnabled: true,
          }
          telemetry.routerDecision = router
        }
        if (dispatcherMode === "enforce") {
          // SIG-227b: NON-PROTECTED enforcement. Apply the dispatcher's full
          // decision (rule layer + LLM-decided ambiguous middle) for fan-out.
          // reconcile() PROTECTS security + logic — an ambiguous protected role
          // ALWAYS runs; only ambiguous `tests`/`performance` are LLM-skippable
          // — and a disabled/errored/aborted LLM fails CLOSED to "run all
          // ambiguous" (makeDisabledDecision returns ALL_SPECIALISTS). So this
          // can only ever SHRINK the fan-out for the two low-stakes roles,
          // never drop security/logic. (Protected-role LLM-skipping needs a
          // confidence floor + high-trust = SIG-228, deliberately NOT here.)
          // Mirrors the enforce_rules swap above; the difference is upstream —
          // mode=enforce ran the LLM classifier, so the decision is narrower.
          telemetry.legacyRouterDecision = router
          router = {
            specialists: dispatcherDecision.specialists,
            // Defensive `?? ""` so a malformed decision can never throw the
            // `.slice` into the outer catch (Kimi sign-off, SIG-227b).
            reason: `dispatcher_enforce:${(dispatcherDecision.reasoning ?? "").slice(0, 200)}`,
            routerEnabled: true,
          }
          telemetry.routerDecision = router
          console.log(JSON.stringify({
            event: "dispatcher-enforce-applied",
            owner, repo, prNumber, headSha: headSha.slice(0, 7),
            legacySpecialists: telemetry.legacyRouterDecision.specialists,
            enforcedSpecialists: router.specialists,
          }))
        }
      } catch (err) {
        console.error(JSON.stringify({
          event: "dispatcher-shadow-error",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          err: err instanceof Error ? err.message : String(err),
          note: "dispatcher threw unexpectedly; legacy router still drives fan-out",
        }))
      }
    }

    if (router.specialists.length === 0) {
      // Router said "no specialists apply to this PR" — e.g. docs-only
      // with no executable fenced code blocks (see ensemble-router.ts
      // `decideSpecialists` for the rule taxonomy).
      //
      // SIG-224 Phase 0: this used to call `bailWithSkipNotice` →
      // "Couldn't review — see PR comment" + a yellow check, which is
      // wrong semantics. "No specialists apply" is a successful review,
      // not a failure. Thread `event: "APPROVE" + findingsCount: 0` so
      // the Check Run renders the existing `"Approved — no issues found"`
      // title (`pr-review-check-run.ts:382-387`) instead of falling
      // through to the legacy "Review posted · View review" title that
      // links to a nonexistent review. The dispatcher maps `"skipped"
      // → "success"` via `src/index.ts:1297`.
      //
      // "APPROVE" is a slight semantic stretch (we didn't run a review;
      // we determined no review was needed), but the customer-visible
      // effect is correct: green check, "Sigilix approved", link points
      // at the PR conversation tab, no broken review URL.
      //
      // Pre-req for SIG-225 (Phase 1 shadow dispatcher) — once the
      // dynamic dispatcher starts skipping legitimately-not-applicable
      // specialists more often, this path will fire more often, and the
      // wrong "couldn't review" surface would be customer-visible noise.
      telemetry.fellBackToPhase3 = false  // ARC-280: Phase 3 deleted; this flag is now always false on every path
      telemetry.fellBackReason = "router_no_specialists"
      return finalize(telemetry, env, "skipped", cache, {
        event: "APPROVE",
        findingsCount: 0,
      })
    }

    // ─── Pre-flight retrieval snapshot ─────────────────────────
    cache = createRetrievalCache({
      maxCalls: ensembleConfig.tunables.maxRetrieveCallsPerPr,
    })
    const namespace = indexNamespace(owner, repo)
    const preflightQuery = `${meta.title}\n\n${meta.body ?? ""}`
    // Phase 4a.1: cap the pre-flight Vectorize round-trip so a slow
    // retrieval can't silently consume the synth budget. Failure here
    // is non-fatal (per v3.1 §8) — specialists fall back to empty
    // snapshot and may still use their role-specific context blocks.
    // Capture cache locally so the lambda below sees a non-null narrowing.
    const preflightCache = cache
    let preflightChunks: Awaited<ReturnType<typeof preflightCache.cachedRetrieve>>["chunks"] = null
    // SIG-110: perf-keyword retrieval. Kicked off HERE so it runs
    // CONCURRENTLY with the preflight below — both share the ≤15s cap +
    // orchCtrl.signal, so the perf query adds no critical-path wall-clock
    // (the orchestrator has only ~10s of static slack). Fires only when
    // the performance specialist is in the lineup AND the retrieve budget
    // has room for preflight + perf plus shared retrieval headroom
    // (`budgetRemaining() > 2` reads full budget here since the
    // cache consumes only after its internal cacheKey await — so this
    // means maxCalls >= 3, the default). The query seeds perf anti-pattern
    // vocabulary + changed function names so Vectorize lands on
    // perf-relevant code (single namespace → bias is via query terms, not
    // a separate index). Best-effort: never rejects, falls back to the
    // shared snapshot.
    const wantPerfRetrieval = shouldRunPerfRetrieval(
      router.specialists,
      preflightCache.budgetRemaining(),
    )
    let perfQuery = ""
    let perfChunks: RetrievedChunk[] | null = null
    let perfRetrievalPromise: Promise<RetrievedChunk[] | null> | null = null
    if (wantPerfRetrieval) {
      perfQuery = buildPerfRetrievalQuery(
        preflightQuery,
        extractChangedFunctionNames(diff),
      )
      perfRetrievalPromise = withComposedTimeout(
        () => preflightCache.cachedRetrieve({
          caller: "specialist:performance",
          query: perfQuery,
          namespace,
          fetcher: () => retrieveChunks({ text: perfQuery, teamKey: namespace, env }),
        }),
        RETRIEVAL_PREFLIGHT_TIMEOUT_MS,
        orchCtrl.signal,
      ).then((r) => r.chunks).catch(() => null)
    }
    // SIG-44: multi-corpus retrieval (prior merged PRs + Linear issues).
    // Kicked off HERE so its embed+query runs CONCURRENTLY with the
    // preflight/perf retrieval above. Best-effort: never rejects (the
    // function soft-fails per leg, and we add a defensive .catch). Flag-gated
    // (default off); the result is appended to the shared snapshot AFTER the
    // branch-aware merge block below so the merge can't clobber it.
    const wantMultiCorpus = multiCorpusEnabled(env)
    const multiCorpusPromise: Promise<MultiCorpusResult> | null = wantMultiCorpus
      ? retrieveMultiCorpus(env, owner, repo, preflightQuery, { prNumber, headSha })
          .catch(() => ({ pr: [], issue: [] }))
      : null
    // ARC-284: phase-completed event always emits (even on the catch
    // path) so a 15s pre-flight cap-hit shows up in the trace.
    const preflightStartMs = Date.now()
    try {
      const preflight = await withComposedTimeout(
        () => preflightCache.cachedRetrieve({
          caller: "preflight",
          query: preflightQuery,
          namespace,
          fetcher: () => retrieveChunks({ text: preflightQuery, teamKey: namespace, env }),
        }),
        RETRIEVAL_PREFLIGHT_TIMEOUT_MS,
        orchCtrl.signal,
      )
      preflightChunks = preflight.chunks
    } catch (err) {
      // If the orchestrator's outer signal aborted, propagate — that's a
      // genuine internal_error, not a pre-flight timeout.
      if (orchCtrl.signal.aborted) throw err
      // Pre-flight-only timeout / error. The cache itself wraps the
      // fetcher in its own try/catch so its log will eventually capture
      // the fetcher's outcome (success/error) once the background call
      // settles — we just stop awaiting it and proceed with an empty
      // snapshot. Total wall-clock vs. the cache log's elapsedMs lets
      // post-hoc analysis distinguish "we gave up at 15s" from "fetcher
      // threw a hard error".
      preflightChunks = null
    } finally {
      emitPhaseCompleted(perfCtx, "preflight_retrieval", preflightStartMs)
    }
    let retrievalSnapshot = preflightChunks
      ? formatChunksForPrompt(preflightChunks) ?? ""
      : ""
    // SIG-110: resolve the perf-specific snapshot. Awaited AFTER the
    // preflight (both already ran concurrently), so this adds no extra
    // wall-clock. The inner promise never rejects (`.catch(() => null)`
    // above); empty / skipped perf retrieval falls back to the shared
    // snapshot so the performance specialist is never worse off than the
    // other roles. NOTE: this is the one intentional exception to the
    // "all specialists see the same retrieval snapshot" invariant — only
    // the performance role gets a perf-biased view.
    // (On the orchCtrl-abort path the preflight `await` above re-throws
    // before we reach here, so `perfRetrievalPromise` is intentionally
    // abandoned — it carries `.catch(() => null)` and shares
    // orchCtrl.signal, so it aborts cleanly with no unhandled rejection.)
    let perfRetrievalSnapshot = retrievalSnapshot
    if (perfRetrievalPromise) {
      perfChunks = await perfRetrievalPromise
      const formattedPerf = perfChunks ? formatChunksForPrompt(perfChunks) ?? "" : ""
      const perfRetrievalUsed = formattedPerf.length > 0
      perfRetrievalSnapshot = resolvePerfSnapshot(formattedPerf, retrievalSnapshot)
      // Bake-off signal: did the perf-biased snapshot actually differ
      // from the shared one, or did we fall back? (SIG-110 → SIG-86.)
      console.log(JSON.stringify({
        event: "pr-review-perf-retrieval",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        used: perfRetrievalUsed,
      }))
    }

    // ─── ARC-186: dependency-vulnerability scan ────────────────
    // Runs after secret-scan + deterministic-checks but BEFORE the
    // specialist fanout. Findings are pre-LLM facts injected alongside
    // the other deterministic blocks.
    const depVulnEnabled = sigilixConfig.depVulnScan?.enabled !== false
    const baseShaForDepVuln = meta.base?.sha ?? ""
    const depVulnResult = await runDepVulnScan({
      env,
      client,
      owner, repo, prNumber,
      headSha,
      baseSha: baseShaForDepVuln,
      enabled: depVulnEnabled,
    })
    const depVulnFindings = depVulnResult.skipped ? [] : depVulnResult.findings
    const depVulnBlock = renderDepVulnFindingsForPrompt(depVulnFindings)
    telemetry.depVulnScan = depVulnResult.skipped
      ? { skipped: true, reason: depVulnResult.reason, findingsCount: 0 }
      : {
          skipped: false,
          findingsCount: depVulnResult.findings.length,
          depsScanned: depVulnResult.depsScanned,
          manifestsScanned: depVulnResult.manifestsScanned,
        }

    // ─── ARC-181: AST rule-pack scan ────────────────────────────
    // Pre-LLM AST scan over pathFiltered JS/TS files.
    const astRulesConfig = resolveAstRulesConfig(sigilixConfig)
    const jsTsPaths = filePaths.filter((p) => /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i.test(p))
    // SIG-121: decide symbol retrieval up front — it also needs JS/TS sources
    // for AST symbol extraction, so the fetch below must run when EITHER AST
    // rules or symbol retrieval may run. Otherwise disabling `astRules` in
    // sigilix.json would silently starve symbol retrieval even with
    // OPENCLAW_SYMBOL_RETRIEVAL=on. Budget is read here, before the fetch; no
    // retrieval consumes between here and the block below, so the value is
    // identical to reading it at the block.
    const wantSymbolRetrieval = shouldRunSymbolRetrieval(
      ensembleConfig.flags.symbolRetrieval,
      router.specialists,
      preflightCache.budgetRemaining(),
    )
    const wantBranchAware =
      (ensembleConfig.flags.branchAwareRetrieval ?? "").trim().toLowerCase() === "on"
    const wantDynamicReviewEvidence = dynamicReviewEvidenceEnabled(env)
    // SIG-317 Part 4b: the asymmetry injector needs the changed-files corpus too
    // (CodeRabbit #308 — else `on`/`shadow` silently no-ops when astRules is off).
    const asymmetryMode = ensembleConfig.flags.asymmetryHints
    const toctouMode = ensembleConfig.flags.toctouHints
    // Cross-cutting over-fire Option B: the window-blindness gate reads the full
    // file from `astFilesByPath` to find a guard the model never saw. It must
    // trigger the fetch itself (CodeRabbit #329) — else, if every OTHER
    // AST/symbol feature is off, the map stays empty and the gate silently
    // fail-opens (keeps) on every finding, i.e. becomes a no-op.
    const wantWindowBlindness =
      ensembleConfig.validatorModes.windowBlindnessValidatorMode !== "off"
    // SIG-328: the logic-claim refutation gate also needs the full-file source
    // map for its AST proof — trigger the fetch so it can't silently no-op (and
    // mis-read as "0 would-drops") if the other AST features are ever flipped off.
    const wantLogicClaimRefutation =
      ensembleConfig.validatorModes.logicClaimRefutationMode !== "off"
    const astFilesByPath = new Map<string, string>()
    if (
      (astRulesConfig.enabled || wantSymbolRetrieval || wantBranchAware || wantDynamicReviewEvidence ||
        asymmetryMode !== "off" || toctouMode !== "off" || wantWindowBlindness || wantLogicClaimRefutation) &&
      jsTsPaths.length > 0
    ) {
      const fetchResults = await mapWithConcurrency(
        jsTsPaths,
        5,
        async (p) => {
          const src = await client.getFileContent(owner, repo, p, headSha)
          return { p, src }
        },
      )
      for (const r of fetchResults) {
        if (r.status === "fulfilled" && typeof r.value.src === "string") {
          astFilesByPath.set(r.value.p, r.value.src)
        }
      }
    }

    // SIG-336: one parse-once AST cache for the whole review. Every acorn
    // consumer below (runAstRules, durableObjectClassSpans, detectHelperCoverage,
    // the graph expansion, and the logic-claim refutation gate) shares it, so a
    // given file is parsed at most once per review instead of once per subsystem
    // (and once per finding). The shared 500KB guard rides along.
    const astCache = createAstCache()

    // SIG-129: build the branch retrieval set ONCE (best-effort), reused
    // across the preflight / perf / symbol merges. Empty set ⇒ every merge
    // is a no-op ⇒ identical to today's main-only behavior.
    let branchVectors: BranchVector[] = []
    let branchSetElapsedMs = 0
    if (shouldRunBranchAwareRetrieval(ensembleConfig.flags.branchAwareRetrieval, astFilesByPath)) {
      const startMs = Date.now()
      try {
        branchVectors = await withComposedTimeout(
          () => prepareBranchSet(env.AI, astFilesByPath),
          RETRIEVAL_PREFLIGHT_TIMEOUT_MS,
          orchCtrl.signal,
        )
      } catch (err) {
        // Genuine orchestrator cancellation propagates; a slow/stuck embed
        // degrades to main-only retrieval (empty branch set).
        if (orchCtrl.signal.aborted) throw err
        branchVectors = []
      }
      branchSetElapsedMs = Date.now() - startMs
    }
    // SIG-129 tombstone set: every changed JS/TS file is stale on `main`, so
    // its main-index chunks must be dropped from each merge regardless of
    // whether a branch chunk for it surfaced in the retrieved top-K.
    const changedPaths: ReadonlySet<string> = new Set(jsTsPaths)

    // Branch-aware merge for one pass: embed the pass's query (single text,
    // best-effort) and overlay branch chunks on the main chunks. Returns the
    // main chunks unchanged when branch-aware is off / the set is empty / the
    // query embed fails. Records the per-pass head-override count (stale main
    // chunks removed by the changed-path tombstone) for shadow telemetry.
    const branchMergeStats = { preflight: 0, perf: 0, symbol: 0 }
    const branchAwareMerge = async (
      mainChunks: RetrievedChunk[] | null,
      queryText: string,
      pass: keyof typeof branchMergeStats,
    ): Promise<RetrievedChunk[] | null> => {
      if (branchVectors.length === 0 || !mainChunks) return mainChunks
      let qVec: number[]
      // Cap the query embed input (chars) so a pathological query can't blow
      // the embedder's context — mirrors retrieval.ts's 4k query slice.
      try {
        qVec = await withComposedTimeout(
          () => embedText(env.AI, queryText.slice(0, 4_000)),
          RETRIEVAL_PREFLIGHT_TIMEOUT_MS,
          orchCtrl.signal,
        )
      } catch (err) {
        // Genuine orchestrator cancellation must propagate (matches the
        // preflight/symbol passes); any other embed failure/timeout degrades
        // to main-only retrieval.
        if (orchCtrl.signal.aborted) throw err
        return mainChunks
      }
      const branchChunks = retrieveBranchChunks(qVec, branchVectors, TOP_K_BRANCH)
      branchMergeStats[pass] = mainChunks.filter((c) => changedPaths.has(c.path)).length
      return mergeBranchAware(mainChunks, branchChunks, changedPaths)
    }

    // Re-merge the SHARED preflight snapshot (seen by every specialist) and
    // the perf snapshot now that branchVectors exists. No-op when the set is
    // empty. The symbol pass merges itself in its own block below.
    let sharedChunksForOverlap: RetrievedChunk[] = preflightChunks ?? []
    if (branchVectors.length > 0) {
      const preflightMerged = await branchAwareMerge(preflightChunks, preflightQuery, "preflight")
      sharedChunksForOverlap = preflightMerged ?? []
      retrievalSnapshot = preflightMerged ? formatChunksForPrompt(preflightMerged) ?? "" : ""

      if (perfChunks) {
        const perfMerged = await branchAwareMerge(perfChunks, perfQuery, "perf")
        const formattedPerf = perfMerged ? formatChunksForPrompt(perfMerged) ?? "" : ""
        perfRetrievalSnapshot = resolvePerfSnapshot(formattedPerf, retrievalSnapshot)
      } else {
        perfRetrievalSnapshot = retrievalSnapshot
      }
    }

    // SIG-44: append the multi-corpus (prior PRs + Linear issues) section to
    // the shared + perf snapshots. Done HERE — after the branch-aware merge's
    // reassignments — so it can't be overwritten. Awaited now; it ran
    // concurrently with preflight so this adds no critical-path wall-clock.
    // The logic role inherits this via its shared snapshot; the SIG-236 logic
    // prompt budget still trims if needed (formatMultiCorpusForPrompt is
    // already bounded to ~6K chars).
    if (multiCorpusPromise) {
      const mc = await multiCorpusPromise
      const block = formatMultiCorpusForPrompt(mc) ?? ""
      if (block.length > 0) {
        const section = `[PRIOR PRS & ISSUES]\n${block}`
        retrievalSnapshot = retrievalSnapshot ? `${retrievalSnapshot}\n\n${section}` : section
        perfRetrievalSnapshot = perfRetrievalSnapshot
          ? `${perfRetrievalSnapshot}\n\n${section}`
          : section
      }
    }

    // SIG-121: symbol-based retrieval for the LOGIC specialist (flag-gated,
    // best-effort). Fires HERE — after astFilesByPath is built (it needs the
    // file SOURCES for AST symbol extraction) and before the specialist
    // fanout. Unlike SIG-110's perf retrieval (concurrent with preflight),
    // this can't run at preflight time because the sources don't exist yet.
    // Budget-aware, ≤15s cap, non-fatal (empty snapshot on failure; rethrow
    // only on orchCtrl abort). AUGMENTS — never replaces — the logic role's
    // shared snapshot via mergeLogicSnapshot below.
    //
    // BUDGET NOTE: the gate (shouldRunSymbolRetrieval) requires
    // budgetRemaining() > 1 — checked HERE, after preflight (and perf, if
    // any) have already consumed. At the default maxCalls=3: a logic-only PR
    // leaves budgetRemaining()=2 → symbol fires (1 reserved for synth); a PR
    // that ALSO ran a perf pass leaves 1 → symbol defers (perf + symbol are
    // mutually exclusive at the default budget). Raise
    // OPENCLAW_ENSEMBLE_MAX_RETRIEVE_CALLS_PER_PR (≥4) to run both — relevant
    // when enabling this flag for the SIG-86 bake-off.
    let logicSymbolSnapshot = ""
    let symbolOverlap: ReturnType<typeof computeChunkOverlap> | null = null
    let symbolRetrievalElapsedMs = 0
    let symbolQueryCount = 0
    let symbolInjected = false
    if (wantSymbolRetrieval) {
      const changedLines = buildChangedLines(diff)
      const symbols = extractChangedSymbols(astFilesByPath, changedLines)
      symbolQueryCount = symbols.length
      const symbolQuery = buildSymbolRetrievalQuery(symbols)
      if (symbolQuery.length > 0) {
        const startMs = Date.now()
        let symbolChunks: RetrievedChunk[] | null = null
        try {
          const r = await withComposedTimeout(
            () =>
              preflightCache.cachedRetrieve({
                caller: "specialist:logic-symbol",
                query: symbolQuery,
                namespace,
                fetcher: () => retrieveChunks({ text: symbolQuery, teamKey: namespace, env }),
              }),
            RETRIEVAL_PREFLIGHT_TIMEOUT_MS,
            orchCtrl.signal,
          )
          symbolChunks = await branchAwareMerge(r.chunks, symbolQuery, "symbol")
        } catch (err) {
          if (orchCtrl.signal.aborted) throw err
          symbolChunks = null
        }
        symbolRetrievalElapsedMs = Date.now() - startMs
        const formatted = symbolChunks ? formatChunksForPrompt(symbolChunks) ?? "" : ""
        if (formatted.length > 0) {
          logicSymbolSnapshot = formatted
          symbolInjected = true
        }
        symbolOverlap = computeChunkOverlap(sharedChunksForOverlap, symbolChunks ?? [])
      }
      // Bake-off signal (SIG-121 → SIG-86): how different is the
      // symbol-derived snapshot from the shared one?
      console.log(JSON.stringify({
        event: "pr-review-symbol-retrieval",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        query_symbol_count: symbolQueryCount,
        injected: symbolInjected,
        elapsed_ms: symbolRetrievalElapsedMs,
        budget_remaining: preflightCache.budgetRemaining(),
        shared_chunks: symbolOverlap?.sharedCount ?? 0,
        symbol_chunks: symbolOverlap?.symbolCount ?? 0,
        intersection: symbolOverlap?.intersectionCount ?? 0,
        jaccard: symbolOverlap?.jaccard ?? 0,
      }))
    }

    // SIG-129 → SIG-86 bake-off signal. Flag-off ⇒ branchVectors empty ⇒
    // logs zeros and nothing changed in the snapshots.
    if (wantBranchAware) {
      console.log(JSON.stringify(buildBranchRetrievalEvent({
        owner, repo, prNumber, headSha,
        branchChunkCount: branchVectors.length,
        embedElapsedMs: branchSetElapsedMs,
        headOverride: branchMergeStats,
      })))
    }

    // ─── SIG-138 Phase 2: graph-expansion retrieval ────────────────────
    //
    // Gated by OPENCLAW_GRAPH_RETRIEVAL=shadow|post. Off ⇒ no DO calls,
    // no behavior change. Any error in this block is caught and logged;
    // the review always proceeds unaffected (graph is additive context).
    //
    // shadow: compute everything for telemetry; do NOT attach graphContext
    //   to posted prompts.
    // post:   attach graphContext to logic + tests specialists + synth.
    //
    // SIG-143: blast radius is driven by the PR's changed symbol NAMES
    // (extractChangedSymbols), which the DO resolves to symbol_ids in the
    // active graph version (blastRadiusByNames). Names are extracted here
    // independently of the symbol-retrieval block above (that block is gated
    // on a separate budget flag and may not run). Both helpers are pure.
    let graphContextString = ""
    let graphNodePaths: string[] = []
    let graphContextNodesForEvidence: GraphContextNode[] = []
    // M2: keep caller + import-dependent counts separate for telemetry;
    // graph-context injection can use a combined set.
    let graphBlastCallerPaths: string[] = []
    let graphBlastDependentPaths: string[] = []
    // SIG-143: blast paths folded into the prompt graph-context block (post mode).
    let graphBlastContextString = ""
    if (graphRetrievalEnabled(env)) {
      const graphRpcBudgetMs = ensembleConfig.tunables.graphRpcTimeoutMs
      try {
        // Seed from deduplicated chunk paths of the merged hit set.
        const seedPaths = [...new Set(sharedChunksForOverlap.map((c) => c.path))]
        // Wrap in withTimeout so a slow DO RPC cannot consume orchestrator wall
        // time.  AbortSignal is unused by the DO stub but required by the helper
        // signature.  On timeout the helper aborts and rejects; the outer catch
        // below handles it and skips graph context gracefully.
        const { nodes } = await withTimeout(
          (_signal) => graphContextFor(env, owner, repo, {
            seedPaths,
            maxFiles: 8,
            maxSymbolsPerHit: 12,
            maxEdgesPerSymbol: 6,
          }),
          graphRpcBudgetMs,
        )
        // Cap graph-only additions to ≤4 nodes per spec.
        // Sort: hop asc, then edge weight desc (higher weight = stronger edge).
        const cappedNodes = nodes
          .slice()
          .sort((a, b) => {
            const hopDiff = a.hop - b.hop
            if (hopDiff !== 0) return hopDiff
            return edgeWeight(b.edgeKind) * hopDecay(b.hop) -
                   edgeWeight(a.edgeKind) * hopDecay(a.hop)
          })
          .slice(0, 4)
        graphContextString = formatGraphContext(cappedNodes)
        graphNodePaths = cappedNodes.map((n) => n.path)
        graphContextNodesForEvidence = cappedNodes

        // Blast radius (SIG-143): resolve the PR's changed symbol names in the
        // active graph version → caller + import-dependent files. Names come
        // from the diff via the same pure helpers the symbol-retrieval block
        // uses; resolution is scoped to the changed JS/TS files (astFilesByPath
        // keys) as a name-collision guard. Empty input fast-paths inside the DO.
        const changedGraphNames = extractChangedSymbols(astFilesByPath, buildChangedLines(diff))
        const changedGraphPaths = [...astFilesByPath.keys()]
        // Isolated try: a blast RPC timeout/error must NOT discard the graph
        // context already built above from graphContextFor (the outer catch
        // clears it). Blast radius is additive on top of the BFS neighbors.
        try {
          const blast = await withTimeout(
            (_signal) => blastRadiusByNamesFor(env, owner, repo, {
              changedNames: changedGraphNames,
              changedPaths: changedGraphPaths,
            }),
            graphRpcBudgetMs,
          )
          // M2: preserve caller vs import-dependent distinction for telemetry.
          graphBlastCallerPaths = [...new Set(blast.callerPaths)]
          graphBlastDependentPaths = [...new Set(blast.importDependents)]
          // SIG-143: fold blast paths into the graph context that reaches the
          // specialists (AC), excluding paths already covered by vector-hit
          // seeds or BFS neighbors. Capped for prompt size.
          graphBlastContextString = formatGraphBlastContext({
            callerPaths: graphBlastCallerPaths,
            dependentPaths: graphBlastDependentPaths,
            exclude: new Set([...seedPaths, ...graphNodePaths]),
            cap: GRAPH_BLAST_PROMPT_CAP,
          })
        } catch (blastErr) {
          console.log(JSON.stringify({
            event: "pr-review-graph-blast-error",
            owner, repo, prNumber, headSha: headSha.slice(0, 7),
            error: blastErr instanceof Error ? blastErr.message : String(blastErr),
          }))
          graphBlastCallerPaths = []
          graphBlastDependentPaths = []
          graphBlastContextString = ""
        }

        // Bake-off telemetry: emit in both shadow and post so the SIG-86
        // analysis always has coverage data. Failure is non-fatal.
        const vectorSeedPaths = seedPaths
        const { jaccard, addedCount } = graphOverlapStats({
          vectorPaths: vectorSeedPaths,
          graphPaths: graphNodePaths,
        })
        // hop_distribution: count capped nodes per hop level.
        const hopDist: Record<string, number> = {}
        for (const n of cappedNodes) {
          const key = String(n.hop)
          hopDist[key] = (hopDist[key] ?? 0) + 1
        }
        // edge_type_distribution: count capped nodes per edgeKind.
        const edgeTypeDist: Record<string, number> = {}
        for (const n of cappedNodes) {
          edgeTypeDist[n.edgeKind] = (edgeTypeDist[n.edgeKind] ?? 0) + 1
        }
        console.log(JSON.stringify({
          event: "pr-review-graph-retrieval",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          mode: graphRetrievalMode(env),
          jaccard,
          added_count: addedCount,
          node_count: nodes.length,
          capped_node_count: cappedNodes.length,
          blast_caller_count: graphBlastCallerPaths.length,
          blast_dependent_count: graphBlastDependentPaths.length,
          hop_distribution: hopDist,
          edge_type_distribution: edgeTypeDist,
        }))
        // SIG-152: push the same sample to the dispatcher's sink so it lands in
        // GraphMetricsDO (curl-able via /metrics/graph). Telemetry-only — fires
        // in both shadow and post, matching the log event above.
        args.graphMetricsSink?.push({
          mode: graphRetrievalMode(env),
          jaccard,
          addedCount,
          nodeCount: nodes.length,
          cappedNodeCount: cappedNodes.length,
          blastCallerCount: graphBlastCallerPaths.length,
          blastDependentCount: graphBlastDependentPaths.length,
        })
      } catch (err) {
        // Non-fatal: graph expansion is additive. Log for observability.
        console.log(JSON.stringify({
          event: "pr-review-graph-retrieval-error",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          error: err instanceof Error ? err.message : String(err),
        }))
        graphContextString = ""
        graphNodePaths = []
        graphContextNodesForEvidence = []
        graphBlastCallerPaths = []
        graphBlastDependentPaths = []
        graphBlastContextString = ""
      }
    }
    // In post mode, inject graph context into logic+tests specialists
    // and synthesizer: BFS neighbors (graphContextString) plus the folded
    // blast-radius paths (graphBlastContextString). In shadow mode, the
    // variables are computed but not attached to prompts (bake-off telemetry
    // fires in both modes).
    // `let`: SIG-286 may APPEND a targeted cross-file expansion block below (in
    // OPENCLAW_GRAPH_EXPANSION=post mode) once `enriched` is computed.
    let graphCtxForPrompt = graphRetrievalMode(env) === "post"
      ? [graphContextString, graphBlastContextString].filter((s) => s.length > 0).join("\n")
      : ""
    // ──────────────────────────────────────────────────────────────────

    // ─── SIG-286: graph-context body expansion ─────────────────────────
    //
    // Gated by OPENCLAW_GRAPH_EXPANSION=shadow|post. Off ⇒ no DO call, no
    // telemetry, zero behavior change. Both modes COMPUTE the enriched
    // changed-symbol context (definition / caller / import-dependent bodies)
    // and emit the `graph-expansion-shadow` event. In `post` (PR1 targeted
    // inject) the net-new cross-file bodies are ALSO appended to
    // graphCtxForPrompt below; in `shadow` the result is measured-not-injected,
    // so graphCtxForPrompt stays the SIG-138-only graph block.
    //
    // Soft-fail: bounded by withComposedTimeout(orchCtrl.signal) + a catch that
    // emits `graph-expansion-shadow-error` and continues. It must NEVER block,
    // slow, or break the review.
    const graphExpMode = graphExpansionMode(env)
    if (graphExpMode !== "off") {
      try {
        // CodeRabbit: measure the WHOLE PR, not the prompt batch. astFilesByPath
        // is the full changed JS/TS set, but `diff` is truncated to maxPatchLength
        // — detect changed lines from `fullDiff` so we don't skip symbols past the
        // truncation (which would bias the shadow data low on large PRs).
        const changedExpNames = extractChangedSymbols(astFilesByPath, buildChangedLines(fullDiff))
        const changedExpPaths = [...astFilesByPath.keys()]
        const enriched = await withComposedTimeout(
          async (signal) => {
            const expansion = await contextExpansionForChangedSymbolsFor(env, owner, repo, {
              changedNames: changedExpNames,
              changedPaths: changedExpPaths,
            })
            return buildGraphContextExpansion({
              expansion,
              filesByPath: astFilesByPath,
              // SIG-286 PR2: bounded cross-file fetcher (≤6 distinct files,
              // concurrency 4, ALL inside the 3s soft-fail GRAPH_EXPANSION cap).
              // Reuses the in-scope GitHub client; getFileContent returns null on
              // 404/dir/>1MB and the pre-fetch wraps each call soft-fail so a
              // fetch error never blocks or breaks the (shadow, non-injected)
              // measurement. Turns the PR1 `missing` rows into real `github`
              // bodies → the CONTROL-vs-TREATMENT numbers that decide PR3.
              // Threads the composed-timeout `signal` so an in-flight cross-file
              // fetch CANCELS the moment the 3s expansion cap (or the
              // orchestrator) aborts — the batch is abort-aware mid-wave, not
              // just between waves (Sigilix + CodeRabbit).
              fetchFileContent: (path) => client.getFileContent(owner, repo, path, headSha, { signal }),
              signal,
            })
          },
          GRAPH_EXPANSION_TIMEOUT_MS,
          orchCtrl.signal,
        )
        console.log(JSON.stringify({
          event: "graph-expansion-shadow",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          mode: graphExpMode,
          // Surface diff truncation so analysis can exclude PRs where the changed
          // set may still be partial (large PRs) for a clean opportunity measurement.
          diffTruncated: wasTruncated,
          graphAvailable: enriched.graphAvailable,
          callerBodies: enriched.callerBodies.length,
          dependentBodies: enriched.dependentBodies.length,
          defBodies: enriched.definitionBodies.length,
          totalTokens: enriched.totalTokens,
          cappedAt: enriched.cappedAt,
          elapsedMs: enriched.elapsedMs,
          bodiesSource: enriched.bodiesSource,
          dropped: enriched.dropped,
          // SIG-286 PR2: CONTROL (no-fetch) vs TREATMENT (with cross-file fetch).
          // controlTokens = filesByPath-only; totalTokens above = treatment;
          // netNewTokens = the cross-file context gain the PR3 inject decision
          // keys off (GO ≈ median ≥ 800 + cross-file callers on >40% of reviews;
          // KILL < 500 or no cross-file caller context). `fetch` is the cost.
          controlTokens: enriched.control.tokens,
          netNewTokens: enriched.netNewTokens,
          fetch: enriched.fetch,
        }))
        // SIG-286 PR2.5: push the same sample to the dispatcher's sink so it
        // lands in GraphExpansionMetricsDO (curl-able via /metrics/graph-expansion,
        // the readable netNewTokens median the PR3 GO/KILL decision keys off).
        // Telemetry-only — fires in shadow and post, matching the log event.
        args.graphExpansionMetricsSink?.push({
          mode: graphExpMode,
          graphAvailable: enriched.graphAvailable,
          netNewTokens: enriched.netNewTokens,
          controlTokens: enriched.control.tokens,
          totalTokens: enriched.totalTokens,
          fetchEnabled: enriched.fetch.enabled,
          fetchFiles: enriched.fetch.files,
          fetchBytes: enriched.fetch.bytes,
          fetchElapsedMs: enriched.fetch.elapsedMs,
          budgetExhausted: enriched.fetch.budgetExhausted,
        })
        // SIG-286 PR1: in `post` mode, APPEND the targeted inject — net-new
        // cross-file definition/caller bodies — to the graph block reaching
        // logic+tests+synth. The render is "" for the ~73% of reviews with no
        // net-new cross-file context (the blanket-inject KILL set), so they
        // append nothing. `shadow` skips this ⇒ measured-but-not-injected, the
        // current prod behavior; only `post` injects.
        if (graphExpMode === "post") {
          const expansionBlock = renderGraphExpansionForPrompt(enriched)
          // SIG-286 PR2: A/B among reviews that WOULD inject. TREATMENT gets the
          // cross-file inject; CONTROL computes the identical context but does
          // NOT inject. Both arms record `graphExpansionAb` on the telemetry (it
          // rides into ensemble-review-telemetry alongside `synthesizer.verdict`),
          // so a per-arm finding-rate comparison (group by arm, count
          // `synthesizer.verdict.findings`) can read whether the inject catches
          // MORE real findings — the only honest FN measure, since the inject's
          // findings land on the diff (informed by cross-file context), not on
          // the snippets. Non-inject reviews (empty render) sit out the experiment.
          if (expansionBlock.length > 0) {
            const arm = injectArm(headSha)
            telemetry.graphExpansionAb = { arm }
            if (arm === "treatment") {
              graphCtxForPrompt = [graphCtxForPrompt, expansionBlock]
                .filter((s) => s.length > 0)
                .join("\n\n")
              // Observable so the inject is verifiable. Counts are the ACTUALLY-
              // injected net-new bodies (same selector as the render), not the
              // enriched totals (CodeRabbit #277).
              console.log(JSON.stringify({
                event: "graph-expansion-injected",
                owner, repo, prNumber, headSha: headSha.slice(0, 7),
                bytes: expansionBlock.length,
                bodiesInjected: netNewCrossFileBodies(enriched).length,
                netNewTokens: enriched.netNewTokens,
              }))
            }
          }
        }
      } catch (err) {
        // Genuine orchestrator cancellation propagates; any other failure is
        // soft — log and continue, never block the review.
        if (orchCtrl.signal.aborted) throw err
        console.log(JSON.stringify({
          event: "graph-expansion-shadow-error",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          mode: graphExpMode,
          error: err instanceof Error ? err.message : String(err),
        }))
      }
    }
    // ──────────────────────────────────────────────────────────────────

    const astResult = await runAstRules({
      diff,
      filesByPath: astFilesByPath,
      reviewable,
      config: astRulesConfig,
      ctx: { owner, repo, prNumber },
      astCache,
    })

    // SIG-314: shadow-first gating for the deterministic IDOR/BOLA floor
    // (no-unauthorized-object-lookup). The rule lives in ALL_RULES so it always
    // RUNS (the runner logs `ast-rules-finding` per hit for FP measurement), but
    // its emits reach the synth — and post — ONLY in `post` mode. `off` (the
    // default) strips them silently; `shadow` strips-but-logs a rollup so we can
    // read the firing + false-positive rate on dogfood + the e2e fixtures before
    // promoting. The rule is structurally P2-capped (clampAstEmitScores), so the
    // residual risk we're measuring is middleware-only-authz false positives,
    // never a P0/P1.
    // SIG-318 (PR 5a): env-derived settings come from the typed EnsembleConfig
    // resolved once at the top of the handler (parsed at the Worker edge and
    // injected via args; see resolveEnsembleConfig). The scanner gates below read
    // ensembleConfig.astScanModes.* — no inline env.OPENCLAW_* reads.
    const authzIdorMode = ensembleConfig.astScanModes.authzIdor
    if (authzIdorMode !== "post") {
      const authzEmits = astResult.findings.filter((f) => f.ruleId === "no-unauthorized-object-lookup")
      if (authzEmits.length > 0) {
        astResult.findings = astResult.findings.filter((f) => f.ruleId !== "no-unauthorized-object-lookup")
        // CodeRabbit #302: keep perFinding aligned — the auto-inline poster reads
        // it by astFindingId, so a stale entry would mis-anchor another comment.
        for (const f of authzEmits) astResult.perFinding.delete(f.astFindingId)
        if (authzIdorMode === "shadow") {
          console.log(JSON.stringify({
            event: "authz-idor-shadow",
            owner, repo, prNumber, headSha: headSha.slice(0, 7),
            count: authzEmits.length,
            anchors: authzEmits.map((f) => `${f.path}:${f.line}`),
          }))
        }
      }
    }
    // Shadow-first gating for the deterministic weak-randomness floor
    // (no-insecure-random-token, CWE-338) — same off/shadow/post contract as the
    // IDOR floor above. The rule always RUNS (logged per hit for FP measurement);
    // its emits reach synth/post ONLY in `post`. `off` (default) strips silently;
    // `shadow` strips-but-logs a rollup so we can read the firing + FP rate on
    // dogfood before promoting. Structurally P2-capped (clampAstEmitScores).
    const weakRandomMode = ensembleConfig.astScanModes.weakRandom
    if (weakRandomMode !== "post") {
      const weakRandomEmits = astResult.findings.filter((f) => f.ruleId === "no-insecure-random-token")
      if (weakRandomEmits.length > 0) {
        astResult.findings = astResult.findings.filter((f) => f.ruleId !== "no-insecure-random-token")
        // Keep perFinding aligned (the auto-inline poster reads it by astFindingId).
        for (const f of weakRandomEmits) astResult.perFinding.delete(f.astFindingId)
        if (weakRandomMode === "shadow") {
          console.log(JSON.stringify({
            event: "weak-random-token-shadow",
            owner, repo, prNumber, headSha: headSha.slice(0, 7),
            count: weakRandomEmits.length,
            anchors: weakRandomEmits.map((f) => `${f.path}:${f.line}`),
          }))
        }
      }
    }
    // Shadow-first gating for the deterministic open-redirect floor
    // (no-open-redirect, CWE-601) — same off/shadow/post contract. Default off;
    // shadow strips-but-logs the firing + FP rate on dogfood before promoting.
    const openRedirectMode = ensembleConfig.astScanModes.openRedirect
    if (openRedirectMode !== "post") {
      const openRedirectEmits = astResult.findings.filter((f) => f.ruleId === "no-open-redirect")
      if (openRedirectEmits.length > 0) {
        astResult.findings = astResult.findings.filter((f) => f.ruleId !== "no-open-redirect")
        for (const f of openRedirectEmits) astResult.perFinding.delete(f.astFindingId)
        if (openRedirectMode === "shadow") {
          console.log(JSON.stringify({
            event: "open-redirect-shadow",
            owner, repo, prNumber, headSha: headSha.slice(0, 7),
            count: openRedirectEmits.length,
            anchors: openRedirectEmits.map((f) => `${f.path}:${f.line}`),
          }))
        }
      }
    }
    // Shadow-first gating for the deterministic SSRF floor (no-ssrf, CWE-918) —
    // same off/shadow/post contract. Default off; shadow strips-but-logs the
    // firing + FP rate on dogfood before promoting.
    const ssrfMode = ensembleConfig.astScanModes.ssrf
    if (ssrfMode !== "post") {
      const ssrfEmits = astResult.findings.filter((f) => f.ruleId === "no-ssrf")
      if (ssrfEmits.length > 0) {
        astResult.findings = astResult.findings.filter((f) => f.ruleId !== "no-ssrf")
        for (const f of ssrfEmits) astResult.perFinding.delete(f.astFindingId)
        if (ssrfMode === "shadow") {
          console.log(JSON.stringify({
            event: "ssrf-shadow",
            owner, repo, prNumber, headSha: headSha.slice(0, 7),
            count: ssrfEmits.length,
            anchors: ssrfEmits.map((f) => `${f.path}:${f.line}`),
          }))
        }
      }
    }
    // Shadow-first gating for the deterministic path-traversal floor
    // (no-path-traversal, CWE-22) — same off/shadow/post contract.
    const pathTraversalMode = ensembleConfig.astScanModes.pathTraversal
    const pathTraversalStripped = applyAstScanGate(astResult, "no-path-traversal", pathTraversalMode)
    if (pathTraversalMode === "shadow" && pathTraversalStripped.length > 0) {
      console.log(JSON.stringify({
        event: "path-traversal-shadow",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        count: pathTraversalStripped.length,
        anchors: pathTraversalStripped.map((a) => `${a.path}:${a.line}`),
      }))
    }
    // Shadow-first gating for the deterministic SQL-injection floor
    // (no-sql-injection, CWE-89) — same off/shadow/post contract.
    const sqlInjectionMode = ensembleConfig.astScanModes.sqlInjection
    const sqlInjectionStripped = applyAstScanGate(astResult, "no-sql-injection", sqlInjectionMode)
    if (sqlInjectionMode === "shadow" && sqlInjectionStripped.length > 0) {
      console.log(JSON.stringify({
        event: "sql-injection-shadow",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        count: sqlInjectionStripped.length,
        anchors: sqlInjectionStripped.map((a) => `${a.path}:${a.line}`),
      }))
    }
    // Shadow-first gating for the deterministic SSTI floor (no-ssti, CWE-1336).
    const sstiMode = ensembleConfig.astScanModes.ssti
    const sstiStripped = applyAstScanGate(astResult, "no-ssti", sstiMode)
    if (sstiMode === "shadow" && sstiStripped.length > 0) {
      console.log(JSON.stringify({
        event: "ssti-shadow",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        count: sstiStripped.length,
        anchors: sstiStripped.map((a) => `${a.path}:${a.line}`),
      }))
    }
    // Shadow-first gating for the deterministic NoSQL-injection floor
    // (no-nosql-injection, CWE-943) — same off/shadow/post contract.
    const nosqlInjectionMode = ensembleConfig.astScanModes.nosqlInjection
    const nosqlInjectionStripped = applyAstScanGate(astResult, "no-nosql-injection", nosqlInjectionMode)
    if (nosqlInjectionMode === "shadow" && nosqlInjectionStripped.length > 0) {
      console.log(JSON.stringify({
        event: "nosql-injection-shadow",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        count: nosqlInjectionStripped.length,
        anchors: nosqlInjectionStripped.map((a) => `${a.path}:${a.line}`),
      }))
    }
    // Shadow-first gating for the deterministic prototype-pollution floor
    // (no-prototype-pollution, CWE-1321) — same off/shadow/post contract.
    const protoPollutionMode = ensembleConfig.astScanModes.protoPollution
    const protoPollutionStripped = applyAstScanGate(astResult, "no-prototype-pollution", protoPollutionMode)
    if (protoPollutionMode === "shadow" && protoPollutionStripped.length > 0) {
      console.log(JSON.stringify({
        event: "proto-pollution-shadow",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        count: protoPollutionStripped.length,
        anchors: protoPollutionStripped.map((a) => `${a.path}:${a.line}`),
      }))
    }
    // Shadow-first gating for the deterministic XXE floor
    // (no-xxe, CWE-611) — same off/shadow/post contract.
    const xxeMode = ensembleConfig.astScanModes.xxe
    const xxeStripped = applyAstScanGate(astResult, "no-xxe", xxeMode)
    if (xxeMode === "shadow" && xxeStripped.length > 0) {
      console.log(JSON.stringify({
        event: "xxe-shadow",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        count: xxeStripped.length,
        anchors: xxeStripped.map((a) => `${a.path}:${a.line}`),
      }))
    }

    // SIG-108: AST findings are split by roleHint inside buildFactsByRole
    // (below) so each block reaches only its own specialist.
    telemetry.astRules = astResult.telemetry.scanned
      ? {
          scanned: true,
          filesScanned: astResult.telemetry.filesScanned,
          filesSkippedLarge: astResult.telemetry.filesSkippedLarge,
          filesParseFailed: astResult.telemetry.filesParseFailed,
          findingsCount: astResult.findings.length,
          durationMs: astResult.telemetry.durationMs,
        }
      : {
          scanned: false,
          ...(astResult.telemetry.skipReason ? { skipReason: astResult.telemetry.skipReason } : {}),
          findingsCount: 0,
        }

    // ─── ARC-188: SARIF evidence channel ──────────────────────
    // Reads `.sigilix/trivy.sarif.json` (or configured path) at PR
    // head; emits Trivy / Kubescape / generic SARIF v2.1.0 findings
    // as authoritative facts alongside the other deterministic
    // blocks. SBOM (when present) goes to the synth prompt only.
    const sarifConfig = resolveSarifEvidenceConfig(sigilixConfig)

    // SIG-184 PR 3: runner-evidence consumption (flag-gated; off by default →
    // fully inert). In shadow/post we look up the VERIFIED receipt by the SIGNED
    // join `(repoId, prNumber)` and BIND it to the PR's current merge commit
    // (`meta.merge_commit_sha` == the OIDC-signed sha) — the forge-proof key. In
    // `post` we feed the receipt's SARIF to the SAME pipeline via `rawOverride`.
    const runnerMode = readRunnerEvidenceMode(env)
    // SIG-285 v2 PR1: receipt-join shares the SAME verified-receipt lookup as
    // runner-evidence, so the lookup must fire when EITHER feature is on —
    // otherwise enabling OPENCLAW_RECEIPTJOIN_MODE alone (with runner-evidence
    // off) would silently no-op (CodeRabbit). The runner-evidence-specific
    // outputs (the trust-pill badge + the adoption metric) stay gated on
    // `runnerMode` below; only the shared lookup is decoupled.
    const receiptJoinMode = ensembleConfig.flags.receiptJoinMode
    let runnerEvidence: RunnerEvidenceState = { state: "runner-absent" }
    // SIG-285 v2 PR1: the verified receipt's UN-FILTERED HEAD-scan index, built
    // below + joined to findings after submission (receipt-join verification).
    // null = no receipt-join (mode off, or no verified receipt for this commit).
    let receiptScanIndex: Map<string, ReceiptScanResult[]> | null = null
    if ((runnerMode !== "off" || receiptJoinMode !== "off") && args.repoId !== undefined) {
      const mergeSha = meta.merge_commit_sha
      runnerEvidence = mergeSha
        ? await lookupRunnerEvidence(env, String(args.repoId), prNumber, mergeSha)
        : { state: "evidence-pending", reason: "merge-sha-unavailable" } // GitHub still computing the merge
      console.log(JSON.stringify({
        event: "runner-evidence-consume",
        owner, repo, prNumber,
        mode: runnerMode,
        receiptJoinMode,
        state: runnerEvidence.state,
        ...(runnerEvidence.state === "evidence-pending" ? { reason: runnerEvidence.reason } : {}),
      }))
    } else if (receiptJoinMode !== "off" && args.repoId === undefined) {
      // Receipt-join is on but this entry path has no repoId, so the receipt
      // lookup was skipped → telemeter so these reviews are distinguishable from
      // "feature off" / "no verified receipt" in the rollout denominator (CodeRabbit).
      console.warn(JSON.stringify({ event: "receiptjoin-skipped-no-repoid", owner, repo, prNumber }))
    }
    // SIG-184: record the trust state for the check-run badge. Only in `post`
    // mode — that's when the receipt actually backs the review (verified →
    // receipt SARIF via rawOverride below; pending → runner configured but not
    // verified for this commit). In `shadow` the review uses the repo-pull SARIF
    // regardless, so a "verified" pill would overclaim; render no badge there.
    if (runnerMode === "post") {
      runnerEvidenceBadge =
        runnerEvidence.state === "verified" ? "verified"
        : runnerEvidence.state === "evidence-pending" ? "evidence-pending"
        : undefined
    }
    // SIG-184 PR 5b: presence telemetry — one increment per review in shadow/
    // post (a repoId-less review records `runner-absent`, so it still lands in
    // the adoption denominator). Best-effort: a failure must NEVER break the
    // review, and the DO RPC is bounded by a race-timeout (queue-consumer
    // ctx.waitUntil doesn't extend lifetime, and a signal-less RPC won't honor
    // an AbortSignal, so race is the correct bound). Read via GET
    // /metrics/runner-evidence.
    if (runnerMode !== "off") {
      let metricTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          recordRunnerEvidenceMetric(env, {
            owner, repo, prNumber,
            state: runnerEvidence.state,
            ...(runnerEvidence.state === "evidence-pending" ? { reason: runnerEvidence.reason } : {}),
          }),
          new Promise<never>((_, reject) => {
            metricTimer = setTimeout(() => reject(new Error("metric-record-timeout")), 1_500)
          }),
        ])
      } catch (err) {
        console.warn(JSON.stringify({ event: "runner-evidence-metric-record-failed", owner, repo, prNumber, error: String(err) }))
      } finally {
        if (metricTimer !== undefined) clearTimeout(metricTimer)
      }
    }
    const sarifResult = await runSarifEvidence({
      env, client, owner, repo, prNumber, headSha,
      diff, config: sarifConfig,
      // `post` + verified → scan the receipt's SARIF; else the repo-pull path.
      ...(runnerMode === "post" && runnerEvidence.state === "verified" ? { rawOverride: runnerEvidence.sarif } : {}),
    })
    const sarifFindings = sarifResult.skipped ? [] : sarifResult.findings
    deterministicCheckAnnotations = buildSarifCheckAnnotations(sarifFindings)
    // SIG-285 v2 PR1 (receipt-join, no-perm, shadow): when a VERIFIED receipt
    // exists, build the HEAD-scan index from the receipt's UN-FILTERED parseSarif
    // results — deliberately NOT `sarifResult.findings`, which runSarifEvidence
    // already diff/severity-filtered (a filtered-out result would read as a false
    // absence). Best-effort + bounded: any parse error leaves the index null
    // (→ the join no-ops) and never breaks the review.
    if (receiptJoinMode !== "off" && runnerEvidence.state === "verified") {
      try {
        const parsed = parseSarif(runnerEvidence.sarif)
        if (!parsed.ok) {
          // parseSarif reports malformed/unsupported receipts via {ok:false}
          // (it does NOT throw); telemeter so a bad receipt is distinguishable
          // from "no verified receipt" / "empty index" during rollout (CodeRabbit).
          console.warn(JSON.stringify({ event: "receiptjoin-index-build-skipped", owner, repo, prNumber, reason: parsed.reason }))
        } else {
          // Pure, unit-tested extraction (mirrors runner.ts path resolution).
          receiptScanIndex = buildReceiptIndex(
            extractReceiptScanResults(parsed.report.runs, normalizeSarifPath),
          )
        }
      } catch (err) {
        console.warn(JSON.stringify({ event: "receiptjoin-index-build-failed", owner, repo, prNumber, error: String(err) }))
      }
    }
    const sarifBlock = renderSarifFindingsForPrompt(sarifFindings)
    telemetry.sarifEvidence = sarifResult.skipped
      ? { skipped: true, reason: sarifResult.reason, findingsCount: 0 }
      : {
          skipped: false,
          findingsCount: sarifResult.findings.length,
          truncatedCount: sarifResult.telemetry.truncatedCount,
          durationMs: sarifResult.telemetry.durationMs,
        }

    // ARC-272: docs-coverage check. Zero-LLM, pure: takes the
    // PR's changed-file list + operator config and returns a hit
    // when architecture-impacting paths were touched without a
    // matching docs update. Runs BEFORE the prompt is built so the
    // hit becomes part of the authoritative-fact block fed to the
    // specialists + synth.
    //
    // `splitFiles` is the pre-`pathFilters` changed-file set — we
    // want every file the PR touched, not the post-filter subset
    // (the filter drops noise like lockfiles, but docs-coverage
    // wants to see architectural changes regardless of whether
    // they're reviewed).
    const docsReviewConfig = resolveDocsReviewConfig(sigilixConfig)
    const docsCoverageHit: DocsCoverageHit | null = runDocsCoverageCheck(
      splitFiles.map((f) => f.path),
      docsReviewConfig,
    )
    if (docsCoverageHit !== null) {
      console.log(JSON.stringify({
        event: "pr-review-docs-coverage-hit",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        architecture_files: docsCoverageHit.architectureFiles,
        doc_paths: [...docsCoverageHit.docPaths],
      }))
    }

    // ─── SIG-110: perf-budgets hot-path check ──────────────────
    // Opt-in (no-op until the operator declares `perfBudgets.hotPaths`).
    // Matched against the REVIEWABLE file set (post path-filter) so the
    // resulting `performance`-scoped fact only ever names files that are
    // actually in this review — a hot-path fact for a file absent from
    // the prompt diff would invite an inline finding that later fails
    // line validation. The hit primes the perf specialist; it does NOT
    // add a verdict finding here.
    const perfBudgetsConfig = resolvePerfBudgetsConfig(sigilixConfig)
    const perfBudgetsHit: PerfBudgetsHit | null = runPerfBudgetsCheck(
      filePaths,
      perfBudgetsConfig,
    )
    if (perfBudgetsHit !== null) {
      console.log(JSON.stringify({
        event: "pr-review-perf-budgets-hit",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        hot_path_files: perfBudgetsHit.hotPathFiles,
        matched_hot_paths: perfBudgetsHit.matchedHotPaths,
      }))
    }

    // ─── SIG-118: coverage-diff ingestion ──────────────────────
    // GATED OFF by default (`coverage.source: "off"`) — production is
    // unaffected until an operator opts in. When enabled, fetch the LCOV
    // coverage artifact from the head SHA's CI run, parse uncovered
    // lines, intersect with the PR's added lines, and feed the resulting
    // coverage-gap facts to the tests specialist. Best-effort + non-
    // fatal: `ingestCoverage` returns null on ANY failure (never throws),
    // so a coverage failure can never break a review. AWAITED here (not
    // in the allSettled block) because the tests fact block depends on
    // the result. Uses `diff` (the post-truncation prompt diff) for the
    // added-line set so a gap is only reported on a line the specialist
    // can actually see.
    const coverageConfig = resolveCoverageConfig(sigilixConfig)
    const coverageResult = coverageConfig.source !== "off"
      ? await ingestCoverage({ client, owner, repo, headSha, diff, config: coverageConfig })
      : null
    // Real coverage-gap set keyed `"<path>:<line>"` for the citation
    // gates. Empty when ingestion is off / yielded no gaps.
    const coverageGapSet = new Set<string>()
    for (const gap of coverageResult?.coverageGaps ?? []) {
      for (const ln of gap.lines) coverageGapSet.add(`${gap.path}:${ln}`)
    }
    {
      const gapsCount = coverageResult?.coverageGaps.reduce((n, g) => n + g.lines.length, 0) ?? 0
      console.log(JSON.stringify({
        event: "coverage-ingest",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        source: coverageConfig.source,
        runId: coverageResult?.meta.runId ?? null,
        artifactName: coverageConfig.source !== "off" ? coverageConfig.artifactName : null,
        gaps_count: gapsCount,
        skipped_reason: coverageConfig.source === "off"
          ? "disabled-config"
          : coverageResult === null
            ? "no-coverage"
            : null,
      }))
    }

    // ─── Fan out specialists ────────────────────────────────────
    const deterministicBlock = renderHitsForPrompt(deterministicHits)
    const secretScanBlock = renderSecretHitsForPrompt(secretHits)
    const docsCoverageBlock = renderDocsCoverageForPrompt(docsCoverageHit)
    const perfBudgetBlock = renderPerfBudgetsForPrompt(perfBudgetsHit)
    const coverageGapBlock = renderCoverageGapBlock(coverageResult?.coverageGaps ?? [])
    // SIG-108: security fact manifest — assigns each deterministic
    // security fact a hard-to-fabricate `evidenceId` (`tool:rule-id:
    // hash:line`). The render() block is folded into the security role's
    // facts (below) so the security specialist sees the citable ids; the
    // manifest Map is threaded to validateForSubmission so the citation
    // gate can cross-check each cited id against the real fact's path/line.
    const securityManifest = await buildSecurityFactManifest({
      secretHits,
      depVulnFindings,
      // M3 (review): scope SARIF to roleHint==="security" so the security
      // manifest never carries a logic/perf SARIF fact. All current SARIF
      // rules are security-domain, so this is a no-op today, but it makes
      // the contract explicit + matches how the AST findings are split.
      sarifFindings: sarifFindings.filter((f) => f.roleHint === "security"),
      astSecurityFindings: astResult.findings.filter((f) => f.roleHint === "security"),
    })
    // SIG-108: route deterministic facts to their owning specialist — no
    // cross-domain leak. Pure + unit-tested in role-scoped-facts.test.ts.
    // The SIG-91 diff-classification + ARC-182 stack blocks stay shared.
    // SIG-317 Part 4b: cross-function asymmetry hints for the LOGIC specialist —
    // a deterministic FACT (a mutator of table T that bypasses the aggregation
    // helper over T used elsewhere = a likely over-credit/over-refund) surfaced
    // for the model to judge, NOT a posted finding. Gated `off` (shadow) by
    // default: unlike a pure detector this NUDGES the specialist, so it carries
    // an induced-FP risk and ships shadow-first → measure → flip. `on` injects.
    // `asymmetryMode` is read above (it also gates the changed-files corpus load).
    let asymmetryBlock = ""
    if (asymmetryMode !== "off") {
      const asymmetryHints = analyzeHelperBypass(astFilesByPath)
      if (asymmetryHints.length > 0) {
        console.log(JSON.stringify({
          event: "pr-review-asymmetry-hints",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          mode: asymmetryMode,
          count: asymmetryHints.length,
          hints: asymmetryHints.map((h) => ({ fn: h.fn, helper: h.helper })),
        }))
        if (asymmetryMode === "on") asymmetryBlock = renderAsymmetryHints(asymmetryHints)
      }
    }
    // SIG-317 Part 4b-v2: TOCTOU / check-then-act race hints for the LOGIC
    // specialist — a deterministic FACT (a SELECT-of-C-then-separate-relative-
    // UPDATE-of-C with no atomic guard = a likely race) surfaced for the model to
    // judge, NOT a posted finding. Same shadow-first ladder as the asymmetry
    // injector: `shadow` logs the count, `on` injects.
    let toctouBlock = ""
    if (toctouMode !== "off") {
      const toctouHints = analyzeToctouRace(astFilesByPath)
      if (toctouHints.length > 0) {
        console.log(JSON.stringify({
          event: "pr-review-toctou-hints",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          mode: toctouMode,
          count: toctouHints.length,
          hints: toctouHints.map((h) => ({ fn: h.fn, table: h.table, column: h.column })),
        }))
        if (toctouMode === "on") toctouBlock = renderToctouHints(toctouHints)
      }
    }
    const factsByRole = buildFactsByRole({
      secretScanBlock,
      depVulnBlock,
      sarifBlock,
      deterministicBlock,
      docsCoverageBlock,
      coverageGapBlock,
      securityManifestBlock: securityManifest.render(),
      perfBudgetBlock,
      astFindings: astResult.findings,
      asymmetryBlock,
      toctouBlock,
    })
    void renderAstFindingsAsJsonForSynth // referenced by Task 8 synth wiring

    // ARC-181 Task 9: auto-inline poster — gated behind
    // `astRules.autoInline === true` AND mode === "post". Default-
    // false v1 cautious rollout; flips after 2 weeks of FP telemetry
    // shows < 5% rate.
    //
    // Posting is DEFERRED until the ensemble's own review submits
    // successfully (CR catch on PR #67) so an aborted run — stale
    // head SHA, synth_timeout, specialist failure-cascade — doesn't
    // leave orphan AST comments on a PR whose ensemble review never
    // landed. The closure captures everything we need; the two
    // submission-success paths below invoke it.
    const maybePostAstAutoInline = async (): Promise<void> => {
      if (mode !== "post") return
      if (!astRulesConfig.autoInline) return
      if (astResult.findings.length === 0) return
      try {
        await postAstInlineFindings({
          client,
          owner, repo, prNumber, headSha,
          findings: astResult.findings,
          perFindingPositions: astResult.perFinding,
        })
      } catch {
        // Swallowed — the poster's own try/catch already does this;
        // belt-and-suspenders so a poster bug never blocks the
        // ensemble's finalize.
      }
    }
    // ARC-182: compute stack context just before specialist fanout.
    // Stack detection is pure + cheap; the only async work is the
    // optional parent-files fetch when isStacked && parent. Render
    // a single stackBlock string and pass to BOTH specialist and
    // synth messages so they see the same context.
    const repoFullName = `${owner}/${repo}`
    const stack: StackContext = detectStack({
      currentPr: {
        number: prNumber,
        title: meta.title ?? "",
        headRef: meta.head?.ref ?? "",
        baseRef: meta.base?.ref ?? "",
        headRepo: repoFullName,
        baseRepo: repoFullName,
        author: meta.user?.login ?? null,
      },
      openPrs: openPrsForStack,
    })
    let stackOverlap: FileOverlap | undefined
    if (stack.isStacked && stack.parent) {
      const [currentFilesList, parentFilesList] = await Promise.all([
        // Reuse the diff-derived file list for the current PR — it's
        // already in memory (splitFiles) and the parent files fetch
        // is the only extra request.
        Promise.resolve(splitFiles.map((f) => ({ filename: f.path }))),
        client
          .listPullRequestFiles(owner, repo, stack.parent.number, { maxFiles: 100 })
          .catch(() => []),
      ])
      stackOverlap = computeFileOverlap({
        currentFiles: currentFilesList.map((f) => f.filename),
        parentFiles: parentFilesList.map((f) => f.filename),
      })
    }
    const stackBlock = stack.isStacked ? renderStackPromptBlock(stack, stackOverlap) : ""

    console.log(JSON.stringify({
      event: "pr-stack-context",
      owner, repo, prNumber,
      mode,
      isStacked: stack.isStacked,
      position: stack.position,
      depth: stack.depth,
      parentPrNumber: stack.parent?.number ?? null,
      childCount: stack.children.length,
      openPrCount: openPrsForStack.length,
      openPrsTruncated: openPrsForStack.length >= 200,
      cycleDetected: stack.cycleDetected,
      stackWalkCapped: stack.stackWalkCapped,
      hasUpstackFork: stack.hasUpstackFork,
      overlapShared: stackOverlap?.sharedCount ?? null,
      overlapCurrentOnly: stackOverlap?.currentOnlyCount ?? null,
    }))

    // SIG-91: classify the diff's file list (source / test / docs /
    // config / other) and resolve source ↔ test sibling pairs. The
    // tests specialist was firing false-positive "module ships without
    // tests" findings on PRs that DO add sibling tests (PRs #98, #100,
    // #104) because the prompt biased it to look for "no test files
    // changed" without grounding it on what's actually in the diff.
    // We render the classification as an authoritative block injected
    // before the diff so the model can't miss the pairing.
    //
    // Source list = the files that survived path filtering + batch
    // packing — i.e., the exact set the specialists actually see in
    // [DIFF]. Reporting classification on files dropped from [DIFF]
    // would mislead the model about what's available.
    const classifiedDiffFiles = classifyDiffFiles(reviewedFiles.map((f) => f.path))
    const diffFileClassificationBlock = renderDiffFileClassificationBlock(classifiedDiffFiles)

    // SIG-113: build the testing-evidence pack from the FULL diff
    // inventory (splitFiles, not reviewedFiles). Pre-SIG-113, the
    // classification block above used `reviewedFiles` only — the
    // first packed-diff batch — which produced 8 testing-completeness
    // false positives across PR #110 + PR #111 when test files lived
    // in later batches or were modified-not-added. The new pack uses
    // `splitFiles`, embeds the FULL CONTENT of added/modified test
    // files (subject to caps), and feeds the validator the
    // `inspectedTestFiles` list so the post-LLM citation gate can
    // drop unevidenced findings.
    //
    // Three-step build:
    //   1. Pure pack (deterministic, no I/O)
    //   2. Async fetch of test-file content via client.getFileContent
    //      (mirrors the AST source fetch pattern at line ~1227)
    //   3. Cap-application + merge → final pack with inspectedTestFiles
    // code-reviewer M1 catch (pre-PR): build from `filesAfterFilter`
    // (post-pathFilter, pre-batch) — NOT `splitFiles` (pre-filter).
    // Using `splitFiles` would re-surface operator-excluded files
    // (generated/, vendor/, etc.) in the evidence pack, inviting
    // missing-tests findings on paths the operator chose not to
    // review + wasting getFileContent fetches on them. The pack's
    // JSDoc contract says "post-filter, pre-batch" — this aligns the
    // call site with it. `filesAfterFilter` ⊇ `reviewedFiles` (the
    // batcher subsets it), so `testFilesNotInPromptDiff` still
    // correctly captures batch-dropped (not filter-dropped) tests.
    const testingEvidencePackInitial: TestingEvidencePack = buildTestingEvidencePack({
      splitFilePaths: filesAfterFilter.map((f) => f.path),
      reviewedFilePaths: reviewedFiles.map((f) => f.path),
    })
    const changedLineTextByPath = buildChangedLineTextByPath(fullPrDiff)
    const missingSiblingSources = testingEvidencePackInitial.siblingMappings
      .filter((m) => m.test === null)
      .map((m) => m.source)
    let repoPathsForTestingEvidence: string[] | undefined
    if (missingSiblingSources.length > 0) {
      let repoTreeStatus:
        | "ok"
        | "unavailable"
        | "missing-head-ref"
        | "branch-missing"
        | "head-ref-mismatch"
        | "tree-missing"
        | "tree-truncated"
        | "fetch-failed" = "unavailable"
      let repoTreePathsCount = 0
      const treeCapableClient = client as GitHubClient & {
        getBranch?: GitHubClient["getBranch"]
        getRepoTree?: GitHubClient["getRepoTree"]
      }
      const headRef = meta.head?.ref ?? ""
      if (
        typeof treeCapableClient.getBranch === "function" &&
        typeof treeCapableClient.getRepoTree === "function"
      ) {
        if (headRef.length === 0) {
          repoTreeStatus = "missing-head-ref"
        } else {
          try {
            const branch = await treeCapableClient.getBranch(owner, repo, headRef, {
              signal: orchCtrl.signal,
            })
            if (branch === null) {
              repoTreeStatus = "branch-missing"
            } else if (branch.headSha !== headSha) {
              repoTreeStatus = "head-ref-mismatch"
            } else {
              const tree = await treeCapableClient.getRepoTree(owner, repo, branch.treeSha, {
                signal: orchCtrl.signal,
              })
              if (tree === null) {
                repoTreeStatus = "tree-missing"
              } else if (tree.truncated) {
                repoTreeStatus = "tree-truncated"
              } else {
                repoPathsForTestingEvidence = tree.tree.flatMap((entry) =>
                  entry.type === "blob" && typeof entry.path === "string" && entry.path.length > 0
                    ? [entry.path]
                    : [],
                )
                repoTreePathsCount = repoPathsForTestingEvidence.length
                repoTreeStatus = "ok"
              }
            }
          } catch (err) {
            if (orchCtrl.signal.aborted) {
              console.warn(JSON.stringify({
                event: "tests-evidence-repo-tree-aborted",
                owner, repo, prNumber, headSha: headSha.slice(0, 7),
                error: err instanceof Error ? err.message : String(err),
              }))
              throw err
            }
            repoTreeStatus = "fetch-failed"
            console.warn(JSON.stringify({
              event: "tests-evidence-repo-tree-fetch-failed",
              owner, repo, prNumber, headSha: headSha.slice(0, 7),
              error: err instanceof Error ? err.message : String(err),
            }))
          }
        }
      }
      console.log(JSON.stringify({
        event: "tests-evidence-repo-tree-status",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        status: repoTreeStatus,
        missingSiblingSources_count: missingSiblingSources.length,
        repoTreePaths_count: repoTreePathsCount,
      }))
    }
    const testingEvidenceSuppression = filterTestingEvidenceForSuppressedMissingCoverage(
      testingEvidencePackInitial,
      {
        changedLineTextByPath,
        ...(repoPathsForTestingEvidence !== undefined ? { repoPaths: repoPathsForTestingEvidence } : {}),
      },
    )
    for (const suppression of testingEvidenceSuppression.suppressions) {
      if (suppression.reason === "repo-sibling-exists") {
        console.log(JSON.stringify({
          event: "tests-finding-suppressed-repo-sibling-exists",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          source: suppression.source,
          test: suppression.test ?? null,
        }))
      } else {
        console.log(JSON.stringify({
          event: "tests-finding-suppressed-comment-only-source",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          source: suppression.source,
        }))
      }
    }
    const testingEvidencePackFiltered = testingEvidenceSuppression.pack
    let testingEvidenceFetchResult: InspectedTestFileFetchResult = {
      contentByPath: {},
      failedPaths: [],
      budgetOmittedPaths: [],
      truncatedPaths: [],
      totalChars: 0,
    }
    let testingEvidenceFetchedCount = 0
    let testingEvidenceSkippedForBudgetCount = 0
    if (testingEvidencePackFiltered.testFilesChanged.length > 0) {
      const fetched = await fetchTestFileContentsWithBudget({
        paths: testingEvidencePackFiltered.testFilesChanged,
        fetchContent: async (p) => {
          const src = await client.getFileContent(owner, repo, p, headSha)
          if (typeof src !== "string") throw new Error("content unavailable")
          return src
        },
        concurrency: 5,
      })
      testingEvidenceFetchResult = fetched
      testingEvidenceFetchedCount = fetched.fetchedCount
      testingEvidenceSkippedForBudgetCount = fetched.skippedForBudgetCount
    }
    const testingEvidencePack = mergeInspectedTestFileContents(
      testingEvidencePackFiltered,
      testingEvidenceFetchResult,
    )
    const testingEvidencePackWithFocus = mergeTestingFocusHints(
      testingEvidencePack,
      buildAddedLineTextByLine(fullPrDiff),
      buildDeletedLineTextByLine(fullPrDiff),
    )
    // SIG-128: credit orchestrator glue whose changed logic delegates to
    // same-PR tested helpers. Uses `fullDiff` (the COMPLETE per-file patch)
    // for added-line text — NOT the truncated/first-batch `diff` — and the
    // already-fetched changed JS/TS head content (`astFilesByPath`). A source
    // missing from either input fails closed to "none" (never suppresses).
    // SIG-128 observability: when `astFilesByPath` is empty (e.g. all retrieval
    // flags off so no head content was fetched), every source fails closed to
    // "none" and this credits nothing — a future flag change must not silently
    // disable this path.
    const helperCoverage = detectHelperCoverage({
      filesByPath: astFilesByPath,
      addedLineTextByPath: buildAddedLineTextByLine(fullDiff),
      siblingMappings: testingEvidencePackFiltered.siblingMappings,
      testContentByPath: testingEvidenceFetchResult.contentByPath,
      astCache,
    })
    const testingEvidencePackWithCoverage = mergeHelperCoverage(
      testingEvidencePackWithFocus,
      helperCoverage.coverageBySource,
    )
    const testingEvidenceBlock = renderTestingEvidenceBlock(
      testingEvidencePackWithCoverage,
      testingEvidenceFetchResult,
    )

    // SIG-91 + SIG-113 telemetry — lets us verify post-deploy that
    // sibling pairs + the new evidence pack are being built from the
    // full diff inventory (not just the first batch).
    {
      const sourceFilesInDiff: string[] = []
      const testFilesInDiff: string[] = []
      const siblingMappingsDetected: Array<{ source: string; test: string }> = []
      for (const c of classifiedDiffFiles) {
        if (c.kind === "source") sourceFilesInDiff.push(c.path)
        if (c.kind === "test") testFilesInDiff.push(c.path)
        if (c.kind === "source" && c.testsSibling) {
          siblingMappingsDetected.push({ source: c.path, test: c.testsSibling })
        }
      }
      console.log(JSON.stringify({
        event: "tests-specialist-input-files",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        sourceFilesInDiff,
        testFilesInDiff,
        siblingMappingsDetected,
      }))
      // SIG-113: separate event for the new evidence pack so we can
      // monitor coverage of the full-inventory inspection independent
      // of the SIG-91 first-batch classification.
      console.log(JSON.stringify({
        event: "pr-review-testing-evidence-built",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        sourceFilesChanged_count: testingEvidencePackWithCoverage.sourceFilesChanged.length,
        testFilesChanged_count: testingEvidencePackWithCoverage.testFilesChanged.length,
        testFilesInPromptDiff_count: testingEvidencePackWithCoverage.testFilesInPromptDiff.length,
        testFilesNotInPromptDiff_count: testingEvidencePackWithCoverage.testFilesNotInPromptDiff.length,
        inspectedTestFiles_count: testingEvidencePackWithCoverage.inspectedTestFiles.length,
        testingFocusHints_count: testingEvidencePackWithCoverage.testingFocusHints?.length ?? 0,
        contentTotalChars: testingEvidenceFetchResult.totalChars,
        truncatedPaths_count: testingEvidenceFetchResult.truncatedPaths.length,
        failedFetchPaths_count: testingEvidenceFetchResult.failedPaths.length,
        fetchedPaths_count: testingEvidenceFetchedCount,
        skippedForBudgetPaths_count: testingEvidenceSkippedForBudgetCount,
      }))
    }

    // Dynamic review evidence (Greptile-style grounding): small cards around
    // changed symbols/regions that bundle local code, graph/retrieval
    // neighbors, and test context. Shadow mode computes coverage telemetry
    // only; post mode injects the cards into specialist + synth prompts.
    const dynamicEvidence = resolveDynamicEvidencePromptBlock({
      env,
      filesByPath: astFilesByPath,
      astCache,
      changedLines: buildChangedLines(diff),
      reviewablePaths: filePaths,
      retrievalChunks: sharedChunksForOverlap,
      graphNodes: graphContextNodesForEvidence,
      blastCallerPaths: graphBlastCallerPaths,
      blastDependentPaths: graphBlastDependentPaths,
      testingEvidence: testingEvidencePackWithCoverage,
    })
    const dynamicEvidenceBlockForPrompt = dynamicEvidence.promptBlock
    if (dynamicEvidence.pack !== null) {
      const dynamicEvidencePack = dynamicEvidence.pack
      const cardsWithGraph = dynamicEvidencePack.cards.filter((c) => c.graphRelations.length > 0).length
      const cardsWithRetrieval = dynamicEvidencePack.cards.filter((c) => c.retrievalRefs.length > 0).length
      const cardsWithTesting = dynamicEvidencePack.cards.filter((c) =>
        c.testingContext.siblingRefs.length > 0 ||
        c.testingContext.inspectedTestFiles.length > 0 ||
        c.testingContext.helperCoverageRefs.length > 0
      ).length
      console.log(JSON.stringify({
        event: "pr-review-dynamic-evidence",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        mode: dynamicEvidence.mode,
        files_scanned: dynamicEvidencePack.filesScanned,
        changed_files_with_sources: dynamicEvidencePack.changedFilesWithSources,
        cards: dynamicEvidencePack.cards.length,
        cards_with_graph: cardsWithGraph,
        cards_with_retrieval: cardsWithRetrieval,
        cards_with_testing: cardsWithTesting,
        rendered_chars: dynamicEvidence.rendered.length,
      }))
    }

    // SIG-108: build one message per role, injecting only that role's
    // scoped facts block (no cross-domain leak). The tests specialist
    // additionally gets the SIG-113 testing-evidence block (which
    // REPLACES the shared classification block); every other role gets
    // the shared SIG-91 classification block. guidance/profile/stack
    // remain shared. Messages are cached per role since each fan-out
    // path may request the same role's message more than once.
    const specialistMessageCache = new Map<SpecialistRole, string>()
    const messageForRole = (role: SpecialistRole): string => {
      const cached = specialistMessageCache.get(role)
      if (cached !== undefined) return cached
      const roleFacts = factsByRole[role]
      const message = buildSpecialistInitialMessage({
        prNumber,
        title: meta.title,
        body: meta.body ?? "",
        diff,
        // SIG-110: the performance role gets the perf-biased snapshot.
        // SIG-121: the logic role AUGMENTS the shared snapshot with the
        // symbol-derived block (empty when the flag is off, in which case
        // mergeLogicSnapshot returns the shared snapshot unchanged). Every
        // other role gets the shared preflight snapshot.
        retrievalSnapshot:
          role === "performance"
            ? selectRetrievalSnapshotForRole(role, perfRetrievalSnapshot, retrievalSnapshot)
            : role === "logic"
              ? mergeLogicSnapshot(retrievalSnapshot, logicSymbolSnapshot)
              : retrievalSnapshot,
        namespace,
        ...(sigilixConfig.guidance ? { guidance: sigilixConfig.guidance } : {}),
        ...(matchedPathInstructions.length > 0
          ? { pathInstructionsBlock: renderPathInstructionsForPrompt(matchedPathInstructions, role) }
          : {}),
        // SIG-172: directory-scoped + glob-scoped rules. Same block
        // for every role (no per-role splitting in v1) — the rules
        // are written by the repo owner with all four lenses in mind.
        ...(scopedRulesBlock.length > 0
          ? { scopedRulesBlock }
          : {}),
        ...(sigilixConfig.profile ? { profile: sigilixConfig.profile } : {}),
        ...(roleFacts.length > 0 ? { deterministicChecksBlock: roleFacts } : {}),
        ...(stackBlock.length > 0 ? { stackBlock } : {}),
        ...(role === "tests" && testingEvidenceBlock.length > 0
          ? { testingEvidenceBlock }
          : diffFileClassificationBlock.length > 0
            ? { diffFileClassificationBlock }
            : {}),
        // SIG-138 Phase 2: logic + tests specialists see graph neighbors
        // (post mode only; empty string when off or shadow).
        ...(graphCtxForPrompt.length > 0 && (role === "logic" || role === "tests")
          ? { graphContext: graphCtxForPrompt }
          : {}),
        ...(dynamicEvidenceBlockForPrompt.length > 0
          ? { dynamicEvidenceBlock: dynamicEvidenceBlockForPrompt }
          : {}),
      })
      specialistMessageCache.set(role, message)
      return message
    }

    // ARC-283 Phase B1b — shadow specialist fan-out. Fires BEFORE the
    // prod Promise.allSettled below so both lineups run in parallel
    // (NOT serially). Shadow shares prod's `orchCtrl.signal` — when
    // the outer orchestrator times out, shadow aborts with it. No
    // new wall-clock budget. The shadow promise never throws (the
    // runner catches + structures every failure path) but the
    // `finally`-block consumer still wraps the await in try/catch
    // to defend the prod return path.
    const shadowEnabledRoles = parseShadowEnabledRoles(env.SHADOW_BAKEOFF_ROLES)
    for (const role of router.specialists) {
      const shadowConfig = resolveShadowConfig(role, shadowEnabledRoles)
      if (shadowConfig === null) continue
      // ARC-283 Phase B1b CR-2: per-shadow AbortController, composed
      // with orchCtrl. Either source can abort the in-flight HTTP
      // request: orchCtrl when the outer 895s wall fires, the
      // per-shadow controller when the finally block decides the
      // shadow is past its grace cap. Without the per-shadow
      // controller, the cut-short emit was a pure log line and the
      // request kept consuming provider capacity.
      const shadowCtrl = new AbortController()
      shadowState.abortControllers.set(role, shadowCtrl)
      const composedSignal = composeSignals(orchCtrl.signal, shadowCtrl.signal)
      const shadowPromise = runShadowSpecialist({
        role,
        shadowConfig,
        apiKey: env.OLLAMA_API_KEY,
        systemPrompt: SPECIALIST_PROMPTS[role],
        // SIG-113: pick per-role initial message — tests specialist
        // gets the testing-evidence block, others get the
        // classification block.
        userMessage: appendRoleRule(messageForRole(role), role, sigilixConfig),
        chatEnabled: env.OLLAMA_CHAT_ENABLE === "on" ? "on" : "off",
        signal: composedSignal,
        perfCtx,
      }).finally(() => {
        // Settled (success OR runner-caught failure) — clear the
        // controller so the finally block's still-pending sweep
        // doesn't re-abort an already-finished call. Doesn't drop
        // the promise itself; the finally block still awaits to
        // emit comparison telemetry.
        shadowState.abortControllers.delete(role)
      })
      shadowState.specialistPromises.set(role, shadowPromise)
    }

    // ARC-284: track per-specialist start time so the fanout summary
    // can name the slowest role. The fan-out below waits for ALL to
    // settle by default; SIG-235 quorum collector below opt-in
    // early-exits when `N-1` of `N` succeed.
    const fanoutStartMs = Date.now()
    const perSpecialistStart = new Map<string, number>()
    const perSpecialistEnd = new Map<string, number>()
    for (const role of router.specialists) perSpecialistStart.set(role, Date.now())

    // SIG-236 — parse the logic-prompt-budget mode once per ensemble
    // so the per-role map below doesn't re-read env. `off` (the
    // default) skips the measurement+emit entirely. `shadow` /
    // `enforce` emit `logic-prompt-budget` telemetry once per
    // ensemble run with the logic role's full prompt size + per-
    // section breakdown.
    const logicPromptBudgetMode = ensembleConfig.flags.logicPromptBudgetMode

    // SIG-235 — min-specialists early exit. Build per-role
    // AbortControllers (mirroring the shadow path above) so the
    // quorum collector can cancel a single laggard's outstanding
    // attempts without affecting the others. composeSignals fires on
    // EITHER orchCtrl OR the per-role controller — same pattern as
    // the shadow path so the ladder cancels cleanly mid-attempt.
    const earlyExitMode = ensembleConfig.flags.minSpecialistsEarlyExitMode
    const prodSpecialistAbortControllers = new Map<SpecialistRole, AbortController>()
    // Tracks roles whose perSpecialistEnd has been frozen at the early-
    // exit cancel point. Used by the `.finally()` below to skip
    // overwriting an already-recorded end-time if the cancelled
    // promise eventually settles (race-hardening for any future await
    // between fan-out and `computeSpecialistFanoutSummary`).
    const earlyExitCancelledRoles = new Set<SpecialistRole>()
    type RolePromise = {
      role: SpecialistRole
      ctrl: AbortController
      promise: Promise<PromiseSettledResult<SpecialistRunResult>>
    }
    const rolePromises: RolePromise[] = router.specialists.map((role) => {
      const ctrl = new AbortController()
      prodSpecialistAbortControllers.set(role, ctrl)
      const composedSignal = composeSignals(orchCtrl.signal, ctrl.signal)
      // SIG-236: build the initialMessage ONCE per role so the
      // logic-prompt-budget measurement sees exactly what runSpecialist
      // sees, and we don't waste a second messageForRole + appendRoleRule
      // pass.
      let initialMessage = appendRoleRule(messageForRole(role), role, sigilixConfig)
      if (role === "logic") {
        // SIG-287/SIG-236: off→passthrough, shadow→measure-only, enforce→TRIM
        // the logic prompt to the cap (returns the prompt the model receives)
        // so logic stops timing out on its uniquely-large prompt. Belt-and-
        // suspenders try/catch (CR catch on PR #191): `applyLogicPromptBudget`
        // already fails open internally, but instrumentation MUST NOT break the
        // fan-out even if a future refactor removes the inner guard — on any
        // throw, fall back to the un-trimmed prompt (logic still runs).
        try {
          initialMessage = applyLogicPromptBudget({
            mode: logicPromptBudgetMode,
            prompt: initialMessage,
            owner, repo, prNumber, headSha,
          })
        } catch (err) {
          console.warn(JSON.stringify({
            event: "logic-prompt-budget-call-site-error",
            owner, repo, prNumber, headSha: headSha.slice(0, 7),
            message: err instanceof Error ? err.message : String(err),
          }))
        }
      }
      const promise = withComposedTimeout(
        // Use the composed signal `withComposedTimeout` provides — it
        // aborts on EITHER the per-specialist 270s timer OR the outer
        // orch abort OR the per-role early-exit abort. Passing
        // `orchCtrl.signal` directly only cancels the await wrapper,
        // leaving the in-flight model fetch alive until the outer
        // 490s wall fires (CR catch on PR #42).
        (signal) => runSpecialist({
          role,
          apiKey: env.OLLAMA_API_KEY,
          systemPrompt: SPECIALIST_PROMPTS[role],
          // SIG-113: tests specialist gets the testing-evidence
          // block; other specialists get the classification block.
          initialMessage,
          chatEnabled: env.OLLAMA_CHAT_ENABLE === "on" ? "on" : "off",
          signal,
          // ARC-283 Phase B1b: thread the orchestrator's perfCtx
          // through so per-attempt `model-attempt-completed` events
          // share correlation fields with the surrounding ensemble
          // telemetry.
          perfCtx,
        }),
        SPECIALIST_TIMEOUT_MS,
        composedSignal,
      ).finally(() => {
        // M2 race-hardening: only record end-time if the role's
        // end-time wasn't already frozen by the early-exit synthetic
        // entry. Today's flow is synchronous from fan-out to fanout-
        // summary so the race doesn't fire, but this prevents a
        // future await from triggering a late-set overwrite.
        if (!earlyExitCancelledRoles.has(role)) {
          perSpecialistEnd.set(role, Date.now())
        }
        prodSpecialistAbortControllers.delete(role)
      }).then(
        (value): PromiseSettledResult<SpecialistRunResult> => ({ status: "fulfilled", value }),
        (reason): PromiseSettledResult<SpecialistRunResult> => ({ status: "rejected", reason }),
      )
      return { role, ctrl, promise }
    })

    // SIG-235 quorum collector. Drains role promises one at a time;
    // when `N-1` of `N` have returned a non-null verdict AND mode is
    // "on", cancels the remaining role(s) and continues to synth.
    // Late verdicts from cancelled roles are logged + discarded.
    //
    // Modes:
    //   off    — pure Promise.all (legacy semantics, default)
    //   shadow — wait for all, but log when early-exit WOULD have fired
    //   on     — cancel laggard + proceed to synth as soon as N-1 succeed
    let specialistResults: PromiseSettledResult<SpecialistRunResult>[]
    let earlyExitFiredAtMs: number | null = null
    let cancelledRolesAtExit: SpecialistRole[] = []
    let earlyExitWouldFireAtMs: number | null = null
    // SIG-236: log the protected-role early-exit suppression at most once.
    let earlyExitProtectedLogged = false
    if (earlyExitMode === "off") {
      // Legacy: wait for everyone.
      specialistResults = await Promise.all(rolePromises.map((rp) => rp.promise))
    } else {
      const settledResults = new Map<SpecialistRole, PromiseSettledResult<SpecialistRunResult>>()
      // Each pending promise carries its role so Promise.race can
      // identify which one resolved without an index lookup.
      //
      // CodeRabbit catch (Major): the tracked-promise SELF-REMOVES
      // from `pending` in its `.then(...)` (microtask 1) so by the
      // time `Promise.race(...)` resumes the loop (microtask 2),
      // `pending` accurately reflects "still in-flight" — never
      // "in-flight OR just-settled-this-tick-but-not-yet-consumed."
      // Without this, a microtask burst where multiple specialists
      // resolve simultaneously can race-pick role A, leave already-
      // resolved roles B/C in `pending`, hit the early-exit threshold,
      // abort B/C via their AbortControllers, and synthesize null
      // verdicts for them — silently dropping real verdicts.
      const pending = new Map<SpecialistRole, Promise<{ role: SpecialistRole; result: PromiseSettledResult<SpecialistRunResult> }>>()
      for (const rp of rolePromises) {
        const tracked = rp.promise.then((result) => {
          pending.delete(rp.role)
          return { role: rp.role, result }
        })
        pending.set(rp.role, tracked)
      }
      const N = router.specialists.length
      const quorumThreshold = N - 1
      while (pending.size > 0) {
        const settled = await Promise.race(pending.values())
        // `pending.delete(settled.role)` already happened in the
        // `.then` above — `settledResults.set` records the result.
        settledResults.set(settled.role, settled.result)

        const succeededCount = Array.from(settledResults.values()).filter(
          (r) => r.status === "fulfilled" && r.value.verdict !== null,
        ).length

        // SIG-236: logic is the intentional long-pole (rich graph+symbol context,
        // ~110s per-attempt). It is a PROTECTED role — early-exit must NOT cancel
        // it, or flipping early-exit to "on" would silently re-break logic
        // availability (the regression this fix closes). Early-exit can still fire
        // to drop a genuinely stuck non-logic role. decideEarlyExitAction is the
        // pure, unit-tested decision.
        const logicProtectedPending =
          router.specialists.includes("logic") && pending.has("logic")
        const earlyExitAction = decideEarlyExitAction({
          mode: earlyExitMode,
          succeededCount,
          quorumThreshold,
          pendingCount: pending.size,
          logicProtectedPending,
        })
        if (earlyExitAction !== "none") {
          const nowMs = Date.now()
          if (earlyExitAction === "suppress-protected") {
            // Keep awaiting logic — its 110s per-attempt cap bounds it, not
            // early-exit. Fall through (no break) to the next Promise.race.
            if (!earlyExitProtectedLogged) {
              earlyExitProtectedLogged = true
              console.log(JSON.stringify({
                event: "ensemble-early-exit-suppressed-protected-role",
                owner, repo, prNumber,
                mode: "on",
                protectedRole: "logic",
                succeededRoles: Array.from(settledResults.entries())
                  .filter(([, r]) => r.status === "fulfilled" && r.value.verdict !== null)
                  .map(([role]) => role),
                pendingRoles: Array.from(pending.keys()),
                elapsedMsSinceFanoutStart: nowMs - fanoutStartMs,
              }))
            }
          } else if (earlyExitAction === "cancel") {
            earlyExitFiredAtMs = nowMs
            cancelledRolesAtExit = Array.from(pending.keys())
            // Abort the laggards' AbortControllers — composedSignal
            // propagates the cancel into the in-flight attempt.
            for (const rp of rolePromises) {
              if (pending.has(rp.role)) {
                rp.ctrl.abort()
                // Background watcher for the late-verdict-discard
                // event. Doesn't block the synth path.
                rp.promise
                  .then((result) => {
                    if (result.status === "fulfilled" && result.value.verdict !== null) {
                      console.log(JSON.stringify({
                        event: "ensemble-late-verdict-discarded",
                        owner, repo, prNumber,
                        role: rp.role,
                        attemptsUsed: result.value.attemptsUsed,
                        modelUsed: result.value.modelUsed,
                      }))
                    }
                  })
                  .catch(() => { /* discard cancellation errors */ })
              }
            }
            break
          } else if (earlyExitAction === "shadow-mark" && earlyExitWouldFireAtMs === null) {
            // Shadow: log the would-fire and keep awaiting. Only the
            // FIRST time the threshold is crossed (subsequent settles
            // would also satisfy `>= quorumThreshold` and we don't
            // need duplicate events).
            earlyExitWouldFireAtMs = nowMs
            console.log(JSON.stringify({
              event: "ensemble-min-specialists-early-exit-would-fire",
              owner, repo, prNumber,
              mode: "shadow",
              succeededRoles: Array.from(settledResults.entries())
                .filter(([, r]) => r.status === "fulfilled" && r.value.verdict !== null)
                .map(([role]) => role),
              pendingRoles: Array.from(pending.keys()),
              dispatchedRoles: router.specialists,
              elapsedMsSinceFanoutStart: nowMs - fanoutStartMs,
            }))
          }
        }
      }

      // Reassemble into router.specialists order so downstream
      // `collectSpecialistVerdicts(roles, results, ...)` zips correctly.
      // Cancelled-but-not-settled roles (only possible in "on" mode
      // after early-exit) get a synthetic null-verdict entry so the
      // [DEGRADED COVERAGE] block fires the same way as a legitimate
      // ladder-exhaust failure.
      //
      // `failureReason: "early_exit_aborted"` is intentional — the
      // collector's `timedOut: /abort/i || /timeout/i` regex at
      // `collectSpecialistVerdicts` line ~6327 catches it, so these
      // cancellations land in the same telemetry bucket as legitimate
      // timer/parent-signal aborts. Lets the `/metrics/validation`
      // dashboard treat early-exit cancels like timeouts (which they
      // structurally are — primary started but was forcibly stopped).
      //
      // `attemptsUsed: 1` is a conservative MINIMUM (CR catch). The
      // cancelled promise may have spent 1-3 attempts (primary +
      // optional retry + optional fallback) before the cancel
      // propagated, but synth-firing immediately means we can't
      // await the real count without losing the wall-time win that
      // motivates early-exit. Charging 1 acknowledges the primary
      // definitely started; undercount risk on retry/fallback paths
      // is bounded by the role's `maxAttempts()` and the daily-budget
      // gate already has slack from the worst-case
      // `MAX_CALLS_PER_ENSEMBLE_RUN` reservation.
      specialistResults = router.specialists.map((role) => {
        const r = settledResults.get(role)
        if (r !== undefined) return r
        earlyExitCancelledRoles.add(role)
        const startMs = perSpecialistStart.get(role) ?? Date.now()
        const nowMs = Date.now()
        perSpecialistEnd.set(role, nowMs)
        return {
          status: "fulfilled" as const,
          value: {
            verdict: null,
            modelUsed: SPECIALIST_CONFIGS[role].primary,
            attemptsUsed: 1,
            elapsedMs: nowMs - startMs,
            failureReason: "early_exit_aborted",
          } satisfies SpecialistRunResult,
        }
      })

      if (earlyExitFiredAtMs !== null) {
        const succeededRoles = Array.from(settledResults.entries())
          .filter(([, r]) => r.status === "fulfilled" && r.value.verdict !== null)
          .map(([role]) => role)
        console.log(JSON.stringify({
          event: "ensemble-min-specialists-early-exit-fired",
          owner, repo, prNumber,
          mode: "on",
          succeededRoles,
          cancelledRoles: cancelledRolesAtExit,
          dispatchedRoles: router.specialists,
          elapsedMsAtFire: earlyExitFiredAtMs - fanoutStartMs,
        }))
      }
    }
    const fanoutEndMs = Date.now()
    emitPhaseCompleted(perfCtx, "specialist_fanout", fanoutStartMs, fanoutEndMs)

    // Collect specialist verdicts (with stable IDs assigned).
    const specialistVerdicts = collectSpecialistVerdicts(
      router.specialists,
      specialistResults,
      telemetry,
    )

    // SIG-282 Phase 2: reconcile the security specialist's explicit
    // false-positive dismissals against the manifest and emit telemetry.
    // A dismissal is ACCEPTED only when its evidenceId resolves AND the
    // underlying fact is a dismissible (warn-level) candidate; a dismissal
    // aimed at a high-confidence provider hit is REJECTED + logged — a
    // possible real-secret wave-off worth a human's attention. This is
    // observability + a safety rail; Phase 1's framing already keeps the
    // false-positive finding from being emitted.
    const securityDismissals =
      specialistVerdicts.find((v) => v.role === "security")?.verdict?.dismissedScanFacts ?? []
    for (const d of securityDismissals) {
      const decision = evaluateScanFactDismissal(d, securityManifest.manifest)
      console.log(JSON.stringify({
        event: "pr-review-scan-fact-dismissed",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        evidenceId: d.evidenceId,
        ruleId: decision.ruleId,
        accepted: decision.accepted,
        rejectReason: decision.accepted ? null : decision.reason,
      }))
    }

    // SIG-308 Phase 2: telemeter the logic specialist's cleared candidates —
    // correctness concerns it refuted against an in-code mitigation instead of
    // emitting a finding. There is no manifest to reconcile against (logic
    // candidates are self-generated), so this is pure observability of the
    // cleared-rate; the recall safety rail is the Phase 3 backstop. Phase 1's
    // framing already keeps the refuted finding from being emitted.
    const clearedLogicCandidates =
      specialistVerdicts.find((v) => v.role === "logic")?.verdict?.clearedLogicCandidates ?? []
    for (const ev of buildClearedLogicCandidateTelemetry(clearedLogicCandidates, {
      owner, repo, prNumber, headSha,
    })) {
      console.log(JSON.stringify(ev))
    }

    // ARC-283 Phase B1b — snapshot per-role prod outcomes for the
    // shadow comparison emit in `finally`. Only writes for roles
    // that have a shadow promise queued; for everyone else we'd
    // never emit a comparison anyway. Reading from `specialistVerdicts`
    // (not `specialistResults`) so we get the same shape downstream
    // telemetry sees (stable-id-assigned verdict, dedupe-corrected
    // modelUsed). Findings are projected to the overlap-helper's
    // shape so the `finally` block stays a thin wrapper.
    for (const v of specialistVerdicts) {
      if (!shadowState.specialistPromises.has(v.role)) continue
      const findings: FindingForOverlap[] = v.verdict
        ? v.verdict.findings.map((f) => ({
            path: f.path,
            line: f.line,
            category: f.category,
            score: f.score,
          }))
        : []
      shadowState.prodSnapshots.set(v.role, {
        verdictOk: v.verdict !== null,
        modelUsed: v.modelUsed ?? SPECIALIST_CONFIGS[v.role].primary,
        attemptsUsed: v.attemptsUsed ?? 0,
        elapsedMs: v.elapsedMs,
        findings,
      })
    }

    // ARC-284 (Sigilix PR #95 catch): specialist-fanout-summary
    // computation moved into `computeSpecialistFanoutSummary` so the
    // slowestRole / fallbacksUsed / totalAttemptsUsed logic is unit-
    // testable. The orchestrator just maps its CollectedVerdict[] +
    // per-role timing into the helper's input shape.
    //
    // Emitted BEFORE the coverage / quorum gate below so the event
    // fires even on the "all specialists failed" bail path.
    {
      const summary = computeSpecialistFanoutSummary({
        dispatchedRoles: router.specialists,
        inputs: specialistVerdicts.map((v) => ({
          role: v.role,
          verdictOk: v.verdict !== null,
          attemptsUsed: v.attemptsUsed,
          modelUsed: v.modelUsed,
          fallbackModel: SPECIALIST_CONFIGS[v.role].fallback,
        })),
        perRoleStartMs: perSpecialistStart,
        perRoleEndMs: perSpecialistEnd,
        fanoutStartMs,
        fanoutEndMs,
      })
      emitSpecialistFanoutSummary(perfCtx, summary)
    }

    // ─── Coverage check (ARC-277) ──────────────────────────────
    //
    // Pre-ARC-277, this was a quorum gate that bailed to `skipped`
    // whenever fewer than min(2, dispatched.length) specialists
    // returned. The fall-back to Phase 3 plus the silent-success
    // bug chain that ARC-258 / ARC-275 chased made that gate the
    // single biggest contributor to "Sigilix went silent" reports.
    //
    // New contract:
    //   - 0/N succeeded: still bail to `skipped` (synth has
    //     nothing to merge from; will revisit in ARC-278 once
    //     synth retry + comment fallback land).
    //   - 1 ≤ succeeded < dispatched: continue to synth with a
    //     `[DEGRADED COVERAGE]` prompt block + structured
    //     telemetry. `checkQuorum` is no longer the gate.
    //   - succeeded === dispatched: full coverage, no prompt
    //     change, no degraded-coverage telemetry.
    const succeeded = specialistVerdicts.filter((v) => v.verdict !== null)
    if (succeeded.length === 0) {
      telemetry.fellBackToPhase3 = false  // ARC-280: Phase 3 deleted; this flag is now always false on every path
      telemetry.fellBackReason = "specialists_all_failed"
      // CR Minor catch on PR #92: name the roles the router
      // actually dispatched, since `specialists_all_failed` fires
      // whether 4/4 or 1/1 specialists failed.
      return bailWithSkipNotice("specialists_all_failed", {
        dispatchedRoles: router.specialists,
      })
    }
    const degradedCoverage = succeeded.length < router.specialists.length
      ? computeDegradedCoverage(router.specialists, succeeded.map((v) => v.role))
      : null
    if (degradedCoverage) {
      // Record the partial-coverage telemetry but DON'T bail. Synth
      // runs on the partial input + a degraded-coverage block in
      // the prompt.
      telemetry.fellBackReason = "specialists_degraded"
      telemetry.degradedCoverage = degradedCoverage
      console.log(JSON.stringify({
        event: "ensemble-specialists-degraded",
        owner, repo, prNumber,
        roles_returned: degradedCoverage.rolesReturned,
        roles_missing: degradedCoverage.rolesMissing,
      }))
    }

    // ─── SIG-228 Phase 3c: synth-bypass single-specialist hot path ─
    //
    // When the dispatcher returns exactly 1 specialist AND none of
    // that specialist's findings have `score >= 4` (major/critical),
    // skip the synthesizer LLM round-trip entirely. The specialist's
    // verdict IS the submission verdict — there's no cross-specialist
    // consensus to compute, and no major-severity finding that
    // benefits from synth-level rewriting.
    //
    // Saves ~15-25s on the hot path (the typical synth elapsed window
    // on `gpt-oss:120b-cloud`). Flag-gated behind
    // `OPENCLAW_SYNTH_BYPASS_ENABLED`; default-off in dev/test,
    // default-on in production (wrangler.toml).
    //
    // Reaches here only AFTER the `succeeded.length === 0` bail above
    // (line ~2894) — the bypass branch's `synthInputVerdicts[0]!`
    // assertion is safe by construction. If the order is ever flipped,
    // re-add a guard on the bypass branch.
    //
    // `synthInputVerdicts` is hoisted out so both the bypass path AND
    // the synth path read the same truncated verdicts. `truncateVerdictToTokens`
    // sorts findings by score DESC and pops from the end, so major
    // findings always survive truncation as long as any space remains.
    // The bypass eligibility check below intentionally reads from the
    // UNTRUNCATED `succeeded` array (not `synthInputVerdicts`) so that a
    // hypothetical extreme-token-pressure case dropping a `score >= 4`
    // finding can't sneak past the bypass gate — CR phase-end catch on
    // PR #188.
    const synthInputVerdicts = buildSynthInputVerdicts(succeeded)

    // Bypass eligibility: dispatched-count gate + succeeded-count gate
    // both live in the helper. The hot path is "dispatcher narrowed to
    // 1 specialist on purpose" — NOT "dispatcher fanned out to N, only
    // 1 returned." The latter is a degraded-coverage run where the
    // customer expected multiple perspectives; we MUST run synth there
    // so it can render the `[DEGRADED COVERAGE]` block and acknowledge
    // the gap.
    //
    // Evaluated against the untruncated `succeeded` array — see the
    // hoist comment above on `synthInputVerdicts` for why.
    //
    // HARD-DISABLE the bypass whenever synth shadow bake-off is
    // configured for this run. Otherwise flipping the bypass on would
    // silently halve the shadow synth signal on the bypass-eligible
    // population — exactly the cohort the bake-off measures. The
    // shadow comparator matters more than the bypass perf win during
    // the bake-off window; flip `SHADOW_BAKEOFF_ROLES` back to "" to
    // re-enable bypass.
    const synthBypassEligible =
      !shadowEnabledRoles.has("synth") &&
      isSynthBypassEligible(
        env,
        router.specialists.length,
        succeeded,
      )

    // Hoisted from the original synth section below so the bypass
    // path can populate them too — the post-synth validation code
    // reads from one source of truth regardless of which branch fired.
    //
    // `synthStartMs` is captured inside each branch so the metric stays
    // apples-to-apples vs pre-SIG-228 telemetry: synth branch starts
    // its clock right before the LLM call, bypass branch right before
    // its near-zero construction. Otherwise the synth-path elapsedMs
    // would silently accrete prompt-building + review-memory-lookup
    // time and overstate the bypass savings on rollout dashboards.
    let synthOutput: Awaited<ReturnType<typeof runSynthesizer>> | undefined
    let synthStartMs: number
    let synthAttemptsUsed = 0
    let synthRetryUsed = false
    let synthRetryOutcome: "n/a" | "ok" | "timeout" | "parse" | "provenance" | "exhausted-budget" = "n/a"
    // SIG-276 Phase 3: the injected memories captured in the synth-path
    // scope (where `reviewMemoryResult` is alive) so the Site-2 shadow
    // matcher — which runs later, in the outer post-synth scope — can read
    // them. Stays [] on the synth-bypass branch (no memory injection there).
    let shadowMemoriesForPhase3: ReviewMemoryFinding[] = []

    if (synthBypassEligible) {
      synthStartMs = Date.now()
      // Bypass: construct a synth-equivalent output directly from the
      // single specialist's truncated verdict. The provenance entries
      // declare every kept finding as sourced from that one specialist
      // with `action: "kept"` — the only legal shape when synth never
      // ran. The `modelUsed` sentinel lets telemetry consumers
      // distinguish bypass elapsed-ms from real synth elapsed-ms.
      //
      // Known tradeoffs (M2/M3 from code-reviewer): the bypass also
      // skips synth's contextual signals — AST supersession (drops
      // specialist findings that share `(path, line, role_hint)` with
      // a deterministic AST entry), SARIF Fix-Plan ordering, GRAPH
      // CONTEXT contradiction, REVIEW MEMORY softening, and the
      // unified PR-wide summary rewrite. On the 1-role no-major hot
      // path those signals are typically empty or low-signal; on a
      // 1-role + populated-AST/SARIF/memory PR they would actually
      // do useful work. Worth filing a follow-up to either disable
      // bypass when those blocks are non-empty OR fold a minimal
      // post-bypass supersession pass.
      const sole = synthInputVerdicts[0]!
      const verdict = sole.verdict
      synthOutput = {
        verdict,
        provenance: {
          findings: verdict.findings.map((f) => ({
            sourceSpecialists: [sole.role],
            sourceFindingIds: [f.id],
            action: "kept" as const,
            verifiedViaRetrieval: false,
          })),
          dropped: [],
        },
        // `elapsedMs: 0` here is overwritten by `synthEntry.elapsedMs =
        // Date.now() - synthStartMs` below; kept as a defensive stub
        // so callers reading `synthOutput.elapsedMs` directly (vs
        // via the telemetry entry) never see undefined.
        elapsedMs: 0,
        modelUsed: "synth-bypass-single-specialist",
        attemptsUsed: 0,
      }
      telemetry.synthBypass = {
        reason: "single_specialist_no_major",
        specialistRole: sole.role,
        findingCount: verdict.findings.length,
      }
      // Set reviewMemory + synthRetry explicitly for telemetry parity
      // with the synth path — bypass produces a shape that rollout
      // dashboards can filter for without ambiguity.
      // `reason: "retrieval-disabled-config"` is the closest
      // ReviewMemorySkipReason that captures "the bypass path
      // skipped review memory by configuration choice" (the synth-
      // bypass IS a configuration choice).
      telemetry.reviewMemory = {
        skipped: true,
        reason: "retrieval-disabled-config",
        findingsCount: 0,
      }
      telemetry.synthRetry = { used: false, outcome: "n/a" }
      console.log(JSON.stringify({
        event: "ensemble-synth-bypassed",
        owner, repo, prNumber,
        role: sole.role,
        findingCount: verdict.findings.length,
      }))
    } else {
      synthStartMs = Date.now()

    // ─── Synthesizer ───────────────────────────────────────────
    const synthVerdictBlock = renderSpecialistVerdictsForSynth(synthInputVerdicts)
    const synthMessage = buildSynthesizerInitialMessage({
      prNumber,
      diff,
      specialistVerdictsBlock: synthVerdictBlock,
      ...(sigilixConfig.guidance ? { guidance: sigilixConfig.guidance } : {}),
      ...(matchedPathInstructions.length > 0
        ? { pathInstructionsBlock: renderPathInstructionsForPrompt(matchedPathInstructions) }
        : {}),
      ...(stackBlock.length > 0 ? { stackBlock } : {}),
      // ARC-277: when one or more specialists didn't return, tell
      // synth which roles it's missing so it can constrain its
      // output and acknowledge the gap in `summary`.
      ...(degradedCoverage ? { degradedCoverage } : {}),
      // SIG-138 Phase 2: synth sees graph neighbors in post mode.
      ...(graphCtxForPrompt.length > 0 ? { graphContext: graphCtxForPrompt } : {}),
      ...(dynamicEvidenceBlockForPrompt.length > 0
        ? { dynamicEvidenceBlock: dynamicEvidenceBlockForPrompt }
        : {}),
    })

    // ARC-181 Task 8: thread structured AST findings into the synth
    // prompt for (path, line, role_hint) supersession matching.
    const astFindingsForSynth = renderAstFindingsAsJsonForSynth(astResult.findings)
    // SIG-245: only instruct supersession-and-drop when the AST version will be
    // posted (autoInline ON). With it OFF (default) the drop silently loses
    // double-detected real findings — see buildAstFindingsSynthBlock.
    const synthMessageWithAst =
      synthMessage + buildAstFindingsSynthBlock(astFindingsForSynth, astRulesConfig.autoInline)

    // ARC-188: append SARIF structured findings + SBOM summary on
    // top of the AST-augmented prompt. Synth gets the machine-
    // readable JSON for Fix Plan ordering (direct-dep findings
    // outrank deep-transitive). Empty when no SARIF run + no SBOM.
    const sarifSynthBlock = renderSarifFindingsAsJsonForSynth(
      sarifFindings,
      sarifResult.skipped ? undefined : sarifResult.sbom,
    )
    const synthMessageWithSarif = sarifSynthBlock.length > 0
      ? `${synthMessageWithAst}\n\n[SARIF EVIDENCE — synth-only structured]\n\n\`\`\`\n${sarifSynthBlock}\n\`\`\``
      : synthMessageWithAst

    // ─── ARC-189: cross-PR review-memory injection ────────────
    // Synth-only (specialists do NOT see this block — we want them to
    // surface the finding and let synth decide whether to soften).
    // Gates per spec §5.2 truth table: env=on AND sigilix.json
    // enabled=true. Lookup pipeline does its own gate-check; this
    // outer guard avoids paying the (cheap) lookup cost when
    // disabled.
    const reviewMemoryConfig = resolveReviewMemoryConfig(sigilixConfig)
    const reviewMemoryResult = await runReviewMemoryLookup({
      env, owner, repo, prNumber,
      paths: filePaths,
      config: reviewMemoryConfig,
      // SIG-247 Phase 1: thread the immutable repo.id so the lookup
      // hits the dual-write keyspace. When absent (legacy queue
      // message / slash-command raw-send), the lookup degrades to
      // legacy-only reads and the canary telemetry `key_mode` field
      // surfaces the gap.
      ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
    })
    const memoryBlock = reviewMemoryResult.skipped
      ? ""
      : renderReviewMemoryForPrompt(reviewMemoryResult.findings)
    // SIG-276 Phase 3: hand the injected memories (which carry telemetry
    // `shadowClaims` when the shadow flag is on) to the outer-scope holder
    // for the Site-2 shadow matcher. Telemetry-only; never affects the
    // prompt or softening.
    shadowMemoriesForPhase3 = reviewMemoryResult.skipped
      ? []
      : reviewMemoryResult.findings
    // Codex BLOCKING on plan v2: gate the append on memoryBlock
    // length, NOT sarifBlock length. The two blocks are independent.
    const synthMessageWithMemory = memoryBlock.length > 0
      ? `${synthMessageWithSarif}\n\n${memoryBlock}`
      : synthMessageWithSarif
    telemetry.reviewMemory = reviewMemoryResult.skipped
      ? {
          skipped: true,
          reason: reviewMemoryResult.reason,
          findingsCount: 0,
        }
      : {
          skipped: false,
          findingsCount: reviewMemoryResult.findings.length,
          memoriesInjected: reviewMemoryResult.findings.length,
          durationMs: reviewMemoryResult.durationMs,
        }

    // Phase 4a.1: distinguish synth-local timeout from outer-orch abort.
    // Without this, `withComposedTimeout` rejection on synth's own 180s
    // timer bubbles to the outer catch and is recorded as
    // `internalError: "Operation aborted"` with `synthesizer: null` —
    // the spec promised `synthesizer.timedOut: true` for this case.
    //
    // SIG-228 Phase 3c: `synthOutput`, `synthStartMs`, `synthRetryUsed`,
    // `synthRetryOutcome` + `synthAttemptsUsed` are now declared in
    // outer scope (just before the bypass-or-synth branch above) so
    // both paths populate the same identifiers.
    // ARC-278 (CR catch on PR #90): runSynthesizer wraps
    // runWithRetryAndFallback, which already does its own internal
    // primary+retry+fallback. So `attempt.attemptsUsed` from a single
    // outer call can be 1, 2, or 3+. Accumulate the real count across
    // BOTH attempts (and across a local timeout, where the outer call
    // never returned attemptsUsed at all — treat as 1).
    // This feeds `finalize()`'s daily-budget charge; under-counting
    // here would under-charge the budget and over-count head-room.
    //
    // SIG-228 Phase 3c: hoisted to outer scope (see comment block at
    // the top of the bypass-or-synth branch above).
    try {
      // ARC-185: per-PR commands.review.{prompt.addendum, model.{primary,
      // fallbacks}} override. Specialists left untouched on the v3.1
      // LOCKED lineup. v1 limitation: ModelConfig.fallback is a single
      // string — only the first user-supplied fallback reaches the
      // synth runtime. Telemetry records the dropped count.
      const reviewCmdConfig = resolveCommandConfig(sigilixConfig, "review")
      const synthSystemPrompt = reviewCmdConfig.promptAddendum
        ? `${SYNTHESIZER_PROMPT}\n\n[REPO-SPECIFIC GUIDANCE]\n${reviewCmdConfig.promptAddendum}`
        : SYNTHESIZER_PROMPT
      const synthConfigOverride: ModelConfig | undefined = (
        reviewCmdConfig.modelPrimary !== null ||
        reviewCmdConfig.modelFallbacks.override
      )
        ? {
            primary: reviewCmdConfig.modelPrimary ?? SYNTHESIZER_CONFIG.primary,
            retries: SYNTHESIZER_CONFIG.retries,
            fallback: reviewCmdConfig.modelFallbacks.override
              ? (reviewCmdConfig.modelFallbacks.models[0] ?? SYNTHESIZER_CONFIG.fallback)
              : SYNTHESIZER_CONFIG.fallback,
          }
        : undefined
      if (
        reviewCmdConfig.promptAddendum !== null ||
        reviewCmdConfig.modelPrimary !== null ||
        reviewCmdConfig.modelFallbacks.override
      ) {
        console.log(JSON.stringify({
          event: "command-config-resolved",
          owner, repo, prNumber,
          command: "review",
          hasPromptAddendum: reviewCmdConfig.promptAddendum !== null,
          modelPrimary: reviewCmdConfig.modelPrimary,
          modelFallbacksCount: reviewCmdConfig.modelFallbacks.override
            ? reviewCmdConfig.modelFallbacks.models.length
            : 0,
        }))
      }

      // ARC-283 Phase B1b — shadow synth kick-off. Fires BEFORE
      // `attempt1` so both lineups run in parallel; the shadow
      // promise is captured at the outer scope so `finally` can
      // settle it even when prod synth bails to skip-notice.
      // Same `synthSystemPrompt` + `synthMessageWithMemory` the prod
      // path uses, so the comparison is apples-to-apples on input.
      // Shadow shares `orchCtrl.signal` — aborts with the outer
      // orchestrator timer. The shadow synth is allowed to take
      // longer than the prod synth's 420s budget; what bounds it
      // is the 895s outer orchestrator wall.
      const shadowSynthConfig = resolveShadowConfig("synth", shadowEnabledRoles)
      if (shadowSynthConfig !== null) {
        // ARC-283 Phase B1b CR-2: per-shadow synth AbortController,
        // same pattern as the specialist fan-out above. Lets the
        // finally block cancel an in-flight synth shadow when the
        // grace deadline fires instead of leaving the request to
        // burn provider capacity invisibly.
        const shadowSynthCtrl = new AbortController()
        shadowState.abortControllers.set("synth", shadowSynthCtrl)
        const composedSynthSignal = composeSignals(orchCtrl.signal, shadowSynthCtrl.signal)
        shadowState.synthPromise = runShadowSynth({
          shadowConfig: shadowSynthConfig,
          apiKey: env.OLLAMA_API_KEY,
          systemPrompt: synthSystemPrompt,
          userMessage: synthMessageWithMemory,
          chatEnabled: env.OLLAMA_CHAT_ENABLE === "on" ? "on" : "off",
          signal: composedSynthSignal,
          perfCtx,
        }).finally(() => {
          shadowState.abortControllers.delete("synth")
        })
      }

      // ARC-278: extract the attempt-runner so we can call it twice
      // (primary + at most one retry). The closure captures every
      // input that's stable between attempts (system prompt, config
      // override, env, orchCtrl); only `userMessage` and `timeoutMs`
      // vary per call. Returns null on local timeout (so callers
      // don't have to discriminate between catch and `failureReason:
      // "aborted"` shapes). Re-throws on orchestrator-wall abort.
      const attemptSynth = async (
        userMessage: string,
        timeoutMs: number,
      ): Promise<Awaited<ReturnType<typeof runSynthesizer>> | null> => {
        try {
          return await withComposedTimeout(
            // Use the composed signal so a synth-only timeout actually
            // cancels the underlying model call. Passing `orchCtrl.signal`
            // directly only rejects this await; the in-flight model fetch
            // would keep running until the outer 490s orch wall fires
            // (CR catch on PR #42).
            (signal) => runSynthesizer({
              apiKey: env.OLLAMA_API_KEY,
              systemPrompt: synthSystemPrompt,
              userMessage,
              chatEnabled: env.OLLAMA_CHAT_ENABLE === "on" ? "on" : "off",
              signal,
              // ARC-283 Phase B1b: same correlation context as the
              // specialist fan-out above.
              perfCtx,
              ...(synthConfigOverride ? { configOverride: synthConfigOverride } : {}),
            }),
            timeoutMs,
            orchCtrl.signal,
          )
        } catch (err) {
          // Orchestrator-wall abort propagates — that's the
          // internal_error path. Synth-local timer is a local
          // failure: return null so the retry path can run.
          if (orchCtrl.signal.aborted) throw err
          return null
        }
      }

      const attempt1 = await attemptSynth(synthMessageWithMemory, SYNTHESIZER_TIMEOUT_MS)
      synthOutput = attempt1 ?? undefined
      // attempt1 === null → local timeout, runSynthesizer never returned
      // anything; charge 1 for the in-flight call. attempt1 !== null →
      // trust the inner retry/fallback count.
      synthAttemptsUsed += attempt1?.attemptsUsed ?? 1
      const attempt1Outcome = classifySynthOutcome(synthOutput, attempt1 === null)

      // ARC-278: if the primary attempt failed in a way we can
      // retry, run one more attempt with a tightened prompt hint.
      // Retry budget is bounded by SYNTHESIZER_RETRY_TIMEOUT_MS
      // (which fits inside RESERVED_HEADROOM_MS, per the static
      // invariant at module load). On retry success → telemetry
      // logs which path recovered; on retry failure → existing
      // failure-handling code below still fires.
      if (attempt1Outcome !== "ok") {
        synthRetryUsed = true
        const retryUserMessage = buildSynthRetryMessage(synthMessageWithMemory, attempt1Outcome)
        console.log(JSON.stringify({
          event: "synth-retry-dispatched",
          owner, repo, prNumber,
          attempt1_outcome: attempt1Outcome,
        }))
        const attempt2 = await attemptSynth(retryUserMessage, SYNTHESIZER_RETRY_TIMEOUT_MS)
        synthOutput = attempt2 ?? undefined
        // Same attempts-accounting rationale as attempt1 above.
        synthAttemptsUsed += attempt2?.attemptsUsed ?? 1
        const attempt2Outcome = classifySynthOutcome(synthOutput, attempt2 === null)
        synthRetryOutcome = attempt2Outcome
        console.log(JSON.stringify({
          event: "synth-retry-completed",
          owner, repo, prNumber,
          attempt1_outcome: attempt1Outcome,
          retry_outcome: attempt2Outcome,
          recovered: attempt2Outcome === "ok",
        }))
      }
    } catch (err) {
      // If the orchestrator's outer signal aborted, propagate — outer
      // timeout is a genuine internal_error and lands in the top-level
      // catch as before.
      if (orchCtrl.signal.aborted) throw err
      // Defensive: any other unexpected throw from the attempt-runner
      // gets recorded as a synth-local timeout (same shape as the
      // pre-ARC-278 behavior). Should be unreachable since
      // attemptSynth handles its own catch — but kept as a safety
      // net so a future refactor that surfaces a thrown exception
      // doesn't crash the dispatcher.
      telemetry.synthesizer = {
        model: SYNTHESIZER_MODEL,
        modelUsed: SYNTHESIZER_MODEL,
        // Defensive catch-block — `synthAttemptsUsed` may or may not
        // have been incremented depending on which await threw.
        // Fall back to a minimum of 1 if accounting got skipped.
        attemptsUsed: Math.max(1, synthAttemptsUsed),
        verdict: null,
        provenance: null,
        elapsedMs: Date.now() - synthStartMs,
        timedOut: true,
        failureReason: "synth_timeout",
      }
      telemetry.synthRetry = { used: synthRetryUsed, outcome: synthRetryOutcome }
      telemetry.fellBackToPhase3 = false  // ARC-280: Phase 3 deleted; this flag is now always false on every path
      telemetry.fellBackReason = "synth_timeout"
      return bailWithSkipNotice("synth_timeout")
    }

    // ARC-278: persist the retry telemetry regardless of which path
    // wins below. Done BEFORE the post-call processing so even
    // happy-path success carries `synthRetry: { used: false,
    // outcome: "n/a" }` for stable rollout analysis.
    telemetry.synthRetry = { used: synthRetryUsed, outcome: synthRetryOutcome }

    // ARC-278: if both attempts locally timed out, synthOutput is
    // undefined here. Synthesize a stub entry that matches the
    // pre-ARC-278 "synth-local timeout caught in the outer catch"
    // shape so the failure-handling code below stays uniform.
    if (synthOutput === undefined) {
      telemetry.synthesizer = {
        model: SYNTHESIZER_MODEL,
        modelUsed: SYNTHESIZER_MODEL,
        // CR catch on PR #90: trust the accumulated count from
        // attempt1.attemptsUsed (+ attempt2.attemptsUsed if retry
        // ran). Local-timeout branches charge 1 per missed
        // returned-attempt count, so the minimum is correctly 1 for
        // a single-attempt timeout, 2 for primary-then-retry both
        // locally timing out.
        attemptsUsed: Math.max(1, synthAttemptsUsed),
        verdict: null,
        provenance: null,
        elapsedMs: Date.now() - synthStartMs,
        timedOut: true,
        failureReason: "synth_timeout",
      }
      telemetry.fellBackToPhase3 = false  // ARC-280: Phase 3 deleted; this flag is now always false on every path
      telemetry.fellBackReason = "synth_timeout"
      return bailWithSkipNotice("synth_timeout")
    }
    } // SIG-228 Phase 3c: close the `else { /* synth path */ }` opened
      // above the prompt-building block.

    // Phase 4a.2: withComposedTimeout no longer throws when its own
    // timer or the orch signal aborts an abort-aware factory — it
    // returns the factory's structured wrapFailure with
    // failureReason="aborted". That now reaches this branch instead of
    // the synth_timeout catch above, so derive timedOut + fellBackReason
    // here too. Without this, synth-timer aborts would silently land in
    // synth_failed_parse with timedOut=false (CR catch on PR #44).
    const synthFailureReason = synthOutput.failureReason ?? ""
    const synthAborted = /abort/i.test(synthFailureReason) || /timeout/i.test(synthFailureReason)

    const synthEntry: NonNullable<EnsembleTelemetry["synthesizer"]> = {
      model: SYNTHESIZER_MODEL,
      modelUsed: synthOutput.modelUsed,
      // ARC-278 (CR catch on PR #90): use the accumulated count.
      // `synthAttemptsUsed` sums each outer-attempt's inner
      // attemptsUsed (where each is itself
      // primary+retry+cross-provider-fallback inside
      // runWithRetryAndFallback). The previous `+ 1` undercounted
      // whenever the inner retry/fallback fired.
      attemptsUsed: synthAttemptsUsed > 0 ? synthAttemptsUsed : synthOutput.attemptsUsed,
      verdict: synthOutput.verdict,
      provenance: synthOutput.provenance,
      elapsedMs: Date.now() - synthStartMs,
      timedOut: synthAborted,
    }
    if (synthOutput.failureReason) synthEntry.failureReason = synthOutput.failureReason
    if (synthOutput.failureRawAnswer) synthEntry.failureRawAnswer = synthOutput.failureRawAnswer
    telemetry.synthesizer = synthEntry

    if (!synthOutput.verdict || !synthOutput.provenance) {
      telemetry.fellBackToPhase3 = false  // ARC-280: Phase 3 deleted; this flag is now always false on every path
      const synthFailReason: SkipNoticeReason = synthAborted
        ? "synth_timeout"
        : synthOutput.failureReason === "synth_invalid_provenance"
          ? "synth_invalid_provenance"
          : "synth_failed_parse"
      telemetry.fellBackReason = synthFailReason
      return bailWithSkipNotice(synthFailReason)
    }

    // ARC-284: phase + synth summary fire on the SUCCESS join. Failure
    // paths above (`return bailWithSkipNotice(...)`) skip these — the
    // skip-notice event captures the bail reason; synth-summary is
    // scoped to "synth produced a usable verdict."
    emitPhaseCompleted(perfCtx, "synth", synthStartMs)
    {
      const inputFindingCount = synthInputVerdicts.reduce(
        (sum, v) => sum + (v.verdict?.findings.length ?? 0),
        0,
      )
      const summary: SynthSummary = {
        elapsedMs: Date.now() - synthStartMs,
        attemptsUsed: synthAttemptsUsed > 0 ? synthAttemptsUsed : synthOutput.attemptsUsed,
        retryUsed: synthRetryUsed,
        // ARC-284 Sigilix-PR-#95 catch: coercion extracted to
        // `narrowSynthRetryOutcome` for unit-testability. Collapses
        // the orchestrator-internal `"n/a"` and `"exhausted-budget"`
        // sentinels to `null` for the telemetry contract.
        retryOutcome: narrowSynthRetryOutcome(synthRetryUsed, synthRetryOutcome),
        inputSpecialistCount: synthInputVerdicts.length,
        inputFindingCount,
        outputFindingCount: synthOutput.verdict.findings.length,
        modelUsed: synthOutput.modelUsed,
      }
      emitSynthSummary(perfCtx, summary)
    }

    // ─── SIG-287: degraded-coverage finding floor ──────────────
    // On a degraded run (a dispatched specialist — in practice `logic` —
    // timed out), the synth can shrug: emit a low-confidence verdict that
    // DROPS what the surviving specialists found (PR #218: synth emitted 0
    // findings while `performance` had a real score-2 finding). The event
    // downgrade (#219) already stops a degraded review from posting a
    // confident APPROVE; this re-injects the score>=2 findings the synth
    // dropped so the partial COMMENT shows what was actually found, rather
    // than an empty "partial review". Re-injected findings flow through the
    // SAME post-synth pipeline below (validators, anchor repair, withdrawal
    // suppression, inline-grounding, score-1 demotion) — nothing is force-
    // posted. Only runs when degraded; full-coverage reviews are untouched.
    // `synthOutput.verdict`/`.provenance` are non-null here (the bail above
    // returns otherwise). Capture into locals so the floor can replace them
    // for validation WITHOUT reassigning `synthOutput` (which would widen its
    // type back to nullable + perturb the downstream soften path that reads
    // `synthOutput.provenance.softened`).
    let effectiveSynthVerdict = synthOutput.verdict
    let effectiveSynthProvenance = synthOutput.provenance

    // SIG-317: synth verdict-truncation recovery (runs BEFORE the degraded floor
    // so recovery re-aligns verdict↔provenance first). On target-rich PRs the
    // synth writes a COMPLETE provenance but a SHORTER verdict.findings — it
    // details the top-ranked findings (security-first) and silently truncates
    // the verbose tail, losing real subtle findings it MARKED KEPT (pr/10:
    // provenance 20, verdict 8 — a score-5 N+1, the cents bug, a floating
    // promise all lost). Recover the tail from the cited specialist sources; the
    // recovered findings flow through the SAME post-synth gates below, so this
    // CANNOT lower precision — the gates remain the authority. Modes:
    // `off` (default) inert, `shadow` logs the recoverable count, `on` applies.
    //
    // The helper ALWAYS returns a 1:1-aligned (verdict, provenance) pair — it
    // trims the truncated orphan tail to verdict length, then re-appends only the
    // recovered entries. So in `on` we install the result UNCONDITIONALLY whenever
    // the truncation branch runs, even when nothing qualified for recovery: the
    // trim alone re-aligns the arrays so the degraded floor downstream appends
    // onto an aligned base (otherwise the stale longer provenance survives and
    // validateForSubmission mispairs the floor's restored findings — Codex SIG-317
    // review). The non-recovered case is behavior-identical for posting (the
    // ignored tail was never paired), so trimming it costs no recall. Orphans
    // citing only AST-emit ids are NOT recovered here (sourceById is specialist-
    // only) — AST/SIG-310 deterministic recovery is a deliberate Part-1 gap,
    // fast-follow; it is precision-safe (those emits were already truncated).
    const synthRecoveryMode = ensembleConfig.flags.synthRecovery
    if (synthRecoveryMode !== "off"
      && effectiveSynthProvenance.findings.length > effectiveSynthVerdict.findings.length) {
      const sourceById = new Map<string, PrReviewFinding & { id: string }>()
      for (const v of synthInputVerdicts) {
        for (const f of v.verdict?.findings ?? []) {
          const id = (f as { id?: unknown }).id
          if (typeof id === "string") sourceById.set(id, f as PrReviewFinding & { id: string })
        }
      }
      const rec = recoverTruncatedSynthFindings({
        findings: effectiveSynthVerdict.findings,
        provenanceFindings: effectiveSynthProvenance.findings,
        sourceById,
      })
      if (rec.recovered.length > 0) {
        console.log(JSON.stringify({
          event: "pr-review-synth-truncation-recovered",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          mode: synthRecoveryMode,
          verdictLen: effectiveSynthVerdict.findings.length,
          provenanceLen: effectiveSynthProvenance.findings.length,
          recoveredCount: rec.recovered.length,
          recovered: rec.recovered.map((r) => ({ id: r.id, score: r.score, category: r.category })),
        }))
      }
      if (synthRecoveryMode === "on") {
        // Install unconditionally — `rec` is always aligned (trim ± recovery).
        effectiveSynthVerdict = { ...effectiveSynthVerdict, findings: rec.findings }
        effectiveSynthProvenance = { ...effectiveSynthProvenance, findings: rec.provenanceFindings }
      }
    }

    // SIG-351: full-coverage source-finding floor. Prompt-level FP
    // adjudication is allowed ONLY when the synth records a proof-like drop
    // (`false positive on diff inspection` / AST supersession). If a score>=4
    // source finding is neither represented in kept provenance nor proof-dropped,
    // restore it before validation. This is recall-only: restored findings still
    // pass through the normal hallucination, grounding, validator, anchor, and
    // rendering gates below.
    {
      const floored = applySynthSourceFindingFloor({
        findings: effectiveSynthVerdict.findings,
        provenanceFindings: effectiveSynthProvenance.findings,
        provenanceDropped: effectiveSynthProvenance.dropped,
        specialists: synthInputVerdicts
          .filter((v) => v.verdict !== null)
          .map((v) => ({ role: v.role, findings: v.verdict!.findings })),
        // SIG-351: verify `superseded_by_ast/<id>` suppressions against the REAL
        // AST id set — same source SIG-314 uses for the kept-path hallucination
        // guard (validateForSubmission's `astFindingIds`, below). A spoofed
        // `<id>` is NOT honored, so the floor restores the finding (recall-safe).
        astFindingIds: new Set(astResult.findings.map((f) => f.astFindingId)),
      })
      if (floored.restored.length > 0) {
        effectiveSynthVerdict = { ...effectiveSynthVerdict, findings: floored.findings }
        effectiveSynthProvenance = { ...effectiveSynthProvenance, findings: floored.provenanceFindings }
        console.log(JSON.stringify({
          event: "pr-review-synth-source-findings-restored",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          restoredCount: floored.restored.length,
          restored: floored.restored.map((r) => ({ role: r.role, id: r.id, score: r.score })),
        }))
      }
    }

    if (degradedCoverage) {
      const floored = applyDegradedCoverageFindingFloor({
        findings: effectiveSynthVerdict.findings,
        provenanceFindings: effectiveSynthProvenance.findings,
        specialists: synthInputVerdicts
          .filter((v) => v.verdict !== null)
          .map((v) => ({ role: v.role, findings: v.verdict!.findings })),
      })
      if (floored.restored.length > 0) {
        effectiveSynthVerdict = { ...effectiveSynthVerdict, findings: floored.findings }
        effectiveSynthProvenance = { ...effectiveSynthProvenance, findings: floored.provenanceFindings }
        console.log(JSON.stringify({
          event: "pr-review-degraded-source-findings-restored",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          rolesMissing: degradedCoverage.rolesMissing,
          restoredCount: floored.restored.length,
          restored: floored.restored.map((r) => ({ role: r.role, id: r.id, score: r.score })),
        }))
      }
    }

    // SIG-317 step 6 Part A: deterministic AST-emit injection floor. Force-
    // SURFACE any `emitWhenUnmatched` (warning/info) AST finding the synth did
    // NOT emit — the proven subtle needle (cents-as-dollars, enum drift) the
    // model crowded out of its verdict tail. The injected finding cites the
    // `astFindingId` (SIG-314 admits it) and flows through every post-synth gate
    // below, so nothing is force-posted; it just can't be silently dropped.
    // `off` skips; `shadow` logs what WOULD inject (no behavior change); `on`
    // injects. Recall-positive + P2/P3-capped (never mints a P0/P1).
    // Validated parse — a misconfig / typo FAILS CLOSED to "off" rather than
    // silently enabling on any non-"off" string (CodeRabbit/Sigilix #330).
    const astEmitFloorMode = ensembleConfig.flags.astEmitFloorMode
    if (astEmitFloorMode !== "off") {
      const floored = injectUnmatchedAstEmits({
        findings: effectiveSynthVerdict.findings,
        provenanceFindings: effectiveSynthProvenance.findings,
        astFindings: astResult.findings,
      })
      if (floored.injected.length > 0) {
        console.log(JSON.stringify({
          event: "pr-review-ast-emit-floor-injected",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          mode: astEmitFloorMode,
          injectedCount: floored.injected.length,
          injected: floored.injected,
        }))
        if (astEmitFloorMode === "on") {
          effectiveSynthVerdict = { ...effectiveSynthVerdict, findings: floored.findings }
          effectiveSynthProvenance = { ...effectiveSynthProvenance, findings: floored.provenanceFindings }
        }
      }
    }

    // ─── Post-synthesis validation ─────────────────────────────
    // SIG-318 (PR 12a): the adjudicate phase — validateForSubmission, the
    // AST-emit + performance severity clamps, and the consensus re-ranking —
    // moved verbatim to ensemble/app/adjudicate. The phase mutates `telemetry`
    // (synthesizer re-point + postValidation) and `validated` (in-place clamps)
    // by reference; the consensus outputs flow downstream unchanged.
    const { trustLedgerMode, showEvidence, validated, consensusVerdict, consensusProvenance, consensusByIndex } = adjudicateFindings({
      env,
      owner,
      repo,
      prNumber,
      headSha,
      ensembleConfig,
      telemetry,
      validationSink: args.validationSink,
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
    })

    // ARC-280: shadow-mode branch deleted. The dual-mode routing
    // (shadow vs post) is gone — post is the only mode. The
    // shadow-only `telemetry.shadowVerdict` field stays in the
    // interface for back-compat with stored telemetry rows but is
    // never written from this handler again.

    // ─── Stale-head guard #2 ───────────────────────────────────
    //
    // ARC-250 (Codex MAJOR on the design review): this guard MUST run
    // before `writeLastReviewedSha`. Previously the write happened
    // first, so if the head moved we still marked `headSha` as
    // last-reviewed even though no GitHub review was posted. The next
    // ARC-251 requeue then read that marker and used a `compareDiff`
    // of `oldSha..newSha` instead of the full PR diff — missing every
    // finding from before the head move. The fix is twofold: check
    // staleness here, and move `writeLastReviewedSha` to the two
    // posted-return sites below so it only runs after a successful
    // GitHub submit.
    const meta2 = await client.getPullRequest(owner, repo, prNumber)
    if (meta2.head?.sha && meta2.head.sha !== headSha) {
      // CodeRabbit catch (phase-end): do NOT set `fellBackToPhase3`
      // — same reasoning as guard #1.
      telemetry.fellBackReason = "stale_head_after_review"
      await handleStaleHead({
        env, owner, repo, prNumber, installationId,
        queuedHeadSha: headSha,
        currentHeadSha: meta2.head.sha,
        baseSha: meta2.base?.sha ?? null,
        depth: staleHeadRequeueDepth,
        source: "ensemble-after-review",
        ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
      })
      return finalize(telemetry, env, "stale_head", cache)
    }

    // ─── SIG-216: overview-then-submit ordering ────────────────
    //
    // Pre-SIG-216 the overview ran as its own queue job kicked off
    // by the push webhook and a "Reviewing…" stub was synchronously
    // posted at webhook time so the review-side wait gate could line
    // it up ahead of `submitReview`. Founder direction 2026-05-25:
    // drop the stub-first pattern; the overview comment now lands
    // immediately BEFORE the review comment in this same handler
    // invocation, CodeRabbit-style. See `runInlineOverview` below
    // (called once the submission verdict is final, just before the
    // pre-submit dismiss + `submitReview`).

    // ─── Submit ────────────────────────────────────────────────
    // GitHub validates every inline anchor and rejects the entire review
    // on a single bad position (typical 422). When that happens the
    // ensemble verdict is good but unsubmittable in its inline shape —
    // Greptile's pr_review.ts handles this by re-posting the review
    // anchorless with all findings rolled into the body. Same pattern
    // here: catch any submit error and retry with `buildFallbackSubmission`.
    // If the fallback ALSO fails, the outer try/catch records it as
    // `internal_error` (same behaviour as before this change).
    // Pass `unanchoredFindings` to the primary submission so any
    // findings that failed line-validity are still rolled into the
    // body (instead of being recovered ONLY when the inline submit
    // fails). CR PR #38 catch — without this, GitHub's success path
    // silently drops the unanchored set.
    //
    // ARC-189 Task 10b: apply review-memory soften BEFORE rendering.
    // The synth's `provenance.softened[]` references specialist
    // sourceFindingIds (e.g., "logic-3"); for each kept finding whose
    // provenance.sourceFindingIds intersects the softened set, build
    // a CLONE of the finding with `score = Math.max(1, score - 1)`.
    // Original finding objects are NEVER mutated (Kimi MINOR on plan
    // v2 — preserves immutability for downstream telemetry).
    const softenedSet = new Set<string>()
    if (synthOutput.provenance?.softened) {
      for (const s of synthOutput.provenance.softened) {
        if (typeof s.sourceFindingId === "string") {
          softenedSet.add(s.sourceFindingId)
        }
      }
    }
    // SIG-280 PR B: soften is now CALIBRATED + opt-in. It only changes a
    // score when `softenActive` (global flag === "soften" AND per-repo
    // `claimSoftening` true). PR B ships the COLD regime: no calibration
    // params exist yet (PR C produces them), so the veto cancels EVERY
    // soften — we record what WOULD have softened (telemetry) then clear
    // the set, so nothing is softened until the calibrated path lands and
    // the founder enables it (believability-dominant: worst case is "no
    // soften", never over-soften). When NOT active, the soften loop below
    // simply doesn't decrement, turning off the pre-Phase-4 uncalibrated
    // always-on soften.
    const claimShadowMode = ensembleConfig.flags.reviewMemoryClaimShadowMode
    // `reviewMemoryConfig` is scoped to the review-memory injection block
    // above; re-resolve the per-repo bool here (pure + cheap) from the
    // function-scoped sigilixConfig.
    const softenActive = isSoftenActive(
      claimShadowMode,
      resolveReviewMemoryConfig(sigilixConfig).claimSoftening,
    )
    const claimsEnabled = ensembleConfig.flags.reviewMemoryClaims === "on"

    // Reusable claim-extractor model closure. Shared by the SIG-280 PR C
    // warm veto below and the Phase-2/3 extraction site further down, so
    // the (paid) classifier runs at most ONCE per review even on the warm
    // path (the warm pre-pass memoizes its output into
    // `earlyClaimsPerFinding`).
    const runClaimClassifier = async (
      system: string,
      user: string,
    ): Promise<string | null> => {
      if (!env.OLLAMA_API_KEY) return null
      const res = await runWithRetryAndFallback<string>({
        config: CLAIM_EXTRACTOR_CONFIG,
        apiKey: env.OLLAMA_API_KEY,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        signal: orchCtrl.signal,
        chatEnabled: env.OLLAMA_CHAT_ENABLE === "on" ? "on" : "off",
        format: CLAIM_EXTRACTION_SCHEMA as unknown as Record<string, unknown>,
        parseAnswer: (content) => content,
        parseFailureLabel: "claim_extractor_did_not_parse",
        startedAt: Date.now(),
        perAttemptTimeoutMs: CLAIM_EXTRACTOR_TIMEOUT_MS,
      })
      return res.verdict
    }

    // Withdrawals are loaded ONCE here (hoisted from the post-soften
    // filter site below) so the warm veto and the main render path derive
    // the SAME withdrawal-survivor index from one read — eliminating any
    // chance the two diverge between back-to-back KV reads. Defense-in-
    // depth wrap (CodeRabbit M1, PR #142): the store helper already
    // returns [] on KV/parse failure, but a future sync throw would
    // otherwise unwind the whole review path; withdrawal suppression is a
    // nice-to-have and must never fail a review.
    let withdrawals: Awaited<ReturnType<typeof loadWithdrawals>> = []
    try {
      withdrawals = await loadWithdrawals(env, owner, repo, prNumber)
    } catch (err) {
      console.warn(JSON.stringify({
        event: "review-withdrawal-load-unexpected-throw",
        owner, repo, prNumber,
        error: err instanceof Error ? err.message : String(err),
      }))
    }

    // SIG-280 PR C — the soften VETO. PR B shipped only the COLD regime
    // (no calibration params → veto EVERY soften). PR C adds the WARM
    // regime: when a calibration blob exists in KV with >=1 trustworthy
    // claim type, each soften survives ONLY if the finding matched — at
    // claim level, conditioned on the active memory's shadowClaims, i.e.
    // exactly what the calibration corpus measured — a claim type whose
    // 95% lower bound clears the threshold. The ENTIRE warm branch is
    // gated on params existing; in prod they do not yet, so the cold
    // veto-all runs byte-identically to PR B until calibration is fitted
    // and the founder enables it. Believability-dominant: any ambiguity
    // (no match, cold/thin type, low bound, missing params) → veto, and
    // the P0/P1 floor in the soften clone below is the final guard.
    let earlyClaimsPerFinding:
      | ReadonlyArray<readonly ReviewMemoryClaimMarkerData[]>
      | null = null
    // Survival is keyed by CONSENSUS-FINDING INDEX, never by sourceFindingId
    // (Codex + CodeRabbit P1: one source id can map to multiple synthesized
    // findings, so a source-id set would leak a survival onto a sibling).
    // null on the soften-inactive path; an (empty in cold regime) Set when
    // the veto pre-pass runs. The soften clone loop + approval-readiness key
    // off this index set.
    let survivingSoftenIndexSet: Set<number> | null = null
    if (softenActive && softenedSet.size > 0) {
      const calibrationBlob = claimsEnabled
        ? await readCalibrationParams(env.OPENCLAW_STATE)
        : null
      const warmUsable =
        calibrationBlob !== null &&
        shadowMemoriesForPhase3.length > 0 &&
        Object.values(calibrationBlob).some((p) => shouldKeepSoften(p))

      // Per softened finding, the claim types it matched a memory on.
      // WARM only — needs the model-backed claim extraction + the shadow
      // match. Cold/off paths never compute this (→ empty → veto-all).
      const matchedTypesByFid = new Map<string, Set<ReviewMemoryClaimType>>()
      if (warmUsable) {
        // Re-derive today's withdrawal-survivor index the SAME way the
        // main render path does. `filterWithdrawnFindings` matches on
        // path+line+body (score-independent), so an UNSOFTENED probe
        // over the same `withdrawals` yields the identical keepIndex —
        // and extracting claims over exactly that filtered batch keeps
        // the veto's claim types on the same batch shape the corpus saw
        // (Codex Option E: avoids batch-drift over-soften).
        const probe = consensusVerdict.findings.map((f, i) =>
          annotateWithConsensus(f, consensusByIndex[i] ?? 1),
        )
        const { kept: probeKept } = filterWithdrawnFindings(probe, withdrawals)
        const probeKeptSet = new Set(probeKept)
        const warmKeepIndex: number[] = []
        for (let i = 0; i < probe.length; i++) {
          if (probeKeptSet.has(probe[i]!)) warmKeepIndex.push(i)
        }
        const warmFiltered = warmKeepIndex.map((i) => consensusVerdict.findings[i]!)
        const warmFilteredProvenance = warmKeepIndex.map((i) => consensusProvenance[i])

        const warmClaims = await extractClaims({
          findings: warmFiltered.map(
            (f): ClaimExtractionFinding => ({
              headline: f.headline,
              body: f.body,
              category: f.category,
            }),
          ),
          runClassifier: runClaimClassifier,
        })
        earlyClaimsPerFinding = warmClaims

        const warmShadowFids = await Promise.all(
          warmFiltered.map((f) =>
            computeFid({ ruleId: null, path: f.path, line: f.line, headline: f.headline }),
          ),
        )
        const warmShadowPathHashes = await Promise.all(
          warmFiltered.map((f) => computePathSha256(f.path)),
        )
        const warmShadowFindings: ShadowMatchFinding[] = warmFiltered.map((f, j) => {
          const sourceSpec = warmFilteredProvenance[j]?.sourceSpecialists?.[0]
          return {
            category: sourceSpec ? categoryFromRoleHint(sourceSpec) : null,
            pathSha12: warmShadowPathHashes[j]?.slice(0, 12) ?? null,
            fid: warmShadowFids[j] ?? "",
            severityTier: severityTier(f.score),
            claims: (warmClaims[j] ?? []).map((c) => ({
              type: c.type,
              extractorVersion: c.extractorVersion,
            })),
          }
        })
        const warmRows = shadowMatchReviewMemoryClaims({
          memories: shadowMemoriesForPhase3,
          findings: warmShadowFindings,
        })
        // Codex P1: the soften veto joins a candidate to its matched claim
        // types BY fid. `computeFid` ignores body/category, so two distinct
        // findings sharing (path, line, headline) collide on fid — one
        // could then inherit the other's match and be softened though it
        // matched nothing. Believability-dominant resolution: if a fid is
        // ambiguous (more than one finding in this review carries it), we
        // CANNOT safely attribute a match, so we drop it from the map →
        // every candidate with that fid vetoes. Near-impossible after
        // consensus dedup, but the cost of being wrong here is hiding a
        // real finding, so we refuse to guess.
        const fidCounts = new Map<string, number>()
        for (const fid of warmShadowFids) {
          fidCounts.set(fid, (fidCounts.get(fid) ?? 0) + 1)
        }
        for (const row of warmRows) {
          if (!row.claimType) continue
          if ((fidCounts.get(row.fid) ?? 0) > 1) continue // ambiguous fid → veto
          let set = matchedTypesByFid.get(row.fid)
          if (!set) {
            set = new Set<ReviewMemoryClaimType>()
            matchedTypesByFid.set(row.fid, set)
          }
          set.add(row.claimType)
        }
      }

      // Build candidates — the softened findings, keyed by consensus index.
      const candidates: WarmSoftenCandidate[] = []
      for (let i = 0; i < consensusVerdict.findings.length; i++) {
        const f = consensusVerdict.findings[i]!
        const sourceIds = consensusProvenance[i]?.sourceFindingIds ?? []
        // Candidacy: the finding had at least one synth-softened source id.
        if (!sourceIds.some((id) => softenedSet.has(id))) continue
        const fid = await computeFid({ ruleId: null, path: f.path, line: f.line, headline: f.headline })
        candidates.push({
          index: i,
          fid,
          matchedTypes: [...(matchedTypesByFid.get(fid) ?? [])],
        })
      }
      const decisions: WarmSoftenDecision[] = warmUsable
        ? decideWarmSoftenSurvival({ candidates, blob: calibrationBlob! })
        : candidates.map((c) => ({
            index: c.index,
            fid: c.fid,
            kept: false,
            keepingTypes: [] as ReviewMemoryClaimType[],
          }))

      // Survival is carried forward BY INDEX (empty in the cold regime →
      // veto-all, exactly as PR B). Keying by index — never by source id —
      // prevents a kept finding from softening a sibling that shares a
      // specialist source id (Codex + CodeRabbit P1).
      survivingSoftenIndexSet = new Set<number>()
      for (const d of decisions) {
        if (d.kept) survivingSoftenIndexSet.add(d.index)
        console.log(JSON.stringify({
          event: "review-memory-claim-soften",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          fid: d.fid,
          severityTier: severityTier(consensusVerdict.findings[d.index]!.score),
          keepingTypes: d.keepingTypes,
          vetoed: !d.kept,
          paramsMissing: !warmUsable,
        }))
      }
    }
    let softenedCount = 0
    // SIG-280 PR C: the SINGLE source of truth for "this finding's score was
    // actually lowered in the rendered output" — populated below exactly where
    // the soften clone is built. Approval-readiness reads this (intersected
    // with the withdrawal-survivor `keepIndex`) instead of re-encoding the
    // soften contract, so the two paths can never drift (CodeRabbit).
    const actuallySoftenedIndexSet = new Set<number>()
    // ARC-270: soften walks the CONSENSUS-RANKED arrays (verdict +
    // provenance + consensusByIndex stay in lockstep). Body
    // annotation happens here too, so renderable findings carry both
    // the (possibly softened) score AND the consensus prefix.
    //
    // Caveat: the rendered Fix Plan (`renderFixPlan` in
    // `triage-pr-review.ts`) and the anchorless 422-fallback's
    // per-file rendering both apply their own sort (by location /
    // by score within file). They override consensus ORDER, but the
    // `_Flagged by N specialists._` body prefix still surfaces the
    // signal — the badge stays, just the row position differs in
    // those two surfaces.
    // SIG-217: annotate each finding with its content fingerprint BEFORE
    // render + withdrawal filtering. Computed from the RAW synth body (this
    // runs before annotateWithConsensus prepends its "_Flagged by N_" line),
    // so the value is stable across pushes regardless of the per-push blob
    // hash that drives the model-emitted finding ID. The fingerprint then
    // (a) flows into the rendered comment as a hidden marker, and (b) lets a
    // later content-equivalent re-fire be recognized as already-dismissed.
    // Mutates in place — runtime-only field, like `trust`. Best-effort: a hash
    // failure leaves the finding without a fingerprint (Jaccard fallback).
    try {
      await Promise.all(
        consensusVerdict.findings.map(async (f) => {
          f.contentFingerprint = await computeContentFingerprint(f.category, f.path, f.body)
        }),
      )
    } catch (err) {
      console.warn(JSON.stringify({
        event: "finding-fingerprint-annotate-failed",
        owner, repo, prNumber,
        error: err instanceof Error ? err.message : String(err),
      }))
    }
    const renderableFindings = consensusVerdict.findings.map((f, i) => {
      // SIG-280 PR C: soften iff this finding's INDEX survived the veto
      // pre-pass (cold regime → empty set, so this never fires in prod yet).
      // Index-keyed — see `survivingSoftenIndexSet`. `softenScoreWithFloor`
      // keeps a P0/P1 (score >= 4) UNCHANGED — a blocker is never softened
      // below its tier — and decrements P2/P3 by one (floored at 1).
      //
      // Codex P1 note: the floor reads the CONSENSUS finding's `f.score`,
      // not the underlying specialist source score. That equals the true
      // severity only because the synthesizer is required to emit findings
      // at TRUE severity and never pre-downgrade (the SIG-284 renderer-only-
      // soften contract, pinned by PROMPT_VERSION + the double-soften test).
      // If a synth ever under-scored a true P0/P1 to <4 this floor wouldn't
      // catch it — but that is a synth-correctness bug, out of scope here,
      // and guarded by the prompt contract rather than this line.
      const matched = softenActive && (survivingSoftenIndexSet?.has(i) ?? false)
      let working = f
      if (matched) {
        const effectiveScore = softenScoreWithFloor(f.score)
        if (effectiveScore !== f.score) {
          softenedCount++
          actuallySoftenedIndexSet.add(i)
          working = { ...f, score: effectiveScore }
        }
      }
      // Body annotation — only when consensus >= 2.
      return annotateWithConsensus(working, consensusByIndex[i] ?? 1)
    })
    const renderableUnanchoredRaw = validated.unanchoredFindings  // unanchored never matches by INDEX (no parallel arrays)
    // SIG-160 PR3: drop any finding the bot already conceded via mention-reply
    // (`<!-- sigilix:gh-mention-reply -->` with verdict:"concede"). Filter
    // applies to inline-anchored findings only — unanchored findings have
    // no path+line to match a WithdrawalRecord against. Runs BEFORE the
    // manifest snapshot + counter bump so a withdrawn finding never:
    //   - lands in the persisted manifest (would corrupt next push's delta)
    //   - triggers a REQUEST_CHANGES counter bump (would re-block the PR)
    //   - reaches `buildReviewSubmission` (would post the inline comment).
    //
    // Index alignment (CodeRabbit M1 catch): `consensusVerdict.findings`,
    // `consensusByIndex`, and `consensusProvenance` are parallel arrays
    // — index `i` in each refers to the same finding. The filter must
    // produce a `keepIndex` whose entries are valid indices into the
    // original arrays, and downstream consumers (snapshot + marker
    // computation) read through that index list so the filtered view
    // stays aligned end-to-end.
    //
    // `withdrawals` is loaded once near the soften pre-pass above (SIG-280
    // PR C hoisted it so the warm veto and this render path share one
    // read); the defensive wrap + rationale live there.
    const { kept: postWithdrawalFindings, suppressed: withdrawnDetailed, decayExpired: decayExpiredFindings } =
      filterWithdrawnFindingsDetailed(renderableFindings, withdrawals)
    const withdrawnFindings = withdrawnDetailed.map((s) => s.finding)
    // SIG-217: emit repeat-FP telemetry. Two cases feed one batch:
    //   - fingerprint re-fires still inside the decay window (suppressed) →
    //     `repeat-fp-detected`, plus `severity-escalation-attempt` if the score
    //     climbed above what it was when dismissed.
    //   - decay-window lapses (SIG-217 Part B) — the finding was LET THROUGH
    //     because the dismissal aged past the decay window → emit
    //     `dismiss-decay-window-expired`.
    // The finding's category is the per-specialist dimension (logic / security /
    // performance / testing …). Awaited-but-non-fatal (the recordDismissalMetric
    // pattern) — a telemetry failure must never affect the review.
    const repeatFpEvents: RepeatFpEvent[] = []
    for (const s of withdrawnDetailed) {
      if (!s.viaFingerprint) continue
      repeatFpEvents.push({ kind: "repeat-fp-detected", specialist: s.finding.category })
      if (s.severityEscalated) {
        repeatFpEvents.push({ kind: "severity-escalation-attempt", specialist: s.finding.category })
      }
    }
    for (const s of decayExpiredFindings) {
      repeatFpEvents.push({ kind: "dismiss-decay-window-expired", specialist: s.finding.category })
    }
    if (repeatFpEvents.length > 0) {
      try {
        await recordRepeatFpMetrics(env, { owner, repo, prNumber, headSha, events: repeatFpEvents })
      } catch (err) {
        console.log(JSON.stringify({
          event: "repeat-fp-metrics-record-error",
          owner, repo, prNumber,
          error: err instanceof Error ? err.message : String(err),
        }))
      }
    }
    // SIG-147: per-repo precision profile — suppress repeatedly-dismissed
    // PATTERNS (recall-safe: never a P0/P1) and record the `stale` outcome from
    // decay-expired dismissals. Shadow by default (compute + telemeter, no
    // output change); `enforce` filters. Best-effort — a profile failure must
    // never affect the review. Boost is computed/surfaced but applied at the
    // SIG-104 prompt gate (not yet built); see precision-profile/README.md.
    // NOTE: `shadow` leaves the posted review byte-identical, but DOES still
    // write `stale` outcomes to KV (building the corpus is the point of shadow);
    // only `enforce` changes what's posted.
    const precisionMode = ensembleConfig.flags.precisionProfileMode
    let precisionKept = postWithdrawalFindings
    if (precisionMode !== "off") {
      // Key on the owner/repo slug — the SAME key the dismiss path
      // (github-mention) records outcomes under, so the signal round-trips.
      const precisionRepoKey = `${owner}/${repo}`
      try {
        const profile = await loadPrecisionProfile(env, precisionRepoKey)
        const precision = applyPrecisionProfile(postWithdrawalFindings, profile, {
          enforce: precisionMode === "enforce",
        })
        if (precision.suppressed.length > 0 || precision.boosted.length > 0) {
          console.log(JSON.stringify({
            event: "precision-profile-decision",
            owner, repo, prNumber, mode: precisionMode,
            // FP-reduction signal (ties SIG-114): each suppressed finding is an avoided FP.
            suppressed: precision.suppressed.length,
            boosted: precision.boosted.length,
            suppressed_categories: precision.suppressed.map((s) => s.finding.category),
            boosted_categories: precision.boosted.map((b) => b.finding.category),
          }))
        }
        if (precisionMode === "enforce") precisionKept = precision.kept
      } catch (err) {
        console.warn(JSON.stringify({
          event: "precision-profile-apply-failed",
          owner, repo, prNumber,
          error: err instanceof Error ? err.message : String(err),
        }))
      }
      // A decay-expired dismissal (SIG-217) relaxes its pattern back toward neutral.
      for (const s of decayExpiredFindings) {
        if (!s.finding.contentFingerprint) continue
        try {
          await recordOutcome(env, {
            repoId: precisionRepoKey,
            category: s.finding.category,
            patternHash: s.finding.contentFingerprint,
            outcome: "stale",
          })
        } catch { /* non-fatal */ }
      }
    }
    // SIG-281 PR C (Codex P2): also suppress withdrawn findings from the
    // body-only set. PR C's enforce mode can demote a LINE-scoped finding
    // (which carries a real path+line) to the body; without this it would
    // bypass withdrawal suppression and a previously-dismissed nit could
    // reappear in the Review Body. Safe for pr/file-scope body findings
    // too — findingMatchesWithdrawal requires path + line-proximity + body
    // similarity, so an unrelated body finding cannot false-match. This
    // also closes the pre-existing gap where SIG-141 line-1 / unanchorable
    // demotions skipped withdrawal entirely.
    const { kept: renderableUnanchored, suppressed: withdrawnUnanchored } =
      filterWithdrawnFindings(renderableUnanchoredRaw, withdrawals)
    const keptRefSet = new Set(precisionKept)
    const keepIndex: number[] = []
    for (let i = 0; i < renderableFindings.length; i++) {
      if (keptRefSet.has(renderableFindings[i]!)) keepIndex.push(i)
    }
    if (withdrawnFindings.length > 0 || withdrawnUnanchored.length > 0) {
      console.log(JSON.stringify({
        event: "review-findings-suppressed-by-withdrawal",
        owner, repo, prNumber,
        suppressed: withdrawnFindings.length,
        // SIG-281 PR C: body-only findings now also withdrawal-filtered.
        suppressed_unanchored: withdrawnUnanchored.length,
        withdrawals_active: withdrawals.length,
        paths: [...withdrawnFindings, ...withdrawnUnanchored].map((f) => f.path),
      }))
    }
    // Filtered parallel views for downstream consumers — snapshot and
    // marker computation read through these so the manifest, counter,
    // and inline-comment markers all see the same kept set the renderer
    // does. Original `consensusVerdict` stays intact (it's the audit
    // record of what the model produced before suppression).
    const filteredConsensusFindings = keepIndex.map((i) => consensusVerdict.findings[i]!)
    const filteredConsensusByIndex = keepIndex.map((i) => consensusByIndex[i] ?? 1)
    const filteredConsensusProvenance = keepIndex.map((i) => consensusProvenance[i])
    // CodeRabbit M2 (review on PR #142): the synthesizer wrote
    // `consensusVerdict.summary` over the FULL finding set including
    // findings we're about to suppress. Reusing it verbatim could
    // surface conceded content (e.g. "two findings about test
    // coverage") even though the renderer drops one of them. When any
    // suppression happened, replace the summary with a neutral
    // fallback the renderer can use unmodified.
    //
    // CodeRabbit M-new (follow-up review on PR #142): the "nothing
    // remaining to block" branch must consider BOTH anchored kept +
    // unanchored findings — `renderableUnanchored` is independent of
    // the withdrawal filter (no path+line to match against). Without
    // this, an all-anchored-withdrawn run with surviving unanchored
    // findings would post REQUEST_CHANGES with a summary that says
    // "nothing remaining." `chooseReviewEvent` reads the merged set
    // for the verdict decision, so the summary must agree.
    const hasRemainingFindings =
      precisionKept.length + renderableUnanchored.length > 0
    // SIG-281 PR C (Codex P2 follow-on): regenerate the summary when
    // EITHER an inline OR a body finding was withdrawal-suppressed —
    // otherwise a body-only withdrawal would remove the finding from the
    // submission but leave the consensus summary still describing it.
    const summaryAfterSuppression = (withdrawnFindings.length > 0 || withdrawnUnanchored.length > 0)
      ? (!hasRemainingFindings
          ? "All flagged findings were previously addressed via review-thread acknowledgments; nothing remaining to block."
          : "Summary regenerated after suppressing findings previously acknowledged via review-thread replies.")
      : consensusVerdict.summary
    const renderableVerdict: PrReviewVerdict = {
      ...consensusVerdict,
      summary: summaryAfterSuppression,
      findings: precisionKept,
    }
    if (softenedCount > 0) {
      console.log(JSON.stringify({
        event: "review-memory-softened-rendered",
        owner, repo, prNumber, softenedCount,
      }))
    }

    // SIG-205 — approval-readiness must run before the delta/manifest
    // snapshot below. Its body-only blockers are customer-visible
    // findings, so they need the same persistence and still-open/new
    // tracking as normal unanchored findings.
    const intendedEvent = chooseReviewEvent([
      ...renderableVerdict.findings,
      ...renderableUnanchored,
    ])
    const sourceFindingsForApproval = collectApprovalReadinessSourceFindings(
      synthInputVerdicts,
      withdrawals,
    )
    // SIG-280 PR C: which synth-softened source ids were ACTUALLY softened in
    // the rendered output. Derived from finding INDICES, never a source-id set,
    // because a source id can feed multiple synthesized findings.
    //
    // We reuse `actuallySoftenedIndexSet` — the SINGLE source of truth built in
    // the renderableFindings map above where the score is actually changed —
    // and intersect it with the withdrawal survivors (`keepIndex`). That makes
    // "actually de-emphasized in the output" mean: the renderer lowered the
    // score AND the finding survived withdrawal filtering. No re-encoding of the
    // soften contract here, so approval can't drift from rendered output
    // (CodeRabbit). A P0/P1 the floor left unchanged was never added to the set,
    // so it correctly does NOT count.
    // FAIL CLOSED: a source id de-emphasized in one finding but left at full
    // severity in another (vetoed, withdrawn, or floor-no-op) is NOT counted as
    // accounted — else approval-readiness could approve over a sibling finding
    // still at full severity (undercount blockers).
    const keptIndexSet = new Set(keepIndex)
    const softenMembership = new Map<string, { survived: boolean; vetoed: boolean }>()
    if (softenActive) {
      for (let idx = 0; idx < consensusProvenance.length; idx++) {
        const survived = actuallySoftenedIndexSet.has(idx) && keptIndexSet.has(idx)
        for (const sourceFindingId of consensusProvenance[idx]?.sourceFindingIds ?? []) {
          if (!softenedSet.has(sourceFindingId)) continue
          const state = softenMembership.get(sourceFindingId) ?? { survived: false, vetoed: false }
          if (survived) state.survived = true
          else state.vetoed = true
          softenMembership.set(sourceFindingId, state)
        }
      }
    }
    const approvalReadiness = assessApprovalReadiness({
      intendedEvent,
      sourceFindings: sourceFindingsForApproval,
      // Pass only source ids that survived softening EVERYWHERE they appear —
      // a source finding counts as "accounted" only when it was actually
      // de-emphasized in the output, so approval-readiness never silently
      // approves over a finding the calibrated veto kept at full severity.
      // Empty in the cold regime; [] when soften is inactive entirely.
      provenance: {
        ...validated.provenance,
        softened: softenActive
          ? (validated.provenance.softened ?? []).filter((s) => {
              if (typeof s.sourceFindingId !== "string") return false
              const state = softenMembership.get(s.sourceFindingId)
              return state !== undefined && state.survived && !state.vetoed
            })
          : [],
      },
    })
    const renderableUnanchoredForSubmission = [
      ...renderableUnanchored,
      ...approvalReadiness.bodyOnlyFindings,
    ]
    const effectiveEvent = approvalReadiness.event
    // SIG-287: a degraded-coverage or low-confidence review must NOT post a
    // confident clean APPROVE — that is the fake-approve believability bug (the
    // bot says "all clear" when its primary bug-finder, logic, didn't run).
    // Downgrade an otherwise-APPROVE to a neutral COMMENT ("Sigilix looked, but
    // this is not a full sign-off"). A real blocker still escalates to
    // REQUEST_CHANGES (escalation wins); the COMMENT override can only weaken
    // APPROVE→COMMENT, never hide a rendered blocker — see
    // `chooseRenderedEventWithOverride`. Honors the founder's SIG-14 posture
    // ("speak, don't be silent"): the bot still comments, it just stops
    // rubber-stamping a review it couldn't actually complete.
    const synthConfidence =
      typeof renderableVerdict.confidence === "number" ? renderableVerdict.confidence : 5
    // TODO(SIG-364): extract an isLowConfidence predicate into domain/verdict when the orchestrator is thinned — the comparison direction is policy.
    const reviewIncomplete =
      degradedCoverage !== null || synthConfidence <= LOW_CONFIDENCE_COMMENT_THRESHOLD
    // SIG-245: files dropped from review (diff-budget spill into a later batch,
    // or individually too large) make a clean APPROVE dishonest — the bot never
    // read part of the diff. Downgrade it to COMMENT (same mechanism as
    // SIG-287) so the "files not reviewed" notice — which renders in the
    // findings body, NOT the marker-only APPROVE body — actually surfaces.
    // Kept SEPARATE from `reviewIncomplete` so the degraded/low-confidence
    // summary-prefix wording is NOT applied to a files-dropped review (the
    // notice is its own block under the headline).
    const filesDroppedFromReview = [...new Set([...filesNotReviewed, ...droppedTooLarge])]
    const reviewEventOverride = resolveReviewEventOverride({
      hasApprovalBlocker: approvalReadiness.blockers.length > 0,
      reviewIncomplete,
      filesDroppedCount: filesDroppedFromReview.length,
    })
    if (reviewIncomplete) {
      console.log(JSON.stringify({
        event: "review-incomplete-downgrade",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        reason: degradedCoverage !== null ? "degraded_coverage" : "low_confidence",
        rolesMissing: degradedCoverage?.rolesMissing ?? [],
        synthConfidence,
      }))
    }
    // Visible caveat so a downgraded review reads as honestly partial, never as
    // a quiet clean approve (SIG-94 hid coverage on APPROVE; this re-surfaces it
    // only when the review is actually incomplete).
    const incompleteSummaryPrefix = reviewIncomplete
      ? degradedCoverage !== null
        ? `> ⚠️ **Partial review** — ${degradedCoverage.rolesMissing.join(", ")} specialist` +
          `${degradedCoverage.rolesMissing.length === 1 ? "" : "s"} unavailable; this is **not** a full Sigilix sign-off.\n\n`
        : `> ⚠️ **Low-confidence review** — posted as a comment, not a full approval.\n\n`
      : ""
    const submissionVerdict: PrReviewVerdict = {
      ...renderableVerdict,
      summary:
        incompleteSummaryPrefix +
        buildApprovalReadinessSummary(approvalReadiness, renderableVerdict.summary),
    }

    // ARC-271 — finding delta vs the prior review.
    //
    // For each current finding compute a stable key and look it up
    // in the prior manifest. The result is a {new, still-open,
    // likely-fixed, carried-over} count surfaced in the review body.
    //
    // Best-effort: manifest read failures (KV outage, malformed
    // record, never-written) degrade to "no delta" — the review
    // body simply doesn't show the Δ line. The current findings
    // are persisted on the success path regardless so subsequent
    // pushes can compute deltas against them.
    // CodeRabbit MAJOR catch on PR #83: the review body includes
    // BOTH `consensusVerdict.findings` (inline-anchored) AND
    // `validated.unanchoredFindings` (body-only). The manifest
    // snapshot must capture both — otherwise a still-open unanchored
    // finding silently disappears from the delta and re-appears as
    // `new` on the next push. Unanchored findings never went through
    // consensus ranking (they were filtered for failing line
    // validity, not for consensus), so their consensus defaults to 1.
    // SIG-160 PR3: snapshot the FILTERED set so withdrawn findings
    // don't land in the persisted manifest — otherwise next push's
    // delta would compare {prior: includes withdrawn} vs
    // {current: excludes withdrawn} and report the withdrawn finding
    // as `likely-fixed`. SIG-205 extends the body-only side with
    // approval-readiness blockers, which are already derived from the
    // withdrawal-filtered source findings above.
    const snapshotInputs = [
      ...filteredConsensusFindings.map((f, j) => ({ f, consensus: filteredConsensusByIndex[j] ?? 1 })),
      ...renderableUnanchoredForSubmission.map((f) => ({ f, consensus: 1 })),
    ]
    const currentFindingsForManifest: ReviewManifestFinding[] = await Promise.all(
      snapshotInputs.map(async ({ f, consensus }) => ({
        key: await computeFindingKey(f.path, f.headline),
        path: f.path,
        headline: f.headline,
        score: f.score,
        consensus,
      })),
    )
    const currentKeySet = new Set(currentFindingsForManifest.map((f) => f.key))
    // ARC-281: pass the delta counts straight into the renderer
    // (it draws the `**Δ:**` badge under the heading) instead of
    // prepending a "**Δ since last review:** …" string into the
    // summary. `null` = no prior manifest / no signal.
    let deltaCounts: DeltaBadgeCounts | null = null
    try {
      const priorRead = await readReviewManifest(env, owner, repo, prNumber)
      if (priorRead.kind === "ok" && priorRead.manifest.findings) {
        // Codex spec warning: a finding's path NOT in the current PR's
        // changed-file set means specialists never looked at it on
        // this run (incremental review only sends changed-file
        // diffs). Don't claim "fixed" in that case — classify as
        // `carried-over` instead.
        //
        // `reviewable.keys()` is our changed-paths source of truth:
        // it's parsed from the diff that the specialists actually
        // saw, so every path with at least one reviewable position
        // is a file we have fresh signal on. Pure-rename or empty
        // diffs without reviewable positions correctly fall out
        // (we had no signal on them).
        const changedPaths = new Set(reviewable.keys())
        const delta = computeFindingDelta(
          currentKeySet,
          priorRead.manifest.findings,
          changedPaths,
        )
        // Promote to the renderer-facing shape. We still gate the
        // observability log on the same "any signal" predicate as
        // `renderDeltaBadge` so a no-change second review doesn't
        // log a "+0 new" line.
        const anySignal =
          delta.newCount > 0 ||
          delta.stillOpenCount > 0 ||
          delta.likelyFixedCount > 0 ||
          delta.carriedOverCount > 0
        if (anySignal) {
          deltaCounts = {
            newCount: delta.newCount,
            stillOpenCount: delta.stillOpenCount,
            likelyFixedCount: delta.likelyFixedCount,
            carriedOverCount: delta.carriedOverCount,
          }
          console.log(JSON.stringify({
            event: "pr-review-delta-computed",
            owner, repo, prNumber, headSha: headSha.slice(0, 7),
            ...delta,
          }))
        }
      }
    } catch (err) {
      console.warn(JSON.stringify({
        event: "pr-review-delta-read-failed",
        owner, repo, prNumber,
        err: err instanceof Error ? err.message : String(err),
      }))
    }

    // ARC-281: specialist coverage roster for the renderer. The
    // `**Coverage:**` line uses the dispatched/succeeded split
    // directly — `degradedCoverage` upstream already drove prompt
    // logic; this is purely display.
    const coverage: CoverageRoles = {
      dispatched: router.specialists,
      succeeded: succeeded.map((v) => v.role),
    }

    // ARC-189: pre-compute the per-finding sigilix marker BEFORE
    // calling buildReviewSubmission so marker construction (async via
    // crypto.subtle) doesn't force the whole renderer async. Markers
    // align by index with `validated.verdict.findings` AND
    // `validated.cleanFindingProvenance` — the same walk in
    // validateForSubmission produced both. Findings with no source
    // specialist (defensive, shouldn't happen post-hallucination
    // guard) emit `null` and skip the marker.
    //
    // Marker severity uses the ORIGINAL (pre-soften) score so the
    // marker reflects what synth actually emitted; the soften
    // applies to the rendered finding body only.
    // ARC-270: marker computation walks the consensus-ranked arrays
    // so per-finding markers stay aligned with the rendered finding
    // order. `consensusProvenance` and `consensusVerdict.findings`
    // are in the new ranking; `findingMarkers[i]` lines up with
    // `renderableFindings[i]`.
    //
    // SIG-160 PR3: walk the FILTERED parallel views so markers align
    // with `postWithdrawalFindings` (== `renderableVerdict.findings`),
    // not the original pre-suppression set. Otherwise `buildReviewSubmission`
    // would index off-by-one when consulting `findingMarkers` for an inline
    // comment whose `originalIndex` survived suppression.
    //
    // SIG-276 Phase 2: extract write-time claims over the SAME filtered/
    // ranked findings, so `claimsPerFinding[j]` aligns with the marker
    // walk below. Gated behind OPENCLAW_REVIEW_MEMORY_CLAIMS (default off)
    // so the extra per-PR classifier round-trip is opt-in. Fail-open: a
    // classifier blip yields no claims rather than blocking the merge path
    // or rotating a marker. The id-less claim data rides the marker;
    // capture (PR B) recomputes each id before storing it on a signal.
    const claimT0 = Date.now()
    // SIG-280 PR C: reuse the warm pre-pass's claim extraction when it
    // ran — the (paid) classifier is invoked at most once per review. It
    // was extracted over the SAME withdrawal-filtered batch (one shared
    // `withdrawals` read + a score-independent filter), so it aligns with
    // `filteredConsensusFindings`. The length guard is belt-and-suspenders:
    // if that invariant is ever broken, fall back to a fresh extraction
    // rather than misalign markers / the shadow corpus.
    const claimsPerFinding: ReadonlyArray<readonly ReviewMemoryClaimMarkerData[]> =
      earlyClaimsPerFinding &&
      earlyClaimsPerFinding.length === filteredConsensusFindings.length
        ? earlyClaimsPerFinding
        : claimsEnabled
          ? await extractClaims({
              findings: filteredConsensusFindings.map(
                (f): ClaimExtractionFinding => ({
                  headline: f.headline,
                  body: f.body,
                  category: f.category,
                }),
              ),
              runClassifier: runClaimClassifier,
            })
          : filteredConsensusFindings.map(() => [])
    if (claimsEnabled) {
      const claimsEmitted = claimsPerFinding.reduce((s, cs) => s + cs.length, 0)
      console.log(
        JSON.stringify({
          event: "review-memory-claim-extracted",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          findingCount: filteredConsensusFindings.length,
          claimsEmitted,
          elapsedMs: Date.now() - claimT0,
        }),
      )
    }

    // SIG-285: build the added-line index + verification mode once here —
    // HOISTED above BOTH the SIG-280 shadow-claim fid computation below AND the
    // marker generation, so a re-anchored finding's line is updated BEFORE either
    // reads it (the fid includes `line`). Both consts are reused by the
    // verification block further down (no recompute).
    const verificationMode = readVerificationMode(env)
    const addedLineTextByLine = buildAddedLineTextByLine(fullPrDiff)

    // SIG-285 re-anchor ENFORCE (inline-first): when verification is `enforce`
    // AND OPENCLAW_VERIFICATION_REANCHOR=on (default OFF — inert), MOVE each
    // refuted inline finding that has an UNAMBIGUOUS same-file target to the
    // correct line, in place, keeping the marker source (filteredConsensusFindings)
    // aligned. Runs BEFORE the shadow-claim fid + the markers (Codex #260: so the
    // SIG-280 shadow fid and the posted marker both use the post-move line — no
    // corpus-join divergence). A mis-anchored inline comment becomes a CORRECTLY-
    // anchored one (the founder's inline-first direction) instead of a body row.
    // Re-anchored findings are then no longer refuted at the verification block
    // below, so PR4 only body-demotes the ambiguous/no-match remainder. Default
    // OFF → byte-identical to PR1+PR4.
    if (verificationMode === "enforce" && readReanchorEnabled(env)) {
      const reanchored = applyReanchors(
        submissionVerdict.findings,
        filteredConsensusFindings,
        addedLineTextByLine,
        isSubstantiveAnchorLine,
      )
      for (const r of reanchored) {
        console.log(JSON.stringify({
          event: "verification-reanchor-applied",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          path: r.path, fromLine: r.fromLine, toLine: r.toLine,
        }))
        // dropped:false — a re-anchored finding is KEPT inline (MOVED to the
        // correct line), NOT dropped/demoted. The `applied` reason distinguishes
        // it from the shadow would-reanchor decisions (CodeRabbit #260).
        args.validationSink?.push({ kind: "gate-rejection", gate: "verification-reanchor", reason: "applied", dropped: false })
      }
    }

    // SIG-276 Phase 3 (Site 2): SHADOW-ONLY claim-match telemetry. Match
    // each incoming finding's write-time claim TYPES against the active
    // memories' `shadowClaims` (populated by lookup Site 1) and emit ONE
    // aggregated `review-memory-claim-shadow` event per review. This pass
    // is OBSERVATION-ONLY — its output is block-scoped and consumed by
    // NOTHING below (no markers, no soften, no submission). It changes no
    // score and posts no comment; it only generates the corpus Phase 4
    // calibrates on. Gated: requires the shadow flag AND real claims
    // (claimsEnabled) AND a non-skipped lookup — otherwise a no-op.
    if (
      claimShadowMode !== "off" &&
      claimsEnabled &&
      shadowMemoriesForPhase3.length > 0
    ) {
      const shadowPathHashes = await Promise.all(
        filteredConsensusFindings.map((f) => computePathSha256(f.path)),
      )
      // SIG-280: per-finding sha16 fid (same canonical form as the marker)
      // becomes the OFFLINE join key linking this claim-matched finding to a
      // later `review-memory-outcome` dismissal event. NOTE (SIG-285, Codex #260):
      // the re-anchor mutation runs ABOVE this block, so `f.line` here is already
      // the post-move line — this fid matches the posted marker fid even for a
      // re-anchored finding (no SIG-280 corpus-join divergence).
      const shadowFids = await Promise.all(
        filteredConsensusFindings.map((f) =>
          computeFid({ ruleId: null, path: f.path, line: f.line, headline: f.headline }),
        ),
      )
      const shadowFindings: ShadowMatchFinding[] = filteredConsensusFindings.map(
        (f, j) => {
          const sourceSpec = filteredConsensusProvenance[j]?.sourceSpecialists?.[0]
          return {
            category: sourceSpec ? categoryFromRoleHint(sourceSpec) : null,
            pathSha12: shadowPathHashes[j]?.slice(0, 12) ?? null,
            fid: shadowFids[j] ?? "",
            severityTier: severityTier(f.score),
            claims: (claimsPerFinding[j] ?? []).map((c) => ({
              type: c.type,
              extractorVersion: c.extractorVersion,
            })),
          }
        },
      )
      const shadowRows = shadowMatchReviewMemoryClaims({
        memories: shadowMemoriesForPhase3,
        findings: shadowFindings,
      })
      // Emit unconditionally (within the gate): a matchCount:0 event is a
      // meaningful Phase-4 DENOMINATOR — "shadow ran with active memories but
      // no finding's category overlapped" — so coverage is explicit rather
      // than inferred from the absence of an event.
      const shadowEvent = {
        event: "review-memory-claim-shadow",
        owner,
        repo,
        prNumber,
        headSha: headSha.slice(0, 7),
        matchCount: shadowRows.length,
        matches: shadowRows,
      }
      console.log(JSON.stringify(shadowEvent))
      // SIG-280 PR A: ALSO persist the rows to a durable KV record so the
      // offline calibration fit (which reads KV, not console logs) can read
      // the claim-matched set — the NEGATIVE-class denominator. Each row's
      // `fid` joins to the dismissal signals already in KV (same computeFid),
      // which are the POSITIVE labels. Best-effort: never throws (this is
      // telemetry on the review path); enum/numeric/bool + sha16 fid only.
      try {
        const reverseTs = String(9_999_999_999_999 - Date.now()).padStart(13, "0")
        await env.OPENCLAW_STATE.put(
          `review-memory-claim-shadow:${reverseTs}:${owner}/${repo}#${prNumber}:${headSha.slice(0, 7)}`,
          JSON.stringify(shadowEvent),
          { expirationTtl: 30 * 24 * 60 * 60 },
        )
      } catch {
        // best-effort durable corpus write — losing one is acceptable; the
        // console event still lands for live/Logpush observation.
      }
    }

    // `let` (was const): SIG-285 PR 4 filters this in lockstep with
    // submissionVerdict.findings when a refuted finding is demoted, to keep the
    // marker<->finding index alignment the builder relies on (SIG-127).
    let findingMarkers: Array<string | null> = await Promise.all(
      filteredConsensusFindings.map(async (f, j) => {
        const sourceSpec = filteredConsensusProvenance[j]?.sourceSpecialists?.[0]
        if (!sourceSpec) return null
        return await buildSigilixMarker({
          ruleId: null,
          path: f.path,
          line: f.line,
          headline: f.headline,
          category: categoryFromRoleHint(sourceSpec),
          severity: markerSeverityFromScore(f.score),
          claims: claimsPerFinding[j] ?? [],
        })
      }),
    )

    // ARC-286 / SIG-88 — merge-guard runs BEFORE we bump the
    // SIG-101 counter or render the body so a PR that merged mid-
    // review takes the marker-only APPROVE path without ghost-
    // advancing the per-PR review counter. CodeRabbit catch on
    // PR #110: pre-fix the bump ran before the guard, so a
    // `merged-during-review` short-circuit incremented the counter
    // even though nothing user-visible rendered. The reorder
    // doesn't change any other behavior — `checkIsPrMerged` is a
    // pure read against the GitHub API and only needs (client,
    // owner, repo, prNumber, headSha), all available here.
    //
    // SIG-88 (2026-05-18): on the merged branch, we now submit a
    // marker-only APPROVE instead of bailing to a skip-notice. Posting
    // REQUEST_CHANGES on already-merged code is noise (and was the
    // pre-ARC-286 behavior that ARC-286 fixed by bailing); CodeRabbit
    // posts a lightweight APPROVE here so the GitHub Checks UI shows
    // a clean "passed" state instead of an empty skip. The ensemble
    // verdict we just computed is discarded — submitting it as
    // REQUEST_CHANGES would compete with the merge.
    const mergeGuard = await checkIsPrMerged({ client, owner, repo, prNumber, headSha })
    if (mergeGuard.shouldSkip) {
      telemetry.fellBackReason = "merged_during_review"
      const out = await submitMergedOnApprove({
        client, owner, repo, prNumber, headSha,
        stage: "pre-submit",
        mergedAtMs: mergeGuard.mergedAtMs,
        startMs,
      })
      if (out.ok) {
        // CR PR #104 Major catch: same post-submit verification as the
        // pre-fanout branch above. See that block for the rationale.
        await verifyReviewPersisted(
          client, owner, repo, prNumber, out.reviewId,
          "merged-on-approve-pre-submit", out.state,
        )
        return finalize(telemetry, env, "posted", cache, {
          event: "APPROVE",
          findingsCount: 0,
          ...(runnerEvidenceBadge ? { runnerEvidence: runnerEvidenceBadge } : {}),
          ...deterministicCheckAnnotationMeta(),
        })
      }
      return finalize(telemetry, env, "errored", cache, deterministicErroredReviewMeta())
    }

    // SIG-101/SIG-205: approval-readiness blockers can still force a
    // REQUEST_CHANGES review even though they render in the body. The
    // review counter itself is bumped later, after the renderer chooses
    // the final event from the rendered surface, so body-only findings
    // BELOW the blocker floor (score < 4) do not advance the
    // request-changes sequence. SIG-281 PR A: a body-only finding of
    // score >= 4 now DOES escalate the rendered event to REQUEST_CHANGES
    // (the believability floor) and therefore advances the sequence,
    // even without an approval-readiness blocker.
    if (approvalReadiness.blockers.length > 0) {
      console.warn(JSON.stringify({
        event: "pr-review-approval-readiness-blocked",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        legacy_event: intendedEvent,
        effective_event: effectiveEvent,
        blockers: approvalReadiness.blockers.slice(0, 5).map((b) => ({
          sourceFindingId: b.sourceFindingId,
          role: b.role,
          path: b.path,
          line: b.line,
          score: b.score,
          confidence: b.confidence,
          headline: b.headline,
        })),
      }))
    }

    // SIG-161 PR 4b — shadow-mode telemetry. Off the critical path:
    // the KV read + divergence compute + log write are dispatched as
    // a detached promise so a slow KV cold-read or anything else CANNOT
    // delay the customer-visible verdict submission below.
    //
    // CodeRabbit catch (PR #146 fix-up #2): the prior version `await`ed
    // `readGateThreshold` inline, which added a KV read latency budget
    // to every production review even though shadow is observation-
    // only. Fire-and-forget here is acceptable because the work is
    // small (single KV read + ~1ms compute + single console.log) and
    // CF Workers' microtask queue drains before the isolate is killed.
    // If shadow ever grows expensive enough to warrant `ctx.waitUntil`,
    // plumb the ExecutionContext through `EnsembleHandlerArgs`.
    //
    // The pure-helper `computeShadowGateDivergence` lives in
    // triage-pr-review.ts (unit-tested there); this call site just
    // does the I/O — read env, read KV threshold, write the log.
    // Wrapped in try/catch so a KV outage / compute failure CANNOT
    // surface as an unhandled rejection.
    const gateMode = readGateMode(env)
    if (gateMode !== "off") {
      // Snapshot the inputs at the (sync) call site so the detached
      // task doesn't race with later mutation of `renderableVerdict`.
      const snapshotRenderable: PrReviewFinding[] = [...submissionVerdict.findings]
      const snapshotUnanchored: PrReviewFinding[] = [...renderableUnanchoredForSubmission]
      const snapshotProvenance = [...filteredConsensusProvenance]
      const snapshotLegacy = effectiveEvent
      void (async () => {
        try {
          const threshold = await readGateThreshold(env)
          const result = computeShadowGateDivergence({
            renderable: snapshotRenderable,
            unanchored: snapshotUnanchored,
            provenance: snapshotProvenance,
            threshold,
            legacyEvent: snapshotLegacy,
          })
          if (result.divergence) {
            console.log(
              JSON.stringify({
                event: "pr-review-gate-shadow-divergence",
                owner,
                repo,
                prNumber,
                headSha: headSha.slice(0, 7),
                mode: gateMode,
                ...result.divergence,
              }),
            )
          }
        } catch (err) {
          console.log(
            JSON.stringify({
              event: "pr-review-gate-shadow-error",
              owner,
              repo,
              prNumber,
              headSha: headSha.slice(0, 7),
              mode: gateMode,
              error: err instanceof Error ? err.message : String(err),
            }),
          )
        }
      })()
    }

    // SIG-285 PR 1 (shadow): verification-by-execution, observe-only. For the
    // findings we're about to submit, re-check that the code token each score>=4
    // logic/security finding CITES actually appears at the line it points to
    // (worker-native, line-anchored — no subprocess, no new perms). Emit the
    // verdict (confirmed/refuted/inconclusive/no-check) keyed for a SIG-114
    // outcome join (the refutable-FP fraction). SIG-285 PR 4: in `enforce`, a
    // REFUTED score>=4 logic/security finding that is currently INLINE is a
    // mis-anchored citation — DEMOTE it to the PR body (never drop; FN-cost >>
    // FP-cost). The demote moves a mis-anchored INLINE comment to a body row; it
    // does NOT unblock the merge (a score>=4 body finding still forces
    // REQUEST_CHANGES via the SIG-281 body-only floor) — it changes the surface,
    // not the gate. `shadow` observes-only (counts the would-demote). Off = no
    // work. The move runs BEFORE buildReviewSubmissionWithMetadata so the event +
    // marker alignment recompute over the post-demote split.
    if (verificationMode !== "off") {
      // Cover EVERY submitted score>=4 logic/security finding — inline AND the
      // body-only (unanchored) ones — so the refutable-FP measurement isn't
      // biased by which surface a finding landed on (CR).
      const submittedFindings = [
        ...submissionVerdict.findings,
        ...renderableUnanchoredForSubmission,
      ]
      const verificationItems: RecordVerificationArgs[] = []
      for (const finding of submittedFindings) {
        if (finding.score < 4) continue
        if (finding.category !== "logic" && finding.category !== "security") continue
        const result = verifyFinding(finding, addedLineTextByLine)
        console.log(JSON.stringify({
          event: "verification-shadow",
          gate: "verification",
          mode: verificationMode,
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          findingKey: findingKey(finding),
          path: finding.path,
          line: finding.line,
          score: finding.score,
          category: finding.category,
          verdict: result.verdict,
          tokenCount: result.tokens.length,
          ...(result.check ? { checkKind: result.check.kind, checkStatus: result.check.status } : {}),
        }))
        verificationItems.push({ verdict: result.verdict, category: finding.category })
        // Trust Ledger: a CONFIRMED worker-token re-check (the cited token is
        // present at the cited line) is a proof signal. Annotate in place — the
        // finding object's identity is reused by selectRefutedInlineDemotions +
        // the marker index below, so we must not swap it for a clone. Gated on the
        // flag so `off` is a true no-op (no trust mutation at all).
        if (trustLedgerMode !== "off" && result.verdict === "confirmed") {
          annotateFindingTrust(finding, { signals: ["worker-token-confirmed"] })
        }
      }
      // SIG-285 PR 2: persist the review's verdict distribution to
      // VerificationMetricsDO (one batched RPC). Best-effort + bounded so a
      // stalled DO can't eat orchestrator time, and a failure NEVER breaks the
      // review (telemetry only). Read via GET /metrics/verification.
      await recordVerificationMetricsBounded(
        env, verificationItems, 1_500,
        (event, detail) => console.warn(JSON.stringify({ event, owner, repo, prNumber, ...detail })),
      )
      // SIG-285 PR 4: the demote subset = the REFUTED inline findings (pure,
      // unit-tested helper). Record the demote decision per finding on the shared
      // validation corpus (gate `verification-refuted`, readable at
      // /metrics/validation alongside the grounding gates) — `dropped` = actually
      // demoted (enforce) vs would-demote (shadow), matching the gates' semantics.
      const refutedInline = selectRefutedInlineDemotions(submissionVerdict.findings, addedLineTextByLine)
      const demoting = verificationMode === "enforce"
      for (const finding of refutedInline) {
        console.log(JSON.stringify({
          event: "pr-review-finding-rejected-validation",
          gate: "verification-refuted",
          mode: verificationMode,
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          reason: "refuted-citation",
          dropped: demoting,
          path: finding.path,
          line: finding.line,
          score: finding.score,
          category: finding.category,
        }))
        args.validationSink?.push({ kind: "gate-rejection", gate: "verification-refuted", reason: "refuted-citation", dropped: demoting })
        // SIG-285 (inline-first, SHADOW measurement only — NO mutation in this
        // PR): for each refuted finding, would it RE-ANCHOR to the correct added
        // line (the inline-first fix) or only body-demote? Measures the
        // would-reanchor rate (reanchor | ambiguous | no-match) at
        // /metrics/validation (gate `verification-reanchor`) BEFORE the PR that
        // actually mutates the line (which must run before marker generation).
        const reanchor = planReanchor(finding, addedLineTextByLine)
        console.log(JSON.stringify({
          event: "verification-reanchor-shadow",
          mode: verificationMode,
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          findingKey: findingKey(finding), // parity with verification-shadow for the SIG-114 join
          path: finding.path,
          fromLine: finding.line,
          decision: reanchor.kind,
          ...(reanchor.kind === "reanchor" ? { toLine: reanchor.toLine } : {}),
          ...(reanchor.kind === "ambiguous" ? { candidateLines: reanchor.candidateLines } : {}),
        }))
        args.validationSink?.push({ kind: "gate-rejection", gate: "verification-reanchor", reason: reanchor.kind, dropped: false })
      }
      // Enforce only: move the refuted findings from the inline set to the
      // body-only set BEFORE buildReviewSubmissionWithMetadata. The builder
      // re-derives the review event from the post-demote inline/body split, so a
      // demoted finding stops being an inline comment — but it is NOT unblocked:
      // it is still score>=4, and the SIG-281 body-only floor keeps a score>=4
      // body finding at REQUEST_CHANGES. The demote changes the SURFACE (a
      // mis-anchored inline thread becomes a body row), not the gate. Never
      // hard-drops; stays fully visible. `applyRefutedDemotion` filters
      // findingMarkers in lockstep so the marker<->finding alignment the builder
      // indexes by (SIG-127) survives. Inline findings were already
      // withdrawal-filtered, so the move can't re-introduce a dismissed finding.
      if (demoting && refutedInline.length > 0) {
        const { keptFindings, keptMarkers, demoted } = applyRefutedDemotion(
          submissionVerdict.findings,
          findingMarkers,
          new Set<PrReviewFinding>(refutedInline),
        )
        submissionVerdict.findings = keptFindings
        findingMarkers = keptMarkers
        // Trust Ledger: these refuted findings are now body-routed because their
        // inline citation was mis-anchored. Mark the surface + reason (the tier
        // stays whatever stronger proof it carries — resolveTier never lowers it).
        if (trustLedgerMode !== "off") {
          for (const d of demoted) {
            annotateFindingTrust(d, { surface: "body", demoteReason: "verification-refuted" })
          }
        }
        renderableUnanchoredForSubmission.push(...demoted)
      }
    }

    // SIG-285 v2 PR1 (receipt-join, no-perm, shadow): when a VERIFIED runner
    // receipt is present (receiptScanIndex built above), re-check each submitted
    // score>=4 SECURITY finding with a resolvable evidenceId against HEAD's OWN
    // scan — CONFIRMED if the same rule still fires at the cited path/line,
    // INCONCLUSIVE otherwise (NEVER refuted; absence is over-determined). PR1 is
    // TELEMETRY ONLY (event:verification-receiptjoin keyed findingKey for the
    // SIG-114 join); it measures the refutable-eligible fraction that decides
    // whether the demote path (PR4/5) is worth building vs receipts-as-trust.
    // Independent of OPENCLAW_VERIFICATION_MODE; gated by the index being built.
    if (receiptScanIndex !== null) {
      const rjMode = receiptJoinMode
      // SIG-285 v2 PR2: persist the verdict distribution to VerificationMetricsDO
      // under RECEIPTJOIN_CATEGORY (a separate corpus from worker-token) so the
      // refutable-eligible fraction is readable at GET /metrics/verification —
      // the load-bearing measurement, not just live `wrangler tail`.
      const receiptJoinItems: RecordVerificationArgs[] = []
      for (const finding of [...submissionVerdict.findings, ...renderableUnanchoredForSubmission]) {
        if (finding.score < 4 || finding.category !== "security") continue
        const result = verifyFindingAgainstReceipt(finding, receiptScanIndex)
        if (result.verdict === "no-check") continue
        console.log(JSON.stringify({
          event: "verification-receiptjoin",
          mode: rjMode,
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          findingKey: findingKey(finding),
          path: finding.path,
          line: finding.line,
          score: finding.score,
          verdict: result.verdict,
          ...(result.check ? { checkStatus: result.check.status } : {}),
        }))
        receiptJoinItems.push({ verdict: result.verdict, category: RECEIPTJOIN_CATEGORY })
        // Trust Ledger: a CONFIRMED receipt join (the same rule still fires in the
        // VERIFIED runner receipt's HEAD scan) is the STRONGEST proof tier. In place
        // (identity already preserved by this point — post-demote). Flag-gated.
        if (trustLedgerMode !== "off" && result.verdict === "confirmed") {
          annotateFindingTrust(finding, { signals: ["runner-confirmed"] })
        }
      }
      // Best-effort + bounded (same as the worker-token block) — a stalled DO or
      // a record failure NEVER breaks the review (measurement only).
      await recordVerificationMetricsBounded(
        env, receiptJoinItems, 1_500,
        (event, detail) => console.warn(JSON.stringify({ event, owner, repo, prNumber, ...detail })),
      )
    }

    // SIG Trust Ledger v0: give every final visible
    // finding a BASELINE trust tier (the strong proof signals — worker-token-confirmed,
    // runner-confirmed — were already set in place above), then record the per-tier
    // distribution. The baseline is surface-aware + honest-conservative:
    //   - INLINE findings passed validation AND anchored, so they have grounding →
    //     grounded-model (or deterministic-grounded with a real manifest evidenceId,
    //     the SIG-108 security-evidence path).
    //   - BODY findings claim NO grounding by default → body-only-ungrounded (the
    //     MODEL pill), lifted only by a real evidenceId or a proof signal above. We
    //     under-claim rather than over-claim believability for body-routed findings.
    // resolveTier keeps the stronger tier, so a baseline never lowers a proven
    // finding. Distribution persists to VerificationMetricsDO under TRUSTLEDGER_CATEGORY
    // (a SEPARATE corpus, read at GET /metrics/verification). Whole block is flag-gated,
    // so `off` (default) is a true no-op; `on` lets the renderer surface these
    // tiers as the Trust Summary and per-finding pills.
    if (trustLedgerMode !== "off") {
      const hasManifestEvidence = (finding: PrReviewFinding): boolean => {
        const ev = typeof finding.evidenceId === "string" ? finding.evidenceId.trim() : ""
        return ev.length > 0 && ev !== "NONE"
      }
      for (const finding of submissionVerdict.findings) {
        annotateFindingTrust(finding, {
          signals: [hasManifestEvidence(finding) ? "deterministic-grounded" : "grounded-model"],
          surface: "inline",
        })
      }
      for (const finding of renderableUnanchoredForSubmission) {
        annotateFindingTrust(finding, {
          signals: [hasManifestEvidence(finding) ? "deterministic-grounded" : "body-only-ungrounded"],
          surface: "body",
        })
      }
      const trustItems: RecordVerificationArgs[] = [
        ...submissionVerdict.findings,
        ...renderableUnanchoredForSubmission,
      ].map((finding) => ({
        verdict: finding.trust?.tier ?? "body-only-ungrounded",
        category: TRUSTLEDGER_CATEGORY,
      }))
      // Best-effort + bounded (same as the verification blocks) — a stalled DO or a
      // record failure NEVER breaks the review (measurement only).
      await recordVerificationMetricsBounded(
        env, trustItems, 1_500,
        (event, detail) => console.warn(JSON.stringify({ event, owner, repo, prNumber, ...detail })),
      )
    }

    if (showEvidence) {
      for (const [index, finding] of [
        ...submissionVerdict.findings,
        ...renderableUnanchoredForSubmission,
      ].entries()) {
        const record = finding.evidence
        const evidencePieces = evidencePieceCountForTelemetry(record)
        console.log(JSON.stringify({
          event: "pr-review-evidence-emitted",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          index,
          path: finding.path,
          line: finding.line,
          score: finding.score,
          category: finding.category,
          visible: true,
          specialists_flagged: record?.specialistsThatFlagged.length ?? 0,
          specialists_declined: record?.specialistsThatDeclined.length ?? 0,
          deterministic_fact_ids: record?.deterministicFactIds.length ?? 0,
          retrieval_chunk_ids: record?.retrievalChunkIds.length ?? 0,
          related_prior_prs: record?.relatedPriorPRs.length ?? 0,
          consensus_score: record?.consensusScore ?? 0,
          synth_decision: record?.synthDecision ?? null,
          structured_evidence_empty: evidencePieces === 0,
        }))
      }
    }

    for (const finding of submissionVerdict.findings) {
      const mismatch = getProposedChangeScopeMismatch(finding)
      if (mismatch === null) continue
      console.log(JSON.stringify({
        event: "pr-review-finding-anchor-scope-mismatch",
        gate: "rendering",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        reason: "replacement_anchor_scope_mismatch",
        dropped: false,
        path: finding.path,
        line: finding.line,
        startLine: finding.startLine ?? null,
        score: finding.score,
        category: finding.category,
        anchorLines: mismatch.anchorLines,
        replacementLines: mismatch.replacementLines,
        replacementToAnchorRatio: Number(mismatch.replacementToAnchorRatio.toFixed(3)),
      }))
    }

    const primaryEvent = previewReviewSubmissionEvent({
      verdict: submissionVerdict,
      headSha,
      unanchored: renderableUnanchoredForSubmission,
      reviewable,
      addedLineTextByLine,
      ...(reviewEventOverride !== undefined ? { eventOverride: reviewEventOverride } : {}),
    })
    const primaryAffordance = await prepareSubmissionAffordance({
      env, owner, repo, prNumber, event: primaryEvent,
    })
    const prepareFallbackAffordance = async (event: ReviewEvent): Promise<SubmissionAffordance> =>
      event === primaryEvent
        ? primaryAffordance
        : prepareSubmissionAffordance({ env, owner, repo, prNumber, event })

    // SIG-318 (PR 0b): bind the render args so the golden-capture hook below
    // records the EXACT object passed to buildReviewSubmissionWithMetadata (no
    // behavior change — same object, same call). No-op unless
    // OPENCLAW_GOLDEN_CAPTURE === "on".
    const submissionBuildArgs = {
      verdict: submissionVerdict,
      prAuthor: meta.user?.login ?? null,
      headSha,
      // SIG Trust Ledger v0: render the trust layer (Trust Summary + per-finding
      // VERIFIED/GROUNDED/MODEL pills) only in `on` mode. off/shadow → byte-identical
      // body. (The Summary's `suppressed` count is a PR3b follow-up.)
      trustLedger: trustLedgerMode === "on",
      showEvidence,
      unanchored: renderableUnanchoredForSubmission,
      findingMarkers,
      ...(reviewEventOverride !== undefined ? { eventOverride: reviewEventOverride } : {}),
      // ARC-182 (code-review C1): thread stack so the renderer can
      // append the `_(Stacked on #N)_` parenthetical to the summary
      // (post-ARC-281 — used to be a multi-line "### Stack context"
      // block). Without this the parenthetical only appears on the
      // single-model path, which is now dead.
      ...(stack.isStacked ? { stack } : {}),
      // ARC-281: thread specialist coverage + delta counts through
      // to the new renderer.
      coverage,
      // SIG-245: files dropped from review (diff-budget spill into a later
      // batch, or individually too large) → a visible "files not reviewed"
      // notice in the body so a silently-dropped file is never invisible. The
      // review is also downgraded APPROVE→COMMENT above so this notice renders
      // even when batch[0] was clean (it would be discarded by the marker-only
      // APPROVE body otherwise).
      notReviewedFiles: filesDroppedFromReview,
      delta: deltaCounts,
      ...(primaryAffordance.reviewCounter !== undefined
        ? { reviewCounter: primaryAffordance.reviewCounter }
        : {}),
      ...(primaryAffordance.retriggerUrl !== undefined
        ? { retriggerUrl: primaryAffordance.retriggerUrl }
        : {}),
      // SIG-125: thread the diff's reviewable-position map so
      // `formatFindingComment` can render committable ```suggestion
      // blocks when a finding cleanly anchors (RIGHT + contiguous).
      reviewable,
      // SIG-127: per-file new-side-line → text map so findings the
      // model anchored to a non-substantive structural line (a bare
      // `}`, blank line) route to the summary body instead of an
      // inline comment "on an empty line."
      addedLineTextByLine,
      // SIG-216 fix-up: thread the source-repo coordinates so the
      // body-only finding anchors render as clickable Markdown links
      // (`[path:line](https://github.com/...blob/<sha>/<path>#L<line>)`)
      // in production. Pre-fix-up the clickable-link path was test-only
      // because the ensemble didn't pass `linkContext`, so real PR
      // reviews fell back to the back-compat inline-code anchor.
      linkContext: { owner, repo, headSha },
    } satisfies Parameters<typeof buildReviewSubmissionWithMetadata>[0]
    const submissionBuild = buildReviewSubmissionWithMetadata(submissionBuildArgs)
    // SIG-318 (PR 0b): golden-output capture seam #2 (render). No-op unless
    // OPENCLAW_GOLDEN_CAPTURE === "on"; off/unset → byte-identical behavior.
    // `trace` = the in-scope decision values at this seam (Kimi's ask): specialist
    // coverage, degraded-coverage + downgrade signals, consensus ranking, finding
    // delta, verdict-gate override, trust-ledger mode, and the token ledger. These
    // are diagnostic context, NOT asserted by the parity test.
    captureGolden(env, "render", {
      input: submissionBuildArgs,
      output: submissionBuild,
      trace: {
        coverage,
        degradedCoverage,
        reviewIncomplete,
        synthConfidence,
        approvalReadiness,
        deltaCounts,
        reviewEventOverride,
        trustLedgerMode,
        consensusByIndex: filteredConsensusByIndex,
        tokenUsageByModel,
      },
    })
    const submission = submissionBuild.submission
    const bodyOnlyAnnotations = submissionBuild.bodyOnlyAnnotations
    const allFindingAnnotations = buildBodyOnlyCheckAnnotations([
      ...submissionVerdict.findings,
      ...renderableUnanchoredForSubmission,
    ])
    const checkAnnotationMeta = (annotations: CheckRunAnnotation[]) =>
      annotations.length > 0 ? { checkAnnotations: annotations } : {}

    // SIG-144: when the configured surface is `annotations` (only), the
    // findings are delivered as Check annotations (posted by the
    // dispatcher's `completeCheckRun`), NOT as inline review comments.
    // Strip the inline comments from the submission so the formal review
    // still registers its verdict (APPROVE / REQUEST_CHANGES) + summary
    // body, but doesn't double-post each finding as a review comment. The
    // `both` and `comments` surfaces keep inline comments untouched.
    const reviewOutputSurface = ensembleConfig.flags.reviewOutputSurface
    const { suppressedComments } = applyOutputSurfaceToSubmission(submission, reviewOutputSurface)
    if (suppressedComments > 0) {
      console.log(JSON.stringify({
        event: "pr-review-inline-comments-suppressed-for-annotations",
        owner, repo, prNumber,
        suppressed: suppressedComments,
      }))
    }
    // ─── SIG-216: post the overview comment IMMEDIATELY before the
    // review submit so the two GitHub timeline entries land in the
    // same time window (CodeRabbit-style Walkthrough-then-Review).
    // The overview is informed by the review's verdict — we pass
    // findingsCount + severity + category breakdown + the chosen
    // event so the model can summarize "what reviewer concluded"
    // instead of running blind. Gated on `overview.enabled` per the
    // same `sigilixConfig` the ensemble loaded earlier; opted-out
    // customers skip the inline render.
    //
    // Awaited (not `ctx.waitUntil`) so the overview comment is
    // GUARANTEED on the PR timeline before `submitReview` fires.
    // `skipDedupe: true` bypasses the per-(PR, headSha) KV dedupe
    // lock inside `handlePrOverview` so a sibling queued run (legacy
    // warmup refresh, etc.) on this SHA can't block us — but does
    // NOT bypass the in-handler stale-head guards (those still fire
    // on this path, catching head moves that landed during the
    // review's own Ollama window). SIG-216 fix-up swap from
    // `force: true` (which historically bypassed both).
    //
    // Budgeting (SIG-216 fix-up): the overview runs against the
    // REMAINING review budget so a stalled overview can't push the
    // handler past ORCHESTRATOR_TIMEOUT_MS (the wall the orchestrator
    // itself aborts on). Capped at INLINE_OVERVIEW_MAX_BUDGET_MS even
    // on a budget surplus so the overview never eats more than its
    // fair share. When remaining budget falls under
    // INLINE_OVERVIEW_MIN_BUDGET_MS we skip the inline render entirely
    // — the overview can fire on the next push.
    //
    // Retry policy (SIG-216 fix-up): single retry on transient
    // failures (timeouts / 502 / 503 / 504 / fetch-failed /
    // budget-exceeded). Pre-SIG-216 the queue consumer gave
    // MAX_RETRIES=3 on Ollama transients; the inline path had zero.
    // One retry only — bounded by the same Promise.race budget so
    // we can't blow the wall-clock even on a double attempt.
    //
    // Best-effort: even after the single retry, a failure here
    // NEVER blocks the review submit. The customer still gets the
    // review even if the overview comment fails to land.
    if (isPrOverviewEnabled(sigilixConfig)) {
      const overviewStartMs = Date.now()
      const overviewReviewContext: PrOverviewReviewContext = {
        findingsCount:
          submissionVerdict.findings.length + renderableUnanchoredForSubmission.length,
        severityBreakdown: countBySeverity([
          ...submissionVerdict.findings,
          ...renderableUnanchoredForSubmission,
        ]),
        categoryBreakdown: countByCategory([
          ...submissionVerdict.findings,
          ...renderableUnanchoredForSubmission,
        ]),
        verdict: primaryEvent,
      }
      // Reserve INLINE_OVERVIEW_SUBMIT_RESERVE_MS for the submitReview
      // GitHub roundtrip + the post-overview stale-head re-check that
      // follows; the overview itself gets whatever's left up to
      // INLINE_OVERVIEW_MAX_BUDGET_MS.
      //
      // SIG-216 fix-up (CR catch): budget against ORCHESTRATOR_TIMEOUT_MS,
      // not CF_QUEUE_CONSUMER_CEILING_MS. The orchestrator's own
      // wall-clock is the actual bound on this handler — the platform
      // ceiling is wider (CF_QUEUE_CONSUMER_CEILING_MS - ORCHESTRATOR_TIMEOUT_MS
      // is the grace pad reserved for finalize/cleanup). Using the
      // wider ceiling could push the overview past the orchestrator's
      // own abort and burn the grace pad too.
      const elapsedMs = Date.now() - startMs
      const remainingBudgetMs = Math.max(
        0,
        ORCHESTRATOR_TIMEOUT_MS - elapsedMs - INLINE_OVERVIEW_SUBMIT_RESERVE_MS,
      )
      const overviewBudgetMs = Math.min(remainingBudgetMs, INLINE_OVERVIEW_MAX_BUDGET_MS)
      if (overviewBudgetMs < INLINE_OVERVIEW_MIN_BUDGET_MS) {
        console.log(JSON.stringify({
          event: "pr-review-inline-overview-skipped-budget",
          owner, repo, prNumber, head_sha: headSha.slice(0, 7),
          remaining_budget_ms: remainingBudgetMs,
          threshold_ms: INLINE_OVERVIEW_MIN_BUDGET_MS,
        }))
      } else {
        try {
          await runInlineOverviewWithRetry({
            owner, repo, prNumber, headSha, installationId, env,
            skipDedupe: true,
            reviewContext: overviewReviewContext,
          }, overviewBudgetMs)
          // SIG-149: time-to-first-overview = handler entry → overview
          // posted (first customer-visible content). Measured from
          // `startMs`, NOT `overviewStartMs` (that's the overview's own
          // generation time, already logged as `elapsed_ms`). Set only on
          // the success path so `finalize()` reports it as "no data" when
          // the overview was skipped/failed rather than a misleading 0.
          telemetry.timeToFirstOverviewMs = Date.now() - startMs
          console.log(JSON.stringify({
            event: "pr-review-inline-overview-posted",
            owner, repo, prNumber, head_sha: headSha.slice(0, 7),
            elapsed_ms: Date.now() - overviewStartMs,
            budget_ms: overviewBudgetMs,
            findings_count: overviewReviewContext.findingsCount,
            verdict: overviewReviewContext.verdict,
          }))
        } catch (err) {
          console.error(JSON.stringify({
            event: "pr-review-inline-overview-failed",
            owner, repo, prNumber, head_sha: headSha.slice(0, 7),
            elapsed_ms: Date.now() - overviewStartMs,
            budget_ms: overviewBudgetMs,
            err: err instanceof Error ? err.message : String(err),
          }))
        }
      }

      // SIG-216 fix-up: re-check the PR head AFTER the inline overview.
      // Belt-and-braces with the in-overview guards: the overview's own
      // pre-Ollama + pre-write guards (which now fire on the inline
      // path since we use `skipDedupe`, not `force`) catch head moves
      // BEFORE / DURING the overview's Ollama call; this re-check
      // catches moves landing AFTER the overview returns, before the
      // review submit. Both layers are intentional — different windows.
      // Fail-closed on lookup error — matches the existing guard pattern.
      try {
        const metaPostOverview = await client.getPullRequest(owner, repo, prNumber)
        if (metaPostOverview.head?.sha && metaPostOverview.head.sha !== headSha) {
          telemetry.fellBackReason = "stale_head_after_inline_overview"
          console.log(JSON.stringify({
            event: "pr-review-stale-head-after-inline-overview",
            owner, repo, prNumber,
            queued_head_sha: headSha.slice(0, 7),
            current_head_sha: metaPostOverview.head.sha.slice(0, 7),
          }))
          await handleStaleHead({
            env, owner, repo, prNumber, installationId,
            queuedHeadSha: headSha,
            currentHeadSha: metaPostOverview.head.sha,
            baseSha: metaPostOverview.base?.sha ?? null,
            depth: staleHeadRequeueDepth,
            source: "ensemble-after-inline-overview",
            ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
          })
          return finalize(telemetry, env, "stale_head", cache)
        }
      } catch (err) {
        // Fail-closed: uncertain head state → abort the submit rather
        // than risk shipping a stale review. Matches Codex's pattern in
        // `triage-pr-overview.ts`.
        console.warn(JSON.stringify({
          event: "pr-review-stale-recheck-failed-aborted",
          owner, repo, prNumber, head_sha: headSha.slice(0, 7),
          err: err instanceof Error ? err.message : String(err),
        }))
        telemetry.fellBackReason = "stale_head_recheck_failed"
        return finalize(telemetry, env, "errored", cache, deterministicErroredReviewMeta())
      }
    }

    // ARC-287 (pre-SIG-85): dismiss prior Sigilix reviews BEFORE
    // posting the new one, so the GitHub timeline renders cleanup-
    // above-current-review (oldest-at-top). Pre-ARC-287 the dismiss
    // fired AFTER the submit, producing a footgun where the dismissal
    // banner showed BELOW the new review chronologically (PR #95's
    // `8ad306a` review demonstrated this — see ARC-287).
    //
    // SIG-85 (2026-05-18): `dismissPriorSigilixReviews` no longer
    // dismisses — it emits `pr-review-stale-detected` telemetry per
    // matching prior. Customers enable GitHub's repo-level "Dismiss
    // stale pull request approvals when new commits are pushed"
    // branch-protection setting; GitHub then handles the dismissal
    // natively and attributes it to the commit pusher. See
    // docs/setup/customer-onboarding.md. The call stays here for the
    // telemetry signal; arguments unchanged so callers don't need
    // updating.
    //
    // Best-effort try/catch — the helper never throws in practice,
    // but defense in depth keeps a hypothetical bug from breaking the
    // submit path.
    try {
      await dismissPriorSigilixReviews({
        client, owner, repo, prNumber,
        currentReviewId: null,
        headSha,
      })
    } catch (err) {
      console.error(JSON.stringify({
        event: "pr-review-dismiss-prior-failed",
        owner, repo, prNumber,
        submit_path: "pre-submit",
        err: err instanceof Error ? err.message : String(err),
      }))
    }

    // ARC-284: wrap the submit so a slow GitHub roundtrip shows up in
    // the trace. Covers BOTH the success path and the 422-fallback
    // path that the catch block dispatches to.
    const submitStartMs = Date.now()
    try {
      const submitted = await client.submitReview(owner, repo, prNumber, submission)
      // ARC-258 follow-up (PR #84 anomaly catch, refined PR #86):
      // GitHub's `POST /pulls/{n}/reviews` occasionally returns 2xx
      // with a valid-looking `{id, state}` payload but the review
      // doesn't become publicly visible — either it never persists
      // (PR #84) or it persists in `PENDING` (draft) state (PR #86).
      // Both are caught by verifying against `listPullRequestReviews`
      // (the public list excludes PENDING). If verify can't confirm,
      // mark the run as `errored` so the Check Run reflects reality
      // (failure ≠ silent success) and the customer sees a signal
      // that a real submit didn't happen.
      const verified = await verifyReviewPersisted(
        client, owner, repo, prNumber, submitted.id,
        "inline-anchored", submitted.state,
      )
      if (!verified) {
        console.error(JSON.stringify({
          event: "pr-review-submit-not-persisted",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          claimed_review_id: submitted.id,
          submit_path: "inline-anchored",
        }))
        telemetry.fellBackReason = "submit_not_persisted"
        telemetry.fellBackToPhase3 = false
        // ARC-279: GitHub silently dropped the formal review. Post
        // the synth body as a regular PR comment so the review
        // signal isn't lost. Dispatcher sees `posted` + surface=
        // "comment" → maps the Check Run to `failure` with a "see
        // PR comment" title so the customer knows the normal
        // review pipeline didn't run.
        //
        // CodeRabbit catch on PR #91: on the inline-anchored path,
        // `submission.body` is ONLY the formal review body — the
        // actual findings live separately in `submission.comments`
        // because they're meant to anchor as inline review comments.
        // Posting `submission.body` as a top-level comment would
        // drop every finding. Re-render via `buildFallbackSubmission`
        // (the anchorless body-only renderer) so findings move into
        // the body and survive the channel switch.
        const fallbackCommentEvent = previewFallbackSubmissionEvent({
          verdict: submissionVerdict,
          unanchored: renderableUnanchoredForSubmission,
          ...(reviewEventOverride !== undefined ? { eventOverride: reviewEventOverride } : {}),
        })
        const fallbackCommentAffordance = await prepareFallbackAffordance(fallbackCommentEvent)
        const fallbackCommentSubmission = buildFallbackSubmission(withSubmissionAffordance({
          trustLedger: trustLedgerMode === "on",
          showEvidence,
          notReviewedFiles: filesDroppedFromReview,
          verdict: submissionVerdict,
          unanchored: renderableUnanchoredForSubmission,
          prAuthor: meta.user?.login ?? null,
          headSha,
          ...(reviewEventOverride !== undefined ? { eventOverride: reviewEventOverride } : {}),
          ...(stack.isStacked ? { stack } : {}),
          // ARC-281: keep coverage + delta consistent between the
          // primary submit and the comment-fallback body — otherwise
          // a customer who only sees the comment-fallback loses the
          // coverage signal that ARC-277 surfaces on the main path.
          coverage,
          delta: deltaCounts,
        }, fallbackCommentAffordance))
        const fallback = await postReviewCommentFallback({
          env, client, owner, repo, prNumber, headSha,
          body: fallbackCommentSubmission.body ?? "<!-- sigilix:pr-review -->\n(no body)",
          submitPath: "inline-anchored",
        })
        if (fallback.ok) {
          const findingsCount =
            submissionVerdict.findings.length + renderableUnanchoredForSubmission.length
          // SIG-89 note: comment-fallback paths intentionally do NOT
          // write a noop-merge diff hash. The surface is degraded
          // already (we couldn't post a formal review), and the next
          // push should re-attempt the formal review rather than skip
          // dispatch. Same rationale at all four `surface: "comment"`
          // return sites below.
          await fallbackCommentAffordance.persistReviewCounter()
          return finalize(telemetry, env, "posted", cache, {
            event: fallbackCommentSubmission.event,
            findingsCount,
            surface: "comment",
            // No runner pill on `surface: "comment"`: the dispatcher maps these
            // to a `failure` conclusion whose summary is error prose, and the
            // pill is a success-summary-only signal (Kimi spec). Threading it
            // here would be dead data the renderer never shows.
            ...deterministicCheckAnnotationMeta(),
            ...checkAnnotationMeta(allFindingAnnotations),
          })
        }
        // Comment fallback ALSO failed — `errored` is the truth.
        return finalize(telemetry, env, "errored", cache, deterministicErroredReviewMeta())
      }
      await primaryAffordance.persistReviewCounter()
      telemetry.submitted = true
      const suggestionEmissionEvents = buildSuggestionEmissionLogEvents({
        owner,
        repo,
        prNumber,
        headSha,
        commentsSubmitted: (submission.comments?.length ?? 0) > 0,
      }, submissionBuild.suggestionEmissions)
      for (const event of suggestionEmissionEvents) {
        console.log(JSON.stringify(event))
      }
      // ARC-258 follow-up: dismiss any stale Sigilix reviews from
      // earlier commits on this PR so the Reviews tab reflects only
      // the current head. Without this, customers see "Sigilix
      // approved a while ago" pointing at an outdated commit even
      // after Sigilix has re-reviewed the new head. Body-marker
      // match ensures we only ever dismiss our own reviews — never
      // touch another reviewer's.
      //
      // ARC-287: post-submit dismissPriorSigilixReviews call removed.
      // Dismissal now fires BEFORE submitReview (see the pre-submit
      // block above) so the GitHub timeline renders dismissal-above-
      // current-review chronologically. ARC-279's comment-fallback
      // covers the "dismiss succeeded + submit failed" failure mode.

      // ARC-184: write review-provenance manifest. Best-effort.
      // ARC-271: also persist the per-finding snapshot so the next
      // push's review can compute a new/still-open/likely-fixed
      // delta against this run.
      await writeReviewManifestForEnsemble({
        env, client, owner, repo, prNumber,
        headSha,
        baseSha: meta.base?.sha ?? "",
        modelId: "ensemble-synth",
        reviewId: submitted.id,
        findings: currentFindingsForManifest,
      })
      // ARC-194 (moved here in ARC-250): record `lastReviewedSha`
      // only after a confirmed GitHub submit. Previously this fired
      // before guard #2 — a stale-head skip still marked the SHA
      // reviewed, corrupting the next push's compare-diff.
      //
      // CodeRabbit PR #75 catch: a KV failure here MUST NOT bubble
      // out as `errored`. The customer-facing review has already
      // been submitted; an outer-catch `errored` would make
      // `dispatchJob` fall back to Phase 3 and post a SECOND review
      // on the same head. Best-effort: swallow + log instead.
      try {
        await writeLastReviewedSha(env, owner, repo, prNumber, headSha)
      } catch (err) {
        console.error(JSON.stringify({
          event: "pr-review-last-reviewed-sha-write-failed",
          owner, repo, prNumber, headSha,
          err: err instanceof Error ? err.message : String(err),
        }))
      }
      // SIG-89: stash the diff hash so the next synchronize push can
      // detect no-op merges (Update-branch button, rebase-no-op force
      // push, empty commit) and skip dispatch. Same best-effort
      // semantics as writeLastReviewedSha — the customer-facing
      // review already shipped; KV failure only means the next push
      // falls back to dispatch instead of skipping. The helper
      // swallows internally.
      await recordReviewedDiffHash(env, owner, repo, prNumber, fullPrDiff, headSha)
      // SIG-216: post-submit `pr-overview` refresh enqueue removed.
      // The overview is now rendered INLINE earlier in this handler
      // (right before `dismissPriorSigilixReviews`), informed by the
      // same submissionVerdict the review is built from — so there's
      // no stale-warmup-callout to clear and nothing for a separate
      // queue job to add. ARC-258's post-review refresh use case is
      // subsumed by the inline render.
      await maybePostAstAutoInline()
      // ARC-276: signal the customer-visible verdict back to the
      // dispatcher so the Sigilix Check Run title can render
      // "Approved — no issues found" vs "N findings posted".
      const inlineFindings =
        submissionVerdict.findings.length + renderableUnanchoredForSubmission.length
      return finalize(telemetry, env, "posted", cache, {
        event: submission.event,
        findingsCount: inlineFindings,
        ...(runnerEvidenceBadge ? { runnerEvidence: runnerEvidenceBadge } : {}),
        ...deterministicCheckAnnotationMeta(),
        // SIG-144 (PR #339 review fix): in annotations-only mode inline
        // comments are suppressed, so the annotations payload must carry
        // ALL findings — not just the body-only leftovers — or anchored
        // findings get dropped from every surface.
        ...checkAnnotationMeta(
          selectPrimarySubmitAnnotations(reviewOutputSurface, bodyOnlyAnnotations, allFindingAnnotations),
        ),
      })
    } catch (submitErr) {
      // Narrow the anchorless-retry fallback to GitHub HTTP 422 — that's
      // the specific status GitHub returns when an inline anchor is
      // invalid. CR PR #38 round-2 catch: the original catch-all retry
      // was unsafe because `POST /pulls/{n}/reviews` is non-idempotent.
      // A timeout / network error after GitHub accepted the first
      // submission would have produced a duplicate review on retry.
      // So: 422 → re-render anchorless + retry submitReview;
      //     non-422 → don't retry submit, but DO post the comment
      //     fallback (CR PR #97 catch — see below).
      const is422 =
        submitErr instanceof GitHubHttpError && submitErr.status === 422
      if (!is422) {
        // CR PR #97 catch (Major): pre-ARC-287, a non-422 submit
        // failure rethrew and the prior review stayed intact — the
        // customer saw a stale-but-existing signal. Post-ARC-287,
        // the prior is ALREADY DISMISSED (the pre-submit dismiss
        // fired before submit), so rethrowing here would leave the
        // customer with NO Sigilix signal at all.
        //
        // Restore the "customer always sees Sigilix" guarantee by
        // posting the comment fallback (ARC-279's helper, normally
        // used on verify-fail) on every non-422 submit error too.
        // The synth verdict still hits the PR — just as a regular
        // comment instead of a formal review.
        console.warn(JSON.stringify({
          event: "pr-review-submit-non-422-error",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          err: submitErr instanceof Error ? submitErr.message : String(submitErr),
        }))
        const fallbackBodyOnlyEvent = previewFallbackSubmissionEvent({
          verdict: submissionVerdict,
          unanchored: renderableUnanchoredForSubmission,
          ...(reviewEventOverride !== undefined ? { eventOverride: reviewEventOverride } : {}),
        })
        const fallbackBodyOnlyAffordance = await prepareFallbackAffordance(fallbackBodyOnlyEvent)
        const fallbackBodyOnly = buildFallbackSubmission(withSubmissionAffordance({
          trustLedger: trustLedgerMode === "on",
          showEvidence,
          notReviewedFiles: filesDroppedFromReview,
          verdict: submissionVerdict,
          unanchored: renderableUnanchoredForSubmission,
          prAuthor: meta.user?.login ?? null,
          headSha,
          ...(reviewEventOverride !== undefined ? { eventOverride: reviewEventOverride } : {}),
          ...(stack.isStacked ? { stack } : {}),
          coverage,
          delta: deltaCounts,
        }, fallbackBodyOnlyAffordance))
        const commentFallback = await postReviewCommentFallback({
          env, client, owner, repo, prNumber, headSha,
          body: fallbackBodyOnly.body ?? "<!-- sigilix:pr-review -->\n(no body)",
          submitPath: "inline-anchored-error",
        })
        if (commentFallback.ok) {
          const findingsCount =
            submissionVerdict.findings.length + renderableUnanchoredForSubmission.length
          await fallbackBodyOnlyAffordance.persistReviewCounter()
          return finalize(telemetry, env, "posted", cache, {
            event: fallbackBodyOnly.event,
            findingsCount,
            surface: "comment",
            // No runner pill on `surface: "comment"` — see the note at the
            // fallbackCommentSubmission site above (failure conclusion, pill is
            // success-summary-only).
            ...deterministicCheckAnnotationMeta(),
            ...checkAnnotationMeta(allFindingAnnotations),
          })
        }
        // Both inline submit AND comment fallback failed — rethrow
        // so the outer catch records `internal_error` and the
        // Check Run reflects the failure.
        throw submitErr
      }
      const fallbackReason = `HTTP 422 ${submitErr.message}`
      // Set telemetry BEFORE the fallback submit. If the fallback
      // ALSO fails, the outer catch overwrites `internalError` but
      // these two fields stay set — preserves the "we attempted a
      // fallback" signal that Phase 4b shadow-mode monitoring needs.
      // CR PR #38 round-2 catch.
      telemetry.submitFallback = true
      telemetry.submitFallbackReason = fallbackReason
      console.warn("[ensemble] inline submit rejected (HTTP 422); falling back to anchorless review", {
        owner,
        repo,
        prNumber,
        reason: fallbackReason,
      })
      const fallbackEvent = previewFallbackSubmissionEvent({
        verdict: submissionVerdict,
        unanchored: renderableUnanchoredForSubmission,
        ...(reviewEventOverride !== undefined ? { eventOverride: reviewEventOverride } : {}),
      })
      const fallbackAffordance = await prepareFallbackAffordance(fallbackEvent)
      const fallback = buildFallbackSubmission(withSubmissionAffordance({
        trustLedger: trustLedgerMode === "on",
        showEvidence,
        notReviewedFiles: filesDroppedFromReview,
        // ARC-189: fallback path also receives the soften-applied
        // verdict. Markers are NOT emitted on the fallback (it's a
        // body-only review with no inline anchors) — see Task 2.5.
        verdict: submissionVerdict,
        unanchored: renderableUnanchoredForSubmission,
        prAuthor: meta.user?.login ?? null,
        headSha,
        ...(reviewEventOverride !== undefined ? { eventOverride: reviewEventOverride } : {}),
        // ARC-182 (code-review C1): thread stack to the anchorless
        // fallback as well — the stack parenthetical belongs in the
        // body regardless of whether inline anchoring succeeded.
        ...(stack.isStacked ? { stack } : {}),
        // ARC-281: coverage + delta survive the anchorless-fallback
        // too, so a 422-driven body-only review reads the same way
        // as the inline-anchored primary.
        coverage,
        delta: deltaCounts,
      }, fallbackAffordance))
      // CR PR #97 round-4 catch: the anchorless-fallback submit
      // can also throw (merge race after the guard, transient
      // GitHub 5xx, connection drop). With ARC-287's pre-submit
      // dismiss already done, an un-caught throw here would leave
      // the customer with NO Sigilix signal (prior dismissed, no
      // review posted, no comment). Symmetric to the inline-anchored
      // catch above — post the synth body as a regular PR comment
      // tagged `anchorless-fallback-error` so on-call can correlate.
      let submittedFallback: Awaited<ReturnType<typeof client.submitReview>>
      try {
        submittedFallback = await client.submitReview(owner, repo, prNumber, fallback)
      } catch (fallbackSubmitErr) {
        console.warn(JSON.stringify({
          event: "pr-review-fallback-submit-error",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          err: fallbackSubmitErr instanceof Error
            ? fallbackSubmitErr.message
            : String(fallbackSubmitErr),
        }))
        const commentFallback = await postReviewCommentFallback({
          env, client, owner, repo, prNumber, headSha,
          body: fallback.body ?? "<!-- sigilix:pr-review -->\n(no body)",
          submitPath: "anchorless-fallback-error",
        })
        if (commentFallback.ok) {
          const findingsCount =
            submissionVerdict.findings.length + renderableUnanchoredForSubmission.length
          await fallbackAffordance.persistReviewCounter()
          return finalize(telemetry, env, "posted", cache, {
            event: fallback.event,
            findingsCount,
            surface: "comment",
            // No runner pill on `surface: "comment"` — failure conclusion; the
            // pill is success-summary-only (see fallbackCommentSubmission note).
            ...deterministicCheckAnnotationMeta(),
            ...checkAnnotationMeta(allFindingAnnotations),
          })
        }
        // Both anchorless submit AND comment fallback failed — rethrow
        // so the outer catch records `internal_error` and the
        // Check Run reflects the failure.
        throw fallbackSubmitErr
      }
      // ARC-258 follow-up (PR #84 anomaly catch, refined PR #86):
      // same post-submit verification as the primary path — catches
      // both the 404-on-id and the PENDING-state silent-success
      // cases for the anchorless fallback.
      const verifiedFallback = await verifyReviewPersisted(
        client, owner, repo, prNumber, submittedFallback.id,
        "anchorless-fallback", submittedFallback.state,
      )
      if (!verifiedFallback) {
        console.error(JSON.stringify({
          event: "pr-review-submit-not-persisted",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          claimed_review_id: submittedFallback.id,
          submit_path: "anchorless-fallback",
        }))
        telemetry.fellBackReason = "submit_not_persisted"
        telemetry.fellBackToPhase3 = false
        // ARC-279: same comment-fallback as the inline-anchored
        // verify-fail path. By this point we've tried inline,
        // 422'd, anchorless, and silent-rejected. The synth body
        // is real signal the reviewer would benefit from — post
        // it as a regular comment instead of dropping it.
        const commentFallback = await postReviewCommentFallback({
          env, client, owner, repo, prNumber, headSha,
          // Same defensive default as the inline-anchored path:
          // `fallback.body` is typed optional but the anchorless
          // path always emits it (buildFallbackBody + the marker).
          body: fallback.body ?? "<!-- sigilix:pr-review -->\n(no body)",
          submitPath: "anchorless-fallback",
        })
        if (commentFallback.ok) {
          const findingsCount =
            submissionVerdict.findings.length + renderableUnanchoredForSubmission.length
          await fallbackAffordance.persistReviewCounter()
          return finalize(telemetry, env, "posted", cache, {
            event: fallback.event,
            findingsCount,
            surface: "comment",
            // No runner pill on `surface: "comment"` — failure conclusion; the
            // pill is success-summary-only (see fallbackCommentSubmission note).
            ...deterministicCheckAnnotationMeta(),
            ...checkAnnotationMeta(allFindingAnnotations),
          })
        }
        return finalize(telemetry, env, "errored", cache, deterministicErroredReviewMeta())
      }
      await fallbackAffordance.persistReviewCounter()
      telemetry.submitted = true
      // ARC-287: post-submit dismissPriorSigilixReviews call removed
      // (was the anchorless-fallback's parallel of the inline-anchored
      // helper). Both submit paths now rely on the single pre-submit
      // dismissal at the top of this submit block.

      // ARC-184: write manifest for the fallback path too. Same target
      // shape (kind: "review") because the fallback is still a GitHub
      // review (just anchorless body). ARC-271: same per-finding
      // snapshot as the primary path.
      await writeReviewManifestForEnsemble({
        env, client, owner, repo, prNumber,
        headSha,
        baseSha: meta.base?.sha ?? "",
        modelId: "ensemble-synth",
        reviewId: submittedFallback.id,
        findings: currentFindingsForManifest,
      })
      // ARC-194 (moved here in ARC-250): mirror the primary submit
      // path — only mark `lastReviewedSha` after a confirmed GitHub
      // submit. CR PR #75 catch: same try/catch as the primary path
      // so a KV write failure doesn't bubble out as `errored` and
      // trigger a duplicate Phase 3 fallback review.
      try {
        await writeLastReviewedSha(env, owner, repo, prNumber, headSha)
      } catch (err) {
        console.error(JSON.stringify({
          event: "pr-review-last-reviewed-sha-write-failed",
          owner, repo, prNumber, headSha,
          err: err instanceof Error ? err.message : String(err),
        }))
      }
      // SIG-89: mirror the primary path — stash the diff hash for
      // noop-merge skip on the next synchronize. Same best-effort
      // semantics as the lastReviewedSha write above.
      await recordReviewedDiffHash(env, owner, repo, prNumber, fullPrDiff, headSha)
      // SIG-216: post-submit `pr-overview` refresh enqueue removed
      // here too — same rationale as the primary inline-anchored
      // submit path above. The overview already ran inline at the
      // top of the submit block, before the 422 fallback was even
      // considered, so the comment is already on the timeline.
      await maybePostAstAutoInline()
      // ARC-276: same reviewMeta plumbing as the inline-anchored
      // path — the anchorless fallback is still a posted review.
      const fallbackFindings =
        submissionVerdict.findings.length + renderableUnanchoredForSubmission.length
      return finalize(telemetry, env, "posted", cache, {
        event: fallback.event,
        findingsCount: fallbackFindings,
        ...(runnerEvidenceBadge ? { runnerEvidence: runnerEvidenceBadge } : {}),
        ...deterministicCheckAnnotationMeta(),
        ...checkAnnotationMeta(allFindingAnnotations),
      })
    } finally {
      // ARC-284: fire the submit phase event on every exit path —
      // inline-anchored success, inline-anchored verify-fail (comment
      // fallback), 422 → anchorless fallback success, 422 → fallback
      // verify-fail. Catches the GitHub roundtrip + verify time
      // independently of the synth latency above.
      emitPhaseCompleted(perfCtx, "submit", submitStartMs)
    }
  } catch (e) {
    telemetry.fellBackToPhase3 = false  // ARC-280: Phase 3 deleted; this flag is now always false on every path
    telemetry.fellBackReason = "internal_error"
    telemetry.internalError = e instanceof Error ? e.message : String(e)
    // ARC-280 follow-up: the internal_error path doesn't post a
    // skip-notice because the catch may have fired BEFORE the
    // client/auth was built (so the `bailWithSkipNotice` closure
    // isn't reachable from here). The dispatcher's `errored` →
    // `failure` Check Run mapping renders a generic "Review
    // failed" title, which is accurate for this case — the on-
    // call team needs to look at telemetry to know what failed.
    return finalize(telemetry, env, "errored", cache, deterministicErroredReviewMeta())
  } finally {
    clearTimeout(orchTimer)
    // SIG-318 (PR 12b): the ARC-283 shadow-comparison emit (the entire finally
    // body after `clearTimeout`) moved verbatim to ensemble/app/shadow-settle.
    // It runs on EVERY return path (success, skip-notice bail, outer-catch);
    // when shadow is disabled the holder's maps are empty + `synthPromise` is
    // null and it is a zero-cost no-op. Awaited exactly as the original finally
    // body was, so the shadow tail still gates the function's settle.
    await settleShadowBakeoff({
      shadowState,
      telemetry,
      perfCtx,
      orchCtrl,
      shadowFinalizeGraceMs: SHADOW_FINALIZE_GRACE_MS,
      owner,
      repo,
      prNumber,
      headSha,
    })
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

/**
 * ARC-174: append the per-role rule from `sigilix.json` to a
 * specialist's initial message. No-op when the config defines no rule
 * for that role. The role-specific rule is rendered as a labeled
 * block so the specialist can clearly attribute it to repo config
 * rather than mistake it for ambient context.
 */
function appendRoleRule(
  baseMessage: string,
  role: SpecialistRole,
  config: SigilixConfig,
): string {
  const rule = config.rules?.[role]
  if (!rule) return baseMessage
  return `${baseMessage}\n\n[REPO RULES — ${role.toUpperCase()} (from sigilix.json)]\n${rule}`
}

// SIG-362 (PR 10): `maxAttempts` (private) moved to ensemble/domain/model-policy;
// `MAX_CALLS_PER_ENSEMBLE_RUN` (derived from the configs) moved to the
// model-provider adapter. It was exported here → re-export to keep the surface.
export { MAX_CALLS_PER_ENSEMBLE_RUN } from "./ensemble/adapters/model-provider"

// ARC-280: `dailyBudgetAvailable` was the budget-gate `routeReview`
// called before admitting a PR; with `routeReview` deleted and the
// dispatcher calling `handlePrReviewEnsemble` directly, the
// admission check no longer fires. `incrementDailyBudget` still
// runs in `finalize()` so the per-day cumulative count is recorded
// for telemetry / future-policy use. A hard cap that bails the
// ensemble early on budget exhaustion is a separate follow-up.
//
// SIG-363 (PR 11): `incrementDailyBudget` moved to ensemble/adapters/persistence
// (it was private here → imported-back, not re-exported).

function countLines(diff: string): number {
  let n = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) n++
    else if (line.startsWith("-") && !line.startsWith("---")) n++
  }
  return n
}

// SIG-361 (PR 9): `severityTier` moved to the verdict domain (imported above;
// import-back only, NOT re-exported — it was private here).

/**
 * SIG-216: count findings by P0/P1/P2/P3 severity tier for the
 * `reviewContext.severityBreakdown` passed into `handlePrOverview`.
 * Empty buckets are omitted so the prompt stays compact. Pure.
 */
function countBySeverity(
  findings: readonly { score: number }[],
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of findings) {
    const tier = severityTier(f.score)
    out[tier] = (out[tier] ?? 0) + 1
  }
  return out
}

/**
 * SIG-216: count findings by `FindingCategory` for the
 * `reviewContext.categoryBreakdown` passed into `handlePrOverview`.
 * Empty buckets are omitted so the prompt stays compact. Pure.
 */
function countByCategory(
  findings: readonly { category: string }[],
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of findings) {
    out[f.category] = (out[f.category] ?? 0) + 1
  }
  return out
}

// SIG-363 (PR 11): the per-installation client factory (`buildClient`), the
// post-submit visibility check (`verifyReviewPersisted`), and its page-cap
// constant (`REVIEW_LIST_PAGE_CAP`) moved to ensemble/adapters/review-sink. All
// three were private here → imported-back, not re-exported (the public surface
// is unchanged).
import {
  buildClient,
  verifyReviewPersisted,
} from "./ensemble/adapters/review-sink"

// SIG-363 (PR 11): the KV write obligations — the review-provenance manifest
// (`writeReviewManifestForEnsemble`), the per-day budget counter
// (`incrementDailyBudget`), and the SLO/FP-rate telemetry record
// (`writeTelemetry`) — moved to ensemble/adapters/persistence. All were private
// here → imported-back, not re-exported.
import {
  writeReviewManifestForEnsemble,
  incrementDailyBudget,
  writeTelemetry,
} from "./ensemble/adapters/persistence"

// ─── specialist + synth runners (moved) ──────────────────────────────────
// SIG-362 (PR 10): the specialist runner, the retry-and-fallback executor, the
// synthesizer runner, and their pure wire-format parsers moved to
// ensemble/adapters/model-provider. Re-exported here so existing importers
// (tests + the shadow runner) are unchanged; the orchestrator below imports the
// runners + `SpecialistRunResult` directly from the adapter.
export {
  runSpecialist,
  runWithRetryAndFallback,
  runSynthesizer,
  isPermanentFailure,
  parseSynthAnswer,
} from "./ensemble/adapters/model-provider"
export type {
  SpecialistRunArgs,
  AttemptCallbackInfo,
  SynthesizerRunArgs,
} from "./ensemble/adapters/model-provider"
import {
  runSpecialist,
  runWithRetryAndFallback,
  runSynthesizer,
  type SpecialistRunResult,
} from "./ensemble/adapters/model-provider"

// ─── verdict post-processing ──────────────────────────────────────────

export interface ApprovalReadinessSourceVerdict {
  role: SpecialistRole
  verdict: (PrReviewVerdict & { findings: Array<PrReviewFinding & { id: string }> }) | null
}

export function collectApprovalReadinessSourceFindings(
  sourceVerdicts: ReadonlyArray<ApprovalReadinessSourceVerdict>,
  withdrawals: ReadonlyArray<WithdrawalRecord>,
): ApprovalReadinessSourceFinding[] {
  return sourceVerdicts.flatMap((v) => {
    const verdict = v.verdict
    if (!verdict) return []
    const { kept } = filterWithdrawnFindings(verdict.findings, withdrawals)
    return kept.map((finding) => ({
      role: v.role,
      id: finding.id,
      finding,
      verdictConfidence: verdict.confidence,
    }))
  })
}

export function buildSynthInputVerdicts<T extends ApprovalReadinessSourceVerdict>(
  sourceVerdicts: ReadonlyArray<T>,
  maxTokens: number = SPECIALIST_VERDICT_TOKEN_CAP,
): Array<T & { verdict: PrReviewVerdictWithIds }> {
  const out: Array<T & { verdict: PrReviewVerdictWithIds }> = []
  for (const source of sourceVerdicts) {
    if (!source.verdict) continue
    out.push({
      ...source,
      verdict: truncateVerdictToTokens(source.verdict, maxTokens),
    } as T & { verdict: PrReviewVerdictWithIds })
  }
  return out
}

function collectSpecialistVerdicts(
  roles: SpecialistRole[],
  results: Array<PromiseSettledResult<SpecialistRunResult>>,
  telemetry: EnsembleTelemetry,
): CollectedVerdict[] {
  const out: CollectedVerdict[] = []
  for (let i = 0; i < roles.length; i++) {
    const role = roles[i]!
    const settled = results[i]
    if (!settled || settled.status === "rejected") {
      const reason = settled?.status === "rejected"
        ? (settled.reason instanceof Error ? settled.reason.message : String(settled.reason))
        : "unknown_settlement"
      const collected: CollectedVerdict = { role, verdict: null, elapsedMs: 0, failureReason: reason }
      out.push(collected)
      // No attemptsUsed available — the wrapper threw before runSpecialist
      // returned, so we don't know how many attempts ran. Leave undefined
      // so finalize()'s defensive `?? 1` kicks in.
      telemetry.specialistVerdicts.push({
        role,
        model: SPECIALIST_MODELS[role],
        verdict: null,
        failureReason: reason,
        elapsedMs: 0,
        timedOut: reason.includes("timeout") || reason.includes("aborted"),
      })
      continue
    }
    const value = settled.value
    if (!value.verdict) {
      const collected: CollectedVerdict = {
        role,
        verdict: null,
        elapsedMs: value.elapsedMs,
        attemptsUsed: value.attemptsUsed,
        modelUsed: value.modelUsed,
      }
      if (value.failureReason) collected.failureReason = value.failureReason
      if (value.failureRawAnswer) collected.failureRawAnswer = value.failureRawAnswer
      out.push(collected)
      // Phase 4a.2: aborts (timer- or parent-signal-driven) now reach
      // this branch via withComposedTimeout's grace window — the
      // factory's structured wrapFailure(reason="aborted", ...) flows
      // through Promise.allSettled as a fulfilled value with verdict
      // null. Derive timedOut from the reason string so timer-driven
      // aborts stay visible in telemetry. The reason can be the
      // canonical "aborted" (signal.aborted check between attempts),
      // a DOMException message like "The operation was aborted." (when
      // fetch threw mid-attempt), or `fallback_failed: ... aborted`
      // (primary AND fallback both aborted) — a single /abort/i regex
      // captures all three.
      const reason = value.failureReason ?? ""
      const telEntry: EnsembleTelemetry["specialistVerdicts"][number] = {
        role,
        model: SPECIALIST_MODELS[role],
        modelUsed: value.modelUsed,
        attemptsUsed: value.attemptsUsed,
        verdict: null,
        elapsedMs: value.elapsedMs,
        timedOut: /abort/i.test(reason) || /timeout/i.test(reason),
      }
      if (value.failureReason) telEntry.failureReason = value.failureReason
      if (value.failureRawAnswer) telEntry.failureRawAnswer = value.failureRawAnswer
      telemetry.specialistVerdicts.push(telEntry)
      continue
    }
    const withIds = assignStableFindingIds(role, value.verdict)
    out.push({
      role,
      verdict: withIds,
      elapsedMs: value.elapsedMs,
      attemptsUsed: value.attemptsUsed,
      modelUsed: value.modelUsed,
    })
    telemetry.specialistVerdicts.push({
      role,
      model: SPECIALIST_MODELS[role],
      modelUsed: value.modelUsed,
      attemptsUsed: value.attemptsUsed,
      verdict: withIds,
      elapsedMs: value.elapsedMs,
      timedOut: false,
    })
  }
  return out
}

/**
 * ARC-278: classified outcome of one synth attempt. `ok` means we
 * have a usable verdict + provenance; the three failure shapes line
 * up with the three skip gates the pre-ARC-278 code bailed on
 * (timeout / parse / invalid-provenance).
 */
export type SynthAttemptOutcome = "ok" | "timeout" | "parse" | "provenance"

/**
 * ARC-278: pure helper. Classify the result of one
 * `runSynthesizer(...)` call (or the `null` we substitute for
 * synth-local timeout) into one of four outcomes. Encapsulates the
 * subtle Phase 4a.2 abort-rather-than-throw shape — without this,
 * three call sites duplicated the `/abort|timeout/i.test(failureReason)`
 * regex match.
 */
export function classifySynthOutcome(
  output: Awaited<ReturnType<typeof runSynthesizer>> | null | undefined,
  localTimeout: boolean,
): SynthAttemptOutcome {
  if (localTimeout) return "timeout"
  if (!output) return "timeout" // defensive — caller's null/undefined → treat as timeout
  const reason = output.failureReason ?? ""
  if (/abort/i.test(reason) || /timeout/i.test(reason)) return "timeout"
  if (output.verdict && output.provenance) return "ok"
  return output.failureReason === "synth_invalid_provenance" ? "provenance" : "parse"
}

/**
 * ARC-278: prepend a per-outcome retry hint to the original synth
 * user message. Pure — exposed for unit tests that pin the prompt
 * text (which feeds the model's recovery behavior on retry).
 *
 * For `timeout`: a terse "be prompter and more concise" hint, since
 * the model already had the full schema + verdict block on attempt
 * 1 and timeout suggests either it stalled mid-generation OR the
 * retry-side environment was overloaded. Hint is short to avoid
 * burning tokens on retry overhead.
 *
 * For `parse` / `provenance`: a constraint reminder pointed at the
 * specific failure mode. The retry runs at the smaller
 * SYNTHESIZER_RETRY_TIMEOUT_MS budget, so the model only has time
 * for one tight re-emission — we tell it exactly what to fix.
 */
export function buildSynthRetryMessage(
  originalMessage: string,
  outcome: SynthAttemptOutcome,
): string {
  if (outcome === "ok") return originalMessage
  const hint =
    outcome === "parse"
      ? "RETRY: Your previous response could not be parsed as JSON. Re-emit ONLY a single JSON object matching the schema. No prose. No markdown fence. No leading or trailing text."
      : outcome === "provenance"
      ? "RETRY: Your previous response's `provenance` field was malformed. Re-emit with a valid `provenance` object: `{ findings: [...], dropped: [...], softened?: [...] }`. Each `provenance.findings[i].sourceFindingIds[]` and each `provenance.softened[i].sourceFindingId` must reference real source specialist finding IDs from the [SPECIALIST VERDICTS] block."
      : "RETRY: Your previous response did not arrive within the time budget. Re-emit promptly and concisely; the schema and inputs above are unchanged."
  return `${originalMessage}\n\n${hint}`
}

export function checkQuorum(
  succeeded: CollectedVerdict[],
  mode: "shadow" | "post",
  dispatchedSpecialists?: SpecialistRole[],
): boolean {
  // Arc PR #35 catch: when the router dispatches fewer than 4
  // specialists (e.g., CSS-only → ["performance"]), the original
  // `succeeded.length < 2` rule always failed because there were
  // never 2 to begin with. Make quorum proportional to what the
  // router actually requested.
  //
  // Rule:
  //   - Need min(2, dispatched.length) successes (so single-dispatch
  //     PRs need just that 1 to succeed; multi-dispatch needs ≥2).
  //   - In post mode, ALSO require ≥1 of {logic, security} to have
  //     succeeded — but only if the router actually dispatched them.
  //     If the router intentionally excluded both (rare; would only
  //     happen for CSS-only → ["performance"] type cases), the post-
  //     mode check is effectively just the count requirement.
  const dispatched = dispatchedSpecialists ?? [...ALL_SPECIALISTS]
  const dispatchedSet = new Set(dispatched)
  const minSuccesses = Math.min(2, dispatched.length)
  if (succeeded.length < minSuccesses) return false
  if (mode === "shadow") return true
  // post mode: enforce logic/security only if router dispatched them
  const dispatchedLogicOrSec = dispatchedSet.has("logic") || dispatchedSet.has("security")
  if (!dispatchedLogicOrSec) return true
  return succeeded.some((v) => v.role === "logic" || v.role === "security")
}

/**
 * Truncate a verdict's JSON-stringified form to fit the token cap.
 * Drops lowest-score findings first to preserve severity. Approximate
 * — uses 4 chars/token estimate.
 */
export function truncateVerdictToTokens(
  verdict: PrReviewVerdictWithIds,
  maxTokens: number,
): PrReviewVerdictWithIds {
  const charBudget = maxTokens * 4
  const working = { ...verdict, findings: [...verdict.findings] }
  // Sort findings by score DESC so we drop the lowest first.
  working.findings.sort((a, b) => b.score - a.score)
  while (JSON.stringify(working).length > charBudget && working.findings.length > 0) {
    working.findings.pop()
  }
  return working
}

/**
 * SIG-216 fix-up: run the inline pr-overview with a single retry on
 * transient errors, bounded by `budgetMs` per attempt.
 *
 * Why two attempts and not three: the pre-SIG-216 queue consumer gave
 * `MAX_RETRIES = 3` on Ollama transient failures because the consumer
 * could afford the wall-time. The inline path runs inside the same
 * review handler that's already against the orchestrator's wall-clock
 * (`ORCHESTRATOR_TIMEOUT_MS`), so a single retry is the most we
 * can fit without risking the orchestrator's own abort firing.
 *
 * Transient classification matches the queue consumer's heuristic +
 * the budget-exceeded signal raised by the per-attempt `Promise.race`.
 * Non-transient errors propagate immediately to the caller.
 */
async function runInlineOverviewWithRetry(
  args: PrOverviewArgs,
  totalBudgetMs: number,
): Promise<void> {
  // SIG-216 fix-up: ONE shared deadline across both attempts (was: a
  // fresh per-attempt budget that could allow overlapping attempts on
  // retry and let the wall-clock blow past the budget). Each attempt
  // also gets its own AbortController so the in-flight Ollama fetch
  // from the first attempt is actually cancelled when retry fires —
  // otherwise the abandoned Promise burns CPU + network until the
  // 600s default `generate` timeout.
  const deadline = Date.now() + totalBudgetMs
  const computeRemaining = (): number => Math.max(0, deadline - Date.now())

  const attempt = async (): Promise<void> => {
    const remainingMs = computeRemaining()
    if (remainingMs <= 0) {
      throw new Error("inline-overview-budget-exceeded")
    }
    const ctl = new AbortController()
    const timeoutId = setTimeout(() => {
      ctl.abort(new Error("inline-overview-budget-exceeded"))
    }, remainingMs)
    try {
      await handlePrOverview({ ...args, abortSignal: ctl.signal })
    } finally {
      clearTimeout(timeoutId)
    }
  }

  try {
    await attempt()
    return
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const transient = /budget-exceeded|timeout|abort|503|502|504|fetch failed|ECONNRESET|ETIMEDOUT/i.test(msg)
    if (!transient) throw err
    if (computeRemaining() <= 0) throw err
    console.log(JSON.stringify({
      event: "pr-review-inline-overview-retry",
      owner: args.owner, repo: args.repo, prNumber: args.prNumber,
      head_sha: args.headSha.slice(0, 7),
      err: msg.slice(0, 200),
    }))
    await attempt()
  }
}

// SIG-360: thin public wrapper preserving the original `validateForSubmission`
// signature (astCache OPTIONAL). The believability core moved to
// ./ensemble/domain/validation, where `astCache` is REQUIRED (no features-barrel
// VALUE default in a domain default — the one permitted body delta). Here we
// supply the default so the orchestrator's `satisfies Parameters<typeof
// validateForSubmission>[0]` call site is unchanged. Sync, like the domain fn.
export function validateForSubmission(
  args: Omit<ValidateForSubmissionArgs, "astCache"> & { astCache?: AstCache },
): ValidatedOutput {
  return validateForSubmissionDomain({ ...args, astCache: args.astCache ?? createAstCache() })
}

// ─── telemetry ─────────────────────────────────────────────────────────

interface EnsembleTelemetry {
  schemaVersion: 3
  owner: string
  repo: string
  prNumber: number
  headSha: string
  mode: "shadow" | "post"
  fellBackToPhase3: boolean
  fellBackReason?: string
  internalError?: string
  routerDecision: RouterDecision | null
  /**
   * SIG-227a: when `OPENCLAW_DYNAMIC_DISPATCHER_MODE === "enforce_rules"`,
   * `routerDecision` above is overwritten with the dispatcher's picks
   * because those drive fan-out. The legacy `decideSpecialists` result
   * is preserved here so `/metrics/validation` can compute
   * "would-have-been-fanned-out vs actually-fanned-out" deltas across
   * the enforce_rules window. Absent when mode is `off`/`shadow`/`enforce`
   * (only `enforce_rules` does the routerDecision swap).
   */
  legacyRouterDecision?: RouterDecision
  /**
   * SIG-226 / SIG-224 Phase 1: shadow-mode dispatcher decision blob.
   * Populated only when `OPENCLAW_DYNAMIC_DISPATCHER_MODE` is set to
   * `shadow` or `enforce`. Always absent in default-off mode so the
   * existing telemetry consumers don't see noise.
   *
   * Held on the telemetry object (rather than just `console.log`-ed)
   * so the existing KV-backed metrics endpoints (`/metrics/validation`,
   * `/metrics/graph`) can compute shadow-window stats — p50/p95/p99
   * dispatcher overhead, per-role agreement rates between rule layer
   * and LLM, false-negative rates on protected roles. Phase 2/3
   * graduation criteria depend on these aggregates.
   */
  dispatcherDecision?: import("./dynamic-dispatcher").DispatcherDecision
  /**
   * ARC-277: populated when 1 ≤ specialist-success-count < dispatched-count.
   * Records which roles came back and which didn't so post-rollout
   * telemetry analysis can compute degraded-vs-full-coverage rates
   * per specialist + per repo. Absent when full coverage (synth ran
   * with everything) AND when fully empty (synth never ran).
   */
  degradedCoverage?: {
    rolesReturned: SpecialistRole[]
    rolesMissing: SpecialistRole[]
  }
  /**
   * ARC-278: did we run the one-shot synth retry, and if so how did
   * it land? Populated on EVERY ensemble run that gets as far as
   * the synth call (so the field is present whether or not the
   * retry ran). Outcomes:
   *   - `n/a`     — first attempt succeeded, retry not triggered
   *   - `ok`      — retry recovered the failed first attempt
   *   - `timeout` — retry also locally timed out
   *   - `parse`   — retry also failed JSON parse
   *   - `provenance` — retry also produced invalid provenance
   *   - `exhausted-budget` — first attempt failed but no retry
   *     budget left (reserved for ARC-278.future; current code
   *     always runs the retry within the static budget).
   */
  synthRetry?: {
    used: boolean
    outcome: SynthAttemptOutcome | "n/a" | "exhausted-budget"
  }
  /**
   * SIG-228 Phase 3c: populated when the synth-bypass single-specialist
   * hot path fired (dispatcher returned 1 specialist + no major-severity
   * findings + `OPENCLAW_SYNTH_BYPASS_ENABLED === "on"`). When present,
   * `synthesizer.modelUsed` is the bypass sentinel and `synthesizer.elapsedMs`
   * reflects the bypass synth-construction time (near-zero), so post-
   * rollout analysis can compute the wall-time saved vs the legacy
   * synth path. Absent on the synth path (default) AND when the flag
   * is off.
   */
  synthBypass?: {
    reason: "single_specialist_no_major"
    specialistRole: SpecialistRole
    findingCount: number
  }
  specialistVerdicts: Array<{
    role: SpecialistRole
    /** Configured primary model. Kept for backward telemetry compat. */
    model: string
    /** The model that actually answered (or last attempted on failure).
     *  Differs from `model` when the cross-provider fallback fired. */
    modelUsed?: string
    /** Total model invocations across primary retries + fallback.
     *  Used by finalize() to charge the daily budget accurately
     *  (CR PR #37 catch — previously assumed 1 call per specialist). */
    attemptsUsed?: number
    verdict: PrReviewVerdictWithIds | null
    failureReason?: string
    failureRawAnswer?: string
    elapsedMs: number
    timedOut: boolean
  }>
  synthesizer: {
    model: string
    modelUsed?: string
    attemptsUsed?: number
    verdict: PrReviewVerdict | null
    provenance: SynthesizerProvenance | null
    failureReason?: string
    failureRawAnswer?: string
    elapsedMs: number
    timedOut: boolean
  } | null
  postValidation: {
    droppedForInvalidLine: number
    remappedInvalidLineToInline: number
    droppedForHallucination: number
    demotedScore1: number
    /** ARC-156: count of synth findings dropped by the vague-prefix
     * post-processing filter (headline or body starts with
     * Ensure/Verify/Validate/Consider/Review/Confirm). */
    droppedForVaguePrefix: number
    /** SIG-113: count of `category: "testing"` findings dropped
     * because the specialist failed to cite evidence (no
     * inspectedTestFiles AND no evidenceRefs:siblingMapping). */
    droppedForUncitedTestingEvidence: number
    /** SIG-108: count of security findings the evidence gate flagged
     * (would-drop in shadow mode, actual-drop in enforce mode). */
    droppedForFailedValidation: number
    /** SIG-111: count of sev>=4 testing findings the specificity gate
     * flagged (would-drop in shadow mode, actual-drop in enforce
     * mode). */
    droppedForFailedTestValidation: number
    /** SIG-109: count of sev>=4 logic findings the evidence gate flagged
     * (would-drop in shadow mode, actual-drop in enforce mode). */
    droppedForFailedLogicValidation: number
    /** SIG-308: count of sev>=4 logic findings the refutation backstop flagged
     * for missing a survival rationale (would-drop shadow / actual-drop enforce). */
    droppedForFailedLogicRefutation: number
    /** SIG-328: count of sev>=4 logic findings the logic-claim refutation gate
     * flagged for a provably-false control-flow / sync-race claim (would-drop
     * shadow / actual-drop enforce). */
    droppedForFailedLogicClaimRefutation: number
    /** SIG-325: count of sev>=4 self-originated findings the refutation-survival
     * gate flagged for a missing mechanism rationale (would-demote shadow /
     * actual-demote enforce). */
    droppedForFailedRefutationSurvival: number
    /** SIG-110: count of sev>=4 perf findings the evidence gate flagged
     * (would-drop in shadow mode, actual-drop in enforce mode). */
    droppedForFailedPerfValidation: number
    /** SIG-281 PR C: count of score 2-3 findings the inline-grounding gate
     * flagged as ungrounded (would-demote-to-body in shadow, actual-demote
     * in enforce mode). */
    droppedForFailedInlineGroundingValidation: number
    /** SIG-290 v1: count of absence-claim findings the absence-grounding
     * gate flagged as ungrounded — evidence provably outside the window
     * (would-demote-to-body in shadow, actual-demote in enforce; 0 when
     * the gate is off). */
    droppedForFailedAbsenceGroundingValidation: number
    /** Cross-cutting over-fire Option B: count of window-blindness gate hits
     * (would-demote-to-body in shadow, actual-demote in enforce; 0 when the
     * gate is off). */
    droppedForFailedWindowBlindnessValidation: number
    /** SIG-293 v1: count of secrets-exposure findings the security-
     * grounding gate flagged as ungrounded — cited line held no credential
     * token, uncorroborated by any scanner fact (would-demote-to-body in
     * shadow, actual-demote in enforce; 0 when the gate is off). */
    droppedForFailedSecurityGroundingValidation: number
  droppedForFailedSecurityUsageValidation: number
  }
  retrievalCacheStats: RetrievalCacheStats | null
  /**
   * SIG-149: per-review token spend, keyed by the model that produced
   * it (summed across every settled attempt — specialist primary +
   * retries + cross-provider fallback + synth + synth retry). Populated
   * live during the run via `perfCtx.recordTokens`; read by `finalize()`
   * to compute modeled cost for the `review-slo-summary` event. Empty
   * `{}` when no model attempt surfaced usage (e.g. stale-head bail
   * before fan-out) — never absent, so the cost path is branch-free.
   */
  tokenUsageByModel: TokenUsageByModel
  /**
   * SIG-149: time-to-first-overview — `startMs` → the moment the inline
   * PR overview/walkthrough is posted (first customer-visible content).
   * Set only when the overview actually posts; absent on runs that skip
   * it (budget) or bail before reaching it. `finalize()` forwards it to
   * the `review-slo-summary` SLO eval, where absent = "no data" (never a
   * breach). See the `timeToFirstOverviewMs` SloTarget caveat re: the
   * overview currently being on the critical path (SIG-216).
   */
  timeToFirstOverviewMs?: number
  /**
   * ARC-192: hunk-level diff packing telemetry. Records how the diff
   * was split for the model call. `batchCount > 1` means the PR was
   * too large to fit in one specialist call; v1 reviews only the
   * first batch and lists the rest in `filesNotReviewed`. Operators
   * use this to decide whether v2 (multi-call merge) is worth the
   * cost increase.
   */
  diffPacking?: {
    diffTokensEstimated: number
    totalFiles: number
    batchCount: number
    filesReviewed: string[]
    filesDroppedTooLarge: string[]
    filesNotReviewed: string[]
    /**
     * ARC-176: paths excluded by `sigilix.json` `pathFilters` BEFORE
     * packing. Helps operators tune the filter list — surfacing files
     * we filtered lets them spot accidental over-exclusion.
     */
    filesDroppedByFilter?: string[]
    /**
     * ARC-273: when the char-level cap `costControls.maxPatchLength`
     * truncated the post-packing diff, this records the final size
     * the model actually saw. Absent when no truncation fired.
     */
    diffTruncatedToChars?: number
  }
  /**
   * ARC-193: deterministic regex check telemetry. `hits` are the
   * matches injected into specialist prompts as facts; analyses can
   * confirm the rules are firing as expected. `compiledRegexFailures`
   * are rule IDs whose pattern didn't compile — surfaces config
   * mistakes without breaking review.
   */
  deterministicChecks?: {
    hits: DeterministicCheckHit[]
    compiledRegexFailures: string[]
  }
  /**
   * ARC-187: secret-scan telemetry. Stores hit count + fingerprints
   * only. Raw secrets are NEVER stored or logged — fingerprints are
   * `${ruleId}:${path}:${line}:${redactedPreview}` so post-hoc
   * analysis can dedupe across runs without exposing the value.
   */
  secretScan?: {
    hitCount: number
    fingerprints: string[]
  }
  /**
   * ARC-186: dependency-vulnerability scan telemetry. `skipped: true`
   * with a reason for the skip-paths (disabled, missing manifest,
   * etc.); `skipped: false` with the finding count + scanned counts
   * on the run path.
   */
  depVulnScan?:
    | { skipped: true; reason: DepVulnSkipReason; findingsCount: 0 }
    | { skipped: false; findingsCount: number; depsScanned: number; manifestsScanned: number }
  /**
   * ARC-181: AST rule-pack scan telemetry. Mirrors the dep-vuln
   * shape — `scanned: true` with metrics on the run path,
   * `scanned: false` with optional `skipReason` on skip paths.
   */
  astRules?:
    | { scanned: true; filesScanned: number; filesSkippedLarge: number; filesParseFailed: number; findingsCount: number; durationMs: number }
    | { scanned: false; skipReason?: "disabled-config" | "no-js-ts-files"; findingsCount: 0 }
  /**
   * ARC-188: SARIF evidence channel telemetry. `findingsCount`
   * reflects the post-200-cap emitted count (Kimi NIT #6); the
   * pre-cap total is `findingsCount + truncatedCount`.
   */
  sarifEvidence?:
    | { skipped: true; reason: SarifSkipReason; findingsCount: 0 }
    | { skipped: false; findingsCount: number; truncatedCount: number; durationMs: number }
  /**
   * ARC-189: cross-PR review-memory lookup telemetry. `skipped`
   * paths emit a reason from the union; the run path carries the
   * per-finding count + duration. `memoriesInjected` mirrors
   * `findingsCount` in v1 (no extra render-time cap beyond what
   * `selectTopMemories` already applied at lookup time).
   */
  reviewMemory?:
    | { skipped: true; reason: ReviewMemorySkipReason; findingsCount: 0 }
    | { skipped: false; findingsCount: number; memoriesInjected: number; durationMs: number }
  /**
   * ARC-194: incremental-review telemetry. `mode` is `incremental`
   * (savings path), `full` (we tried but bailed), or `first-review`
   * (no previous record). `previousSha` is the SHA we previously
   * reviewed (if any). `reason` explains why we didn't take the
   * incremental path (`same_sha`, `compare_fetch_failed`,
   * `compare_empty`, `compare_not_smaller`).
   */
  incrementalReview?: {
    mode: DiffMode
    previousSha?: string
    reason?: string
  }
  shadowVerdict?: PrReviewVerdict
  submitted?: boolean
  /**
   * True when the inline-anchored submission was rejected by GitHub
   * and the orchestrator successfully recovered by re-submitting an
   * anchorless review with all findings rolled into the body. Set
   * alongside `submitted: true` — the review was posted, just not in
   * the inline-comment shape.
   */
  submitFallback?: boolean
  /** Error message from the original (failed) inline submission. */
  submitFallbackReason?: string
  /**
   * SIG-286 PR2 — targeted-inject A/B arm. Set ONLY in `post` mode and ONLY on
   * reviews that WOULD inject (non-empty render): `treatment` got the cross-file
   * inject, `control` did not (so `injected` ≡ `arm === "treatment"` — stored as
   * just `arm`, no redundant flag). Rides into the ensemble-review-telemetry KV
   * alongside `synthesizer.verdict` (NOT the dead `shadowVerdict`), so a per-arm
   * finding-rate comparison — group by arm, count `synthesizer.verdict.findings`
   * — can read whether the inject catches more real findings. Absent in shadow /
   * non-inject reviews.
   */
  graphExpansionAb?: { arm: "treatment" | "control" }
  startMs: number
  totalMs: number
}

// ARC-250: `stale_head` is split out from `skipped` so the dispatcher
// can short-circuit the Phase 3 fallback. Falling through to Phase 3
// when the ensemble guard fired would just hit Phase 3's identical
// stale-head guard and skip again — invisible to the customer.
type EnsembleResultStatus =
  | "posted"
  | "shadow_recorded"
  | "skipped"
  | "stale_head"
  | "errored"

/**
 * ARC-276: signal the customer-visible verdict + findings count back
 * to the dispatcher so the Sigilix Check Run title can reflect the
 * actual review outcome (`Approved — no issues found` vs `N findings
 * posted`).
 *
 * ARC-279: `surface` distinguishes a real GitHub review from the
 * fallback PR comment that fires when the formal submit silently
 * rejects. The dispatcher uses `surface === "comment"` to map the
 * Check Run to `failure` with a "see PR comment" title instead of
 * the normal `success` outcome.
 *
 * ARC-280 follow-up: `surface === "skip-notice"` signals that the
 * ensemble couldn't even generate a verdict (router_no_specialists,
 * specialists_all_failed, synth retry exhausted) and posted a
 * minimal "Sigilix couldn't review" comment instead. The catch-all
 * `internal_error` path is intentionally NOT in this list — it
 * returns a generic `errored` result with no `surface`, because the
 * catch may fire before the client/auth is built (so the
 * `bailWithSkipNotice` closure isn't reachable). Set on `status ===
 * "errored"` so the dispatcher's existing errored → failure mapping
 * kicks in; the Check Run renderer then branches on `surface ===
 * "skip-notice"` to show a "couldn't review — see PR comment"
 * title. `event` + `findingsCount` are required by the type but
 * ignored on this branch (we don't have a verdict to count).
 */
export interface ReviewMeta {
  event: ReviewEvent
  findingsCount: number
  /** Default behavior when omitted is `"review"` (back-compat with
   *  Phase 3's `PrReviewMeta` shape). */
  surface?: "review" | "comment" | "skip-notice"
  /** Body-only findings rendered as GitHub Checks annotations. */
  checkAnnotations?: CheckRunAnnotation[]
  /** SIG-171: scanner-derived Lane A annotations rendered independently
   *  from model-authored review findings. */
  deterministicCheckAnnotations?: CheckRunAnnotation[]
  /** SIG-184: the runner-evidence trust state when a receipt was
   *  consulted (flag-gated; omitted = `runner-absent` = no badge).
   *  Flows verbatim into `ReviewCheckMeta.runnerEvidence` (index.ts
   *  spreads this object) so the check-run summary renders the pill. */
  runnerEvidence?: "verified" | "evidence-pending"
}

export interface EnsembleResult {
  status: EnsembleResultStatus
  telemetry: EnsembleTelemetry
  /** ARC-276/279/280: set on `posted` (real review or comment
   *  fallback) AND on `errored` when a skip-notice was posted. */
  reviewMeta?: ReviewMeta
}

async function finalize(
  telemetry: EnsembleTelemetry,
  env: Env,
  status: EnsembleResultStatus,
  cache: ReturnType<typeof createRetrievalCache> | null,
  reviewMeta?: ReviewMeta,
): Promise<EnsembleResult> {
  telemetry.totalMs = Date.now() - telemetry.startMs
  // Capture retrieval cache stats BEFORE the KV write so telemetry
  // reflects everything the cache observed during this run (CR catch).
  if (cache !== null) {
    telemetry.retrievalCacheStats = cache.stats()
  }
  // Best-effort daily-budget increment.
  //
  // CR PR #37 catch: previously this counted dispatched specialists as
  // 1 each + synth as 1. With retries + cross-provider fallback, a
  // single role can use up to 4 model invocations. Using attemptsUsed
  // (set by runWithRetryAndFallback) gives accurate spend telemetry
  // and keeps the daily budget honest.
  let callsUsed = 0
  for (const sv of telemetry.specialistVerdicts) {
    callsUsed += sv.attemptsUsed ?? 1  // ?? 1 — defensive for legacy records
  }
  if (telemetry.synthesizer) {
    callsUsed += telemetry.synthesizer.attemptsUsed ?? 1
  }
  await incrementDailyBudget(env, callsUsed).catch(() => {})
  // SIG-149: emit the per-review latency + cost SLO roll-up. Fires here
  // because finalize() is the single choke point every exit path funnels
  // through (success, stale-head, errored, skip-notice) and `totalMs` +
  // `tokenUsageByModel` are both final by now. Pure-observability: the
  // emitter only console.log's + does arithmetic, but we still guard it
  // so a telemetry bug can never convert a posted review into a throw
  // (same discipline as the writeTelemetry catch below). Tier omitted →
  // the `default` SLO target applies until SIG-41 lands plan tiers.
  try {
    emitReviewSlo(
      {
        owner: telemetry.owner,
        repo: telemetry.repo,
        prNumber: telemetry.prNumber,
        headSha: telemetry.headSha,
      },
      {
        status,
        totalMs: telemetry.totalMs,
        usage: telemetry.tokenUsageByModel,
        // Conditional spread under exactOptionalPropertyTypes — absent
        // when no overview posted, so the overview SLO dimension is
        // evaluated as "no data" rather than 0.
        ...(telemetry.timeToFirstOverviewMs !== undefined
          ? { timeToFirstOverviewMs: telemetry.timeToFirstOverviewMs }
          : {}),
      },
    )
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "review-slo-emit-failed",
        owner: telemetry.owner,
        repo: telemetry.repo,
        prNumber: telemetry.prNumber,
        err: e instanceof Error ? e.message : String(e),
      }),
    )
  }
  // Best-effort telemetry write — but no longer SILENT (SIG-306): a swallowed
  // failure here is exactly how the FP-rate ruler went blind for ~30 days after
  // the org rename. Log the failure (owner/repo/pr) so a regression is visible.
  await writeTelemetry(env, telemetry).catch((e) => {
    console.error(
      JSON.stringify({
        event: "telemetry-write-failed",
        owner: telemetry.owner,
        repo: telemetry.repo,
        prNumber: telemetry.prNumber,
        err: e instanceof Error ? e.message : String(e),
      }),
    )
  })
  return reviewMeta !== undefined ? { status, telemetry, reviewMeta } : { status, telemetry }
}
