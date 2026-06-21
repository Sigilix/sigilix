// ARC-156: vague-prefix filter (Greptile port A2).
//
// Two layers of coverage:
//   1. `hasVaguePrefix` pure unit tests — word-boundary matching,
//      headline OR body, case sensitivity, false-positive guards.
//   2. `validateForSubmission` integration — a vague-prefix finding
//      gets dropped, the `droppedForVaguePrefix` counter increments,
//      and the surviving findings flow through correctly.

import { describe, it, expect, vi } from "vitest"
import { hasVaguePrefix, validateForSubmission, VAGUE_PREFIXES } from "@/src/lib/triage-pr-review-ensemble"
import type { PrReviewFinding } from "@/src/lib/triage-pr-review"

function finding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "src/foo.ts",
    line: 1,
    score: 3,
    category: "logic",
    headline: "Some specific bug",
    body: "Real actionable explanation.",
    ...overrides,
  }
}

describe("VAGUE_PREFIXES constant", () => {
  it("includes exactly the 6 Greptile-spec words", () => {
    expect([...VAGUE_PREFIXES]).toEqual(["Ensure", "Verify", "Validate", "Consider", "Review", "Confirm"])
  })
})

describe("hasVaguePrefix", () => {
  it("returns false on a clean finding", () => {
    expect(hasVaguePrefix(finding())).toBe(false)
  })

  it("matches when headline starts with 'Ensure '", () => {
    expect(hasVaguePrefix(finding({ headline: "Ensure the user is authenticated" }))).toBe(true)
  })

  it("matches when body starts with 'Verify '", () => {
    expect(hasVaguePrefix(finding({ body: "Verify that the input is valid." }))).toBe(true)
  })

  it("matches when headline ends without a space (lone word)", () => {
    expect(hasVaguePrefix(finding({ headline: "Confirm" }))).toBe(true)
  })

  it("matches all 6 trigger words", () => {
    for (const word of VAGUE_PREFIXES) {
      expect(hasVaguePrefix(finding({ headline: `${word} something here` }))).toBe(true)
    }
  })

  it("matches with leading whitespace (trims before check)", () => {
    expect(hasVaguePrefix(finding({ headline: "   Ensure inputs are sanitized" }))).toBe(true)
  })

  // ── False-positive guards ─────────────────────────────────────

  it("does NOT match longer words that start with the prefix ('Ensures', 'Verifying')", () => {
    expect(hasVaguePrefix(finding({ headline: "Ensures backwards compatibility" }))).toBe(false)
    expect(hasVaguePrefix(finding({ headline: "Verifying access tokens at runtime" }))).toBe(false)
    expect(hasVaguePrefix(finding({ headline: "Validates input but skips length check" }))).toBe(false)
  })

  it("is case-sensitive: lowercase 'ensure' does NOT match", () => {
    // Greptile's spec uses capitalized prefixes. The LLM's most
    // common offending output is capitalized; lowercase suggests
    // the finding is mid-sentence and probably substantive.
    expect(hasVaguePrefix(finding({ headline: "ensure auth check is present" }))).toBe(false)
  })

  it("does NOT match when the prefix appears mid-string", () => {
    expect(hasVaguePrefix(finding({ headline: "Auth bug — must Ensure validation runs" }))).toBe(false)
  })

  it("does NOT match on empty headline + empty body", () => {
    expect(hasVaguePrefix(finding({ headline: "", body: "" }))).toBe(false)
  })

  it("matches when the prefix is followed by punctuation, not space", () => {
    expect(hasVaguePrefix(finding({ headline: "Consider: refactoring this" }))).toBe(true)
    expect(hasVaguePrefix(finding({ headline: "Review, then merge" }))).toBe(true)
  })

  // Sigilix + CodeRabbit catch on arc-156 PR: the boundary check
  // was originally narrowed to `[\s.,!?:;()]`, which missed common
  // separators like `-`, `/`, `"`, `'`, `[`. New regex uses \b
  // (word-boundary anchor) and matches the stated "non-letter"
  // contract. These cases should now drop.
  it("matches when the prefix is followed by a hyphen", () => {
    expect(hasVaguePrefix(finding({ headline: "Ensure-thing fix" }))).toBe(true)
  })

  it("matches when the prefix is followed by a slash", () => {
    expect(hasVaguePrefix(finding({ headline: "Verify/Validate the input" }))).toBe(true)
  })

  it("matches when the prefix is followed by a double-quote", () => {
    expect(hasVaguePrefix(finding({ headline: 'Ensure "the value" is set' }))).toBe(true)
  })

  it("matches when the prefix is followed by an open-bracket", () => {
    expect(hasVaguePrefix(finding({ headline: "Confirm[]: array bounds" }))).toBe(true)
  })

  it("does NOT match digit suffix that makes it a different identifier-like word", () => {
    // "Ensure2" is one identifier-like token; \b does not fire between
    // letters and digits since both are word chars. This is the
    // intentional carve-out — letters/digits/underscore stay grouped.
    expect(hasVaguePrefix(finding({ headline: "Ensure2 is a different word" }))).toBe(false)
  })
})

// ── Integration with validateForSubmission ────────────────────

import type { SynthesizerProvenance } from "@/src/lib/triage-pr-review-ensemble"
import type { ReviewableMap } from "@/src/shared/util/diff-positions"

function makeReviewable(): ReviewableMap {
  // All lines on the right side; deriveSide will return "RIGHT" for
  // any path/line pair in the map.
  return new Map([
    [
      "src/foo.ts",
      [
        { line: 1, side: "RIGHT" as const, position: 1 },
        { line: 2, side: "RIGHT" as const, position: 2 },
        { line: 3, side: "RIGHT" as const, position: 3 },
        { line: 10, side: "RIGHT" as const, position: 10 },
        { line: 20, side: "RIGHT" as const, position: 20 },
      ],
    ],
  ])
}

function makeSpecialistVerdicts(): Array<{
  role: "logic" | "security" | "performance" | "tests"
  verdict: { findings: Array<{ id: string }> } | null
}> {
  return [
    {
      role: "logic",
      verdict: { findings: [{ id: "logic-0" }, { id: "logic-1" }, { id: "logic-2" }] },
    },
  ]
}

describe("validateForSubmission — ARC-156 vague-prefix filter", () => {
  it("drops a finding whose headline starts with 'Ensure' and increments the counter", () => {
    const synthOutput = {
      verdict: {
        summary: "Test",
        confidence: 3,
        confidenceReason: "Test reason.",
        findings: [
          finding({
            headline: "Ensure the user input is validated before storing it",
            body: "The user input should be checked for SQL injection vectors.",
          }),
          finding({
            headline: "Off-by-one in pagination cursor",
            body: "`getNextPage(cursor)` uses < instead of <=.",
            line: 2,
          }),
        ],
      },
      provenance: {
        findings: [
          {
            sourceSpecialists: ["logic"],
            sourceFindingIds: ["logic-0"],
            action: "kept",
            verifiedViaRetrieval: false,
          },
          {
            sourceSpecialists: ["logic"],
            sourceFindingIds: ["logic-1"],
            action: "kept",
            verifiedViaRetrieval: false,
          },
        ],
        dropped: [],
        softened: [],
      } satisfies SynthesizerProvenance,
    }

    const specialistVerdicts = makeSpecialistVerdicts() as any
    const result = validateForSubmission({
      synthOutput,
      reviewable: makeReviewable(),
      specialistVerdicts,
    })

    expect(result.droppedForVaguePrefix).toBe(1)
    expect(result.droppedForHallucination).toBe(0)
    expect(result.droppedForInvalidLine).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
    expect(result.verdict.findings[0]!.headline).toContain("Off-by-one")
  })

  it("drops a finding whose BODY starts with a vague prefix (even when headline is clean)", () => {
    const synthOutput = {
      verdict: {
        summary: "Test",
        confidence: 3,
        confidenceReason: "Test reason.",
        findings: [
          finding({
            headline: "Pagination cursor logic",
            body: "Verify that the cursor handles the empty-page edge case.",
          }),
        ],
      },
      provenance: {
        findings: [
          {
            sourceSpecialists: ["logic"],
            sourceFindingIds: ["logic-0"],
            action: "kept",
            verifiedViaRetrieval: false,
          },
        ],
        dropped: [],
        softened: [],
      } satisfies SynthesizerProvenance,
    }

    const specialistVerdicts = makeSpecialistVerdicts() as any
    const result = validateForSubmission({
      synthOutput,
      reviewable: makeReviewable(),
      specialistVerdicts,
    })

    expect(result.droppedForVaguePrefix).toBe(1)
    expect(result.verdict.findings).toHaveLength(0)
  })

  it("preserves non-vague findings while filtering vague ones (mixed input)", () => {
    const synthOutput = {
      verdict: {
        summary: "Test",
        confidence: 3,
        confidenceReason: "Test reason.",
        findings: [
          finding({ headline: "Consider extracting this to a helper", line: 1 }),
          finding({
            headline: "Real bug: null deref on line 3",
            line: 3,
            body: "`x.field` will throw when `x` is null.",
          }),
          finding({ headline: "Validate the schema before parsing", line: 10 }),
        ],
      },
      provenance: {
        findings: [
          {
            sourceSpecialists: ["logic"],
            sourceFindingIds: ["logic-0"],
            action: "kept",
            verifiedViaRetrieval: false,
          },
          {
            sourceSpecialists: ["logic"],
            sourceFindingIds: ["logic-1"],
            action: "kept",
            verifiedViaRetrieval: false,
          },
          {
            sourceSpecialists: ["logic"],
            sourceFindingIds: ["logic-2"],
            action: "kept",
            verifiedViaRetrieval: false,
          },
        ],
        dropped: [],
        softened: [],
      } satisfies SynthesizerProvenance,
    }

    const specialistVerdicts = makeSpecialistVerdicts() as any
    const result = validateForSubmission({
      synthOutput,
      reviewable: makeReviewable(),
      specialistVerdicts,
    })

    expect(result.droppedForVaguePrefix).toBe(2)
    expect(result.verdict.findings).toHaveLength(1)
    expect(result.verdict.findings[0]!.headline).toContain("Real bug")
  })

  it("runs AFTER hallucination guard (attribution priority)", () => {
    // Finding whose headline is "Ensure ..." AND whose sourceIds are
    // hallucinated. Should be counted toward droppedForHallucination,
    // NOT droppedForVaguePrefix (the guard runs first).
    const synthOutput = {
      verdict: {
        summary: "Test",
        confidence: 3,
        confidenceReason: "Test reason.",
        findings: [finding({ headline: "Ensure the user is logged in" })],
      },
      provenance: {
        findings: [
          {
            sourceSpecialists: ["logic"],
            sourceFindingIds: ["logic-99"],
            action: "kept",
            verifiedViaRetrieval: false,
          }, // 99 not in validIds
        ],
        dropped: [],
        softened: [],
      } satisfies SynthesizerProvenance,
    }

    const specialistVerdicts = makeSpecialistVerdicts() as any
    const result = validateForSubmission({
      synthOutput,
      reviewable: makeReviewable(),
      specialistVerdicts,
    })

    expect(result.droppedForHallucination).toBe(1)
    expect(result.droppedForVaguePrefix).toBe(0)
  })

  it("runs BEFORE score-1 demotion (a vague score-1 is dropped, not advisory)", () => {
    const synthOutput = {
      verdict: {
        summary: "Test",
        confidence: 3,
        confidenceReason: "Test reason.",
        findings: [finding({ headline: "Verify if the logging is sufficient", score: 1 })],
      },
      provenance: {
        findings: [
          {
            sourceSpecialists: ["logic"],
            sourceFindingIds: ["logic-0"],
            action: "kept",
            verifiedViaRetrieval: false,
          },
        ],
        dropped: [],
        softened: [],
      } satisfies SynthesizerProvenance,
    }

    const specialistVerdicts = makeSpecialistVerdicts() as any
    const result = validateForSubmission({
      synthOutput,
      reviewable: makeReviewable(),
      specialistVerdicts,
    })

    expect(result.droppedForVaguePrefix).toBe(1)
    expect(result.demotedScore1).toBe(0)
    expect(result.verdict.findings).toHaveLength(0)
  })
})

// ── SIG-488 (recall #5): demote-instead-of-hard-drop for sev>=4 ──

describe("validateForSubmission — SIG-488 high-sev gate demote (recall #5)", () => {
  const highSevVague = () => ({
    verdict: {
      summary: "Test",
      confidence: 4,
      confidenceReason: "Test reason.",
      findings: [finding({ headline: "Ensure the admin check runs before the destructive delete", score: 5, line: 1 })],
    },
    provenance: {
      findings: [
        { sourceSpecialists: ["logic"], sourceFindingIds: ["logic-0"], action: "kept", verifiedViaRetrieval: false },
      ],
      dropped: [],
      softened: [],
    } satisfies SynthesizerProvenance,
  })
  const verdicts = () => makeSpecialistVerdicts() as any

  it("off (default): a sev>=4 vague-prefix finding still HARD-DROPS (byte-identical)", () => {
    const result = validateForSubmission({
      synthOutput: highSevVague(),
      reviewable: makeReviewable(),
      specialistVerdicts: verdicts(),
    })
    expect(result.droppedForVaguePrefix).toBe(1)
    expect(result.verdict.findings).toHaveLength(0)
  })

  it("on: a sev>=4 vague-prefix finding is DEMOTED to P2 (kept, score 3) not dropped", () => {
    const result = validateForSubmission({
      synthOutput: highSevVague(),
      reviewable: makeReviewable(),
      specialistVerdicts: verdicts(),
      highSevGateDemoteMode: "on",
    })
    expect(result.droppedForVaguePrefix).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
    expect(result.verdict.findings[0]!.headline).toContain("Ensure the admin check")
    expect(result.verdict.findings[0]!.score).toBe(3)
  })

  it("on: a LOW-sev (score 3) vague-prefix finding still drops (only sev>=4 is saved)", () => {
    const synthOutput = highSevVague()
    synthOutput.verdict.findings = [finding({ headline: "Consider extracting a helper here", score: 3, line: 1 })]
    const result = validateForSubmission({
      synthOutput,
      reviewable: makeReviewable(),
      specialistVerdicts: verdicts(),
      highSevGateDemoteMode: "on",
    })
    expect(result.droppedForVaguePrefix).toBe(1)
    expect(result.verdict.findings).toHaveLength(0)
  })

  it("shadow: a sev>=4 vague-prefix finding still DROPS but logs a would-save", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
    try {
      const result = validateForSubmission({
        synthOutput: highSevVague(),
        reviewable: makeReviewable(),
        specialistVerdicts: verdicts(),
        highSevGateDemoteMode: "shadow",
      })
      expect(result.droppedForVaguePrefix).toBe(1)
      expect(result.verdict.findings).toHaveLength(0)
      const ev = logSpy.mock.calls
        .map((c) => JSON.parse(c[0] as string))
        .find((e) => e.event === "pr-review-highsev-gate-demote")
      expect(ev).toMatchObject({ reason: "vague-prefix", mode: "shadow", saved: false, score: 5 })
    } finally {
      logSpy.mockRestore()
    }
  })
})
