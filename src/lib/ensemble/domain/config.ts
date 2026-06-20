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

import type { SpecialistRole } from "@/src/shared/domain/specialist-role"
import type { SecurityValidatorMode } from "./gates/validate-security-finding"
import type { TestsValidatorMode } from "./gates/validate-test-finding"
import type { LogicValidatorMode } from "./gates/validate-logic-finding"
import type { LogicRefutationMode } from "./gates/validate-logic-refutation"
import type { RefutationSurvivalMode } from "./gates/validate-refutation-survival"
import type { LogicClaimRefutationMode, LogicClaimDropReason } from "./gates/validate-logic-claim-refutation"
import type { PerfValidatorMode } from "./gates/validate-perf-finding"
import type { InlineGroundingValidatorMode } from "./gates/validate-inline-grounding"
import type { AbsenceClaimValidatorMode } from "./gates/validate-absence-grounding"
import type { WindowBlindnessValidatorMode } from "./gates/validate-window-blindness"
import type { SecurityGroundingValidatorMode } from "./gates/validate-security-grounding"
import type { SecurityUsageValidatorMode } from "./gates/validate-security-usage"
import type { ReceiptJoinMode } from "@/src/lib/verification/verify-finding-receipt"
import type { SelfConfirmMode } from "@/src/lib/verification/confirm-finding-inworker"
import type { LogicPromptBudgetMode } from "@/src/lib/logic-prompt-budget"
import type { LogicInputCompositionMode } from "./logic-input-composition"
import type { AstEmitFloorMode } from "@/src/lib/degraded-finding-floor"
import type { TrustLedgerMode } from "./gates/trust-ledger-thread"
import type { ClaimShadowMode } from "@/src/lib/review-memory/shadow-match"
import type { PrecisionMode } from "@/src/features/precision-profile"
import type { ResweepMode } from "./resweep"
import type { MultiBatchMode } from "./multibatch-budget"
import type { InvariantLensMode, InvariantLensRecallContract } from "./invariant-lens"
import type { ReviewOutputSurface } from "@/src/lib/pr-review-check-run"
import type { MinSpecialistsEarlyExitMode } from "./policy"
import type { IncrementalReviewMode } from "./incremental-coverage"
import type { AdversarialFramingMode } from "@/src/lib/removed-guarding-tests"

/** Normalized `off | shadow | post` mode for an AST security scanner. Kept as a
 *  string to preserve the call sites' exact contract (`mode !== "post"`,
 *  `applyAstScanGate(...)`). */
export type AstScanMode = string

/** SIG-287 (reasoning-on harness): the BOUNDED DeepSeek reasoning levels a role
 *  may opt into. Never `true` (unbounded) — the per-attempt cap can't out-wait
 *  an unbounded CoT (the SIG-287 stall). Matches `GenerateArgs.reasoning`. */
export type ReasoningLevel = "high" | "medium" | "low"

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
  /** SIG-392: at the SIG-108 evidence gate's demote branch, recategorize a
   *  failing sev>=4 security finding to `logic` and keep it INLINE when it
   *  carries a concrete mechanism (non-empty failureExample) — the
   *  security-shaped-logic-bug class (key collisions, authz-by-construction)
   *  that can never have scanner evidence. Mechanism-less findings demote
   *  exactly as before (the anti-hallucination wall is untouched). */
  securityReclassEnabled: boolean
  testsValidatorMode: TestsValidatorMode
  logicValidatorMode: LogicValidatorMode
  logicRefutationMode: LogicRefutationMode
  refutationSurvivalMode: RefutationSurvivalMode
  logicClaimRefutationMode: LogicClaimRefutationMode
  /** SIG-392 reason-scoped enforce allowlist; `undefined` ⇒ enforce every reason. */
  logicClaimRefutationEnforceReasons: ReadonlySet<LogicClaimDropReason> | undefined
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
  /** SIG-476 PR2: in-worker self-confirmation gate mode — "off" (default) |
   *  "shadow" | "on". `shadow` MEASURES the confirmed/uplift fractions (the
   *  `selfconfirm` corpus on VerificationMetricsDO) WITHOUT mutating any tier —
   *  the GO/NO-GO that decides whether `deterministic-confirmed` earns a distinct
   *  pill (PR3) or should be a GROUNDED sub-state. `on` also annotates a confirmed
   *  finding with the `deterministic-confirmed` signal. */
  selfConfirmMode: SelfConfirmMode
  logicPromptBudgetMode: LogicPromptBudgetMode
  /** SIG-369(b): `OPENCLAW_LOGIC_INPUT_COMPOSITION` "off" | "shadow" (default
   *  "off"). When "shadow", the logic specialist's input-token composition is
   *  measured + emitted + attached to the KV review-telemetry record. Pure no-op
   *  when off — telemetry only, no context cut. */
  logicInputCompositionMode: LogicInputCompositionMode
  /** Normalized `OPENCLAW_SYNTH_RECOVERY` (default "off", trim + lowercase). */
  synthRecovery: AstScanMode
  astEmitFloorMode: AstEmitFloorMode
  trustLedgerMode: TrustLedgerMode
  reviewMemoryClaimShadowMode: ClaimShadowMode
  /** Raw `OPENCLAW_REVIEW_MEMORY_CLAIMS` — compared (`=== "on"`) at the call site. */
  reviewMemoryClaims: string | undefined
  precisionProfileMode: PrecisionMode
  reviewOutputSurface: ReviewOutputSurface
  minSpecialistsEarlyExitMode: MinSpecialistsEarlyExitMode
  /** `OPENCLAW_GRAPH_RETRIEVAL` is "shadow" | "post" (SIG-138). Drives the
   *  graph-expansion DO calls in `gatherGraphEvidence`. */
  graphRetrievalEnabled: boolean
  /** Effective `OPENCLAW_GRAPH_RETRIEVAL` mode: "off" | "shadow" | "post". A raw
   *  "post" is honored once `BLAST_RADIUS_RESOLUTION_READY` is true (SIG-143). */
  graphRetrievalMode: "off" | "shadow" | "post"
  /** `OPENCLAW_SYNTH_BYPASS_ENABLED === "on"` (SIG-228 Phase 3c). Gates the
   *  single-specialist no-major synth-skip optimization. */
  synthBypassEnabled: boolean
  /** `OPENCLAW_REVIEW_MANIFEST_ENABLED !== "off"` (ARC-184). The review-provenance
   *  manifest kill-switch — default-on; "off" short-circuits the manifest write. */
  reviewManifestEnabled: boolean
  /** Normalized `OPENCLAW_RESWEEP_MODE` (SIG-393): "off" | "shadow" | "on",
   *  default "off". Gates the region re-sweep second pass pre-synth. */
  /** SIG-392: roles whose `OPENCLAW_<ROLE>_RECALL_MODE === "on"`, so the
   *  recall-eliciting directive is appended to that specialist's prompt
   *  (precision is the downstream gates' job). Rolled out one role at a time. */
  recallRoles: ReadonlySet<SpecialistRole>
  /** SIG-399: roles whose `OPENCLAW_<ROLE>_REASONING_PROMPT_MODE === "on"`, so the
   *  reasoning-process directive (LOGIC_REASONING_SUFFIX) is appended to that
   *  specialist's prompt, AFTER any recall directive. Distinct from `reasoningByRole`
   *  (the SIG-287 model-effort harness); this gates PROMPT text. Logic-only today. */
  reasoningPromptRoles: ReadonlySet<SpecialistRole>
  /** SIG-287 (reasoning-on harness): roles whose model calls send a bounded
   *  `think:"<level>"` on the PRIMARY attempt (fallback always stays
   *  `think:false`). Built from `OPENCLAW_REASONING_MODE` + the role/level
   *  vars; EMPTY by default → every call is `think:false`, byte-identical to
   *  today. Mirrors `recallRoles`' per-role rollout shape. */
  reasoningByRole: ReadonlyMap<SpecialistRole, ReasoningLevel>
  resweepMode: ResweepMode
  /** Normalized `OPENCLAW_INVARIANT_LENS_MODE` (SIG-395): "off" | "shadow" |
   *  "on", default "off". Gates the concurrent invariant-lens auditors. */
  invariantLensMode: InvariantLensMode
  /** SIG-400/SIG-401: recall contract for the invariant lens. `blocking`
   *  is the default; `shadow-background` may only detach telemetry-only shadow
   *  runs. `pending-check-amendment` is parsed but fails closed until a
   *  merge-gated follow-up lane owns check completion. */
  invariantLensRecallContract: InvariantLensRecallContract
  /** SIG-418 Phase 2 (Design B′): in-invocation multi-batch review mode —
   *  "off" (default) | "shadow" | "on". DARK in PR 1: parsed into the config but
   *  not yet consumed by the orchestrator (the batch loop is PR 2), so off is
   *  byte-identical to today. */
  multiBatchMode: MultiBatchMode
  /** SIG-436: `OPENCLAW_ANCHOR_PRECISION === "on"` (default false). When true the
   *  submission substantive-anchor forward-walk treats a whole-line COMMENT as
   *  non-substantive, so a finding the model anchored to the `// comment` line
   *  above the bug is re-homed onto the buggy code statement it describes. Default
   *  OFF → byte-identical inline anchoring (the live surface is unchanged until the
   *  K=12 exactness eval proves the lift). Threaded into the render layer via
   *  `buildReviewSubmissionWithMetadata`'s `anchorPrecision` arg. */
  anchorPrecision: boolean
  /** SIG-439: incremental PR re-review coverage mode. Default "off" preserves
   *  current file selection and performs no coverage-memory IO. */
  incrementalReviewMode: IncrementalReviewMode
  /** SIG-452: adversarial-framing hardening mode — "off" (default) | "shadow" |
   *  "enforce". off/shadow are byte-identical to today's OUTPUT (shadow only logs
   *  the "removed guarding test" signal counts); enforce computes the symbol-grade
   *  signal (incl. a GitHub file-metadata fetch for rename exclusion) and injects
   *  the enforce-gated logic + synth prompt blocks. */
  adversarialFramingMode: AdversarialFramingMode
}

/**
 * SIG-417: the (DARK by default) projected-cost governor knobs. Capture +
 * projection telemetry ship unconditionally; only the TRIM is gated here.
 *
 * RECALL-SAFETY: trimming is recall-NEGATIVE — a trimmed file is dropped from
 * the cheap deterministic + secret-scan P0/P1 detectors too, not just the LLM
 * pass (both run on the packed diff). So this defaults `enabled: false` and is a
 * founder-set emergency lever, never v1 behavior. When the governor DOES trim,
 * the trimmed files flow into the 1.2 spillover disclosure (never silently
 * hidden) and a high-risk file is never trimmed.
 */
export interface CostGovernorConfig {
  /** `OPENCLAW_COST_GOVERNOR_ENABLED === "on"`. Default false → no trim,
   *  review byte-identical (projection telemetry still emits, observe-only). */
  enabled: boolean
  /** Founder-set per-PR projected-cost ceiling in USD
   *  (`OPENCLAW_COST_GOVERNOR_CEILING_USD`, parseFloat). When `enabled` and set,
   *  the governor trims lowest-risk files until the projection is at/under it.
   *  Undefined ⇒ no ceiling ⇒ never trims even when `enabled`. */
  ceilingUsd?: number
  /** Floor: never trim below this many reviewed files
   *  (`OPENCLAW_COST_GOVERNOR_MIN_REVIEWED_FILES`, default 1). Guards against a
   *  too-low ceiling emptying the reviewed batch. */
  minReviewedFiles: number
  /** Per-call fixed-overhead token estimate added to the diff tokens for the
   *  projection (system prompt + retrieval snapshot + output budget;
   *  `OPENCLAW_COST_GOVERNOR_PER_CALL_OVERHEAD_TOKENS_EST`, default 4000). */
  perCallOverheadTokensEst: number
}

/** Numeric, env-overridable tunables (SIG-318 PR 5c). Each is `parseIntEnv`-parsed
 *  at the edge with the orchestrator's original default. */
export interface EnsembleTunables {
  /** Pre-flight retrieval call cap (`OPENCLAW_ENSEMBLE_MAX_RETRIEVE_CALLS_PER_PR`, default 3). */
  maxRetrieveCallsPerPr: number
  /** Graph-RPC budget in ms (`OPENCLAW_GRAPH_RPC_TIMEOUT_MS`, default `GRAPH_RPC_TIMEOUT_MS` = 2500). */
  graphRpcTimeoutMs: number
  /** SIG-393: max regions one re-sweep may fan out over (default 6). */
  resweepMaxRegions: number
  /** SIG-417: the dark projected-cost governor (default-off; see the type). */
  costGovernor: CostGovernorConfig
}

/** The parse-once, typed view of the ensemble's env-derived settings. Grows by
 *  cluster as the env→Config migration proceeds (SIG-318 PR 3+). */
export interface EnsembleConfig {
  astScanModes: AstScanModes
  validatorModes: EnsembleValidatorModes
  flags: EnsembleFeatureFlags
  tunables: EnsembleTunables
}
