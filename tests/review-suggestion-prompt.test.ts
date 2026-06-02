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
  it("PROMPT_VERSION bumped to 17", () => {
    // History: SIG-110 3→4 (perf evidence); SIG-125 4→5 (suggestedReplacement);
    // SIG-162 5→6 (kind:"delete"); SIG-161 PR 4b 6→7 (confidence rubric);
    // SIG-180 7→8 (point-fix anchor scope exception);
    // SIG-176 8→9 (remove dead synth retrieve/provenance budget contract).
    // SIG-202 9→10 (finding scope decides inline vs body review surface).
    // Structured details 10→11 (structured proof/fix/test-gap finding fields).
    // SIG-280 prereq 11→12 (synth stops pre-decrementing score in the
    // system prompt — renderer single soften point).
    // SIG-280 PR B 12→13 (BOTH prompt sites: synth emits true severity +
    // full body and only flags provenance.softened[]; no score/body soften
    // — completes the double-soften fix render.ts missed + makes Phase-4
    // soften-gating hold).
    // SIG-245 13→14 (logic lens gains non-atomic RMW + cross-tier field-drift
    // focus bullets — the subtle-logic recall gap the benchmark surfaced).
    // SIG-309 PR2 14→15 (AST block emits unmatched deterministic_emit security
    // sinks — exec/spawn/TLS — through the grounding pipeline).
    // SIG-310 15→16 (deterministic_emit generalized role-aware: the logic-role
    // snake/camel-optional-alias type smell now emits too).
    // SIG-310 follow-up 16→17 (role-aware suppression: a different-role same-line
    // finding no longer suppresses a logic emit — CodeRabbit #294).
    // SIG-312 17→18 (deterministic_emit severity keys on the entry's `severity`:
    // a `warning` entry is a P2/P3 advisory never a P0/P1 blocker — lets the
    // dynamic-HTML-sink detector surface an XSS at P2 without a false P0/P1).
    expect(PROMPT_VERSION).toBe("18")
  })
})
