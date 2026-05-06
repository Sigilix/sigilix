// Worker-friendly GitHub REST + GraphQL client. Wraps `fetch` with the
// installation token resolved per-webhook (see github-app.ts) and exposes
// just the operations the triage handlers need: PR diff, file contents,
// workflow run logs, issue comments, review-comment replies, GraphQL
// review threads.
//
// Replaces the `gh` CLI calls used by the rema-portal triage scripts —
// Workers don't have child_process. Same surface, smaller scope.
//
// Inputs (`owner`, `repo`, `path`, `ref`) come from the webhook payload
// and are interpolated into URLs. They're NOT user-controlled; the App
// only receives webhooks from repos it's installed on, and GitHub has
// already validated those values. We still URL-encode `path` because file
// paths legitimately contain characters like `+` or `#`.

const GITHUB_API = "https://api.github.com"

export interface GitHubClientOptions {
  token: string
}

export class GitHubClient {
  private readonly token: string

  constructor({ token }: GitHubClientOptions) {
    if (!token) throw new Error("GitHubClient: missing token")
    this.token = token
  }

  /** Raw REST GET that parses JSON. Throws on !ok. */
  async restGet<T>(path: string, opts?: { signal?: AbortSignal }): Promise<T> {
    return this.request<T>("GET", path, undefined, "json", undefined, opts?.signal)
  }

  /** Raw REST GET that returns the response body as text. */
  async restGetText(
    path: string,
    accept = "application/vnd.github+json",
    opts?: { signal?: AbortSignal }
  ): Promise<string> {
    return this.request<string>("GET", path, undefined, "text", accept, opts?.signal)
  }

  async restPost<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body, "json")
  }

  async restPatch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body, "json")
  }

  /**
   * Fetch the unified diff for a PR. GitHub returns the diff body when
   * `Accept: application/vnd.github.v3.diff` is set; without it the
   * response is the metadata JSON.
   */
  async getPullRequestDiff(
    owner: string,
    repo: string,
    prNumber: number,
    opts?: { signal?: AbortSignal }
  ): Promise<string> {
    return this.restGetText(
      `/repos/${owner}/${repo}/pulls/${prNumber}`,
      "application/vnd.github.v3.diff",
      opts
    )
  }

  /**
   * ARC-194: incremental review support. Fetch the unified diff
   * representing changes between two commits/refs. Used to review
   * only the new commits since the last successful review on a PR
   * that's been pushed-to multiple times — saves model spend on
   * iteration-heavy PRs.
   *
   * Returns the diff in unified format (same shape as
   * `getPullRequestDiff`). GitHub's compare endpoint accepts SHAs,
   * branch names, or refs separated by `...` (3 dots = base...head
   * showing only commits ahead on head, which is what we want).
   */
  async getCompareDiff(
    owner: string,
    repo: string,
    base: string,
    head: string,
    opts?: { signal?: AbortSignal }
  ): Promise<string> {
    return this.restGetText(
      `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      "application/vnd.github.v3.diff",
      opts
    )
  }

  /** Fetch PR metadata (title, body, head sha, author, labels, etc.). */
  async getPullRequest(
    owner: string,
    repo: string,
    prNumber: number,
    opts?: { signal?: AbortSignal }
  ): Promise<PullRequestMeta> {
    return this.restGet<PullRequestMeta>(`/repos/${owner}/${repo}/pulls/${prNumber}`, opts)
  }

  /**
   * List the files changed in a PR. Pages until either `maxFiles` is
   * collected OR no more pages — does NOT continue past `maxFiles` to
   * compute the total. Total file count comes from `changed_files` in
   * the PR meta returned by `getPullRequest`.
   */
  async listPullRequestFiles(
    owner: string,
    repo: string,
    prNumber: number,
    opts?: { perPage?: number; maxFiles?: number; signal?: AbortSignal }
  ): Promise<PrChangedFile[]> {
    const perPage = opts?.perPage ?? 100
    const maxFiles = opts?.maxFiles ?? 50
    const out: PrChangedFile[] = []
    let page = 1
    while (out.length < maxFiles && page < 50) {
      const items = await this.restGet<RawPrFile[]>(
        `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=${perPage}&page=${page}`,
        opts?.signal !== undefined ? { signal: opts.signal } : undefined
      )
      if (!Array.isArray(items) || items.length === 0) break
      for (const it of items) {
        if (out.length >= maxFiles) break
        out.push({
          filename: it.filename ?? "",
          status: it.status ?? "",
          additions: typeof it.additions === "number" ? it.additions : 0,
          deletions: typeof it.deletions === "number" ? it.deletions : 0,
        })
      }
      if (items.length < perPage) break
      page += 1
    }
    return out
  }

  /**
   * Fetch the most recent commits on a PR (up to GitHub's 250-commit cap).
   * Returns the list newest-last so callers can `.slice(-N)` the latest.
   */
  async getPullRequestCommits(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<PrCommit[]> {
    const list = await this.restGet<RawCommit[]>(
      `/repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=100`
    )
    return list.map((c) => ({
      sha: c.sha,
      message: c.commit?.message ?? "",
    }))
  }

  /**
   * Fetch a file's contents at a specific git ref. Returns null when the
   * path doesn't exist (404) or when the response shape isn't a file
   * (directory listings come back as an array). The "size > 1MB" path
   * also short-circuits to null since GitHub returns base64-encoded
   * content inline only up to 1MB.
   */
  async getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string
  ): Promise<string | null> {
    const escaped = encodeURIComponent(path).replace(/%2F/g, "/")
    let res: ContentsResponse
    try {
      res = await this.restGet<ContentsResponse>(
        `/repos/${owner}/${repo}/contents/${escaped}?ref=${encodeURIComponent(ref)}`
      )
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) return null
      throw error
    }
    if (Array.isArray(res)) return null
    if (typeof res.content !== "string" || res.encoding !== "base64") return null
    // GitHub returns base64 with embedded newlines — strip before decode.
    const cleaned = res.content.replace(/\s+/g, "")
    try {
      return atobUtf8(cleaned)
    } catch {
      return null
    }
  }

  /** List jobs for a workflow run. Used by triage-ci to find failed jobs. */
  async getWorkflowRunJobs(
    owner: string,
    repo: string,
    runId: number
  ): Promise<WorkflowJob[]> {
    const res = await this.restGet<{ jobs?: WorkflowJob[] }>(
      `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`
    )
    return Array.isArray(res.jobs) ? res.jobs : []
  }

  /**
   * Fetch the plain-text logs for a single workflow job. GitHub returns a
   * 302 redirect to a signed S3 URL; `fetch` follows redirects by default
   * so we get the log body directly. Logs are truncated upstream (the
   * prompt builder slices them down further).
   */
  async getWorkflowJobLog(owner: string, repo: string, jobId: number): Promise<string> {
    return this.restGetText(`/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, "*/*")
  }

  /**
   * List PR review comments (the inline ones). Paginates so callers
   * doing thread-ancestry walks (e.g. `arcInThreadAbove`) don't get
   * silently truncated on PRs with >100 review comments — Arc's
   * parent comment could otherwise be missing from the result and
   * legitimate replies would be skipped. Mirrors the pagination
   * pattern in `listIssueComments` above.
   */
  async listPullRequestReviewComments(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<ReviewComment[]> {
    const out: ReviewComment[] = []
    let page = 1
    while (page < 50) {
      const items = await this.restGet<ReviewComment[]>(
        `/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100&page=${page}`
      )
      if (!Array.isArray(items) || items.length === 0) break
      out.push(...items)
      if (items.length < 100) break
      page += 1
    }
    return out
  }

  /**
   * Submit a single PR review with multiple inline comments. Used by the
   * proactive primary reviewer — bundles every finding into one review so
   * GitHub renders them as a coherent unit (vs. a stream of individual
   * comments). `event` controls approval state: APPROVE / COMMENT /
   * REQUEST_CHANGES / PENDING.
   *
   * Each comment in `comments` must include `path` plus EITHER `line` (and
   * optional `start_line` for a multi-line range) OR `position` (legacy).
   * GitHub validates that the line is part of the diff and rejects the
   * whole review on a single bad anchor — caller is responsible for
   * filtering to valid lines.
   */
  async submitReview(
    owner: string,
    repo: string,
    prNumber: number,
    review: SubmitReviewBody
  ): Promise<{ id: number; state: string }> {
    return this.restPost<{ id: number; state: string }>(
      `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
      review
    )
  }

  /** List top-level issue comments on a PR. Used to find existing markers. */
  async listIssueComments(
    owner: string,
    repo: string,
    issueNumber: number
  ): Promise<IssueComment[]> {
    const out: IssueComment[] = []
    let page = 1
    while (page < 50) {
      const items = await this.restGet<IssueComment[]>(
        `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`
      )
      if (!Array.isArray(items) || items.length === 0) break
      out.push(...items)
      if (items.length < 100) break
      page += 1
    }
    return out
  }

  async createIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<{ id: number }> {
    return this.restPost<{ id: number }>(
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      { body }
    )
  }

  async updateIssueComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string
  ): Promise<void> {
    await this.restPatch<unknown>(`/repos/${owner}/${repo}/issues/comments/${commentId}`, { body })
  }

  /**
   * Add an emoji reaction to a top-level issue/PR-conversation comment.
   * Idempotent at the API level — re-posting the same reaction returns
   * the existing one with 200, not a duplicate. We use it to "ack" an
   * @-mention with 👀 so the asker knows Arc saw the message before
   * the LLM call returns (which can take 30-90s on Ollama Turbo).
   *
   * Returns 200 on existing-reaction, 201 on newly-created. We don't
   * distinguish; both paths are fine.
   */
  async addReactionToIssueComment(
    owner: string,
    repo: string,
    commentId: number,
    content: ReactionContent
  ): Promise<void> {
    await this.restPost<unknown>(
      `/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`,
      { content }
    )
  }

  /** Same as `addReactionToIssueComment` but for inline review comments. */
  async addReactionToReviewComment(
    owner: string,
    repo: string,
    commentId: number,
    content: ReactionContent
  ): Promise<void> {
    await this.restPost<unknown>(
      `/repos/${owner}/${repo}/pulls/comments/${commentId}/reactions`,
      { content }
    )
  }

  /**
   * Reply to an existing PR review comment. GitHub creates a new comment
   * threaded under the parent. Used by triage-cr to post per-comment
   * verdicts.
   */
  async replyToReviewComment(
    owner: string,
    repo: string,
    prNumber: number,
    commentId: number,
    body: string
  ): Promise<{ id: number }> {
    return this.restPost<{ id: number }>(
      `/repos/${owner}/${repo}/pulls/${prNumber}/comments/${commentId}/replies`,
      { body }
    )
  }

  /**
   * Run a GraphQL query/mutation. Used by triage-cr for the
   * resolveReviewThread mutation, which has no REST equivalent.
   */
  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${GITHUB_API}/graphql`, {
      method: "POST",
      headers: this.headers("application/json"),
      body: JSON.stringify({ query, variables }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new GitHubHttpError(res.status, `POST /graphql failed: ${text.slice(0, 300)}`)
    }
    const json = (await res.json()) as {
      data?: T
      errors?: Array<{ message: string }>
    }
    if (json.errors && json.errors.length > 0) {
      throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`)
    }
    if (!json.data) throw new Error("GraphQL response missing data")
    return json.data
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    parse: "json" | "text",
    accept = "application/vnd.github+json",
    signal?: AbortSignal
  ): Promise<T> {
    const url = path.startsWith("http") ? path : `${GITHUB_API}${path}`
    const init: RequestInit = {
      method,
      headers: this.headers(accept, body !== undefined),
    }
    if (body !== undefined) init.body = JSON.stringify(body)
    if (signal !== undefined) init.signal = signal
    const res = await fetch(url, init)
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new GitHubHttpError(
        res.status,
        `${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`
      )
    }
    if (res.status === 204) return undefined as T
    if (parse === "text") return (await res.text()) as T
    return (await res.json()) as T
  }

  private headers(accept: string, hasBody = false): Record<string, string> {
    const h: Record<string, string> = {
      accept,
      authorization: `token ${this.token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "openclaw-worker",
    }
    if (hasBody) h["content-type"] = "application/json"
    return h
  }
}

/** GitHub's accepted reaction emoji values. */
export type ReactionContent =
  | "+1"
  | "-1"
  | "laugh"
  | "confused"
  | "heart"
  | "hooray"
  | "rocket"
  | "eyes"

export class GitHubHttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "GitHubHttpError"
    this.status = status
  }
}

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
  changed_files?: number
}

export interface PrChangedFile {
  filename: string
  status: string
  additions: number
  deletions: number
}

interface RawPrFile {
  filename?: string
  status?: string
  additions?: number
  deletions?: number
}

export interface PrCommit {
  sha: string
  message: string
}

interface RawCommit {
  sha: string
  commit?: { message?: string }
}

interface ContentsResponse {
  type?: string
  encoding?: string
  content?: string
  size?: number
}

export interface WorkflowJob {
  id: number
  name: string
  conclusion: string | null
  status: string
  html_url: string | null
}

export interface ReviewComment {
  id: number
  user: { login: string } | null
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

/**
 * UTF-8-safe atob. The plain `atob` returns a binary string; if the file
 * has multi-byte chars, naive String.fromCharCode loses bytes. Decode via
 * Uint8Array + TextDecoder so the model sees the source verbatim.
 */
function atobUtf8(b64: string): string {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder("utf-8").decode(bytes)
}
