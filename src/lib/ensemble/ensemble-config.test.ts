// SIG-318 (PR 3): EnsembleConfig parser — the typed, parse-once edge that
// replaces the inline `env.OPENCLAW_*` reads (the "env-reading traps"). This PR
// migrates the AST security-scan modes; the test pins the exact contract the old
// inline reads had — default "off", trim + lowercase — and that each env var maps
// to the correct scanner field (the one thing a 10-field parser can silently get
// wrong via copy-paste).

import { describe, it, expect } from "vitest"
import { parseEnsembleConfig } from "@/src/lib/ensemble/config"
import { parseSecurityValidatorMode } from "@/src/lib/ensemble/domain/gates/validate-security-finding"
import { parseTestsValidatorMode } from "@/src/lib/ensemble/domain/gates/validate-test-finding"
import { parseLogicValidatorMode } from "@/src/lib/ensemble/domain/gates/validate-logic-finding"
import { parseLogicRefutationMode } from "@/src/lib/ensemble/domain/gates/validate-logic-refutation"
import { parseRefutationSurvivalMode } from "@/src/lib/ensemble/domain/gates/validate-refutation-survival"
import { parseLogicClaimRefutationMode } from "@/src/lib/ensemble/domain/gates/validate-logic-claim-refutation"
import { parsePerfValidatorMode } from "@/src/lib/ensemble/domain/gates/validate-perf-finding"
import { parseInlineGroundingValidatorMode } from "@/src/lib/ensemble/domain/gates/validate-inline-grounding"
import { parseAbsenceClaimValidatorMode } from "@/src/lib/ensemble/domain/gates/validate-absence-grounding"
import { parseWindowBlindnessValidatorMode } from "@/src/lib/ensemble/domain/gates/validate-window-blindness"
import { parseSecurityGroundingValidatorMode } from "@/src/lib/ensemble/domain/gates/validate-security-grounding"
import { parseSecurityUsageValidatorMode } from "@/src/lib/ensemble/domain/gates/validate-security-usage"
import { parseReceiptJoinMode } from "@/src/lib/verification/verify-finding-receipt"
import { parseSelfConfirmMode } from "@/src/lib/verification/confirm-finding-inworker"
import { parseReproduceMode } from "@/src/lib/verification/reproduce-eligibility"
import { parseLogicPromptBudgetMode } from "@/src/lib/logic-prompt-budget"
import { parseLogicInputCompositionMode } from "@/src/lib/ensemble/domain/logic-input-composition"
import { parseAstEmitFloorMode } from "@/src/lib/degraded-finding-floor"
import { parseTrustLedgerMode } from "@/src/lib/ensemble/domain/gates/trust-ledger-thread"
import { resolveClaimShadowMode } from "@/src/lib/review-memory/shadow-match"
import { resolvePrecisionMode } from "@/src/features/precision-profile"
import { parseReviewOutputSurface } from "@/src/lib/pr-review-check-run"
import { parseMinSpecialistsEarlyExitMode } from "@/src/lib/ensemble/domain/policy"
import { parseMultiBatchMode } from "@/src/lib/ensemble/domain/multibatch-budget"
import { parseIncrementalReviewMode } from "@/src/lib/ensemble/domain/incremental-coverage"
import { parseAdversarialFramingMode } from "@/src/lib/removed-guarding-tests"

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
      OPENCLAW_SECURITY_RECLASS: "on",
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
      securityReclassEnabled: true,
      testsValidatorMode: parseTestsValidatorMode(env.OPENCLAW_TESTS_VALIDATOR_MODE),
      logicValidatorMode: parseLogicValidatorMode(env.OPENCLAW_LOGIC_VALIDATOR_MODE),
      logicRefutationMode: parseLogicRefutationMode(env.OPENCLAW_LOGIC_REFUTATION_MODE),
      refutationSurvivalMode: parseRefutationSurvivalMode(env.OPENCLAW_REFUTATION_SURVIVAL_MODE),
      logicClaimRefutationMode: parseLogicClaimRefutationMode(env.OPENCLAW_LOGIC_CLAIM_REFUTATION_MODE),
      perfValidatorMode: parsePerfValidatorMode(env.OPENCLAW_PERF_VALIDATOR_MODE),
      inlineGroundingValidatorMode: parseInlineGroundingValidatorMode(env.OPENCLAW_INLINE_GROUNDING_VALIDATOR_MODE),
      absenceClaimValidatorMode: parseAbsenceClaimValidatorMode(env.OPENCLAW_ABSENCE_CLAIM_VALIDATOR_MODE),
      windowBlindnessValidatorMode: parseWindowBlindnessValidatorMode(env.OPENCLAW_WINDOW_BLINDNESS_VALIDATOR_MODE),
      securityGroundingValidatorMode: parseSecurityGroundingValidatorMode(
        env.OPENCLAW_SECURITY_GROUNDING_VALIDATOR_MODE,
      ),
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
      securityReclassEnabled: false,
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
    const env = {
      OPENCLAW_SECURITY_VALIDATOR_MODE: "  ENFORCE  ",
      OPENCLAW_LOGIC_VALIDATOR_MODE: "Shadow",
    }
    expect(parseEnsembleConfig(env).validatorModes.securityValidatorMode).toBe(
      parseSecurityValidatorMode("  ENFORCE  "),
    )
    expect(parseEnsembleConfig(env).validatorModes.logicValidatorMode).toBe(parseLogicValidatorMode("Shadow"))
  })

  it("treats explicit empty / whitespace-only distinctly from absent (per-parser contract)", () => {
    // Absent (undefined) vs explicit "" / "   " can differ per parser; the edge must
    // forward the explicit value, not collapse it to the absent default.
    const c = parseEnsembleConfig({
      OPENCLAW_SECURITY_VALIDATOR_MODE: "",
      OPENCLAW_LOGIC_VALIDATOR_MODE: "   ",
    })
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
      // SIG-476 PR2: in-worker self-confirmation gate (off|shadow|on).
      OPENCLAW_SELFCONFIRM_MODE: "shadow",
      // SIG-477 PR-1: execution-sandbox eligibility gate (off|shadow|on).
      OPENCLAW_REPRODUCE_MODE: "on",
      OPENCLAW_LOGIC_PROMPT_BUDGET: "shadow",
      // SIG-369(b): logic-input-composition telemetry flag (off|shadow).
      OPENCLAW_LOGIC_INPUT_COMPOSITION: "shadow",
      OPENCLAW_SYNTH_RECOVERY: "  ON  ",
      OPENCLAW_SYNTH_SOURCE_FLOOR_LOW: "shadow",
      OPENCLAW_SECURITY_KUNION: "shadow",
      OPENCLAW_GATE_DEMOTE_HIGH_SEV: "shadow",
      OPENCLAW_AST_EMIT_FLOOR: "shadow",
      OPENCLAW_TRUST_LEDGER: "on",
      OPENCLAW_REVIEW_MEMORY_CLAIM_SHADOW: "soften",
      OPENCLAW_REVIEW_MEMORY_CLAIMS: "on",
      OPENCLAW_PRECISION_PROFILE_MODE: "enforce",
      OPENCLAW_REVIEW_OUTPUT_SURFACE: "annotations",
      OPENCLAW_MIN_SPECIALISTS_EARLY_EXIT: "shadow",
      // SIG-375: the final three flag reads. graphRetrieval drives both the
      // enabled-boolean and the effective mode; bypass is `=== "on"`; manifest is
      // the default-on `!== "off"` kill-switch.
      OPENCLAW_GRAPH_RETRIEVAL: "shadow",
      OPENCLAW_SYNTH_BYPASS_ENABLED: "on",
      OPENCLAW_REVIEW_MANIFEST_ENABLED: "off",
      // SIG-393: region re-sweep rollout flag.
      OPENCLAW_RESWEEP_MODE: "Shadow",
      // SIG-395: invariant-lens rollout flag.
      OPENCLAW_INVARIANT_LENS_MODE: "ON",
      OPENCLAW_INVARIANT_LENS_RECALL_CONTRACT: "shadow-background",
      // SIG-418: in-invocation multi-batch review rollout flag (off|shadow|on).
      OPENCLAW_REVIEW_MULTIBATCH_MODE: "Shadow",
      // SIG-392: recall-eliciting logic prompt (=== "on").
      OPENCLAW_LOGIC_RECALL_MODE: "on",
      OPENCLAW_SECURITY_RECALL_MODE: "on",
      // SIG-399: reasoning-process directive flag (logic).
      OPENCLAW_LOGIC_REASONING_PROMPT_MODE: "on",
      // SIG-436: inline anchor-precision pass (=== "on").
      OPENCLAW_ANCHOR_PRECISION: "on",
      OPENCLAW_INCREMENTAL_REVIEW_MODE: "Shadow",
      // SIG-452: adversarial-framing rollout flag (off|shadow|enforce).
      OPENCLAW_ADVERSARIAL_FRAMING_MODE: "Enforce",
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
      synthSourceFloorLow: scanMode(env.OPENCLAW_SYNTH_SOURCE_FLOOR_LOW),
      securityKUnionMode: scanMode(env.OPENCLAW_SECURITY_KUNION),
      highSevGateDemoteMode: scanMode(env.OPENCLAW_GATE_DEMOTE_HIGH_SEV),
      // parsed via each field's own dedicated parser
      receiptJoinMode: parseReceiptJoinMode(env.OPENCLAW_RECEIPTJOIN_MODE),
      selfConfirmMode: parseSelfConfirmMode(env.OPENCLAW_SELFCONFIRM_MODE),
      reproduceMode: parseReproduceMode(env.OPENCLAW_REPRODUCE_MODE),
      logicPromptBudgetMode: parseLogicPromptBudgetMode(env.OPENCLAW_LOGIC_PROMPT_BUDGET),
      logicInputCompositionMode: parseLogicInputCompositionMode(env.OPENCLAW_LOGIC_INPUT_COMPOSITION),
      astEmitFloorMode: parseAstEmitFloorMode(env.OPENCLAW_AST_EMIT_FLOOR),
      trustLedgerMode: parseTrustLedgerMode(env.OPENCLAW_TRUST_LEDGER),
      reviewMemoryClaimShadowMode: resolveClaimShadowMode(env.OPENCLAW_REVIEW_MEMORY_CLAIM_SHADOW),
      precisionProfileMode: resolvePrecisionMode(env.OPENCLAW_PRECISION_PROFILE_MODE),
      reviewOutputSurface: parseReviewOutputSurface(env.OPENCLAW_REVIEW_OUTPUT_SURFACE),
      minSpecialistsEarlyExitMode: parseMinSpecialistsEarlyExitMode(env.OPENCLAW_MIN_SPECIALISTS_EARLY_EXIT),
      // SIG-375: reproduce the EXACT pre-migration reads byte-for-byte —
      // graphRetrievalEnabled was `v === "shadow" || v === "post"`, graphRetrievalMode
      // honored post (BLAST_RADIUS_RESOLUTION_READY is true), bypass was `=== "on"`,
      // manifest was the `!== "off"` kill-switch.
      graphRetrievalEnabled:
        scanMode(env.OPENCLAW_GRAPH_RETRIEVAL) === "shadow" || scanMode(env.OPENCLAW_GRAPH_RETRIEVAL) === "post",
      graphRetrievalMode: scanMode(env.OPENCLAW_GRAPH_RETRIEVAL),
      synthBypassEnabled: scanMode(env.OPENCLAW_SYNTH_BYPASS_ENABLED) === "on",
      reviewManifestEnabled: env.OPENCLAW_REVIEW_MANIFEST_ENABLED !== "off",
      resweepMode: scanMode(env.OPENCLAW_RESWEEP_MODE),
      invariantLensMode: scanMode(env.OPENCLAW_INVARIANT_LENS_MODE),
      invariantLensRecallContract: "shadow-background",
      multiBatchMode: parseMultiBatchMode(env.OPENCLAW_REVIEW_MULTIBATCH_MODE),
      anchorPrecision: env.OPENCLAW_ANCHOR_PRECISION === "on",
      incrementalReviewMode: parseIncrementalReviewMode(env.OPENCLAW_INCREMENTAL_REVIEW_MODE),
      adversarialFramingMode: parseAdversarialFramingMode(env.OPENCLAW_ADVERSARIAL_FRAMING_MODE),
      recallRoles: new Set(
        [
          env.OPENCLAW_LOGIC_RECALL_MODE === "on" ? "logic" : null,
          env.OPENCLAW_SECURITY_RECALL_MODE === "on" ? "security" : null,
        ].filter((r): r is "logic" | "security" => r !== null),
      ),
      // SIG-399: reasoning-process directive flag → logic (set "on" above).
      reasoningPromptRoles: new Set(["logic"]),
      // SIG-287: reasoning-on harness defaults EMPTY — this env block leaves
      // OPENCLAW_REASONING_MODE unset, so the per-role map stays empty (every
      // call is `think:false`, byte-identical to today). The dedicated
      // reasoning-parse suite below covers the populated cases.
      reasoningByRole: new Map(),
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
      synthSourceFloorLow: "off",
      securityKUnionMode: "off",
      highSevGateDemoteMode: "off",
      receiptJoinMode: parseReceiptJoinMode(undefined),
      selfConfirmMode: parseSelfConfirmMode(undefined),
      reproduceMode: parseReproduceMode(undefined),
      logicPromptBudgetMode: parseLogicPromptBudgetMode(undefined),
      logicInputCompositionMode: parseLogicInputCompositionMode(undefined),
      astEmitFloorMode: parseAstEmitFloorMode(undefined),
      trustLedgerMode: parseTrustLedgerMode(undefined),
      reviewMemoryClaimShadowMode: resolveClaimShadowMode(undefined),
      precisionProfileMode: resolvePrecisionMode(undefined),
      reviewOutputSurface: parseReviewOutputSurface(undefined),
      minSpecialistsEarlyExitMode: parseMinSpecialistsEarlyExitMode(undefined),
      // SIG-375: the final three flag reads. graphRetrieval defaults off (both the
      // enabled-boolean and the mode); the synth bypass defaults off; the manifest
      // kill-switch is default-ON (`undefined !== "off"` → true — only an explicit
      // "off" short-circuits the write).
      graphRetrievalEnabled: false,
      graphRetrievalMode: "off",
      synthBypassEnabled: false,
      reviewManifestEnabled: true,
      resweepMode: "off",
      invariantLensMode: "off",
      invariantLensRecallContract: "blocking",
      multiBatchMode: "off",
      anchorPrecision: false,
      incrementalReviewMode: "off",
      adversarialFramingMode: "off",
      recallRoles: new Set(),
      // SIG-399: reasoning-process directive default off → empty set.
      reasoningPromptRoles: new Set(),
      // SIG-287: reasoning-on harness defaults to an empty map (off).
      reasoningByRole: new Map(),
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

  it("threads the pending-check amendment contract through config without making it detachable", () => {
    expect(
      parseEnsembleConfig({ OPENCLAW_INVARIANT_LENS_RECALL_CONTRACT: " Pending-Check-Amendment " }).flags
        .invariantLensRecallContract,
    ).toBe("pending-check-amendment")
  })

  it('forwards the raw value un-mangled for the raw / `=== "on"` flags (no edge normalization)', () => {
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
    const env = {
      OPENCLAW_RECEIPTJOIN_MODE: "  ENFORCE  ",
      OPENCLAW_TRUST_LEDGER: "On",
      OPENCLAW_SELFCONFIRM_MODE: "  Shadow  ",
    }
    expect(parseEnsembleConfig(env).flags.receiptJoinMode).toBe(parseReceiptJoinMode("  ENFORCE  "))
    expect(parseEnsembleConfig(env).flags.trustLedgerMode).toBe(parseTrustLedgerMode("On"))
    expect(parseEnsembleConfig(env).flags.selfConfirmMode).toBe(parseSelfConfirmMode("  Shadow  "))
  })
})

describe("SIG-476 PR2 parseSelfConfirmMode (OPENCLAW_SELFCONFIRM_MODE)", () => {
  it("defaults to off when unset", () => {
    expect(parseSelfConfirmMode(undefined)).toBe("off")
    expect(parseEnsembleConfig({}).flags.selfConfirmMode).toBe("off")
  })

  it("parses off | shadow | on (trim + lowercase), everything else → off", () => {
    expect(parseSelfConfirmMode("off")).toBe("off")
    expect(parseSelfConfirmMode("  SHADOW  ")).toBe("shadow")
    expect(parseSelfConfirmMode("On")).toBe("on")
    expect(parseSelfConfirmMode("")).toBe("off")
    expect(parseSelfConfirmMode("enforce")).toBe("off") // not a valid value here
    expect(parseSelfConfirmMode("nonsense")).toBe("off")
  })
})

describe("SIG-477 PR-1 parseReproduceMode (OPENCLAW_REPRODUCE_MODE)", () => {
  it("defaults to off when unset", () => {
    expect(parseReproduceMode(undefined)).toBe("off")
    expect(parseEnsembleConfig({}).flags.reproduceMode).toBe("off")
  })

  it("parses off | shadow | on (trim + lowercase), everything else → off", () => {
    expect(parseReproduceMode("off")).toBe("off")
    expect(parseReproduceMode("  SHADOW  ")).toBe("shadow")
    expect(parseReproduceMode("On")).toBe("on")
    expect(parseReproduceMode("")).toBe("off")
    expect(parseReproduceMode("enforce")).toBe("off") // not a valid value here
    expect(parseReproduceMode("nonsense")).toBe("off")
  })

  it("wires OPENCLAW_REPRODUCE_MODE through to flags.reproduceMode", () => {
    expect(parseEnsembleConfig({ OPENCLAW_REPRODUCE_MODE: "shadow" }).flags.reproduceMode).toBe("shadow")
    expect(parseEnsembleConfig({ OPENCLAW_REPRODUCE_MODE: "  On  " }).flags.reproduceMode).toBe("on")
  })
})

describe("SIG-287 parseEnsembleConfig — reasoningByRole (reasoning-on harness)", () => {
  it("defaults to an empty map when OPENCLAW_REASONING_MODE is unset (byte-identical default-off)", () => {
    expect(parseEnsembleConfig({}).flags.reasoningByRole).toEqual(new Map())
  })

  it("stays empty when mode is unset even if roles/level are set (mode is the master switch)", () => {
    // The per-role + level vars are inert without the master switch on — so a
    // stale OPENCLAW_REASONING_ROLES can never silently enable reasoning.
    const c = parseEnsembleConfig({
      OPENCLAW_REASONING_ROLES: "security,logic",
      OPENCLAW_REASONING_LEVEL: "high",
    }).flags
    expect(c.reasoningByRole).toEqual(new Map())
  })

  it("stays empty when mode is explicitly off", () => {
    const c = parseEnsembleConfig({
      OPENCLAW_REASONING_MODE: "off",
      OPENCLAW_REASONING_ROLES: "security",
    }).flags
    expect(c.reasoningByRole).toEqual(new Map())
  })

  it("populates the listed roles at the default level 'high' when mode=on and no level set", () => {
    const c = parseEnsembleConfig({
      OPENCLAW_REASONING_MODE: "on",
      OPENCLAW_REASONING_ROLES: "security,tests",
    }).flags
    expect(c.reasoningByRole).toEqual(
      new Map([
        ["security", "high"],
        ["tests", "high"],
      ]),
    )
  })

  it("honors an explicit level for every enabled role", () => {
    const c = parseEnsembleConfig({
      OPENCLAW_REASONING_MODE: "on",
      OPENCLAW_REASONING_ROLES: "logic",
      OPENCLAW_REASONING_LEVEL: "medium",
    }).flags
    expect(c.reasoningByRole).toEqual(new Map([["logic", "medium"]]))
  })

  it("normalizes mode/roles/level with trim + lowercase and ignores unknown role tokens", () => {
    const c = parseEnsembleConfig({
      OPENCLAW_REASONING_MODE: "  ON  ",
      OPENCLAW_REASONING_ROLES: " Security , bogus , Tests ",
      OPENCLAW_REASONING_LEVEL: "  LOW ",
    }).flags
    // "bogus" is dropped; the two valid roles land at the normalized level.
    expect(c.reasoningByRole).toEqual(
      new Map([
        ["security", "low"],
        ["tests", "low"],
      ]),
    )
  })

  it("disables reasoning entirely (empty map) when an explicit level is invalid — never reaches the adapter's think", () => {
    // Codex sign-off: an arbitrary string must NOT flow into `think`. An
    // explicit-but-invalid level returns the empty map (off), not a partial
    // enablement at a bad level.
    const c = parseEnsembleConfig({
      OPENCLAW_REASONING_MODE: "on",
      OPENCLAW_REASONING_ROLES: "security",
      OPENCLAW_REASONING_LEVEL: "ultra",
    }).flags
    expect(c.reasoningByRole).toEqual(new Map())
  })

  // SIG-450: a token may carry a per-role override `role:level`; a bare role uses
  // the global default. This is the shipping shape (logic at high while tests stays
  // medium) for the Kimi logic flip.
  it("pins a per-role level via role:level while a bare role uses the global default (the SIG-450 logic-flip shape)", () => {
    const c = parseEnsembleConfig({
      OPENCLAW_REASONING_MODE: "on",
      OPENCLAW_REASONING_ROLES: "logic:high,tests",
      OPENCLAW_REASONING_LEVEL: "medium",
    }).flags
    expect(c.reasoningByRole).toEqual(
      new Map([
        ["logic", "high"],
        ["tests", "medium"],
      ]),
    )
  })

  it("honors distinct per-role levels for multiple roles", () => {
    const c = parseEnsembleConfig({
      OPENCLAW_REASONING_MODE: "on",
      OPENCLAW_REASONING_ROLES: "logic:high,security:low,tests:medium",
    }).flags
    expect(c.reasoningByRole).toEqual(
      new Map([
        ["logic", "high"],
        ["security", "low"],
        ["tests", "medium"],
      ]),
    )
  })

  it("DROPS only the token whose per-role level is invalid (no silent downgrade), keeping the rest", () => {
    // A per-role typo must not fall back to the default level — it drops that role
    // so a misconfig surfaces as missing reasoning, not quietly-wrong effort.
    const c = parseEnsembleConfig({
      OPENCLAW_REASONING_MODE: "on",
      OPENCLAW_REASONING_ROLES: "logic:ultra,tests",
      OPENCLAW_REASONING_LEVEL: "medium",
    }).flags
    expect(c.reasoningByRole).toEqual(new Map([["tests", "medium"]]))
  })

  it("trims + lowercases role:level tokens and ignores an unknown role with a level", () => {
    const c = parseEnsembleConfig({
      OPENCLAW_REASONING_MODE: "on",
      OPENCLAW_REASONING_ROLES: " Logic : HIGH , bogus:low , Tests ",
      OPENCLAW_REASONING_LEVEL: "medium",
    }).flags
    expect(c.reasoningByRole).toEqual(
      new Map([
        ["logic", "high"],
        ["tests", "medium"],
      ]),
    )
  })

  it("an invalid GLOBAL level still disables everything (empty map) even with a valid per-role token", () => {
    // The global guard is unchanged: a bad OPENCLAW_REASONING_LEVEL fails the whole
    // map closed, so a stale/garbage default can't leave a partial enablement.
    const c = parseEnsembleConfig({
      OPENCLAW_REASONING_MODE: "on",
      OPENCLAW_REASONING_ROLES: "logic:high",
      OPENCLAW_REASONING_LEVEL: "ultra",
    }).flags
    expect(c.reasoningByRole).toEqual(new Map())
  })
})

describe("SIG-399 parseEnsembleConfig — reasoningPromptRoles (logic reasoning directive flag)", () => {
  it("defaults to an empty set when OPENCLAW_LOGIC_REASONING_PROMPT_MODE is unset", () => {
    expect(parseEnsembleConfig({}).flags.reasoningPromptRoles).toEqual(new Set())
  })
  it('adds "logic" when OPENCLAW_LOGIC_REASONING_PROMPT_MODE === "on"', () => {
    expect(parseEnsembleConfig({ OPENCLAW_LOGIC_REASONING_PROMPT_MODE: "on" }).flags.reasoningPromptRoles).toEqual(
      new Set(["logic"]),
    )
  })
  it('stays empty for any value other than exactly "on" (e.g. "ON", "shadow") — mirrors recall-mode', () => {
    expect(parseEnsembleConfig({ OPENCLAW_LOGIC_REASONING_PROMPT_MODE: "ON" }).flags.reasoningPromptRoles).toEqual(
      new Set(),
    )
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
      // SIG-393: re-sweep region fan-out cap.
      resweepMaxRegions: 6,
      // SIG-417: the dark cost governor — default OFF, no ceiling (absent), floors.
      costGovernor: {
        enabled: false,
        minReviewedFiles: 1,
        perCallOverheadTokensEst: 4000,
      },
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

describe("SIG-417 parseEnsembleConfig — cost governor (dark by default)", () => {
  it("defaults the governor OFF with no ceiling and the floor defaults", () => {
    const g = parseEnsembleConfig({}).tunables.costGovernor
    expect(g.enabled).toBe(false)
    expect(g.ceilingUsd).toBeUndefined()
    expect(g.minReviewedFiles).toBe(1)
    expect(g.perCallOverheadTokensEst).toBe(4000)
  })

  it("enables only on the exact 'on' string", () => {
    expect(parseEnsembleConfig({ OPENCLAW_COST_GOVERNOR_ENABLED: "on" }).tunables.costGovernor.enabled).toBe(true)
    expect(parseEnsembleConfig({ OPENCLAW_COST_GOVERNOR_ENABLED: "true" }).tunables.costGovernor.enabled).toBe(false)
    expect(parseEnsembleConfig({ OPENCLAW_COST_GOVERNOR_ENABLED: "1" }).tunables.costGovernor.enabled).toBe(false)
    expect(parseEnsembleConfig({ OPENCLAW_COST_GOVERNOR_ENABLED: "ON" }).tunables.costGovernor.enabled).toBe(false)
  })

  it("parses a float ceiling in USD", () => {
    expect(parseEnsembleConfig({ OPENCLAW_COST_GOVERNOR_CEILING_USD: "0.35" }).tunables.costGovernor.ceilingUsd).toBe(
      0.35,
    )
  })

  it("treats a non-numeric or negative ceiling as ABSENT (never an accidental ceiling)", () => {
    expect(
      parseEnsembleConfig({ OPENCLAW_COST_GOVERNOR_CEILING_USD: "abc" }).tunables.costGovernor.ceilingUsd,
    ).toBeUndefined()
    expect(
      parseEnsembleConfig({ OPENCLAW_COST_GOVERNOR_CEILING_USD: "-1" }).tunables.costGovernor.ceilingUsd,
    ).toBeUndefined()
    expect(
      parseEnsembleConfig({ OPENCLAW_COST_GOVERNOR_CEILING_USD: "" }).tunables.costGovernor.ceilingUsd,
    ).toBeUndefined()
  })

  it("allows an explicit 0 ceiling (trim everything trimmable)", () => {
    expect(parseEnsembleConfig({ OPENCLAW_COST_GOVERNOR_CEILING_USD: "0" }).tunables.costGovernor.ceilingUsd).toBe(0)
  })

  it("parses the floor + overhead overrides", () => {
    const g = parseEnsembleConfig({
      OPENCLAW_COST_GOVERNOR_MIN_REVIEWED_FILES: "3",
      OPENCLAW_COST_GOVERNOR_PER_CALL_OVERHEAD_TOKENS_EST: "5500",
    }).tunables.costGovernor
    expect(g.minReviewedFiles).toBe(3)
    expect(g.perCallOverheadTokensEst).toBe(5500)
  })
})
