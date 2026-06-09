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
