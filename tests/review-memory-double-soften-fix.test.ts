// SIG-280 prereq: regression test for the live DOUBLE-SOFTEN bug.
//
// Background: review-memory soften lowers a matched finding by one tier.
// The renderer applies that deterministically (`Math.max(1, f.score - 1)`
// on a `softenedSet` match, in the ensemble handler). The SYNTHESIZER
// prompt ALSO used to instruct the model to "downgrade the finding's
// `score` by one tier". When the synth obeyed, the finding was softened
// TWICE (e.g. a P0 score-5 finding emitted at 4 by the synth, then
// decremented to 3 by the renderer) — a two-tier over-soften.
//
// The fix makes the RENDERER the single soften point: the synth emits the
// finding at its TRUE severity and only flags it in `provenance.softened[]`;
// the orchestrator applies the one-tier decrement. This also makes the
// pre-soften (source) tier recoverable from the emitted score — the
// prerequisite for the SIG-280 PR B P0/P1 floor.
//
// This is a prompt-wording fix, so the regression guard is on the prompt
// content + the PROMPT_VERSION bump (which marks prior-version reviews
// stale on deploy).

import { describe, it, expect } from "vitest"
import { SYNTHESIZER_PROMPT } from "../src/prompts/pr-review-specialists"
import { PROMPT_VERSION } from "../src/prompts/pr-review"

describe("SIG-280 prereq: double-soften fix (renderer-only soften)", () => {
  it("the synth prompt no longer instructs the model to downgrade the score itself", () => {
    // The exact old phrasing that caused the double-decrement.
    expect(SYNTHESIZER_PROMPT).not.toContain("downgrade the finding's `score` by one tier")
  })

  it("the synth prompt tells the model to emit TRUE severity + full body and defer soften to the orchestrator", () => {
    expect(SYNTHESIZER_PROMPT).toContain("do NOT lower the finding's `score` or shorten its `body` yourself")
    expect(SYNTHESIZER_PROMPT).toContain("The orchestrator applies any soften")
  })

  it("SIG-280 PR B: the synth prompt no longer instructs body-shortening (soften is the orchestrator's job)", () => {
    expect(SYNTHESIZER_PROMPT).not.toContain("shorten the `body` to at most 2 sentences")
  })

  it("still directs the synth to flag softened findings in provenance.softened[]", () => {
    // The orchestrator keys its single decrement off `provenance.softened[]`,
    // so the synth must still populate it.
    expect(SYNTHESIZER_PROMPT).toContain("provenance.softened[]")
  })

  it("bumps PROMPT_VERSION so prior-version reviews go stale on deploy", () => {
    expect(PROMPT_VERSION).toBe("19")
  })
})
