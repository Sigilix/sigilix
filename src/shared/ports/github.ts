// Ports: the narrow GitHub seams the feature app-layers depend on. Each
// declares only the operation a feature needs, with signatures matching the
// concrete `GitHubClient` (in `@/shared/adapters/github`) so the client
// STRUCTURALLY satisfies the port with no changes — the composition root just
// passes a `GitHubClient` where a port is expected. Types only; imports nothing
// outward (the `SubmitReviewBody` DTO lives in `@/shared/types/github`, a leaf
// with no IO — never the adapter). This is how an app layer stays free of any
// dependency on a concrete adapter (COMPLIANCE.md §1).

import type { SubmitReviewBody } from "@/src/shared/types/github"

/** Read a single file's contents at a git ref. Used by dep-vuln + SARIF scans. */
export interface GitHubFileReaderPort {
  /** A file's contents at a git ref; null when missing / non-file / >1MB. */
  getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string,
    opts?: { signal?: AbortSignal },
  ): Promise<string | null>
}

/** Post a review to a PR. Used by the AST-rules inline poster. */
export interface GitHubReviewSinkPort {
  submitReview(
    owner: string,
    repo: string,
    prNumber: number,
    review: SubmitReviewBody,
  ): Promise<{ id: number; state: string }>
}
