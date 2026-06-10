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
// SIG-318 (PR 12d): the review-withdrawal store helpers (loadWithdrawals,
// filterWithdrawnFindings[Detailed], computeContentFingerprint, WithdrawalRecord)
// and the repeat-FP metrics client (recordRepeatFpMetrics, RepeatFpEvent) followed
// the render-prep phase into ensemble/app/render-prep — no longer imported here.
import { GitHubClient } from "../shared/adapters/github"
import type { CheckRunAnnotation } from "../shared/types/github"
import {
  type PrReviewVerdict,
} from "./triage-pr-review"
// SIG-361 (PR 9): the verdict domain. The moved names import directly from the
// leaf (the inward direction per the dependency rule); `severityTier` is
// import-back (was private here — NOT re-exported), while
// `LOW_CONFIDENCE_COMMENT_THRESHOLD` + `resolveReviewEventOverride` were exported
// at HEAD (tests import the latter from this path), so both are re-exported to
// preserve this module's public surface.
import {
  LOW_CONFIDENCE_COMMENT_THRESHOLD,
  resolveReviewEventOverride,
} from "./ensemble/domain/verdict"
export { LOW_CONFIDENCE_COMMENT_THRESHOLD, resolveReviewEventOverride }
// SIG-318 (PR 12d): `isSubstantiveAnchorLine` (the re-anchor gate's substantive-
// line predicate) and the approval-readiness helpers (`assessApprovalReadiness`,
// `buildApprovalReadinessSummary`, `ApprovalReadinessSourceFinding`) followed the
// render-prep / verification-prep phases into ensemble/app — no longer imported here.
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
  buildChangedLineTextByPath,
} from "./validate-logic-finding"
import { postReviewSkipNotice, type SkipNoticeReason } from "./review-comment-fallback"
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
  buildSpecialistInitialMessage,
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
  loadSigilixConfig,
  passesLabelGate,
  renderPathInstructionsForPrompt,
  resolvePathInstructionsForChangedPaths,
  resolveCostControlsConfig,
  resolveDocsReviewConfig,
  resolveAstRulesConfig,
  resolveCoverageConfig,
  resolvePerfBudgetsConfig,
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
// SIG-318 (PR 12f): the inline PR-overview seam (`handlePrOverview` +
// `PrOverviewArgs`/`PrOverviewReviewContext`) moved with the publish phase to
// ensemble/app/publish — the inline-overview render was its only caller here.
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
  selectDiff,
  type DiffMode,
} from "./incremental-review"
// SIG-318 (PR 12f): `writeLastReviewedSha` + `recordReviewedDiffHash` (the
// post-submit lastReviewedSha + noop-merge diff-hash writes) and
// `dismissPriorSigilixReviews` (the pre-submit stale-detection emit) moved with
// the publish phase to ensemble/app/publish — all three were submit-path-only.
// SIG-318 (PR 12d): the review-manifest reader (`readReviewManifest`) +
// `ReviewManifestFinding` followed the render-prep delta-badge snapshot into
// ensemble/app/render-prep — no longer imported here.
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
// SIG-318 (PR 12d): the verification-mode readers (`readVerificationMode`,
// `readReanchorEnabled`) + `applyReanchors` followed the verification/marker
// pre-compute into ensemble/app/verification-prep — no longer imported here.
import {
  buildReceiptIndex,
  extractReceiptScanResults,
  type ReceiptScanResult,
} from "./verification/verify-finding-receipt"
import { parseSarif } from "@/features/sarif-evidence"
import { normalizeSarifPath } from "@/features/sarif-evidence"
import {
  renderSarifFindingsForPrompt,
} from "@/features/sarif-evidence"
import { buildSarifCheckAnnotations } from "@/features/sarif-evidence"
import { resolveSarifEvidenceConfig } from "./sigilix-config"
import { renderDepVulnFindingsForPrompt } from "@/features/dep-vulns"
// SIG-318 (PR 12d): the review-memory render-path helpers — the marker builders
// (`buildSigilixMarker`/`categoryFromRoleHint`/`computeFid`/`computePathSha256`/
// `markerSeverityFromScore`), the claim extractor (`extractClaims`/
// `CLAIM_EXTRACTION_SCHEMA`/`ClaimExtractionFinding`), the shadow-match
// (`shadowMatchReviewMemoryClaims`/`ShadowMatchFinding`), the soften gate
// (`isSoftenActive`/`softenScoreWithFloor`), the calibration cluster
// (`readCalibrationParams`/`shouldKeepSoften`/`decideWarmSoftenSurvival`/
// `WarmSoftenCandidate`/`WarmSoftenDecision`), `resolveReviewMemoryConfig`, the
// precision-profile loop (`loadPrecisionProfile`/`recordOutcome`/
// `applyPrecisionProfile`), and the claim-marker/type aliases — all followed the
// render-prep / verification-prep phases into ensemble/app — no longer imported here.
import type {
  ReviewMemorySkipReason,
} from "./review-memory/types"
import { handleStaleHead } from "./stale-head"
import { checkIsPrMerged, submitMergedOnApprove } from "./merge-guard"
import {
  type EnsembleRunCtx,
  emitPhaseCompleted,
} from "./ensemble-perf-telemetry"
import {
  type TokenUsageByModel,
  makeTokenRecorder,
} from "./ensemble-slo-telemetry"
// ARC-283 Phase B1b — shadow-mode bake-off harness. SIG-318 (PR 12c): the
// fan-out + kick-off entry points (`parseShadowEnabledRoles`, `resolveShadowConfig`,
// `runShadowSpecialist`, `runShadowSynth`, `FindingForOverlap`) followed the
// specialists+synth seam into ensemble/app; the orchestrator only keeps
// `ShadowRunResult` for the `ShadowBakeoffState` holder it threads through.
import {
  type ShadowRunResult,
} from "./shadow-bakeoff-runner"
import type { Env } from "../shared/types/env"
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
// SIG-318 (PR 12c): the SYNTH-input + synth-outcome PURE helpers (synth-input
// builder + verdict truncation, the synth-attempt outcome classifier + retry
// message, and the synth-bypass eligibility predicates) moved to the synth
// domain. Value-imported for internal use + re-exported below so existing
// importers (tests + siblings) are unaffected. SIG-318 (PR 12d):
// `collectApprovalReadinessSourceFindings` (the render-prep app phase's pure
// source-finding flattener) followed it into the synth domain — re-exported
// below to keep this module's public surface. `ApprovalReadinessSourceVerdict`
// is re-exported too (that flattener + the render-prep phase read it).
// `SynthAttemptOutcome` is type-imported for the `EnsembleTelemetry`
// `synthRetry.outcome` union (import-back).
import {
  buildSynthInputVerdicts,
  collectApprovalReadinessSourceFindings,
  classifySynthOutcome,
  buildSynthRetryMessage,
  truncateVerdictToTokens,
  buildAstFindingsSynthBlock,
  isSynthBypassEnabled,
  isSynthBypassEligible,
  type ApprovalReadinessSourceVerdict,
  type SynthAttemptOutcome,
} from "./ensemble/domain/synth"
export {
  buildSynthInputVerdicts,
  collectApprovalReadinessSourceFindings,
  classifySynthOutcome,
  buildSynthRetryMessage,
  truncateVerdictToTokens,
  buildAstFindingsSynthBlock,
  isSynthBypassEnabled,
  isSynthBypassEligible,
}
export type { ApprovalReadinessSourceVerdict, SynthAttemptOutcome }
// SIG-318 (PR 12c): the SPECIALISTS+SYNTH seam (shadow + prod fan-out, the
// SIG-235 quorum collector, collectSpecialistVerdicts, the coverage gate, the
// synth-bypass / synthesizer path + the recall floors) moved to the app layer.
import { runSpecialistsAndSynthesize } from "./ensemble/app/specialists"
// SIG-318 (PR 12d): the RENDER-PREP phase (review-memory soften + warm veto, the
// renderable-set assembly + the fragile parallel-array bookkeeping, the cross-push
// delta-badge snapshot, the coverage roster, and the verification/marker pre-
// compute) moved to the app layer (render-prep delegates the verification/marker
// tail to ensemble/app/verification-prep so neither file exceeds 1k lines).
import { prepareRender } from "./ensemble/app/render-prep"
// SIG-318 (PR 12e): the VERIFY-AND-BUILD phase (the detached gate-shadow IIFE, the
// SIG-285 verification + refuted-demote + receipt-join, the Trust Ledger v0 baseline
// annotation, and the submission build through buildReviewSubmissionWithMetadata +
// applyOutputSurfaceToSubmission) moved to the app layer.
import { verifyAndBuildSubmission } from "./ensemble/app/verify-and-build"
// SIG-318 (PR 12f): the PUBLISH phase (inline overview + post-overview stale-head
// guard, pre-submit dismiss, the submit + 4-level fallback ladder, post-submit
// persistence) moved to the app layer. The SESSION module owns `finalize` (the
// finalize choke point) + the review-result contract (`EnsembleResult` /
// `ReviewMeta` / the status union); `EnsembleResult` is bound to the concrete
// `EnsembleTelemetry` below + `ReviewMeta` re-exported, preserving the surface.
import { publishReviewSubmission } from "./ensemble/app/publish"
import {
  finalize,
  type EnsembleResult as EnsembleResultBase,
  type ReviewMeta,
} from "./ensemble/app/session"
export type { ReviewMeta }

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

// SIG-318 (PR 12f): the private `INLINE_OVERVIEW_SUBMIT_RESERVE_MS` (the reserved
// tail subtracted from the inline-overview budget for the submit + stale-head
// re-check) moved with the publish phase to ensemble/app/publish, which is now the
// only place the inline-overview budget math runs. The two EXPORTED thresholds
// above stay here to preserve the module's public surface.

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
//   - `CLAIM_EXTRACTOR_CONFIG`/`CLAIM_EXTRACTOR_TIMEOUT_MS` were private here →
//     SIG-318 (PR 12d): followed the render-prep claim-classifier closure into
//     ensemble/app/render-prep — no longer imported here.
//     SIG-318 (PR 12c): `SYNTHESIZER_MODEL`/`SPECIALIST_MODELS`
//     followed the specialists+synth seam into ensemble/app — no longer imported
//     here (the model-provider adapter still owns them; the app reads them direct).
import type { ModelConfig } from "./ensemble/domain/model-policy"
export type { ModelConfig }
import {
  SPECIALIST_CONFIGS,
  SYNTHESIZER_CONFIG,
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

// SIG-318 (PR 12e): the submission-affordance cluster (`SubmissionAffordance`,
// `withSubmissionAffordance`, `SuggestionEmissionLogContext`/`...Event` +
// `buildSuggestionEmissionLogEvents`, `prepareSubmissionAffordance`) moved to
// ensemble/app/affordances — the verify-and-build phase and the (12f) publish
// phase both call them. The exported members are re-exported below (tests import
// `prepareSubmissionAffordance` + `buildSuggestionEmissionLogEvents`).
// SIG-318 (PR 12f): `withSubmissionAffordance`'s remaining import-back consumer
// (the orchestrator's submit/fallback ladder) moved to ensemble/app/publish, so
// it is no longer imported-back here.
export {
  prepareSubmissionAffordance,
  buildSuggestionEmissionLogEvents,
} from "./ensemble/app/affordances"
export type {
  SubmissionAffordance,
  SuggestionEmissionLogContext,
  SuggestionEmissionLogEvent,
} from "./ensemble/app/affordances"

// ARC-280: `routeReview` + `RouteDecision` + the shadow/post/off
// mode-routing layer were deleted. The dispatcher now performs an
// inline sensitive-repo skip check and otherwise calls
// `handlePrReviewEnsemble` directly. Daily-budget exhaustion is
// handled inside the ensemble itself (an early `skipped` return
// with `fellBackReason: "daily_budget_exhausted"` once it lands).

// SIG-361 (PR 9): `resolveReviewEventOverride` moved to the verdict domain
// (imported + re-exported above).

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

    // ─── SIG-318 (PR 12c): the SPECIALISTS+SYNTH seam ─────────
    // The shadow + prod specialist fan-out, the SIG-235 quorum collector,
    // collectSpecialistVerdicts, the dismissal/cleared telemetry + prod
    // snapshots + fanout summary, the ARC-277 coverage gate, the synth-bypass /
    // synthesizer path (+ retry ladder + telemetry + summary), and the recall
    // floors all moved verbatim to ensemble/app/specialists (which delegates the
    // synth phase to ensemble/app/synthesize + the floors to ensemble/app/recall-
    // floors). The phase mutates `telemetry` + `shadowState` by reference; its
    // skip-notice bails return the `exit` arm, forwarded here.
    const specialistsPhase = await runSpecialistsAndSynthesize({
      env,
      owner,
      repo,
      prNumber,
      headSha,
      ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
      ensembleConfig,
      telemetry,
      perfCtx,
      orchCtrl,
      shadowState,
      bailWithSkipNotice,
      sigilixConfig,
      router,
      messageForRole,
      securityManifest,
      diff,
      matchedPathInstructions,
      stackBlock,
      graphCtxForPrompt,
      dynamicEvidenceBlockForPrompt,
      astResult,
      astRulesConfig,
      sarifFindings,
      sarifResult,
      filePaths,
    })
    if (specialistsPhase.kind === "exit") return specialistsPhase.result
    const {
      succeeded,
      degradedCoverage,
      synthInputVerdicts,
      synthOutput,
      shadowMemoriesForPhase3,
      effectiveSynthVerdict,
      effectiveSynthProvenance,
    } = specialistsPhase

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
    // SIG-318 (PR 12d): the render-prep phase — review-memory soften + the
    // SIG-280 warm veto + the renderable-set assembly (fingerprints, consensus
    // annotation, withdrawal filtering, repeat-FP metrics, precision profile, the
    // `keepIndex` parallel-array bookkeeping, approval-readiness, the review-event
    // resolution, `submissionVerdict`), the cross-push delta-badge snapshot, the
    // coverage roster, and the verification/marker pre-compute (delegated to
    // ensemble/app/verification-prep) — moved to ensemble/app/render-prep. It
    // imports each dependency from its canonical home (app → domain/leaf, never
    // back into this orchestrator) and mutates `submissionVerdict`'s findings by
    // reference only on the default-off re-anchor path; every value it returns
    // flows downstream unchanged. The fragile parallel arrays (keepIndex, the
    // filtered-consensus triple, markers) moved byte-identical with no reordering.
    const {
      submissionVerdict,
      renderableUnanchoredForSubmission,
      filteredConsensusByIndex,
      filteredConsensusProvenance,
      intendedEvent,
      approvalReadiness,
      effectiveEvent,
      synthConfidence,
      reviewIncomplete,
      filesDroppedFromReview,
      reviewEventOverride,
      deltaCounts,
      currentFindingsForManifest,
      coverage,
      verificationMode,
      addedLineTextByLine,
      findingMarkers: findingMarkersFromPrep,
    } = await prepareRender({
      env,
      owner,
      repo,
      prNumber,
      headSha,
      ensembleConfig,
      sigilixConfig,
      orchCtrl,
      validationSink: args.validationSink,
      router,
      fullPrDiff,
      reviewable,
      filesNotReviewed,
      droppedTooLarge,
      succeeded,
      degradedCoverage,
      synthInputVerdicts,
      synthOutput,
      shadowMemoriesForPhase3,
      validated,
      consensusVerdict,
      consensusProvenance,
      consensusByIndex,
    })
    // `let` (was const): SIG-285 PR 4 filters this in lockstep with
    // submissionVerdict.findings when a refuted finding is demoted, to keep the
    // marker<->finding index alignment the builder relies on (SIG-127).
    let findingMarkers: Array<string | null> = findingMarkersFromPrep

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

    // SIG-318 (PR 12e): the VERIFY-AND-BUILD phase — the detached gate-shadow
    // telemetry IIFE (fire-and-forget), the SIG-285 verification + refuted-demote
    // (the only enforce-path mutation) + the v2 receipt-join + the Trust Ledger v0
    // baseline annotation + the evidence/scope telemetry, then the submission build
    // (affordance preparation, buildReviewSubmissionWithMetadata with its
    // captureGolden(render) seam, and the output-surface strip) — moved verbatim to
    // ensemble/app/verify-and-build. It imports each dependency from its canonical
    // home (app → domain/leaf/render-leaf laterals, never back into this
    // orchestrator) and mutates `submissionVerdict.findings`,
    // `renderableUnanchoredForSubmission`, and `findingMarkers` in lockstep on the
    // refuted-demote path; the first two are mutated by reference, the reassigned
    // `findingMarkers` is returned explicitly and re-bound here.
    const {
      primaryEvent,
      primaryAffordance,
      prepareFallbackAffordance,
      submissionBuild,
      submission,
      bodyOnlyAnnotations,
      allFindingAnnotations,
      checkAnnotationMeta,
      reviewOutputSurface,
      findingMarkers: findingMarkersAfterBuild,
    } = await verifyAndBuildSubmission({
      env,
      owner,
      repo,
      prNumber,
      headSha,
      ensembleConfig,
      validationSink: args.validationSink,
      meta,
      reviewable,
      addedLineTextByLine,
      stack,
      coverage,
      deltaCounts,
      filesDroppedFromReview,
      approvalReadiness,
      effectiveEvent,
      intendedEvent,
      reviewEventOverride,
      verificationMode,
      receiptScanIndex,
      receiptJoinMode,
      trustLedgerMode,
      showEvidence,
      filteredConsensusByIndex,
      filteredConsensusProvenance,
      degradedCoverage,
      reviewIncomplete,
      synthConfidence,
      tokenUsageByModel,
      submissionVerdict,
      renderableUnanchoredForSubmission,
      findingMarkers,
    })
    findingMarkers = findingMarkersAfterBuild
    // SIG-318 (PR 12f): the PUBLISH phase — the inline PR-overview render + its
    // post-overview stale-head guard (#3), the pre-submit dismiss, the submit +
    // 4-level fallback ladder (inline → comment-fallback / 422 → anchorless →
    // comment-fallback, the inner try/catch/finally + its `emitPhaseCompleted`
    // intact), and the per-path post-submit persistence — moved verbatim to
    // ensemble/app/publish. Every terminal path returns `finalize(...)`, so the
    // phase returns the `EnsembleResult` directly. The two submit-ladder rethrows
    // (`throw submitErr` / `throw fallbackSubmitErr`) propagate OUT of
    // `publishReviewSubmission` to this outer catch — publish adds no catch of its
    // own. The orchestrator threads in the ambient identity, the verify-and-build
    // outputs, the mutable telemetry + cache, and the deterministic-annotation /
    // ast-auto-inline closures.
    return await publishReviewSubmission({
      env,
      owner,
      repo,
      prNumber,
      headSha,
      installationId,
      staleHeadRequeueDepth,
      repoId: args.repoId,
      client,
      sigilixConfig,
      meta,
      perfCtx,
      telemetry,
      startMs,
      cache,
      fullPrDiff,
      stack,
      coverage,
      deltaCounts,
      filesDroppedFromReview,
      currentFindingsForManifest,
      reviewEventOverride,
      trustLedgerMode,
      showEvidence,
      runnerEvidenceBadge,
      submissionVerdict,
      renderableUnanchoredForSubmission,
      primaryEvent,
      primaryAffordance,
      prepareFallbackAffordance,
      submissionBuild,
      submission,
      bodyOnlyAnnotations,
      allFindingAnnotations,
      checkAnnotationMeta,
      reviewOutputSurface,
      maybePostAstAutoInline,
      deterministicCheckAnnotationMeta,
      deterministicErroredReviewMeta,
    })
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

// SIG-318 (PR 12c): `appendRoleRule` (private) moved with the specialists+synth
// seam to ensemble/app/specialists (its only callers were the shadow + prod
// specialist fan-out).

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

// SIG-318 (PR 12f): `countBySeverity` / `countByCategory` (the inline-overview
// severity/category breakdown helpers) moved with the publish seam to
// ensemble/app/publish — their only caller was the inline-overview reviewContext.

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
// (`writeTelemetry`) — live in ensemble/adapters/persistence. SIG-318 (PR 12f):
// their last orchestrator consumers — `writeReviewManifestForEnsemble` (the submit
// paths) + `incrementDailyBudget` / `writeTelemetry` (the relocated `finalize`) —
// moved to ensemble/app/{publish,session}, so the orchestrator no longer imports
// them back. The persistence module is unchanged; the public surface is unaffected
// (these were private here, never re-exported).

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
// SIG-318 (PR 12d): the orchestrator's only direct `runWithRetryAndFallback` call
// (the claim-extractor closure) moved into ensemble/app/render-prep, so the
// import-back is gone — the symbol stays re-exported above for tests + the shadow
// runner.

// ─── verdict post-processing ──────────────────────────────────────────

// SIG-318 (PR 12d): `collectApprovalReadinessSourceFindings` moved with the
// render-prep phase to ensemble/domain/synth (it is a pure flattener the
// render-prep app phase calls). Re-exported here so existing importers (tests)
// are unaffected.

// SIG-318 (PR 12c): `collectSpecialistVerdicts` (private) moved with the
// specialists+synth seam to ensemble/app/specialists (its only caller was the
// post-fanout collect step; it reads the model-provider adapter, which only the
// app layer may import).

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

// SIG-318 (PR 12f): `runInlineOverviewWithRetry` (the single-retry inline-overview
// runner) moved with the publish seam to ensemble/app/publish — its only caller was
// the inline-overview render in the publish block.

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

// SIG-318 (PR 12f): `EnsembleResultStatus` (internal status union), the public
// `ReviewMeta` review-result contract, the generic `EnsembleResult`, and the
// `finalize` choke point moved to ensemble/app/session. `EnsembleResult` is bound
// here to the concrete (god-file-resident) `EnsembleTelemetry` so the public type
// is byte-identical; `ReviewMeta` is re-exported at the import site above. The
// telemetry-type parameter exists so session never imports the ~310-line private
// `EnsembleTelemetry` interface — see the session header note.
export type EnsembleResult = EnsembleResultBase<EnsembleTelemetry>
