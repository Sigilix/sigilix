import { describe, expect, it } from "vitest"
import { runAstRules } from "@/src/features/ast-rules/app/runner"
import type { ReviewableMap } from "@/src/shared/util/diff-positions"
import { assessApprovalReadiness, buildApprovalReadinessSummary } from "@/src/lib/approval-readiness"
import {
  buildReviewSubmission,
  chooseReviewEvent,
  type PrReviewFinding,
  type PrReviewVerdict,
} from "@/src/lib/triage-pr-review"
import {
  buildTestingEvidencePack,
  fetchTestFileContentsWithBudget,
  mergeInspectedTestFileContents,
  renderTestingEvidenceBlock,
  TEST_FILE_CONTENT_CHAR_CAP,
} from "@/src/lib/testing-evidence-pack"

const CTX = { owner: "Sigilix", repo: "sigilix", prNumber: 124116 }
const CONFIG = {
  enabled: true,
  severityThreshold: "warning" as const,
  disabledRules: [],
  autoInline: false,
}

function addLineDiff(path: string, line: number): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${line},0 +${line},1 @@`,
    "+changed",
    "",
  ].join("\n")
}

describe("PR review engine acceptance flow (SIG-124 + SIG-116)", () => {
  it("emits in-diff AST hits even when unchanged earlier hazards exist", async () => {
    const cases = [
      {
        ruleId: "no-await-in-loop",
        path: "src/awaits.ts",
        oldLine: 2,
        changedLine: 5,
        source: [
          "async function oldLoop(xs) {",
          "  for (const x of xs) await oldWork(x)",
          "}",
          "async function newLoop(xs) {",
          "  for (const x of xs) await newWork(x)",
          "}",
        ].join("\n"),
      },
      {
        ruleId: "no-spread-accumulator-in-loop",
        path: "src/spread.ts",
        oldLine: 2,
        changedLine: 5,
        source: [
          "let oldAcc = []",
          "for (const x of xs) { oldAcc = [...oldAcc, x] }",
          "",
          "let newAcc = []",
          "for (const x of xs) { newAcc = [...newAcc, x] }",
        ].join("\n"),
      },
      {
        ruleId: "no-allocation-in-loop",
        path: "src/allocation.ts",
        oldLine: 2,
        changedLine: 5,
        source: [
          "function oldOne(xs) {",
          '  for (const x of xs) { new RegExp("old").test(x) }',
          "}",
          "function newOne(xs) {",
          '  for (const x of xs) { new RegExp("new").test(x) }',
          "}",
        ].join("\n"),
      },
      {
        ruleId: "no-n-plus-one-call-in-loop",
        path: "src/n-plus-one.ts",
        oldLine: 2,
        changedLine: 5,
        source: [
          "async function oldOne(ids) {",
          '  for (const id of ids) { await db.query("old") }',
          "}",
          "async function newOne(ids) {",
          '  for (const id of ids) { await db.query("new") }',
          "}",
        ].join("\n"),
      },
      {
        ruleId: "no-sync-io-in-request-path",
        path: "src/app.ts",
        oldLine: 2,
        changedLine: 4,
        source: [
          'import fs from "fs"',
          'app.get("/old", (req, res) => { fs.readFileSync("old") })',
          "",
          'app.get("/new", (req, res) => { fs.readFileSync("new") })',
        ].join("\n"),
      },
    ]

    const diff = cases.map((c) => addLineDiff(c.path, c.changedLine)).join("")
    const reviewable: ReviewableMap = new Map(
      cases.map((c) => [c.path, [{ line: c.changedLine, side: "RIGHT" as const }]]),
    )
    const result = await runAstRules({
      diff,
      filesByPath: new Map(cases.map((c) => [c.path, c.source])),
      reviewable,
      config: CONFIG,
      ctx: CTX,
    })

    for (const c of cases) {
      const findings = result.findings.filter((f) => f.ruleId === c.ruleId && f.path === c.path)
      expect(findings.map((f) => f.line)).toContain(c.changedLine)
      expect(findings.map((f) => f.line)).not.toContain(c.oldLine)
    }
  })

  it("builds testing evidence without fetching test files beyond the content budget", async () => {
    const testPaths = Array.from({ length: 60 }, (_unused, i) => `tests/e2e-${i}.test.ts`)
    const pack = buildTestingEvidencePack({
      splitFilePaths: ["src/lib/e2e.ts", ...testPaths],
      reviewedFilePaths: ["src/lib/e2e.ts", testPaths[0]!],
    })

    const fetchedPaths: string[] = []
    const fetchResult = await fetchTestFileContentsWithBudget({
      paths: pack.testFilesChanged,
      concurrency: 5,
      fetchContent: async (path) => {
        fetchedPaths.push(path)
        return "x".repeat(TEST_FILE_CONTENT_CHAR_CAP)
      },
    })
    const merged = mergeInspectedTestFileContents(pack, fetchResult)
    const rendered = renderTestingEvidenceBlock(merged, fetchResult)

    expect(fetchedPaths).toEqual(testPaths.slice(0, 5))
    expect(fetchResult.fetchedCount).toBe(5)
    expect(Object.keys(fetchResult.contentByPath)).toEqual(testPaths.slice(0, 3))
    expect(fetchResult.skippedForBudgetCount).toBe(57)
    expect(fetchResult.failedPaths).toEqual([])
    expect(merged.inspectedTestFiles).toEqual(testPaths.slice(0, 3))
    expect(rendered).toContain("content included below")
    expect(rendered).toContain("content NOT available (omitted to fit the evidence-block size budget)")
    expect(rendered).not.toContain("content NOT available (fetch failed)")
  })
})

describe("PR review engine acceptance flow (SIG-205)", () => {
  it("withholds marker-only approval when a PR #157-style source finding disappears", () => {
    const duplicateAnchorFinding: PrReviewFinding = {
      path: "src/lib/triage-pr-improve.ts",
      line: 221,
      score: 4,
      confidence: 4,
      category: "logic",
      headline: "duplicate `/sigilix improve` anchor drops preserved suggestion",
      body: "The preservation path still drops the conflicting fallback suggestion.",
    }
    const cleanSynthVerdict: PrReviewVerdict = {
      summary: "No issues found.",
      confidence: 5,
      confidenceReason: "Synth reported a clean preservation path.",
      findings: [],
    }

    const intendedEvent = chooseReviewEvent(cleanSynthVerdict.findings)
    const readiness = assessApprovalReadiness({
      intendedEvent,
      sourceFindings: [
        {
          role: "logic",
          id: "logic-0",
          finding: duplicateAnchorFinding,
          verdictConfidence: 4,
        },
      ],
      provenance: { findings: [], dropped: [] },
    })
    const postGateVerdict: PrReviewVerdict = {
      ...cleanSynthVerdict,
      summary: buildApprovalReadinessSummary(readiness, cleanSynthVerdict.summary),
    }
    const submission = buildReviewSubmission({
      verdict: postGateVerdict,
      prAuthor: "alice",
      headSha: "a".repeat(40),
      unanchored: readiness.bodyOnlyFindings,
      nowMs: 0,
      eventOverride: "REQUEST_CHANGES",
    })

    expect(intendedEvent).toBe("APPROVE")
    expect(readiness.event).toBe("REQUEST_CHANGES")
    expect(submission.event).toBe("REQUEST_CHANGES")
    expect(submission.comments).toBeUndefined()
    expect(submission.body).not.toBe("<!-- sigilix:pr-review -->\n")
    expect(submission.body).not.toContain("No issues found.")
    expect(submission.body).toContain("Approval withheld")
    expect(submission.body).toContain("Approval validation lost logic finding")
    expect(submission.body).toContain("duplicate `/sigilix improve` anchor drops preserved suggestion")
    expect(submission.body).toContain("kept, merged, softened, or explicitly dropped")
  })
})
