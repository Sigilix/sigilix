// SIG-290 v1: anti-hallucination absence-grounding gate tests.
//
// Layer 1: evaluateAbsenceGrounding + isAbsenceClaim pure unit tests —
// the FP-safe decision per (finding shape, evidence context). The
// detector + every exclusion, the per-category grounding predicate, and
// the never-throws contract.
//
// Layer 2: validateForSubmission integration — off / shadow / enforce
// wiring, the droppedForFailedAbsenceGroundingValidation counter, the
// onAbsenceFindingDropped callback, and the demote-to-body behavior.
//
// Mirrors the style of tests/validate-inline-grounding.test.ts.

import { describe, it, expect, vi } from "vitest"
import {
  evaluateAbsenceGrounding,
  isAbsenceClaim,
  parseAbsenceClaimValidatorMode,
  type AbsenceGroundingContext,
} from "@/src/lib/ensemble/domain/gates/validate-absence-grounding"
import { validateForSubmission } from "@/src/lib/triage-pr-review-ensemble"
import type { SynthesizerProvenance } from "@/src/lib/triage-pr-review-ensemble"
import type { PrReviewFinding, FindingCategory } from "@/src/lib/triage-pr-review"
import type { ReviewableMap } from "@/src/shared/util/diff-positions"
import type { TestingEvidencePack } from "@/src/lib/testing-evidence-pack"

const PATH = "src/lib/orders.ts"

function finding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: PATH,
    line: 17,
    score: 3,
    category: "testing",
    headline: "this module lacks tests",
    body: "No spec covers the new path.",
    ...overrides,
  }
}

function pack(overrides: Partial<TestingEvidencePack> = {}): TestingEvidencePack {
  return {
    sourceFilesChanged: [PATH],
    testFilesChanged: [],
    testFilesInPromptDiff: [],
    testFilesNotInPromptDiff: [],
    siblingMappings: [],
    inspectedTestFiles: [],
    helperCoverageBySource: {},
    ...overrides,
  }
}

function ctx(overrides: Partial<AbsenceGroundingContext> = {}): AbsenceGroundingContext {
  return {
    reviewablePaths: new Set([PATH]),
    wasTruncated: false,
    droppedPaths: [],
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────
describe("isAbsenceClaim — detector + category scoping", () => {
  it("detects testing/coverage absence phrasings", () => {
    expect(isAbsenceClaim(finding({ headline: "this module lacks tests" }))).toBe(true)
    expect(isAbsenceClaim(finding({ headline: "missing test coverage for the new branch" }))).toBe(true)
    expect(isAbsenceClaim(finding({ category: "testing", headline: "no spec for handleCheckout" }))).toBe(true)
    expect(isAbsenceClaim(finding({ headline: "needs a regression assertion here" }))).toBe(true)
  })

  it("detects guard/validation/error-handling absence phrasings", () => {
    expect(isAbsenceClaim(finding({ category: "security", headline: "no null check before deref", body: "" }))).toBe(true)
    expect(isAbsenceClaim(finding({ category: "security", headline: "missing input validation", body: "" }))).toBe(true)
    expect(isAbsenceClaim(finding({ category: "error-handling", headline: "lacks error handling on the await", body: "" }))).toBe(true)
    expect(isAbsenceClaim(finding({ category: "security", headline: "without input sanitization", body: "" }))).toBe(true)
  })

  it("detects general 'is never handled / fails to validate / there is no check' phrasings", () => {
    expect(isAbsenceClaim(finding({ category: "error-handling", headline: "the rejection is never handled", body: "" }))).toBe(true)
    expect(isAbsenceClaim(finding({ category: "error-handling", headline: "does not validate the payload", body: "" }))).toBe(true)
    expect(isAbsenceClaim(finding({ category: "security", headline: "there is no bounds check", body: "" }))).toBe(true)
  })

  it("NEVER scans performance findings (always not-an-absence-claim)", () => {
    expect(isAbsenceClaim(finding({ category: "performance", headline: "no caching of the result", body: "missing memoization" }))).toBe(false)
    expect(isAbsenceClaim(finding({ category: "performance", headline: "lacks test coverage", body: "" }))).toBe(false)
  })

  it("logic findings count only on a literal absence-pattern hit", () => {
    expect(isAbsenceClaim(finding({ category: "logic", headline: "off-by-one in the loop bound", body: "" }))).toBe(false)
    expect(isAbsenceClaim(finding({ category: "logic", headline: "no null check on the optional", body: "" }))).toBe(true)
  })

  it("a non-absence finding (real style/logic nit) is not a claim", () => {
    expect(isAbsenceClaim(finding({ category: "style", headline: "naming is inconsistent here", body: "rename for clarity" }))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
describe("isAbsenceClaim — EXCLUSIONS (every excluded phrase is NOT a claim)", () => {
  it("'PR adds/fixes/implements the missing X' is a positive change, not an absence", () => {
    expect(isAbsenceClaim(finding({ headline: "this PR adds the missing tests", body: "" }))).toBe(false)
    expect(isAbsenceClaim(finding({ category: "security", headline: "fixes the missing null check", body: "" }))).toBe(false)
    expect(isAbsenceClaim(finding({ category: "security", headline: "implements the missing validation", body: "" }))).toBe(false)
    expect(isAbsenceClaim(finding({ category: "security", headline: "introduces the lacking guard", body: "" }))).toBe(false)
  })

  it("'X was/were/had been missing' (past tense, now resolved) is not a current absence", () => {
    expect(isAbsenceClaim(finding({ headline: "the test was missing before this commit", body: "" }))).toBe(false)
    expect(isAbsenceClaim(finding({ category: "security", headline: "the guards were missing previously", body: "" }))).toBe(false)
    expect(isAbsenceClaim(finding({ category: "security", headline: "the check had been absent", body: "" }))).toBe(false)
  })

  it("'missing from the allowlist/config/import/...' is a structural reference", () => {
    expect(isAbsenceClaim(finding({ category: "security", headline: "this domain is missing from the allowlist", body: "" }))).toBe(false)
    expect(isAbsenceClaim(finding({ category: "logic", headline: "the symbol is missing from the import", body: "" }))).toBe(false)
    expect(isAbsenceClaim(finding({ category: "logic", headline: "the field is missing from the interface", body: "" }))).toBe(false)
  })

  it("a conditional/hypothetical ('if X is missing') is not an asserted absence", () => {
    expect(isAbsenceClaim(finding({ category: "logic", headline: "if config is missing the call throws", body: "" }))).toBe(false)
    expect(isAbsenceClaim(finding({ category: "logic", headline: "when token becomes absent the guard fails", body: "" }))).toBe(false)
    expect(isAbsenceClaim(finding({ category: "logic", headline: "should value be missing, default to 0", body: "" }))).toBe(false)
  })

  it("a negation ('not missing', 'no longer lacking') is not an absence", () => {
    expect(isAbsenceClaim(finding({ category: "security", headline: "the guard is not missing here", body: "" }))).toBe(false)
    expect(isAbsenceClaim(finding({ headline: "coverage is no longer lacking", body: "" }))).toBe(false)
  })

  it("a positive-presence claim ('has test coverage', 'provides validation') is not an absence", () => {
    expect(isAbsenceClaim(finding({ headline: "this module has test coverage already", body: "" }))).toBe(false)
    expect(isAbsenceClaim(finding({ category: "security", headline: "the handler provides input validation", body: "" }))).toBe(false)
    expect(isAbsenceClaim(finding({ category: "security", headline: "the wrapper includes error handling", body: "" }))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
describe("evaluateAbsenceGrounding — grounding predicate per category", () => {
  it("non-absence-claim → keep (predicate never runs)", () => {
    const f = finding({ category: "style", headline: "naming is inconsistent here", body: "rename for clarity" })
    expect(evaluateAbsenceGrounding(f, ctx())).toEqual({ keep: true })
  })

  it("performance category → keep (never scanned)", () => {
    const f = finding({ category: "performance", headline: "lacks test coverage", body: "" })
    expect(evaluateAbsenceGrounding(f, ctx({ droppedPaths: [PATH] }))).toEqual({ keep: true })
  })

  // ── TESTING-flavored grounding ──
  it("testing: GROUNDED when the sibling test was inspected → keep", () => {
    const f = finding({ headline: "tests are insufficient for the new branch" })
    const p = pack({
      siblingMappings: [{ source: PATH, test: "tests/orders.test.ts" }],
      inspectedTestFiles: ["tests/orders.test.ts"],
    })
    expect(evaluateAbsenceGrounding(f, ctx({ testingEvidence: p }))).toEqual({ keep: true })
  })

  it("testing: mapped but test NOT inspected → suppress (the bot never read what it points at)", () => {
    const f = finding({ headline: "tests are insufficient for the new branch" })
    const p = pack({
      siblingMappings: [{ source: PATH, test: "tests/orders.test.ts" }],
      inspectedTestFiles: [], // never inspected
    })
    expect(evaluateAbsenceGrounding(f, ctx({ testingEvidence: p }))).toEqual({
      keep: false,
      reason: "absence-claim-ungrounded-by-truncation",
    })
  })

  it("testing: mapping test is null (->NONE, source has no sibling test) → keep (GROUNDED — the bot saw ->NONE; SIG-113 accepts it as evidence)", () => {
    const f = finding({ headline: "this module lacks tests" })
    const p = pack({ siblingMappings: [{ source: PATH, test: null }], inspectedTestFiles: [] })
    expect(evaluateAbsenceGrounding(f, ctx({ testingEvidence: p }))).toEqual({ keep: true })
  })

  it("non-testing claim whose BODY merely mentions 'test' is NOT misrouted to the sibling-test predicate → keep (P1: route on category, not prose)", () => {
    // Security null-check claim; its body incidentally says "add a test", and
    // its sibling test is mapped-but-not-inspected — but that's irrelevant: the
    // claim's evidence is the SOURCE (in-window, not dropped). Must KEEP.
    const f = finding({
      category: "security",
      headline: "no null check before deref",
      body: "consider adding a test for this branch too",
    })
    const p = pack({ siblingMappings: [{ source: PATH, test: "tests/orders.test.ts" }], inspectedTestFiles: [] })
    expect(evaluateAbsenceGrounding(f, ctx({ testingEvidence: p, droppedPaths: [] }))).toEqual({ keep: true })
  })

  it("testing: NO mapping for the cited path → UNKNOWN → keep", () => {
    const f = finding({ headline: "this module lacks tests" })
    const p = pack({ siblingMappings: [{ source: "src/other.ts", test: null }] })
    expect(evaluateAbsenceGrounding(f, ctx({ testingEvidence: p }))).toEqual({ keep: true })
  })

  it("testing: no testing-evidence pack wired → UNKNOWN → keep", () => {
    const f = finding({ headline: "this module lacks tests" })
    expect(evaluateAbsenceGrounding(f, ctx({ testingEvidence: undefined }))).toEqual({ keep: true })
  })

  // ── NON-testing grounding ──
  it("non-testing: cited path was DROPPED from the diff → suppress (specialist never saw the content)", () => {
    const f = finding({ category: "security", headline: "no null check before deref", body: "" })
    expect(evaluateAbsenceGrounding(f, ctx({ droppedPaths: [PATH] }))).toEqual({
      keep: false,
      reason: "absence-claim-ungrounded-by-truncation",
    })
  })

  it("non-testing: path NOT dropped → UNKNOWN → keep (don't suppress on wasTruncated alone)", () => {
    const f = finding({ category: "security", headline: "no null check before deref", body: "" })
    expect(evaluateAbsenceGrounding(f, ctx({ droppedPaths: [], wasTruncated: true }))).toEqual({ keep: true })
  })

  it("never throws on degenerate input (empty strings, no context paths)", () => {
    const degenerate = finding({ headline: "", body: "", category: "syntax" as FindingCategory })
    expect(() =>
      evaluateAbsenceGrounding(degenerate, { reviewablePaths: new Set(), wasTruncated: false, droppedPaths: [] }),
    ).not.toThrow()
    expect(evaluateAbsenceGrounding(degenerate, ctx())).toEqual({ keep: true })
  })
})

// ─────────────────────────────────────────────────────────────────────
describe("parseAbsenceClaimValidatorMode", () => {
  it("returns 'shadow' / 'enforce' for the literals (case/space-insensitive)", () => {
    expect(parseAbsenceClaimValidatorMode("shadow")).toBe("shadow")
    expect(parseAbsenceClaimValidatorMode("  SHADOW ")).toBe("shadow")
    expect(parseAbsenceClaimValidatorMode("enforce")).toBe("enforce")
    expect(parseAbsenceClaimValidatorMode("Enforce")).toBe("enforce")
  })
  it("defaults to 'off' for anything else (undefined, empty, garbage)", () => {
    expect(parseAbsenceClaimValidatorMode(undefined)).toBe("off")
    expect(parseAbsenceClaimValidatorMode("")).toBe("off")
    expect(parseAbsenceClaimValidatorMode("off")).toBe("off")
    expect(parseAbsenceClaimValidatorMode("enforced")).toBe("off")
  })
})

// ── Integration with validateForSubmission (off / shadow / enforce) ────

type SpecialistVerdictsArg = Parameters<typeof validateForSubmission>[0]["specialistVerdicts"]

function makeReviewable(path = PATH): ReviewableMap {
  return new Map([[path, [{ line: 17, side: "RIGHT" as const, position: 1 }]]])
}
function makeSpecialistVerdicts(): SpecialistVerdictsArg {
  return [{ role: "security", verdict: { findings: [{ id: "security-0" }] } }] as unknown as SpecialistVerdictsArg
}
function prov(count = 1, sourceId = "security-0"): SynthesizerProvenance {
  return {
    findings: Array.from({ length: count }, () => ({
      sourceSpecialists: ["security"],
      sourceFindingIds: [sourceId],
      action: "kept" as const,
      verifiedViaRetrieval: false,
    })),
    dropped: [],
    softened: [],
  }
}

// A non-testing absence-claim on a path that is dropped from the diff —
// the canonical "the bot was guessing" case. score 3 + a backticked token
// on the reviewed line so it survives inline-grounding (default shadow
// keeps anyway, but this keeps the fixture honest).
const ADDED = new Map([[PATH, new Map([[17, "  return userInput.value"]])]])

function absenceFinding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return finding({
    score: 3,
    category: "security",
    headline: "no null check on `userInput` before deref",
    body: "A null `userInput` would throw.",
    ...overrides,
  })
}

function run(
  findings: PrReviewFinding[],
  opts: {
    mode?: "off" | "shadow" | "enforce"
    droppedPaths?: readonly string[]
    onDrop?: (...a: unknown[]) => void
  } = {},
) {
  return validateForSubmission({
    synthOutput: {
      verdict: { summary: "T", confidence: 3, confidenceReason: "R.", findings },
      provenance: prov(findings.length),
    },
    reviewable: makeReviewable(),
    specialistVerdicts: makeSpecialistVerdicts(),
    addedLineTextByLine: ADDED,
    ...(opts.mode ? { absenceClaimValidatorMode: opts.mode } : {}),
    ...(opts.droppedPaths ? { droppedPaths: opts.droppedPaths } : {}),
    ...(opts.onDrop ? { onAbsenceFindingDropped: opts.onDrop } : {}),
  })
}

describe("validateForSubmission — SIG-290 absence-grounding gate", () => {
  it("OFF (default): the gate never runs — counter 0, finding kept inline, callback not fired", () => {
    const onDrop = vi.fn()
    const result = run([absenceFinding()], { droppedPaths: [PATH], onDrop })
    expect(result.droppedForFailedAbsenceGroundingValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
    expect(onDrop).not.toHaveBeenCalled()
  })

  it("OFF: explicit 'off' also no-ops even when the claim is provably ungrounded", () => {
    const result = run([absenceFinding()], { mode: "off", droppedPaths: [PATH] })
    expect(result.droppedForFailedAbsenceGroundingValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
  })

  it("SHADOW: counts the would-demote + fires callback dropped:false but KEEPS the finding inline", () => {
    const onDrop = vi.fn()
    const result = run([absenceFinding()], { mode: "shadow", droppedPaths: [PATH], onDrop })
    expect(result.droppedForFailedAbsenceGroundingValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(1)
    expect(result.unanchoredFindings).toHaveLength(0)
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), {
      reason: "absence-claim-ungrounded-by-truncation",
      dropped: false,
    })
  })

  it("ENFORCE: demotes the ungrounded absence-claim to the body (counter++, callback dropped:true, leaves verdict.findings)", () => {
    const onDrop = vi.fn()
    const result = run([absenceFinding()], { mode: "enforce", droppedPaths: [PATH], onDrop })
    expect(result.droppedForFailedAbsenceGroundingValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(0)
    expect(result.unanchoredFindings.some((f) => f.headline.includes("no null check"))).toBe(true)
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), {
      reason: "absence-claim-ungrounded-by-truncation",
      dropped: true,
    })
  })

  it("ENFORCE: KEEPS a grounded absence-claim (path NOT dropped) inline — counter stays 0", () => {
    const onDrop = vi.fn()
    const result = run([absenceFinding()], { mode: "enforce", droppedPaths: [], onDrop })
    expect(result.droppedForFailedAbsenceGroundingValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
    expect(onDrop).not.toHaveBeenCalled()
  })

  it("ENFORCE: KEEPS a non-absence-claim (real nit) inline even on a dropped path — counter 0", () => {
    const onDrop = vi.fn()
    const f = absenceFinding({ headline: "rename `userInput` for clarity", body: "naming nit" })
    const result = run([f], { mode: "enforce", droppedPaths: [PATH], onDrop })
    expect(result.droppedForFailedAbsenceGroundingValidation).toBe(0)
    expect(result.verdict.findings).toHaveLength(1)
    expect(onDrop).not.toHaveBeenCalled()
  })

  it("ENFORCE: no score floor — a score-4 ungrounded absence-claim is demoted too", () => {
    const onDrop = vi.fn()
    const result = run([absenceFinding({ score: 4 })], { mode: "enforce", droppedPaths: [PATH], onDrop })
    expect(result.droppedForFailedAbsenceGroundingValidation).toBe(1)
    expect(result.verdict.findings).toHaveLength(0)
    expect(result.unanchoredFindings.some((f) => f.headline.includes("no null check"))).toBe(true)
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), {
      reason: "absence-claim-ungrounded-by-truncation",
      dropped: true,
    })
  })
})
