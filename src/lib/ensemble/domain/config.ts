// SIG-318 — the EnsembleConfig CONTRACT (domain layer).
//
// Pure domain types describing the ensemble's env-derived settings. The
// use-case / orchestrator depends on THIS contract; the edge parser
// (`../config.ts`) is the ONLY place that knows about the Worker env, and it
// IMPLEMENTS this shape and injects it inward. Per the dependency rule the
// contract lives inward (domain) while the framework detail (env reading) stays
// at the edge — never the reverse (Kimi clean-arch review, SIG-318 PR 4).
//
// The validator-mode fields reuse each validator's own exported mode type, so
// the contract is a single typed view, not a re-declaration.

import type { SecurityValidatorMode } from "../../validate-security-finding"
import type { TestsValidatorMode } from "../../validate-test-finding"
import type { LogicValidatorMode } from "../../validate-logic-finding"
import type { LogicRefutationMode } from "../../validate-logic-refutation"
import type { RefutationSurvivalMode } from "../../validate-refutation-survival"
import type { LogicClaimRefutationMode } from "../../validate-logic-claim-refutation"
import type { PerfValidatorMode } from "../../validate-perf-finding"
import type { InlineGroundingValidatorMode } from "../../validate-inline-grounding"
import type { AbsenceClaimValidatorMode } from "../../validate-absence-grounding"
import type { WindowBlindnessValidatorMode } from "../../validate-window-blindness"
import type { SecurityGroundingValidatorMode } from "../../validate-security-grounding"
import type { SecurityUsageValidatorMode } from "../../validate-security-usage"
import type { ReceiptJoinMode } from "../../verification/verify-finding-receipt"
import type { LogicPromptBudgetMode } from "../../logic-prompt-budget"
import type { AstEmitFloorMode } from "../../degraded-finding-floor"
import type { TrustLedgerMode } from "../../trust-ledger-thread"
import type { ClaimShadowMode } from "../../review-memory/shadow-match"
import type { PrecisionMode } from "../../precision-profile/types"
import type { ReviewOutputSurface } from "../../pr-review-check-run"

/** Normalized `off | shadow | post` mode for an AST security scanner. Kept as a
 *  string to preserve the call sites' exact contract (`mode !== "post"`,
 *  `applyAstScanGate(...)`). */
export type AstScanMode = string

/** The AST security-scanner modes, one per scanner rule. */
export interface AstScanModes {
  authzIdor: AstScanMode
  weakRandom: AstScanMode
  openRedirect: AstScanMode
  ssrf: AstScanMode
  pathTraversal: AstScanMode
  sqlInjection: AstScanMode
  ssti: AstScanMode
  nosqlInjection: AstScanMode
  protoPollution: AstScanMode
  xxe: AstScanMode
}

/** The believability validator gate modes, one per validator — each typed by the
 *  validator's own exported mode union. */
export interface EnsembleValidatorModes {
  securityValidatorMode: SecurityValidatorMode
  testsValidatorMode: TestsValidatorMode
  logicValidatorMode: LogicValidatorMode
  logicRefutationMode: LogicRefutationMode
  refutationSurvivalMode: RefutationSurvivalMode
  logicClaimRefutationMode: LogicClaimRefutationMode
  perfValidatorMode: PerfValidatorMode
  inlineGroundingValidatorMode: InlineGroundingValidatorMode
  absenceClaimValidatorMode: AbsenceClaimValidatorMode
  windowBlindnessValidatorMode: WindowBlindnessValidatorMode
  securityGroundingValidatorMode: SecurityGroundingValidatorMode
  securityUsageValidatorMode: SecurityUsageValidatorMode
}

/** The orchestrator's feature-flag / mode settings (SIG-318 PR 5b). Each field
 *  preserves its old inline read's exact contract: parser-typed fields reuse the
 *  parser's own return type; inline-normalized fields are the normalized string
 *  (default "off", trim + lowercase); raw fields keep the unparsed env value
 *  (`string | undefined`) so the call site's own comparison/normalization is
 *  byte-identical. */
export interface EnsembleFeatureFlags {
  /** Raw `OPENCLAW_INGEST_AI_INSTRUCTIONS` — passed through unparsed. */
  ingestAiInstructions: string | undefined
  /** Raw `OPENCLAW_DYNAMIC_DISPATCHER_MODE` — compared at the call site. */
  dynamicDispatcherMode: string | undefined
  /** Raw `OPENCLAW_SYMBOL_RETRIEVAL` — `shouldRunSymbolRetrieval` normalizes it. */
  symbolRetrieval: string | undefined
  /** Raw `OPENCLAW_BRANCH_AWARE_RETRIEVAL` — used at two call sites, each keeps
   *  its own normalization. */
  branchAwareRetrieval: string | undefined
  /** Normalized `OPENCLAW_ASYMMETRY_HINTS` (default "off", trim + lowercase). */
  asymmetryHints: AstScanMode
  /** Normalized `OPENCLAW_TOCTOU_HINTS` (default "off", trim + lowercase). */
  toctouHints: AstScanMode
  receiptJoinMode: ReceiptJoinMode
  logicPromptBudgetMode: LogicPromptBudgetMode
  /** Normalized `OPENCLAW_SYNTH_RECOVERY` (default "off", trim + lowercase). */
  synthRecovery: AstScanMode
  astEmitFloorMode: AstEmitFloorMode
  trustLedgerMode: TrustLedgerMode
  reviewMemoryClaimShadowMode: ClaimShadowMode
  /** Raw `OPENCLAW_REVIEW_MEMORY_CLAIMS` — compared (`=== "on"`) at the call site. */
  reviewMemoryClaims: string | undefined
  precisionProfileMode: PrecisionMode
  reviewOutputSurface: ReviewOutputSurface
}

/** Numeric, env-overridable tunables (SIG-318 PR 5c). Each is `parseIntEnv`-parsed
 *  at the edge with the orchestrator's original default. */
export interface EnsembleTunables {
  /** Pre-flight retrieval call cap (`OPENCLAW_ENSEMBLE_MAX_RETRIEVE_CALLS_PER_PR`, default 3). */
  maxRetrieveCallsPerPr: number
  /** Graph-RPC budget in ms (`OPENCLAW_GRAPH_RPC_TIMEOUT_MS`, default `GRAPH_RPC_TIMEOUT_MS` = 2500). */
  graphRpcTimeoutMs: number
}

/** The parse-once, typed view of the ensemble's env-derived settings. Grows by
 *  cluster as the env→Config migration proceeds (SIG-318 PR 3+). */
export interface EnsembleConfig {
  astScanModes: AstScanModes
  validatorModes: EnsembleValidatorModes
  flags: EnsembleFeatureFlags
  tunables: EnsembleTunables
}
