// SIG-318 — the EDGE: parses the Worker env into the domain `EnsembleConfig`
// contract (`./domain/config`).
//
// This is the ONLY module that reads the Worker env and knows the `OPENCLAW_*`
// variable names. It composes the domain mode-parsers (an inward dependency) to
// IMPLEMENT the contract, then the orchestrator gets the typed config injected —
// so domain/use-case code never reads `env` (the "env-reading traps" the
// clean-arch decomposition removes). The contract's home is `./domain/config`;
// this module only produces it. Migrated one cohesive cluster at a time
// (SIG-318 PR 3+): PR 3 = AST scan modes, PR 4 = validator gate modes; feature
// flags + tunables follow, after which the single parse call hoists to the edge.

import { parseResweepMode } from "./domain/resweep"
import { parseInvariantLensMode, parseInvariantLensRecallContract } from "./domain/invariant-lens"
import { parseSecurityValidatorMode } from "./domain/gates/validate-security-finding"
import { parseTestsValidatorMode } from "./domain/gates/validate-test-finding"
import { parseLogicValidatorMode } from "./domain/gates/validate-logic-finding"
import { parseLogicRefutationMode } from "./domain/gates/validate-logic-refutation"
import { parseRefutationSurvivalMode } from "./domain/gates/validate-refutation-survival"
import {
  parseLogicClaimRefutationMode,
  parseLogicClaimRefutationEnforceReasons,
} from "./domain/gates/validate-logic-claim-refutation"
import { parsePerfValidatorMode } from "./domain/gates/validate-perf-finding"
import { parseInlineGroundingValidatorMode } from "./domain/gates/validate-inline-grounding"
import { parseAbsenceClaimValidatorMode } from "./domain/gates/validate-absence-grounding"
import { parseWindowBlindnessValidatorMode } from "./domain/gates/validate-window-blindness"
import { parseSecurityGroundingValidatorMode } from "./domain/gates/validate-security-grounding"
import { parseSecurityUsageValidatorMode } from "./domain/gates/validate-security-usage"
import { parseReceiptJoinMode } from "@/src/lib/verification/verify-finding-receipt"
import { parseLogicPromptBudgetMode } from "@/src/lib/logic-prompt-budget"
import { parseLogicInputCompositionMode } from "./domain/logic-input-composition"
import { parseAstEmitFloorMode } from "@/src/lib/degraded-finding-floor"
import { parseTrustLedgerMode } from "./domain/gates/trust-ledger-thread"
import { resolveClaimShadowMode } from "@/src/lib/review-memory/shadow-match"
import { resolvePrecisionMode } from "@/src/features/precision-profile"
import { parseReviewOutputSurface } from "@/src/lib/pr-review-check-run"
import { parseMinSpecialistsEarlyExitMode } from "./domain/policy"
import { parseIncrementalReviewMode } from "./domain/incremental-coverage"
import { parseAdversarialFramingMode } from "@/src/lib/removed-guarding-tests"
import { GRAPH_RPC_TIMEOUT_MS } from "./domain/budget"
import { parseGraphRetrievalEnabled, parseGraphRetrievalMode } from "./domain/graph-context-format"
import { parseSynthBypassEnabled, isSynthBypassEligible as isSynthBypassEligibleCore } from "./domain/synth"
import { parseMultiBatchMode } from "./domain/multibatch-budget"
import type { Env } from "@/src/shared/types/env"
import type { AstScanMode, EnsembleConfig, ReasoningLevel } from "./domain/config"
import type { SpecialistRole } from "@/src/shared/domain/specialist-role"

/** SIG-392: the set of specialist roles whose `OPENCLAW_<ROLE>_RECALL_MODE` is
 *  "on". Add a role here to wire its recall prompt; default = empty. */
function buildRecallRoles(env: EnsembleConfigEnv): ReadonlySet<SpecialistRole> {
  const roles = new Set<SpecialistRole>()
  if (env.OPENCLAW_LOGIC_RECALL_MODE === "on") roles.add("logic")
  if (env.OPENCLAW_SECURITY_RECALL_MODE === "on") roles.add("security")
  return roles
}

/** SIG-399: the set of specialist roles whose `OPENCLAW_<ROLE>_REASONING_PROMPT_MODE`
 *  is "on", so the reasoning-process directive is appended to that specialist's
 *  prompt (after any recall directive). Distinct from `buildReasoningByRole` (the
 *  SIG-287 model-effort harness): this gates PROMPT text, that gates the model
 *  `think:` level. Default = empty. Logic-only today; add a role to extend. */
function buildReasoningPromptRoles(env: EnsembleConfigEnv): ReadonlySet<SpecialistRole> {
  const roles = new Set<SpecialistRole>()
  if (env.OPENCLAW_LOGIC_REASONING_PROMPT_MODE === "on") roles.add("logic")
  return roles
}

const REASONING_LEVELS: ReadonlySet<string> = new Set<ReasoningLevel>(["high", "medium", "low"])
const REASONING_ROLE_NAMES: ReadonlySet<string> = new Set<SpecialistRole>(["logic", "security", "performance", "tests"])

/** SIG-287 (reasoning-on harness): the per-role bounded-reasoning map. EMPTY
 *  (→ every call stays `think:false`, byte-identical to today) unless
 *  `OPENCLAW_REASONING_MODE === "on"`. When on, the enabled roles are the
 *  validated tokens of `OPENCLAW_REASONING_ROLES` (comma list) and the level is
 *  the validated `OPENCLAW_REASONING_LEVEL` (default "high"). Per Codex sign-off
 *  the inputs are validated STRICTLY: an unknown role token is ignored, and an
 *  explicitly-set-but-invalid level disables reasoning entirely (returns empty)
 *  rather than letting an arbitrary string reach the adapter's `think`. Mirrors
 *  `buildRecallRoles`' per-role rollout shape. */
function buildReasoningByRole(env: EnsembleConfigEnv): ReadonlyMap<SpecialistRole, ReasoningLevel> {
  const byRole = new Map<SpecialistRole, ReasoningLevel>()
  if ((env.OPENCLAW_REASONING_MODE ?? "").trim().toLowerCase() !== "on") return byRole
  const rawLevel = (env.OPENCLAW_REASONING_LEVEL ?? "").trim().toLowerCase()
  // Default "high" when unset; an explicit-but-invalid level → off (empty map).
  if (rawLevel !== "" && !REASONING_LEVELS.has(rawLevel)) return byRole
  const level: ReasoningLevel = rawLevel === "" ? "high" : (rawLevel as ReasoningLevel)
  for (const token of (env.OPENCLAW_REASONING_ROLES ?? "").split(",")) {
    const role = token.trim().toLowerCase()
    if (REASONING_ROLE_NAMES.has(role)) byRole.set(role as SpecialistRole, level)
  }
  return byRole
}

/** The structural subset of the Worker env that `parseEnsembleConfig` reads.
 *  Declared at the edge (it names framework/env details) — never in the domain. */
export interface EnsembleConfigEnv {
  // AST security-scan modes (PR 3)
  OPENCLAW_AUTHZ_IDOR_SCAN?: string | undefined
  // SIG-392 recall-eliciting logic prompt
  OPENCLAW_LOGIC_RECALL_MODE?: string | undefined
  OPENCLAW_SECURITY_RECALL_MODE?: string | undefined
  // SIG-399 reasoning-process directive (prompt suffix; distinct from SIG-287 effort)
  OPENCLAW_LOGIC_REASONING_PROMPT_MODE?: string | undefined
  // SIG-287 reasoning-on harness (per-role bounded reasoning; default off)
  OPENCLAW_REASONING_MODE?: string | undefined
  OPENCLAW_REASONING_ROLES?: string | undefined
  OPENCLAW_REASONING_LEVEL?: string | undefined
  // SIG-393 region re-sweep
  OPENCLAW_RESWEEP_MODE?: string | undefined
  OPENCLAW_RESWEEP_MAX_REGIONS?: string | undefined
  OPENCLAW_INVARIANT_LENS_MODE?: string | undefined
  OPENCLAW_INVARIANT_LENS_RECALL_CONTRACT?: string | undefined
  // SIG-418 Phase 2 (Design B′) in-invocation multi-batch review (dark in PR 1)
  OPENCLAW_REVIEW_MULTIBATCH_MODE?: string | undefined
  OPENCLAW_WEAK_RANDOM_SCAN?: string | undefined
  OPENCLAW_OPEN_REDIRECT_SCAN?: string | undefined
  OPENCLAW_SSRF_SCAN?: string | undefined
  OPENCLAW_PATH_TRAVERSAL_SCAN?: string | undefined
  OPENCLAW_SQL_INJECTION_SCAN?: string | undefined
  OPENCLAW_SSTI_SCAN?: string | undefined
  OPENCLAW_NOSQL_INJECTION_SCAN?: string | undefined
  OPENCLAW_PROTO_POLLUTION_SCAN?: string | undefined
  OPENCLAW_XXE_SCAN?: string | undefined
  // validator gate modes (PR 4)
  OPENCLAW_SECURITY_VALIDATOR_MODE?: string | undefined
  OPENCLAW_SECURITY_RECLASS?: string | undefined
  OPENCLAW_TESTS_VALIDATOR_MODE?: string | undefined
  OPENCLAW_LOGIC_VALIDATOR_MODE?: string | undefined
  OPENCLAW_LOGIC_REFUTATION_MODE?: string | undefined
  OPENCLAW_REFUTATION_SURVIVAL_MODE?: string | undefined
  OPENCLAW_LOGIC_CLAIM_REFUTATION_MODE?: string | undefined
  OPENCLAW_LOGIC_CLAIM_REFUTATION_ENFORCE_REASONS?: string | undefined
  OPENCLAW_PERF_VALIDATOR_MODE?: string | undefined
  OPENCLAW_INLINE_GROUNDING_VALIDATOR_MODE?: string | undefined
  OPENCLAW_ABSENCE_CLAIM_VALIDATOR_MODE?: string | undefined
  OPENCLAW_WINDOW_BLINDNESS_VALIDATOR_MODE?: string | undefined
  OPENCLAW_SECURITY_GROUNDING_VALIDATOR_MODE?: string | undefined
  OPENCLAW_SECURITY_USAGE_VALIDATOR_MODE?: string | undefined
  // feature-flag / mode reads (PR 5b)
  OPENCLAW_INGEST_AI_INSTRUCTIONS?: string | undefined
  OPENCLAW_DYNAMIC_DISPATCHER_MODE?: string | undefined
  OPENCLAW_SYMBOL_RETRIEVAL?: string | undefined
  OPENCLAW_BRANCH_AWARE_RETRIEVAL?: string | undefined
  OPENCLAW_ASYMMETRY_HINTS?: string | undefined
  OPENCLAW_TOCTOU_HINTS?: string | undefined
  OPENCLAW_RECEIPTJOIN_MODE?: string | undefined
  OPENCLAW_LOGIC_PROMPT_BUDGET?: string | undefined
  // SIG-369(b): logic-input-composition telemetry (off | shadow; default off)
  OPENCLAW_LOGIC_INPUT_COMPOSITION?: string | undefined
  OPENCLAW_SYNTH_RECOVERY?: string | undefined
  OPENCLAW_AST_EMIT_FLOOR?: string | undefined
  OPENCLAW_TRUST_LEDGER?: string | undefined
  OPENCLAW_REVIEW_MEMORY_CLAIM_SHADOW?: string | undefined
  OPENCLAW_REVIEW_MEMORY_CLAIMS?: string | undefined
  OPENCLAW_PRECISION_PROFILE_MODE?: string | undefined
  OPENCLAW_REVIEW_OUTPUT_SURFACE?: string | undefined
  OPENCLAW_MIN_SPECIALISTS_EARLY_EXIT?: string | undefined
  // the final flag reads (SIG-375)
  OPENCLAW_GRAPH_RETRIEVAL?: string | undefined
  OPENCLAW_SYNTH_BYPASS_ENABLED?: string | undefined
  OPENCLAW_REVIEW_MANIFEST_ENABLED?: string | undefined
  // SIG-436: inline anchor-precision pass (default OFF; `=== "on"` to enable)
  OPENCLAW_ANCHOR_PRECISION?: string | undefined
  // SIG-439: incremental PR re-review coverage mode (off | shadow | on)
  OPENCLAW_INCREMENTAL_REVIEW_MODE?: string | undefined
  // SIG-452: adversarial-framing hardening mode (off | shadow | enforce)
  OPENCLAW_ADVERSARIAL_FRAMING_MODE?: string | undefined
  // numeric tunables (PR 5c)
  OPENCLAW_ENSEMBLE_MAX_RETRIEVE_CALLS_PER_PR?: string | undefined
  OPENCLAW_GRAPH_RPC_TIMEOUT_MS?: string | undefined
  // SIG-417: the dark projected-cost governor (default-off; trim is recall-negative)
  OPENCLAW_COST_GOVERNOR_ENABLED?: string | undefined
  OPENCLAW_COST_GOVERNOR_CEILING_USD?: string | undefined
  OPENCLAW_COST_GOVERNOR_MIN_REVIEWED_FILES?: string | undefined
  OPENCLAW_COST_GOVERNOR_PER_CALL_OVERHEAD_TOKENS_EST?: string | undefined
}

// The exact normalization the inline scan call sites used: default "off", trim,
// lowercase. Centralized so every scanner mode parses identically.
const scanMode = (v: string | undefined): AstScanMode => (v ?? "off").trim().toLowerCase()

// Numeric tunable parser (moved from the orchestrator, SIG-318 PR 5c — int-from-env
// parsing is an edge concern). Empty/undefined, non-numeric, or negative → fallback;
// an explicit 0 propagates (a 0 override must take effect, not silently default).
function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

// SIG-417: float-from-env parser for the cost-governor USD ceiling. Empty,
// non-numeric, or negative → undefined (no ceiling) rather than a fallback; the
// ceiling is intentionally absent-by-default (the governor is dark), so a bad
// value must NOT silently become an active ceiling. An explicit 0 IS a valid
// ceiling (trim everything trimmable) and propagates.
function parseFloatEnvOptional(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

// Pre-flight retrieval call-cap default (was god-file-local, SIG-318 PR 5c).
const DEFAULT_MAX_RETRIEVE_CALLS_PER_PR = 3
// SIG-393: re-sweep fan-out cap — regions × roles bounds the second pass.
const DEFAULT_RESWEEP_MAX_REGIONS = 6
// SIG-417: cost-governor floors. Never trim below 1 reviewed file; the per-call
// fixed-overhead token estimate (system prompt + retrieval snapshot + output
// budget) added to the diff tokens for the projection.
const DEFAULT_COST_GOVERNOR_MIN_REVIEWED_FILES = 1
const DEFAULT_COST_GOVERNOR_PER_CALL_OVERHEAD_TOKENS_EST = 4_000

export function parseEnsembleConfig(env: EnsembleConfigEnv): EnsembleConfig {
  // SIG-417: parse the cost-governor ceiling once (a bad value → undefined, never
  // an accidental active ceiling — see `parseFloatEnvOptional`).
  const costGovernorCeilingUsd = parseFloatEnvOptional(env.OPENCLAW_COST_GOVERNOR_CEILING_USD)
  return {
    astScanModes: {
      authzIdor: scanMode(env.OPENCLAW_AUTHZ_IDOR_SCAN),
      weakRandom: scanMode(env.OPENCLAW_WEAK_RANDOM_SCAN),
      openRedirect: scanMode(env.OPENCLAW_OPEN_REDIRECT_SCAN),
      ssrf: scanMode(env.OPENCLAW_SSRF_SCAN),
      pathTraversal: scanMode(env.OPENCLAW_PATH_TRAVERSAL_SCAN),
      sqlInjection: scanMode(env.OPENCLAW_SQL_INJECTION_SCAN),
      ssti: scanMode(env.OPENCLAW_SSTI_SCAN),
      nosqlInjection: scanMode(env.OPENCLAW_NOSQL_INJECTION_SCAN),
      protoPollution: scanMode(env.OPENCLAW_PROTO_POLLUTION_SCAN),
      xxe: scanMode(env.OPENCLAW_XXE_SCAN),
    },
    validatorModes: {
      securityValidatorMode: parseSecurityValidatorMode(env.OPENCLAW_SECURITY_VALIDATOR_MODE),
      securityReclassEnabled: (env.OPENCLAW_SECURITY_RECLASS ?? "").trim().toLowerCase() === "on",
      testsValidatorMode: parseTestsValidatorMode(env.OPENCLAW_TESTS_VALIDATOR_MODE),
      logicValidatorMode: parseLogicValidatorMode(env.OPENCLAW_LOGIC_VALIDATOR_MODE),
      logicRefutationMode: parseLogicRefutationMode(env.OPENCLAW_LOGIC_REFUTATION_MODE),
      refutationSurvivalMode: parseRefutationSurvivalMode(env.OPENCLAW_REFUTATION_SURVIVAL_MODE),
      logicClaimRefutationMode: parseLogicClaimRefutationMode(env.OPENCLAW_LOGIC_CLAIM_REFUTATION_MODE),
      logicClaimRefutationEnforceReasons: parseLogicClaimRefutationEnforceReasons(
        env.OPENCLAW_LOGIC_CLAIM_REFUTATION_ENFORCE_REASONS,
      ),
      perfValidatorMode: parsePerfValidatorMode(env.OPENCLAW_PERF_VALIDATOR_MODE),
      inlineGroundingValidatorMode: parseInlineGroundingValidatorMode(env.OPENCLAW_INLINE_GROUNDING_VALIDATOR_MODE),
      absenceClaimValidatorMode: parseAbsenceClaimValidatorMode(env.OPENCLAW_ABSENCE_CLAIM_VALIDATOR_MODE),
      windowBlindnessValidatorMode: parseWindowBlindnessValidatorMode(env.OPENCLAW_WINDOW_BLINDNESS_VALIDATOR_MODE),
      securityGroundingValidatorMode: parseSecurityGroundingValidatorMode(
        env.OPENCLAW_SECURITY_GROUNDING_VALIDATOR_MODE,
      ),
      securityUsageValidatorMode: parseSecurityUsageValidatorMode(env.OPENCLAW_SECURITY_USAGE_VALIDATOR_MODE),
    },
    flags: {
      // Raw pass-through / `=== "on"` flags: store the unparsed value so the call
      // site's own comparison stays byte-identical.
      ingestAiInstructions: env.OPENCLAW_INGEST_AI_INSTRUCTIONS,
      dynamicDispatcherMode: env.OPENCLAW_DYNAMIC_DISPATCHER_MODE,
      // Helper-normalized at the call site (shouldRunSymbolRetrieval /
      // shouldRunBranchAwareRetrieval) — branch-aware is read twice, so the raw
      // value keeps both sites identical.
      symbolRetrieval: env.OPENCLAW_SYMBOL_RETRIEVAL,
      branchAwareRetrieval: env.OPENCLAW_BRANCH_AWARE_RETRIEVAL,
      // Inline-normalized (default "off", trim + lowercase) — reuse `scanMode`.
      asymmetryHints: scanMode(env.OPENCLAW_ASYMMETRY_HINTS),
      toctouHints: scanMode(env.OPENCLAW_TOCTOU_HINTS),
      receiptJoinMode: parseReceiptJoinMode(env.OPENCLAW_RECEIPTJOIN_MODE),
      logicPromptBudgetMode: parseLogicPromptBudgetMode(env.OPENCLAW_LOGIC_PROMPT_BUDGET),
      // SIG-369(b): logic-input-composition telemetry mode (default off → no-op).
      logicInputCompositionMode: parseLogicInputCompositionMode(env.OPENCLAW_LOGIC_INPUT_COMPOSITION),
      synthRecovery: scanMode(env.OPENCLAW_SYNTH_RECOVERY),
      astEmitFloorMode: parseAstEmitFloorMode(env.OPENCLAW_AST_EMIT_FLOOR),
      trustLedgerMode: parseTrustLedgerMode(env.OPENCLAW_TRUST_LEDGER),
      reviewMemoryClaimShadowMode: resolveClaimShadowMode(env.OPENCLAW_REVIEW_MEMORY_CLAIM_SHADOW),
      reviewMemoryClaims: env.OPENCLAW_REVIEW_MEMORY_CLAIMS,
      precisionProfileMode: resolvePrecisionMode(env.OPENCLAW_PRECISION_PROFILE_MODE),
      reviewOutputSurface: parseReviewOutputSurface(env.OPENCLAW_REVIEW_OUTPUT_SURFACE),
      minSpecialistsEarlyExitMode: parseMinSpecialistsEarlyExitMode(env.OPENCLAW_MIN_SPECIALISTS_EARLY_EXIT),
      // The final flag reads (SIG-375). graphRetrieval is read into BOTH an
      // enabled-boolean and the effective mode (the two old helpers); the synth
      // bypass is a parsed boolean; the manifest kill-switch is a default-on
      // boolean (only `=== "off"` short-circuits — preserve the exact comparison).
      graphRetrievalEnabled: parseGraphRetrievalEnabled(env.OPENCLAW_GRAPH_RETRIEVAL),
      graphRetrievalMode: parseGraphRetrievalMode(env.OPENCLAW_GRAPH_RETRIEVAL),
      synthBypassEnabled: parseSynthBypassEnabled(env.OPENCLAW_SYNTH_BYPASS_ENABLED),
      reviewManifestEnabled: env.OPENCLAW_REVIEW_MANIFEST_ENABLED !== "off",
      // SIG-436: inline anchor-precision pass. Default OFF — only the literal
      // "on" (trim + lowercase) enables it; the inline-anchoring surface is LIVE
      // and a benchmark runs on prod, so this must not change posted anchors
      // until the K=12 exactness eval proves the lift.
      anchorPrecision: (env.OPENCLAW_ANCHOR_PRECISION ?? "").trim().toLowerCase() === "on",
      incrementalReviewMode: parseIncrementalReviewMode(env.OPENCLAW_INCREMENTAL_REVIEW_MODE),
      // SIG-452: adversarial-framing hardening (off → shadow → enforce). off/shadow
      // are byte-identical to today's output; enforce injects the inverted-inference
      // blocks. Default off.
      adversarialFramingMode: parseAdversarialFramingMode(env.OPENCLAW_ADVERSARIAL_FRAMING_MODE),
      // SIG-393: region re-sweep rollout flag (off → shadow → on).
      // SIG-392: recall-eliciting logic prompt (default off).
      recallRoles: buildRecallRoles(env),
      // SIG-399: per-role reasoning-process directive (default off → empty set).
      reasoningPromptRoles: buildReasoningPromptRoles(env),
      // SIG-287: per-role bounded reasoning (default off → empty map).
      reasoningByRole: buildReasoningByRole(env),
      resweepMode: parseResweepMode(env.OPENCLAW_RESWEEP_MODE),
      // SIG-395: invariant-lens rollout flag (off → shadow → on).
      invariantLensMode: parseInvariantLensMode(env.OPENCLAW_INVARIANT_LENS_MODE),
      invariantLensRecallContract: parseInvariantLensRecallContract(env.OPENCLAW_INVARIANT_LENS_RECALL_CONTRACT),
      // SIG-418 Phase 2 (Design B′): in-invocation multi-batch review rollout
      // flag (off → shadow → on). DARK in PR 1 — parsed but not yet read by the
      // orchestrator, so default off is byte-identical to today.
      multiBatchMode: parseMultiBatchMode(env.OPENCLAW_REVIEW_MULTIBATCH_MODE),
    },
    tunables: {
      maxRetrieveCallsPerPr: parseIntEnv(
        env.OPENCLAW_ENSEMBLE_MAX_RETRIEVE_CALLS_PER_PR,
        DEFAULT_MAX_RETRIEVE_CALLS_PER_PR,
      ),
      graphRpcTimeoutMs: parseIntEnv(env.OPENCLAW_GRAPH_RPC_TIMEOUT_MS, GRAPH_RPC_TIMEOUT_MS),
      resweepMaxRegions: parseIntEnv(env.OPENCLAW_RESWEEP_MAX_REGIONS, DEFAULT_RESWEEP_MAX_REGIONS),
      // SIG-417: the dark projected-cost governor. `enabled` defaults false →
      // capture + projection telemetry only, review byte-identical. `ceilingUsd`
      // is absent unless explicitly set.
      costGovernor: {
        enabled: env.OPENCLAW_COST_GOVERNOR_ENABLED === "on",
        ...(costGovernorCeilingUsd !== undefined ? { ceilingUsd: costGovernorCeilingUsd } : {}),
        minReviewedFiles: parseIntEnv(
          env.OPENCLAW_COST_GOVERNOR_MIN_REVIEWED_FILES,
          DEFAULT_COST_GOVERNOR_MIN_REVIEWED_FILES,
        ),
        perCallOverheadTokensEst: parseIntEnv(
          env.OPENCLAW_COST_GOVERNOR_PER_CALL_OVERHEAD_TOKENS_EST,
          DEFAULT_COST_GOVERNOR_PER_CALL_OVERHEAD_TOKENS_EST,
        ),
      },
    },
  }
}

// SIG-375 (SIG-318 env→Config): the env-taking flag wrappers. The src consumers
// now read `EnsembleConfig.flags.*`; these thin edge wrappers (re-exported via the
// god-file shim) keep the long-standing public helper names + their unit tests
// working without re-introducing an env read into the domain. Each delegates to
// the pure domain parser on the single OPENCLAW_ field it owns — byte-identical to
// the helper bodies that used to live in the domain.

/** Returns true when OPENCLAW_GRAPH_RETRIEVAL is "shadow" or "post". */
export function graphRetrievalEnabled(env: Env): boolean {
  return parseGraphRetrievalEnabled(env.OPENCLAW_GRAPH_RETRIEVAL)
}

/** Returns the effective graph-retrieval mode: "off" | "shadow" | "post". */
export function graphRetrievalMode(env: Env): "off" | "shadow" | "post" {
  return parseGraphRetrievalMode(env.OPENCLAW_GRAPH_RETRIEVAL)
}

/** Returns true when OPENCLAW_SYNTH_BYPASS_ENABLED is "on". */
export function isSynthBypassEnabled(env: Env): boolean {
  return parseSynthBypassEnabled(env.OPENCLAW_SYNTH_BYPASS_ENABLED)
}

/**
 * SIG-228 Phase 3c synth-bypass eligibility — env-taking wrapper around the pure
 * `isSynthBypassEligible(enabled, …)` domain predicate (the unit tests pin it via
 * this surface). Reads the flag once, then defers to the pure gate.
 */
export function isSynthBypassEligible(
  env: Env,
  dispatchedCount: number,
  candidates: ReadonlyArray<{ verdict: { findings: ReadonlyArray<{ score: number }> } | null }>,
): boolean {
  return isSynthBypassEligibleCore(
    parseSynthBypassEnabled(env.OPENCLAW_SYNTH_BYPASS_ENABLED),
    dispatchedCount,
    candidates,
  )
}
