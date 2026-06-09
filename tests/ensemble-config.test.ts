// SIG-318 (PR 3): EnsembleConfig parser — the typed, parse-once edge that
// replaces the inline `env.OPENCLAW_*` reads (the "env-reading traps"). This PR
// migrates the AST security-scan modes; the test pins the exact contract the old
// inline reads had — default "off", trim + lowercase — and that each env var maps
// to the correct scanner field (the one thing a 10-field parser can silently get
// wrong via copy-paste).

import { describe, it, expect } from "vitest"
import { parseEnsembleConfig } from "../src/lib/ensemble/config"
import { parseSecurityValidatorMode } from "../src/lib/validate-security-finding"
import { parseTestsValidatorMode } from "../src/lib/validate-test-finding"
import { parseLogicValidatorMode } from "../src/lib/validate-logic-finding"
import { parseLogicRefutationMode } from "../src/lib/validate-logic-refutation"
import { parseRefutationSurvivalMode } from "../src/lib/validate-refutation-survival"
import { parseLogicClaimRefutationMode } from "../src/lib/validate-logic-claim-refutation"
import { parsePerfValidatorMode } from "../src/lib/validate-perf-finding"
import { parseInlineGroundingValidatorMode } from "../src/lib/validate-inline-grounding"
import { parseAbsenceClaimValidatorMode } from "../src/lib/validate-absence-grounding"
import { parseWindowBlindnessValidatorMode } from "../src/lib/validate-window-blindness"
import { parseSecurityGroundingValidatorMode } from "../src/lib/validate-security-grounding"
import { parseSecurityUsageValidatorMode } from "../src/lib/validate-security-usage"
import { parseReceiptJoinMode } from "../src/lib/verification/verify-finding-receipt"
import { parseLogicPromptBudgetMode } from "../src/lib/logic-prompt-budget"
import { parseAstEmitFloorMode } from "../src/lib/degraded-finding-floor"
import { parseTrustLedgerMode } from "../src/lib/trust-ledger-thread"
import { resolveClaimShadowMode } from "../src/lib/review-memory/shadow-match"
import { resolvePrecisionMode } from "../src/lib/precision-profile/mode"
import { parseReviewOutputSurface } from "../src/lib/pr-review-check-run"

describe("SIG-318 parseEnsembleConfig — AST scan modes", () => {
  it("defaults every scanner to 'off' when the env var is absent", () => {
    expect(parseEnsembleConfig({}).astScanModes).toEqual({
      authzIdor: "off",
      weakRandom: "off",
      openRedirect: "off",
      ssrf: "off",
      pathTraversal: "off",
      sqlInjection: "off",
      ssti: "off",
      nosqlInjection: "off",
      protoPollution: "off",
      xxe: "off",
    })
  })

  it("normalizes each value with trim + lowercase (the old inline contract)", () => {
    const c = parseEnsembleConfig({ OPENCLAW_SSRF_SCAN: "  POST  ", OPENCLAW_XXE_SCAN: "Shadow" })
    expect(c.astScanModes.ssrf).toBe("post")
    expect(c.astScanModes.xxe).toBe("shadow")
  })

  it("maps each env var to the correct scanner field (no cross-wiring)", () => {
    // Distinct value per var so a swapped mapping is caught.
    expect(
      parseEnsembleConfig({
        OPENCLAW_AUTHZ_IDOR_SCAN: "post",
        OPENCLAW_WEAK_RANDOM_SCAN: "shadow",
        OPENCLAW_OPEN_REDIRECT_SCAN: "post",
        OPENCLAW_SSRF_SCAN: "shadow",
        OPENCLAW_PATH_TRAVERSAL_SCAN: "post",
        OPENCLAW_SQL_INJECTION_SCAN: "shadow",
        OPENCLAW_SSTI_SCAN: "post",
        OPENCLAW_NOSQL_INJECTION_SCAN: "shadow",
        OPENCLAW_PROTO_POLLUTION_SCAN: "post",
        OPENCLAW_XXE_SCAN: "shadow",
      }).astScanModes,
    ).toEqual({
      authzIdor: "post",
      weakRandom: "shadow",
      openRedirect: "post",
      ssrf: "shadow",
      pathTraversal: "post",
      sqlInjection: "shadow",
      ssti: "post",
      nosqlInjection: "shadow",
      protoPollution: "post",
      xxe: "shadow",
    })
  })

  it("treats explicit empty / whitespace-only as '' (not 'off') — matching the old inline read", () => {
    // `?? "off"` only defaults ABSENT (undefined) vars; an explicit "" or
    // whitespace normalizes to "" exactly as the pre-migration inline read did.
    // Downstream that reads as not-"post" → the scanner stays off, so behavior is
    // unchanged; this pins the distinction (absent → "off", but "" → "").
    const c = parseEnsembleConfig({ OPENCLAW_SSRF_SCAN: "", OPENCLAW_XXE_SCAN: "   " })
    expect(c.astScanModes.ssrf).toBe("")
    expect(c.astScanModes.xxe).toBe("")
  })
})

describe("SIG-318 parseEnsembleConfig — validator gate modes (PR 4)", () => {
  it("wires each validator env var to the correct mode field via its own parser (no cross-wire)", () => {
    // Distinct values per var so a swapped env-var OR a swapped parser is caught.
    // The expected side calls each parser directly, so this guards the wiring
    // without re-testing the parser internals (those have their own suites).
    const env = {
      OPENCLAW_SECURITY_VALIDATOR_MODE: "enforce",
      OPENCLAW_TESTS_VALIDATOR_MODE: "shadow",
      OPENCLAW_LOGIC_VALIDATOR_MODE: "enforce",
      OPENCLAW_LOGIC_REFUTATION_MODE: "shadow",
      OPENCLAW_REFUTATION_SURVIVAL_MODE: "enforce",
      OPENCLAW_LOGIC_CLAIM_REFUTATION_MODE: "shadow",
      OPENCLAW_PERF_VALIDATOR_MODE: "enforce",
      OPENCLAW_INLINE_GROUNDING_VALIDATOR_MODE: "shadow",
      OPENCLAW_ABSENCE_CLAIM_VALIDATOR_MODE: "enforce",
      OPENCLAW_WINDOW_BLINDNESS_VALIDATOR_MODE: "shadow",
      OPENCLAW_SECURITY_GROUNDING_VALIDATOR_MODE: "enforce",
      OPENCLAW_SECURITY_USAGE_VALIDATOR_MODE: "shadow",
    }
    expect(parseEnsembleConfig(env).validatorModes).toEqual({
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
    })
  })

  it("defaults every validator to its parser's default when the env var is absent", () => {
    // Parity with the AST-scan-modes default test. The validator parsers each have
    // their own default ("off"/"shadow"/…), so the expected side calls each parser
    // with `undefined` — this pins the full contract shape (a dropped or renamed
    // field fails `toEqual`) AND that the absent case routes through every parser.
    expect(parseEnsembleConfig({}).validatorModes).toEqual({
      securityValidatorMode: parseSecurityValidatorMode(undefined),
      testsValidatorMode: parseTestsValidatorMode(undefined),
      logicValidatorMode: parseLogicValidatorMode(undefined),
      logicRefutationMode: parseLogicRefutationMode(undefined),
      refutationSurvivalMode: parseRefutationSurvivalMode(undefined),
      logicClaimRefutationMode: parseLogicClaimRefutationMode(undefined),
      perfValidatorMode: parsePerfValidatorMode(undefined),
      inlineGroundingValidatorMode: parseInlineGroundingValidatorMode(undefined),
      absenceClaimValidatorMode: parseAbsenceClaimValidatorMode(undefined),
      windowBlindnessValidatorMode: parseWindowBlindnessValidatorMode(undefined),
      securityGroundingValidatorMode: parseSecurityGroundingValidatorMode(undefined),
      securityUsageValidatorMode: parseSecurityUsageValidatorMode(undefined),
    })
  })

  it("routes the raw env value through each parser (the edge does not pre-normalize)", () => {
    // Normalization (trim + lowercase) is the parser's job and has its own suite;
    // here we only guard that the edge hands the RAW, un-mangled env string to the
    // right parser — so a stray `.trim()` added in parseEnsembleConfig is caught.
    const env = { OPENCLAW_SECURITY_VALIDATOR_MODE: "  ENFORCE  ", OPENCLAW_LOGIC_VALIDATOR_MODE: "Shadow" }
    expect(parseEnsembleConfig(env).validatorModes.securityValidatorMode).toBe(parseSecurityValidatorMode("  ENFORCE  "))
    expect(parseEnsembleConfig(env).validatorModes.logicValidatorMode).toBe(parseLogicValidatorMode("Shadow"))
  })

  it("treats explicit empty / whitespace-only distinctly from absent (per-parser contract)", () => {
    // Absent (undefined) vs explicit "" / "   " can differ per parser; the edge must
    // forward the explicit value, not collapse it to the absent default.
    const c = parseEnsembleConfig({ OPENCLAW_SECURITY_VALIDATOR_MODE: "", OPENCLAW_LOGIC_VALIDATOR_MODE: "   " })
    expect(c.validatorModes.securityValidatorMode).toBe(parseSecurityValidatorMode(""))
    expect(c.validatorModes.logicValidatorMode).toBe(parseLogicValidatorMode("   "))
  })
})

describe("SIG-318 parseEnsembleConfig — feature flags / modes (PR 5b)", () => {
  it("wires each env var to the correct flag field via the SAME expression the old inline read used (no cross-wire)", () => {
    // Distinct values per var so a swapped env-var OR a swapped parser/strategy is
    // caught. The expected side reproduces the EXACT pre-migration read for each
    // field — parsed flags call the same parser, normalized flags reproduce the
    // inline `(x ?? "off").trim().toLowerCase()`, raw flags echo the env value.
    const env = {
      OPENCLAW_INGEST_AI_INSTRUCTIONS: "on",
      OPENCLAW_DYNAMIC_DISPATCHER_MODE: "shadow",
      OPENCLAW_SYMBOL_RETRIEVAL: "on",
      OPENCLAW_BRANCH_AWARE_RETRIEVAL: "ON",
      OPENCLAW_ASYMMETRY_HINTS: "  SHADOW  ",
      OPENCLAW_TOCTOU_HINTS: "On",
      OPENCLAW_RECEIPTJOIN_MODE: "enforce",
      OPENCLAW_LOGIC_PROMPT_BUDGET: "shadow",
      OPENCLAW_SYNTH_RECOVERY: "  ON  ",
      OPENCLAW_AST_EMIT_FLOOR: "shadow",
      OPENCLAW_TRUST_LEDGER: "on",
      OPENCLAW_REVIEW_MEMORY_CLAIM_SHADOW: "soften",
      OPENCLAW_REVIEW_MEMORY_CLAIMS: "on",
      OPENCLAW_PRECISION_PROFILE_MODE: "enforce",
      OPENCLAW_REVIEW_OUTPUT_SURFACE: "annotations",
    }
    // The inline normalizer the AST-scan / asymmetry / toctou / synth-recovery
    // reads used: default "off", trim, lowercase.
    const scanMode = (v: string | undefined): string => (v ?? "off").trim().toLowerCase()
    expect(parseEnsembleConfig(env).flags).toEqual({
      // raw pass-through (use site does its own comparison / forwards unparsed)
      ingestAiInstructions: env.OPENCLAW_INGEST_AI_INSTRUCTIONS,
      dynamicDispatcherMode: env.OPENCLAW_DYNAMIC_DISPATCHER_MODE,
      symbolRetrieval: env.OPENCLAW_SYMBOL_RETRIEVAL,
      branchAwareRetrieval: env.OPENCLAW_BRANCH_AWARE_RETRIEVAL,
      reviewMemoryClaims: env.OPENCLAW_REVIEW_MEMORY_CLAIMS,
      // inline-normalized (default "off", trim + lowercase)
      asymmetryHints: scanMode(env.OPENCLAW_ASYMMETRY_HINTS),
      toctouHints: scanMode(env.OPENCLAW_TOCTOU_HINTS),
      synthRecovery: scanMode(env.OPENCLAW_SYNTH_RECOVERY),
      // parsed via each field's own dedicated parser
      receiptJoinMode: parseReceiptJoinMode(env.OPENCLAW_RECEIPTJOIN_MODE),
      logicPromptBudgetMode: parseLogicPromptBudgetMode(env.OPENCLAW_LOGIC_PROMPT_BUDGET),
      astEmitFloorMode: parseAstEmitFloorMode(env.OPENCLAW_AST_EMIT_FLOOR),
      trustLedgerMode: parseTrustLedgerMode(env.OPENCLAW_TRUST_LEDGER),
      reviewMemoryClaimShadowMode: resolveClaimShadowMode(env.OPENCLAW_REVIEW_MEMORY_CLAIM_SHADOW),
      precisionProfileMode: resolvePrecisionMode(env.OPENCLAW_PRECISION_PROFILE_MODE),
      reviewOutputSurface: parseReviewOutputSurface(env.OPENCLAW_REVIEW_OUTPUT_SURFACE),
    })
  })

  it("defaults every flag the same way its old inline read defaulted when the env var is absent", () => {
    // Pins the full contract shape (a dropped/renamed field fails `toEqual`) AND
    // that the absent case routes through the right default per strategy: raw →
    // undefined, normalized → "off", parsed → the parser's own default.
    expect(parseEnsembleConfig({}).flags).toEqual({
      ingestAiInstructions: undefined,
      dynamicDispatcherMode: undefined,
      symbolRetrieval: undefined,
      branchAwareRetrieval: undefined,
      reviewMemoryClaims: undefined,
      asymmetryHints: "off",
      toctouHints: "off",
      synthRecovery: "off",
      receiptJoinMode: parseReceiptJoinMode(undefined),
      logicPromptBudgetMode: parseLogicPromptBudgetMode(undefined),
      astEmitFloorMode: parseAstEmitFloorMode(undefined),
      trustLedgerMode: parseTrustLedgerMode(undefined),
      reviewMemoryClaimShadowMode: resolveClaimShadowMode(undefined),
      precisionProfileMode: resolvePrecisionMode(undefined),
      reviewOutputSurface: parseReviewOutputSurface(undefined),
    })
  })

  it("normalizes the inline-normalized flags with trim + lowercase (the old inline contract)", () => {
    const c = parseEnsembleConfig({
      OPENCLAW_ASYMMETRY_HINTS: "  ON  ",
      OPENCLAW_TOCTOU_HINTS: "Shadow",
      OPENCLAW_SYNTH_RECOVERY: "  POST  ",
    }).flags
    expect(c.asymmetryHints).toBe("on")
    expect(c.toctouHints).toBe("shadow")
    expect(c.synthRecovery).toBe("post")
  })

  it("forwards the raw value un-mangled for the raw / `=== \"on\"` flags (no edge normalization)", () => {
    // These call sites do their own normalization (`shouldRunSymbolRetrieval`, the
    // inline `(x ?? "").trim().toLowerCase() === "on"`, `=== "on"`), so the edge
    // must hand them the RAW env string — a stray `.trim()` here would change
    // behavior. A whitespace-padded value must survive verbatim.
    const env = {
      OPENCLAW_INGEST_AI_INSTRUCTIONS: "  on  ",
      OPENCLAW_DYNAMIC_DISPATCHER_MODE: " enforce_rules ",
      OPENCLAW_SYMBOL_RETRIEVAL: "  ON ",
      OPENCLAW_BRANCH_AWARE_RETRIEVAL: " on ",
      OPENCLAW_REVIEW_MEMORY_CLAIMS: " on ",
    }
    const c = parseEnsembleConfig(env).flags
    expect(c.ingestAiInstructions).toBe(env.OPENCLAW_INGEST_AI_INSTRUCTIONS)
    expect(c.dynamicDispatcherMode).toBe(env.OPENCLAW_DYNAMIC_DISPATCHER_MODE)
    expect(c.symbolRetrieval).toBe(env.OPENCLAW_SYMBOL_RETRIEVAL)
    expect(c.branchAwareRetrieval).toBe(env.OPENCLAW_BRANCH_AWARE_RETRIEVAL)
    expect(c.reviewMemoryClaims).toBe(env.OPENCLAW_REVIEW_MEMORY_CLAIMS)
  })

  it("routes the raw env value through each parser (the edge does not pre-normalize parsed flags)", () => {
    // Normalization is each parser's own job (its own suite); here we only guard
    // that the edge hands the RAW string to the right parser, so a stray `.trim()`
    // added in parseEnsembleConfig is caught.
    const env = { OPENCLAW_RECEIPTJOIN_MODE: "  ENFORCE  ", OPENCLAW_TRUST_LEDGER: "On" }
    expect(parseEnsembleConfig(env).flags.receiptJoinMode).toBe(parseReceiptJoinMode("  ENFORCE  "))
    expect(parseEnsembleConfig(env).flags.trustLedgerMode).toBe(parseTrustLedgerMode("On"))
  })
})

describe("SIG-318 parseEnsembleConfig — numeric tunables (PR 5c)", () => {
  it("parses each tunable to an int and wires it to the correct field", () => {
    const c = parseEnsembleConfig({
      OPENCLAW_ENSEMBLE_MAX_RETRIEVE_CALLS_PER_PR: "7",
      OPENCLAW_GRAPH_RPC_TIMEOUT_MS: "1234",
    }).tunables
    expect(c.maxRetrieveCallsPerPr).toBe(7)
    expect(c.graphRpcTimeoutMs).toBe(1234)
  })

  it("defaults to the orchestrator's original constants when absent", () => {
    // 3 = DEFAULT_MAX_RETRIEVE_CALLS_PER_PR, 2500 = GRAPH_RPC_TIMEOUT_MS (both moved
    // out of the god-file). A drift in either default fails here.
    expect(parseEnsembleConfig({}).tunables).toEqual({
      maxRetrieveCallsPerPr: 3,
      graphRpcTimeoutMs: 2500,
    })
  })

  it("falls back to the default on non-numeric or negative values (parseIntEnv contract)", () => {
    const c = parseEnsembleConfig({
      OPENCLAW_ENSEMBLE_MAX_RETRIEVE_CALLS_PER_PR: "abc",
      OPENCLAW_GRAPH_RPC_TIMEOUT_MS: "-5",
    }).tunables
    expect(c.maxRetrieveCallsPerPr).toBe(3)
    expect(c.graphRpcTimeoutMs).toBe(2500)
  })

  it("allows an explicit 0 to propagate (the documented parseIntEnv contract)", () => {
    expect(
      parseEnsembleConfig({ OPENCLAW_ENSEMBLE_MAX_RETRIEVE_CALLS_PER_PR: "0" }).tunables.maxRetrieveCallsPerPr,
    ).toBe(0)
  })
})
