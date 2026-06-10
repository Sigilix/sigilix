import { describe, it, expect } from "vitest"
import { evaluateTestFinding } from "@/src/lib/ensemble/domain/gates/validate-test-finding"
import { finding, pack } from "@/src/lib/ensemble/domain/gates/validate-test-finding.test-helpers"

// ── SIG-347 (SIG-166 AC #2): sibling-test identifier cross-check ──
//
// The PR #144 over-fire shape: an insufficient-test finding that cites a
// real inspected test AND names a concrete identifier, on a NON-glue file
// (so the SIG-166-1 glue suppression never fires) — but the cited
// identifier is already referenced by an in-diff sibling test we fetched.
describe("evaluateTestFinding — sibling-test cross-check (SIG-347 AC #2)", () => {
  it("DROPS the PR #144 over-fire: `parsePrReviewResponse` cited while an in-diff test references it", () => {
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/triage-pr-review.ts",
        headline: "Missing test for `kind` coercion logic in `parsePrReviewResponse`",
        body: "The `parsePrReviewResponse` coercion branches are not exercised by the existing tests.",
        evidenceRefs: ["inspectedTestFile:tests/triage-pr-review.test.ts"],
        inspectedTestFiles: ["tests/triage-pr-review.test.ts"],
      }),
      pack({
        sourceFilesChanged: ["src/lib/triage-pr-review.ts"],
        testFilesChanged: ["tests/triage-pr-review.test.ts"],
        siblingMappings: [{ source: "src/lib/triage-pr-review.ts", test: "tests/triage-pr-review.test.ts" }],
        inspectedTestFiles: ["tests/triage-pr-review.test.ts"],
        inspectedTestContentByPath: {
          "tests/triage-pr-review.test.ts":
            'it("coerces kind", () => { expect(parsePrReviewResponse(raw).kind).toBe("bug") })',
        },
        helperCoverageBySource: {}, // NOT glue — so the SIG-166-1 suppression can't fire
      }),
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("cross-referenced-in-sibling-test")
  })

  it("KEEPS (FP-safe) when the cited identifier is NOT referenced by the in-diff test", () => {
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/triage-pr-review.ts",
        headline: "`coerceVerdictKind` fallback branch is untested",
        body: "The new `coerceVerdictKind` helper's fallback branch has no assertion in the suite.",
        evidenceRefs: ["inspectedTestFile:tests/triage-pr-review.test.ts"],
        inspectedTestFiles: ["tests/triage-pr-review.test.ts"],
      }),
      pack({
        sourceFilesChanged: ["src/lib/triage-pr-review.ts"],
        testFilesChanged: ["tests/triage-pr-review.test.ts"],
        siblingMappings: [{ source: "src/lib/triage-pr-review.ts", test: "tests/triage-pr-review.test.ts" }],
        inspectedTestFiles: ["tests/triage-pr-review.test.ts"],
        inspectedTestContentByPath: {
          // references parsePrReviewResponse but NOT coerceVerdictKind → no over-fire
          "tests/triage-pr-review.test.ts":
            'it("parses", () => { expect(parsePrReviewResponse(raw)).toBeTruthy() })',
        },
        helperCoverageBySource: {},
      }),
    )
    expect(r.keep).toBe(true)
  })

  it("KEEPS a concrete error-path finding when the sibling test only references the happy path", () => {
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/config.ts",
        headline: "`parseConfig` rejection path lacks coverage",
        body: "The sibling test references `parseConfig`, but it only asserts the valid-input path; the new rejection path is still untested.",
        evidenceRefs: ["inspectedTestFile:tests/config.test.ts"],
        inspectedTestFiles: ["tests/config.test.ts"],
      }),
      pack({
        sourceFilesChanged: ["src/lib/config.ts"],
        testFilesChanged: ["tests/config.test.ts"],
        siblingMappings: [{ source: "src/lib/config.ts", test: "tests/config.test.ts" }],
        inspectedTestFiles: ["tests/config.test.ts"],
        inspectedTestContentByPath: {
          "tests/config.test.ts": "expect(parseConfig(validConfig)).toEqual({ ok: true })",
        },
        helperCoverageBySource: {},
      }),
    )
    expect(r.keep).toBe(true)
  })

  it("KEEPS a BadConfig error-path finding when the sibling test only mentions BadConfig via toBe", () => {
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/config.ts",
        headline: "`parseConfig` `BadConfig` error path lacks coverage",
        body: "The changed code throws `new Error(\"BadConfig\")`, but the sibling test only mentions `BadConfig` in a happy-path `toBe` assertion.",
        evidenceRefs: ["inspectedTestFile:tests/config.test.ts"],
        inspectedTestFiles: ["tests/config.test.ts"],
      }),
      pack({
        sourceFilesChanged: ["src/lib/config.ts"],
        testFilesChanged: ["tests/config.test.ts"],
        siblingMappings: [{ source: "src/lib/config.ts", test: "tests/config.test.ts" }],
        inspectedTestFiles: ["tests/config.test.ts"],
        inspectedTestContentByPath: {
          "tests/config.test.ts": "expect(parseConfig(validConfig).name).toBe(\"BadConfig\")",
        },
        helperCoverageBySource: {},
      }),
    )
    expect(r).toEqual({ keep: true })
  })

  it("KEEPS a concrete error-path finding when the sibling test throws a different error", () => {
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/config.ts",
        headline: "`parseConfig` `missing user` rejection path lacks coverage",
        body: "The sibling test references `parseConfig`, but it only asserts another throw; the `missing user` rejection path is still untested.",
        evidenceRefs: ["inspectedTestFile:tests/config.test.ts"],
        inspectedTestFiles: ["tests/config.test.ts"],
      }),
      pack({
        sourceFilesChanged: ["src/lib/config.ts"],
        testFilesChanged: ["tests/config.test.ts"],
        siblingMappings: [{ source: "src/lib/config.ts", test: "tests/config.test.ts" }],
        inspectedTestFiles: ["tests/config.test.ts"],
        inspectedTestContentByPath: {
          "tests/config.test.ts": "expect(() => parseConfig(badToken)).toThrow('invalid token')",
        },
        helperCoverageBySource: {},
      }),
    )
    expect(r.keep).toBe(true)
  })

  it("KEEPS when the only shared quoted token is not an Error/Exception class", () => {
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/config.ts",
        headline: "`parseConfig` `Timeout` error branch lacks coverage",
        body: "The sibling test references `parseConfig`, but a generic `Timeout` token is not proof that the same error path is asserted.",
        evidenceRefs: ["inspectedTestFile:tests/config.test.ts"],
        inspectedTestFiles: ["tests/config.test.ts"],
      }),
      pack({
        sourceFilesChanged: ["src/lib/config.ts"],
        testFilesChanged: ["tests/config.test.ts"],
        siblingMappings: [{ source: "src/lib/config.ts", test: "tests/config.test.ts" }],
        inspectedTestFiles: ["tests/config.test.ts"],
        inspectedTestContentByPath: {
          "tests/config.test.ts": "const Timeout = 1000; expect(() => parseConfig(bad)).toThrow()",
        },
        helperCoverageBySource: {},
      }),
    )
    expect(r.keep).toBe(true)
  })

  it("DROPS a concrete error-path finding when the sibling test asserts the same specific error", () => {
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/config.ts",
        headline: "`parseConfig` `missing user` rejection path lacks coverage",
        body: "The sibling test references `parseConfig`; verify whether the `missing user` rejection path is actually asserted.",
        evidenceRefs: ["inspectedTestFile:tests/config.test.ts"],
        inspectedTestFiles: ["tests/config.test.ts"],
      }),
      pack({
        sourceFilesChanged: ["src/lib/config.ts"],
        testFilesChanged: ["tests/config.test.ts"],
        siblingMappings: [{ source: "src/lib/config.ts", test: "tests/config.test.ts" }],
        inspectedTestFiles: ["tests/config.test.ts"],
        inspectedTestContentByPath: {
          "tests/config.test.ts": "expect(() => parseConfig(missingUser)).toThrow('missing user')",
        },
        helperCoverageBySource: {},
      }),
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("cross-referenced-in-sibling-test")
  })

  it("KEEPS when the referencing test is NOT in the PR diff (cross-check is in-diff only)", () => {
    // The test was inspected (pre-existing sibling) but is NOT in testFilesChanged,
    // so its content is not scanned — a real "new code path uncovered" finding
    // against pre-existing tests must survive.
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/triage-pr-review.ts",
        headline: "`parsePrReviewResponse` new branch untested",
        body: "The new branch in `parsePrReviewResponse` is not covered by the existing test.",
        evidenceRefs: ["inspectedTestFile:tests/triage-pr-review.test.ts"],
        inspectedTestFiles: ["tests/triage-pr-review.test.ts"],
      }),
      pack({
        sourceFilesChanged: ["src/lib/triage-pr-review.ts"],
        testFilesChanged: [], // NOT changed in this PR
        siblingMappings: [{ source: "src/lib/triage-pr-review.ts", test: "tests/triage-pr-review.test.ts" }],
        inspectedTestFiles: ["tests/triage-pr-review.test.ts"],
        inspectedTestContentByPath: {
          "tests/triage-pr-review.test.ts": "expect(parsePrReviewResponse(raw)).toBeTruthy()",
        },
        helperCoverageBySource: {},
      }),
    )
    expect(r.keep).toBe(true)
  })

  it("KEEPS when the only cited token is too generic to cross-check (stoplist safety belt)", () => {
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/triage-pr-review.ts",
        headline: "The `null` case needs more tests",
        body: "The `error` and `data` handling could use additional coverage.",
        evidenceRefs: ["inspectedTestFile:tests/triage-pr-review.test.ts"],
        inspectedTestFiles: ["tests/triage-pr-review.test.ts"],
      }),
      pack({
        sourceFilesChanged: ["src/lib/triage-pr-review.ts"],
        testFilesChanged: ["tests/triage-pr-review.test.ts"],
        siblingMappings: [{ source: "src/lib/triage-pr-review.ts", test: "tests/triage-pr-review.test.ts" }],
        inspectedTestFiles: ["tests/triage-pr-review.test.ts"],
        inspectedTestContentByPath: {
          "tests/triage-pr-review.test.ts": "const data = null; const error = data",
        },
        helperCoverageBySource: {},
      }),
    )
    // `null` (the only headline-backticked token) is stoplisted → no concrete
    // identifier extracted → no cross-check drop → keep.
    expect(r.keep).toBe(true)
  })

  it("KEEPS when the cited identifier appears only in body prose, not the headline (headline-scoped belt)", () => {
    // Recall-favoring: the headline names no concrete symbol, so even though the
    // body mentions a symbol the in-diff test references, the finding is NOT
    // cross-checked — a real uncovered-branch claim survives.
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/triage-pr-review.ts",
        headline: "The coercion fallback branch is untested",
        body: "Specifically `parsePrReviewResponse` never asserts the fallback path.",
        evidenceRefs: ["inspectedTestFile:tests/triage-pr-review.test.ts"],
        inspectedTestFiles: ["tests/triage-pr-review.test.ts"],
      }),
      pack({
        sourceFilesChanged: ["src/lib/triage-pr-review.ts"],
        testFilesChanged: ["tests/triage-pr-review.test.ts"],
        siblingMappings: [{ source: "src/lib/triage-pr-review.ts", test: "tests/triage-pr-review.test.ts" }],
        inspectedTestFiles: ["tests/triage-pr-review.test.ts"],
        inspectedTestContentByPath: {
          "tests/triage-pr-review.test.ts": "expect(parsePrReviewResponse(raw)).toBeTruthy()",
        },
        helperCoverageBySource: {},
      }),
    )
    expect(r.keep).toBe(true)
  })

  it("matches the cited identifier on a word boundary, not as a substring", () => {
    // body cites `parse`; test references `parseConfig` only. A substring
    // match would falsely drop — the boundary check must keep it.
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/triage-pr-review.ts",
        headline: "`parseHeader` branch untested",
        body: "The `parseHeader` boundary case is not asserted.",
        evidenceRefs: ["inspectedTestFile:tests/triage-pr-review.test.ts"],
        inspectedTestFiles: ["tests/triage-pr-review.test.ts"],
      }),
      pack({
        sourceFilesChanged: ["src/lib/triage-pr-review.ts"],
        testFilesChanged: ["tests/triage-pr-review.test.ts"],
        siblingMappings: [{ source: "src/lib/triage-pr-review.ts", test: "tests/triage-pr-review.test.ts" }],
        inspectedTestFiles: ["tests/triage-pr-review.test.ts"],
        inspectedTestContentByPath: {
          "tests/triage-pr-review.test.ts": "expect(parseHeaderName(x)).toBe(y)", // parseHeaderName ≠ parseHeader
        },
        helperCoverageBySource: {},
      }),
    )
    expect(r.keep).toBe(true)
  })

  it("KEEPS when only a NON-sibling changed test references the identifier (sibling-scoped, CodeRabbit)", () => {
    // Two changed tests in the PR; the SIBLING of the finding's source does NOT
    // reference the identifier, but an UNRELATED changed test does. Sibling-
    // scoping must keep the finding — an unrelated test's token can't suppress it.
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/triage-pr-review.ts",
        headline: "`parsePrReviewResponse` fallback branch untested",
        body: "The `parsePrReviewResponse` fallback branch has no assertion in its sibling test.",
        evidenceRefs: ["inspectedTestFile:tests/triage-pr-review.test.ts"],
        inspectedTestFiles: ["tests/triage-pr-review.test.ts"],
      }),
      pack({
        sourceFilesChanged: ["src/lib/triage-pr-review.ts"],
        testFilesChanged: ["tests/triage-pr-review.test.ts", "tests/unrelated.test.ts"],
        siblingMappings: [{ source: "src/lib/triage-pr-review.ts", test: "tests/triage-pr-review.test.ts" }],
        inspectedTestFiles: ["tests/triage-pr-review.test.ts", "tests/unrelated.test.ts"],
        inspectedTestContentByPath: {
          // the SIBLING does NOT reference the cited identifier…
          "tests/triage-pr-review.test.ts": "expect(somethingElse()).toBe(1)",
          // …but an UNRELATED changed test does — must NOT suppress.
          "tests/unrelated.test.ts": "expect(parsePrReviewResponse(raw)).toBeTruthy()",
        },
        helperCoverageBySource: {},
      }),
    )
    expect(r.keep).toBe(true)
  })
})
