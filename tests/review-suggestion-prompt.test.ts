import { describe, expect, it } from "vitest"
import { SPECIALIST_PROMPTS, SYNTHESIZER_PROMPT } from "../src/prompts/pr-review-specialists"
import { PROMPT_VERSION } from "../src/prompts/pr-review"

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
  it("PROMPT_VERSION bumped to 7 (SIG-161 PR 4b: + per-finding confidence rubric)", () => {
    // History: SIG-110 3→4 (perf evidence); SIG-125 4→5 (suggestedReplacement);
    // SIG-162 5→6 (kind:"delete"); SIG-161 PR 4b 6→7 (confidence rubric in
    // SHARED_OUTPUT_INSTRUCTIONS).
    expect(PROMPT_VERSION).toBe("7")
  })
})
