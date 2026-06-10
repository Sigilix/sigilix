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

import { parseSecurityValidatorMode } from "./domain/gates/validate-security-finding"
import { parseTestsValidatorMode } from "./domain/gates/validate-test-finding"
import { parseLogicValidatorMode } from "./domain/gates/validate-logic-finding"
import { parseLogicRefutationMode } from "./domain/gates/validate-logic-refutation"
import { parseRefutationSurvivalMode } from "./domain/gates/validate-refutation-survival"
import { parseLogicClaimRefutationMode } from "./domain/gates/validate-logic-claim-refutation"
import { parsePerfValidatorMode } from "./domain/gates/validate-perf-finding"
import { parseInlineGroundingValidatorMode } from "./domain/gates/validate-inline-grounding"
import { parseAbsenceClaimValidatorMode } from "./domain/gates/validate-absence-grounding"
import { parseWindowBlindnessValidatorMode } from "./domain/gates/validate-window-blindness"
import { parseSecurityGroundingValidatorMode } from "./domain/gates/validate-security-grounding"
import { parseSecurityUsageValidatorMode } from "./domain/gates/validate-security-usage"
import { parseReceiptJoinMode } from "../verification/verify-finding-receipt"
import { parseLogicPromptBudgetMode } from "../logic-prompt-budget"
import { parseAstEmitFloorMode } from "../degraded-finding-floor"
import { parseTrustLedgerMode } from "./domain/gates/trust-ledger-thread"
import { resolveClaimShadowMode } from "../review-memory/shadow-match"
import { resolvePrecisionMode } from "@/features/precision-profile"
import { parseReviewOutputSurface } from "../pr-review-check-run"
import { parseMinSpecialistsEarlyExitMode } from "./domain/policy"
import { GRAPH_RPC_TIMEOUT_MS } from "./domain/budget"
import {
  parseGraphRetrievalEnabled,
  parseGraphRetrievalMode,
} from "./domain/graph-context-format"
import { parseSynthBypassEnabled, isSynthBypassEligible as isSynthBypassEligibleCore } from "./domain/synth"
import type { Env } from "@/shared/types/env"
import type { AstScanMode, EnsembleConfig } from "./domain/config"

/** The structural subset of the Worker env that `parseEnsembleConfig` reads.
 *  Declared at the edge (it names framework/env details) — never in the domain. */
export interface EnsembleConfigEnv {
  // AST security-scan modes (PR 3)
  OPENCLAW_AUTHZ_IDOR_SCAN?: string | undefined
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
  OPENCLAW_TESTS_VALIDATOR_MODE?: string | undefined
  OPENCLAW_LOGIC_VALIDATOR_MODE?: string | undefined
  OPENCLAW_LOGIC_REFUTATION_MODE?: string | undefined
  OPENCLAW_REFUTATION_SURVIVAL_MODE?: string | undefined
  OPENCLAW_LOGIC_CLAIM_REFUTATION_MODE?: string | undefined
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
  // numeric tunables (PR 5c)
  OPENCLAW_ENSEMBLE_MAX_RETRIEVE_CALLS_PER_PR?: string | undefined
  OPENCLAW_GRAPH_RPC_TIMEOUT_MS?: string | undefined
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

// Pre-flight retrieval call-cap default (was god-file-local, SIG-318 PR 5c).
const DEFAULT_MAX_RETRIEVE_CALLS_PER_PR = 3

export function parseEnsembleConfig(env: EnsembleConfigEnv): EnsembleConfig {
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
      testsValidatorMode: parseTestsValidatorMode(env.OPENCLAW_TESTS_VALIDATOR_MODE),
      logicValidatorMode: parseLogicValidatorMode(env.OPENCLAW_LOGIC_VALIDATOR_MODE),
      logicRefutationMode: parseLogicRefutationMode(env.OPENCLAW_LOGIC_REFUTATION_MODE),
      refutationSurvivalMode: parseRefutationSurvivalMode(env.OPENCLAW_REFUTATION_SURVIVAL_MODE),
      logicClaimRefutationMode: parseLogicClaimRefutationMode(env.OPENCLAW_LOGIC_CLAIM_REFUTATION_MODE),
      perfValidatorMode: parsePerfValidatorMode(env.OPENCLAW_PERF_VALIDATOR_MODE),
      inlineGroundingValidatorMode: parseInlineGroundingValidatorMode(env.OPENCLAW_INLINE_GROUNDING_VALIDATOR_MODE),
      absenceClaimValidatorMode: parseAbsenceClaimValidatorMode(env.OPENCLAW_ABSENCE_CLAIM_VALIDATOR_MODE),
      windowBlindnessValidatorMode: parseWindowBlindnessValidatorMode(env.OPENCLAW_WINDOW_BLINDNESS_VALIDATOR_MODE),
      securityGroundingValidatorMode: parseSecurityGroundingValidatorMode(env.OPENCLAW_SECURITY_GROUNDING_VALIDATOR_MODE),
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
    },
    tunables: {
      maxRetrieveCallsPerPr: parseIntEnv(env.OPENCLAW_ENSEMBLE_MAX_RETRIEVE_CALLS_PER_PR, DEFAULT_MAX_RETRIEVE_CALLS_PER_PR),
      graphRpcTimeoutMs: parseIntEnv(env.OPENCLAW_GRAPH_RPC_TIMEOUT_MS, GRAPH_RPC_TIMEOUT_MS),
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
  return isSynthBypassEligibleCore(parseSynthBypassEnabled(env.OPENCLAW_SYNTH_BYPASS_ENABLED), dispatchedCount, candidates)
}
