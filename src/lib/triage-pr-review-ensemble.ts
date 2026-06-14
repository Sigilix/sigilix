// SIG-318 (PR 12h) — RE-EXPORT SHIM. The Phase 4 ensemble PR-review orchestrator
// finished decomposing across PRs 2–12g (domain, ports, adapters, the nine app-layer
// phase seams — all under `./ensemble/`), and the residual `handlePrReviewEnsemble`
// coordinator moved to `./ensemble/app/orchestrator` (PR 12h).
//
// This file now exists ONLY to preserve the public module path. ~72 external
// importers (src/index.ts, the shadow-bakeoff siblings, and the test suite) import
// from `"./triage-pr-review-ensemble"` / `"../src/lib/triage-pr-review-ensemble"`,
// and the dispatch-job tests `vi.mock("../src/lib/triage-pr-review-ensemble", …)`
// to intercept `handlePrReviewEnsemble` — keeping the path alive keeps every import
// resolving + every mock intercepting unchanged. Each name is re-exported from its
// canonical home, so the public surface is byte-identical (same name set, same
// kinds) to the pre-decomposition god-file.
//
// LOAD-TIME BUDGET INVARIANT: `assertEnsembleBudgetInvariants` (run at module load
// in `./ensemble/domain/budget`) still fires whenever this graph loads — the
// orchestrator value-imports budget.ts, and this shim value-re-exports the budget
// constants below — preserving the original fail-fast-at-import contract.

// The orchestrator coordinator (PR 12h).
export {
  handlePrReviewEnsemble,
  resolveEnsembleConfig,
  validateForSubmission,
  INLINE_OVERVIEW_MIN_BUDGET_MS,
  INLINE_OVERVIEW_MAX_BUDGET_MS,
} from "./ensemble/app/orchestrator"
export type { EnsembleHandlerArgs, EnsembleResult } from "./ensemble/app/orchestrator"

// ARC-283 Phase B1b: `ChatMessage` passthrough so the shadow runner can type its
// `runWithRetryAndFallback` calls without reaching into ./ollama-chat.
export type { ChatMessage } from "@/src/shared/ports/model"

// SIG-361 (PR 9): the verdict domain. `resolveReviewEventOverride` +
// `LOW_CONFIDENCE_COMMENT_THRESHOLD` were exported at HEAD (tests import from here).
export { LOW_CONFIDENCE_COMMENT_THRESHOLD, resolveReviewEventOverride } from "./ensemble/domain/verdict"

// SIG-318: the timeout schedule + load-time budget invariants (domain/budget).
// Value-re-exported (NOT type-only) so the module-load assertion fires (see header).
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
} from "./ensemble/domain/budget"

// SIG-318 (PR 2): the FINDINGS domain.
export {
  assignStableFindingIds,
  computeConsensusRanking,
  annotateWithConsensus,
  computeFindingKey,
  computeFindingDelta,
  clampAstEmitScores,
} from "./ensemble/domain/findings"
export type { ConsensusRanked, FindingDelta } from "./ensemble/domain/findings"

// SIG-318 (PR 7 / PR 12h): the fan-out POLICY domain (`checkQuorum` joined it in 12h).
export {
  parseMinSpecialistsEarlyExitMode,
  decideEarlyExitAction,
  computeDegradedCoverage,
  checkQuorum,
} from "./ensemble/domain/policy"
export type { MinSpecialistsEarlyExitMode, EarlyExitAction } from "./ensemble/domain/policy"

// SIG-318 (PR 8) / SIG-360: the post-synthesis VALIDATION domain.
export { VAGUE_PREFIXES, hasVaguePrefix, evaluateTestingFindingCitation } from "./ensemble/domain/validation"
export type { ValidatedOutput, SynthesizerProvenance } from "./ensemble/domain/validation"

// SIG-318 (PR 12c/12d): the SYNTH-input + synth-outcome domain.
export {
  buildSynthInputVerdicts,
  collectApprovalReadinessSourceFindings,
  classifySynthOutcome,
  buildSynthRetryMessage,
  truncateVerdictToTokens,
  buildAstFindingsSynthBlock,
} from "./ensemble/domain/synth"
export type { ApprovalReadinessSourceVerdict, SynthAttemptOutcome } from "./ensemble/domain/synth"
// SIG-375 (SIG-318 env→Config): the env-taking synth-bypass wrappers moved to the
// `./ensemble/config` edge (the domain now exposes the pure boolean-taking gate).
// Re-exported here so the public helper names + their unit tests stay unchanged.
export { isSynthBypassEnabled, isSynthBypassEligible } from "./ensemble/config"

// SIG-318 (PR 12g-3): the dynamic-evidence-block domain.
export { resolveDynamicEvidencePromptBlock } from "./ensemble/domain/dynamic-evidence-block"
export type {
  ResolveDynamicEvidencePromptBlockArgs,
  ResolvedDynamicEvidencePromptBlock,
} from "./ensemble/domain/dynamic-evidence-block"

// SIG-318 (PR 12g-2): the graph-context-format domain + the AST-scan-gate helper.
export {
  BLAST_RADIUS_RESOLUTION_READY,
  formatGraphContext,
  formatGraphBlastContext,
  graphOverlapStats,
} from "./ensemble/domain/graph-context-format"
// SIG-375 (SIG-318 env→Config): the env-taking graph-retrieval wrappers moved to
// the `./ensemble/config` edge (the domain now exposes the pure raw-string parsers).
// Re-exported here so the public helper names + their unit tests stay unchanged.
export { graphRetrievalEnabled, graphRetrievalMode } from "./ensemble/config"
export { applyAstScanGate } from "./ensemble/domain/ast-scan-gate"

// SIG-286: graphExpansionMode (the light module the metrics route imports).
export { graphExpansionMode } from "./graph-expansion-mode"

// SIG-318 (PR 12b): the shadow-bakeoff GRACE primitives.
export {
  SHADOW_GRACE_EXPIRED,
  SHADOW_RUN_FAILED,
  composeSignals,
  isShadowRunFailed,
  raceWithShadowGrace,
} from "./ensemble/domain/shadow-grace"
export type { ShadowRunFailedOutcome } from "./ensemble/domain/shadow-grace"

// SIG-362 (PR 10): the model-call core. `ModelConfig` (the pure retry knobs) lives
// in the model-policy domain; the configs + runners + `MAX_CALLS_PER_ENSEMBLE_RUN`
// live in the model-provider adapter.
export type { ModelConfig } from "./ensemble/domain/model-policy"
export {
  SPECIALIST_CONFIGS,
  SYNTHESIZER_CONFIG,
  MAX_CALLS_PER_ENSEMBLE_RUN,
  runSpecialist,
  runWithRetryAndFallback,
  runSynthesizer,
  isPermanentFailure,
  parseSynthAnswer,
  // SIG-406: per-model API-key selection (key-by-id-shape) — used by the live eval
  // harnesses so a `:cloud` model override routes to OLLAMA_API_KEY and an OpenRouter
  // id (e.g. openai/o3) routes to OPENROUTER_API_KEY.
  selectConfigApiKey,
  modelApiKeys,
} from "./ensemble/adapters/model-provider"
export type { SpecialistRunArgs, AttemptCallbackInfo, SynthesizerRunArgs } from "./ensemble/adapters/model-provider"
export type { ModelApiKeys } from "./ensemble/adapters/model-provider"

// SIG-318 (PR 12e/12f): the submission-affordance cluster + the SESSION contract.
export { prepareSubmissionAffordance, buildSuggestionEmissionLogEvents } from "./ensemble/app/affordances"
export type {
  SubmissionAffordance,
  SuggestionEmissionLogContext,
  SuggestionEmissionLogEvent,
} from "./ensemble/app/affordances"
export type { ReviewMeta } from "./ensemble/app/session"
