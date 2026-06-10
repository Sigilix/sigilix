// Port: the READ side of GitHub for the PR-review ensemble. Declares only the
// fetch operations the orchestrator needs, with signatures matching the concrete
// `GitHubClient` (in `@/shared/adapters/github`) so the client STRUCTURALLY
// satisfies this interface with no changes — the adapter wiring (PR 10/11) just
// passes a `GitHubClient` where a `GitHubPort` is expected. Types only; imports
// nothing outward (DTOs come from `@/shared/types/github`, never the adapter).

import type {
  ListOpenPullsItem,
  PrChangedFile,
  PullRequestMeta,
} from "@/src/shared/types/github"

export interface GitHubPort {
  /** PR metadata (title, body, head sha, author, labels, merge_commit_sha…). */
  getPullRequest(
    owner: string,
    repo: string,
    prNumber: number,
    opts?: { signal?: AbortSignal },
  ): Promise<PullRequestMeta>

  /** The unified diff for a PR (`Accept: application/vnd.github.v3.diff`). */
  getPullRequestDiff(
    owner: string,
    repo: string,
    prNumber: number,
    opts?: { signal?: AbortSignal },
  ): Promise<string>

  /** Changed files for a PR (capped/paginated; default maxFiles=50). */
  listPullRequestFiles(
    owner: string,
    repo: string,
    prNumber: number,
    opts?: { perPage?: number; maxFiles?: number; signal?: AbortSignal },
  ): Promise<PrChangedFile[]>

  /** Fully-paginated changed-file list for the per-PR review manifest. */
  listPullFilesForManifest(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<{
    overflow: boolean
    entries: Array<{ filename: string; previous_filename: string | null; status: string }>
  }>

  /** A file's contents at a git ref; null when missing / non-file / >1MB. */
  getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string,
    opts?: { signal?: AbortSignal },
  ): Promise<string | null>

  /** Recursive git-tree walk; null on 404, `truncated` flag on overflow. */
  getRepoTree(
    owner: string,
    repo: string,
    treeSha: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{
    tree: Array<{ path?: string; type?: string; sha?: string; size?: number }>
    truncated: boolean
  } | null>

  /** A branch's tip commit SHA + tree SHA; null on 404 / missing shapes. */
  getBranch(
    owner: string,
    repo: string,
    branch: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{ headSha: string; treeSha: string } | null>

  /** Merge-base SHA for a base/head pair; null on any failure shape. */
  getMergeBase(
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<string | null>

  /** Open PRs in the repo (for stack detection); default maxItems=200. */
  listOpenPullRequests(
    owner: string,
    repo: string,
    opts?: { perPage?: number; maxItems?: number; signal?: AbortSignal },
  ): Promise<ListOpenPullsItem[]>

  /** All reviews on a PR (id + state + author + body + commitId). */
  listPullRequestReviews(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<Array<{
    id: number
    state: string
    user: { login: string } | null
    body: string
    commitId: string | null
  }>>
}
