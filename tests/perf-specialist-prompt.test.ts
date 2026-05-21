// SIG-110 PR B — pins the perf few-shot library + the prompt/schema/
// synth wiring that the perf evidence gate (evaluatePerfFinding)
// depends on end-to-end.

import { describe, expect, it } from "vitest"
import { SPECIALIST_PROMPTS, SYNTHESIZER_PROMPT } from "../src/prompts/pr-review-specialists"
import { PR_REVIEW_SCHEMA } from "../src/lib/schemas"
import { PROMPT_VERSION } from "../src/prompts/pr-review"
import perfExamples from "../src/prompts/perf-examples.json"

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
})

describe("PROMPT_VERSION", () => {
  it("is bumped to 4 for the SIG-110 perf prompt/schema/synth changes", () => {
    expect(PROMPT_VERSION).toBe("4")
  })
})
