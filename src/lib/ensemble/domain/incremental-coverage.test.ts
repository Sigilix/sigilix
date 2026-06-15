import { describe, expect, it } from "vitest"

import {
  buildChangedPathSet,
  selectIncrementalReviewPaths,
  summarizeIncrementalCoverage,
  type IncrementalReviewCoverage,
  type IncrementalReviewFile,
} from "@/src/lib/ensemble/domain/incremental-coverage"

const coverage = (files: Record<string, string>): IncrementalReviewCoverage => ({
  schemaVersion: 1,
  files: Object.fromEntries(
    Object.entries(files).map(([path, reviewedAtBlobSha]) => [
      path,
      {
        reviewedAtBlobSha,
        reviewedAtHeadSha: "head-old",
        reviewedAt: "2026-06-15T00:00:00.000Z",
      },
    ]),
  ),
})

const file = (path: string, blobSha: string | null = `${path}-sha`): IncrementalReviewFile => ({
  path,
  blobSha,
})

describe("selectIncrementalReviewPaths", () => {
  it("first review selects every current file", () => {
    const selected = selectIncrementalReviewPaths({
      priorCoverage: null,
      currentFiles: [file("src/a.ts"), file("src/b.ts")],
      changedPaths: new Set(),
    })

    expect(selected.pathsToReview).toEqual(["src/a.ts", "src/b.ts"])
    expect(selected.skippedUnchangedPaths).toEqual([])
    expect(selected.neverReviewedPaths).toEqual(["src/a.ts", "src/b.ts"])
  })

  it("selects changed files, never-reviewed files, and skips unchanged reviewed files", () => {
    const priorCoverage = coverage({
      "src/changed.ts": "old-blob",
      "src/unchanged.ts": "same-blob",
    })
    const selected = selectIncrementalReviewPaths({
      priorCoverage,
      currentFiles: [
        file("src/changed.ts", "new-blob"),
        file("src/unchanged.ts", "same-blob"),
        file("src/never-reviewed.ts", "never-blob"),
      ],
      changedPaths: new Set(["src/changed.ts"]),
    })

    expect(selected.pathsToReview).toEqual(["src/changed.ts", "src/never-reviewed.ts"])
    expect(selected.changedPaths).toEqual(["src/changed.ts"])
    expect(selected.neverReviewedPaths).toEqual(["src/never-reviewed.ts"])
    expect(selected.skippedUnchangedPaths).toEqual(["src/unchanged.ts"])
  })
})

describe("buildChangedPathSet", () => {
  it("treats missing blob SHA as changed so the caller fails open to review", () => {
    const priorCoverage = coverage({ "src/a.ts": "old-blob" })

    expect(buildChangedPathSet(priorCoverage, [file("src/a.ts", null)])).toEqual(new Set(["src/a.ts"]))
  })
})

describe("summarizeIncrementalCoverage", () => {
  it("reports cumulative coverage from unchanged prior files plus files actually reviewed this pass", () => {
    const priorCoverage = coverage({
      "src/changed.ts": "old-blob",
      "src/unchanged.ts": "same-blob",
    })

    const summary = summarizeIncrementalCoverage({
      priorCoverage,
      currentFiles: [
        file("src/changed.ts", "new-blob"),
        file("src/unchanged.ts", "same-blob"),
        file("src/deferred.ts", "deferred-blob"),
      ],
      reviewedThisPassPaths: new Set(["src/changed.ts"]),
    })

    expect(summary.reviewedPaths).toEqual(["src/changed.ts", "src/unchanged.ts"])
    expect(summary.unreviewedPaths).toEqual(["src/deferred.ts"])
    expect(summary.reviewedCount).toBe(2)
    expect(summary.totalCount).toBe(3)
  })
})
