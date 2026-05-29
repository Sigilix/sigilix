import { describe, expect, it } from "vitest"
import { SPECIALIST_PROMPTS, SYNTHESIZER_PROMPT } from "../src/prompts/pr-review-specialists"
import { PR_IMPROVE_PROMPT } from "../src/prompts/pr-improve"
import { PROMPT_VERSION, PR_REVIEW_PROMPT } from "../src/prompts/pr-review"

describe("SIG-125 suggestion prompt wiring", () => {
  it("output schema documents suggestedReplacement", () => {
    expect(SPECIALIST_PROMPTS.performance).toContain("suggestedReplacement")
    expect(SPECIALIST_PROMPTS.logic).toContain("suggestedReplacement")
  })
  it("instructs contiguous-only emission", () => {
    expect(SPECIALIST_PROMPTS.logic).toMatch(/contiguous/i)
  })
  it("synth preserves suggestedReplacement verbatim", () => {
    expect(SYNTHESIZER_PROMPT).toContain("suggestedReplacement")
    expect(SYNTHESIZER_PROMPT).toMatch(/PRESERVE VERBATIM/i)
  })
  // SIG-162 PR 5: the `kind` field is a new specialist output that drives
  // deletion-suggestion rendering. A prompt edit that accidentally
  // dropped it would silently break deletions (model wouldn't emit it,
  // parser falls back to the back-compat path). Pin both the specialist
  // emission side AND the synth preservation side so either drop is
  // caught at CI time.
  it("specialist output schema documents the `kind` field (SIG-162)", () => {
    expect(SPECIALIST_PROMPTS.logic).toContain('"kind"')
    expect(SPECIALIST_PROMPTS.performance).toContain('"kind"')
  })
  it("synth preserves the `kind` field verbatim (SIG-162)", () => {
    expect(SYNTHESIZER_PROMPT).toContain('"kind"')
    // The synth-side line also mentions PRESERVE VERBATIM next to the kind doc.
    expect(SYNTHESIZER_PROMPT).toMatch(/"kind"[\s\S]*?PRESERVE VERBATIM/i)
  })
  it("documents structured finding examples and preserves them through synthesis", () => {
    for (const field of ["failureExample", "fixExample", "testGap"]) {
      expect(SPECIALIST_PROMPTS.logic).toContain(`"${field}"`)
      expect(SYNTHESIZER_PROMPT).toContain(`"${field}"`)
    }
    expect(SPECIALIST_PROMPTS.logic).toMatch(/STRUCTURED FINDING DETAILS/i)
    expect(SPECIALIST_PROMPTS.logic).toMatch(/Do NOT put Markdown fences/i)
    expect(SYNTHESIZER_PROMPT).toMatch(/"failureExample"[\s\S]*?PRESERVE VERBATIM/i)
    expect(PR_REVIEW_PROMPT).toContain("Structured finding details")
    expect(PR_REVIEW_PROMPT).toContain("suggestedReplacement")
  })
  it("keeps point-fix anchors narrow instead of widening to the enclosing block (SIG-180)", () => {
    expect(SPECIALIST_PROMPTS.logic).toContain("ANCHOR SCOPE EXCEPTION")
    expect(SPECIALIST_PROMPTS.logic).toMatch(/point-fix[\s\S]*?startLine: null/i)
    expect(SPECIALIST_PROMPTS.logic).toMatch(/Do NOT widen a point-fix/i)
    expect(PR_REVIEW_PROMPT).toContain("Anchor scope exception: point-fix shapes")
    expect(PR_REVIEW_PROMPT).toMatch(/point-fix[\s\S]*?omitting `startLine`/i)
    expect(PR_REVIEW_PROMPT).toMatch(/Do NOT widen a point-fix/i)
  })
  it("documents finding review-surface scope (SIG-202)", () => {
    expect(SPECIALIST_PROMPTS.logic).toContain('"scope"')
    expect(SPECIALIST_PROMPTS.logic).toMatch(/REVIEW SURFACE SCOPE/i)
    expect(SYNTHESIZER_PROMPT).toMatch(/"scope"[\s\S]*?SIG-202/i)
    expect(PR_REVIEW_PROMPT).toContain("Finding scope")
    expect(PR_REVIEW_PROMPT).toMatch(/scope:"line"[\s\S]*?inline/i)
  })
  it("improve prompt explicitly permits empty deletion suggestions (SIG-142)", () => {
    expect(PR_IMPROVE_PROMPT).toMatch(/EMPTY[\s\S]*?```suggestion/i)
    expect(PR_IMPROVE_PROMPT).toMatch(/delete|deletion|remove/i)
    expect(PR_IMPROVE_PROMPT).not.toContain("only when it is still useful")
  })
  it("PROMPT_VERSION bumped to 12", () => {
    // History: SIG-110 3→4 (perf evidence); SIG-125 4→5 (suggestedReplacement);
    // SIG-162 5→6 (kind:"delete"); SIG-161 PR 4b 6→7 (confidence rubric);
    // SIG-180 7→8 (point-fix anchor scope exception);
    // SIG-176 8→9 (remove dead synth retrieve/provenance budget contract).
    // SIG-202 9→10 (finding scope decides inline vs body review surface).
    // Structured details 10→11 (structured proof/fix/test-gap finding fields).
    // SIG-280 prereq 11→12 (review-memory soften no longer pre-decrements
    // score in the synth — renderer is the single soften point; fixes the
    // double-soften).
    expect(PROMPT_VERSION).toBe("12")
  })
})
