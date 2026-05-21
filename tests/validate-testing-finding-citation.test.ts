// SIG-113: testing-finding citation gate tests.
//
// Two layers of coverage:
//   1. `evaluateTestingFindingCitation` pure unit tests — the gate
//      decision per (finding shape, pack presence/shape).
//   2. `validateForSubmission` integration — a non-citing testing
//      finding gets dropped, the `droppedForUncitedTestingEvidence`
//      counter increments, and the onTestingFindingDropped callback
//      fires with the right structured info.

import { describe, it, expect, vi } from "vitest"
import {
  evaluateTestingFindingCitation,
  validateForSubmission,
} from "../src/lib/triage-pr-review-ensemble"
import type { PrReviewFinding } from "../src/lib/triage-pr-review"
import type { TestingEvidencePack } from "../src/lib/testing-evidence-pack"
import type { SynthesizerProvenance } from "../src/lib/synth-output-schema"
import type { ReviewableMap } from "../src/lib/diff-positions"

function finding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "src/lib/foo.ts",
    line: 1,
    score: 3,
    category: "testing",
    headline: "Module ships without tests",
    body: "There is no test for this new function.",
    ...overrides,
  }
}

function pack(overrides: Partial<TestingEvidencePack> = {}): TestingEvidencePack {
  return {
    sourceFilesChanged: ["src/lib/foo.ts"],
    testFilesChanged: ["tests/foo.test.ts"],
    testFilesInPromptDiff: ["tests/foo.test.ts"],
    testFilesNotInPromptDiff: [],
    siblingMappings: [{ source: "src/lib/foo.ts", test: "tests/foo.test.ts" }],
    inspectedTestFiles: ["tests/foo.test.ts"],
    helperCoverageBySource: {},
    ...overrides,
  }
}

describe("evaluateTestingFindingCitation", () => {
  // The shared `pack()` helper has:
  //   inspectedTestFiles: ["tests/foo.test.ts"]
  //   siblingMappings: [{ source: "src/lib/foo.ts", test: "tests/foo.test.ts" }]
  // → real mapping ref = "siblingMapping:src/lib/foo.ts->tests/foo.test.ts"
  //   real inspected path = "tests/foo.test.ts"

  it("non-testing findings always pass (gate only applies to category='testing')", () => {
    const r = evaluateTestingFindingCitation(finding({ category: "logic" }), pack())
    expect(r.keep).toBe(true)
  })

  it("returns keep when pack is undefined (back-compat: no evidence to gate on)", () => {
    const r = evaluateTestingFindingCitation(finding(), undefined)
    expect(r.keep).toBe(true)
  })

  it("keeps when inspectedTestFiles cites a path that IS in the pack", () => {
    const r = evaluateTestingFindingCitation(
      finding({ inspectedTestFiles: ["tests/foo.test.ts"] }),
      pack(),
    )
    expect(r.keep).toBe(true)
  })

  // CodeRabbit PR #112 (Major): a fabricated inspected path must NOT
  // pass — the citation is cross-checked against the pack.
  it("DROPS when inspectedTestFiles cites a path NOT in the pack (anti-fabrication)", () => {
    const r = evaluateTestingFindingCitation(
      finding({ inspectedTestFiles: ["tests/totally-made-up.test.ts"] }),
      pack(),
    )
    expect(r.keep).toBe(false)
  })

  it("keeps when evidenceRefs cites a siblingMapping that MATCHES the pack AND is relevant to finding.path", () => {
    const r = evaluateTestingFindingCitation(
      finding({ path: "src/lib/foo.ts", evidenceRefs: ["siblingMapping:src/lib/foo.ts->tests/foo.test.ts"] }),
      pack(),
    )
    expect(r.keep).toBe(true)
  })

  // CodeRabbit PR #112 round 2 (Major): relevance enforcement. A real
  // mapping for an UNRELATED file must not let a finding about a
  // different file bypass the gate.
  it("DROPS when the cited siblingMapping is real but UNRELATED to finding.path", () => {
    const r = evaluateTestingFindingCitation(
      finding({
        path: "src/lib/foo.ts",
        // bar.ts->NONE is a real mapping in the pack below, but this
        // finding is about foo.ts — irrelevant citation.
        evidenceRefs: ["siblingMapping:src/lib/bar.ts->NONE"],
      }),
      pack({
        sourceFilesChanged: ["src/lib/foo.ts", "src/lib/bar.ts"],
        siblingMappings: [
          { source: "src/lib/foo.ts", test: "tests/foo.test.ts" },
          { source: "src/lib/bar.ts", test: null },
        ],
      }),
    )
    expect(r.keep).toBe(false)
  })

  it("keeps when evidenceRefs cites a real ->NONE mapping relevant to finding.path", () => {
    const r = evaluateTestingFindingCitation(
      // finding.path must equal the mapping's source (relevance).
      finding({ path: "src/lib/bar.ts", evidenceRefs: ["siblingMapping:src/lib/bar.ts->NONE"] }),
      pack({
        sourceFilesChanged: ["src/lib/foo.ts", "src/lib/bar.ts"],
        siblingMappings: [
          { source: "src/lib/foo.ts", test: "tests/foo.test.ts" },
          { source: "src/lib/bar.ts", test: null },
        ],
      }),
    )
    expect(r.keep).toBe(true)
  })

  it("keeps when evidenceRefs cites testFileChanged: for a deleted/renamed test (CodeRabbit PR #112 round 2)", () => {
    const r = evaluateTestingFindingCitation(
      finding({
        path: "src/lib/foo.ts",
        headline: "PR deletes tests/foo.test.ts, removing coverage for foo()",
        evidenceRefs: ["testFileChanged:tests/foo.test.ts"],
      }),
      pack(), // tests/foo.test.ts IS in testFilesChanged
    )
    expect(r.keep).toBe(true)
  })

  it("DROPS testFileChanged: citing a path NOT in the PR's changed test set", () => {
    const r = evaluateTestingFindingCitation(
      finding({ evidenceRefs: ["testFileChanged:tests/never-existed.test.ts"] }),
      pack(),
    )
    expect(r.keep).toBe(false)
  })

  // CodeRabbit PR #112 (Major): the original FP pattern — model claims
  // "src/lib/foo.ts->NONE" but the pack shows foo.ts HAS a sibling. The
  // fabricated mapping must be rejected.
  it("DROPS when evidenceRefs cites a siblingMapping that CONTRADICTS the pack (->NONE for a file that has a sibling)", () => {
    const r = evaluateTestingFindingCitation(
      finding({ evidenceRefs: ["siblingMapping:src/lib/foo.ts->NONE"] }),
      pack(), // foo.ts -> tests/foo.test.ts in this pack, so ->NONE is a lie
    )
    expect(r.keep).toBe(false)
  })

  it("keeps when evidenceRefs uses the inspectedTestFile: prefix on a real path", () => {
    const r = evaluateTestingFindingCitation(
      finding({ evidenceRefs: ["inspectedTestFile:tests/foo.test.ts"] }),
      pack(),
    )
    expect(r.keep).toBe(true)
  })

  it("DROPS when evidenceRefs uses inspectedTestFile: on a path NOT in the pack", () => {
    const r = evaluateTestingFindingCitation(
      finding({ evidenceRefs: ["inspectedTestFile:tests/fake.test.ts"] }),
      pack(),
    )
    expect(r.keep).toBe(false)
  })

  it("returns drop with no-citation reason when neither cited", () => {
    const r = evaluateTestingFindingCitation(finding(), pack())
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("no-citation")
  })

  it("drops when inspectedTestFiles is an empty array + no evidenceRefs", () => {
    const r = evaluateTestingFindingCitation(
      finding({ inspectedTestFiles: [] }),
      pack(),
    )
    expect(r.keep).toBe(false)
  })

  it("drops when evidenceRefs has an unrecognized-prefix ref that maps to nothing", () => {
    const r = evaluateTestingFindingCitation(
      finding({ evidenceRefs: ["randomRef:foo", "another:bar"] }),
      pack(),
    )
    expect(r.keep).toBe(false)
  })

  it("tolerates whitespace around a REAL evidenceRefs entry", () => {
    const r = evaluateTestingFindingCitation(
      finding({ evidenceRefs: ["  siblingMapping:src/lib/foo.ts->tests/foo.test.ts  "] }),
      pack(),
    )
    expect(r.keep).toBe(true)
  })

  it("ignores non-string evidenceRefs entries but still validates the real one (defensive)", () => {
    const r = evaluateTestingFindingCitation(
      finding({
        // @ts-expect-error — runtime guard against schema-bypass
        evidenceRefs: [42, null, "siblingMapping:src/lib/foo.ts->tests/foo.test.ts"],
      }),
      pack(),
    )
    expect(r.keep).toBe(true)
  })
})

// ── Integration with validateForSubmission ──────────────────────

function makeReviewable(): ReviewableMap {
  return new Map([
    [
      "src/lib/foo.ts",
      [
        { line: 1, side: "RIGHT" as const, position: 1 },
        { line: 2, side: "RIGHT" as const, position: 2 },
      ],
    ],
  ])
}

function makeSpecialistVerdicts(): Array<{
  role: "logic" | "security" | "performance" | "tests"
  verdict: { findings: Array<{ id: string }> } | null
}> {
  return [
    { role: "tests", verdict: { findings: [{ id: "tests-0" }, { id: "tests-1" }] } },
    { role: "logic", verdict: { findings: [{ id: "logic-0" }] } },
  ]
}

function makeProvenance(count: number, sourceId = "tests-0"): SynthesizerProvenance {
  const findings = Array.from({ length: count }, () => ({
    sourceSpecialists: ["tests"] as const,
    sourceFindingIds: [sourceId],
    action: "kept" as const,
    verifiedViaRetrieval: false,
  }))
  return {
    findings,
    dropped: [],
    softened: [],
    retrievalCallsUsed: 0,
  }
}

describe("validateForSubmission — SIG-113 testing-evidence citation gate", () => {
  it("drops an uncited testing finding + increments the counter + fires the callback", () => {
    const synthOutput = {
      verdict: {
        summary: "Test",
        confidence: 3,
        confidenceReason: "Reason.",
        findings: [
          finding({
            headline: "Module ships without tests for the new helper",
            // No inspectedTestFiles, no evidenceRefs → drops
          }),
        ],
      },
      provenance: makeProvenance(1),
    }
    const dropped: Array<{ path: string; reason: string }> = []
    const onDrop = vi.fn((f: PrReviewFinding, reason: "no-citation") => {
      dropped.push({ path: f.path, reason })
    })

    const result = validateForSubmission({
      synthOutput,
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts() as never,
      testingEvidence: pack(),
      onTestingFindingDropped: onDrop,
    })

    expect(result.droppedForUncitedTestingEvidence).toBe(1)
    expect(result.verdict.findings).toHaveLength(0)
    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(dropped[0]).toEqual({ path: "src/lib/foo.ts", reason: "no-citation" })
  })

  it("keeps a testing finding that cites inspectedTestFiles", () => {
    const synthOutput = {
      verdict: {
        summary: "Test",
        confidence: 3,
        confidenceReason: "Reason.",
        findings: [
          finding({
            headline: "Test for foo() doesn't cover the empty-input branch",
            inspectedTestFiles: ["tests/foo.test.ts"],
          }),
        ],
      },
      provenance: makeProvenance(1),
    }
    const result = validateForSubmission({
      synthOutput,
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts() as never,
      testingEvidence: pack(),
    })
    expect(result.droppedForUncitedTestingEvidence).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
  })

  it("keeps a testing finding that cites a REAL ->NONE siblingMapping (legitimate absence claim)", () => {
    // The cited mapping must match the pack. Use a pack where
    // src/lib/bar.ts genuinely has no sibling test.
    const absencePack = pack({
      sourceFilesChanged: ["src/lib/foo.ts", "src/lib/bar.ts"],
      siblingMappings: [
        { source: "src/lib/foo.ts", test: "tests/foo.test.ts" },
        { source: "src/lib/bar.ts", test: null },
      ],
    })
    const synthOutput = {
      verdict: {
        summary: "Test",
        confidence: 3,
        confidenceReason: "Reason.",
        findings: [
          finding({
            path: "src/lib/bar.ts",
            headline: "src/lib/bar.ts ships without a sibling test in this PR",
            evidenceRefs: ["siblingMapping:src/lib/bar.ts->NONE"],
          }),
        ],
      },
      provenance: makeProvenance(1),
    }
    const result = validateForSubmission({
      synthOutput,
      reviewable: new Map([
        ["src/lib/bar.ts", [{ line: 1, side: "RIGHT" as const, position: 1 }]],
      ]),
      specialistVerdicts: makeSpecialistVerdicts() as never,
      testingEvidence: absencePack,
    })
    expect(result.droppedForUncitedTestingEvidence).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
  })

  it("DROPS a testing finding citing a CONTRADICTORY ->NONE mapping (foo.ts actually has a sibling)", () => {
    // CodeRabbit PR #112 (Major): the exact original FP pattern. The
    // model claims foo.ts has no test, but the pack shows it DOES.
    // The fabricated ->NONE citation is rejected.
    const synthOutput = {
      verdict: {
        summary: "Test",
        confidence: 3,
        confidenceReason: "Reason.",
        findings: [
          finding({
            headline: "src/lib/foo.ts ships without tests",
            evidenceRefs: ["siblingMapping:src/lib/foo.ts->NONE"],
          }),
        ],
      },
      provenance: makeProvenance(1),
    }
    const result = validateForSubmission({
      synthOutput,
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts() as never,
      testingEvidence: pack(), // foo.ts -> tests/foo.test.ts; ->NONE is a lie
    })
    expect(result.droppedForUncitedTestingEvidence).toBe(1)
    expect(result.verdict.findings).toHaveLength(0)
  })

  it("back-compat: when no testingEvidence is supplied, the gate no-ops (uncited findings pass)", () => {
    const synthOutput = {
      verdict: {
        summary: "Test",
        confidence: 3,
        confidenceReason: "Reason.",
        findings: [
          finding({ headline: "Module ships without tests" }),
        ],
      },
      provenance: makeProvenance(1),
    }
    const result = validateForSubmission({
      synthOutput,
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts() as never,
      // testingEvidence intentionally omitted
    })
    expect(result.droppedForUncitedTestingEvidence).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
  })

  it("non-testing findings are unaffected (gate only applies to category='testing')", () => {
    const synthOutput = {
      verdict: {
        summary: "Test",
        confidence: 3,
        confidenceReason: "Reason.",
        findings: [
          finding({ category: "logic", headline: "Off-by-one in cursor" }),
          finding({ category: "security", headline: "Hardcoded API key on line 7", line: 2 }),
        ],
      },
      provenance: {
        findings: [
          { sourceSpecialists: ["logic"], sourceFindingIds: ["logic-0"], action: "kept", verifiedViaRetrieval: false },
          { sourceSpecialists: ["tests"], sourceFindingIds: ["tests-0"], action: "kept", verifiedViaRetrieval: false },
        ],
        dropped: [],
        softened: [],
        retrievalCallsUsed: 0,
      } satisfies SynthesizerProvenance,
    }
    const result = validateForSubmission({
      synthOutput,
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts() as never,
      testingEvidence: pack(),
    })
    expect(result.droppedForUncitedTestingEvidence).toBe(0)
    expect(result.verdict.findings).toHaveLength(2)
  })

  it("the PR #110/#111 regression scenario: 4 uncited 'missing tests' findings all drop", () => {
    const synthOutput = {
      verdict: {
        summary: "Test",
        confidence: 3,
        confidenceReason: "Reason.",
        findings: [
          finding({ path: "src/lib/foo.ts", headline: "foo.ts ships without tests" }),
          finding({ path: "src/lib/bar.ts", headline: "bar.ts has no test coverage" }),
          finding({ path: "src/lib/baz.ts", headline: "Untested module: baz" }),
          finding({ path: "src/lib/qux.ts", headline: "qux lacks a test file" }),
        ],
      },
      provenance: {
        findings: Array.from({ length: 4 }, () => ({
          sourceSpecialists: ["tests"] as const,
          sourceFindingIds: ["tests-0"] as const,
          action: "kept" as const,
          verifiedViaRetrieval: false,
        })),
        dropped: [],
        softened: [],
        retrievalCallsUsed: 0,
      } satisfies SynthesizerProvenance,
    }
    const result = validateForSubmission({
      synthOutput,
      reviewable: new Map([
        ["src/lib/foo.ts", [{ line: 1, side: "RIGHT" as const, position: 1 }]],
        ["src/lib/bar.ts", [{ line: 1, side: "RIGHT" as const, position: 1 }]],
        ["src/lib/baz.ts", [{ line: 1, side: "RIGHT" as const, position: 1 }]],
        ["src/lib/qux.ts", [{ line: 1, side: "RIGHT" as const, position: 1 }]],
      ]),
      specialistVerdicts: makeSpecialistVerdicts() as never,
      testingEvidence: pack({
        sourceFilesChanged: ["src/lib/foo.ts", "src/lib/bar.ts", "src/lib/baz.ts", "src/lib/qux.ts"],
        testFilesChanged: ["tests/foo.test.ts", "tests/bar.test.ts"],
        // PRE-FIX scenario: classifier was fed reviewedFiles only, so the
        // testing specialist didn't see tests/foo.test.ts or
        // tests/bar.test.ts and hallucinated all four "missing tests"
        // findings. POST-FIX (SIG-113): the specialist would see the
        // siblings and emit either no finding or a citing finding. This
        // test pins the safety net: even if a future regression makes
        // the specialist hallucinate uncited findings again, the
        // validator drops them before they reach the customer.
        inspectedTestFiles: [],
      }),
    })
    expect(result.droppedForUncitedTestingEvidence).toBe(4)
    expect(result.verdict.findings).toHaveLength(0)
  })
})
