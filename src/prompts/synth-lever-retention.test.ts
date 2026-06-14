// SIG-392: synth retention of lever-recovered findings.
//
// The synth systematically merged-away single-source re-sweep/lens candidates
// (K=12 uncapped replay: b18 11→0, b4 9→1, b20 9→1) because nothing in its
// input distinguished them from pass-1 findings. The fix is a render-time
// `origin` marker on the synth-visible JSON plus a protected-recovery prompt
// rule. These tests pin both halves: the marker exists ONLY inside the
// rendered string (boundary-only — no domain type carries it), and the prompt
// rule + version bump ship together.

import { describe, expect, it } from "vitest"
import { PROMPT_VERSION } from "@/src/prompts/pr-review"
import { SYNTHESIZER_PROMPT, renderSpecialistVerdictsForSynth } from "@/src/prompts/pr-review-specialists"

const verdicts = [
  {
    role: "logic" as const,
    verdict: {
      summary: "s",
      confidence: 3,
      confidenceReason: "r",
      findings: [
        { id: "logic-0", path: "a.ts", line: 1, score: 4, category: "logic", headline: "pass-1", body: "b" },
        { id: "logic-1", path: "b.ts", line: 2, score: 5, category: "logic", headline: "resweep", body: "b" },
        { id: "logic-2", path: "c.ts", line: 3, score: 4, category: "logic", headline: "lens", body: "b" },
      ],
    },
  },
]

describe("SIG-392 lever-origin render annotation", () => {
  it("stamps origin onto mapped findings in the rendered JSON only", () => {
    const origins = new Map<string, "resweep" | "lens">([
      ["logic-1", "resweep"],
      ["logic-2", "lens"],
    ])
    const block = renderSpecialistVerdictsForSynth(verdicts, origins)
    const parsed = JSON.parse(block.replace("=== LOGIC ===\n", "")) as {
      findings: Array<{ id: string; origin?: string }>
    }
    expect(parsed.findings[0]).not.toHaveProperty("origin")
    expect(parsed.findings[1]?.origin).toBe("resweep")
    expect(parsed.findings[2]?.origin).toBe("lens")
    // boundary-only: the INPUT objects were not mutated
    expect(verdicts[0]!.verdict.findings[1]).not.toHaveProperty("origin")
    expect(verdicts[0]!.verdict.findings[2]).not.toHaveProperty("origin")
  })

  it("renders byte-identical output when the map is absent or empty (shadow/unlevered runs)", () => {
    const bare = renderSpecialistVerdictsForSynth(verdicts)
    expect(renderSpecialistVerdictsForSynth(verdicts, new Map())).toBe(bare)
    expect(renderSpecialistVerdictsForSynth(verdicts, undefined)).toBe(bare)
    expect(bare).not.toContain('"origin"')
  })
})

describe("SIG-392 protected-recovery prompt rule", () => {
  it("ships the lever-recovered section with the score>=4 protection contract", () => {
    expect(SYNTHESIZER_PROMPT).toContain('LEVER-RECOVERED FINDINGS (origin: "resweep" | "lens")')
    expect(SYNTHESIZER_PROMPT).toContain(
      "Do NOT drop an origin-tagged score>=4 finding via ranking, ordering, or summary-level judgment",
    )
    expect(SYNTHESIZER_PROMPT).toContain(
      "The ONLY drop path for an origin-tagged score>=4 finding is DETECTED-IMPOSSIBLE with quoted evidence",
    )
    // self-conditional: inert when no input finding carries origin
    expect(SYNTHESIZER_PROMPT).toContain(
      "When no source finding carries an `origin` field, this section does not apply",
    )
    // output hygiene: the model must not echo origin (format-drift guard)
    expect(SYNTHESIZER_PROMPT).toContain("Do NOT copy the `origin` field into your output findings")
  })

  it("SIG-406: ships the recall RETENTION DIRECTIVE (carry forward every grounded finding)", () => {
    expect(SYNTHESIZER_PROMPT).toContain("RETENTION DIRECTIVE (recall)")
    expect(SYNTHESIZER_PROMPT).toContain("carry forward EVERY distinct grounded specialist finding of score >= 2")
  })

  it("rode in with the v30 prompt version bump", () => {
    expect(Number(PROMPT_VERSION)).toBeGreaterThanOrEqual(30)
  })
})

describe("SIG-392 coverage-observation aggregation prompt rule", () => {
  it("merges 2+ pure coverage stamps into one pr-scope finding, never mechanism-naming ones", () => {
    expect(SYNTHESIZER_PROMPT).toContain('COVERAGE-OBSERVATION AGGREGATION (category: "testing")')
    expect(SYNTHESIZER_PROMPT).toContain("merge them into ONE finding instead of emitting one stamp per file")
    // determinism (Kimi addendum sign-off conditions): stable ordering + tiebreak
    expect(SYNTHESIZER_PROMPT).toContain("lists ALL merged source ids in ascending order")
    expect(SYNTHESIZER_PROMPT).toContain("`score` = the highest score among the merged sources")
    // the guardrails: singletons untouched, mechanism-naming findings never absorbed
    expect(SYNTHESIZER_PROMPT).toContain("A SINGLE coverage observation stays as-is")
    expect(SYNTHESIZER_PROMPT).toContain("NEVER aggregate a testing finding that names a concrete failure mechanism")
  })
})
