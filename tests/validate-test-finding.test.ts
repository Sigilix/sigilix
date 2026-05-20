// SIG-111: tests-finding specificity gate tests.
//
// Two layers (mirror tests/validate-security-finding.test.ts):
//   1. evaluateTestFinding pure unit tests — the FP-safe decision per
//      (finding shape, testing evidence pack). False-negative-sensitive:
//      most cases assert KEEP; only the two concrete FP shapes drop.
//   2. validateForSubmission integration — testing applicability via
//      category+score, shadow vs enforce, the
//      droppedForFailedTestValidation counter, and the
//      onTestFindingDropped callback.

import { describe, it, expect, vi } from "vitest"
import {
  evaluateTestFinding,
  parseTestsValidatorMode,
} from "../src/lib/validate-test-finding"
import { validateForSubmission } from "../src/lib/triage-pr-review-ensemble"
import type { PrReviewFinding } from "../src/lib/triage-pr-review"
import type { TestingEvidencePack } from "../src/lib/testing-evidence-pack"
import type { SynthesizerProvenance } from "../src/lib/triage-pr-review-ensemble"
import type { ReviewableMap } from "../src/lib/diff-positions"

function finding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "src/lib/foo.ts",
    line: 17,
    score: 4,
    category: "testing",
    headline: "New `parseConfig` export ships without tests",
    body: "The new `parseConfig` function has no sibling test file in this PR; its error path is untested.",
    evidenceRefs: ["siblingMapping:src/lib/foo.ts->NONE"],
    ...overrides,
  }
}

function pack(overrides: Partial<TestingEvidencePack> = {}): TestingEvidencePack {
  return {
    sourceFilesChanged: ["src/lib/foo.ts"],
    testFilesChanged: [],
    testFilesInPromptDiff: [],
    testFilesNotInPromptDiff: [],
    siblingMappings: [{ source: "src/lib/foo.ts", test: null }],
    inspectedTestFiles: [],
    ...overrides,
  }
}

describe("parseTestsValidatorMode", () => {
  it("defaults to shadow for unset / unknown values", () => {
    expect(parseTestsValidatorMode(undefined)).toBe("shadow")
    expect(parseTestsValidatorMode("")).toBe("shadow")
    expect(parseTestsValidatorMode("on")).toBe("shadow")
  })
  it("resolves enforce (case-insensitive, trimmed)", () => {
    expect(parseTestsValidatorMode("enforce")).toBe("enforce")
    expect(parseTestsValidatorMode("  ENFORCE  ")).toBe("enforce")
  })
})

describe("evaluateTestFinding (pure FP-safe decision)", () => {
  it("passes any non-testing finding untouched", () => {
    const r = evaluateTestFinding(finding({ category: "logic" }), pack())
    expect(r.keep).toBe(true)
  })

  it("passes any score < 4 testing finding untouched (specificity bar is sev>=4 only)", () => {
    const r = evaluateTestFinding(finding({ score: 3 }), pack())
    expect(r.keep).toBe(true)
  })

  it("keeps when the pack is absent (no evidence to gate on)", () => {
    expect(evaluateTestFinding(finding(), undefined).keep).toBe(true)
  })

  it("keeps when the pack is empty (pure docs PR)", () => {
    const empty = pack({ sourceFilesChanged: [], testFilesChanged: [], siblingMappings: [] })
    expect(evaluateTestFinding(finding(), empty).keep).toBe(true)
  })

  // ── deletion / rename exception (SIG-113, preserved) ──────────────
  it("ALWAYS keeps a finding citing a real testFileChanged (deleted/renamed test)", () => {
    const r = evaluateTestFinding(
      finding({
        headline: "PR removes coverage by deleting `foo.test.ts`",
        body: "This PR deletes the only test for the payment flow, leaving it unverified.",
        evidenceRefs: ["testFileChanged:tests/foo.test.ts"],
      }),
      pack({ testFilesChanged: ["tests/foo.test.ts"] }),
    )
    expect(r.keep).toBe(true)
  })

  it("does NOT honor a testFileChanged citing a path NOT in the changed set (falls through to classification)", () => {
    // No real changed test + no sibling/inspected signal → ambiguous → keep (FP-safe).
    const r = evaluateTestFinding(
      finding({
        headline: "PR removes test coverage",
        body: "This PR deletes a test for the payment flow.",
        evidenceRefs: ["testFileChanged:tests/made-up.test.ts"],
      }),
      pack({ testFilesChanged: [] }),
    )
    expect(r.keep).toBe(true)
  })

  // ── missing-path drop ─────────────────────────────────────────────
  it("DROPS a sev>=4 testing finding with an empty path", () => {
    const r = evaluateTestFinding(finding({ path: "  " }), pack())
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("missing-path")
  })

  // ── missing-coverage class ────────────────────────────────────────
  it("keeps a missing-coverage finding citing a real ->NONE mapping for its own path", () => {
    const r = evaluateTestFinding(finding(), pack())
    expect(r.keep).toBe(true)
  })

  it("DROPS a missing-coverage finding whose ->NONE mapping is for a DIFFERENT file than finding.path", () => {
    // finding.path is src/lib/foo.ts but it cites bar.ts's mapping →
    // not relevant → no real missing-coverage signal. With no inspected
    // test either, this is the uncited-missing-coverage FP shape.
    const r = evaluateTestFinding(
      finding({ evidenceRefs: ["siblingMapping:src/lib/bar.ts->NONE"] }),
      pack({
        sourceFilesChanged: ["src/lib/foo.ts", "src/lib/bar.ts"],
        siblingMappings: [
          { source: "src/lib/foo.ts", test: null },
          { source: "src/lib/bar.ts", test: null },
        ],
      }),
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("uncited-missing-coverage")
  })

  it("DROPS a ->NONE claim for a source the pack says IS covered (mapping disagreement)", () => {
    const r = evaluateTestFinding(
      finding({ evidenceRefs: ["siblingMapping:src/lib/foo.ts->NONE"] }),
      pack({ siblingMappings: [{ source: "src/lib/foo.ts", test: "tests/foo.test.ts" }] }),
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("uncited-missing-coverage")
  })

  // ── insufficient-test class ───────────────────────────────────────
  it("keeps an insufficient-test finding that reads a real test AND names a concrete API", () => {
    const r = evaluateTestFinding(
      finding({
        headline: "`retryWithBackoff` test never exercises the timeout branch",
        body: "The test for `retryWithBackoff` asserts the happy path but the new timeout branch is uncovered.",
        evidenceRefs: undefined,
        inspectedTestFiles: ["tests/retry.test.ts"],
      }),
      pack({ inspectedTestFiles: ["tests/retry.test.ts"] }),
    )
    expect(r.keep).toBe(true)
  })

  it("keeps an insufficient-test finding citing inspectedTestFile via evidenceRefs + concrete branch", () => {
    const r = evaluateTestFinding(
      finding({
        headline: "Existing test misses the null-input branch",
        body: "The test exercises valid input only; the new null guard throws and is untested.",
        evidenceRefs: ["inspectedTestFile:tests/retry.test.ts"],
        inspectedTestFiles: undefined,
      }),
      pack({ inspectedTestFiles: ["tests/retry.test.ts"] }),
    )
    expect(r.keep).toBe(true)
  })

  it("DROPS a vague insufficient-test finding that names nothing concrete (needs more tests)", () => {
    const r = evaluateTestFinding(
      finding({
        headline: "Module needs more tests",
        body: "This module could use additional tests to improve coverage overall.",
        evidenceRefs: undefined,
        inspectedTestFiles: ["tests/retry.test.ts"],
      }),
      pack({ inspectedTestFiles: ["tests/retry.test.ts"] }),
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("vague-insufficient-test")
  })

  // Review fix (HIGH): a concretely-NAMED branch keeps even alongside a
  // "needs more tests" call-to-action. "Error path" is the concrete
  // target; the old vague-veto wrongly dropped this real finding.
  it("KEEPS an insufficient-test finding naming a concrete branch even with 'needs more tests' phrasing", () => {
    const r = evaluateTestFinding(
      finding({
        headline: "Error path needs more tests",
        body: "The error path could use better coverage; please add additional tests here.",
        evidenceRefs: undefined,
        inspectedTestFiles: ["tests/retry.test.ts"],
      }),
      pack({ inspectedTestFiles: ["tests/retry.test.ts"] }),
    )
    expect(r.keep).toBe(true)
  })

  // Codex review (HIGH): a concrete insufficient-test finding may cite a
  // COVERED `->tests/...` mapping (the existing test it read) and no
  // inspectedTestFiles. The old class detection treated ANY siblingMapping
  // ref as missing-coverage and dropped it as uncited-missing-coverage.
  // Now only `->NONE` is missing-class, so this falls to ambiguous → keep.
  it("KEEPS an insufficient-test finding citing a COVERED ->tests mapping (not misclassified as missing)", () => {
    const r = evaluateTestFinding(
      finding({
        headline: "Existing `parse` test misses the `null` branch",
        body: "tests/foo.test.ts covers the happy path but not the null guard added here.",
        evidenceRefs: ["siblingMapping:src/lib/foo.ts->tests/foo.test.ts"],
        inspectedTestFiles: undefined,
      }),
      pack({ siblingMappings: [{ source: "src/lib/foo.ts", test: "tests/foo.test.ts" }] }),
    )
    expect(r.keep).toBe(true)
  })

  // ── ambiguity → keep (FP-safe crux) ───────────────────────────────
  it("keeps an AMBIGUOUS finding that cites BOTH a real mapping AND a real inspected test", () => {
    const r = evaluateTestFinding(
      finding({
        evidenceRefs: ["siblingMapping:src/lib/foo.ts->NONE"],
        inspectedTestFiles: ["tests/retry.test.ts"],
      }),
      pack({ inspectedTestFiles: ["tests/retry.test.ts"] }),
    )
    expect(r.keep).toBe(true)
  })

  it("keeps an AMBIGUOUS finding that cites NEITHER class (no sibling ref, no inspected test)", () => {
    // Reached here past SIG-113 by hypothesis (e.g. via some other
    // accepted ref). Cites neither a siblingMapping nor an inspected
    // test → fits neither class cleanly → ambiguous → keep (FP-safe).
    const r = evaluateTestFinding(
      finding({
        headline: "Risky logic landed",
        body: "The new branch carries real production risk and warrants attention.",
        evidenceRefs: ["someOtherRef:whatever"],
        inspectedTestFiles: undefined,
      }),
      pack(),
    )
    expect(r.keep).toBe(true)
  })
})

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
    retrievalCallsUsed: 0,
  }
}

describe("validateForSubmission — SIG-111 tests specificity gate", () => {
  it("ENFORCE: drops a vague insufficient-test finding + increments counter + fires callback", () => {
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
    expect(result.verdict.findings).toHaveLength(0)
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), { reason: "vague-insufficient-test", dropped: true })
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
          dropped: [], softened: [], retrievalCallsUsed: 0,
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
