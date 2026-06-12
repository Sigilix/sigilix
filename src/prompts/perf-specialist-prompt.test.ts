// SIG-110 PR B — pins the perf few-shot library + the prompt/schema/
// synth wiring that the perf evidence gate (evaluatePerfFinding)
// depends on end-to-end.

import { describe, expect, it } from "vitest"
import { SPECIALIST_PROMPTS, SYNTHESIZER_PROMPT } from "@/src/prompts/pr-review-specialists"
import { RUNNER_TOOL_EVIDENCE_INSTRUCTIONS } from "@/src/prompts/specialists/shared"
import { PR_REVIEW_SCHEMA } from "@/src/shared/domain/schemas"
import { PROMPT_VERSION } from "@/src/prompts/pr-review"
import perfExamples from "@/src/prompts/perf-examples.json"

describe("perf-examples.json", () => {
  it("is versioned", () => {
    expect(perfExamples.version).toBe(1)
  })

  it("is balanced — has both EMIT (good) and SKIP (bad) exemplars", () => {
    const good = perfExamples.examples.filter((e) => e.emit)
    const bad = perfExamples.examples.filter((e) => !e.emit)
    expect(good.length).toBeGreaterThanOrEqual(3)
    expect(bad.length).toBeGreaterThanOrEqual(3)
  })

  it("every example has id, situation, why; emit examples carry a finding", () => {
    for (const ex of perfExamples.examples) {
      expect(ex.id).toBeTruthy()
      expect(ex.situation).toBeTruthy()
      expect(ex.why).toBeTruthy()
      if (ex.emit) expect(ex.finding).toBeTruthy()
    }
  })

  it("good score>=4 exemplars carry an evidence field (complexityEstimate or hotPathIdentifier)", () => {
    for (const ex of perfExamples.examples) {
      if (ex.emit && ex.finding && ex.finding.score >= 4) {
        const hasEvidence = "complexityEstimate" in ex.finding || "hotPathIdentifier" in ex.finding
        expect(hasEvidence, `exemplar ${ex.id} lacks perf evidence field`).toBe(true)
      }
    }
  })

  it("includes the budget-claim-without-measurement negative (Codex FP class)", () => {
    const budgetBad = perfExamples.examples.find((e) => e.id === "bad-budget-claim-no-measurement")
    expect(budgetBad).toBeTruthy()
    expect(budgetBad!.emit).toBe(false)
  })

  it("pins the SIG-342 membership-scan and serial-eval boundary exemplars", () => {
    const ids = new Set(perfExamples.examples.map((e) => e.id))
    expect(ids.has("good-direct-membership-scan")).toBe(true)
    expect(ids.has("good-production-serial-fanout-even-with-order-comment")).toBe(true)
    expect(ids.has("bad-intentional-live-eval-serial-loop")).toBe(true)
  })
})

describe("performance specialist prompt", () => {
  const prompt = SPECIALIST_PROMPTS.performance

  it("instructs emitting the perf evidence fields on score>=4", () => {
    expect(prompt).toContain("complexityEstimate")
    expect(prompt).toContain("hotPathIdentifier")
    expect(prompt).toContain("score >= 4")
  })

  it("explains the evaluatePerfFinding drop gate", () => {
    expect(prompt).toContain("evaluatePerfFinding")
    expect(prompt).toContain("DROPPED")
  })

  it("warns that perfBudgets are policy targets, not measurements", () => {
    expect(prompt).toMatch(/POLICY TARGETS|not measurements|not measured/i)
  })

  it("embeds the few-shot exemplar block", () => {
    expect(prompt).toContain("PERFORMANCE FEW-SHOT EXEMPLARS")
  })

  it("embeds the SIG-342 direct membership-scan and live-eval boundaries", () => {
    expect(prompt).toContain("return items.filter(item => others.some(other => other.id === item.id))")
    expect(prompt).toContain("tests/*.live.test.ts")
    expect(prompt).toContain("This exception does NOT apply to production request fan-out")
  })
})

describe("runner tool evidence prompt contract", () => {
  it("uses the shared runner tool evidence block as the single source of truth", () => {
    expect(RUNNER_TOOL_EVIDENCE_INSTRUCTIONS.length).toBeGreaterThan(100)
    for (const role of ["logic", "security", "performance", "tests"] as const) {
      expect(SPECIALIST_PROMPTS[role]).toContain(RUNNER_TOOL_EVIDENCE_INSTRUCTIONS)
    }
  })

  it("reaches every specialist so all routed runner findings are triaged consistently", () => {
    for (const role of ["logic", "security", "performance", "tests"] as const) {
      expect(SPECIALIST_PROMPTS[role]).toContain("RUNNER TOOL EVIDENCE")
      expect(SPECIALIST_PROMPTS[role]).toContain("source: deterministic-tool/<toolId>")
      expect(SPECIALIST_PROMPTS[role]).toContain("candidate evidence, not a final verdict")
      expect(SPECIALIST_PROMPTS[role]).toContain(
        "Do NOT suppress independent real bugs just because no tool emitted them",
      )
    }
  })

  it("tells specialists to inspect and refute tool-backed candidates before emitting", () => {
    const prompt = SPECIALIST_PROMPTS.logic
    expect(prompt).toContain("Use `rule_id`, `tool`, `source`, `path`, `message`, and `evidence`")
    expect(prompt).toContain("Inspect the visible diff/context before emitting")
    expect(prompt).toContain("Refute only with specific, verifiable evidence")
    expect(prompt).toContain("stay in your lane")
  })

  it("makes refutation proof-only and recall-safe when tool evidence is uncertain", () => {
    const prompt = SPECIALIST_PROMPTS.security
    expect(prompt).toContain("Refute only with specific, verifiable evidence from the visible code")
    expect(prompt).toContain("If you cannot prove it safe, emit it in your lane")
    expect(prompt).not.toContain("obvious safe cases")
    expect(prompt).toContain("documentation-only examples")
    expect(prompt).toContain("test fixture data that is not used by production")
    expect(prompt).toContain("Do NOT refute generated production code")
    expect(prompt).toContain("partially applies or is lower severity than reported")
    expect(prompt).toContain("emit it with an adjusted score")
  })

  it("prevents cross-domain runner findings from being dropped by mutual deferral", () => {
    const prompt = SPECIALIST_PROMPTS.performance
    expect(prompt).toContain("If a tool finding spans multiple domains")
    expect(prompt).toContain("emit when your specialist lens is a plausible primary lens")
    expect(prompt).toContain("When in doubt, emit rather than drop")
    expect(prompt).toContain("supplements, and does not override, the role-specific gates")
    expect(prompt).toContain("If you are certain it belongs entirely to another lane, skip it")
    expect(prompt).toContain("For the tests specialist, emit-rather-than-drop applies only to plausible testing gaps")
    expect(prompt).not.toContain("dead paths")
    expect(prompt).not.toContain("role-mismatched output")
  })

  it("keeps high-confidence deterministic tool findings from being discounted", () => {
    const prompt = SPECIALIST_PROMPTS.logic
    expect(prompt).toContain("High-confidence deterministic findings")
    expect(prompt).toContain("type, parse, syntax, or schema errors")
    expect(prompt).toContain("near-certain evidence of a tool-detected issue")
    expect(prompt).toContain("Even near-certain tool findings can be false positives")
    expect(prompt).toContain("verify the finding applies to the actual diff before emitting")
  })

  it("requires score adjustments to follow the role scoring rubric", () => {
    const prompt = SPECIALIST_PROMPTS.logic
    expect(prompt).toContain("Use your role's normal scoring rubric")
    expect(prompt).toContain("explain the adjustment in the finding body")
  })
})

describe("security specialist prompt — SIG-282 output fields", () => {
  const prompt = SPECIALIST_PROMPTS.security

  // The [OUTPUT SCHEMA] template (shared by all specialists) must DECLARE the
  // two SIG-282 fields, not just mention them in prose — the model anchors on
  // the example object, and both fields are only OPTIONAL in PR_REVIEW_SCHEMA,
  // so an undeclared field is silently dropped and Phase 2 telemetry goes dark.
  it("declares dismissedScanFacts and independentAssessment in the schema block", () => {
    expect(prompt).toContain("dismissedScanFacts")
    expect(prompt).toContain("independentAssessment")
  })

  it("keeps the analyst verify/refute mandate that drives those fields", () => {
    expect(prompt).toContain("VERIFY THEM LIKE AN ANALYST")
  })

  // The [OUTPUT SCHEMA] block is shared across specialists, so the field names
  // appear in every prompt; the SECURITY-only scoping is carried by the inline
  // annotation, not by structural exclusion. Pin the annotation so a future
  // edit can't quietly turn these into all-specialist fields.
  it("annotates both fields as security-specialist-only", () => {
    expect(prompt).toMatch(/dismissedScanFacts[\s\S]*?SECURITY specialist only/)
    expect(prompt).toMatch(/independentAssessment[\s\S]*?category:"security"/)
  })
})

describe("synthesizer prompt — perf field preservation", () => {
  it("preserves complexityEstimate + hotPathIdentifier from performance-* source findings", () => {
    expect(SYNTHESIZER_PROMPT).toContain("complexityEstimate")
    expect(SYNTHESIZER_PROMPT).toContain("hotPathIdentifier")
    expect(SYNTHESIZER_PROMPT).toContain("performance-*")
  })
})

describe("PR_REVIEW_SCHEMA — constrained decode surface", () => {
  it("lists the optional perf evidence fields so generation can emit them", () => {
    const props = PR_REVIEW_SCHEMA.properties.findings.items.properties as Record<string, unknown>
    expect(props.complexityEstimate).toEqual({ type: "string" })
    expect(props.hotPathIdentifier).toEqual({ type: "string" })
  })

  it("requires finding scope so constrained generation chooses the review surface", () => {
    const props = PR_REVIEW_SCHEMA.properties.findings.items.properties as Record<string, unknown>
    const required = PR_REVIEW_SCHEMA.properties.findings.items.required as readonly string[]
    expect(props.scope).toEqual({ type: "string", enum: ["line", "file", "pr", "comment"] })
    expect(required).toContain("scope")
  })

  it("lists structured finding detail fields and kind for constrained generation", () => {
    const props = PR_REVIEW_SCHEMA.properties.findings.items.properties as Record<string, unknown>
    expect(props.failureExample).toEqual({ type: "string" })
    expect(props.fixExample).toEqual({ type: "string" })
    expect(props.testGap).toEqual({ type: "string" })
    expect(props.kind).toEqual({
      type: "string",
      enum: ["delete", "replace", "insert", "describe"],
    })
  })
})

describe("PROMPT_VERSION", () => {
  it("is bumped to v31 for SIG-107 runner tool evidence instructions", () => {
    expect(Number(PROMPT_VERSION)).toBeGreaterThanOrEqual(31)
  })

  it("is at least 25 (SIG-342 bumped 24->25 for perf calibration)", () => {
    // SIG-110 bumped 3->4; SIG-125 bumped 4->5; SIG-162 bumped 5->6;
    // SIG-161 PR 4b bumped 6->7; SIG-342 bumped 24->25. Assert the
    // current value rather than
    // a frozen number so a legitimate later bump doesn't require
    // editing an unrelated specialist's test.
    expect(Number(PROMPT_VERSION)).toBeGreaterThanOrEqual(25)
  })
})

describe("SIG-176 synthesizer retrieval contract cleanup", () => {
  it("does not advertise a callable retrieval loop or dead provenance budget", () => {
    expect(SYNTHESIZER_PROMPT).not.toContain("retrieve_codebase")
    expect(SYNTHESIZER_PROMPT).not.toContain("retrievalCallsUsed")
    expect(SYNTHESIZER_PROMPT).not.toMatch(/per-PR retrieve budget/i)
  })

  it("tells synth to adjudicate from precomputed context only", () => {
    expect(SYNTHESIZER_PROMPT).toContain("CONFLICT ADJUDICATION")
    expect(SYNTHESIZER_PROMPT).toContain("precomputed context blocks")
    expect(SYNTHESIZER_PROMPT).toContain("[RETRIEVAL SNAPSHOT]")
    expect(SYNTHESIZER_PROMPT).toContain("[GRAPH CONTEXT]")
    expect(SYNTHESIZER_PROMPT).toContain("[TESTING EVIDENCE]")
  })
})

// SIG-161 PR 4b — confidence rubric embedded in SHARED_OUTPUT_INSTRUCTIONS.
// Every specialist sees the rubric because they all interpolate
// SHARED_OUTPUT_INSTRUCTIONS into their system prompt. Tests pin the
// substantive bands so a future copy edit doesn't silently weaken
// the calibration signal.
describe("SIG-161 confidence rubric (PR 4b)", () => {
  // Sample from each specialist prompt — they all share
  // SHARED_OUTPUT_INSTRUCTIONS so any one is sufficient as proof.
  const prompt = SPECIALIST_PROMPTS.logic

  it("introduces the rubric with the SIG-161 marker + scale framing", () => {
    expect(prompt).toContain("SIG-161 FINDING CONFIDENCE")
    expect(prompt).toContain("probability that an expert reviewer would label the finding a true positive")
  })

  it("defines all five bands explicitly (1..5)", () => {
    expect(prompt).toMatch(/- 5: A senior engineer would agree without needing to re-read the code/)
    expect(prompt).toMatch(/- 4: An engineer would agree after checking the cited line\(s\)/)
    expect(prompt).toMatch(/- 3: Borderline/)
    expect(prompt).toMatch(/- 2: You see a pattern that often indicates a problem/)
    expect(prompt).toMatch(/- 1: Speculative or stylistic/)
  })

  it("disambiguates confidence from score (severity) and self-reasoning", () => {
    expect(prompt).toContain("NOT your confidence in your own reasoning")
    expect(prompt).toContain("NOT severity")
  })

  it("warns against rounding up (catches the over-confidence FP class)", () => {
    expect(prompt).toContain("Do NOT round up")
  })

  it("reaches every specialist (rubric is in SHARED_OUTPUT_INSTRUCTIONS, not per-role)", () => {
    for (const role of ["logic", "security", "performance", "tests"] as const) {
      expect(SPECIALIST_PROMPTS[role]).toContain("SIG-161 FINDING CONFIDENCE")
    }
  })
})
