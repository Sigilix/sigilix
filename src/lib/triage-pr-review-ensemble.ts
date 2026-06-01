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

import { chat, type ChatMessage } from "./ollama-chat"
// ARC-283 Phase B1b: re-export ChatMessage so the shadow runner can
// type its `runWithRetryAndFallback` calls without reaching past
// this module into ./ollama-chat.
export type { ChatMessage }
import { retrieveChunks, formatChunksForPrompt, type RetrievedChunk } from "./retrieval"
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
import { embedText } from "./embeddings"
import { buildAddedLineTextByLine, buildChangedLines, type ChangedLines } from "./ast-rules/diff-filter"
import { mapWithConcurrency } from "./bounded-concurrency"
import {
  loadWithdrawals,
  filterWithdrawnFindings,
  type WithdrawalRecord,
} from "./review-withdrawal-store"
import { GitHubClient, GitHubHttpError, type CheckRunAnnotation } from "./github"
import { getInstallationToken } from "./github-app"
import { parseFirstJsonObject } from "./json-extract"
import { PR_REVIEW_SCHEMA } from "./schemas"
import {
  type PrReviewVerdict,
  type PrReviewFinding,
  type ReviewFindingScope,
  type CoverageRoles,
  type DeltaBadgeCounts,
  parsePrReviewResponse,
  buildBodyOnlyCheckAnnotations,
  buildFallbackSubmission,
  buildReviewSubmissionWithMetadata,
  chooseReviewEvent,
  computeShadowGateDivergence,
  getProposedChangeScopeMismatch,
  isSubstantiveAnchorLine,
  previewFallbackSubmissionEvent,
  previewReviewSubmissionEvent,
  type ReviewEvent,
  type ReviewEventOverride,
} from "./triage-pr-review"
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
  mergeInspectedTestFileContents,
  mergeHelperCoverage,
  renderTestingEvidenceBlock,
  type TestingEvidencePack,
  type InspectedTestFileFetchResult,
} from "./testing-evidence-pack"
import { detectHelperCoverage } from "./helper-coverage"
import {
  buildSecurityFactManifest,
  type SecurityFact,
} from "./security-evidence-manifest"
import {
  evaluateSecurityFinding,
  evaluateScanFactDismissal,
  parseSecurityValidatorMode,
  deriveSecurityBucket,
  AUTHZ_BUCKET,
  type SecurityValidatorMode,
  type SecurityDropReason,
} from "./validate-security-finding"
import { durableObjectClassSpans, lineInDurableObjectClass, type LineSpan } from "./durable-object-spans"
import {
  evaluateTestFinding,
  parseTestsValidatorMode,
  parseCoverageGapRef,
  type TestsValidatorMode,
  type TestDropReason,
} from "./validate-test-finding"
import {
  evaluateLogicFinding,
  parseLogicValidatorMode,
  buildChangedLineTextByPath,
  type LogicValidatorMode,
  type LogicDropReason,
  type LogicEvidence,
} from "./validate-logic-finding"
import {
  evaluatePerfFinding,
  parsePerfValidatorMode,
  type PerfValidatorMode,
  type PerfDropReason,
  type PerfEvidence,
} from "./validate-perf-finding"
import {
  evaluateInlineGrounding,
  parseInlineGroundingValidatorMode,
  type InlineGroundingValidatorMode,
  type InlineGroundingDropReason,
} from "./validate-inline-grounding"
import {
  evaluateAbsenceGrounding,
  parseAbsenceClaimValidatorMode,
  type AbsenceClaimValidatorMode,
  type AbsenceGroundingDropReason,
} from "./validate-absence-grounding"
import {
  evaluateSecurityGrounding,
  parseSecurityGroundingValidatorMode,
  type SecurityGroundingValidatorMode,
  type SecurityGroundingDropReason,
} from "./validate-security-grounding"
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
  deriveSide,
  type ReviewableMap,
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
import type { ListOpenPullsItem } from "./github"
import { withComposedTimeout } from "./agent-loop"
import {
  applyLogicPromptBudget,
  parseLogicPromptBudgetMode,
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
  type SigilixProfile,
} from "./sigilix-config"
import {
  renderScopedRulesForPrompt,
  resolveScopedRulesForChangedPaths,
} from "./scoped-rules"
import { loadCompiledScopedRulesManifest } from "./scoped-rules-kv"
import {
  runPerfBudgetsCheck,
  renderPerfBudgetsForPrompt,
  type PerfBudgetsHit,
} from "./perf-budgets"
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
import { shouldReview } from "./path-glob"
import {
  runDeterministicChecks,
  renderHitsForPrompt,
  type DeterministicCheckHit,
} from "./deterministic-checks"
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
  computeFileListHash,
  readReviewManifest,
  writeReviewManifest,
  type ReviewManifestFinding,
  type ReviewManifestV1,
} from "./review-manifest"
import { dismissPriorSigilixReviews } from "./dismiss-prior-reviews"
import { PROMPT_VERSION } from "../prompts/pr-review"
import { runDepVulnScan, type ScanSkipReason as DepVulnSkipReason } from "./dep-vulns/scanner"
import { runAstRules } from "./ast-rules/runner"
import { renderAstFindingsAsJsonForSynth } from "./ast-rules/render"
import { buildFactsByRole } from "./role-scoped-facts"
import { postAstInlineFindings } from "./ast-rules/inline-poster"
import { runSarifEvidence, type ScanSkipReason as SarifSkipReason } from "./sarif-evidence/runner"
import { lookupRunnerEvidence, readRunnerEvidenceMode, type RunnerEvidenceState } from "./runner-evidence/lookup"
import { recordRunnerEvidenceMetric } from "./runner-evidence-metrics-client"
import { readVerificationMode, readReanchorEnabled } from "./verification/mode"
import { verifyFinding, findingKey, selectRefutedInlineDemotions, applyRefutedDemotion, planReanchor, applyReanchors } from "./verification/verify-finding"
import {
  verifyFindingAgainstReceipt,
  buildReceiptIndex,
  extractReceiptScanResults,
  parseReceiptJoinMode,
  type ReceiptScanResult,
} from "./verification/verify-finding-receipt"
import { parseSarif } from "./sarif-evidence/sarif-parser"
import { normalizeSarifPath } from "./sarif-evidence/path-normalize"
import { recordVerificationMetricsBounded } from "./verification-metrics-client"
import { RECEIPTJOIN_CATEGORY, TRUSTLEDGER_CATEGORY, type RecordVerificationArgs } from "../do/verification-metrics"
import { annotateFindingTrust, parseTrustLedgerMode } from "./trust-ledger-thread"
import {
  renderSarifFindingsForPrompt,
  renderSarifFindingsAsJsonForSynth,
} from "./sarif-evidence/render"
import { resolveSarifEvidenceConfig } from "./sigilix-config"
import { renderDepVulnFindingsForPrompt } from "./dep-vulns/render"
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
  resolveClaimShadowMode,
  type ShadowMatchFinding,
} from "./review-memory/shadow-match"
import { isSoftenActive, softenScoreWithFloor } from "./review-memory/soften-gate"
import { applyDegradedCoverageFindingFloor } from "./degraded-finding-floor"
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
  emitModelAttempt,
  emitPhaseCompleted,
  emitSpecialistFanoutSummary,
  emitSynthSummary,
  narrowSynthRetryOutcome,
} from "./ensemble-perf-telemetry"
// ARC-283 Phase B1b — shadow-mode bake-off harness. Imports are
// no-ops when `env.SHADOW_BAKEOFF_ROLES` is unset/empty (the only
// code path that fires is `parseShadowEnabledRoles("")` → empty
// Set → every `resolveShadowConfig` returns null → no fan-out).
import {
  parseShadowEnabledRoles,
  resolveShadowConfig,
} from "./shadow-bakeoff-config"
import {
  buildShadowVerdictComparison,
  emitShadowCutShort,
  emitShadowRunFailed,
  emitShadowVerdictComparison,
  type FindingForOverlap,
} from "./shadow-bakeoff-telemetry"
import {
  runShadowSpecialist,
  runShadowSynth,
  type ShadowRunResult,
} from "./shadow-bakeoff-runner"
import type { Env } from "../index"
// SIG-138 Phase 2 — graph expansion.
import { graphContextFor, blastRadiusByNamesFor } from "./repo-graph-client"
// SIG-286 — graph-context body expansion (shadow-only in PR1).
import { contextExpansionForChangedSymbolsFor } from "./repo-graph-client"
import { buildGraphContextExpansion } from "./graph-context-expansion"
import type { ValidationRejectionEvent } from "../do/validation-metrics"
import type { GraphRetrievalSample } from "../do/graph-metrics"
import type { GraphExpansionSample } from "../do/graph-expansion-metrics"
import { graphExpansionMode } from "./graph-expansion-mode"
import type { GraphContextNode } from "../do/repo-graph"
import { edgeWeight, hopDecay } from "./graph-scoring"
import { withTimeout } from "./with-timeout"

// ─── tunables (defaults — env-overridable) ─────────────────────────────

// DEFAULT_MAX_MODEL_CALLS_PER_PR is configured via env but currently
// unused at the orchestrator level — Phase 4a relies on the per-call
// timeouts + the precomputed retrieval budget for cost control.
const DEFAULT_MAX_RETRIEVE_CALLS_PER_PR = 3

// Phase 4a.3 timeout schedule (rebalanced 2026-05-06 after Phase 4a.2
// telemetry validation, ARC-171). The Phase 4a.1 sizing (180s) was
// based on "median successful logic latency = 78s" — but that figure
// excluded the failed-aborted runs that were silently capped at 90s
// pre-Phase-4a.1 and 180s pre-Phase-4a.3. Real post-4a.2 telemetry
// (PR #45 record) showed `deepseek-v4-pro:cloud` consistently doing 2
// primary attempts of ~90s each, exhausting the 180s budget mid-
// second-attempt and killing the cross-provider fallback before it
// could fire.
//
// SIG-234 (2026-05-26): tightened 270s → 185s. The new lineup
// retires `deepseek-v4-pro:cloud` from the logic primary slot
// (was the 100-270s wall-time floor). New primaries fit a
// realistic worst case of 3 attempts × 60s per-attempt cap = 180s,
// rounded up to 185s for the 1s inter-attempt retry-backoff slack
// asserted by the budget-invariant test below. The pre-tighten 270s
// was a comfort budget for the v4-pro slow path; with v4-flash +
// qwen3-coder-next + minimax-m2.5 + glm-5.1, we don't need it. The
// static invariant test regression-guards the budget arithmetic.
//
// Pre-SIG-234 history: sized to fit `2 primary attempts (2×90s) +
// retry backoff (~1s) + 1 cross-provider fallback attempt (~80s,
// kimi-k2.5:cloud)` = 261s, rounded up to 270s for slack.
//
// SIG-287 (2026-05-30): bumped 185s → 250s → 370s over successive passes.
// Live telemetry showed logic aborting mid-generation at its per-attempt cap on
// 13k+-tok prompts (graph+symbol+retrieval context) while security/perf/tests
// finish in 4-25s — logic is the unique long-pole. 110s, then 240s, each STILL
// left it INTERMITTENT (available on some reviews, aborted on others). A
// thorough logic pass legitimately takes minutes (CodeRabbit/Greptile too);
// founder ruling: availability+believability outrank speed, reviews up to ~8 min
// are fine, the only HARD ceiling is Cloudflare's 900s queue-consumer limit.
// 370s fits logic's 360s per-attempt within the invariant (370+325+195 = 890 ≤
// 895; synth trimmed 420→325 to make room — it was wildly over-provisioned).
// Other roles finish fast, so the higher wall is pure headroom for them.
export const SPECIALIST_TIMEOUT_MS = 370_000
// ARC-283: synth budget bumped from 180s → 420s after PR #93's own
// review timed out at 180s on a 900-line diff + 27 new tests.
// Sigilix's product positioning is "yes cost more time for BETTER,
// more THOUGHT-OUT reviews" — timing out is a non-starter when
// specialists already returned cleanly and the merge step just
// needed more time. 420s comfortably handles 3-4× the diff size
// that timed out at 180s. Pre-ARC-283 telemetry showed synth at
// 22-100s on small/medium PRs; the 420s ceiling matches the
// product brand without leaving runaway resource budgets open.
//
// SIG-287 (2026-05-30): trimmed 420s → 325s to free budget for logic's 360s
// per-attempt. Synth was over-provisioned — telemetry shows it at 22-100s, so
// the 325s primary + the 160s in-headroom retry is still 3-5× the observed p95.
export const SYNTHESIZER_TIMEOUT_MS = 325_000
// ARC-278 + ARC-283: cap for the one-shot synth RETRY budget. Lives
// INSIDE the reserved headroom — the retry is "use what's left in
// the headroom envelope, don't extend the orchestrator wall."
//
// Pre-ARC-283: 30s. That was enough for parse/provenance retries
// (the model already produced output, just needed to re-emit
// cleanly) but useless when primary timed out on actual model
// latency — the retry would just timeout again in 30s.
//
// Post-ARC-283: 160s. A retry that fires after a primary timeout
// now has a real shot at completing; a retry that fires after a
// parse/provenance failure still completes fast (those don't need
// the full budget). Trimmed from 170s → 160s on Sigilix's own
// PR #94 review catch to make room for pre-flight retrieval in
// the headroom envelope (see invariant block below).
//
// Budget math (post-Sigilix-PR-#94-catch):
//   SPECIALIST (270) + SYNTHESIZER (420) + RESERVED_HEADROOM (195) = 885
//   Inside the 195s headroom: pre-flight (15) + retry (160) + finalize (20).
//   So `RESERVED_HEADROOM_MS` is NOT spent in addition to retry —
//   pre-flight, retry, AND finalize all carve out of it. The second
//   module-load invariant below verifies that arithmetic.
export const SYNTHESIZER_RETRY_TIMEOUT_MS = 160_000
// Reserved for pre-flight retrieval + diff parse + stale-head guards +
// telemetry write — AND, post-ARC-278, for the synth retry call when
// it fires. The orchestrator must always have at least this much
// headroom beyond (specialist + synth) so a slow Vectorize round-trip
// doesn't eat into the synth budget.
//
// ARC-283 + Sigilix PR #94 catch: bumped 40s → 195s. The 195s budget
// breakdown: pre-flight retrieval (15s, see RETRIEVAL_PREFLIGHT_TIMEOUT_MS) +
// synth retry (160s) + finalize reserve (20s). Pre-Sigilix-catch
// version was 190s — short by exactly the 15s pre-flight, which
// caused worst-case wall-clock to overshoot the orchestrator by 5s
// and abort the run during finalize (reintroducing the very failure
// mode ARC-283 was meant to eliminate).
export const RESERVED_HEADROOM_MS = 195_000
// ARC-283: 270 + 420 + 195 = 885, with 10s slack inside the
// orchestrator. Cloudflare queue consumer ceiling is 900s, so the
// new 895s budget stays just inside the platform limit while
// extending the per-review wall-clock from 8.2 min → 14.9 min.
// Phase B (DO-alarm-driven synth) lifts the queue ceiling entirely;
// tracked in ARC-283. For now, 895s comfortably absorbs the diffs
// that pre-ARC-283 was burning out on.
export const ORCHESTRATOR_TIMEOUT_MS = 895_000
// SIG-287: synth confidence (1-5) at or below this downgrades an otherwise-
// clean APPROVE to a neutral COMMENT — a low-confidence review must not read as
// a confident sign-off. Degraded coverage (a missing specialist) ALSO triggers
// the downgrade independently of this. Tunable knob; 2 = "low".
export const LOW_CONFIDENCE_COMMENT_THRESHOLD = 2
// Cap the pre-flight Vectorize round-trip so a slow retrieval can't
// silently consume the synth budget. Failed pre-flight is non-fatal
// per v3.1 §8 — specialists fall back to empty snapshot.
export const RETRIEVAL_PREFLIGHT_TIMEOUT_MS = 15_000
// SIG-129: branch chunks to consider per pass before merge dedup/re-rank.
// Matches retrieval.ts TOP_K (6) so a pass can be fully branch-sourced.
const TOP_K_BRANCH = 6
// Phase 4a.4 (ARC-175): cap each individual model attempt inside
// `runWithRetryAndFallback` so a single slow primary call can't eat
// the entire `SPECIALIST_TIMEOUT_MS` budget and starve the retry +
// fallback. Telemetry on PR #47 (Phase 4a.3 era) showed v4-pro logic
// stalling for the full 270s on a single attempt with `attempts=1` —
// the budget extension just gave the primary more rope.
//
// ARC-283 B1a: tightened 85s → 60s based on real-run telemetry from
// PR #96 (the B0 dogfood capture). Observed healthy logic specialist
// latency on two clean runs was 28s and 57s — the 85s cap was way
// above the natural distribution. Tightening to 60s:
//
//   - Gives healthy attempts (28-57s observed) ~3-30s of margin —
//     still completes successfully.
//   - Cuts each failed-primary attempt's wasted wall-clock by 25s.
//     Worst-case retry-chain compresses from 256s → 181s per role.
//   - The 9-min P99 outliers on PR #94 came from a specialist's
//     retry chain hitting the full 85s × 3 attempts. At 60s the
//     same chain would take 181s — saving ~75s per offending role.
//
// Math under the new cap: 2 × 60s primary + ~1s backoff + 60s
// fallback = ~181s, fits comfortably within the 270s SPECIALIST
// budget (89s slack).
export const PER_ATTEMPT_TIMEOUT_MS = 60_000
// Graph RPC budget: graph context is purely additive; a slow DO call must
// not consume orchestrator wall time. Env-tunable via
// OPENCLAW_GRAPH_RPC_TIMEOUT_MS (e.g. for integration test overrides).
// Default 2500 ms is generous for a local DO RPC but tight enough that a
// hung worker doesn't delay the review.
export const GRAPH_RPC_TIMEOUT_MS = 2_500
// SIG-286: wall-clock budget for the shadow graph-context expansion (one DO RPC
// + in-process body slicing, no GitHub reads in PR1). Composed with
// orchCtrl.signal so a stuck DO can never delay the review.
export const GRAPH_EXPANSION_TIMEOUT_MS = 3_000
// SIG-143: max blast-radius paths folded into the prompt graph-context block.
// Mirrors the ≤4 cap on BFS graph-node additions — keeps the additive context
// from crowding out the primary vector-hit retrieval.
const GRAPH_BLAST_PROMPT_CAP = 4
const SPECIALIST_VERDICT_TOKEN_CAP = 8_000
const MAX_ADVISORY_NITS = 5

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
  })
  const rendered = renderDynamicReviewEvidenceBlock(pack)

  return {
    mode,
    pack,
    rendered,
    promptBlock: mode === "post" ? rendered : "",
  }
}

// Static budget invariant — guarantees the synth always has its full
// 180s budget regardless of pre-flight + diff-parse + stale-head latency.
// Tripped → throws at module load, not at runtime, so misconfigured
// builds fail fast.
if (SPECIALIST_TIMEOUT_MS + SYNTHESIZER_TIMEOUT_MS + RESERVED_HEADROOM_MS > ORCHESTRATOR_TIMEOUT_MS) {
  throw new Error(
    `[ensemble] timeout invariant violated: ` +
      `SPECIALIST_TIMEOUT_MS (${SPECIALIST_TIMEOUT_MS}) + ` +
      `SYNTHESIZER_TIMEOUT_MS (${SYNTHESIZER_TIMEOUT_MS}) + ` +
      `RESERVED_HEADROOM_MS (${RESERVED_HEADROOM_MS}) ` +
      `must be ≤ ORCHESTRATOR_TIMEOUT_MS (${ORCHESTRATOR_TIMEOUT_MS}).`,
  )
}
// ARC-278 + ARC-283 retry budget invariant — pre-flight retrieval +
// synth retry + finalize ALL share the RESERVED_HEADROOM_MS envelope.
// The orchestrator's wall-clock budget is laid out as:
//
//   [ pre-flight ] [ specialists (parallel) ] [ synth primary ]
//                                              [ synth retry  ]
//                                              [ finalize     ]
//
// Pre-flight runs INSIDE the orchestrator timer (orchTimer starts
// BEFORE preflightRetrieval — verified by tracing the orchCtrl
// usage). It does NOT extend specialist/synth — but it DOES consume
// orchestrator wall-clock, so it has to be charged against headroom.
//
// Sigilix's PR #94 self-review caught the pre-ARC-283-fix-up version
// (HEADROOM=190) missing the 15s pre-flight allowance — worst-case
// wall-clock was 895s vs 890s orchestrator, aborting the run during
// finalize. The third invariant below regression-guards that math.
//
// Pre-ARC-283 finalize was budgeted at 5s; ARC-283 bumped to 20s to
// defend against slower telemetry writes / daily-budget increments /
// cache writes when synth produces a large finding set.
//
// Exported per Sigilix's PR #94 follow-up finding (orphaned on the
// merged PR, picked up here as ARC-288): the test that pins the
// synth-retry budget invariant must import the same constant the
// runtime guard uses, not a hardcoded duplicate that can drift the
// next time the budget changes.
export const SYNTH_RETRY_FINALIZE_RESERVE_MS = 20_000
if (SYNTHESIZER_RETRY_TIMEOUT_MS + SYNTH_RETRY_FINALIZE_RESERVE_MS > RESERVED_HEADROOM_MS) {
  throw new Error(
    `[ensemble] synth-retry budget invariant violated: ` +
      `SYNTHESIZER_RETRY_TIMEOUT_MS (${SYNTHESIZER_RETRY_TIMEOUT_MS}) + ` +
      `SYNTH_RETRY_FINALIZE_RESERVE_MS (${SYNTH_RETRY_FINALIZE_RESERVE_MS}) ` +
      `must be ≤ RESERVED_HEADROOM_MS (${RESERVED_HEADROOM_MS}).`,
  )
}
// Sigilix's PR #94 self-review catch — pre-flight is the third
// consumer of RESERVED_HEADROOM_MS alongside retry + finalize.
// Without this invariant, a worst-case run can blow the orchestrator
// budget by exactly RETRIEVAL_PREFLIGHT_TIMEOUT_MS, aborting the
// review during finalize.
if (
  RETRIEVAL_PREFLIGHT_TIMEOUT_MS +
    SYNTHESIZER_RETRY_TIMEOUT_MS +
    SYNTH_RETRY_FINALIZE_RESERVE_MS >
  RESERVED_HEADROOM_MS
) {
  throw new Error(
    `[ensemble] headroom-envelope invariant violated: ` +
      `RETRIEVAL_PREFLIGHT_TIMEOUT_MS (${RETRIEVAL_PREFLIGHT_TIMEOUT_MS}) + ` +
      `SYNTHESIZER_RETRY_TIMEOUT_MS (${SYNTHESIZER_RETRY_TIMEOUT_MS}) + ` +
      `SYNTH_RETRY_FINALIZE_RESERVE_MS (${SYNTH_RETRY_FINALIZE_RESERVE_MS}) ` +
      `must be ≤ RESERVED_HEADROOM_MS (${RESERVED_HEADROOM_MS}).`,
  )
}
// Cloudflare Queues consumer wall — the entire orchestrator runs
// inside the queue consumer's request handler, which the platform
// caps at 900s. Tracked separately from the orchestrator invariant
// because a future bump that ignores the platform ceiling would
// silently lose every review on production.
const CF_QUEUE_CONSUMER_CEILING_MS = 900_000
if (ORCHESTRATOR_TIMEOUT_MS >= CF_QUEUE_CONSUMER_CEILING_MS) {
  throw new Error(
    `[ensemble] queue-ceiling invariant violated: ` +
      `ORCHESTRATOR_TIMEOUT_MS (${ORCHESTRATOR_TIMEOUT_MS}) ` +
      `must be < CF_QUEUE_CONSUMER_CEILING_MS (${CF_QUEUE_CONSUMER_CEILING_MS}). ` +
      `Phase B (DO-alarm-driven synth, tracked in ARC-283) lifts this ceiling entirely.`,
  )
}

// ARC-283 Phase B1b review pass — shadow tail grace cap.
//
// The orchestrator's `finally` block awaits any in-flight shadow
// promises so it can emit `shadow-verdict-comparison` telemetry on
// every exit path. Pre-grace, those awaits cleared the `orchTimer`
// FIRST, which meant `orchCtrl.signal` no longer autonomously fired
// — a pathologically slow shadow could run for up to ~180s
// (60s per-attempt × (retries + 1) + fallback) AFTER prod returned.
//
// Worst case math: prod returns at the orchestrator-timeout edge
// (895s) and the shadow happens to be in the middle of its
// fallback attempt. Without a tail cap, the queue consumer would
// have to wait the full 180s for shadow to finalize, blowing past
// the 900s CF Queues consumer ceiling → worker hard-killed mid-
// await → message re-delivered → duplicate review.
//
// The cap is RELATIVE to when the finally block STARTS, not
// absolute from handler start. Value chosen as the maximum we can
// afford without violating the CF ceiling:
//
//   CF_QUEUE_CONSUMER_CEILING_MS - ORCHESTRATOR_TIMEOUT_MS
//   = 900_000 - 895_000
//   = 5_000ms
//
// At 5s a healthy shadow that's milliseconds-from-settling still
// emits its comparison; a pathological one gets cut short with a
// `shadow-cut-short` event and the prod return is unaffected.
// Total worst-case wall-clock = 895s + 5s = 900s, exactly at the
// CF ceiling but not over it.
//
// Exported so the helper's unit test can race against the same
// budget the runtime guard uses, mirroring the
// `SYNTH_RETRY_FINALIZE_RESERVE_MS` convention earlier in this file.
export const SHADOW_FINALIZE_GRACE_MS = 5_000
if (SHADOW_FINALIZE_GRACE_MS + ORCHESTRATOR_TIMEOUT_MS > CF_QUEUE_CONSUMER_CEILING_MS) {
  throw new Error(
    `[ensemble] shadow-grace invariant violated: ` +
      `SHADOW_FINALIZE_GRACE_MS (${SHADOW_FINALIZE_GRACE_MS}) + ` +
      `ORCHESTRATOR_TIMEOUT_MS (${ORCHESTRATOR_TIMEOUT_MS}) ` +
      `must be ≤ CF_QUEUE_CONSUMER_CEILING_MS (${CF_QUEUE_CONSUMER_CEILING_MS}). ` +
      `A pathologically slow shadow tail can otherwise push the queue ` +
      `consumer past the 900s ceiling → worker hard-killed → message re-delivered.`,
  )
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
 * SIG-235 — min-specialists early exit mode parser. Returns one of:
 *   - "off"    (default): fan-out waits for ALL specialists to settle
 *   - "shadow"           : fan-out waits for all, BUT logs would-fire
 *   - "on"               : fires synth as soon as N-1 of N succeed,
 *                          cancels the laggard's outstanding ladder
 *
 * Case-insensitive, whitespace-tolerant. Unknown / unset values default
 * to "off" so a misconfigured env never silently changes fan-out semantics.
 *
 * Extracted as a pure helper so unit tests can pin the parser without
 * spinning up the orchestrator.
 */
export type MinSpecialistsEarlyExitMode = "off" | "shadow" | "on"

export function parseMinSpecialistsEarlyExitMode(
  raw: string | undefined,
): MinSpecialistsEarlyExitMode {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "shadow") return "shadow"
  if (v === "on") return "on"
  return "off"
}

/** What the fan-out loop should do at a given settle point (SIG-235 + SIG-236). */
export type EarlyExitAction = "none" | "suppress-protected" | "cancel" | "shadow-mark"

/**
 * Pure decision for the min-specialists early-exit gate. Extracted so the
 * SIG-236 protected-role guard is unit-testable without the orchestrator.
 *   none               — quorum not met (or nothing pending) → keep awaiting
 *   cancel             — "on" + no protected role pending → cancel the laggards
 *   suppress-protected — "on" + logic still pending → do NOT cancel (SIG-236):
 *                        logic is the intentional long-pole; its 110s per-attempt
 *                        cap bounds it, not early-exit. Without this, flipping
 *                        early-exit to "on" would silently re-drop logic.
 *   shadow-mark        — "shadow" → record the would-fire, keep awaiting
 */
export function decideEarlyExitAction(args: {
  mode: MinSpecialistsEarlyExitMode
  succeededCount: number
  quorumThreshold: number
  pendingCount: number
  logicProtectedPending: boolean
}): EarlyExitAction {
  if (args.succeededCount < args.quorumThreshold || args.pendingCount === 0) return "none"
  if (args.mode === "on") return args.logicProtectedPending ? "suppress-protected" : "cancel"
  if (args.mode === "shadow") return "shadow-mark"
  return "none" // "off"
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
 * The score-gate semantics match `score >= 4` as the "major/critical"
 * threshold used across the codebase
 * (`triage-pr-review.ts:1961, 2103`). The orchestrator's inline bypass
 * branch reads the predicate verbatim — keep these in sync.
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

/**
 * Sentinels returned by `raceWithShadowGrace`.
 *
 *  - `SHADOW_GRACE_EXPIRED` — the wall-clock grace deadline fired OR the
 *    parent `orchCtrl.signal` aborted before the shadow promise settled.
 *    Caller emits `shadow-cut-short` with the reason it detected.
 *  - `SHADOW_RUN_FAILED`    — the shadow promise itself REJECTED. The
 *    shadow runners catch every internal failure and return a structured
 *    `{verdictOk:false, ...}` shape, so a rejection means the runner
 *    threw outside its own try/catch (programming bug, OOM, runtime
 *    tear-down). Caller emits the dedicated `shadow-run-failed` event so
 *    dashboards don't mis-attribute a real crash to a benign timeout.
 *
 * Both are unique symbols so callers can discriminate via `===` and
 * TypeScript narrows the underlying `T` correctly. Exported so unit
 * tests assert without re-declaring the sentinel.
 */
export const SHADOW_GRACE_EXPIRED = Symbol("shadow_grace_expired")
export const SHADOW_RUN_FAILED = Symbol("shadow_run_failed")

/**
 * ARC-283 Phase B1b CR-2: compose multiple `AbortSignal`s into one
 * that aborts as soon as ANY input aborts. Used at each shadow
 * dispatch site so the finally block can cancel an in-flight shadow
 * request (per-shadow controller) WITHOUT giving up the existing
 * "orch timeout also kills shadow" behavior (orchCtrl).
 *
 * Returns a fresh `AbortSignal` from an internal `AbortController`.
 * The reason of the FIRST signal to fire is forwarded onto the
 * composed signal so listeners can see WHY it aborted (grace_deadline,
 * orch_aborted, run_failed, ...). Pre-aborted inputs are honored
 * synchronously — the returned signal will already be aborted.
 *
 * No-op when no signals are provided — returns a never-aborting
 * signal (the AbortController is GC'd alongside the signal it owns).
 */
export function composeSignals(...signals: readonly AbortSignal[]): AbortSignal {
  const ctrl = new AbortController()
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort(s.reason)
      return ctrl.signal
    }
    s.addEventListener(
      "abort",
      () => {
        if (!ctrl.signal.aborted) ctrl.abort(s.reason)
      },
      { once: true },
    )
  }
  return ctrl.signal
}

/**
 * Wrapper around the rejection from a shadow promise so the caller
 * can emit a `shadow-run-failed` event with the underlying message.
 * Carries the failure message alongside the sentinel; using a tagged
 * shape instead of throwing keeps `raceWithShadowGrace` resolve-only
 * and preserves the prod return path.
 *
 * The discriminator field is named `__shadowRunFailed` (mangled,
 * starting with underscores) so the type-guard `isShadowRunFailed`
 * narrows reliably even when `T` itself happens to be an object. We
 * can't use plain `"kind" in shadow` because `T = ShadowRunResult`
 * is a structurally-typed object too and TypeScript can't prove the
 * tag is unique to the failure variant.
 */
export interface ShadowRunFailedOutcome {
  readonly __shadowRunFailed: typeof SHADOW_RUN_FAILED
  readonly message: string
}

/** Type-guard for the run-failed sentinel-wrapper. */
export function isShadowRunFailed(value: unknown): value is ShadowRunFailedOutcome {
  return (
    typeof value === "object" &&
    value !== null &&
    "__shadowRunFailed" in value &&
    (value as { __shadowRunFailed: unknown }).__shadowRunFailed === SHADOW_RUN_FAILED
  )
}

/**
 * Races `promise` against an absolute wall-clock `deadline` (ms since
 * epoch). Used by the `handlePrReviewEnsemble` finally block to cap
 * the shadow tail at `SHADOW_FINALIZE_GRACE_MS` so prod return +
 * shadow comparison stay inside the 900s CF Queues consumer ceiling.
 *
 * Resolution table:
 *   - promise resolves first → its value
 *   - promise rejects first  → `{kind: SHADOW_RUN_FAILED, message}`
 *   - deadline fires first   → `SHADOW_GRACE_EXPIRED`
 *   - signal aborted first   → `SHADOW_GRACE_EXPIRED`
 *
 * Never rejects. CR-1: the rejection branch used to resolve with
 * `SHADOW_GRACE_EXPIRED`, which caused the finally block to emit
 * `shadow-cut-short` on a runner crash — misclassifying real failure
 * signal as a timeout. Splitting the two sentinels keeps each event
 * accurate.
 */
export function raceWithShadowGrace<T>(
  promise: Promise<T>,
  deadline: number,
  signal: AbortSignal,
): Promise<T | typeof SHADOW_GRACE_EXPIRED | ShadowRunFailedOutcome> {
  if (signal.aborted) return Promise.resolve(SHADOW_GRACE_EXPIRED)
  const remaining = Math.max(0, deadline - Date.now())
  return new Promise<T | typeof SHADOW_GRACE_EXPIRED | ShadowRunFailedOutcome>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(SHADOW_GRACE_EXPIRED)
    }, remaining)
    const onAbort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Orchestrator was torn down — treat the same as a grace
      // expiry from the comparison's perspective (we can no longer
      // wait for the shadow). The finally consumer reads
      // `orchCtrl.signal.aborted` to label the reason on the
      // emitted `shadow-cut-short` event.
      resolve(SHADOW_GRACE_EXPIRED)
    }
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (err: unknown) => {
        // Shadow runners catch internally and return structured
        // failure — a rejection here means something exploded outside
        // the runner's own catch. Surface as the FAILED sentinel so
        // the finally consumer can emit `shadow-run-failed`, not
        // `shadow-cut-short`. Pre-CR-1 we incorrectly mapped this to
        // `SHADOW_GRACE_EXPIRED`, hiding runner crashes in the
        // cut-short bucket.
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener("abort", onAbort)
        resolve({
          __shadowRunFailed: SHADOW_RUN_FAILED,
          message: err instanceof Error ? err.message : String(err),
        })
      },
    )
  })
}

/**
 * Per-role model lineup with retry/fallback config (v3.1 LOCKED spec
 * amendment, post-shadow-mode telemetry from PR #35-36 dogfooding).
 *
 * Initial v3.1 lineup had two real bugs:
 *   - `qwen3-coder:30b:cloud` was a phantom — Ollama Turbo's tag list
 *     doesn't include a 30B variant on cloud (verified via /api/tags).
 *     Security + tests specialists 404'd on every call.
 *   - `deepseek-v4-pro:cloud` is the latest reasoning model, capacity-
 *     constrained on Ollama Turbo's underlying provider; routinely
 *     returns 503 under demand spikes. With specialist retries
 *     disabled per original spec, that = silent specialist failure
 *     and quorum loss.
 *
 * After dual sign-off (Codex + Kimi K2.6) the lineup is now:
 *   - Same primary models where they were working (logic, perf, synth)
 *   - Replaced phantom qwen3-coder:30b → deepseek-v4-flash for
 *     security + tests (known-working family member, predictable cost)
 *   - Cross-provider fallbacks per role (true uncorrelated resilience —
 *     Kimi-B's argument: same-family fallback fails when the upstream
 *     provider has an outage, defeating the fallback's purpose)
 *   - Retries enabled per-role, sized by criticality (logic gets 2,
 *     others 1, synth 1; user constraint "logic cannot fail").
 */
export interface ModelConfig {
  primary: string
  /** Number of retry attempts on the primary BEFORE falling back. 0 = no retry. */
  retries: number
  /** Cross-provider fallback model. null = fail without fallback. */
  fallback: string | null
  /**
   * SIG-236: per-role override for the per-attempt timeout. Omitted → the
   * runner defaults to the global PER_ATTEMPT_TIMEOUT_MS (no behavior change).
   * Logic sets this higher: its prompt is uniquely large (graph+symbol+full
   * retrieval, ~8.4k tok even after the SIG-287 trim) and needs >60s, so the
   * global 60s cap aborted it mid-generation on every review.
   */
  perAttemptTimeoutMs?: number
}

export const SPECIALIST_CONFIGS: Record<SpecialistRole, ModelConfig> = {
  // SIG-234 lineup swap (2026-05-26): all 5 specialist + synth roles
  // now use UNIQUE primary models per the founder's 4+1 constraint.
  // Driven by Codex's ARC-292 lineup proposal + Ollama-format-
  // compatibility validation (curl-tested each candidate with a
  // JSON-schema-constrained prompt; `mistral-large-3:675b-cloud`,
  // `glm-4.6:cloud`, and `deepseek-v3.1:671b-cloud` ALL wrap output
  // in ```json``` markdown fences and are NOT used). The slow logic
  // primary (deepseek-v4-pro:cloud at 100-270s) is demoted to
  // security + tests fallback — kept reachable for its reasoning
  // capability without anchoring wall-time.
  logic: {
    // Was `deepseek-v4-pro:cloud` (100-270s). `deepseek-v4-flash:cloud`
    // keeps the V4 reasoning lineage + 1M context.
    primary: "deepseek-v4-flash:cloud",
    // 2026-05-26 Codex/measurement: production telemetry on PR #188
    // showed deepseek-v4-flash + kimi-k2.5 (the prior fallback) BOTH
    // hit exactly 60_000ms (PER_ATTEMPT_TIMEOUT_MS) on every review.
    // The retry/fallback ladder was 100% waste — 180s burned, logic
    // verdict never returned, customer got `[DEGRADED COVERAGE]` either
    // way. Codex diagnostic: logic's prompt shape (full retrieval +
    // graph + symbol context) is uniquely expensive; the issue is
    // prompt-driven, not model-driven, so swapping fallbacks alone
    // wouldn't help.
    //
    // #188 tactical fix `retries:0`+`fallback:null` capped logic at 60s
    // (vs 180s), but the ROOT CAUSE was never the ladder — it's that the
    // 60s PER-ATTEMPT cap is too small for logic's prompt. SIG-287 added a
    // trim, but it CANNOT reach the 6000-tok cap: the mandatory floor
    // (diff+graph+deterministic+system+meta+rules+schema) is ~8.4k tok even
    // on a small PR. Live #241 telemetry: model-attempt-completed
    // elapsedMs=60000 outcome=aborted — logic was STILL generating at the
    // cap on EVERY review → "logic specialist unavailable" banner for weeks.
    //
    // SIG-287 TRUE ROOT CAUSE (2026-05-30, telemetry + Ollama API docs +
    // DeepSeek-v4-pro, all concurring): the timeout was NEVER the lever. The
    // 60→110→240→360s bumps ALL failed for the same reason — `generate`/
    // `ollamaChat` omitted `think:false`, so deepseek-v4-flash (a REASONING
    // model) ran an unbounded chain-of-thought in a separate `thinking` field
    // (which the stream reader ignores), emitting ZERO `response` tokens until
    // the per-attempt cap aborted it. Live #251 telemetry: timeoutMs:360000
    // elapsedMs:360000 outcome:aborted with NO outputTokens — a flash model
    // producing nothing in 6 min = a stuck reasoning phase, not slow
    // generation. THE FIX (ollama.ts/ollama-chat.ts): set `think:false` on
    // schema-constrained calls so the model emits the structured answer
    // directly — logic now finishes in seconds like every other role.
    //
    // RESILIENCE (founder-chosen fast-fallback, 2026-05-30): with think:false
    // logic is fast, so drop the per-attempt cap 360→120s (still 2× the
    // expected <60s, covers route variance) and ADD a cross-provider fallback
    // (was null) so ANY future stall — route outage, capacity dip — fails fast
    // and the fallback rescues, exactly like the tests role (primary abort →
    // retry/fallback ok). qwen3-coder-next:cloud (Codex pick): cross-provider
    // from DeepSeek (fails independently — the point of a fallback), proven
    // fast in the same #251 telemetry that exposed the stall (it's security's
    // primary, returned in 7.4s), code-analysis-capable, and think:false
    // applies to it too. NOT deepseek-v4-pro (same family as the failing
    // primary + the slow reasoner — the wrong rescue for a stall). Chain:
    // primary 120s + fallback 120s = ~240s ≤ SPECIALIST_TIMEOUT_MS(370s, 130s
    // slack); the budget invariant (370+325+195 ≤ 895) is unchanged. NOTE:
    // logic can now make 2 model calls (primary + fallback), so
    // MAX_CALLS_PER_ENSEMBLE_RUN rose 16→17. VERIFY reliability across MULTIPLE
    // post-deploy reviews (outcome:ok + real outputTokens + elapsedMs well
    // under cap) before declaring SIG-287 fixed.
    retries: 0,
    fallback: "qwen3-coder-next:cloud",
    perAttemptTimeoutMs: 120_000,
  },
  security: {
    // Coder-model territory: vulnerability patterns are mostly
    // syntax / dataflow recognition, not frontier reasoning. Qwen3-
    // Coder-Next is tuned for agentic coding workflows and the
    // primary needs to be DIFFERENT from tests (which now uses
    // MiniMax) so the 4+1 unique constraint holds.
    primary: "qwen3-coder-next:cloud",
    retries: 1,
    // `deepseek-v4-pro:cloud` recycled here — the slow but capable
    // reasoning model now lives on fallback paths so its latency
    // doesn't anchor the critical path. Cross-provider from Qwen.
    fallback: "deepseek-v4-pro:cloud",
  },
  performance: {
    // Phase 4a.1: glm-5.1 promoted from fallback → primary.
    // Shadow telemetry: glm-5.1 won 6/12 fallback runs, minimax was unreliable.
    //
    // ARC-167 spot-check (2026-05-12): swap ratified on a 41-run sample
    // pulled from production KV. glm-5.1 hits 100% success (26/26) vs
    // minimax-m2.1's 80% (12/15 with 3 timeouts). Findings depth holds
    // up — glm-5.1 averages 1.08 findings/verdict (vs 0.92), with 18%
    // longer body text per finding. The latency tradeoff is real
    // (glm-5.1 p95 = 144s) but well under the 250s specialist budget
    // (SIG-287). Full analysis in
    // `.claude/research/arc-167/_report.md`.
    primary: "glm-5.1:cloud",
    retries: 1,
    // Cross-provider fallback retained — kimi-k2.5 same family as
    // logic's fallback so we know it's reachable.
    fallback: "kimi-k2.5:cloud",
  },
  tests: {
    // MiniMax M2.5 — agentic-code / test-workflow model per Codex's
    // ARC-292 analysis. Format-tested clean (~40-90s). Was
    // `deepseek-v4-flash:cloud` which collided with security's
    // primary in the old lineup (violated the 4+1 unique constraint
    // even pre-this-swap).
    primary: "minimax-m2.5:cloud",
    retries: 1,
    // `deepseek-v4-pro:cloud` reused as fallback — cross-provider
    // from MiniMax, proven on reasoning tasks.
    fallback: "deepseek-v4-pro:cloud",
  },
}

export const SYNTHESIZER_CONFIG: ModelConfig = {
  // SIG-234 lineup swap (2026-05-26): synth primary moves to
  // `gpt-oss:120b-cloud` — open-weight, medium-usage, removes
  // Moonshot from the customer-visible critical merge path entirely.
  // Format-tested clean (1.3s on a small prompt; expected 25-75s on
  // a 4-verdict synth payload). Codex's HIGHEST-priority swap per
  // ARC-292: "Moonshot capacity dip burned 6m16s on PR #97."
  primary: "gpt-oss:120b-cloud",
  retries: 1,
  // ARC-291 (PR #97 hot-fix): swap fallback from kimi-k2.5 → DeepSeek
  // family. Pre-this-fix the fallback was kimi-k2.5:cloud — SAME
  // PROVIDER as primary (both Moonshot). When Moonshot had a bad few
  // minutes, primary + retry + fallback all hit the same wall, the
  // ARC-278 retry doubled the burn, and synth_timeout fired even
  // though specialist verdicts were ready to merge.
  //
  // Sigilix's own review of PR #97 demoed this: 6m 16s wall-clock
  // burned, both attemptSynth calls timed out twice, customer saw
  // "Couldn't review — see PR comment." Brand-fatal UX.
  //
  // Every OTHER ModelConfig in this file has cross-provider
  // fallback. Synth was the only outlier. DeepSeek-v4-flash is the
  // proven lighter DeepSeek variant (already primary on security +
  // tests specialists). DIFFERENT provider from Moonshot — fails
  // INDEPENDENTLY, which is the whole point of fallback.
  //
  // Worst-case math with cross-provider fallback:
  //   Primary attempt:  60s (PER_ATTEMPT cap)  — Moonshot slow → null
  //   Retry attempt:    60s + 1s backoff       — Moonshot slow → null
  //   Fallback attempt: 60s                    — DeepSeek likely OK
  //   Total:           ~121s if Moonshot is slow but DeepSeek is fine
  // vs the pre-fix:
  //   Total:           ~362s (180s × 2 outer attempts) → skip-notice
  fallback: "deepseek-v4-flash:cloud",
}

/**
 * SIG-276 Phase 2: the write-time claim extractor. A cheap, single-shot
 * classifier (no retry, no fallback) over the final findings — fail-open
 * by design, so a capacity blip just yields no claims rather than burning
 * the merge path. `deepseek-v4-flash:cloud` matches the logic specialist's
 * proven format-clean primary.
 */
const CLAIM_EXTRACTOR_CONFIG: ModelConfig = {
  primary: "deepseek-v4-flash:cloud",
  retries: 0,
  fallback: null,
}
/** Per-attempt cap for the claim extractor. Kept well under the
 *  specialist budget — the classifier prompt is small and the call is
 *  fail-open, so a slow model must not extend customer-visible latency. */
const CLAIM_EXTRACTOR_TIMEOUT_MS = 25_000

/** @deprecated kept for telemetry compatibility — derive from SPECIALIST_CONFIGS instead */
const SPECIALIST_MODELS: Record<SpecialistRole, string> = {
  logic: SPECIALIST_CONFIGS.logic.primary,
  security: SPECIALIST_CONFIGS.security.primary,
  performance: SPECIALIST_CONFIGS.performance.primary,
  tests: SPECIALIST_CONFIGS.tests.primary,
}
const SYNTHESIZER_MODEL = SYNTHESIZER_CONFIG.primary

/** Backoff schedule (ms) for retry attempts. 800ms, 2.5s — short
 *  enough to fit within specialist timeout budget (90s), long enough
 *  to ride through most transient 503s. */
const RETRY_BACKOFF_MS = [800, 2500]

// ─── public types ──────────────────────────────────────────────────────

export interface EnsembleHandlerArgs {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  installationId: number
  env: Env
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

// ─── orchestrator ──────────────────────────────────────────────────────

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
  const staleHeadRequeueDepth = args.staleHeadRequeueDepth ?? 0
  const startMs = Date.now()
  const orchCtrl = new AbortController()
  const orchTimer = setTimeout(() => orchCtrl.abort(), ORCHESTRATOR_TIMEOUT_MS)
  // ARC-284: correlation fields for the perf-telemetry events emitted
  // throughout this handler. headSha is truncated at log time inside
  // the helper. Stamped here once so every emit gets the same shape.
  const perfCtx: EnsembleRunCtx = { owner, repo, prNumber, headSha }

  // Lifted out of the try block so the finally cleanup can read cache
  // stats into telemetry on every exit path (success, failure, throw).
  let cache: ReturnType<typeof createRetrievalCache> | null = null

  // SIG-184: runner-evidence trust state for the check-run badge, set once the
  // receipt is consulted (the SARIF-evidence section, below) and read by every
  // POSTED finalize() so the summary can render the VERIFIED/PENDING pill.
  // Function-scoped (like `cache`) so it crosses the inner try-block boundaries.
  // `undefined` = `runner-absent` = no badge (the default, flag-off path).
  let runnerEvidenceBadge: "verified" | "evidence-pending" | undefined = undefined

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
  type ProdSpecialistSnapshot = {
    verdictOk: boolean
    modelUsed: string
    attemptsUsed: number
    elapsedMs: number
    findings: readonly FindingForOverlap[]
  }
  const shadowSpecialistPromises = new Map<SpecialistRole, Promise<ShadowRunResult>>()
  const prodSpecialistSnapshots = new Map<SpecialistRole, ProdSpecialistSnapshot>()
  let shadowSynthPromise: Promise<ShadowRunResult> | null = null
  // ARC-283 Phase B1b CR-2: per-shadow AbortController so the finally
  // block can `.abort(reason)` any shadow request that didn't settle
  // before the grace deadline / orch tear-down. Pre-CR-2 we emitted
  // `shadow-cut-short` but left the in-flight HTTP request alive,
  // silently doubling provider rate-limit pressure past the cut.
  //
  // Keyed by the role the controller belongs to; `"synth"` is used
  // for the single shadow synth controller. Map cleared as each entry
  // settles so the finally loop only sees still-pending shadows.
  const shadowAbortControllers = new Map<SpecialistRole | "synth", AbortController>()

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
    postValidation: { droppedForInvalidLine: 0, remappedInvalidLineToInline: 0, droppedForHallucination: 0, demotedScore1: 0, droppedForVaguePrefix: 0, droppedForUncitedTestingEvidence: 0, droppedForFailedValidation: 0, droppedForFailedTestValidation: 0, droppedForFailedLogicValidation: 0, droppedForFailedPerfValidation: 0, droppedForFailedInlineGroundingValidation: 0, droppedForFailedAbsenceGroundingValidation: 0, droppedForFailedSecurityGroundingValidation: 0 },
    retrievalCacheStats: null,
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
        })
      }
      return finalize(telemetry, env, "errored", cache)
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
        })
      }
      // Submit failed — fall through to `errored` without a surface
      // (we have no comment to point the customer at, and the PR is
      // already merged so a skip-notice is pointless).
      return finalize(telemetry, env, "errored", cache)
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
    const sigilixConfig = await loadSigilixConfig(client, owner, repo, headSha)

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
    const dispatcherMode = env.OPENCLAW_DYNAMIC_DISPATCHER_MODE
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
          console.warn(JSON.stringify({
            event: "dispatcher-enforce-mode-not-honored-in-phase-1",
            owner, repo, prNumber, headSha: headSha.slice(0, 7),
            note: "full enforcement (LLM-decided non-protected + protected) ships in SIG-227b + SIG-228; use mode=enforce_rules for rules-only enforcement available today",
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
      maxCalls: parseIntEnv(env.OPENCLAW_ENSEMBLE_MAX_RETRIEVE_CALLS_PER_PR, DEFAULT_MAX_RETRIEVE_CALLS_PER_PR),
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
      env.OPENCLAW_SYMBOL_RETRIEVAL,
      router.specialists,
      preflightCache.budgetRemaining(),
    )
    const wantBranchAware =
      (env.OPENCLAW_BRANCH_AWARE_RETRIEVAL ?? "").trim().toLowerCase() === "on"
    const wantDynamicReviewEvidence = dynamicReviewEvidenceEnabled(env)
    const astFilesByPath = new Map<string, string>()
    if (
      (astRulesConfig.enabled || wantSymbolRetrieval || wantBranchAware || wantDynamicReviewEvidence) &&
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

    // SIG-129: build the branch retrieval set ONCE (best-effort), reused
    // across the preflight / perf / symbol merges. Empty set ⇒ every merge
    // is a no-op ⇒ identical to today's main-only behavior.
    let branchVectors: BranchVector[] = []
    let branchSetElapsedMs = 0
    if (shouldRunBranchAwareRetrieval(env.OPENCLAW_BRANCH_AWARE_RETRIEVAL, astFilesByPath)) {
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
      const graphRpcBudgetMs = parseIntEnv(env.OPENCLAW_GRAPH_RPC_TIMEOUT_MS, GRAPH_RPC_TIMEOUT_MS)
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
    const graphCtxForPrompt = graphRetrievalMode(env) === "post"
      ? [graphContextString, graphBlastContextString].filter((s) => s.length > 0).join("\n")
      : ""
    // ──────────────────────────────────────────────────────────────────

    // ─── SIG-286: graph-context body expansion (shadow-only in PR1) ─────
    //
    // Gated by OPENCLAW_GRAPH_EXPANSION=shadow|post. Off ⇒ no DO call, no
    // telemetry, zero behavior change. shadow AND post are identical in PR1:
    // COMPUTE the enriched changed-symbol context (definition / caller /
    // import-dependent bodies sliced from astFilesByPath) and emit the
    // `graph-expansion-shadow` event. The result is NEVER injected into any
    // prompt here (graphCtxForPrompt above stays the only graph block reaching
    // specialists/synth). PR1 passes NO fetcher: cross-file rows not in
    // astFilesByPath are counted under bodiesSource.missing / dropped.
    // sourceMissing, quantifying the PR2 cross-file fetch opportunity.
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
    })
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
    const receiptJoinMode = parseReceiptJoinMode(env.OPENCLAW_RECEIPTJOIN_MODE)
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
    let testingEvidenceFetchResult: InspectedTestFileFetchResult = {
      contentByPath: {},
      failedPaths: [],
      budgetOmittedPaths: [],
      truncatedPaths: [],
      totalChars: 0,
    }
    let testingEvidenceFetchedCount = 0
    let testingEvidenceSkippedForBudgetCount = 0
    if (testingEvidencePackInitial.testFilesChanged.length > 0) {
      const fetched = await fetchTestFileContentsWithBudget({
        paths: testingEvidencePackInitial.testFilesChanged,
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
      testingEvidencePackInitial,
      testingEvidenceFetchResult,
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
      siblingMappings: testingEvidencePackInitial.siblingMappings,
      testContentByPath: testingEvidenceFetchResult.contentByPath,
    })
    const testingEvidencePackWithCoverage = mergeHelperCoverage(
      testingEvidencePack,
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
      shadowAbortControllers.set(role, shadowCtrl)
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
        shadowAbortControllers.delete(role)
      })
      shadowSpecialistPromises.set(role, shadowPromise)
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
    const logicPromptBudgetMode = parseLogicPromptBudgetMode(env.OPENCLAW_LOGIC_PROMPT_BUDGET)

    // SIG-235 — min-specialists early exit. Build per-role
    // AbortControllers (mirroring the shadow path above) so the
    // quorum collector can cancel a single laggard's outstanding
    // attempts without affecting the others. composeSignals fires on
    // EITHER orchCtrl OR the per-role controller — same pattern as
    // the shadow path so the ladder cancels cleanly mid-attempt.
    const earlyExitMode = parseMinSpecialistsEarlyExitMode(env.OPENCLAW_MIN_SPECIALISTS_EARLY_EXIT)
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

    // ARC-283 Phase B1b — snapshot per-role prod outcomes for the
    // shadow comparison emit in `finally`. Only writes for roles
    // that have a shadow promise queued; for everyone else we'd
    // never emit a comparison anyway. Reading from `specialistVerdicts`
    // (not `specialistResults`) so we get the same shape downstream
    // telemetry sees (stable-id-assigned verdict, dedupe-corrected
    // modelUsed). Findings are projected to the overlap-helper's
    // shape so the `finally` block stays a thin wrapper.
    for (const v of specialistVerdicts) {
      if (!shadowSpecialistPromises.has(v.role)) continue
      const findings: FindingForOverlap[] = v.verdict
        ? v.verdict.findings.map((f) => ({
            path: f.path,
            line: f.line,
            category: f.category,
            score: f.score,
          }))
        : []
      prodSpecialistSnapshots.set(v.role, {
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
    const synthMessageWithAst = astFindingsForSynth.length > 0
      ? `${synthMessage}\n\n[AST RULE FINDINGS — pre-LLM, structured]\n\nMatch these against specialist findings on \`(path, line, role_hint)\` triple. When a specialist finding shares ALL THREE with an AST entry, drop it from your output and include \`{ specialist, sourceFindingId, headline, reason: "superseded_by_ast/<id>" }\` in \`provenance.dropped[]\`. Cross-role matches (e.g. AST=security vs specialist=performance) do NOT supersede.\n\n\`\`\`json\n${astFindingsForSynth}\n\`\`\``
      : synthMessage

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
        shadowAbortControllers.set("synth", shadowSynthCtrl)
        const composedSynthSignal = composeSignals(orchCtrl.signal, shadowSynthCtrl.signal)
        shadowSynthPromise = runShadowSynth({
          shadowConfig: shadowSynthConfig,
          apiKey: env.OLLAMA_API_KEY,
          systemPrompt: synthSystemPrompt,
          userMessage: synthMessageWithMemory,
          chatEnabled: env.OLLAMA_CHAT_ENABLE === "on" ? "on" : "off",
          signal: composedSynthSignal,
          perfCtx,
        }).finally(() => {
          shadowAbortControllers.delete("synth")
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

    // ─── Post-synthesis validation ─────────────────────────────
    // SIG-141: line spans of DurableObject class declarations in the changed
    // files, parsed from the AST (not raw text). Authz findings inside a DO
    // class body are false (the binding is the trust boundary). Best-effort:
    // derived from the already-fetched changed JS/TS head content
    // (astFilesByPath) — empty when AST features are off, which is fail-safe
    // (no suppression → findings kept, never hidden).
    const doClassSpans = durableObjectClassSpans(astFilesByPath)
    const validated = validateForSubmission({
      synthOutput: { verdict: effectiveSynthVerdict, provenance: effectiveSynthProvenance },
      reviewable,
      specialistVerdicts: synthInputVerdicts,
      // SIG-113: thread the testing-evidence pack through so the
      // citation gate fires on uncited `category: "testing"` findings.
      // Empty pack (no source/test files) → gate no-ops via the
      // pure helper's "pack undefined or empty" branch.
      testingEvidence: testingEvidencePackWithCoverage,
      onTestingFindingDropped: (finding, reason) => {
        console.log(JSON.stringify({
          event: "pr-review-testing-finding-dropped",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          dropReason: reason,
          findingPath: finding.path,
          findingLine: finding.line,
          findingHeadline: finding.headline.slice(0, 120),
          inspectedTestFiles_count: finding.inspectedTestFiles?.length ?? 0,
          evidenceRefs_count: finding.evidenceRefs?.length ?? 0,
        }))
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
      securityValidatorMode: parseSecurityValidatorMode(env.OPENCLAW_SECURITY_VALIDATOR_MODE),
      onSecurityFindingDropped: (finding, info) => {
        console.log(JSON.stringify({
          event: "pr-review-finding-rejected-validation",
          gate: "security",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          reason: info.reason,
          dropped: info.dropped,
          path: finding.path,
          line: finding.line,
          cweId: finding.cweId ?? null,
          evidenceId: finding.evidenceId ?? null,
          category: finding.category,
        }))
        args.validationSink?.push({ kind: "gate-rejection", gate: "security", reason: info.reason, dropped: info.dropped })
      },
      // SIG-111: thread the tests-finding specificity gate mode +
      // telemetry through. Default `shadow` — counts/telemeters the
      // would-drop until the operator flips OPENCLAW_TESTS_VALIDATOR_MODE
      // to "enforce". Reuses the `pr-review-finding-rejected-validation`
      // event with a `gate: "tests"` discriminator.
      testsValidatorMode: parseTestsValidatorMode(env.OPENCLAW_TESTS_VALIDATOR_MODE),
      // SIG-118: thread the real coverage-gap set so both the SIG-113
      // citation gate and the SIG-111 specificity gate accept a
      // `coverageGap:<path>:<line>` ref as a genuine missing-coverage
      // citation. Empty when coverage ingestion is off / yielded nothing.
      coverageGaps: coverageGapSet,
      addedLineTextByLine: buildAddedLineTextByLine(fullPrDiff),
      onTestFindingDropped: (finding, info) => {
        console.log(JSON.stringify({
          event: "pr-review-finding-rejected-validation",
          gate: "tests",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          reason: info.reason,
          dropped: info.dropped,
          path: finding.path,
          line: finding.line,
          inspectedTestFiles_count: finding.inspectedTestFiles?.length ?? 0,
          evidenceRefs_count: finding.evidenceRefs?.length ?? 0,
          category: finding.category,
        }))
        args.validationSink?.push({ kind: "gate-rejection", gate: "tests", reason: info.reason, dropped: info.dropped })
      },
      // SIG-109: thread the logic evidence + mode. Evidence is built
      // PR-A-contained — added-line text from the FULL PR diff +
      // roleHint:logic AST findings (NO symbol retrieval; that's SIG-121).
      // Default `shadow` — the gate only counts/telemeters what WOULD
      // drop until the operator flips OPENCLAW_LOGIC_VALIDATOR_MODE to
      // "enforce". Reuses the `pr-review-finding-rejected-validation`
      // event with a `gate: "logic"` discriminator.
      logicEvidence: {
        changedLineTextByPath: buildChangedLineTextByPath(fullPrDiff),
        astLogicFindings: astResult.findings.filter((f) => f.roleHint === "logic"),
      },
      logicValidatorMode: parseLogicValidatorMode(env.OPENCLAW_LOGIC_VALIDATOR_MODE),
      onLogicFindingDropped: (finding, info) => {
        console.log(JSON.stringify({
          event: "pr-review-finding-rejected-validation",
          gate: "logic",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          reason: info.reason,
          dropped: info.dropped,
          path: finding.path,
          line: finding.line,
          score: finding.score,
          category: finding.category,
        }))
        args.validationSink?.push({ kind: "gate-rejection", gate: "logic", reason: info.reason, dropped: info.dropped })
      },
      // SIG-110: thread perf evidence + mode. Evidence is the same
      // changed-line text + the roleHint:performance AST findings. Default
      // `shadow` — counts/telemeters the would-drop until the operator
      // flips OPENCLAW_PERF_VALIDATOR_MODE to "enforce". Reuses the
      // `pr-review-finding-rejected-validation` event (`gate: "perf"`).
      perfEvidence: {
        changedLineTextByPath: buildChangedLineTextByPath(fullPrDiff),
        astPerfFindings: astResult.findings.filter((f) => f.roleHint === "performance"),
      },
      perfValidatorMode: parsePerfValidatorMode(env.OPENCLAW_PERF_VALIDATOR_MODE),
      profile: sigilixConfig.profile ?? "chill",
      onPerfFindingDropped: (finding, info) => {
        console.log(JSON.stringify({
          event: "pr-review-finding-rejected-validation",
          gate: "perf",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          reason: info.reason,
          dropped: info.dropped,
          path: finding.path,
          line: finding.line,
          score: finding.score,
          category: finding.category,
        }))
        args.validationSink?.push({ kind: "gate-rejection", gate: "perf", reason: info.reason, dropped: info.dropped })
      },
      // SIG-281 PR C (Rec 4): inline-grounding gate. Default `shadow` —
      // counts/telemeters the would-demote until the operator flips
      // OPENCLAW_INLINE_GROUNDING_VALIDATOR_MODE to "enforce". Reuses the
      // `pr-review-finding-rejected-validation` event (`gate:
      // "inline-grounding"`). `dropped` here = "demoted to body".
      inlineGroundingValidatorMode: parseInlineGroundingValidatorMode(env.OPENCLAW_INLINE_GROUNDING_VALIDATOR_MODE),
      onInlineGroundingFindingDropped: (finding, info) => {
        console.log(JSON.stringify({
          event: "pr-review-finding-rejected-validation",
          gate: "inline-grounding",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          reason: info.reason,
          dropped: info.dropped,
          path: finding.path,
          line: finding.line,
          score: finding.score,
          category: finding.category,
        }))
        args.validationSink?.push({ kind: "gate-rejection", gate: "inline-grounding", reason: info.reason, dropped: info.dropped })
      },
      // SIG-290 v1: absence-claim grounding gate. Default `off` — the gate
      // doesn't run at all until the operator flips
      // OPENCLAW_ABSENCE_CLAIM_VALIDATOR_MODE to "shadow" (count/telemeter,
      // keep inline) or "enforce" (demote ungrounded absence-claims to the
      // body). `wasTruncated` + `droppedTooLarge` are the in-scope diff-
      // packing signals from `handlePrReviewEnsemble`. Reuses the
      // `pr-review-finding-rejected-validation` event (`gate:
      // "absence-grounding"`). `dropped` here = "demoted to body".
      absenceClaimValidatorMode: parseAbsenceClaimValidatorMode(env.OPENCLAW_ABSENCE_CLAIM_VALIDATOR_MODE),
      wasTruncated,
      droppedPaths: droppedTooLarge,
      onAbsenceFindingDropped: (finding, info) => {
        console.log(JSON.stringify({
          event: "pr-review-finding-rejected-validation",
          gate: "absence-grounding",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          reason: info.reason,
          dropped: info.dropped,
          path: finding.path,
          line: finding.line,
          score: finding.score,
          category: finding.category,
        }))
        args.validationSink?.push({ kind: "gate-rejection", gate: "absence-grounding", reason: info.reason, dropped: info.dropped })
      },
      // SIG-293 v1: security-grounding gate (secrets-exposure). Default
      // `off` — the gate doesn't run until the operator flips
      // OPENCLAW_SECURITY_GROUNDING_VALIDATOR_MODE to "shadow" (count/
      // telemeter, keep inline) or "enforce" (demote a secrets-exposure
      // finding whose cited line holds no credential token). Reuses the
      // `securityManifest` + `addedLineTextByLine` already threaded above,
      // and the `pr-review-finding-rejected-validation` event (`gate:
      // "security-grounding"`). `dropped` here = "demoted to body".
      securityGroundingValidatorMode: parseSecurityGroundingValidatorMode(env.OPENCLAW_SECURITY_GROUNDING_VALIDATOR_MODE),
      onSecurityGroundingFindingDropped: (finding, info) => {
        console.log(JSON.stringify({
          event: "pr-review-finding-rejected-validation",
          gate: "security-grounding",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          reason: info.reason,
          dropped: info.dropped,
          path: finding.path,
          line: finding.line,
          score: finding.score,
          cweId: finding.cweId ?? null,
          category: finding.category,
        }))
        args.validationSink?.push({ kind: "gate-rejection", gate: "security-grounding", reason: info.reason, dropped: info.dropped })
      },
    })
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
      droppedForFailedPerfValidation: validated.droppedForFailedPerfValidation,
      droppedForFailedInlineGroundingValidation: validated.droppedForFailedInlineGroundingValidation,
      droppedForFailedAbsenceGroundingValidation: validated.droppedForFailedAbsenceGroundingValidation,
      droppedForFailedSecurityGroundingValidation: validated.droppedForFailedSecurityGroundingValidation,
    }

    // ARC-270 — consensus-aware re-ranking. Strictly additive: we
    // don't change the verdict gate (`chooseReviewEvent`), drop
    // findings, or touch scores. Just reorder so multi-specialist
    // findings surface first and capture a consensus count per
    // finding for the body annotation below.
    const consensusRanked = computeConsensusRanking(
      validated.verdict,
      validated.cleanFindingProvenance,
    )
    const consensusVerdict = consensusRanked.verdict
    const consensusProvenance = consensusRanked.provenance
    const consensusByIndex = consensusRanked.consensusByIndex
    const highConsensusCount = consensusByIndex.filter((c) => c >= 2).length
    if (consensusVerdict.findings.length > 0) {
      console.log(JSON.stringify({
        event: "pr-review-consensus-rerank",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        finding_count: consensusVerdict.findings.length,
        high_consensus_count: highConsensusCount,
        max_consensus: consensusByIndex.reduce((m, c) => Math.max(m, c), 0),
      }))
    }

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
    const claimShadowMode = resolveClaimShadowMode(env.OPENCLAW_REVIEW_MEMORY_CLAIM_SHADOW)
    // `reviewMemoryConfig` is scoped to the review-memory injection block
    // above; re-resolve the per-repo bool here (pure + cheap) from the
    // function-scoped sigilixConfig.
    const softenActive = isSoftenActive(
      claimShadowMode,
      resolveReviewMemoryConfig(sigilixConfig).claimSoftening,
    )
    const claimsEnabled = env.OPENCLAW_REVIEW_MEMORY_CLAIMS === "on"

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
    const { kept: postWithdrawalFindings, suppressed: withdrawnFindings } =
      filterWithdrawnFindings(renderableFindings, withdrawals)
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
    const keptRefSet = new Set(postWithdrawalFindings)
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
      postWithdrawalFindings.length + renderableUnanchored.length > 0
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
      findings: postWithdrawalFindings,
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
    const reviewIncomplete =
      degradedCoverage !== null || synthConfidence <= LOW_CONFIDENCE_COMMENT_THRESHOLD
    const reviewEventOverride: ReviewEventOverride | undefined =
      approvalReadiness.blockers.length > 0
        ? "REQUEST_CHANGES"
        : reviewIncomplete
          ? "COMMENT"
          : undefined
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
    const trustLedgerMode = parseTrustLedgerMode(env.OPENCLAW_TRUST_LEDGER)
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
        })
      }
      return finalize(telemetry, env, "errored", cache)
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

    // SIG Trust Ledger v0 (thread + measure, INERT): give every final visible
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
    // so `off` (default) is a true no-op. NO render — production renderers ignore
    // `finding.trust` until the PR3 render wiring.
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

    const submissionBuild = buildReviewSubmissionWithMetadata({
      verdict: submissionVerdict,
      prAuthor: meta.user?.login ?? null,
      headSha,
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
    })
    const submission = submissionBuild.submission
    const bodyOnlyAnnotations = submissionBuild.bodyOnlyAnnotations
    const allFindingAnnotations = buildBodyOnlyCheckAnnotations([
      ...submissionVerdict.findings,
      ...renderableUnanchoredForSubmission,
    ])
    const checkAnnotationMeta = (annotations: CheckRunAnnotation[]) =>
      annotations.length > 0 ? { checkAnnotations: annotations } : {}

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
        return finalize(telemetry, env, "errored", cache)
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
            ...checkAnnotationMeta(allFindingAnnotations),
          })
        }
        // Comment fallback ALSO failed — `errored` is the truth.
        return finalize(telemetry, env, "errored", cache)
      }
      await primaryAffordance.persistReviewCounter()
      telemetry.submitted = true
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
        ...checkAnnotationMeta(bodyOnlyAnnotations),
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
            ...checkAnnotationMeta(allFindingAnnotations),
          })
        }
        return finalize(telemetry, env, "errored", cache)
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
    return finalize(telemetry, env, "errored", cache)
  } finally {
    clearTimeout(orchTimer)
    // ARC-283 Phase B1b — shadow comparison emit. Runs on EVERY
    // return path (success, skip-notice bail, outer-catch
    // internal_error). When shadow was disabled the maps stay empty
    // and this block is a zero-cost no-op. Each await is individually
    // try/wrap'd — a shadow-side crash MUST NOT take down the prod
    // return value the function already produced.
    //
    // ARC-283 review pass: a pathologically slow shadow can no longer
    // hold the queue consumer past the 900s CF Queues ceiling. Each
    // shadow await is raced against `shadowDeadline` (finally-start +
    // SHADOW_FINALIZE_GRACE_MS). On grace expiry we emit
    // `shadow-cut-short` and skip the comparison emit for that role.
    const finallyStartMs = Date.now()
    const shadowDeadline = finallyStartMs + SHADOW_FINALIZE_GRACE_MS
    if (shadowSpecialistPromises.size > 0) {
      for (const [role, shadowPromise] of shadowSpecialistPromises) {
        try {
          // Shadow comparison is per-role + must serialize on the
          // same wall-clock; each await independently catches its own
          // failure so an early role error can't poison the rest. The
          // grace race shares one absolute deadline across all roles,
          // so a slow first role can't starve the others.
          const shadow = await raceWithShadowGrace(
            shadowPromise,
            shadowDeadline,
            orchCtrl.signal,
          )
          if (shadow === SHADOW_GRACE_EXPIRED) {
            // ARC-283 Phase B1b CR-2: abort the in-flight shadow
            // request BEFORE emitting the telemetry, so the underlying
            // HTTP call actually stops consuming provider capacity.
            // The controller is only present when the runner hasn't
            // settled yet (the .finally() in the dispatch site clears
            // it on settle).
            const reason: "grace_deadline" | "orch_aborted" =
              orchCtrl.signal.aborted ? "orch_aborted" : "grace_deadline"
            const ctrl = shadowAbortControllers.get(role)
            if (ctrl && !ctrl.signal.aborted) ctrl.abort(reason)
            emitShadowCutShort(perfCtx, {
              role,
              elapsedAtCutMs: Date.now() - finallyStartMs,
              reason,
            })
            continue
          }
          if (isShadowRunFailed(shadow)) {
            // ARC-283 Phase B1b CR-1: shadow runner crashed outside
            // its own catch. Emit the dedicated `shadow-run-failed`
            // event so dashboards distinguish a runner crash from a
            // grace-deadline cut. Abort any controller that's still
            // around (defensive — the .finally() should have cleared
            // it already since the promise settled).
            const ctrl = shadowAbortControllers.get(role)
            if (ctrl && !ctrl.signal.aborted) ctrl.abort("run_failed")
            emitShadowRunFailed(perfCtx, { role, message: shadow.message })
            continue
          }
          const prodSnapshot = prodSpecialistSnapshots.get(role)
          // When the prod path errored before the fan-out settled
          // (orchestrator caught an exception inside try{} before
          // `collectSpecialistVerdicts` ran), there's no prod
          // snapshot. Build a synthetic "prod did not run" entry so
          // the comparison still emits — operators can pivot on
          // `prodVerdictOk === false && prodAttemptsUsed === 0` to
          // filter these out of the bake-off analysis.
          const prod = prodSnapshot ?? {
            verdictOk: false,
            modelUsed: SPECIALIST_CONFIGS[role].primary,
            attemptsUsed: 0,
            elapsedMs: 0,
            findings: [] as readonly FindingForOverlap[],
          }
          const comparison = buildShadowVerdictComparison({
            role,
            prodModelDefault: SPECIALIST_CONFIGS[role].primary,
            prod,
            shadow: {
              verdictOk: shadow.verdictOk,
              modelUsed: shadow.modelUsed,
              attemptsUsed: shadow.attemptsUsed,
              elapsedMs: shadow.elapsedMs,
              findings: shadow.findings,
              ...(shadow.failureReason !== undefined
                ? { failureReason: shadow.failureReason }
                : {}),
            },
          })
          emitShadowVerdictComparison(perfCtx, comparison)
        } catch (err) {
          // Defensive: a shadow-side crash (shouldn't happen — the
          // runner catches every failure path internally) must NOT
          // corrupt the prod return value the function already
          // produced. Surface as a structured event for CF Logs
          // mirroring the Task-4 `model-attempt-emit-error` shape.
          console.warn(JSON.stringify({
            event: "shadow-specialist-emit-error",
            owner, repo, prNumber,
            headSha: headSha.slice(0, 7),
            role,
            message: err instanceof Error ? err.message : String(err),
          }))
        }
      }
    }
    if (shadowSynthPromise !== null) {
      try {
        const shadow = await raceWithShadowGrace(
          shadowSynthPromise,
          shadowDeadline,
          orchCtrl.signal,
        )
        if (shadow === SHADOW_GRACE_EXPIRED) {
          // ARC-283 Phase B1b CR-2: cancel in-flight synth before
          // emitting telemetry so the HTTP request actually stops.
          const reason: "grace_deadline" | "orch_aborted" =
            orchCtrl.signal.aborted ? "orch_aborted" : "grace_deadline"
          const ctrl = shadowAbortControllers.get("synth")
          if (ctrl && !ctrl.signal.aborted) ctrl.abort(reason)
          emitShadowCutShort(perfCtx, {
            role: "synth",
            elapsedAtCutMs: Date.now() - finallyStartMs,
            reason,
          })
        } else if (isShadowRunFailed(shadow)) {
          // ARC-283 Phase B1b CR-1: shadow synth runner crashed.
          // Emit the dedicated `shadow-run-failed` event.
          const ctrl = shadowAbortControllers.get("synth")
          if (ctrl && !ctrl.signal.aborted) ctrl.abort("run_failed")
          emitShadowRunFailed(perfCtx, { role: "synth", message: shadow.message })
        } else {
          // Build the prod synth snapshot from telemetry.synthesizer.
          // Every exit path that runs the synth populates this field;
          // the only case where it's null is the outer-catch path that
          // fired BEFORE the inner synth try ran. In that case prod
          // never produced any synth output — same synthetic "prod
          // did not run" shape as the specialist branch above.
          const prodSynthTel = telemetry.synthesizer
          const prodSynthFindings: FindingForOverlap[] = prodSynthTel?.verdict
            ? prodSynthTel.verdict.findings.map((f) => ({
                path: f.path,
                line: f.line,
                category: f.category,
                score: f.score,
              }))
            : []
          const prod: ProdSpecialistSnapshot = {
            verdictOk: prodSynthTel?.verdict != null,
            modelUsed: prodSynthTel?.modelUsed ?? SYNTHESIZER_CONFIG.primary,
            attemptsUsed: prodSynthTel?.attemptsUsed ?? 0,
            elapsedMs: prodSynthTel?.elapsedMs ?? 0,
            findings: prodSynthFindings,
          }
          const comparison = buildShadowVerdictComparison({
            role: "synth",
            prodModelDefault: SYNTHESIZER_CONFIG.primary,
            prod,
            shadow: {
              verdictOk: shadow.verdictOk,
              modelUsed: shadow.modelUsed,
              attemptsUsed: shadow.attemptsUsed,
              elapsedMs: shadow.elapsedMs,
              findings: shadow.findings,
              ...(shadow.failureReason !== undefined
                ? { failureReason: shadow.failureReason }
                : {}),
            },
          })
          emitShadowVerdictComparison(perfCtx, comparison)
        }
      } catch (err) {
        // Same defensive shape as the specialist branch above.
        console.warn(JSON.stringify({
          event: "shadow-synth-emit-error",
          owner, repo, prNumber,
          headSha: headSha.slice(0, 7),
          message: err instanceof Error ? err.message : String(err),
        }))
      }
    }
  }
}

// ─── ARC-184 manifest helper ──────────────────────────────────────────

/**
 * Best-effort write of the review-provenance manifest from the
 * ensemble post-mode submit paths. Captures the full manifest shape
 * required by Linear AC #1 (head/base/merge-base SHAs, file-list hash,
 * prompt version, model id, target id). KV write failures degrade
 * gracefully — never block the review flow.
 *
 * Skipped when the kill-switch is set: `OPENCLAW_REVIEW_MANIFEST_ENABLED=off`.
 */
async function writeReviewManifestForEnsemble(args: {
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  headSha: string
  baseSha: string
  modelId: string
  reviewId: number
  /** ARC-271: per-finding snapshot for the next push's delta
   *  computation. Optional — when absent or empty, the manifest
   *  omits the `findings` field and the next review surfaces no
   *  delta (e.g., the review had zero findings to record). */
  findings?: ReviewManifestFinding[]
}): Promise<void> {
  const { env, client, owner, repo, prNumber, headSha, baseSha, modelId, reviewId, findings } = args
  if (env.OPENCLAW_REVIEW_MANIFEST_ENABLED === "off") return
  try {
    const [files, mergeBaseSha] = await Promise.all([
      client.listPullFilesForManifest(owner, repo, prNumber),
      baseSha ? client.getMergeBase(owner, repo, baseSha, headSha) : Promise.resolve(null),
    ])
    const fileListHash = await computeFileListHash(files)
    const manifest: ReviewManifestV1 = {
      v: 1,
      prNumber,
      baseSha,
      headSha,
      mergeBaseSha,
      fileListHash,
      promptVersion: PROMPT_VERSION,
      modelId,
      target: { kind: "review", reviewId },
      reviewedAt: Date.now(),
      // CodeRabbit MAJOR catch on PR #83: include `findings` whenever
      // the caller passed an array (even empty), so "previous review
      // had zero findings" is distinguishable from "no ARC-271
      // snapshot exists". The next push reads the empty array and
      // correctly classifies all current findings as `new`.
      ...(findings !== undefined ? { findings } : {}),
    }
    const ok = await writeReviewManifest(env, owner, repo, prNumber, manifest)
    if (ok) {
      console.log(JSON.stringify({
        event: "review-manifest-written",
        owner, repo, prNumber,
        headSha, baseSha, modelId,
        promptVersion: PROMPT_VERSION,
        target: { kind: "review", id: reviewId },
      }))
    } else {
      console.error(JSON.stringify({
        event: "review-manifest-write-failed",
        owner, repo, prNumber,
        err: "writeReviewManifest returned false",
      }))
    }
  } catch (err) {
    console.error(JSON.stringify({
      event: "review-manifest-write-failed",
      owner, repo, prNumber,
      err: err instanceof Error ? err.message : String(err),
    }))
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

/**
 * Max model invocations one ensemble run can possibly consume.
 * Derived from SPECIALIST_CONFIGS + SYNTHESIZER_CONFIG (CR PR #37
 * catch: hard-coded 5 was wrong because retries + fallbacks can push
 * a single run to ~16 calls).
 *
 * Per role: (1 primary attempt) + (config.retries) + (1 fallback if set)
 * Sum across all 4 specialists + synth.
 *
 * Used at admission time to reserve worst-case budget so we don't
 * admit a PR we might overflow. Actual spend at finalize() comes
 * from each role's `attemptsUsed`, not from this constant.
 */
function maxAttempts(config: ModelConfig): number {
  return 1 + config.retries + (config.fallback ? 1 : 0)
}
export const MAX_CALLS_PER_ENSEMBLE_RUN = (
  maxAttempts(SPECIALIST_CONFIGS.logic)
  + maxAttempts(SPECIALIST_CONFIGS.security)
  + maxAttempts(SPECIALIST_CONFIGS.performance)
  + maxAttempts(SPECIALIST_CONFIGS.tests)
  // ARC-278 (CR catch on PR #91): reserve TWO synth budgets, not
  // one. The retry path can fire a second `runSynthesizer` call
  // (itself primary + retry + cross-provider fallback). Without
  // this, a worst-case PR can spend up to N + maxAttempts(SYNTH)
  // extra and overshoot the daily cap.
  + (2 * maxAttempts(SYNTHESIZER_CONFIG))
)

// ARC-280: `dailyBudgetAvailable` was the budget-gate `routeReview`
// called before admitting a PR; with `routeReview` deleted and the
// dispatcher calling `handlePrReviewEnsemble` directly, the
// admission check no longer fires. `incrementDailyBudget` still
// runs in `finalize()` so the per-day cumulative count is recorded
// for telemetry / future-policy use. A hard cap that bails the
// ensemble early on budget exhaustion is a separate follow-up.

async function incrementDailyBudget(env: Env, by: number): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  const key = `ensemble-budget:${today}`
  const raw = await env.OPENCLAW_STATE.get(key)
  const used = raw ? Number.parseInt(raw, 10) : 0
  await env.OPENCLAW_STATE.put(key, String(used + by), { expirationTtl: 48 * 60 * 60 })
}

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  // Arc PR #35 catch: `parsed > 0` made the `cap <= 0` guard in
  // dailyBudgetAvailable() dead code — operators setting
  // OPENCLAW_ENSEMBLE_DAILY_BUDGET=0 silently got the default (200)
  // instead of disabling ensemble. Allow 0 to propagate.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function countLines(diff: string): number {
  let n = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) n++
    else if (line.startsWith("-") && !line.startsWith("---")) n++
  }
  return n
}

/**
 * SIG-216: bucket a finding's score (1-5) into the same P0/P1/P2/P3
 * severity tiers the review body uses (`severityBadgeImg` in
 * `triage-pr-review.ts`) so the overview prompt and the review body
 * speak the same language. Pure.
 */
function severityTier(score: number): "P0" | "P1" | "P2" | "P3" {
  if (score >= 5) return "P0"
  if (score === 4) return "P1"
  if (score === 3) return "P2"
  return "P3"
}

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

/** Single-page cap on `listPullRequestReviews`. Reviews are returned
 *  in ASC (oldest-first) submission order, so a freshly-posted review
 *  sits at the END of the list — meaning a >=100-review PR pushes our
 *  just-submitted review off page 1. Treat the cap as inconclusive
 *  rather than flipping a real submit to `not_persisted`. */
const REVIEW_LIST_PAGE_CAP = 100

/**
 * ARC-258 follow-up (PR #84 anomaly, refined after PR #86): after
 * `submitReview` returns a 2xx, verify the review is actually
 * visible publicly. The Check Run reflects whatever the ensemble
 * returns — a fake-looking 2xx whose review never appears in the
 * Reviews tab would otherwise produce a green "Review posted"
 * check with no review behind it.
 *
 * PR #86 observation: `getReview(id)` is fetch-by-id and returns
 * the review object even when GitHub has left it in `PENDING`
 * (draft) state — invisible to anyone but the App that authored
 * it. The public list endpoint (`listPullRequestReviews`) filters
 * `PENDING` rows out, which mirrors what's actually visible in
 * the Reviews tab. The earlier 404-only verify missed the silent-
 * success case it was built to catch. We now use the list endpoint
 * and require the row to be present AND in a published state
 * (anything but `PENDING`).
 *
 * Cap handling (code-review on this PR): the list endpoint has no
 * `direction` parameter and returns ASC. With `per_page=100`
 * single-page, a PR with >=100 prior reviews pushes our just-
 * submitted review off page 1 and verify would wrongly flip a
 * legitimate submit to `errored`. When the list returns the page
 * cap, default to `true` (inconclusive → assume persisted) and
 * emit `pr-review-verify-list-capped` so we notice when this
 * actually fires.
 *
 * Returns:
 *   - `true` when the review id appears in the public list with a
 *     non-`PENDING` state.
 *   - `true` defensively when the list returns the page cap
 *     (`REVIEW_LIST_PAGE_CAP`) and the row isn't on page 1 — we
 *     can't tell from one page whether the review is missing or
 *     just paginated. Inconclusive → assume persisted.
 *   - `false` when it's absent from the (non-capped) list OR
 *     present but in `PENDING` (silently rejected by GitHub).
 *   - `true` defensively on any GET error — a transient blip on
 *     the verify path should NOT mark a real submit as errored.
 *
 * `submitPath` is the dispatcher-side label of which submit path
 * called us (`inline-anchored` / `anchorless-fallback` / `phase3`).
 * It flows into the verify-side telemetry so log analysis can
 * slice missing/pending rates per path without joining records.
 */
async function verifyReviewPersisted(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
  reviewId: number,
  submitPath: string,
  submittedState: string,
): Promise<boolean> {
  try {
    const list = await client.listPullRequestReviews(owner, repo, prNumber)
    const found = list.find((r) => r.id === reviewId)
    if (found) {
      if (found.state === "PENDING") {
        console.warn(JSON.stringify({
          event: "pr-review-verify-pending",
          owner, repo, prNumber, review_id: reviewId,
          submit_path: submitPath,
          submitted_state: submittedState,
        }))
        return false
      }
      return true
    }
    // Not on page 1. If the list hit the per-page cap we can't
    // tell missing-from-everywhere apart from on-a-later-page;
    // assume persisted and emit a distinct event so we notice.
    if (list.length >= REVIEW_LIST_PAGE_CAP) {
      console.warn(JSON.stringify({
        event: "pr-review-verify-list-capped",
        owner, repo, prNumber, review_id: reviewId,
        submit_path: submitPath,
        list_size: list.length,
        note: "listPullRequestReviews returned page cap; cannot confirm review present, defaulting to verified=true.",
      }))
      return true
    }
    console.warn(JSON.stringify({
      event: "pr-review-verify-missing",
      owner, repo, prNumber, review_id: reviewId,
      submit_path: submitPath,
      submitted_state: submittedState,
      list_size: list.length,
    }))
    return false
  } catch (err) {
    // Network blip / transient 5xx — we'd rather false-positive a
    // posted review than false-negative one that actually exists.
    // The Check Run's `success` conclusion stays; if the review
    // genuinely didn't post, the customer will notice and we can
    // grep telemetry for `pr-review-verify-error`.
    console.warn(JSON.stringify({
      event: "pr-review-verify-error",
      owner, repo, prNumber, review_id: reviewId,
      submit_path: submitPath,
      err: err instanceof Error ? err.message : String(err),
    }))
    return true
  }
}

async function buildClient(env: Env, installationId: number): Promise<GitHubClient> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY required")
  }
  const token = await getInstallationToken({
    kv: env.OPENCLAW_STATE,
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
    installationId,
  })
  return new GitHubClient({ token })
}

// ─── specialist runner ────────────────────────────────────────────────

/**
 * @internal Exported for ARC-283 tests + shadow runner only. Do not
 * call from prod code paths other than `handlePrReviewEnsemble` and
 * `src/lib/shadow-bakeoff-runner.ts`.
 */
export interface SpecialistRunArgs {
  role: SpecialistRole
  apiKey: string | undefined
  systemPrompt: string
  initialMessage: string
  chatEnabled: "on" | "off"
  signal: AbortSignal
  /**
   * ARC-283 Phase B1b: correlation context for emitting
   * `model-attempt-completed` per retry/fallback attempt. Threaded
   * through from the orchestrator's `perfCtx` so the per-attempt
   * event carries the same {owner, repo, prNumber, headSha} as the
   * surrounding `phase-completed` + `specialist-fanout-summary`
   * events for downstream correlation.
   */
  perfCtx: EnsembleRunCtx
}

interface SpecialistRunResult {
  verdict: PrReviewVerdict | null
  failureReason?: string
  failureRawAnswer?: string
  elapsedMs: number
  /** Which model actually produced the verdict (or last attempted on failure).
   *  Differs from SPECIALIST_MODELS[role] when fallback fired. */
  modelUsed: string
  /** Total model invocations across primary retries + fallback. */
  attemptsUsed: number
}

/**
 * @internal Exported for ARC-283 tests + shadow runner only. Do not
 * call from prod code paths other than `handlePrReviewEnsemble` and
 * `src/lib/shadow-bakeoff-runner.ts`.
 */
export async function runSpecialist(args: SpecialistRunArgs): Promise<SpecialistRunResult> {
  const t0 = Date.now()
  if (!args.apiKey) {
    return {
      verdict: null,
      failureReason: "missing_api_key",
      elapsedMs: 0,
      modelUsed: SPECIALIST_CONFIGS[args.role].primary,
      attemptsUsed: 0,
    }
  }
  const messages: ChatMessage[] = [
    { role: "system", content: args.systemPrompt },
    { role: "user", content: args.initialMessage },
  ]
  const config = SPECIALIST_CONFIGS[args.role]
  return runWithRetryAndFallback({
    config,
    apiKey: args.apiKey,
    messages,
    signal: args.signal,
    chatEnabled: args.chatEnabled,
    format: PR_REVIEW_SCHEMA as unknown as Record<string, unknown>,
    parseAnswer: parsePrReviewResponse,
    parseFailureLabel: "specialist_did_not_parse",
    startedAt: t0,
    // SIG-236: honor a per-role per-attempt cap (logic = 110s; its prompt is
    // ~8.4k tok and needs >60s). Omitted for the other roles → the runner
    // falls back to PER_ATTEMPT_TIMEOUT_MS, so their behavior is unchanged.
    // (Conditional spread, not `: undefined`, under exactOptionalPropertyTypes.)
    ...(config.perAttemptTimeoutMs !== undefined
      ? { perAttemptTimeoutMs: config.perAttemptTimeoutMs }
      : {}),
    // ARC-283 Phase B1b: emit `model-attempt-completed` per attempt.
    // Bucket attempts into primary/retry/fallback by attemptIndex:
    //   1                  → primary
    //   2..(retries + 1)   → retry
    //   (retries + 2)      → fallback (only fires when config.fallback
    //                         is set; runWithRetryAndFallback skips it
    //                         when fallback is null).
    onAttempt: (info) => {
      try {
        const attemptKind = info.attemptIndex === 1
          ? "primary"
          : info.attemptIndex <= config.retries + 1
            ? "retry"
            : "fallback"
        const outcome = info.verdictOk
          ? "ok"
          : (info.failureReason ?? "").includes("timeout")
            ? "timeout"
            : (info.failureReason ?? "").toLowerCase().includes("abort")
              ? "aborted"
              : "failed"
        emitModelAttempt(args.perfCtx, {
          phase: "specialist",
          role: args.role,
          attemptKind,
          attemptIndex: info.attemptIndex,
          model: info.model,
          timeoutMs: info.timeoutMs,
          startedAtMs: info.startedAtMs,
          endedAtMs: info.endedAtMs,
          elapsedMs: info.endedAtMs - info.startedAtMs,
          outcome,
          ...(info.failureReason !== undefined ? { failureReason: info.failureReason } : {}),
          // SIG-212: forward token usage from runWithRetryAndFallback.
          ...(info.inputTokens !== undefined ? { inputTokens: info.inputTokens } : {}),
          ...(info.outputTokens !== undefined ? { outputTokens: info.outputTokens } : {}),
        })
      } catch (err) {
        // ARC-283 B1b (code-review BLOCKING): telemetry callback throw
        // must not corrupt the verdict path. `runSpecialist` runs inside
        // Promise.allSettled — an uncaught throw here converts a valid
        // specialist verdict into a rejected entry, dropping coverage.
        // Surface the failure as a structured event for CF Logs; don't
        // re-throw.
        console.log(JSON.stringify({
          event: "model-attempt-emit-error",
          owner: args.perfCtx.owner,
          repo: args.perfCtx.repo,
          prNumber: args.perfCtx.prNumber,
          headSha: args.perfCtx.headSha.slice(0, 7),
          phase: "specialist",
          role: args.role,
          message: err instanceof Error ? err.message : String(err),
        }))
      }
    },
  })
}

/**
 * Run a chat call with retry + cross-provider fallback. Used by both
 * specialist and synthesizer paths to centralize the retry policy
 * (added post-shadow-mode telemetry; original v3.1 spec disabled
 * retries for cost reasons but capacity 503s on frontier models made
 * that untenable for the logic specialist specifically).
 *
 * Sequence:
 *   1. Try primary (attempt 1)
 *   2. If retryable failure (503/429/network/abort-not-from-orch) AND
 *      retries remaining → backoff + retry (attempts 2..N+1)
 *   3. If primary exhausted AND fallback configured → try fallback once
 *   4. Return final outcome (success OR last failure)
 *
 * Parse failures are NOT retried — they indicate a model output
 * problem, not a capacity problem; retrying the same prompt at
 * temperature 0 will yield the same bad output.
 */
export interface AttemptCallbackInfo {
  /** 1-indexed across the entire retry+fallback chain (primary
   *  attempt 1, retry attempts 2..N+1, fallback attempt N+2). */
  attemptIndex: number
  model: string
  timeoutMs: number
  startedAtMs: number
  endedAtMs: number
  verdictOk: boolean
  /** Present when verdictOk=false. Same free-form string
   *  `runWithRetryAndFallback` returns as its top-level
   *  `failureReason` for the final outcome. */
  failureReason?: string
  /** SIG-212: token usage reported by the underlying `chat()` call.
   *  Present whenever the LLM round-trip completed (success OR parse-
   *  failure — the model still consumed tokens producing the unparseable
   *  output). Absent on exception paths (HTTP error, timeout, abort)
   *  where no tokens were exchanged. */
  inputTokens?: number
  outputTokens?: number
}

export async function runWithRetryAndFallback<T>(args: {
  config: ModelConfig
  apiKey: string
  messages: ChatMessage[]
  signal: AbortSignal
  chatEnabled: "on" | "off"
  format: Record<string, unknown> | undefined
  parseAnswer: (content: string) => T | null
  parseFailureLabel: string
  startedAt: number
  /**
   * Phase 4a.4 (ARC-175): per-attempt timeout cap. Each individual
   * `attemptChat` call aborts after this many ms so a single slow
   * primary can't eat the entire `SPECIALIST_TIMEOUT_MS` budget.
   * Defaults to `PER_ATTEMPT_TIMEOUT_MS` (60s) — tests pass a smaller
   * value to exercise the abort path without real-time waits. The logic
   * role overrides this to 240s (SIG-287) via its `ModelConfig`.
   */
  perAttemptTimeoutMs?: number
  /**
   * ARC-283 Phase B1b: optional per-attempt observer. Fires AFTER
   * each settled attempt (primary, retry, OR fallback), on BOTH
   * success and failure branches, BEFORE the next iteration. The
   * shadow runner uses this to emit `shadow-model-attempt-completed`;
   * the prod path uses it (wired in `runSpecialist`/`runSynthesizer`)
   * to emit `model-attempt-completed`.
   *
   * `runWithRetryAndFallback` itself does NOT wrap the callback in
   * try/catch — callers own that decision. The prod-path callers
   * (`runSpecialist`/`runSynthesizer`) DO wrap because their
   * runSpecialist/runSynthesizer call is inside `Promise.allSettled`
   * (or `attemptSynth`'s catch) where an emit-throw would silently
   * discard a valid verdict. The shadow runner deliberately leaves
   * its callback bare — shadow-mode telemetry failures should be
   * loud, not papered over.
   */
  onAttempt?: (info: AttemptCallbackInfo) => void
}): Promise<{
  verdict: T | null
  failureReason?: string
  failureRawAnswer?: string
  elapsedMs: number
  modelUsed: string
  attemptsUsed: number
}> {
  const { config, apiKey, messages, signal, chatEnabled, format, parseAnswer, parseFailureLabel, startedAt } = args
  const perAttemptCap = args.perAttemptTimeoutMs ?? PER_ATTEMPT_TIMEOUT_MS

  let attemptsUsed = 0
  let lastFailureReason: string | undefined
  let lastFailureRaw: string | undefined

  // Try primary with retries
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    if (signal.aborted) {
      return wrapFailure("aborted", undefined, config.primary, attemptsUsed, startedAt)
    }
    if (attempt > 0) {
      // Backoff before retry
      const delay = RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] ?? 0
      await sleepWithSignal(delay, signal)
      if (signal.aborted) {
        return wrapFailure("aborted", undefined, config.primary, attemptsUsed, startedAt)
      }
    }
    attemptsUsed++
    // ARC-283 (B1b): mark per-attempt wall-clock start BEFORE the
    // composed-timeout wrapper so the onAttempt observer gets the
    // true span (including any time spent inside attemptChat's
    // setup, not just chat()'s round-trip).
    const attemptStartMs = Date.now()
    // Phase 4a.4: per-attempt cap. attemptChat already returns a
    // structured failure on AbortError (its inner try/catch catches
    // chat()'s thrown abort), so withComposedTimeout's grace path
    // observes a settled `{verdict: null, failureReason: ...}` and
    // returns it cleanly — no extra throw/catch needed here.
    const outcome = await withComposedTimeout(
      (perAttemptSignal) => attemptChat({
        model: config.primary, apiKey, messages, signal: perAttemptSignal,
        chatEnabled, format, parseAnswer, parseFailureLabel,
      }),
      perAttemptCap,
      signal,
    )
    // ARC-283 (B1b): emit onAttempt on BOTH success and failure
    // branches of the primary/retry loop. Fires before the early
    // `return` below so the observer sees every settled call.
    args.onAttempt?.({
      attemptIndex: attemptsUsed,
      model: config.primary,
      timeoutMs: perAttemptCap,
      startedAtMs: attemptStartMs,
      endedAtMs: Date.now(),
      verdictOk: outcome.verdict !== null,
      ...(outcome.failureReason !== undefined ? { failureReason: outcome.failureReason } : {}),
      // SIG-212: forward token usage from attemptChat. Present on
      // both success and parse-failure; absent on HTTP/timeout/abort.
      ...(outcome.inputTokens !== undefined ? { inputTokens: outcome.inputTokens } : {}),
      ...(outcome.outputTokens !== undefined ? { outputTokens: outcome.outputTokens } : {}),
    })
    if (outcome.verdict !== null) {
      return {
        verdict: outcome.verdict,
        elapsedMs: Date.now() - startedAt,
        modelUsed: config.primary,
        attemptsUsed,
      }
    }
    lastFailureReason = outcome.failureReason
    lastFailureRaw = outcome.failureRawAnswer
    // Failure classification:
    //
    //   Permanent (404 missing-model, 401/403 auth, 400 validation,
    //   parse failure) → don't retry primary (same prompt → same error).
    //   But DO try the cross-provider fallback (arc PR #37 catch): a
    //   404 on deepseek-v4-pro says nothing about whether kimi-k2.5
    //   exists — they're different providers entirely. Same for parse
    //   failures: a different model may format output correctly. So
    //   `break` out of the retry loop to skip ahead to fallback.
    //
    //   Transient (5xx upstream-overload, 429 rate-limited, network
    //   errors, timeout) → keep retrying primary; backoff helps. Fall
    //   back if all retries exhausted.
    if (isPermanentFailure(outcome.failureReason, parseFailureLabel)) {
      break
    }
  }

  // Primary exhausted (either retries used up on transient errors, OR
  // primary hit a permanent failure and broke early). In BOTH cases
  // try the cross-provider fallback before giving up — fallback runs
  // on different infra and may succeed where primary couldn't.
  if (config.fallback && !signal.aborted) {
    const fallbackModel = config.fallback
    attemptsUsed++
    // ARC-283 (B1b): mirror the primary-loop start mark so the
    // fallback attempt also gets a true wall-clock span on the
    // onAttempt observer.
    const attemptStartMs = Date.now()
    // Phase 4a.4: same per-attempt cap on the fallback. The fallback
    // gets one shot — capped — so even if the cross-provider model is
    // also slow, the overall specialist run finishes within budget.
    const outcome = await withComposedTimeout(
      (perAttemptSignal) => attemptChat({
        model: fallbackModel, apiKey, messages, signal: perAttemptSignal,
        chatEnabled, format, parseAnswer, parseFailureLabel,
      }),
      perAttemptCap,
      signal,
    )
    // ARC-283 (B1b): emit onAttempt for the fallback as well, on
    // BOTH success and failure branches.
    args.onAttempt?.({
      attemptIndex: attemptsUsed,
      model: fallbackModel,
      timeoutMs: perAttemptCap,
      startedAtMs: attemptStartMs,
      endedAtMs: Date.now(),
      verdictOk: outcome.verdict !== null,
      ...(outcome.failureReason !== undefined ? { failureReason: outcome.failureReason } : {}),
      // SIG-212: forward token usage on the fallback path too.
      ...(outcome.inputTokens !== undefined ? { inputTokens: outcome.inputTokens } : {}),
      ...(outcome.outputTokens !== undefined ? { outputTokens: outcome.outputTokens } : {}),
    })
    if (outcome.verdict !== null) {
      return {
        verdict: outcome.verdict,
        elapsedMs: Date.now() - startedAt,
        modelUsed: config.fallback,
        attemptsUsed,
      }
    }
    // Fallback also failed. Use ITS failure as the reason (more recent + relevant).
    return wrapFailure(
      `fallback_failed: ${outcome.failureReason ?? "unknown"}`,
      outcome.failureRawAnswer,
      config.fallback,
      attemptsUsed,
      startedAt,
    )
  }

  return wrapFailure(lastFailureReason ?? "exhausted_no_fallback", lastFailureRaw, config.primary, attemptsUsed, startedAt)
}

function wrapFailure<T>(
  reason: string,
  rawAnswer: string | undefined,
  modelUsed: string,
  attemptsUsed: number,
  startedAt: number,
): {
  verdict: T | null
  failureReason?: string
  failureRawAnswer?: string
  elapsedMs: number
  modelUsed: string
  attemptsUsed: number
} {
  const out: ReturnType<typeof wrapFailure<T>> = {
    verdict: null,
    elapsedMs: Date.now() - startedAt,
    modelUsed,
    attemptsUsed,
  }
  if (reason) out.failureReason = reason
  if (rawAnswer) out.failureRawAnswer = rawAnswer
  return out
}

async function attemptChat<T>(args: {
  model: string
  apiKey: string
  messages: ChatMessage[]
  signal: AbortSignal
  chatEnabled: "on" | "off"
  format: Record<string, unknown> | undefined
  parseAnswer: (content: string) => T | null
  parseFailureLabel: string
}): Promise<{
  verdict: T | null
  failureReason?: string
  failureRawAnswer?: string
  // SIG-212: usage is present on BOTH success and parse-failure paths
  // (chat() round-trip completed, model consumed tokens producing the
  // output — even if that output didn't parse). Absent on the
  // exception path where no tokens were exchanged.
  inputTokens?: number
  outputTokens?: number
}> {
  try {
    const result = await chat({
      model: args.model,
      messages: args.messages,
      apiKey: args.apiKey,
      signal: args.signal,
      chatEnabled: args.chatEnabled,
      ...(args.format ? { format: args.format } : {}),
      temperature: 0,
    })
    // SIG-212: capture token usage from chat()'s result. Forward on
    // BOTH success and parse-failure paths so cost telemetry stays
    // accurate even when the model produced unparseable output.
    // `usage` is optional on ChatResult to keep test mocks lightweight;
    // the production accumulator always returns `usage: {...}`.
    const usagePayload: { inputTokens?: number; outputTokens?: number } = {}
    if (result.usage?.inputTokens !== undefined) usagePayload.inputTokens = result.usage.inputTokens
    if (result.usage?.outputTokens !== undefined) usagePayload.outputTokens = result.usage.outputTokens
    const verdict = args.parseAnswer(result.message.content)
    if (!verdict) {
      return {
        verdict: null,
        failureReason: args.parseFailureLabel,
        failureRawAnswer: result.message.content.slice(0, 32_000),
        ...usagePayload,
      }
    }
    return { verdict, ...usagePayload }
  } catch (e) {
    return {
      verdict: null,
      failureReason: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * Classify a failure reason as permanent (don't retry, don't fall back)
 * vs transient (retry primary, then try fallback).
 *
 * Permanent reasons (CR PR #37 catch — caller should fast-fail):
 *   - parse failure label (model output didn't parse; same prompt at
 *     temp=0 will keep failing)
 *   - HTTP 4xx (except 429 which is rate-limit + transient)
 *     - 404: phantom model name (same problem hits the fallback path
 *       if config is wrong, but better to fail loud than retry silently)
 *     - 401/403: auth — retrying won't fix it
 *     - 400: validation error in our request
 *   - "missing_api_key", "aborted" (already short-circuited but defensive)
 *
 * Transient reasons (keep retrying / falling back):
 *   - HTTP 5xx (server overload — the original case we built for)
 *   - HTTP 429 (rate limited; backoff helps)
 *   - Network errors, timeouts
 *   - Unknown (fail open — assume transient so we still try fallback)
 *
 * The chat() helper throws errors with messages like
 * `Ollama HTTP <status>: <body>`, so we extract the status code. For
 * non-HTTP failures (network), the message has no status — treat as
 * transient.
 */
export function isPermanentFailure(failureReason: string | undefined, parseFailureLabel: string): boolean {
  if (!failureReason) return false
  if (failureReason === parseFailureLabel) return true
  if (failureReason === "missing_api_key" || failureReason === "aborted") return true
  // Match `Ollama HTTP <status>` or generic `HTTP <status>` patterns
  const httpMatch = failureReason.match(/HTTP\s+(\d{3})/i)
  if (httpMatch && httpMatch[1]) {
    const status = Number.parseInt(httpMatch[1], 10)
    if (status === 429) return false  // rate-limited = transient
    if (status >= 400 && status < 500) return true  // other 4xx = permanent
  }
  return false
}

async function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  // CR + arc PR #37 catch: if the signal is already aborted on entry,
  // the abort event has already fired and our addEventListener will
  // never trigger — without this guard we'd sleep the full ms before
  // returning. Closes the race between caller's abort check + our
  // listener installation.
  if (ms <= 0 || signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

// ─── synthesizer runner ───────────────────────────────────────────────

/**
 * @internal Exported for ARC-283 tests + shadow runner only. Do not
 * call from prod code paths other than `handlePrReviewEnsemble` and
 * `src/lib/shadow-bakeoff-runner.ts`.
 */
export interface SynthesizerRunArgs {
  apiKey: string | undefined
  systemPrompt: string
  userMessage: string
  chatEnabled: "on" | "off"
  signal: AbortSignal
  /**
   * ARC-185: per-PR synthesizer config override sourced from
   * `commands.review.{model.primary, model.fallbacks}` in
   * `sigilix.json`. When undefined, the runner uses the
   * `SYNTHESIZER_CONFIG` constant (current default behavior).
   *
   * v1 limitation: `ModelConfig.fallback` is a single string; if
   * the user supplies multiple fallbacks, only the first is used at
   * the synth path. The user-facing API still accepts an array (so
   * the schema doesn't churn when we extend the runtime support)
   * but the runtime drops the tail. Telemetry records the count.
   */
  configOverride?: ModelConfig
  /**
   * ARC-283 Phase B1b: correlation context for emitting
   * `model-attempt-completed` per retry/fallback attempt. Same
   * shape + purpose as `SpecialistRunArgs.perfCtx`.
   */
  perfCtx: EnsembleRunCtx
}

interface SynthesizerRunOutput {
  verdict: PrReviewVerdict | null
  provenance: SynthesizerProvenance | null
  failureReason?: string
  failureRawAnswer?: string
  elapsedMs: number
  modelUsed: string
  attemptsUsed: number
}

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

/**
 * Composite type the synth retry path emits — both verdict + provenance
 * are needed for a successful synth, so the runWithRetryAndFallback
 * helper treats this as the parsed-answer shape.
 */
interface SynthParsedOutput {
  verdict: PrReviewVerdict
  provenance: SynthesizerProvenance
}

export function parseSynthAnswer(content: string): SynthParsedOutput | null {
  // Expect `{verdict: PrReviewVerdict, provenance: {...}}`.
  const parsed = parseFirstJsonObject(content)
  if (!parsed) return null
  const verdict = parsePrReviewResponse(JSON.stringify(parsed.verdict))
  if (!verdict) return null
  if (!isValidProvenance(parsed.provenance)) return null
  return { verdict, provenance: parsed.provenance }
}

/**
 * @internal Exported for ARC-283 tests + shadow runner only. Do not
 * call from prod code paths other than `handlePrReviewEnsemble` and
 * `src/lib/shadow-bakeoff-runner.ts`.
 */
export async function runSynthesizer(args: SynthesizerRunArgs): Promise<SynthesizerRunOutput> {
  const t0 = Date.now()
  const effectiveConfig: ModelConfig = args.configOverride ?? SYNTHESIZER_CONFIG
  if (!args.apiKey) {
    return {
      verdict: null,
      provenance: null,
      failureReason: "missing_api_key",
      elapsedMs: 0,
      modelUsed: effectiveConfig.primary,
      attemptsUsed: 0,
    }
  }

  const messages: ChatMessage[] = [
    { role: "system", content: args.systemPrompt },
    { role: "user", content: args.userMessage },
  ]

  // No `format` arg here — synth output is `{verdict, provenance}` which
  // doesn't match PR_REVIEW_SCHEMA shape directly. Tolerated by
  // parseFirstJsonObject + post-validation.
  const outcome = await runWithRetryAndFallback<SynthParsedOutput>({
    config: effectiveConfig,
    apiKey: args.apiKey,
    messages,
    signal: args.signal,
    chatEnabled: args.chatEnabled,
    format: undefined,
    parseAnswer: parseSynthAnswer,
    parseFailureLabel: "synth_failed_parse",
    startedAt: t0,
    // ARC-283 Phase B1b: emit `model-attempt-completed` per attempt.
    // Same attemptKind/outcome bucketing as the specialist path; role
    // is the literal "synth" string (matches the `ModelAttemptPhase`
    // type definition in `ensemble-perf-telemetry.ts`).
    onAttempt: (info) => {
      try {
        const attemptKind = info.attemptIndex === 1
          ? "primary"
          : info.attemptIndex <= effectiveConfig.retries + 1
            ? "retry"
            : "fallback"
        const outcomeLabel = info.verdictOk
          ? "ok"
          : (info.failureReason ?? "").includes("timeout")
            ? "timeout"
            : (info.failureReason ?? "").toLowerCase().includes("abort")
              ? "aborted"
              : "failed"
        emitModelAttempt(args.perfCtx, {
          phase: "synth",
          role: "synth",
          attemptKind,
          attemptIndex: info.attemptIndex,
          model: info.model,
          timeoutMs: info.timeoutMs,
          startedAtMs: info.startedAtMs,
          endedAtMs: info.endedAtMs,
          elapsedMs: info.endedAtMs - info.startedAtMs,
          outcome: outcomeLabel,
          ...(info.failureReason !== undefined ? { failureReason: info.failureReason } : {}),
          // SIG-212: forward token usage on the synth path too.
          ...(info.inputTokens !== undefined ? { inputTokens: info.inputTokens } : {}),
          ...(info.outputTokens !== undefined ? { outputTokens: info.outputTokens } : {}),
        })
      } catch (err) {
        // ARC-283 B1b (code-review BLOCKING): telemetry callback throw
        // must not corrupt the verdict path. `runSynthesizer` is invoked
        // by `attemptSynth` in the orchestrator (which catches throws +
        // returns null → fires the ARC-278 retry → if THAT also throws,
        // synth_timeout skip-notice fires for a valid synth output).
        // Surface the failure as a structured event for CF Logs; don't
        // re-throw.
        console.log(JSON.stringify({
          event: "model-attempt-emit-error",
          owner: args.perfCtx.owner,
          repo: args.perfCtx.repo,
          prNumber: args.perfCtx.prNumber,
          headSha: args.perfCtx.headSha.slice(0, 7),
          phase: "synth",
          role: "synth",
          message: err instanceof Error ? err.message : String(err),
        }))
      }
    },
  })

  if (outcome.verdict) {
    return {
      verdict: outcome.verdict.verdict,
      provenance: outcome.verdict.provenance,
      elapsedMs: outcome.elapsedMs,
      modelUsed: outcome.modelUsed,
      attemptsUsed: outcome.attemptsUsed,
    }
  }

  // Distinguish parse-vs-provenance failures in telemetry. parseSynthAnswer
  // returns null for either case, but we lose the distinction inside the
  // retry helper. Re-parse the raw answer here to label the failure
  // accurately (CR PR #35 catch — telemetry consumers need this split).
  let failureReason = outcome.failureReason ?? "synth_failed_parse"
  if (outcome.failureRawAnswer) {
    const parsed = parseFirstJsonObject(outcome.failureRawAnswer)
    const hasVerdict = parsed && parsePrReviewResponse(JSON.stringify(parsed.verdict))
    if (hasVerdict && !isValidProvenance(parsed?.provenance)) {
      failureReason = "synth_invalid_provenance"
    }
  }

  const result: SynthesizerRunOutput = {
    verdict: null,
    provenance: null,
    elapsedMs: outcome.elapsedMs,
    modelUsed: outcome.modelUsed,
    attemptsUsed: outcome.attemptsUsed,
  }
  if (failureReason) result.failureReason = failureReason
  if (outcome.failureRawAnswer) result.failureRawAnswer = outcome.failureRawAnswer
  return result
}

function isValidProvenance(value: unknown): value is SynthesizerProvenance {
  // CR PR #35 catch: tighten shape check beyond "are findings + dropped
  // arrays?" — without this, a payload like `{findings:[{}], dropped:[]}`
  // passes and validateForSubmission then crashes
  // on `provenance.findings[i].sourceFindingIds.length` (undefined).
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.findings) || !Array.isArray(v.dropped)) {
    return false
  }
  // Each provenance.findings[i] must have an array sourceFindingIds.
  // The hallucination guard in validateForSubmission relies on this.
  for (const f of v.findings) {
    if (!f || typeof f !== "object" || Array.isArray(f)) return false
    const entry = f as Record<string, unknown>
    if (!Array.isArray(entry.sourceFindingIds)) return false
    if (!entry.sourceFindingIds.every((id) => typeof id === "string")) return false
  }
  // dropped entries are looser — they're informational only and never
  // dereferenced into the customer-facing verdict, but still validate
  // for shape stability.
  for (const d of v.dropped) {
    if (!d || typeof d !== "object" || Array.isArray(d)) return false
  }
  // ARC-189: `softened` is OPTIONAL on the wire (synth outputs from
  // pre-v2 prompts omit it). When present, must be an array of
  // object-shaped entries. The renderer dereferences
  // `softened[i].sourceFindingId` to look up the corresponding
  // finding for score-decrement, so we tighten the per-item check
  // to require a string-shaped sourceFindingId — same belt-and-
  // suspenders pattern as the findings.sourceFindingIds[] guard.
  if (v.softened !== undefined) {
    if (!Array.isArray(v.softened)) return false
    for (const s of v.softened) {
      if (!s || typeof s !== "object" || Array.isArray(s)) return false
      const entry = s as Record<string, unknown>
      if (typeof entry.sourceFindingId !== "string") return false
    }
  }
  return true
}

// ─── verdict post-processing ──────────────────────────────────────────

interface CollectedVerdict {
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

interface PrReviewVerdictWithIds extends PrReviewVerdict {
  findings: Array<PrReviewFinding & { id: string }>
}

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

export function assignStableFindingIds(role: SpecialistRole, verdict: PrReviewVerdict): PrReviewVerdictWithIds {
  return {
    ...verdict,
    findings: verdict.findings.map((f, i) => ({ ...f, id: `${role}-${i}` })),
  }
}

/**
 * ARC-270 — consensus-aware ranking of post-synth findings.
 *
 * Re-orders `verdict.findings` (and the parallel `provenance` array)
 * by **`(consensus, score)` DESC** where `consensus = number of
 * distinct specialists that cited the finding via `sourceSpecialists`.
 * Two specialists independently flagging the same line is much
 * stronger signal than one specialist's opinion — surface that
 * agreement at the top, where reviewers will look first.
 *
 * **Why consensus is primary, not score.** A 2-specialist score-2
 * finding ranks above a 1-specialist score-5 finding. This is
 * deliberate: lone-specialist score-5 is the most common LLM
 * over-confidence failure mode, and cross-specialist agreement is
 * exactly the signal that distinguishes "real bug" from "model
 * hallucinated a confident concern". Reversing the keys would put
 * over-confident solo findings at the top.
 *
 * Strictly additive (Codex spec catch): we do NOT change the gate
 * (`chooseReviewEvent`) or drop any findings here. The score values
 * stay untouched. This is a reorder-and-annotate step only.
 *
 * Stable: ties on `(consensus, score)` preserve the synth's emit
 * order (so the synth's logical grouping survives the reorder when
 * there's no consensus signal to leverage).
 *
 * Returns a NEW verdict object + a NEW parallel provenance array +
 * a `consensusByIndex` array aligned with the new ordering. Callers
 * use `consensusByIndex` to render a "Flagged by N specialists"
 * annotation on findings with `consensus >= 2`.
 *
 * Pure — exported for unit tests.
 */
export interface ConsensusRanked {
  verdict: PrReviewVerdict
  provenance: SynthesizerProvenance["findings"]
  /** `consensusByIndex[i]` is the number of distinct specialists for
   *  the finding at NEW index `i`. Always >= 1 (validateForSubmission
   *  drops zero-source findings as hallucinations).
   */
  consensusByIndex: number[]
}

export function computeConsensusRanking(
  verdict: PrReviewVerdict,
  provenance: SynthesizerProvenance["findings"],
): ConsensusRanked {
  // Defensive: provenance.length should equal findings.length post-
  // validateForSubmission. If misaligned, fall back to a no-op
  // (preserve order + emit consensus=1 for all) so we don't
  // accidentally drop findings.
  if (provenance.length !== verdict.findings.length) {
    return {
      verdict,
      provenance,
      consensusByIndex: verdict.findings.map(() => 1),
    }
  }

  const consensusOf = (i: number): number => {
    const specs = provenance[i]?.sourceSpecialists
    if (!Array.isArray(specs) || specs.length === 0) return 1
    return new Set(specs).size
  }

  // Build index permutation. Sort by `(consensus DESC, score DESC,
  // originalIndex ASC)` for stable tiebreaking.
  const order = verdict.findings.map((_, i) => i)
  order.sort((a, b) => {
    const ca = consensusOf(a)
    const cb = consensusOf(b)
    if (cb !== ca) return cb - ca
    const sa = verdict.findings[a]!.score
    const sb = verdict.findings[b]!.score
    if (sb !== sa) return sb - sa
    return a - b
  })

  const newFindings = order.map((i) => verdict.findings[i]!)
  const newProvenance = order.map((i) => provenance[i]!)
  const consensusByIndex = order.map((i) => consensusOf(i))

  return {
    verdict: { ...verdict, findings: newFindings },
    provenance: newProvenance,
    consensusByIndex,
  }
}

/**
 * ARC-270 — annotate a finding's `body` with a "Flagged by N
 * specialists" prefix when consensus >= 2. Returns a CLONE of the
 * finding; never mutates the original (same immutability pattern
 * as the review-memory soften clone in the ensemble flow).
 *
 * For consensus < 2, returns the finding unchanged (no annotation,
 * since a single specialist's opinion is the default expectation).
 *
 * Pure — exported for unit tests.
 */
export function annotateWithConsensus(
  finding: PrReviewFinding,
  consensus: number,
): PrReviewFinding {
  if (consensus < 2) return finding
  const annotation = `_Flagged by ${consensus} specialists._`
  const body = finding.body.length > 0
    ? `${annotation}\n\n${finding.body}`
    : annotation
  return { ...finding, body }
}

// ─── ARC-271 — finding deltas across pushes ──────────────────────────

/**
 * Normalize a headline for stable-key derivation: lowercase, collapse
 * whitespace runs, strip trailing punctuation. Tolerates minor LLM
 * rephrasing across pushes (different casing, extra spaces, optional
 * trailing period). Major rephrasing produces a new key — accepted
 * v1 trade-off (over-report new is safer than silent drop).
 */
function normalizeHeadline(headline: string): string {
  return headline
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?,;:]+$/, "")
}

/**
 * ARC-271 — compute a stable finding key from `(path, headline)`.
 * Pure SHA-256 → first 16 hex chars (64 bits — enough to avoid
 * collisions within a single PR's finding set, which is bounded to
 * MAX_SYNTH_FINDINGS).
 *
 * Exported for unit tests.
 */
export async function computeFindingKey(path: string, headline: string): Promise<string> {
  const input = `${path.toLowerCase()}|${normalizeHeadline(headline)}`
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))
  const bytes = new Uint8Array(buf)
  let hex = ""
  for (let i = 0; i < 8; i++) hex += bytes[i]!.toString(16).padStart(2, "0")
  return hex
}

/**
 * ARC-271 — delta classification result.
 *
 * - `new` — finding has no matching key in the prior manifest.
 * - `stillOpen` — finding's key was also in the prior manifest.
 * - `likelyFixed` — prior finding's key is NOT in current AND the
 *   prior finding's path is in the current PR's changed-file set.
 *   (Path-in-diff implies the file was edited; finding gone → likely
 *   resolved by the edit.)
 * - `carriedOver` — prior finding's key is NOT in current AND the
 *   prior finding's path is NOT in the current PR's changed-file set.
 *   (File untouched since prior review — incremental review didn't
 *   look at it. Finding may still apply but we have no fresh signal.)
 *
 * Codex spec warning: NEVER classify a non-touched-file finding as
 * `fixed`. Incremental review only sends changed-file diffs to
 * specialists, so an old finding for an unchanged file would not
 * reappear in the new run for reasons orthogonal to whether the
 * code was fixed.
 */
export interface FindingDelta {
  newCount: number
  stillOpenCount: number
  likelyFixedCount: number
  carriedOverCount: number
}

/**
 * Compute the delta against the prior manifest's findings. Pure;
 * exported for unit tests.
 */
export function computeFindingDelta(
  currentKeys: ReadonlySet<string>,
  priorFindings: ReadonlyArray<{ key: string; path: string }>,
  changedPaths: ReadonlySet<string>,
): FindingDelta {
  const priorKeys = new Set(priorFindings.map((f) => f.key))
  let newCount = 0
  for (const k of currentKeys) {
    if (!priorKeys.has(k)) newCount += 1
  }
  const stillOpenCount = [...currentKeys].filter((k) => priorKeys.has(k)).length
  // code-reviewer HIGH catch: `computeFindingKey` lowercases path for
  // key derivation (so case-renamed files don't drift). The
  // changed-path lookup must use the same normalization or a prior
  // finding stored as `Src/Foo.ts` won't match `changedPaths`
  // entries like `src/foo.ts` from the diff — falsely landing in
  // `carried-over`. Lowercase both sides of the comparison.
  const changedPathsLower = new Set<string>()
  for (const p of changedPaths) changedPathsLower.add(p.toLowerCase())
  let likelyFixedCount = 0
  let carriedOverCount = 0
  for (const p of priorFindings) {
    if (currentKeys.has(p.key)) continue
    if (changedPathsLower.has(p.path.toLowerCase())) likelyFixedCount += 1
    else carriedOverCount += 1
  }
  return { newCount, stillOpenCount, likelyFixedCount, carriedOverCount }
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

/**
 * ARC-277: pure helper. Given the roles the router DISPATCHED and the
 * roles that actually RETURNED a verdict, compute the symmetric pair
 * the synth prompt block needs. Stable ordering follows
 * `ALL_SPECIALISTS` (logic, security, performance, tests) so two PRs
 * with the same coverage gap produce identical prompt text — easier
 * to grep telemetry by exact prompt-shape hash.
 */
export function computeDegradedCoverage(
  dispatched: readonly SpecialistRole[],
  returned: readonly SpecialistRole[],
): { rolesReturned: SpecialistRole[]; rolesMissing: SpecialistRole[] } {
  const returnedSet = new Set(returned)
  const stable = ALL_SPECIALISTS.filter((r) => dispatched.includes(r))
  return {
    rolesReturned: stable.filter((r) => returnedSet.has(r)),
    rolesMissing: stable.filter((r) => !returnedSet.has(r)),
  }
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

// ─── post-synthesis validation ────────────────────────────────────────

/**
 * ARC-156 (Greptile port A2): vague-prefix filter — drop any finding
 * whose `headline` or `body` starts with one of these words (case-
 * sensitive, word-boundary). The negative-constraint specialist
 * prompts (see `SHARED_NEGATIVE_CONSTRAINTS` in pr-review-specialists.ts)
 * tell the model not to emit these; this post-processing filter is
 * the backstop for findings that slip through.
 */
export const VAGUE_PREFIXES = [
  "Ensure",
  "Verify",
  "Validate",
  "Consider",
  "Review",
  "Confirm",
] as const

/**
 * Returns true when the finding's headline OR body begins with one
 * of the VAGUE_PREFIXES words (followed by end-of-string or a
 * non-letter character so we don't false-match e.g. "Ensures").
 *
 * Pure — exported for unit tests.
 */
export function hasVaguePrefix(finding: PrReviewFinding): boolean {
  return startsWithVagueWord(finding.headline) || startsWithVagueWord(finding.body)
}

/**
 * Word-boundary regex for the vague prefix check. Built once from
 * VAGUE_PREFIXES so the boundary semantics match the stated
 * "any non-letter character" contract — covers `-`, `/`, `"`, `'`,
 * `[`, `\\`, etc. (Sigilix + CodeRabbit catch on arc-156 PR: the
 * prior `/[\s.,!?:;()]/` check was too narrow.) The `\b` anchor
 * fires between any word and non-word character, which matches the
 * intent for headline/body prefix detection.
 */
const VAGUE_PREFIX_RE = new RegExp(`^(?:${VAGUE_PREFIXES.join("|")})\\b`)

function startsWithVagueWord(s: string): boolean {
  const trimmed = (s ?? "").trim()
  return trimmed.length > 0 && VAGUE_PREFIX_RE.test(trimmed)
}

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
   * SIG-293 v1: count of secrets-exposure findings the security-grounding
   * gate flagged as ungrounded — the cited line held no credential token
   * and no scanner fact corroborated it (would-demote-to-body in shadow,
   * actual-demote in enforce). 0 when the gate is `off`. Surfaced to
   * telemetry so the gate's would-demote rate is observable before enforce.
   */
  droppedForFailedSecurityGroundingValidation: number
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

interface SourceFindingSecurityEvidence {
  cweId?: string
  evidenceId?: string
}

function buildSourceFindingSecurityEvidenceById(
  specialistVerdicts: CollectedVerdict[],
): Map<string, SourceFindingSecurityEvidence> {
  const out = new Map<string, SourceFindingSecurityEvidence>()
  for (const verdict of specialistVerdicts) {
    if (!verdict.verdict) continue
    for (const finding of verdict.verdict.findings) {
      const entry: SourceFindingSecurityEvidence = {}
      if (hasNonEmptyString(finding.cweId)) entry.cweId = finding.cweId
      if (hasNonEmptyString(finding.evidenceId)) entry.evidenceId = finding.evidenceId
      if (Object.keys(entry).length > 0) out.set(finding.id, entry)
    }
  }
  return out
}

function backfillSecurityEvidenceFromSources(
  finding: PrReviewFinding,
  sourceIds: readonly string[],
  sourceEvidenceById: ReadonlyMap<string, SourceFindingSecurityEvidence>,
): PrReviewFinding {
  const source = selectSourceEvidenceForBackfill(finding, sourceIds, sourceEvidenceById)
  if (!source) return finding
  return {
    ...finding,
    ...(!hasNonEmptyString(finding.cweId) && source.cweId ? { cweId: source.cweId } : {}),
    ...(!hasNonEmptyString(finding.evidenceId) && source.evidenceId ? { evidenceId: source.evidenceId } : {}),
  }
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

/**
 * SIG-216: post-emit scope normalization. LLM specialists sometimes
 * emit `scope: "file"` for findings that have a concrete `(path, line)`
 * AND that line falls within a reviewable diff hunk. Those findings
 * SHOULD anchor inline, not fall back to the Review Body section.
 * Force `scope: "line"` for the anchorable shape so the renderer
 * routes them inline.
 *
 * Out of scope: PR-level findings (no concrete path/line) and
 * comment-scope findings (replies to existing comments) stay
 * whatever the LLM emitted.
 *
 * Why post-emit not prompt: the prompt already says "use line when
 * possible" but LLMs over-pick file. Belt-and-braces.
 *
 * SIG-216 fix-up: the predicate requires a RIGHT-side anchor (was:
 * any side). For a file-scoped finding on a DELETED line, a LEFT-only
 * diff position was previously passing the predicate → scope flipped
 * to "line" → validation accepted side=LEFT but `buildReviewSubmission`
 * always emits inline comments with `side: "RIGHT"` → primary submit
 * 422'd.
 *
 * SIG-216 follow-up: relax the strict both-bounds check for multi-line
 * findings. ANY line in the inclusive [startLine, line] range being in
 * a RIGHT-side hunk is sufficient to anchor inline. GitHub accepts
 * multi-line inline comments via start_line + line even when only the
 * middle of the range is in the diff. The prior strict-bounds check
 * over-suppressed (PR #175 dogfood: a 15-line finding range with the
 * diff in the middle got routed to body).
 */
function isAnyLineInRightHunk(
  anchorLines: ReadonlyArray<{ line: number; side: "LEFT" | "RIGHT" }>,
  startLine: number,
  endLine: number,
): boolean {
  // CR (PR #176): walking the numeric [startLine, endLine] range is
  // O(N*M) where N = range size and M = anchorLines.length. A malformed
  // finding (e.g. `startLine: 1, line: 999999`) would loop a million
  // times. Single-pass scan over the (typically small) anchorLines is
  // O(M) and unbounded-range-safe.
  for (const a of anchorLines) {
    if (a.side === "RIGHT" && a.line >= startLine && a.line <= endLine) {
      return true
    }
  }
  return false
}

function normalizeFindingScopeForAnchorability(
  finding: PrReviewFinding,
  reviewable: ReviewableMap,
): PrReviewFinding {
  // PR-level / comment-level findings: leave alone — they aren't
  // anchorable by definition.
  if (finding.scope === "pr" || finding.scope === "comment") return finding
  // Already line-scoped: leave alone.
  if (finding.scope === "line") return finding

  // File-scoped (or scope omitted): check if it's actually anchorable.
  const path = typeof finding.path === "string" ? finding.path.trim() : ""
  if (path.length === 0) return finding
  if (typeof finding.line !== "number" || !Number.isFinite(finding.line)) return finding

  // Is the line in a reviewable hunk?
  const anchorLines = reviewable.get(path)
  if (!anchorLines) return finding

  // SIG-216 follow-up: relax the strict both-bounds check. ANY line in
  // the inclusive [startLine, endLine] range being in a RIGHT-side hunk
  // is sufficient to anchor inline. GitHub accepts multi-line inline
  // comments via start_line + line even when only the middle of the
  // range is in the diff. Prior strict-bounds check over-suppressed
  // (PR #175 dogfood: 15-line finding range with diff in the middle
  // got routed to body).
  //
  // LEFT-only positions remain non-anchorable for the scope flip
  // because `buildReviewSubmission` always emits inline comments with
  // `side: "RIGHT"` → a LEFT-only flip would 422 on submit. The
  // RIGHT-side filter inside isAnyLineInRightHunk handles that.
  const endLine = finding.line
  const startLine =
    typeof finding.startLine === "number" && Number.isFinite(finding.startLine)
      ? finding.startLine
      : endLine
  const lo = Math.min(startLine, endLine)
  const hi = Math.max(startLine, endLine)
  if (!isAnyLineInRightHunk(anchorLines, lo, hi)) return finding

  // Force scope=line so the renderer routes inline.
  return { ...finding, scope: "line" as const }
}

function selectSourceEvidenceForBackfill(
  finding: PrReviewFinding,
  sourceIds: readonly string[],
  sourceEvidenceById: ReadonlyMap<string, SourceFindingSecurityEvidence>,
): SourceFindingSecurityEvidence | undefined {
  for (const sourceId of sourceIds) {
    const source = sourceEvidenceById.get(sourceId)
    if (!source) continue
    if (hasNonEmptyString(finding.evidenceId) && source.evidenceId === finding.evidenceId) return source
    if (hasNonEmptyString(finding.cweId) && source.cweId === finding.cweId) return source
  }
  for (const sourceId of sourceIds) {
    const source = sourceEvidenceById.get(sourceId)
    if (source && (hasNonEmptyString(source.cweId) || hasNonEmptyString(source.evidenceId))) {
      return source
    }
  }
  return undefined
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

const INLINE_ANCHOR_REPAIR_WINDOW = 12

function findingScopeForInlineRepair(finding: PrReviewFinding): "line" | "file" | "pr" | "comment" {
  return finding.scope ?? "line"
}

function hasStructuredFixForInlineRepair(finding: PrReviewFinding): boolean {
  const replacement = finding.suggestedReplacement
  const deletion = finding.kind === "delete" && typeof replacement === "string" && replacement.length === 0
  const replace =
    (finding.kind === "replace" || finding.kind === undefined) &&
    typeof replacement === "string" &&
    replacement.length > 0
  return deletion || replace
}

/**
 * SIG-216 follow-up (Option A): when a multi-line finding's `line`
 * endpoint isn't in any RIGHT-side hunk but the scope-normalizer
 * flipped it to scope:"line" because the MIDDLE of the range overlaps
 * the diff, find an actually-anchorable RIGHT position inside the
 * inclusive [startLine, line] range so the inline POST won't 422.
 *
 * Without this rewrite, the half-measure shipped in
 * `normalizeFindingScopeForAnchorability` would flip the scope but
 * leave `f.line = 444` pointing at a non-reviewable line —
 * `deriveSide` at the line-validity check fails, the finding routes to
 * `unanchoredFindings` anyway. PR #175 dogfood class.
 *
 * GitHub multi-line inline-comment semantics: `line` is the bottom of
 * the visible underline; `start_line` is the top. Both must be on the
 * diff (`isCommentAnchorable`). When neither original endpoint
 * survives, we pick the LAST RIGHT anchor in range as the new `line`
 * (closest to the original bottom) and the FIRST RIGHT anchor as the
 * new `start_line` when distinct.
 *
 * Returns null when (a) the finding is single-line (caller falls
 * through to the existing single-line repair / unanchored routing),
 * (b) no RIGHT anchor exists inside the range, or (c) the finding has
 * no usable `path`/`line`. Pure.
 */
function findRangeAwareAnchor(
  reviewable: ReviewableMap,
  finding: PrReviewFinding,
): { line: number; startLine?: number } | null {
  const path = typeof finding.path === "string" ? finding.path.trim() : ""
  if (path.length === 0) return null
  if (typeof finding.line !== "number" || !Number.isFinite(finding.line)) return null
  const hasMultiLine =
    typeof finding.startLine === "number" &&
    Number.isFinite(finding.startLine) &&
    finding.startLine !== finding.line
  if (!hasMultiLine) return null

  const anchors = reviewable.get(path)
  if (!anchors || anchors.length === 0) return null

  const endLine = finding.line
  const startLine = finding.startLine as number
  const lo = Math.min(startLine, endLine)
  const hi = Math.max(startLine, endLine)

  // Single-pass scan: pick the FIRST and LAST RIGHT-side anchor inside
  // the inclusive [lo, hi] range. Last = closest to the original bottom
  // (becomes the new `line`); first = top of the underline
  // (becomes the new `start_line` if distinct from `line`).
  let firstLine: number | null = null
  let lastLine: number | null = null
  for (const a of anchors) {
    if (a.side !== "RIGHT") continue
    if (a.line < lo || a.line > hi) continue
    if (firstLine === null || a.line < firstLine) firstLine = a.line
    if (lastLine === null || a.line > lastLine) lastLine = a.line
  }
  if (lastLine === null || firstLine === null) return null

  return firstLine < lastLine
    ? { line: lastLine, startLine: firstLine }
    : { line: lastLine }
}

function findRepairableInlineAnchor(args: {
  finding: PrReviewFinding
  reviewable: ReviewableMap
  addedLineTextByLine: ReadonlyMap<string, ReadonlyMap<number, string>> | undefined
}): number | null {
  const { finding, reviewable, addedLineTextByLine } = args
  if (findingScopeForInlineRepair(finding) !== "line") return null
  if (hasStructuredFixForInlineRepair(finding)) return null

  const addedLinesForPath = addedLineTextByLine?.get(finding.path)
  if (!addedLinesForPath || addedLinesForPath.size === 0) return null

  let bestLine: number | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  let bestIsForward = false

  for (const [candidateLine, text] of addedLinesForPath) {
    const distance = Math.abs(candidateLine - finding.line)
    if (distance > INLINE_ANCHOR_REPAIR_WINDOW) continue
    if (deriveSide(reviewable, finding.path, candidateLine) !== "RIGHT") continue
    if (!isSubstantiveAnchorLine(text)) continue

    const isForward = candidateLine >= finding.line
    if (
      distance < bestDistance ||
      (distance === bestDistance && isForward && !bestIsForward) ||
      (distance === bestDistance && isForward === bestIsForward && bestLine !== null && candidateLine < bestLine)
    ) {
      bestLine = candidateLine
      bestDistance = distance
      bestIsForward = isForward
    }
  }

  return bestLine
}

/**
 * SIG-113: gate per-finding evidence citation for `category: "testing"`
 * findings. Drops uncited findings to suppress the PR #110/#111
 * hallucination class (specialist asserts "missing tests" without
 * having inspected any test file).
 *
 * Contract:
 *   - Non-testing findings always pass (gate only applies to category="testing")
 *   - When pack is undefined (orchestrator skipped the build — e.g. pure
 *     docs PR with no source/test files in the diff), all findings pass
 *     (no evidence to gate on; the SIG-91 prompt rule already covers
 *     this case via "[TESTING EVIDENCE] block absent → no missing-tests
 *     finding applicable")
 *   - Finding cites an `inspectedTestFiles` path that EXISTS in the
 *     pack's inspected set → keep (specialist read a file we actually
 *     embedded in its prompt)
 *   - Finding cites an `evidenceRefs` `siblingMapping:<source>-><test>`
 *     that MATCHES a real mapping in the pack AND whose `<source>`
 *     equals `finding.path` → keep (relevant + accurate absence claim)
 *   - Finding cites `evidenceRefs` `inspectedTestFile:<path>` resolving
 *     to a real inspected path → keep
 *   - Finding cites `evidenceRefs` `testFileChanged:<path>` resolving
 *     to a test file in the PR's changed set → keep (covers the
 *     "removed/renamed test coverage" class where the deleted test
 *     can't be fetched at headSha)
 *   - Otherwise → drop
 *
 * CodeRabbit catch on PR #112 (Major): the citation MUST be validated
 * against the actual pack, not just shape-checked. Pre-fix, any
 * non-empty `inspectedTestFiles` array or any `evidenceRefs` string
 * with the right prefix passed — letting a hallucinating model bypass
 * the gate with an invented path (`tests/made-up.test.ts`) or a
 * fabricated mapping. That reopens the "structurally valid but
 * factually unsupported" hole the gate exists to close. Now every
 * citation is cross-checked against `pack.inspectedTestFiles` /
 * `pack.siblingMappings`.
 *
 * Pure — exported for tests.
 */
export function evaluateTestingFindingCitation(
  finding: PrReviewFinding,
  pack: TestingEvidencePack | undefined,
  /**
   * SIG-118: the real coverage-gap set, keyed `"<path>:<line>"` (path
   * resolved to a changed file, line in the PR's added set). Defaults to
   * an empty set (back-compat for callers that don't ingest coverage). A
   * `coverageGap:<path>:<line>` evidenceRef is a REAL citation (keep)
   * only when (path,line) is in this set AND `finding.path === path`.
   */
  coverageGaps: ReadonlySet<string> = new Set<string>(),
): { keep: true } | { keep: false; reason: "no-citation" } {
  if (finding.category !== "testing") return { keep: true }
  // `buildTestingEvidencePack` always returns a pack object — even for
  // a pure docs PR it returns one with empty source/test arrays. Treat
  // an empty pack the same as an absent one: no evidence to gate on,
  // so pass the finding through.
  if (!pack || (pack.sourceFilesChanged.length === 0 && pack.testFilesChanged.length === 0)) {
    return { keep: true }
  }

  // Build the sets of REAL evidence from the pack. A citation only
  // counts if it names something the pack actually contains.
  const realInspected = new Set(pack.inspectedTestFiles)
  const realTestFilesChanged = new Set(pack.testFilesChanged)
  // Real mapping source → arrow-value, so we can both (a) confirm the
  // mapping exists AND (b) enforce relevance to `finding.path`.
  const realMappingBySource = new Map<string, string>()
  for (const m of pack.siblingMappings) {
    realMappingBySource.set(m.source, m.test ?? "NONE")
  }

  // inspectedTestFiles: at least one cited path must be in the pack's
  // real inspected set. An invented path doesn't count. No relevance-
  // to-`finding.path` check here — a finding about a source file
  // legitimately cites the (differently-named) test file it read.
  if (Array.isArray(finding.inspectedTestFiles)) {
    for (const p of finding.inspectedTestFiles) {
      if (typeof p === "string" && realInspected.has(p.trim())) {
        return { keep: true }
      }
    }
  }

  // evidenceRefs: validate each ref against the pack.
  if (Array.isArray(finding.evidenceRefs)) {
    for (const ref of finding.evidenceRefs) {
      if (typeof ref !== "string") continue
      const trimmed = ref.trim()

      // `siblingMapping:<source>-><test|NONE>` — must match a REAL
      // mapping AND be RELEVANT to this finding. CodeRabbit PR #112
      // (Major): a finding about `foo.ts` could otherwise cite an
      // unrelated real mapping (`bar.ts->NONE`) and bypass the gate.
      // The mapping's source must equal the finding's target path.
      if (trimmed.startsWith("siblingMapping:")) {
        const payload = trimmed.slice("siblingMapping:".length)
        const arrowIdx = payload.indexOf("->")
        if (arrowIdx < 0) continue
        const source = payload.slice(0, arrowIdx).trim()
        const arrowValue = payload.slice(arrowIdx + 2).trim()
        // Relevance: the cited mapping must be ABOUT the file the
        // finding targets.
        if (source !== finding.path) continue
        // Existence + accuracy: the cited arrow value must match the
        // pack's real mapping for that source (a `->NONE` claim for a
        // source that actually has a sibling is rejected).
        if (realMappingBySource.get(source) === arrowValue) {
          return { keep: true }
        }
        continue
      }

      // `inspectedTestFile:<path>` — must be a real inspected path.
      if (trimmed.startsWith("inspectedTestFile:")) {
        const path = trimmed.slice("inspectedTestFile:".length).trim()
        if (realInspected.has(path)) {
          return { keep: true }
        }
        continue
      }

      // `testFileChanged:<path>` — CodeRabbit PR #112 (Major): a
      // legitimate "PR removed/renamed test coverage" finding can't
      // cite an inspected file (the deleted test fails to fetch at
      // headSha) or a sibling mapping (no source). Accept a citation
      // that names a test file present in the PR's CHANGED set, which
      // includes deletions/renames.
      if (trimmed.startsWith("testFileChanged:")) {
        const path = trimmed.slice("testFileChanged:".length).trim()
        if (realTestFilesChanged.has(path)) {
          return { keep: true }
        }
        continue
      }

      // SIG-118: `coverageGap:<path>:<line>` — an LCOV-derived coverage
      // gap. Parse the LINE from the LAST colon so paths containing
      // colons stay intact. A real citation (keep) only when (path,line)
      // is in the real coverage-gap set AND the cited path matches
      // `finding.path` (relevance, mirroring the sibling-mapping rule).
      if (trimmed.startsWith("coverageGap:")) {
        const parsed = parseCoverageGapRef(trimmed)
        if (parsed === null) continue
        // Compare against the TRIMMED finding path (code-review LOW): the
        // SIG-111 gate trims, so keep both gates consistent.
        if (parsed.path !== finding.path.trim()) continue
        if (coverageGaps.has(`${parsed.path}:${parsed.line}`)) {
          return { keep: true }
        }
        continue
      }
    }
  }

  return { keep: false, reason: "no-citation" }
}

export function validateForSubmission(args: {
  synthOutput: { verdict: PrReviewVerdict; provenance: SynthesizerProvenance }
  reviewable: ReviewableMap
  specialistVerdicts: CollectedVerdict[]
  /**
   * SIG-113: testing-evidence pack built by the orchestrator from
   * the FULL diff inventory. Used by `evaluateTestingFindingCitation`
   * to drop `category: "testing"` findings that don't cite evidence
   * (the PR #110 / PR #111 hallucination class). Absent for callers
   * that haven't wired the pack through — the gate then no-ops
   * (back-compat for the staged rollout).
   */
  testingEvidence?: TestingEvidencePack
  /**
   * SIG-113: optional telemetry-emit callback fired once per dropped
   * testing finding. Lets the orchestrator log
   * `pr-review-testing-finding-dropped` with the full correlation
   * fields (owner/repo/prNumber/headSha) without coupling the pure
   * validator to a logger. Absent → silent drop (counter still
   * increments and surfaces via `droppedForUncitedTestingEvidence`).
   */
  onTestingFindingDropped?: (finding: PrReviewFinding, reason: "no-citation") => void
  /**
   * SIG-108: security fact manifest (evidenceId → fact) built by the
   * orchestrator via `buildSecurityFactManifest`. Used by
   * `evaluateSecurityFinding` to cross-check sev>=4 security findings'
   * evidence + auto-enrich corroborated findings. Absent → the gate
   * no-ops (back-compat for callers not yet threading the manifest).
   */
  securityManifest?: Map<string, SecurityFact>
  /**
   * SIG-141: per-file line spans of `class … extends DurableObject`
   * declarations in the changed files (AST-derived, see
   * `durableObjectClassSpans`). An authz-bucket security finding whose line
   * lands INSIDE one of these spans is suppressed unconditionally — a DO method
   * is only invokable by the Worker holding the binding, so the binding IS the
   * trust boundary (per-tenant isolation is via the DO id, not per-method
   * authz). Scoped to the class body so a real access-control bug in a
   * co-located top-level helper or other class is still surfaced. Absent → no
   * suppression (back-compat).
   */
  durableObjectClassSpans?: ReadonlyMap<string, readonly LineSpan[]>
  /**
   * SIG-108: gate mode. `shadow` (default): the gate's verdict is
   * counted + telemetered but the finding is NOT dropped. `enforce`:
   * rejected findings are dropped. Read from
   * `OPENCLAW_SECURITY_VALIDATOR_MODE` at the call site; defaults to
   * `shadow` for the cautious staged rollout.
   */
  securityValidatorMode?: SecurityValidatorMode
  /**
   * SIG-108: optional telemetry callback fired once per security
   * finding the gate flagged (whether or not it was actually dropped —
   * the `dropped` arg distinguishes enforce from shadow). Lets the
   * orchestrator log `pr-review-finding-rejected-validation` with full
   * correlation fields without coupling the pure validator to a logger.
   */
  onSecurityFindingDropped?: (
    finding: PrReviewFinding,
    info: { reason: SecurityDropReason; dropped: boolean },
  ) => void
  /**
   * SIG-111: tests-finding specificity gate mode. `shadow` (default):
   * the gate's verdict is counted + telemetered but the finding is NOT
   * dropped. `enforce`: rejected findings are dropped. Read from
   * `OPENCLAW_TESTS_VALIDATOR_MODE` at the call site; defaults to
   * `shadow`. This gate is false-negative-sensitive (the SIG-108 review
   * caught real findings being dropped) so it ships dark and biases
   * toward keep.
   */
  testsValidatorMode?: TestsValidatorMode
  /**
   * SIG-111: optional telemetry callback fired once per testing finding
   * the specificity gate flagged (whether or not it was actually
   * dropped — the `dropped` arg distinguishes enforce from shadow).
   * Lets the orchestrator log `pr-review-finding-rejected-validation`
   * (the SIG-108 event, reused with a `gate: "tests"` discriminator)
   * without coupling the pure validator to a logger.
   */
  onTestFindingDropped?: (
    finding: PrReviewFinding,
    info: { reason: TestDropReason; dropped: boolean },
  ) => void
  /**
   * SIG-118: the real coverage-gap set, keyed `"<path>:<line>"`, built
   * by the orchestrator from `ingestCoverage`. Threaded into BOTH the
   * SIG-113 citation gate and the SIG-111 specificity gate so a finding
   * citing a real `coverageGap:<path>:<line>` is treated as a genuine
   * missing-coverage citation. Absent / empty → both gates ignore
   * coverageGap refs (back-compat; default off).
   */
  coverageGaps?: ReadonlySet<string>
  /**
   * SIG-109: logic-finding evidence (added-line text per path + the
   * roleHint:logic AST findings). Threaded so `evaluateLogicFinding` can
   * anchor sev>=4 logic findings to the diff. Absent → the gate no-ops
   * (back-compat for callers not yet threading the evidence).
   */
  logicEvidence?: LogicEvidence
  /**
   * SIG-109: logic-finding evidence gate mode. `shadow` (default): the
   * gate's verdict is counted + telemetered but the finding is NOT
   * dropped. `enforce`: rejected findings are dropped. Read from
   * `OPENCLAW_LOGIC_VALIDATOR_MODE` at the call site; defaults to
   * `shadow`. This gate is false-negative-sensitive (logic bugs are
   * LLM-found with no deterministic backing) so it ships dark and biases
   * hard toward keep.
   */
  logicValidatorMode?: LogicValidatorMode
  /**
   * SIG-109: optional telemetry callback fired once per logic finding the
   * evidence gate flagged (whether or not it was actually dropped — the
   * `dropped` arg distinguishes enforce from shadow). Lets the
   * orchestrator log `pr-review-finding-rejected-validation` (the SIG-108
   * event, reused with a `gate: "logic"` discriminator) without coupling
   * the pure validator to a logger.
   */
  onLogicFindingDropped?: (
    finding: PrReviewFinding,
    info: { reason: LogicDropReason; dropped: boolean },
  ) => void
  /**
   * SIG-110: perf-finding evidence (added-line text per path + the
   * roleHint:performance AST findings). Threaded so `evaluatePerfFinding`
   * can anchor sev>=4 perf findings to the diff. Absent → the gate no-ops.
   */
  perfEvidence?: PerfEvidence
  /**
   * SIG-110: perf-finding evidence gate mode. `shadow` (default) counts +
   * telemeters but never drops; `enforce` drops rejected findings. Read
   * from `OPENCLAW_PERF_VALIDATOR_MODE` at the call site.
   */
  perfValidatorMode?: PerfValidatorMode
  /**
   * PR3 inline-first routing: per-file new-side added-line text. When
   * a line-scoped, non-suggestion finding lands just outside GitHub's
   * reviewable diff coordinates, validation may repair it to the
   * nearest substantive added line in the same file.
   */
  addedLineTextByLine?: ReadonlyMap<string, ReadonlyMap<number, string>>
  /**
   * SIG-110: telemetry callback fired once per perf finding the gate
   * flagged (reuses the `pr-review-finding-rejected-validation` event with
   * a `gate: "perf"` discriminator).
   */
  onPerfFindingDropped?: (
    finding: PrReviewFinding,
    info: { reason: PerfDropReason; dropped: boolean },
  ) => void
  /**
   * SIG-281 PR C (Rec 4): inline-grounding gate mode. `shadow` (default)
   * counts + telemeters but keeps every finding inline; `enforce` DEMOTES
   * ungrounded score 2-3 findings to the review body (never hard-drops).
   * Read from `OPENCLAW_INLINE_GROUNDING_VALIDATOR_MODE` at the call site.
   */
  inlineGroundingValidatorMode?: InlineGroundingValidatorMode
  /**
   * SIG-281 PR C: telemetry callback fired once per finding the inline-
   * grounding gate flagged (reuses the `pr-review-finding-rejected-
   * validation` event with a `gate: "inline-grounding"` discriminator).
   * `dropped` here means "demoted to body" (enforce), not hard-dropped.
   */
  onInlineGroundingFindingDropped?: (
    finding: PrReviewFinding,
    info: { reason: InlineGroundingDropReason; dropped: boolean },
  ) => void
  /**
   * SIG-290 v1: absence-claim grounding gate mode. `off` (default) skips
   * the gate entirely; `shadow` counts + telemeters but keeps every
   * finding inline; `enforce` DEMOTES an absence-claim ("lacks tests",
   * "no null check", "missing validation") to the review body when the
   * evidence that would confirm-or-refute the absence was PROVABLY not in
   * the specialist's window (never hard-drops). Read from
   * `OPENCLAW_ABSENCE_CLAIM_VALIDATOR_MODE` at the call site.
   */
  absenceClaimValidatorMode?: AbsenceClaimValidatorMode
  /**
   * SIG-290 v1: did the packed diff get char-truncated before specialist
   * dispatch? Part of the absence-grounding context (computed at the call
   * site). Default false. Not used alone to suppress in v1.
   */
  wasTruncated?: boolean
  /**
   * SIG-290 v1: paths the batcher dropped from the diff entirely. A
   * non-testing absence-claim on a dropped path is ungrounded (the
   * specialist never saw the file's content). Default [].
   */
  droppedPaths?: readonly string[]
  /**
   * SIG-290 v1: telemetry callback fired once per finding the absence-
   * grounding gate flagged (reuses the `pr-review-finding-rejected-
   * validation` event with a `gate: "absence-grounding"` discriminator).
   * `dropped` here means "demoted to body" (enforce), not hard-dropped.
   */
  onAbsenceFindingDropped?: (
    finding: PrReviewFinding,
    info: { reason: AbsenceGroundingDropReason; dropped: boolean },
  ) => void
  /**
   * SIG-293 v1: security-grounding gate mode. `off` (default) skips the
   * gate entirely; `shadow` counts + telemeters but keeps every finding
   * inline; `enforce` DEMOTES a `secrets-exposure` finding to the review
   * body when its cited line holds no credential token and no scanner fact
   * corroborates it (never hard-drops). Read from
   * `OPENCLAW_SECURITY_GROUNDING_VALIDATOR_MODE` at the call site. Reuses
   * the `securityManifest` + `addedLineTextByLine` already threaded above.
   */
  securityGroundingValidatorMode?: SecurityGroundingValidatorMode
  /**
   * SIG-293 v1: telemetry callback fired once per finding the security-
   * grounding gate flagged (reuses the `pr-review-finding-rejected-
   * validation` event with a `gate: "security-grounding"` discriminator).
   * `dropped` here means "demoted to body" (enforce), not hard-dropped.
   */
  onSecurityGroundingFindingDropped?: (
    finding: PrReviewFinding,
    info: { reason: SecurityGroundingDropReason; dropped: boolean },
  ) => void
  /**
   * ARC-176/SIG-175: review-tone preset. `assertive` preserves the
   * old score-1 advisory summary aggregation; `chill`/default drops
   * score-1 nits from customer-visible output entirely.
   */
  profile?: SigilixProfile
}): ValidatedOutput {
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
    logicEvidence,
    logicValidatorMode = "shadow",
    onLogicFindingDropped,
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
    securityGroundingValidatorMode = "off",
    onSecurityGroundingFindingDropped,
    profile = "chill",
  } = args
  const validIds = new Set<string>()
  const sourceEvidenceById = buildSourceFindingSecurityEvidenceById(specialistVerdicts)
  for (const v of specialistVerdicts) {
    if (!v.verdict) continue
    for (const f of v.verdict.findings) validIds.add(f.id)
  }

  const cleanFindings: PrReviewFinding[] = []
  const cleanFindingProvenance: SynthesizerProvenance["findings"] = []
  const provenanceDropped: SynthesizerProvenance["dropped"] = [
    ...synthOutput.provenance.dropped,
  ]
  const unanchoredFindings: PrReviewFinding[] = []
  let droppedForInvalidLine = 0
  let remappedInvalidLineToInline = 0
  let droppedForHallucination = 0
  let demotedScore1 = 0
  let droppedForVaguePrefix = 0
  let droppedForUncitedTestingEvidence = 0
  let droppedForFailedValidation = 0
  let droppedForFailedTestValidation = 0
  let droppedForFailedLogicValidation = 0
  let droppedForFailedPerfValidation = 0
  let droppedForFailedInlineGroundingValidation = 0
  let droppedForFailedAbsenceGroundingValidation = 0
  let droppedForFailedSecurityGroundingValidation = 0
  const advisoryNits: PrReviewFinding[] = []

  // SIG-290 v1: the reviewable diff's path set for the absence-grounding
  // gate's context. Built once, but only when the gate runs — in `off`
  // mode we skip the key iteration entirely (zero cost).
  const reviewablePaths: ReadonlySet<string> =
    absenceClaimValidatorMode === "off" ? new Set<string>() : new Set(reviewable.keys())

  // Walk by INDEX (v3.1 catch — not by headline).
  for (let i = 0; i < synthOutput.verdict.findings.length; i++) {
    // `let` (not `const`): the SIG-108 auto-enrich path may swap `f` for
    // an enriched CLONE so it never mutates the raw synth finding that
    // telemetry.synthesizer.verdict aliases (CR-1 / CodeRabbit).
    let f = synthOutput.verdict.findings[i]!
    const provenance = synthOutput.provenance.findings[i]

    // Hallucination guard. Defensive against malformed provenance
    // even though isValidProvenance pre-validated (belt + suspenders
    // per CR PR #35 — provenance might be partially valid).
    const sourceIds = Array.isArray(provenance?.sourceFindingIds)
      ? provenance.sourceFindingIds
      : []
    if (sourceIds.length === 0) {
      droppedForHallucination++
      continue
    }
    if (!sourceIds.every((id) => validIds.has(id))) {
      droppedForHallucination++
      continue
    }

    // SIG-117: synth may preserve provenance but omit security
    // evidence fields copied from the original specialist findings.
    // Backfill missing `cweId`/`evidenceId` from the cited source
    // findings BEFORE any validation gates run. The clone keeps raw
    // synth telemetry intact and never overwrites fields the synth
    // already provided.
    f = backfillSecurityEvidenceFromSources(f, sourceIds, sourceEvidenceById)

    // SIG-216: normalize scope BEFORE any scope-dependent gates fire.
    // LLM specialists sometimes emit `scope: "file"` for findings that
    // have a concrete `(path, line)` AND that line falls in a reviewable
    // hunk. The renderer routes any non-line scope into the Review Body
    // section, which loses the inline anchor. Force `scope: "line"` for
    // the anchorable shape so the renderer routes inline (PR #173
    // regression class). Telemeter the flip so we can measure how often
    // the LLM under-anchors; prompt tightening is a follow-up.
    {
      const fromScope: ReviewFindingScope | "undefined" = f.scope ?? "undefined"
      const normalized = normalizeFindingScopeForAnchorability(f, reviewable)
      if (normalized !== f) {
        console.log(JSON.stringify({
          event: "pr-review-scope-normalized-to-line",
          fromScope,
          path: f.path,
          line: f.line,
          category: f.category,
        }))
        f = normalized
      }
    }

    // ARC-156: vague-prefix filter. Drop findings whose headline OR
    // body starts with one of the VAGUE_PREFIXES words (case-
    // sensitive, word-boundary). Runs BEFORE score-1 demotion so a
    // vague nit gets dropped outright rather than aggregated into
    // the advisory bucket. Runs AFTER hallucination guard so the
    // counter attribution is unambiguous (hallucinated findings
    // shouldn't have meaningful prefix content anyway).
    if (hasVaguePrefix(f)) {
      droppedForVaguePrefix++
      continue
    }

    // SIG-113: testing-evidence citation gate. Drops
    // `category: "testing"` findings that don't cite evidence —
    // suppresses the PR #110 / PR #111 hallucination class where
    // the specialist asserted "no tests exist" without inspecting
    // any test file. Runs BEFORE score-1 demotion so an unevidenced
    // nit also drops (no advisory bucket leak). Runs AFTER vague-
    // prefix + hallucination guards so the counter attribution
    // stays clean.
    const citationCheck = evaluateTestingFindingCitation(f, testingEvidence, coverageGaps)
    if (!citationCheck.keep) {
      droppedForUncitedTestingEvidence++
      onTestingFindingDropped?.(f, citationCheck.reason)
      continue
    }

    // SIG-111: tests-finding specificity gate. Runs IMMEDIATELY AFTER
    // the SIG-113 citation gate (disjoint question: SIG-113 asks "did
    // it cite something real?", this asks "is the cited finding
    // SPECIFIC enough to be a true positive?"). Applies ONLY to sev>=4
    // `category: "testing"` findings; everything else passes via the
    // pure helper's early returns. Shadow-first: in `shadow` mode the
    // verdict is counted + telemetered but the finding is NOT dropped;
    // only `enforce` actually drops. False-negative-sensitive — the
    // helper biases toward keep (deletion/rename exception preserved,
    // ambiguous shapes kept). The SIG-86 shadow aggregator instruments
    // the would-drop rate; the bake-off harness is NOT built here.
    {
      const testDecision = evaluateTestFinding(f, testingEvidence, coverageGaps)
      if (!testDecision.keep) {
        const dropped = testsValidatorMode === "enforce"
        droppedForFailedTestValidation++
        onTestFindingDropped?.(f, { reason: testDecision.reason, dropped })
        if (dropped) continue
        // shadow mode: fall through and keep the finding.
      }
    }

    // SIG-141: DurableObject method-authz suppression. A DO method is only
    // invokable by the Worker holding the binding, so the binding IS the trust
    // boundary; per-tenant isolation is via the DO id, not per-method authz.
    // The security specialist over-fires "missing access check" on every new
    // DO method (false P1/P2). Suppress authz-bucket findings whose line lands
    // INSIDE a changed DurableObject class body — UNCONDITIONALLY (a
    // correctness drop, not a shadow-gated evidence policy), so it clears even
    // while the security validator runs in shadow. Scoped to the class span so
    // a real authz bug in a co-located top-level helper is still surfaced, and
    // to SECURITY-sourced findings (provenance, like the SIG-108 gate) so an
    // authz-CWE finding that actually came from logic/tests/perf is untouched.
    if (
      sourceRolesInclude(sourceIds, "security") &&
      lineInDurableObjectClass(doClassSpans.get(f.path.trim()), f.line) &&
      deriveSecurityBucket(f) === AUTHZ_BUCKET
    ) {
      droppedForFailedValidation++
      onSecurityFindingDropped?.(f, { reason: "do-method-authz-trust-boundary", dropped: true })
      continue
    }

    // SIG-108: security evidence gate. Applies ONLY to findings whose
    // derived role set includes `security` (from provenance, NOT from
    // `finding.category` alone — Codex #3: a merged security+logic
    // finding must still satisfy the evidence rule). A sev>=4 security
    // finding must carry a resolving evidenceId, be auto-enrichable
    // from a manifest fact at the same path/+-10 lines, or — for the
    // authz bucket — set evidenceId:"NONE" with a body justification.
    // Runs AFTER the testing gate (disjoint domains) and BEFORE score-1
    // demotion + line validation (Codex #3). Shadow-first: in `shadow`
    // mode the verdict is counted + telemetered but the finding is NOT
    // dropped; only `enforce` actually drops.
    if (securityManifest && sourceRolesInclude(sourceIds, "security")) {
      const decision = evaluateSecurityFinding(f, securityManifest)
      if (decision.keep) {
        // Auto-enrich: stamp the corroborating fact's evidenceId/cwe so
        // downstream consumers (markers, body rendering) see the
        // citation. CR-1 (CodeRabbit): clone rather than mutate — `f`
        // aliases the raw synth finding held by telemetry.synthesizer
        // .verdict; rewriting it would erase the distinction between
        // "model cited it" and "validator backfilled it" in the shadow
        // data. The enriched clone flows to the validated output; the
        // recorded synth verdict keeps the model's original.
        if (decision.enrich) {
          f = {
            ...f,
            evidenceId: decision.enrich.evidenceId,
            ...(decision.enrich.cweId && !f.cweId ? { cweId: decision.enrich.cweId } : {}),
          }
        }
      } else {
        const dropped = securityValidatorMode === "enforce"
        droppedForFailedValidation++
        onSecurityFindingDropped?.(f, { reason: decision.reason, dropped })
        if (dropped) continue
        // shadow mode: fall through and keep the finding.
      }
    }

    // SIG-109: logic evidence gate. Applies ONLY to findings whose
    // derived role set includes `logic` (from the `logic-` sourceFindingId
    // prefix, NOT `finding.category` alone — mirrors the SIG-108 security
    // gate's provenance derivation). A sev>=4 logic finding must be
    // anchored to the diff: on a changed path AND backed by a co-located
    // AST hit OR a concrete backticked token on an added line; otherwise
    // it's an unanchored claim. Runs AFTER the SIG-108 security gate
    // (disjoint domains) and BEFORE score-1 demotion + line validation.
    // Shadow-first: in `shadow` mode the verdict is counted + telemetered
    // but the finding is NOT dropped; only `enforce` actually drops. This
    // gate is false-negative-sensitive (logic bugs are LLM-found with no
    // deterministic backing) so the pure helper biases hard toward keep.
    if (logicEvidence && sourceRolesInclude(sourceIds, "logic")) {
      const logicDecision = evaluateLogicFinding(f, logicEvidence)
      if (!logicDecision.keep) {
        const dropped = logicValidatorMode === "enforce"
        droppedForFailedLogicValidation++
        onLogicFindingDropped?.(f, { reason: logicDecision.reason, dropped })
        if (dropped) continue
        // shadow mode: fall through and keep the finding.
      }
    }

    // SIG-110: perf-finding evidence gate. A sev>=4 performance-sourced
    // finding (derived from the `performance-` sourceFindingId prefix) must
    // be anchored to the diff: on a changed path AND backed by a co-located
    // AST perf hit OR a concrete token (from backticks / complexityEstimate
    // / hotPathIdentifier) on a changed line. Disjoint domain from the
    // logic/security gates. Shadow-first: only `enforce` drops.
    if (perfEvidence && sourceRolesInclude(sourceIds, "performance")) {
      const perfDecision = evaluatePerfFinding(f, perfEvidence)
      if (!perfDecision.keep) {
        const dropped = perfValidatorMode === "enforce"
        droppedForFailedPerfValidation++
        onPerfFindingDropped?.(f, { reason: perfDecision.reason, dropped })
        if (dropped) continue
        // shadow mode: fall through and keep the finding.
      }
    }

    // Score-1 advisory demotion
    if (f.score <= 1) {
      advisoryNits.push(f)
      provenanceDropped.push({
        specialist: firstSpecialistRoleFromSourceIds(sourceIds),
        sourceFindingId: sourceIds[0]!,
        headline: f.headline,
        reason: "score-1-advisory",
      })
      demotedScore1++
      continue
    }

    // SIG-141: a finding anchored to line 1 almost always points at the file
    // header (license/imports/opening comment), not a real code site — a
    // common specialist over-fire on new-file PRs. Withhold it from inline
    // anchoring and route to the summary body (same treatment as a
    // non-reviewable line), where its content is still surfaced.
    if (f.line === 1) {
      droppedForInvalidLine++
      unanchoredFindings.push(f)
      continue
    }

    // Line validity + side derivation.
    //
    // SIG-216 follow-up (Option A): a multi-line finding whose ENDPOINT
    // isn't in any RIGHT-side hunk may still be inline-anchorable if
    // the MIDDLE of the [startLine, line] range overlaps the diff. The
    // scope-normalizer already flipped scope:"line" for this case; the
    // half-measure was leaving f.line pointing at the original
    // unreviewable line so the downstream POST to GitHub would 422.
    // Rewrite both endpoints to the actually-anchorable subrange (last
    // RIGHT anchor becomes new `line`, first RIGHT anchor becomes new
    // `start_line`) so isCommentAnchorable passes and the inline POST
    // succeeds. PR #175 dogfood class.
    //
    // PR #176 CR follow-up: run the range-aware rewrite FIRST so that
    // `deriveSide` (and any subsequent validation) sees the rewritten
    // endpoints rather than the stale originals. A multi-line finding
    // whose original `startLine` is unanchorable would otherwise slip
    // through to a `start_line` 422 on the GitHub inline POST.
    const rangeAnchor = findRangeAwareAnchor(reviewable, f)
    let workingFinding: PrReviewFinding = f
    let rewroteRange = false
    if (rangeAnchor !== null) {
      // Drop the original `startLine` and re-apply only when the helper
      // returned a distinct top-of-underline anchor; otherwise the
      // stale original (outside the actually-anchorable subrange)
      // would fail `isCommentAnchorable` and the inline POST would
      // 422 on `start_line`.
      const { startLine: _originalStartLine, ...rest } = f
      void _originalStartLine
      workingFinding =
        rangeAnchor.startLine !== undefined
          ? { ...rest, line: rangeAnchor.line, startLine: rangeAnchor.startLine }
          : { ...rest, line: rangeAnchor.line }
      // Only count an actual rewrite (anchor differs from the original
      // endpoints) so the counter isn't inflated for findings whose
      // original anchor was already valid and matched by the helper.
      rewroteRange =
        workingFinding.line !== f.line ||
        workingFinding.startLine !== f.startLine
    }

    // SIG-281 PR C (Rec 4): inline-grounding gate. A finding that reaches
    // here is a real inline candidate — it survived every hard-drop gate
    // (SIG-113/111/141/108/109/110), the score-1 advisory demotion, and
    // the range-aware anchor repair above. If it's a weakly-grounded
    // score 2-3 finding it is DEMOTED to the review body (content
    // preserved — NOT hard-dropped) so the inline surface stays
    // high-signal; score>=4 (believability floor) and score<=1 (already
    // routed to advisory above) are kept by the pure helper.
    //
    // PLACEMENT: AFTER the hard-drop gates (Codex P1 — never demote a
    // finding those gates would drop) AND AFTER anchor repair (CodeRabbit
    // Major — demote `workingFinding` so the body record + downstream
    // withdrawal matching use the REPAIRED anchor, not the raw line).
    // Shadow-first: only `enforce` demotes; `shadow` counts + telemeters
    // and keeps the finding inline.
    {
      const groundingDecision = evaluateInlineGrounding(workingFinding, { addedLineTextByLine })
      if (!groundingDecision.keep) {
        const demoted = inlineGroundingValidatorMode === "enforce"
        droppedForFailedInlineGroundingValidation++
        onInlineGroundingFindingDropped?.(workingFinding, { reason: groundingDecision.reason, dropped: demoted })
        if (demoted) {
          unanchoredFindings.push(workingFinding)
          continue
        }
        // shadow mode: fall through and keep the finding inline.
      }
    }

    // SIG-290 v1: absence-grounding gate. An "absence-claim" finding
    // ("lacks tests", "no null check", "missing validation") is only
    // believable when the evidence that would confirm-or-refute the
    // absence was in the specialist's window. When it was PROVABLY not
    // (the sibling test was never inspected, or the cited path was
    // dropped from the diff) the bot was GUESSING — DEMOTE to the body
    // (content preserved, NOT hard-dropped). FP-safe: non-absence-claims,
    // excluded phrases, performance findings, and every UNKNOWN keep.
    //
    // PLACEMENT mirrors the inline-grounding block above (after the
    // hard-drop gates + anchor repair, so the demote routes `workingFinding`
    // with the repaired anchor). `off` skips the gate entirely; `shadow`
    // counts + telemeters and keeps the finding inline; only `enforce`
    // demotes. No score floor — a P0/P1 ungrounded absence-claim is the
    // worst case and is demoted too.
    if (absenceClaimValidatorMode !== "off") {
      const absenceDecision = evaluateAbsenceGrounding(workingFinding, {
        testingEvidence,
        reviewablePaths,
        wasTruncated,
        droppedPaths,
      })
      if (!absenceDecision.keep) {
        const demoted = absenceClaimValidatorMode === "enforce"
        droppedForFailedAbsenceGroundingValidation++
        onAbsenceFindingDropped?.(workingFinding, { reason: absenceDecision.reason, dropped: demoted })
        if (demoted) {
          unanchoredFindings.push(workingFinding)
          continue
        }
        // shadow mode: fall through and keep the finding inline.
      }
    }

    // SIG-293 v1: security-grounding gate (secrets-exposure). A
    // `secrets-exposure` (CWE-798) finding is only believable when the
    // cited code actually CONTAINS a credential token. One whose cited
    // line holds no credential (the #243 FP: a sev-3 finding that misread
    // `console.log(payload.length)` as a leak) is a hallucination — DEMOTE
    // to the body (content preserved, NOT hard-dropped). v1 gates ONLY
    // secrets-exposure (the single line-level-detectable category); a
    // corroborating scanner fact ALWAYS keeps. Scoped to SECURITY-sourced
    // findings (provenance, like the SIG-108 evidence gate) so a non-
    // security finding that merely carries CWE-798 is untouched.
    //
    // PLACEMENT mirrors the inline/absence blocks above (after the hard-
    // drop gates + anchor repair, so the demote routes `workingFinding`
    // with the repaired anchor). `off` skips the gate; `shadow` counts +
    // telemeters and keeps inline; only `enforce` demotes. No score floor —
    // a P0/P1 ungrounded secrets claim is the worst case and is demoted too.
    if (securityGroundingValidatorMode !== "off" && sourceRolesInclude(sourceIds, "security")) {
      const sgDecision = evaluateSecurityGrounding(workingFinding, {
        addedLineTextByLine,
        manifest: securityManifest,
      })
      if (!sgDecision.keep) {
        const demoted = securityGroundingValidatorMode === "enforce"
        droppedForFailedSecurityGroundingValidation++
        onSecurityGroundingFindingDropped?.(workingFinding, { reason: sgDecision.reason, dropped: demoted })
        if (demoted) {
          unanchoredFindings.push(workingFinding)
          continue
        }
        // shadow mode: fall through and keep the finding inline.
      }
    }

    const side = deriveSide(reviewable, workingFinding.path, workingFinding.line)
    if (!side) {
      const repairedLine =
        workingFinding.startLine == null
          ? findRepairableInlineAnchor({ finding: workingFinding, reviewable, addedLineTextByLine })
          : null
      if (repairedLine !== null) {
        cleanFindings.push({ ...workingFinding, line: repairedLine })
        if (provenance) cleanFindingProvenance.push(provenance)
        remappedInvalidLineToInline++
        continue
      }
      droppedForInvalidLine++
      // Preserve for submit-fallback. Inline anchoring would fail here,
      // but the finding's *content* is still actionable when posted as
      // free-form markdown in the body of an anchorless review.
      unanchoredFindings.push(workingFinding)
      continue
    }
    cleanFindings.push(workingFinding)
    if (rewroteRange) remappedInvalidLineToInline++
    // ARC-189: keep the per-clean-finding provenance aligned by index
    // for the ensemble caller's marker-emission step. `provenance` is
    // narrowed by the hallucination guard above (sourceIds.length >= 1
    // implies provenance was non-null).
    if (provenance) cleanFindingProvenance.push(provenance)
  }

  // Aggregate score-1 advisory nits only when the repo opts into
  // assertive review tone. Default/chill keeps these out of
  // customer-visible output entirely while preserving audit provenance.
  let summary = synthOutput.verdict.summary
  if (profile === "assertive" && advisoryNits.length > 0) {
    advisoryNits.sort((a, b) => b.score - a.score || a.headline.localeCompare(b.headline))
    const top = advisoryNits.slice(0, MAX_ADVISORY_NITS)
    const rest = advisoryNits.length - top.length
    const headlines = top.map((n) => n.headline).join("; ")
    const tail = rest > 0 ? `; plus ${rest} more advisory nits` : ""
    summary = `${summary}\n\n**Advisory nits:** ${headlines}${tail}`
  }

  return {
    verdict: { ...synthOutput.verdict, summary, findings: cleanFindings },
    unanchoredFindings,
    droppedForInvalidLine,
    remappedInvalidLineToInline,
    droppedForHallucination,
    demotedScore1,
    droppedForVaguePrefix,
    droppedForUncitedTestingEvidence,
    droppedForFailedValidation,
    droppedForFailedTestValidation,
    droppedForFailedLogicValidation,
    droppedForFailedPerfValidation,
    droppedForFailedInlineGroundingValidation,
    droppedForFailedAbsenceGroundingValidation,
    droppedForFailedSecurityGroundingValidation,
    cleanFindingProvenance,
    provenance: {
      ...synthOutput.provenance,
      dropped: provenanceDropped,
    },
  }
}

/**
 * SIG-108: derive whether a finding's source role set includes `role`.
 * Uses BOTH the explicit `sourceSpecialists` array AND the prefix of
 * each `sourceFindingId` (e.g. "security-0" → "security") — Codex #3:
 * don't trust `sourceSpecialists` blindly; cross-derive from the
 * validated finding ids too. A merged security+logic finding
 * (sourceSpecialists: ["security","logic"]) still counts as security.
 */
function firstSpecialistRoleFromSourceIds(sourceIds: readonly string[]): SpecialistRole {
  for (const id of sourceIds) {
    const role = ALL_SPECIALISTS.find((candidate) => id.startsWith(`${candidate}-`))
    if (role) return role
  }
  return "logic"
}

function sourceRolesInclude(
  sourceIds: readonly string[],
  role: SpecialistRole,
): boolean {
  // Codex-M1 (review): the `<role>-<index>` finding-id prefixes are
  // assigned deterministically (assignStableFindingIds) and are the
  // authoritative provenance signal. `sourceSpecialists` is synth-
  // reported and can be malformed — e.g. claim "security" while every
  // sourceFindingId is "logic-N". Trusting it would security-gate (and,
  // in enforce mode, DROP) a real logic finding for lacking security
  // evidence. Derive scope from the validated id prefixes ONLY. Under-
  // applying (a genuine security finding whose ids weren't populated)
  // is the safe direction for an FP-reduction gate: it skips the check,
  // never drops a real finding.
  const prefix = `${role}-`
  return sourceIds.some((id) => typeof id === "string" && id.startsWith(prefix))
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
    /** SIG-293 v1: count of secrets-exposure findings the security-
     * grounding gate flagged as ungrounded — cited line held no credential
     * token, uncorroborated by any scanner fact (would-demote-to-body in
     * shadow, actual-demote in enforce; 0 when the gate is off). */
    droppedForFailedSecurityGroundingValidation: number
  }
  retrievalCacheStats: RetrievalCacheStats | null
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
  // Best-effort telemetry write.
  await writeTelemetry(env, telemetry).catch(() => {})
  return reviewMeta !== undefined ? { status, telemetry, reviewMeta } : { status, telemetry }
}

async function writeTelemetry(env: Env, telemetry: EnsembleTelemetry): Promise<void> {
  const reverseTs = String(9_999_999_999_999 - Date.now()).padStart(13, "0")
  const key = `ensemble-review-telemetry:${reverseTs}:${telemetry.owner}/${telemetry.repo}#${telemetry.prNumber}`
  await env.OPENCLAW_STATE.put(key, JSON.stringify(telemetry), {
    expirationTtl: 30 * 24 * 60 * 60,
  })
}
