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
   * ARC-235: fetch top-level repository metadata. The ARC-235 indexer
   * uses this for the default-branch name (the consumer then resolves
   * branch → commit SHA + tree SHA via `getBranch`). Returns null on
   * 404 so the consumer can ack and skip without retrying.
   */
  async getRepository(
    owner: string,
    repo: string,
  ): Promise<{ default_branch: string } | null> {
    try {
      const res = await this.restGet<{ default_branch?: string }>(
        `/repos/${owner}/${repo}`,
      )
      if (typeof res.default_branch !== "string" || res.default_branch.length === 0) {
        return null
      }
      return { default_branch: res.default_branch }
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) return null
      throw error
    }
  }

  /**
   * ARC-235: fetch a branch's tip commit SHA AND tree SHA.
   *
   * Codex v2 BLOCKING B1: the GitHub Trees endpoint expects a TREE
   * SHA, not a commit SHA. The earlier draft conflated the two and
   * would have produced 404s at scale. Now we return both so callers
   * can pin `headSha` (commit) for file-content fetches + freshness +
   * runId derivation, and `treeSha` for the `getRepoTree` walk.
   */
  async getBranch(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<{ headSha: string; treeSha: string } | null> {
    try {
      const res = await this.restGet<{
        commit?: { sha?: string; commit?: { tree?: { sha?: string } } }
      }>(
        `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`,
      )
      const headSha = res.commit?.sha
      const treeSha = res.commit?.commit?.tree?.sha
      if (typeof headSha !== "string" || typeof treeSha !== "string") return null
      if (headSha.length === 0 || treeSha.length === 0) return null
      return { headSha, treeSha }
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) return null
      throw error
    }
  }

  /**
   * ARC-235: walk a git tree object recursively. GitHub truncates
   * responses at ~100,000 entries or 7 MB and sets `truncated: true`
   * on the response. The indexer treats truncated trees as a refusal
   * (no manifest written, no partial index) because a partial index
   * looks authoritative to retrieval and silently misses parts of the
   * repo — Codex v2 BLOCKING from the design review.
   */
  async getRepoTree(
    owner: string,
    repo: string,
    treeSha: string,
  ): Promise<{
    tree: Array<{ path?: string; type?: string; sha?: string; size?: number }>
    truncated: boolean
  } | null> {
    try {
      const res = await this.restGet<{
        tree?: Array<{ path?: string; type?: string; sha?: string; size?: number }>
        truncated?: boolean
      }>(
        `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
      )
      return {
        tree: Array.isArray(res.tree) ? res.tree : [],
        truncated: res.truncated === true,
      }
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) return null
      throw error
    }
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
          ...(typeof it.patch === "string" && it.patch.length > 0
            ? { patch: it.patch }
            : {}),
        })
      }
      if (items.length < perPage) break
      page += 1
    }
    return out
  }

  /**
   * ARC-182: list open PRs in the repo for Graphite-style stack
   * detection. Returns up to `maxItems` open PRs (default 200 = 2
   * pages of 100) sorted by recent update so most-recent peers
   * surface first. The detector in `src/lib/pr-stack.ts` uses
   * `head.repo.full_name` + `base.repo.full_name` to distinguish
   * cross-fork branch-name reuse, so we explicitly include the repo
   * shape via GitHub's PR list payload (it ships these by default).
   */
  async listOpenPullRequests(
    owner: string,
    repo: string,
    opts?: { perPage?: number; maxItems?: number; signal?: AbortSignal }
  ): Promise<ListOpenPullsItem[]> {
    const perPage = opts?.perPage ?? 100
    const maxItems = opts?.maxItems ?? 200
    const out: ListOpenPullsItem[] = []
    let page = 1
    while (out.length < maxItems && page < 50) {
      const items = await this.restGet<RawListOpenPullsItem[]>(
        `/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${perPage}&page=${page}`,
        opts?.signal !== undefined ? { signal: opts.signal } : undefined
      )
      if (!Array.isArray(items) || items.length === 0) break
      for (const it of items) {
        if (out.length >= maxItems) break
        const headRef = it.head?.ref ?? ""
        const baseRef = it.base?.ref ?? ""
        // Skip any malformed entry that lacks refs entirely — the
        // stack detector treats empty refs as invalid anyway, so
        // dropping them here keeps the array clean.
        if (!headRef || !baseRef) continue
        out.push({
          number: typeof it.number === "number" ? it.number : 0,
          title: typeof it.title === "string" ? it.title : "",
          state: "open",
          user: it.user?.login ? { login: it.user.login } : null,
          head: {
            ref: headRef,
            sha: it.head?.sha ?? "",
            repo: it.head?.repo?.full_name ? { full_name: it.head.repo.full_name } : null,
          },
          base: {
            ref: baseRef,
            sha: it.base?.sha ?? "",
            repo: it.base?.repo?.full_name ? { full_name: it.base.repo.full_name } : null,
          },
          updated_at: typeof it.updated_at === "string" ? it.updated_at : null,
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

  /**
   * ARC-258: list all check runs on a given commit SHA. Used by the
   * dispatcher to find stale Sigilix-named checks (from prior queue
   * retries or rename-deploy switchovers) and cancel them before
   * creating a fresh one.
   *
   * Returns `{ id, name, status }` per check run. We don't need the
   * full check-run shape — the dispatcher only matches by name and
   * looks at status to decide whether to cancel.
   */
  async listCheckRunsForRef(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<Array<{ id: number; name: string; status: string }>> {
    type Resp = { check_runs?: Array<{ id: number; name: string; status: string }> }
    const data = await this.request<Resp>(
      "GET",
      `/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=100`,
      undefined,
      "json",
    )
    return data.check_runs ?? []
  }

  /**
   * ARC-258: create a Check Run in `in_progress` state. Renders in
   * the PR's Checks tab as "Sigilix · In progress" with a
   * spinner — the customer-visible "we're working on it" indicator.
   * Completed with `updateCheckRun` once the real review POSTs.
   *
   * Sigilix's check is informational (`conclusion: neutral` on
   * completion); we never block merges. Requires `checks: write`
   * permission on the GitHub App — gating + error-handling is the
   * caller's responsibility (we let 403 propagate so misconfigured
   * installations surface visibly in logs).
   *
   * Notes on the payload shape:
   *   - `head_sha` is the commit being reviewed (not the PR's base).
   *   - `details_url` (optional) deep-links from the check to a
   *     status page. Omitted for now — we don't host one.
   *   - `output.title` / `output.summary` show in the check's
   *     expanded view. Keep short; the real review is the substance.
   */
  async createCheckRun(
    owner: string,
    repo: string,
    args: {
      name: string
      headSha: string
      status?: "queued" | "in_progress" | "completed"
      startedAt?: string
      detailsUrl?: string
      externalId?: string
      output?: { title: string; summary: string }
    },
  ): Promise<{ id: number }> {
    const payload: Record<string, unknown> = {
      name: args.name,
      head_sha: args.headSha,
    }
    if (args.status !== undefined) payload.status = args.status
    if (args.startedAt !== undefined) payload.started_at = args.startedAt
    if (args.detailsUrl !== undefined) payload.details_url = args.detailsUrl
    if (args.externalId !== undefined) payload.external_id = args.externalId
    if (args.output !== undefined) payload.output = args.output
    return this.restPost<{ id: number }>(
      `/repos/${owner}/${repo}/check-runs`,
      payload,
    )
  }

  /**
   * ARC-258: update a Check Run created by `createCheckRun`. Used to
   * transition from `in_progress` → `completed` with an appropriate
   * `conclusion`. Conclusions used by Sigilix:
   *
   *   - `neutral`     — review posted successfully (default; we
   *                     never block merges so this is the steady-
   *                     state success outcome).
   *   - `failure`     — orchestrator threw / synth failed / quorum
   *                     missed. Customer sees a red X check so they
   *                     know to look at logs / re-run.
   *   - `skipped`     — stale-head short-circuit fired between
   *                     check creation and submit. Rare but real
   *                     (commit pushed mid-review). Customer-visible
   *                     "skipped" beats a stuck in-progress check.
   *
   * Per GitHub's API, `conclusion` is REQUIRED when `status` is
   * `completed`. We always set both.
   */
  async updateCheckRun(
    owner: string,
    repo: string,
    checkRunId: number,
    args: {
      status?: "queued" | "in_progress" | "completed"
      conclusion?: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required"
      completedAt?: string
      output?: { title: string; summary: string }
    },
  ): Promise<void> {
    const payload: Record<string, unknown> = {}
    if (args.status !== undefined) payload.status = args.status
    if (args.conclusion !== undefined) payload.conclusion = args.conclusion
    if (args.completedAt !== undefined) payload.completed_at = args.completedAt
    if (args.output !== undefined) payload.output = args.output
    await this.restPatch<unknown>(
      `/repos/${owner}/${repo}/check-runs/${checkRunId}`,
      payload,
    )
  }

  /**
   * ARC-184: fully-paginated changed-file list for the per-PR review
   * manifest. Distinct from `listPullRequestFiles` (capped at 50 for
   * other call sites) — drains pages until exhausted, includes
   * `previous_filename` for renames, and surfaces a 3000-entry
   * overflow flag (caller hashes to a sentinel sha256:overflow:N).
   */
  async listPullFilesForManifest(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<{
    overflow: boolean
    entries: Array<{ filename: string; previous_filename: string | null; status: string }>
  }> {
    const PER_PAGE = 100
    const MAX_PAGES = 30 // 3000 entries — GitHub's hard cap on /files
    const entries: Array<{ filename: string; previous_filename: string | null; status: string }> = []
    let page = 1
    let overflow = false
    while (page <= MAX_PAGES) {
      const items = await this.restGet<
        Array<{ filename?: string; previous_filename?: string; status?: string }>
      >(
        `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=${PER_PAGE}&page=${page}`,
      )
      if (!Array.isArray(items) || items.length === 0) break
      for (const it of items) {
        entries.push({
          filename: it.filename ?? "",
          previous_filename: typeof it.previous_filename === "string" ? it.previous_filename : null,
          status: it.status ?? "",
        })
      }
      if (items.length < PER_PAGE) break
      page += 1
      if (page > MAX_PAGES) {
        overflow = true
        break
      }
    }
    return { overflow, entries }
  }

  /**
   * ARC-184: fetch the merge-base SHA for a base/head pair. Records
   * the recommended-merge-base in the manifest for forensic value
   * (drift-detection itself doesn't compare merge-base directly).
   * Best-effort — returns null on any failure shape.
   */
  async getMergeBase(
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<string | null> {
    try {
      const res = await this.restGet<{ merge_base_commit?: { sha?: string } }>(
        `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      )
      return typeof res.merge_base_commit?.sha === "string" ? res.merge_base_commit.sha : null
    } catch (error) {
      if (error instanceof GitHubHttpError) return null
      throw error
    }
  }

  /**
   * ARC-258 follow-up: list all reviews on a PR with author + state
   * info — used by the dispatcher to find prior Sigilix reviews from
   * earlier commits and dismiss them so the Reviews tab reflects the
   * current head. Returns the shape we need (id + state + user.login
   * + body) without dragging in GitHub's full review payload.
   *
   * Caps at 100 reviews (paginated at per_page=100, single page) —
   * realistic PRs have far fewer reviews than that, and the per-PR
   * cap matches `listPullFilesForManifest` shape.
   */
  async listPullRequestReviews(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<Array<{
    id: number
    state: string
    user: { login: string } | null
    body: string
    /** SHA the review was associated with (REST returns this). Null
     *  if the upstream payload omits or invalidates the field. Used by
     *  the dismissal helper to name the stale commit in the dismissal
     *  message so readers can verify which commit was dismissed. */
    commitId: string | null
  }>> {
    type Raw = Array<{
      id?: number
      state?: string
      user?: { login?: string } | null
      body?: string | null
      commit_id?: string | null
    }>
    const items = await this.restGet<Raw>(
      `/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`,
    )
    if (!Array.isArray(items)) return []
    const out: Array<{
      id: number
      state: string
      user: { login: string } | null
      body: string
      commitId: string | null
    }> = []
    for (const it of items) {
      if (typeof it.id !== "number" || typeof it.state !== "string") continue
      out.push({
        id: it.id,
        state: it.state,
        user: it.user?.login ? { login: it.user.login } : null,
        body: typeof it.body === "string" ? it.body : "",
        commitId: typeof it.commit_id === "string" && it.commit_id.length > 0 ? it.commit_id : null,
      })
    }
    return out
  }

  /**
   * ARC-258 follow-up: dismiss a prior review. GitHub requires the
   * review to be in `APPROVED` or `CHANGES_REQUESTED` state (not
   * `COMMENTED` or `PENDING`); attempting to dismiss a comment-only
   * review returns 422.
   *
   * Used to clear a stale Sigilix approval/changes-requested when a
   * new commit lands — without this, the Reviews tab keeps showing
   * "approved a while ago" against an outdated commit.
   *
   * Caller passes a short `message` that GitHub surfaces in the
   * Reviews tab as the dismissal reason.
   */
  async dismissReview(
    owner: string,
    repo: string,
    prNumber: number,
    reviewId: number,
    message: string,
  ): Promise<void> {
    await this.request<unknown>(
      "PUT",
      `/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}/dismissals`,
      { message, event: "DISMISS" },
      "json",
    )
  }

  /**
   * ARC-184: fetch a single PR review's body for stale-marker
   * insertion. Returns null on 404 (review deleted) — caller exits
   * cleanly via `review-stale-target-missing` telemetry.
   */
  async getReview(
    owner: string,
    repo: string,
    prNumber: number,
    reviewId: number,
  ): Promise<{ body: string } | null> {
    try {
      const res = await this.restGet<{ body?: string | null }>(
        `/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}`,
      )
      return { body: res.body ?? "" }
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) return null
      throw error
    }
  }

  /**
   * ARC-184: PATCH a review body in place. Used by the stale-mark
   * queue handler to non-destructively prepend a stale-notice block to
   * a previously-submitted review.
   */
  async updateReviewBody(
    owner: string,
    repo: string,
    prNumber: number,
    reviewId: number,
    body: string,
  ): Promise<void> {
    await this.restPatch<unknown>(
      `/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}`,
      { body },
    )
  }

  /**
   * ARC-264: PATCH the pull request body in place. Used by
   * `/sigilix describe apply` to write the generated draft into the
   * PR body between marker fences. GitHub's update-pull-request
   * endpoint accepts a partial payload; we send only `body` so the
   * title, state, base, and other fields are untouched.
   */
  async updatePullRequestBody(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
  ): Promise<void> {
    await this.restPatch<unknown>(
      `/repos/${owner}/${repo}/pulls/${prNumber}`,
      { body },
    )
  }

  /**
   * ARC-184: fetch a single issue comment's body. Used as the
   * counterpart to `getReview` when the prior review fell back to an
   * issue comment (422-on-submit). Returns null on 404.
   */
  async getIssueComment(
    owner: string,
    repo: string,
    commentId: number,
  ): Promise<{ body: string } | null> {
    try {
      const res = await this.restGet<{ body?: string | null }>(
        `/repos/${owner}/${repo}/issues/comments/${commentId}`,
      )
      return { body: res.body ?? "" }
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) return null
      throw error
    }
  }

  /**
   * ARC-189: fetch a single inline-review comment by ID. Used by the
   * cross-PR review-memory capture pipeline to read the parent comment
   * body when a reviewer replies on a thread (the
   * `pull_request_review_comment.created` webhook payload only carries
   * `in_reply_to_id` — a number — not the parent body).
   *
   * Returns null on 404 (parent already deleted by the time the
   * webhook fires) so the capture pipeline can skip cleanly.
   */
  async getPullRequestReviewComment(
    owner: string,
    repo: string,
    commentId: number,
  ): Promise<{ id: number; body: string; in_reply_to_id?: number } | null> {
    try {
      const res = await this.restGet<{
        id: number
        body?: string | null
        in_reply_to_id?: number | null
      }>(`/repos/${owner}/${repo}/pulls/comments/${commentId}`)
      const out: { id: number; body: string; in_reply_to_id?: number } = {
        id: res.id,
        body: res.body ?? "",
      }
      if (typeof res.in_reply_to_id === "number") {
        out.in_reply_to_id = res.in_reply_to_id
      }
      return out
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) return null
      throw error
    }
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

  /**
   * SIG-91 follow-up: single-page fetch of top-level issue comments
   * on a PR. Callers driving cap-bounded incremental scans
   * (`findExistingOverviewCommentId`) need page-at-a-time control so
   * they can short-circuit on the first marker hit AND stop after a
   * hard page cap on pathological PRs (1000+ comments). `page` is
   * 1-based to mirror GitHub's REST convention.
   */
  async listIssueCommentsPage(
    owner: string,
    repo: string,
    issueNumber: number,
    page: number,
  ): Promise<IssueComment[]> {
    const items = await this.restGet<IssueComment[]>(
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`
    )
    return Array.isArray(items) ? items : []
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
   * Delete a top-level issue/PR-conversation comment. Used by the
   * pr-overview helper's one-way migration to delete the legacy
   * standalone warmup sticky once its content has been folded into
   * the unified overview body (ARC-258 follow-up).
   */
  async deleteIssueComment(
    owner: string,
    repo: string,
    commentId: number,
  ): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/repos/${owner}/${repo}/issues/comments/${commentId}`,
      undefined,
      "json",
    )
  }

  /**
   * ARC-265: list ALL labels defined on a repo (not just labels
   * applied to a specific issue). Used by the labelling pipeline to
   * surface labels with operator-authored descriptions as eligible
   * candidates alongside `sigilix.json::customLabels`.
   *
   * Paginated (100/page, cap at 200 items — labels rarely exceed
   * that; repos with bigger taxonomies degrade to the first 200 by
   * GitHub's default ordering).
   */
  async listRepositoryLabels(
    owner: string,
    repo: string,
  ): Promise<Array<{ name: string; description: string }>> {
    type Resp = Array<{ name?: string; description?: string | null }>
    const out: Array<{ name: string; description: string }> = []
    for (let page = 1; page <= 2; page += 1) {
      const items = await this.restGet<Resp>(
        `/repos/${owner}/${repo}/labels?per_page=100&page=${page}`,
      )
      if (!Array.isArray(items) || items.length === 0) break
      for (const it of items) {
        if (typeof it.name === "string" && it.name.length > 0) {
          out.push({
            name: it.name,
            description: typeof it.description === "string" ? it.description : "",
          })
        }
      }
      if (items.length < 100) break
    }
    return out
  }

  /**
   * ARC-265: add labels to an issue/PR. Idempotent — re-adding a
   * label that's already present is a no-op on GitHub's side. If
   * any label in the list doesn't exist on the repo, GitHub
   * creates it automatically (returns 200 with the full label set).
   */
  async addLabelsToIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    labels: ReadonlyArray<string>,
  ): Promise<void> {
    if (labels.length === 0) return
    await this.restPost<unknown>(
      `/repos/${owner}/${repo}/issues/${issueNumber}/labels`,
      { labels: [...labels] },
    )
  }

  /**
   * ARC-265: remove a single label from an issue/PR by name. 404
   * means the label wasn't applied to begin with — the caller
   * treats that as a no-op. URL-encodes the name to handle labels
   * containing `:` or whitespace.
   */
  async removeLabelFromIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    labelName: string,
  ): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(labelName)}`,
      undefined,
      "json",
    )
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
   * SIG-98 — list every review thread on a PR with each thread's id,
   * isResolved state, and the login of the FIRST (root) comment's
   * author. Used by `/sigilix resolve` to identify Sigilix-rooted
   * threads without touching threads from human reviewers.
   *
   * Pages through `reviewThreads` up to a defensive 5-page cap (500
   * threads) — sufficient for any practical PR, prevents an attacker
   * from making us walk infinite pages on a malicious payload.
   */
  async listPullRequestReviewThreads(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<Array<{ id: string; isResolved: boolean; firstCommentLogin: string | null }>> {
    const out: Array<{ id: string; isResolved: boolean; firstCommentLogin: string | null }> = []
    let cursor: string | null = null
    const MAX_PAGES = 5
    for (let page = 0; page < MAX_PAGES; page++) {
      const data: GraphQLReviewThreadsPage = await this.graphql<GraphQLReviewThreadsPage>(
        `query ListReviewThreads(
          $owner: String!,
          $name: String!,
          $number: Int!,
          $first: Int!,
          $after: String
        ) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              reviewThreads(first: $first, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  isResolved
                  comments(first: 1) {
                    nodes { author { login } }
                  }
                }
              }
            }
          }
        }`,
        { owner, name: repo, number: prNumber, first: 100, after: cursor },
      )
      const pageData = data?.repository?.pullRequest?.reviewThreads
      if (!pageData) break
      for (const node of pageData.nodes ?? []) {
        const firstCommentLogin = node.comments?.nodes?.[0]?.author?.login ?? null
        out.push({
          id: node.id,
          isResolved: Boolean(node.isResolved),
          firstCommentLogin,
        })
      }
      if (!pageData.pageInfo?.hasNextPage) break
      cursor = pageData.pageInfo.endCursor ?? null
      if (!cursor) break
    }
    return out
  }

  /**
   * SIG-98 — resolve a single review thread by its GraphQL node id.
   * The GraphQL mutation is idempotent server-side (already-resolved
   * threads return the same shape), so callers are free to retry.
   */
  async resolveReviewThread(threadId: string): Promise<void> {
    await this.graphql<{ resolveReviewThread: { thread: { id: string; isResolved: boolean } } }>(
      `mutation ResolveReviewThread($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) {
          thread { id isResolved }
        }
      }`,
      { threadId },
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
      "user-agent": "sigilix-worker",
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

/**
 * SIG-98 — GraphQL response shape for `listPullRequestReviewThreads`.
 * Kept internal — callers consume the flat array returned by the
 * client method instead of the nested GraphQL envelope.
 */
interface GraphQLReviewThreadsPage {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
        nodes?: Array<{
          id: string
          isResolved?: boolean
          comments?: {
            nodes?: Array<{ author?: { login?: string } | null }>
          }
        }>
      }
    }
  }
}

interface RawListOpenPullsItem {
  number?: number
  title?: string
  user?: { login?: string } | null
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null } | null
  base?: { ref?: string; sha?: string; repo?: { full_name?: string } | null } | null
  updated_at?: string
}

interface RawPrFile {
  filename?: string
  status?: string
  additions?: number
  deletions?: number
  patch?: string
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
