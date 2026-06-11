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

import { describe, it, expect } from "vitest"
import { evaluateTestFinding, parseTestsValidatorMode } from "@/src/lib/ensemble/domain/gates/validate-test-finding"
import type { HelperCoverage } from "@/src/lib/helper-coverage"
import { finding, pack } from "@/src/lib/ensemble/domain/gates/validate-test-finding.test-helpers"

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

  it("DROPS a source coverage claim when the pack is empty (no testing evidence)", () => {
    const empty = pack({ sourceFilesChanged: [], testFilesChanged: [], siblingMappings: [] })
    const r = evaluateTestFinding(finding(), empty)
    expect(r).toMatchObject({ keep: false, reason: "unbacked-source-coverage-no-evidence" })
  })

  it("keeps the same source coverage claim when the pack has testing evidence", () => {
    const r = evaluateTestFinding(finding(), pack())
    expect(r).toEqual({ keep: true })
  })

  it("keeps a changed test-file quality finding when the pack is empty", () => {
    const empty = pack({ sourceFilesChanged: [], testFilesChanged: [], siblingMappings: [] })
    const r = evaluateTestFinding(
      finding({
        path: "tests/foo.test.ts",
        headline: "`foo.test.ts` never asserts rejection",
        body: "The test calls the failing path but has no assertion.",
      }),
      empty,
    )
    expect(r.keep).toBe(true)
  })

  it("keeps an empty-pack finding when the finding path is itself a test file", () => {
    // The empty-pack branch has no file-list evidence to consult; it keeps
    // test-path findings by path shape so changed test quality nits do not
    // get misclassified as unbacked source-coverage claims.
    const empty = pack({ sourceFilesChanged: [], testFilesChanged: [], siblingMappings: [] })
    const r = evaluateTestFinding(
      finding({
        path: "tests/foo.test.ts",
        headline: "`foo.test.ts` lacks rejection assertions",
        body: "The changed test file only asserts the happy path.",
      }),
      empty,
    )
    expect(r.keep).toBe(true)
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

  it("keeps an insufficient-test finding citing a real covered sibling mapping with no inspected-test citation", () => {
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/retry.ts",
        headline: "`retryWithBackoff` timeout branch lacks coverage",
        body: "The covered sibling test only asserts the successful attempt; the new timeout branch is untested.",
        evidenceRefs: ["siblingMapping:src/lib/retry.ts->tests/retry.test.ts"],
        inspectedTestFiles: [],
      }),
      pack({
        sourceFilesChanged: ["src/lib/retry.ts"],
        testFilesChanged: ["tests/retry.test.ts"],
        siblingMappings: [{ source: "src/lib/retry.ts", test: "tests/retry.test.ts" }],
        inspectedTestFiles: [],
      }),
    )
    expect(r.keep).toBe(true)
  })

  it("DROPS an insufficient-test finding citing an unresolved covered sibling mapping", () => {
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/retry.ts",
        headline: "`retryWithBackoff` timeout branch lacks coverage",
        body: "The covered sibling test only asserts the successful attempt; the new timeout branch is untested.",
        evidenceRefs: ["siblingMapping:src/lib/retry.ts->tests/made-up.test.ts"],
        inspectedTestFiles: [],
      }),
      pack({
        sourceFilesChanged: ["src/lib/retry.ts"],
        testFilesChanged: ["tests/retry.test.ts"],
        siblingMappings: [{ source: "src/lib/retry.ts", test: "tests/retry.test.ts" }],
        inspectedTestFiles: [],
      }),
    )
    expect(r).toEqual({ keep: false, reason: "unresolved-sibling-mapping" })
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
    expect(r).toMatchObject({ keep: false, reason: "vague-insufficient-test" })
  })

  it("DROPS a speculative constant-intent finding that invents retry/backoff behavior", () => {
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/retry.ts",
        headline: "Backoff/retry logic lands without retry-failure test coverage",
        body: "The function `retryWithBackoff` now declares `const delayMs = 10`, signaling an intent to delay and retry on failure, but the sibling test only asserts the happy path.",
        evidenceRefs: undefined,
        inspectedTestFiles: ["tests/retry.test.ts"],
      }),
      pack({
        sourceFilesChanged: ["src/lib/retry.ts"],
        siblingMappings: [{ source: "src/lib/retry.ts", test: "tests/retry.test.ts" }],
        inspectedTestFiles: ["tests/retry.test.ts"],
      }),
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("vague-insufficient-test")
  })

  it("DROPS a speculative constant-intent finding that cites only a covered sibling mapping", () => {
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/retry.ts",
        headline: "Added delayMs without any retry or delay behavior",
        body: "The declaration `const delayMs = 10` suggests intent to add a delay before retrying a failed attempt, but the sibling test only asserts the happy path.",
        evidenceRefs: ["siblingMapping:src/lib/retry.ts->tests/retry.test.ts"],
        inspectedTestFiles: undefined,
      }),
      pack({
        sourceFilesChanged: ["src/lib/retry.ts"],
        siblingMappings: [{ source: "src/lib/retry.ts", test: "tests/retry.test.ts" }],
        inspectedTestFiles: ["tests/retry.test.ts"],
      }),
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("vague-insufficient-test")
  })

  it("DROPS a constant-intent finding whose headline says delayMs suggests eventual retry", () => {
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/retry.ts",
        headline: "constant `delayMs` suggests eventual retry behavior without coverage",
        body: "The new `delayMs` constant suggests eventual retry behavior, but the sibling test only asserts the happy path.",
        evidenceRefs: ["siblingMapping:src/lib/retry.ts->tests/retry.test.ts"],
        inspectedTestFiles: undefined,
      }),
      pack({
        sourceFilesChanged: ["src/lib/retry.ts"],
        siblingMappings: [{ source: "src/lib/retry.ts", test: "tests/retry.test.ts" }],
        inspectedTestFiles: ["tests/retry.test.ts"],
      }),
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("vague-insufficient-test")
  })

  it("DROPS a retry-delay happy-path-only nudge when no concrete branch or error path is named", () => {
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/retry.ts",
        headline: "retryWithBackoff needs delay coverage",
        body: "The new `delayMs` retry delay is not covered because the sibling test only asserts the successful attempt.",
        evidenceRefs: ["siblingMapping:src/lib/retry.ts->tests/retry.test.ts"],
        inspectedTestFiles: undefined,
      }),
      pack({
        sourceFilesChanged: ["src/lib/retry.ts"],
        siblingMappings: [{ source: "src/lib/retry.ts", test: "tests/retry.test.ts" }],
        inspectedTestFiles: ["tests/retry.test.ts"],
      }),
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("vague-insufficient-test")
  })

  it("DROPS a function-name-implies-retry finding as a non-testing gap", () => {
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/retry.ts",
        headline:
          "retryWithBackoff function name implies retry behavior that is absent from both implementation and tests",
        body: "The function is named `retryWithBackoff` suggesting retry-and-backoff semantics, but neither the implementation nor the sibling test exercises retry behavior.",
        evidenceRefs: ["siblingMapping:src/lib/retry.ts->tests/retry.test.ts"],
        inspectedTestFiles: undefined,
      }),
      pack({
        sourceFilesChanged: ["src/lib/retry.ts"],
        siblingMappings: [{ source: "src/lib/retry.ts", test: "tests/retry.test.ts" }],
        inspectedTestFiles: ["tests/retry.test.ts"],
      }),
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("vague-insufficient-test")
  })

  it("DROPS a retry-utility-name finding that infers unimplemented retry/backoff semantics", () => {
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/retry.ts",
        line: 4,
        headline: "Exported retry function ships without any retry/failure or backoff behavior tested",
        body: "`retryWithBackoff` exports a promise-based retry utility, yet the only test (`tests/retry.test.ts`) asserts a single success path. The sibling test file inspects no retry attempts, no `catch`/failure or backoff behavior.",
        evidenceRefs: ["siblingMapping:src/lib/retry.ts->tests/retry.test.ts"],
        inspectedTestFiles: undefined,
      }),
      pack({
        sourceFilesChanged: ["src/lib/retry.ts"],
        siblingMappings: [{ source: "src/lib/retry.ts", test: "tests/retry.test.ts" }],
        inspectedTestFiles: ["tests/retry.test.ts"],
      }),
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("vague-insufficient-test")
  })

  it("KEEPS a constant-intent finding when it also names a concrete branch/error path", () => {
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/retry.ts",
        headline: "Retry limit branch lacks failure coverage",
        body: "The changed `retryWithBackoff` now contains `const delayMs = 10` and a new `if (attempt > 3) throw` branch, but the sibling test never exercises that error path.",
        evidenceRefs: ["siblingMapping:src/lib/retry.ts->tests/retry.test.ts"],
        inspectedTestFiles: undefined,
      }),
      pack({
        sourceFilesChanged: ["src/lib/retry.ts"],
        siblingMappings: [{ source: "src/lib/retry.ts", test: "tests/retry.test.ts" }],
        inspectedTestFiles: ["tests/retry.test.ts"],
      }),
    )
    expect(r.keep).toBe(true)
  })

  it("KEEPS a retry finding that names a concrete rejection path despite happy-path wording", () => {
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/retry.ts",
        headline: "retryWithBackoff rejection path lacks coverage",
        body: "The sibling test only asserts the successful attempt, but the changed catch block now throws `retry failed` and needs a rejection-path assertion.",
        evidenceRefs: ["siblingMapping:src/lib/retry.ts->tests/retry.test.ts"],
        inspectedTestFiles: undefined,
      }),
      pack({
        sourceFilesChanged: ["src/lib/retry.ts"],
        siblingMappings: [{ source: "src/lib/retry.ts", test: "tests/retry.test.ts" }],
        inspectedTestFiles: ["tests/retry.test.ts"],
      }),
    )
    expect(r.keep).toBe(true)
  })

  it("DROPS an absent retry-loop implementation claim even when phrased as missing coverage", () => {
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/retry.ts",
        headline: "retryWithBackoff's retry/fallback logic has no coverage",
        body: "The new `delayMs` constant signals intent to add backoff timing, but the function still contains no retry loop, no error handling, and no timeout/backoff logic.",
        evidenceRefs: undefined,
        inspectedTestFiles: ["tests/retry.test.ts"],
      }),
      pack({
        sourceFilesChanged: ["src/lib/retry.ts"],
        siblingMappings: [{ source: "src/lib/retry.ts", test: "tests/retry.test.ts" }],
        inspectedTestFiles: ["tests/retry.test.ts"],
      }),
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

  // Codex review (HIGH): an UNREAL coverageGap ref must NOT create the
  // ambiguous-keep escape when mixed with a real inspected-test citation.
  // A vague insufficient-test finding that tacks on a bogus coverageGap
  // must still be judged as insufficient-test (and rejected when vague),
  // not rescued by straddling two classes.
  it("REJECTS a vague insufficient-test finding that also cites an UNREAL coverageGap (no ambiguous-keep)", () => {
    const r = evaluateTestFinding(
      finding({
        score: 5,
        headline: "Module needs more tests",
        body: "This module could use additional tests to improve coverage overall.",
        evidenceRefs: ["coverageGap:src/lib/foo.ts:999", "inspectedTestFile:tests/foo.test.ts"],
        inspectedTestFiles: undefined,
      }),
      pack({ inspectedTestFiles: ["tests/foo.test.ts"] }),
      new Set<string>(), // empty real-gap set → the coverageGap ref is unreal
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("vague-insufficient-test")
  })

  it("KEEPS a finding citing a REAL coverageGap for its own path", () => {
    const r = evaluateTestFinding(
      finding({
        score: 5,
        headline: "`parseConfig` line 42 added without coverage",
        body: "The new branch at src/lib/foo.ts:42 is uncovered by the CI run.",
        evidenceRefs: ["coverageGap:src/lib/foo.ts:42"],
        inspectedTestFiles: undefined,
      }),
      pack(),
      new Set<string>(["src/lib/foo.ts:42"]),
    )
    expect(r.keep).toBe(true)
  })

  // ── SIG-128: orchestrator-glue false positive ─────────────────────
  // A sev>=4 "needs integration tests" ->NONE finding on an orchestrator
  // whose changed logic FULLY delegates to same-PR tested helpers
  // (status "all") is the false positive — drop it. `partial`/`none`/
  // absent are NOT suppressed (FP-safe).
  const orchFinding = () =>
    finding({
      path: "src/lib/ensemble.ts",
      headline: "`ensemble` orchestrator ships without integration tests",
      body: "The new orchestrator wiring in `src/lib/ensemble.ts` has no sibling test file in this PR.",
      evidenceRefs: ["siblingMapping:src/lib/ensemble.ts->NONE"],
    })
  const orchPack = (coverage?: HelperCoverage) =>
    pack({
      sourceFilesChanged: ["src/lib/ensemble.ts"],
      siblingMappings: [{ source: "src/lib/ensemble.ts", test: null }],
      helperCoverageBySource: coverage ? { "src/lib/ensemble.ts": coverage } : {},
    })

  it("DROPS a glue ->NONE finding when helper-coverage status is 'all'", () => {
    const r = evaluateTestFinding(orchFinding(), orchPack({ status: "all", helpers: ["src/lib/branch-retrieval.ts"] }))
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("glue-covered-by-helper")
  })

  it("KEEPS a glue ->NONE finding when helper-coverage status is 'partial' (FP-safe)", () => {
    const r = evaluateTestFinding(
      orchFinding(),
      orchPack({ status: "partial", helpers: ["src/lib/branch-retrieval.ts"] }),
    )
    expect(r.keep).toBe(true)
  })

  it("KEEPS a glue ->NONE finding when helper-coverage status is 'none' (FP-safe)", () => {
    const r = evaluateTestFinding(orchFinding(), orchPack({ status: "none", helpers: [] }))
    expect(r.keep).toBe(true)
  })

  it("KEEPS a glue ->NONE finding with NO helper-coverage entry (regression — real missing coverage)", () => {
    const r = evaluateTestFinding(orchFinding(), orchPack())
    expect(r.keep).toBe(true)
  })

  // ── SIG-128 PR 6: structural orchestrator-glue suppression ───────
  // The PR #138 regression: a wrapper that delegates to BOTH same-PR
  // helpers AND pre-existing helpers gets status "partial" (not "all"),
  // so the original SIG-128 check doesn't fire. The structural check
  // catches this case via the `structurallyGlue: true` flag on the
  // coverage record.

  it("DROPS a glue ->NONE finding when structurallyGlue=true even if status is 'partial' (PR 6)", () => {
    const r = evaluateTestFinding(
      orchFinding(),
      orchPack({
        status: "partial",
        helpers: ["src/lib/branch-retrieval.ts"],
        structurallyGlue: true,
      }),
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("glue-covered-by-structure")
  })

  it("DROPS a glue ->NONE finding when structurallyGlue=true and status is 'none' (PR 6)", () => {
    const r = evaluateTestFinding(orchFinding(), orchPack({ status: "none", helpers: [], structurallyGlue: true }))
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("glue-covered-by-structure")
  })

  it("PREFERS the 'all' helper reason over the structural reason when both apply (PR 6)", () => {
    // status:"all" already suppressed; structural is redundant. The
    // existing reason takes priority since it's the stronger signal.
    const r = evaluateTestFinding(
      orchFinding(),
      orchPack({
        status: "all",
        helpers: ["src/lib/branch-retrieval.ts"],
        structurallyGlue: true,
      }),
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("glue-covered-by-helper")
  })

  it("KEEPS when structurallyGlue=false and status is 'partial' (FP-safe — real undertested logic)", () => {
    const r = evaluateTestFinding(
      orchFinding(),
      orchPack({
        status: "partial",
        helpers: ["src/lib/branch-retrieval.ts"],
        structurallyGlue: false,
      }),
    )
    expect(r.keep).toBe(true)
  })

  // SIG-128 (CodeRabbit): glue-covered suppression is scoped to the ->NONE
  // sibling-mapping missing class ONLY. A coverageGap-class missing claim
  // (unresolved coverageGap ref, no ->NONE) on the SAME helper-covered
  // status:"all" source must NOT be labeled glue-covered — it falls to the
  // coverageGap reject path (uncited-missing-coverage) instead.
  it("does NOT label a coverageGap-only missing finding as glue-covered (scoped to ->NONE class)", () => {
    const r = evaluateTestFinding(
      finding({
        score: 5,
        path: "src/lib/ensemble.ts",
        headline: "`ensemble` line 42 added without coverage",
        body: "The new branch at src/lib/ensemble.ts:42 is uncovered.",
        evidenceRefs: ["coverageGap:src/lib/ensemble.ts:42"],
        inspectedTestFiles: undefined,
      }),
      orchPack({ status: "all", helpers: ["src/lib/branch-retrieval.ts"] }),
      new Set<string>(), // empty real-gap set → the coverageGap ref is unreal
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("uncited-missing-coverage")
  })

  // ── SIG-166-1: glue suppression extends to insufficient-test class ───
  // Founder feedback on PR #144 (2026-05-23): the testing specialist
  // over-fires the SAME orchestrator-glue FP via the insufficient-test
  // class on the SAME glue files. The hoisted helper-coverage /
  // structurally-glue checks now fire for either class.

  it("DROPS an insufficient-test finding on a status:'all' glue file (SIG-166-1)", () => {
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/ensemble.ts",
        headline: "`ensemble` orchestrator tests are insufficient",
        body: "The existing tests for `src/lib/ensemble.ts` do not exercise the new orchestration paths.",
        evidenceRefs: ["inspectedTestFile:tests/ensemble.test.ts"],
        inspectedTestFiles: ["tests/ensemble.test.ts"],
      }),
      pack({
        sourceFilesChanged: ["src/lib/ensemble.ts"],
        siblingMappings: [{ source: "src/lib/ensemble.ts", test: "tests/ensemble.test.ts" }],
        inspectedTestFiles: ["tests/ensemble.test.ts"],
        helperCoverageBySource: {
          "src/lib/ensemble.ts": { status: "all", helpers: ["src/lib/branch-retrieval.ts"] },
        },
      }),
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("glue-covered-by-helper")
  })

  it("DROPS an insufficient-test finding on a structurallyGlue:true glue file with status 'partial' (SIG-166-1)", () => {
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/ensemble.ts",
        headline: "`ensemble` orchestrator tests are insufficient",
        body: "The existing tests for `src/lib/ensemble.ts` miss the new delegation wiring.",
        evidenceRefs: ["inspectedTestFile:tests/ensemble.test.ts"],
        inspectedTestFiles: ["tests/ensemble.test.ts"],
      }),
      pack({
        sourceFilesChanged: ["src/lib/ensemble.ts"],
        siblingMappings: [{ source: "src/lib/ensemble.ts", test: "tests/ensemble.test.ts" }],
        inspectedTestFiles: ["tests/ensemble.test.ts"],
        helperCoverageBySource: {
          "src/lib/ensemble.ts": {
            status: "partial",
            helpers: ["src/lib/branch-retrieval.ts"],
            structurallyGlue: true,
          },
        },
      }),
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("glue-covered-by-structure")
  })

  it("KEEPS an insufficient-test finding when the source is NOT glue (FP-safe regression for SIG-166-1)", () => {
    // No helperCoverageBySource entry for the source → the hoisted
    // suppression must not fire; the finding falls through to the normal
    // insufficient-test admissibility + specificity checks and keeps.
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/retry.ts",
        headline: "`retryWithBackoff` test never exercises the timeout branch",
        body: "The test for `retryWithBackoff` asserts the happy path but the new timeout branch is uncovered.",
        evidenceRefs: ["inspectedTestFile:tests/retry.test.ts"],
        inspectedTestFiles: ["tests/retry.test.ts"],
      }),
      pack({
        sourceFilesChanged: ["src/lib/retry.ts"],
        siblingMappings: [{ source: "src/lib/retry.ts", test: "tests/retry.test.ts" }],
        inspectedTestFiles: ["tests/retry.test.ts"],
        helperCoverageBySource: {},
      }),
    )
    expect(r.keep).toBe(true)
  })

  it("DROPS an ambiguous finding (cites BOTH classes) on a status:'all' glue file (SIG-166-1 — pins the natural extension; pre-patch behavior was ambiguous-keep)", () => {
    const r = evaluateTestFinding(
      finding({
        path: "src/lib/ensemble.ts",
        headline: "`ensemble` orchestrator lacks integration coverage",
        body: "The orchestrator at `src/lib/ensemble.ts` cites both ->NONE and an inspected test.",
        evidenceRefs: ["siblingMapping:src/lib/ensemble.ts->NONE", "inspectedTestFile:tests/ensemble.test.ts"],
        inspectedTestFiles: ["tests/ensemble.test.ts"],
      }),
      pack({
        sourceFilesChanged: ["src/lib/ensemble.ts"],
        siblingMappings: [{ source: "src/lib/ensemble.ts", test: null }],
        inspectedTestFiles: ["tests/ensemble.test.ts"],
        helperCoverageBySource: {
          "src/lib/ensemble.ts": { status: "all", helpers: ["src/lib/branch-retrieval.ts"] },
        },
      }),
    )
    expect(r.keep).toBe(false)
    if (!r.keep) expect(r.reason).toBe("glue-covered-by-helper")
  })
})
