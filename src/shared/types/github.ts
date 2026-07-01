// SIG-380 / P1a: pure GitHub DTO types extracted verbatim from `src/lib/github.ts`
// so type-only importers no longer have to depend on the IO adapter (the
// `GitHubClient` in `src/shared/adapters/github`). These are the request/response
// shapes the REST + GraphQL client returns; they carry no runtime, no IO, and no
// environment coupling.
//
// Leaf module: references only primitives + each other + ambient types — NEVER
// `lib`/`index`/`do`/the adapter. Keep it that way (the whole point of the split is
// that a module needing just a `PullRequestMeta` shape doesn't drag in `fetch`).
//
// The adapter's private wire-narrowing interfaces (`Raw*`, `ContentsResponse`,
// `GraphQLReviewThreadsPage`) deliberately stay co-located with the client — they're
// implementation detail, not part of the public DTO surface.

/** Config for constructing a `GitHubClient`. */
export interface GitHubClientOptions {
  token: string
}

/** GitHub's accepted reaction emoji values. */
export type ReactionContent = "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes"

export interface PullRequestMeta {
  number: number
  title: string
  body: string | null
  user: { login: string } | null
  head: { sha: string; ref: string }
  base: { sha: string; ref: string }
  draft?: boolean
  /** GitHub REST returns "open" or "closed" only — `merged` is inferred from `merged_at`. */
  state?: "open" | "closed"
  merged_at?: string | null
  /**
   * ISO-8601 timestamp the PR was closed (set on close OR merge), or `null`
   * while open. GitHub returns it on every `GET /repos/{o}/{r}/pulls/{n}`
   * response; typed optional so partial mocks needn't set it. The Memory
   * Gardener's decay clock (`now - closed_at`) reads it.
   */
  closed_at?: string | null
  /**
   * SIG-184: the PR's test-merge commit (`refs/pull/N/merge`). `null` until
   * GitHub computes it (or unmergeable). The runner-evidence review-join binds a
   * receipt by requiring the OIDC-signed merge sha to equal this.
   */
  merge_commit_sha?: string | null
  changed_files?: number
  /**
   * ARC-265: labels currently applied to the PR. GitHub returns each
   * as a full label object; we only need the `name` for diffing
   * against Sigilix's desired set. Empty array when no labels are
   * applied. Field is optional so older mocks don't have to set it.
   */
  labels?: Array<{ name?: string }>
}

export interface PrChangedFile {
  filename: string
  status: string
  additions: number
  deletions: number
  /** Blob SHA for the file at the PR head when GitHub supplies it. */
  sha?: string
  /**
   * ARC-263: per-file unified diff returned by GitHub's
   * `/pulls/{n}/files` endpoint. Used as the cache key input for
   * walkthrough caching — a file whose patch text hasn't changed
   * between pushes reuses its cached overview row instead of
   * re-summarizing via Ollama. GitHub omits `patch` for files
   * larger than ~500 KB or binary diffs; we treat that as a
   * cache miss (the file goes back through Ollama as usual).
   */
  patch?: string
}

/**
 * ARC-182: an item from `GET /repos/.../pulls?state=open`. Distinct
 * from `PullRequestMeta` (which is for a single PR's detail page) —
 * the list payload includes `head.repo` / `base.repo` for cross-fork
 * disambiguation in the stack detector.
 */
export interface ListOpenPullsItem {
  number: number
  title: string
  state: "open"
  user: { login: string } | null
  head: { ref: string; sha: string; repo: { full_name: string } | null }
  base: { ref: string; sha: string; repo: { full_name: string } | null }
  updated_at: string | null
}

export interface PrCommit {
  sha: string
  message: string
}

export interface WorkflowJob {
  id: number
  name: string
  conclusion: string | null
  status: string
  html_url: string | null
}

/** SIG-118: a completed workflow run, narrowed from the REST payload. */
export interface WorkflowRun {
  id: number
  head_sha: string
  status: string
  conclusion: string | null
  created_at: string
}

/** SIG-118: a workflow-run artifact, narrowed from the REST payload. */
export interface WorkflowArtifact {
  id: number
  name: string
  /** COMPRESSED size in bytes (the pre-download size cap is enforced against this). */
  size_in_bytes: number
  expired: boolean
}

export interface ReviewComment {
  id: number
  user: { login: string } | null
  author_association?: string
  path: string
  line: number | null
  original_line: number | null
  in_reply_to_id?: number
  body: string
  commit_id?: string
  original_commit_id?: string
  pull_request_review_id?: number | null
}

export interface IssueComment {
  id: number
  body: string
  user: { login: string } | null
  author_association?: string
}

export interface SubmitReviewComment {
  path: string
  body: string
  /** Last line of the range (or single-line target). 1-based. */
  line?: number
  /** First line of a multi-line range. Omit for single-line. */
  start_line?: number
  /** "RIGHT" (default) for added/changed lines, "LEFT" for context. */
  side?: "LEFT" | "RIGHT"
  start_side?: "LEFT" | "RIGHT"
}

export interface SubmitReviewBody {
  /** Top-level review body — appears above the inline comments. */
  body?: string
  /** APPROVE / REQUEST_CHANGES / COMMENT (PENDING omits this field). */
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
  /** Optional commit_id pin. Defaults to PR head. */
  commit_id?: string
  comments?: SubmitReviewComment[]
}

export interface CheckRunAnnotation {
  path: string
  start_line: number
  end_line: number
  annotation_level: "notice" | "warning" | "failure"
  message: string
  title?: string
  raw_details?: string
}

export interface CheckRunOutput {
  title: string
  summary: string
  annotations?: CheckRunAnnotation[]
}
