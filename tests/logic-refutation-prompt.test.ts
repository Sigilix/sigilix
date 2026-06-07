// SIG-308 Phase 1 — pins the logic specialist's refute-first mandate, the
// `clearedLogicCandidates` output contract, the generalized
// `independentAssessment` (now also a logic confirmation), and the
// cleared-candidate exemplar that calibrates them. The behavioral fix — the
// model refrains from emitting a finding it can refute against an in-code
// mitigation — rides entirely on these prompt strings; if they regress, the
// self-refuting-finding FP class (PR #12 `sinceMs`) returns.

import { describe, expect, it } from "vitest"
import { SPECIALIST_PROMPTS } from "../src/prompts/pr-review-specialists"
import logicExamples from "../src/prompts/logic-examples.json"

describe("logic specialist prompt — SIG-308 refute-first contract", () => {
  const prompt = SPECIALIST_PROMPTS.logic

  it("instructs the analyst to refute a self-spotted concern against an existing guard before emitting", () => {
    expect(prompt).toMatch(/refute/i)
    expect(prompt).toMatch(/guard|clamp|bound/i)
  })

  // The [OUTPUT SCHEMA] template is shared across specialists, so the field
  // must be DECLARED in the example object (not just mentioned in prose) — an
  // undeclared field is silently dropped by constrained decoding (mirrors the
  // SIG-282 dismissedScanFacts reasoning).
  it("declares the clearedLogicCandidates sink in the output schema block", () => {
    expect(prompt).toContain("clearedLogicCandidates")
  })

  it("gates a clear on a concrete in-code mitigation (evidence-gated, recall-safe)", () => {
    expect(prompt).toMatch(/clearedLogicCandidates[\s\S]*?mitigation/)
  })

  it("annotates the clearedLogicCandidates sink as logic-specialist-only", () => {
    expect(prompt).toMatch(/clearedLogicCandidates[\s\S]*?LOGIC specialist only/)
  })

  it("generalizes independentAssessment to logic confirmations (why no existing guard prevents the bug)", () => {
    expect(prompt).toMatch(/independentAssessment[\s\S]*?category:"logic"/)
  })

  it("still embeds the logic few-shot exemplar block", () => {
    expect(prompt).toContain("LOGIC FEW-SHOT EXEMPLARS")
  })
})

describe("logic-examples.json — SIG-308 cleared-candidate exemplar", () => {
  it("includes the refuted-overflow cleared candidate (PR #12 clamp case)", () => {
    const cleared = logicExamples.examples.find((e) => e.id === "skip-overflow-refuted-by-clamp")
    expect(cleared).toBeTruthy()
    expect(cleared!.emit).toBe(false)
  })

  it("includes the substring-search skip exemplar for requirement-dependent UX semantics", () => {
    const cleared = logicExamples.examples.find((e) => e.id === "skip-substring-search-contract-absent")
    expect(cleared).toBeTruthy()
    expect(cleared!.emit).toBe(false)
    expect(cleared!.why).toContain("product semantics")
    expect(cleared!.why).toContain("visible contract")
  })

  it("stays balanced — still has >=3 EMIT and >=3 SKIP exemplars", () => {
    const good = logicExamples.examples.filter((e) => e.emit)
    const bad = logicExamples.examples.filter((e) => !e.emit)
    expect(good.length).toBeGreaterThanOrEqual(3)
    expect(bad.length).toBeGreaterThanOrEqual(3)
  })

  it("every example still has id, situation, why; emit examples carry a finding", () => {
    for (const ex of logicExamples.examples) {
      expect(ex.id).toBeTruthy()
      expect(ex.situation).toBeTruthy()
      expect(ex.why).toBeTruthy()
      if (ex.emit) expect(ex.finding).toBeTruthy()
    }
  })
})
