// SIG-110 PR B — pins the perf few-shot library + the prompt/schema/
// synth wiring that the perf evidence gate (evaluatePerfFinding)
// depends on end-to-end.

import { describe, expect, it } from "vitest"
import { SPECIALIST_PROMPTS, SYNTHESIZER_PROMPT } from "@/prompts/pr-review-specialists"
import { PR_REVIEW_SCHEMA } from "@/shared/domain/schemas"
import { PROMPT_VERSION } from "@/prompts/pr-review"
import perfExamples from "@/prompts/perf-examples.json"

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
        const hasEvidence =
          "complexityEstimate" in ex.finding || "hotPathIdentifier" in ex.finding
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
    const required = PR_REVIEW_SCHEMA.properties.findings.items.required as string[]
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
