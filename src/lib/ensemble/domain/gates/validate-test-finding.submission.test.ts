import { describe, it, expect, vi } from "vitest"
import { validateForSubmission } from "@/lib/triage-pr-review-ensemble"
import type { SynthesizerProvenance } from "@/lib/triage-pr-review-ensemble"
import type { ReviewableMap } from "@/shared/util/diff-positions"
import { finding, pack } from "@/lib/ensemble/domain/gates/validate-test-finding.test-helpers"

// ── Integration with validateForSubmission ──────────────────────

function makeReviewable(path = "src/lib/foo.ts"): ReviewableMap {
  return new Map([
    [path, [{ line: 17, side: "RIGHT" as const, position: 1 }]],
  ])
}

type SpecialistVerdictsArg = Parameters<typeof validateForSubmission>[0]["specialistVerdicts"]

function makeSpecialistVerdicts(): SpecialistVerdictsArg {
  return [
    { role: "tests", verdict: { findings: [{ id: "tests-0" }] } },
  ] as unknown as SpecialistVerdictsArg
}

function testsProvenance(sourceId = "tests-0"): SynthesizerProvenance {
  return {
    findings: [
      { sourceSpecialists: ["tests"], sourceFindingIds: [sourceId], action: "kept", verifiedViaRetrieval: false },
    ],
    dropped: [],
    softened: [],
  }
}

describe("validateForSubmission — SIG-111 tests specificity gate", () => {
  it("ENFORCE: DEMOTES a vague insufficient-test finding to a NON-blocking body note + increments counter + fires callback", () => {
    // SIG-245 demote-conversion: in enforce the FP-shape finding leaves the
    // inline set (verdict.findings) but lands in unanchoredFindings (the body),
    // so a residual real coverage gap stays visible. FN-safe. AND its score is
    // capped below the score>=4 REQUEST_CHANGES floor so the gate-flagged FP
    // does NOT block the merge (founder decision: a low-confidence coverage
    // over-fire should not gate a PR).
    const onDrop = vi.fn()
    const f = finding({
      headline: "Module needs more tests",
      body: "This module could use additional tests to improve coverage overall.",
      evidenceRefs: undefined,
      inspectedTestFiles: ["tests/retry.test.ts"],
    })
    const result = validateForSubmission({
      synthOutput: {
        verdict: { summary: "Test", confidence: 3, confidenceReason: "Reason.", findings: [f] },
        provenance: testsProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      testingEvidence: pack({ inspectedTestFiles: ["tests/retry.test.ts"] }),
      testsValidatorMode: "enforce",
      onTestFindingDropped: onDrop,
    })
    expect(result.droppedForFailedTestValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(0) // left the inline set
    expect(result.unanchoredFindings).toHaveLength(1) // demoted to the body, NOT dropped
    expect(result.unanchoredFindings[0].headline).toBe("Module needs more tests")
    expect(result.unanchoredFindings[0].score).toBe(3) // capped to exactly 3 — non-blocking (below the score>=4 floor)
    // CR #284: the demote clones — the original synth finding (which aliases
    // telemetry.synthesizer.verdict) must NOT be mutated by the score-cap.
    expect(f.score).toBe(4)
    expect(f.trust).toBeUndefined()
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), { reason: "vague-insufficient-test", dropped: true })
  })

  it("ENFORCE + ledger ON: tags the demoted finding with demoteReason tests-coverage", () => {
    // Mirrors the SIG-108 demote-conversion test discipline: with the trust
    // ledger ON, the body-demoted finding carries surface:"body" +
    // demoteReason:"tests-coverage" so the Trust Summary counts it. Covers the
    // annotateFindingTrust wiring + the demotedToBody filter branch.
    const f = finding({
      headline: "Module needs more tests",
      body: "This module could use additional tests to improve coverage overall.",
      evidenceRefs: undefined,
      inspectedTestFiles: ["tests/retry.test.ts"],
    })
    const result = validateForSubmission({
      synthOutput: {
        verdict: { summary: "Test", confidence: 3, confidenceReason: "Reason.", findings: [f] },
        provenance: testsProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      testingEvidence: pack({ inspectedTestFiles: ["tests/retry.test.ts"] }),
      testsValidatorMode: "enforce",
      trustLedgerEnabled: true,
    })
    expect(result.verdict.findings).toHaveLength(0) // CR #284: not dual-placed — removed from inline
    expect(result.unanchoredFindings).toHaveLength(1)
    expect(result.unanchoredFindings[0].trust).toEqual({
      tier: "body-only-ungrounded",
      surface: "body",
      demoteReason: "tests-coverage",
    })
  })

  it("SHADOW: counts the would-drop + fires callback with dropped:false but KEEPS the finding", () => {
    const onDrop = vi.fn()
    const f = finding({
      headline: "Module needs more tests",
      body: "This module could use additional tests to improve coverage overall.",
      evidenceRefs: undefined,
      inspectedTestFiles: ["tests/retry.test.ts"],
    })
    const result = validateForSubmission({
      synthOutput: {
        verdict: { summary: "Test", confidence: 3, confidenceReason: "Reason.", findings: [f] },
        provenance: testsProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      testingEvidence: pack({ inspectedTestFiles: ["tests/retry.test.ts"] }),
      testsValidatorMode: "shadow",
      onTestFindingDropped: onDrop,
    })
    expect(result.droppedForFailedTestValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(1) // NOT dropped in shadow
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), { reason: "vague-insufficient-test", dropped: false })
  })

  it("defaults to SHADOW when testsValidatorMode is omitted", () => {
    const f = finding({
      headline: "Module needs more tests",
      body: "This module could use additional tests to improve coverage overall.",
      evidenceRefs: undefined,
      inspectedTestFiles: ["tests/retry.test.ts"],
    })
    const result = validateForSubmission({
      synthOutput: {
        verdict: { summary: "Test", confidence: 3, confidenceReason: "Reason.", findings: [f] },
        provenance: testsProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      testingEvidence: pack({ inspectedTestFiles: ["tests/retry.test.ts"] }),
    })
    expect(result.droppedForFailedTestValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(1)
  })

  it("ENFORCE: keeps a concrete missing-coverage finding citing a real ->NONE mapping", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: { summary: "Test", confidence: 3, confidenceReason: "Reason.", findings: [finding()] },
        provenance: testsProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      testingEvidence: pack(),
      testsValidatorMode: "enforce",
    })
    expect(result.droppedForFailedTestValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
  })

  it("ENFORCE: keeps a deleted-test finding citing testFileChanged (deletion exception)", () => {
    const f = finding({
      headline: "PR deletes the only payment-flow test",
      body: "This PR removes coverage for the payment flow by deleting its test file.",
      evidenceRefs: ["testFileChanged:tests/foo.test.ts"],
    })
    const result = validateForSubmission({
      synthOutput: {
        verdict: { summary: "Test", confidence: 3, confidenceReason: "Reason.", findings: [f] },
        provenance: testsProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      testingEvidence: pack({ testFilesChanged: ["tests/foo.test.ts"] }),
      testsValidatorMode: "enforce",
    })
    expect(result.droppedForFailedTestValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
  })

  it("does NOT apply the gate to a non-testing finding (logic finding untouched)", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test", confidence: 3, confidenceReason: "Reason.",
          findings: [finding({ category: "logic", headline: "Off-by-one", evidenceRefs: undefined })],
        },
        provenance: {
          findings: [{ sourceSpecialists: ["logic"], sourceFindingIds: ["logic-0"], action: "kept", verifiedViaRetrieval: false }],
          dropped: [], softened: [],
        },
      },
      reviewable: makeReviewable(),
      specialistVerdicts: [
        { role: "logic", verdict: { findings: [{ id: "logic-0" }] } },
      ] as unknown as SpecialistVerdictsArg,
      testingEvidence: pack(),
      testsValidatorMode: "enforce",
    })
    expect(result.droppedForFailedTestValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
  })

  it("back-compat: when no testingEvidence is supplied, the gate no-ops", () => {
    const f = finding({
      headline: "Module needs more tests",
      body: "This module could use additional tests to improve coverage overall.",
      evidenceRefs: undefined,
      inspectedTestFiles: ["tests/retry.test.ts"],
    })
    const result = validateForSubmission({
      synthOutput: {
        verdict: { summary: "Test", confidence: 3, confidenceReason: "Reason.", findings: [f] },
        provenance: testsProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      // testingEvidence intentionally omitted
      testsValidatorMode: "enforce",
    })
    expect(result.droppedForFailedTestValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
  })
})

describe("validateForSubmission — SIG-347 sibling-test cross-check + ratio damper", () => {
  it("ENFORCE: demotes a cross-referenced insufficient-test finding to the body (AC #2)", () => {
    const onDrop = vi.fn()
    const f = finding({
      path: "src/lib/foo.ts",
      line: 17,
      score: 4,
      headline: "Missing test for `kind` coercion logic in `parseConfig`",
      body: "The `parseConfig` coercion branches are not exercised by the existing test.",
      evidenceRefs: ["inspectedTestFile:tests/foo.test.ts"],
      inspectedTestFiles: ["tests/foo.test.ts"],
    })
    const result = validateForSubmission({
      synthOutput: {
        verdict: { summary: "Test", confidence: 3, confidenceReason: "Reason.", findings: [f] },
        provenance: testsProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      testingEvidence: pack({
        sourceFilesChanged: ["src/lib/foo.ts"],
        testFilesChanged: ["tests/foo.test.ts"],
        siblingMappings: [{ source: "src/lib/foo.ts", test: "tests/foo.test.ts" }],
        inspectedTestFiles: ["tests/foo.test.ts"],
        inspectedTestContentByPath: {
          "tests/foo.test.ts": 'expect(parseConfig(raw).kind).toBe("bug")',
        },
      }),
      testsValidatorMode: "enforce",
      onTestFindingDropped: onDrop,
    })
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), {
      reason: "cross-referenced-in-sibling-test",
      dropped: true,
    })
    expect(result.droppedForFailedTestValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(0)
    expect(result.unanchoredFindings).toHaveLength(1)
  })

  it("AC #3: lowers a KEPT testing finding's score by 1 on a test-heavy PR (ratio > 0.3)", () => {
    const f = finding({ score: 4 }) // missing-coverage citing a real ->NONE → kept
    const result = validateForSubmission({
      synthOutput: {
        verdict: { summary: "Test", confidence: 3, confidenceReason: "Reason.", findings: [f] },
        provenance: testsProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      testingEvidence: pack(),
      testToSourceRatio: 0.5,
    })
    expect(result.verdict.findings).toHaveLength(1)
    expect(result.verdict.findings[0].score).toBe(3) // 4 → 3 (P2 → P3 de-emphasis)
    expect(f.score).toBe(4) // clone-safe: the synth-aliased finding is untouched
  })

  it("AC #3: does NOT damp when the ratio is at/below threshold", () => {
    const f = finding({ score: 4 })
    const result = validateForSubmission({
      synthOutput: {
        verdict: { summary: "Test", confidence: 3, confidenceReason: "Reason.", findings: [f] },
        provenance: testsProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      testingEvidence: pack(),
      testToSourceRatio: 0.2,
    })
    expect(result.verdict.findings[0].score).toBe(4)
  })

  it("AC #3: does NOT damp a non-testing finding even on a test-heavy PR", () => {
    const result = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "Test", confidence: 3, confidenceReason: "Reason.",
          findings: [finding({ category: "logic", score: 4, headline: "Off-by-one", evidenceRefs: undefined })],
        },
        provenance: {
          findings: [{ sourceSpecialists: ["logic"], sourceFindingIds: ["logic-0"], action: "kept", verifiedViaRetrieval: false }],
          dropped: [], softened: [],
        },
      },
      reviewable: makeReviewable(),
      specialistVerdicts: [
        { role: "logic", verdict: { findings: [{ id: "logic-0" }] } },
      ] as unknown as SpecialistVerdictsArg,
      testingEvidence: pack(),
      testToSourceRatio: 0.9,
    })
    expect(result.verdict.findings[0].score).toBe(4)
  })

  it("AC #3: defaults to no damping when testToSourceRatio is omitted", () => {
    const f = finding({ score: 4 })
    const result = validateForSubmission({
      synthOutput: {
        verdict: { summary: "Test", confidence: 3, confidenceReason: "Reason.", findings: [f] },
        provenance: testsProvenance(),
      },
      reviewable: makeReviewable(),
      specialistVerdicts: makeSpecialistVerdicts(),
      testingEvidence: pack(),
    })
    expect(result.verdict.findings[0].score).toBe(4)
  })
})
