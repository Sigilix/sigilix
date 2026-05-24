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

  it("requires finding scope so constrained generation chooses the review surface", () => {
    const props = PR_REVIEW_SCHEMA.properties.findings.items.properties as Record<string, unknown>
    const required = PR_REVIEW_SCHEMA.properties.findings.items.required as string[]
    expect(props.scope).toEqual({ type: "string", enum: ["line", "file", "pr", "comment"] })
    expect(required).toContain("scope")
  })
})

describe("PROMPT_VERSION", () => {
  it("is at least 4 (SIG-110 bumped 3->4; carried forward by later prompt changes)", () => {
    // SIG-110 bumped 3->4; SIG-125 bumped 4->5; SIG-162 bumped 5->6;
    // SIG-161 PR 4b bumped 6->7. Assert the current value rather than
    // a frozen number so a legitimate later bump doesn't require
    // editing an unrelated specialist's test.
    expect(Number(PROMPT_VERSION)).toBeGreaterThanOrEqual(4)
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
