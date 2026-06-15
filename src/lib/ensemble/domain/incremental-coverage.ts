export type IncrementalReviewMode = "off" | "shadow" | "on"

export interface IncrementalReviewFile {
  path: string
  blobSha: string | null
}

export interface IncrementalReviewCoverageEntry {
  reviewedAtBlobSha: string
  reviewedAtHeadSha: string
  reviewedAt: string
}

export interface IncrementalReviewCoverage {
  schemaVersion: 1
  files: Record<string, IncrementalReviewCoverageEntry>
}

export interface IncrementalReviewPathSelection {
  pathsToReview: string[]
  changedPaths: string[]
  neverReviewedPaths: string[]
  skippedUnchangedPaths: string[]
}

export interface IncrementalReviewCoverageSummary {
  reviewedPaths: string[]
  unreviewedPaths: string[]
  reviewedCount: number
  totalCount: number
}

export function parseIncrementalReviewMode(raw: string | undefined): IncrementalReviewMode {
  const normalized = (raw ?? "off").trim().toLowerCase()
  return normalized === "shadow" || normalized === "on" ? normalized : "off"
}

export function buildChangedPathSet(
  priorCoverage: IncrementalReviewCoverage | null,
  currentFiles: readonly IncrementalReviewFile[],
): ReadonlySet<string> {
  const changed = new Set<string>()
  if (priorCoverage === null) return changed
  for (const file of currentFiles) {
    if (!file.blobSha) {
      changed.add(file.path)
      continue
    }
    const prior = priorCoverage.files[file.path]
    if (prior !== undefined && prior.reviewedAtBlobSha !== file.blobSha) {
      changed.add(file.path)
    }
  }
  return changed
}

export function selectIncrementalReviewPaths(args: {
  priorCoverage: IncrementalReviewCoverage | null
  currentFiles: readonly IncrementalReviewFile[]
  changedPaths: ReadonlySet<string>
}): IncrementalReviewPathSelection {
  const pathsToReview: string[] = []
  const changedPaths: string[] = []
  const neverReviewedPaths: string[] = []
  const skippedUnchangedPaths: string[] = []
  const seen = new Set<string>()

  for (const file of args.currentFiles) {
    if (seen.has(file.path)) continue
    seen.add(file.path)
    const prior = args.priorCoverage?.files[file.path]
    const changed = args.changedPaths.has(file.path)
    if (args.priorCoverage === null || prior === undefined) {
      pathsToReview.push(file.path)
      neverReviewedPaths.push(file.path)
      continue
    }
    if (changed) {
      pathsToReview.push(file.path)
      changedPaths.push(file.path)
      continue
    }
    skippedUnchangedPaths.push(file.path)
  }

  return {
    pathsToReview,
    changedPaths,
    neverReviewedPaths,
    skippedUnchangedPaths,
  }
}

export function summarizeIncrementalCoverage(args: {
  priorCoverage: IncrementalReviewCoverage | null
  currentFiles: readonly IncrementalReviewFile[]
  reviewedThisPassPaths: ReadonlySet<string>
}): IncrementalReviewCoverageSummary {
  const reviewedPaths: string[] = []
  const unreviewedPaths: string[] = []
  const seen = new Set<string>()

  for (const file of args.currentFiles) {
    if (seen.has(file.path)) continue
    seen.add(file.path)
    const reviewedThisPass = args.reviewedThisPassPaths.has(file.path)
    const prior = args.priorCoverage?.files[file.path]
    const unchangedSincePriorReview =
      prior !== undefined && file.blobSha !== null && prior.reviewedAtBlobSha === file.blobSha
    if (reviewedThisPass || unchangedSincePriorReview) {
      reviewedPaths.push(file.path)
    } else {
      unreviewedPaths.push(file.path)
    }
  }

  return {
    reviewedPaths,
    unreviewedPaths,
    reviewedCount: reviewedPaths.length,
    totalCount: reviewedPaths.length + unreviewedPaths.length,
  }
}
