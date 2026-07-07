// The GitLab IO adapter — the read/write HTTP client the MR-review path uses,
// the GitLab counterpart of `GitHubClient`. It STRUCTURALLY satisfies the SCM
// review-client port surface (`ScmReviewClient = GitHubPort & ReviewSinkPort`)
// so the SCM seam (`GitLabScmProvider.buildReviewClient`) can hand it to the
// same SCM-agnostic review engine — the four specialists + synthesizer never
// learn which forge they are reviewing.
//
// The port's method names are GitHub-shaped (owner/repo/prNumber). GitLab's
// vocabulary differs, so this adapter maps:
//   - (owner, repo)  -> the URL-encoded `group/project` path, which GitLab's
//                       REST v4 accepts anywhere a numeric `:id` is expected.
//   - prNumber       -> the merge-request `iid` (the per-project number in the
//                       MR URL), NOT the global MR id.
//
// Auth model (v0): a single per-tenant GitLab access token (a Project/Group
// Access Token or a PAT) sent as the `PRIVATE-TOKEN` header against REST v4 at
// a configurable base URL (gitlab.com or a self-managed instance). See
// `GitLabScmProvider` for the env wiring + the per-tenant-mapping follow-up.
//
// The most important divergence is the WRITE path: GitHub bundles a review
// body + all inline comments into ONE `submitReview` POST; GitLab has no such
// bundle — a summary is one MR *note* and each inline comment is its own MR
// *discussion* with a `position`. `submitReview` maps the bundled port shape
// onto those individual POSTs (see the method for the recall-safety contract).

import type {
  ListOpenPullsItem,
  PrChangedFile,
  PullRequestMeta,
  SubmitReviewBody,
  SubmitReviewComment,
} from "@/src/shared/types/github"
import { GitLabHttpError } from "./gitlab-errors"

export interface GitLabClientOptions {
  /** Per-tenant GitLab access token, sent as the `PRIVATE-TOKEN` header. */
  token: string
  /**
   * REST base origin, WITHOUT the `/api/v4` suffix. Defaults to
   * `https://gitlab.com`; a self-managed instance passes its own origin
   * (e.g. `https://gitlab.example.com`).
   */
  baseUrl?: string
  /**
   * The immutable NUMERIC GitLab project id. When set, EVERY REST call addresses
   * the project by this id (`/projects/<id>/…`) instead of the URL-encoded
   * `owner/repo` path. Preferred on the review path (Codex PR-3 hardening): the
   * numeric id is rename/move-stable AND pins the client to exactly the onboarded
   * project whose per-tenant token we resolved — a group/PAT token that can reach
   * many projects can't be steered to a different `owner/repo` than the one the
   * (verified) webhook identified. Absent → the path-encoded fallback (#815).
   */
  projectId?: number
}

/** GitLab's merge-request `diff_refs` — the SHAs an inline `position` pins to. */
interface GitLabDiffRefs {
  base_sha: string
  start_sha: string
  head_sha: string
}

/** One entry of GitLab's MR `/changes` response. */
interface GitLabChange {
  old_path?: string
  new_path?: string
  new_file?: boolean
  renamed_file?: boolean
  deleted_file?: boolean
  diff?: string
}

/**
 * GitLab's MR `/changes` response. GitLab caps very large MRs: `overflow` is
 * `true` (and/or `changes_count` is a `"NNN+"` string) when the change set was
 * truncated. Callers must treat a truncated set as DEGRADED, never as a clean,
 * complete diff (Codex sign-off).
 */
interface GitLabChangesResponse {
  changes?: GitLabChange[]
  changes_count?: string
  overflow?: boolean
}

/** Truncated when GitLab flags `overflow` OR `changes_count` ends in `+`. */
function changesTruncated(res: GitLabChangesResponse): boolean {
  if (res.overflow === true) return true
  return typeof res.changes_count === "string" && /\+\s*$/.test(res.changes_count)
}

const DEFAULT_BASE_URL = "https://gitlab.com"

export class GitLabClient {
  private readonly token: string
  private readonly apiBase: string
  private readonly configuredProjectId: number | undefined

  constructor(opts: GitLabClientOptions) {
    this.token = opts.token
    const origin = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
    this.apiBase = `${origin}/api/v4`
    this.configuredProjectId = opts.projectId
  }

  /** The `:id` path segment: the immutable numeric project id when one was
   *  configured (rename-stable + pins the client to the onboarded project),
   *  else the URL-encoded `group/project` path GitLab also accepts. */
  private projectId(owner: string, repo: string): string {
    if (this.configuredProjectId !== undefined) return String(this.configuredProjectId)
    return encodeURIComponent(`${owner}/${repo}`)
  }

  // ---------------------------------------------------------------------------
  // READ verbs (GitHubPort)
  // ---------------------------------------------------------------------------

  /** MR metadata mapped onto `PullRequestMeta`. */
  async getPullRequest(
    owner: string,
    repo: string,
    prNumber: number,
    opts?: { signal?: AbortSignal },
  ): Promise<PullRequestMeta> {
    const pid = this.projectId(owner, repo)
    const mr = await this.request<RawMergeRequest>(
      "GET",
      `/projects/${pid}/merge_requests/${prNumber}`,
      undefined,
      opts,
    )
    return mapMergeRequestToMeta(prNumber, mr)
  }

  /**
   * Unified diff for an MR. GitLab's `/changes` returns a per-file `diff`
   * that starts at the `@@` hunks WITHOUT the `diff --git` / `---` / `+++`
   * file headers a unified diff needs, so we synthesize those headers per
   * file and concatenate — yielding the same unified-diff string shape the
   * engine's diff parser expects from GitHub.
   *
   * RECALL-SAFETY (Codex review): GitLab TRUNCATES very large MRs. A truncated
   * change set is an INCOMPLETE diff — the review consumer (fetch-and-pack)
   * treats this string as the WHOLE diff, so silently returning a partial one
   * would let files GitLab omitted go unreviewed while the run still looks
   * clean. We THROW instead, so the diff-fetch fails and the run is treated as
   * errored/degraded (never a clean pass on incomplete evidence).
   */
  async getPullRequestDiff(
    owner: string,
    repo: string,
    prNumber: number,
    opts?: { signal?: AbortSignal },
  ): Promise<string> {
    const pid = this.projectId(owner, repo)
    const res = await this.request<GitLabChangesResponse>(
      "GET",
      `/projects/${pid}/merge_requests/${prNumber}/changes`,
      undefined,
      opts,
    )
    if (changesTruncated(res)) {
      throw new GitLabHttpError(
        502,
        `getPullRequestDiff: GitLab truncated the MR ${owner}/${repo}!${prNumber} change set ` +
          `(changes_count=${res.changes_count ?? "?"}); refusing to review a partial diff.`,
      )
    }
    const changes = Array.isArray(res.changes) ? res.changes : []
    return changes.map((c) => synthesizeUnifiedDiff(c)).join("")
  }

  /** Changed files for an MR, derived from `/changes`. */
  async listPullRequestFiles(
    owner: string,
    repo: string,
    prNumber: number,
    opts?: { perPage?: number; maxFiles?: number; signal?: AbortSignal },
  ): Promise<PrChangedFile[]> {
    const pid = this.projectId(owner, repo)
    const maxFiles = opts?.maxFiles ?? 50
    const res = await this.request<GitLabChangesResponse>(
      "GET",
      `/projects/${pid}/merge_requests/${prNumber}/changes`,
      undefined,
      opts?.signal !== undefined ? { signal: opts.signal } : undefined,
    )
    const changes = Array.isArray(res.changes) ? res.changes : []
    const out: PrChangedFile[] = []
    for (const c of changes) {
      if (out.length >= maxFiles) break
      out.push(changeToFile(c))
    }
    return out
  }

  /** Fully-listed changed files for the per-MR review manifest. */
  async listPullFilesForManifest(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<{
    overflow: boolean
    entries: Array<{ filename: string; previous_filename: string | null; status: string }>
  }> {
    const pid = this.projectId(owner, repo)
    const res = await this.request<GitLabChangesResponse>(
      "GET",
      `/projects/${pid}/merge_requests/${prNumber}/changes`,
      undefined,
    )
    const changes = Array.isArray(res.changes) ? res.changes : []
    const entries = changes.map((c) => {
      const f = changeToFile(c)
      return {
        filename: f.filename,
        previous_filename: c.renamed_file && c.old_path ? c.old_path : null,
        status: f.status,
      }
    })
    // GitLab returns the whole MR change set in a single `/changes` payload
    // (no per-file paging), but it TRUNCATES very large MRs — surfaced via
    // `overflow` so a partial manifest is never treated as complete.
    return { overflow: changesTruncated(res), entries }
  }

  /** A file's contents at a git ref via the raw-file endpoint; null on 404. */
  async getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string,
    opts?: { signal?: AbortSignal },
  ): Promise<string | null> {
    const pid = this.projectId(owner, repo)
    const escaped = encodeURIComponent(path)
    try {
      return await this.requestText(
        `/projects/${pid}/repository/files/${escaped}/raw?ref=${encodeURIComponent(ref)}`,
        opts,
      )
    } catch (error) {
      if (error instanceof GitLabHttpError && error.status === 404) return null
      throw error
    }
  }

  /**
   * Recursive repository-tree walk. GitLab's tree endpoint is keyset-paginated
   * and takes a `ref` (branch/tag/sha). `treeSha` here is the commit/ref to
   * walk from (see `getBranch`, which returns the commit sha as `treeSha`).
   * Returns null on 404 so the caller can ack + skip.
   */
  async getRepoTree(
    owner: string,
    repo: string,
    treeSha: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{
    tree: Array<{ path?: string; type?: string; sha?: string; size?: number }>
    truncated: boolean
  } | null> {
    const pid = this.projectId(owner, repo)
    const out: Array<{ path?: string; type?: string; sha?: string; size?: number }> = []
    let page = 1
    const PER_PAGE = 100
    const MAX_PAGES = 100 // 10,000 entries — defensive bound mirroring GitHub's truncation
    try {
      while (page <= MAX_PAGES) {
        const items = await this.request<RawTreeEntry[]>(
          "GET",
          `/projects/${pid}/repository/tree?ref=${encodeURIComponent(treeSha)}&recursive=true&per_page=${PER_PAGE}&page=${page}`,
          undefined,
          opts,
        )
        if (!Array.isArray(items) || items.length === 0) break
        for (const it of items) {
          const entry: { path?: string; type?: string; sha?: string; size?: number } = {}
          if (typeof it.path === "string") entry.path = it.path
          // GitLab uses "blob" / "tree" — already the git-object vocab the caller expects.
          if (typeof it.type === "string") entry.type = it.type
          if (typeof it.id === "string") entry.sha = it.id
          out.push(entry)
        }
        if (items.length < PER_PAGE) break
        page += 1
      }
      return { tree: out, truncated: page > MAX_PAGES }
    } catch (error) {
      if (error instanceof GitLabHttpError && error.status === 404) return null
      throw error
    }
  }

  /**
   * A branch's tip commit SHA. GitLab does not expose a separate git TREE sha
   * on the branch payload the way GitHub does, and its tree-walk endpoint
   * accepts a commit ref directly — so we return the commit sha for BOTH
   * `headSha` and `treeSha` (the latter is consumed only as the ref to
   * `getRepoTree`, which resolves a commit ref fine). Null on 404.
   */
  async getBranch(
    owner: string,
    repo: string,
    branch: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{ headSha: string; treeSha: string } | null> {
    const pid = this.projectId(owner, repo)
    try {
      const res = await this.request<{ commit?: { id?: string } }>(
        "GET",
        `/projects/${pid}/repository/branches/${encodeURIComponent(branch)}`,
        undefined,
        opts,
      )
      const sha = res.commit?.id
      if (typeof sha !== "string" || sha.length === 0) return null
      return { headSha: sha, treeSha: sha }
    } catch (error) {
      if (error instanceof GitLabHttpError && error.status === 404) return null
      throw error
    }
  }

  /** Merge-base SHA for a base/head pair; null on any failure shape. */
  async getMergeBase(owner: string, repo: string, base: string, head: string): Promise<string | null> {
    const pid = this.projectId(owner, repo)
    try {
      const res = await this.request<{ id?: string }>(
        "GET",
        `/projects/${pid}/repository/merge_base?refs[]=${encodeURIComponent(base)}&refs[]=${encodeURIComponent(head)}`,
        undefined,
      )
      return typeof res.id === "string" && res.id.length > 0 ? res.id : null
    } catch (error) {
      if (error instanceof GitLabHttpError) return null
      throw error
    }
  }

  /** Open MRs in the project (for stack detection); default maxItems=200. */
  async listOpenPullRequests(
    owner: string,
    repo: string,
    opts?: { perPage?: number; maxItems?: number; signal?: AbortSignal },
  ): Promise<ListOpenPullsItem[]> {
    const pid = this.projectId(owner, repo)
    const perPage = opts?.perPage ?? 100
    const maxItems = opts?.maxItems ?? 200
    const out: ListOpenPullsItem[] = []
    let page = 1
    while (out.length < maxItems && page < 50) {
      const items = await this.request<RawMergeRequest[]>(
        "GET",
        `/projects/${pid}/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=${perPage}&page=${page}`,
        undefined,
        opts?.signal !== undefined ? { signal: opts.signal } : undefined,
      )
      if (!Array.isArray(items) || items.length === 0) break
      const projectFullName = `${owner}/${repo}`
      for (const it of items) {
        if (out.length >= maxItems) break
        const headRef = it.source_branch ?? ""
        const baseRef = it.target_branch ?? ""
        if (!headRef || !baseRef) continue
        out.push({
          number: typeof it.iid === "number" ? it.iid : 0,
          title: typeof it.title === "string" ? it.title : "",
          state: "open",
          user: it.author?.username ? { login: it.author.username } : null,
          head: { ref: headRef, sha: it.sha ?? "", repo: { full_name: projectFullName } },
          base: { ref: baseRef, sha: it.diff_refs?.base_sha ?? "", repo: { full_name: projectFullName } },
          updated_at: typeof it.updated_at === "string" ? it.updated_at : null,
        })
      }
      if (items.length < perPage) break
      page += 1
    }
    return out
  }

  /**
   * GitHub-only concept: a PR "review" object (APPROVED / CHANGES_REQUESTED
   * with an id). GitLab has no equivalent — approvals + discussions are
   * separate primitives and carry no matching shape, so a GitLab review CANNOT
   * be enumerated this way. We THROW (rather than return `[]`) so the generic,
   * GitHub-shaped consumers reach their INCONCLUSIVE branch instead of reading
   * an empty list as a definitive answer:
   *
   *   - `verifyReviewPersisted` (PR-3 posted path): the empty list would be read
   *     as "the submit did not persist" and trigger a duplicate comment-fallback
   *     re-post. On a throw it defaults to `verified = true` — which is CORRECT
   *     for GitLab: unlike GitHub's occasionally-silent submit, `submitReview`
   *     here already rethrows unless the note POST returned 2xx, so a returned
   *     submit IS confirmed-posted.
   *   - `dismissPriorSigilixReviews`: catches and no-ops (`{dismissed:0}`) — the
   *     same net "nothing to dismiss" as the old `[]`, and GitLab has no review
   *     object to dismiss anyway.
   *
   * KNOWN LIMITATION (PR-4 follow-up): the invariant-lens AMENDMENT lane
   * (`OPENCLAW_INVARIANT_LENS_MODE=on|shadow`, DEFAULT OFF) dedupes + verifies via
   * this method and, on a throw, aborts before posting (`dedupe-lookup-failed`),
   * so amendment findings would not post on GitLab. That lane is GitHub-review-
   * object-shaped and needs its own note/discussion-based dedupe for GitLab; it is
   * off on the default GitLab review path.
   *
   * Recall-safe on the default path: no finding is dropped — the review is fully
   * posted via `submitReview` (summary note + inline discussions), which fails LOUDLY.
   */
  listPullRequestReviews(
    _owner: string,
    _repo: string,
    _prNumber: number,
  ): Promise<
    Array<{ id: number; state: string; user: { login: string } | null; body: string; commitId: string | null }>
  > {
    return Promise.reject(
      new GitLabHttpError(
        501,
        "listPullRequestReviews: GitLab has no PR-review objects to enumerate; verification is inconclusive.",
      ),
    )
  }

  // ---------------------------------------------------------------------------
  // WRITE verbs (ReviewSinkPort)
  // ---------------------------------------------------------------------------

  /**
   * Post a review onto an MR. GitHub bundles the body + every inline comment
   * into ONE POST; GitLab has no bundle, so this maps the port shape onto:
   *   1. ONE summary MR *note* carrying `review.body` (the top-level review),
   *   2. ONE MR *discussion* per inline comment, each with a `position` pinned
   *      to the MR's `diff_refs` (base/start/head sha) + new/old path + line.
   *
   * RECALL-SAFETY (Codex sign-off): the inline `comments` are LOAD-BEARING —
   * with everything-inline rendering the findings live in the comments, NOT
   * necessarily restated in `review.body`. So a lost inline comment is a lost
   * finding. Three-layer guarantee that no finding silently disappears:
   *   - The summary note POST rethrows on failure -> the (PR-3) post-submit
   *     verify marks the review DEGRADED (never a silent clean pass).
   *   - Each inline discussion POST is attempted; failures (bad position, or no
   *     diff_refs to anchor to) are COLLECTED, not swallowed.
   *   - If ANY inline comment failed, its full text is re-posted in a single
   *     consolidated FALLBACK note so the finding still surfaces on the MR. If
   *     that fallback note itself fails to POST, we RETHROW (the findings would
   *     otherwise be lost -> degraded, never a clean pass).
   *
   * Returns the summary note id as the review id (+ the mapped state) so the
   * caller has a stable handle, matching the GitHub `{id, state}` return.
   */
  async submitReview(
    owner: string,
    repo: string,
    prNumber: number,
    review: SubmitReviewBody,
  ): Promise<{ id: number; state: string }> {
    const pid = this.projectId(owner, repo)
    // 1. Summary note (rethrows on failure -> degraded review).
    const summary = await this.request<{ id?: number }>(
      "POST",
      `/projects/${pid}/merge_requests/${prNumber}/notes`,
      { body: review.body ?? "" },
      undefined,
    )
    const summaryId = typeof summary.id === "number" ? summary.id : 0

    // 2. Inline discussions, with a fallback note for any that don't anchor.
    const comments = Array.isArray(review.comments) ? review.comments : []
    if (comments.length > 0) {
      let diffRefs: GitLabDiffRefs | null = null
      try {
        const mr = await this.request<RawMergeRequest>("GET", `/projects/${pid}/merge_requests/${prNumber}`, undefined)
        diffRefs = normalizeDiffRefs(mr.diff_refs)
      } catch (err) {
        console.warn(
          JSON.stringify({
            event: "gitlab-submit-review-diffrefs-failed",
            project: `${owner}/${repo}`,
            mr_iid: prNumber,
            err: err instanceof Error ? err.message : String(err),
          }),
        )
      }
      const failed: SubmitReviewComment[] = []
      for (const c of comments) {
        // No diff_refs -> we cannot build a valid inline position; treat as a
        // failed anchor so the finding goes into the fallback note (never dropped).
        if (!diffRefs) {
          failed.push(c)
          continue
        }
        try {
          await this.request(
            "POST",
            `/projects/${pid}/merge_requests/${prNumber}/discussions`,
            this.buildDiscussionBody(c, diffRefs),
            undefined,
          )
        } catch (err) {
          failed.push(c)
          console.warn(
            JSON.stringify({
              event: "gitlab-submit-review-inline-failed",
              project: `${owner}/${repo}`,
              mr_iid: prNumber,
              path: c.path,
              line: c.line,
              err: err instanceof Error ? err.message : String(err),
            }),
          )
        }
      }
      if (failed.length > 0) {
        // Recall-safety: re-surface every un-anchored finding in one fallback
        // note. Rethrows if the note itself fails (findings would be lost).
        console.warn(
          JSON.stringify({
            event: "gitlab-submit-review-inline-degraded",
            project: `${owner}/${repo}`,
            mr_iid: prNumber,
            inline_failures: failed.length,
            inline_total: comments.length,
            note: "inline anchoring degraded; re-posting failed findings in a fallback note.",
          }),
        )
        await this.request(
          "POST",
          `/projects/${pid}/merge_requests/${prNumber}/notes`,
          { body: buildFallbackNote(failed) },
          undefined,
        )
      }
    }
    return { id: summaryId, state: review.event }
  }

  /** Build a GitLab discussion POST body with a `position` for an inline comment. */
  private buildDiscussionBody(c: SubmitReviewComment, refs: GitLabDiffRefs): Record<string, unknown> {
    const position: Record<string, unknown> = {
      position_type: "text",
      base_sha: refs.base_sha,
      start_sha: refs.start_sha,
      head_sha: refs.head_sha,
      new_path: c.path,
      old_path: c.path,
    }
    // GitHub `side`: RIGHT (default) = the new/added side -> `new_line`;
    // LEFT = the old/context side -> `old_line`.
    if (c.side === "LEFT") {
      position.old_line = c.line
    } else {
      position.new_line = c.line
    }
    return { body: c.body, position }
  }

  /** Post a top-level MR note — the summary/fallback poster. */
  async createIssueComment(owner: string, repo: string, issueNumber: number, body: string): Promise<{ id: number }> {
    const pid = this.projectId(owner, repo)
    const res = await this.request<{ id?: number }>(
      "POST",
      `/projects/${pid}/merge_requests/${issueNumber}/notes`,
      { body },
      undefined,
    )
    return { id: typeof res.id === "number" ? res.id : 0 }
  }

  /**
   * GitHub replies to an inline comment by NUMERIC comment id. GitLab threads
   * a reply onto a DISCUSSION by its STRING id — the numeric `commentId` the
   * port passes cannot be mapped back to a discussion id reliably, so we
   * degrade to a fresh top-level MR note carrying the reply body (documented).
   * Off the GitLab automatic ingress path; recall-neutral (the reply still lands).
   */
  async replyToReviewComment(
    owner: string,
    repo: string,
    prNumber: number,
    _commentId: number,
    body: string,
  ): Promise<{ id: number }> {
    return this.createIssueComment(owner, repo, prNumber, body)
  }

  /**
   * GitHub-only: dismiss a prior review object. GitLab has no review object to
   * dismiss (see `listPullRequestReviews`), so this is a documented no-op. Not
   * on the GitLab automatic ingress path; recall-neutral.
   */
  async dismissReview(
    owner: string,
    repo: string,
    prNumber: number,
    reviewId: number,
    _message: string,
  ): Promise<void> {
    console.warn(
      JSON.stringify({
        event: "gitlab-dismiss-review-noop",
        project: `${owner}/${repo}`,
        mr_iid: prNumber,
        review_id: reviewId,
        note: "GitLab has no review object to dismiss; no-op.",
      }),
    )
  }

  /**
   * GitHub-only: PATCH a prior review body in place. `reviewId` here is a note
   * id (from `submitReview`), so we PUT the MR note body. Best-effort — logs +
   * swallows on failure since it is a cosmetic stale-notice update, not a
   * finding surface.
   */
  async updateReviewBody(owner: string, repo: string, prNumber: number, reviewId: number, body: string): Promise<void> {
    const pid = this.projectId(owner, repo)
    try {
      await this.request("PUT", `/projects/${pid}/merge_requests/${prNumber}/notes/${reviewId}`, { body }, undefined)
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "gitlab-update-review-body-failed",
          project: `${owner}/${repo}`,
          mr_iid: prNumber,
          note_id: reviewId,
          err: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  private async request<T>(method: string, path: string, body: unknown, opts?: { signal?: AbortSignal }): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.apiBase}${path}`
    const init: RequestInit = { method, headers: this.headers(body !== undefined) }
    if (body !== undefined) init.body = JSON.stringify(body)
    if (opts?.signal !== undefined) init.signal = opts.signal
    const res = await fetch(url, init)
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new GitLabHttpError(res.status, `${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`)
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  private async requestText(path: string, opts?: { signal?: AbortSignal }): Promise<string> {
    const url = path.startsWith("http") ? path : `${this.apiBase}${path}`
    const init: RequestInit = { method: "GET", headers: this.headers(false) }
    if (opts?.signal !== undefined) init.signal = opts.signal
    const res = await fetch(url, init)
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new GitLabHttpError(res.status, `GET ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`)
    }
    return await res.text()
  }

  private headers(hasBody: boolean): Record<string, string> {
    const h: Record<string, string> = {
      accept: "application/json",
      "private-token": this.token,
      "user-agent": "sigilix-worker",
    }
    if (hasBody) h["content-type"] = "application/json"
    return h
  }
}

// -----------------------------------------------------------------------------
// Pure wire-mapping helpers
// -----------------------------------------------------------------------------

interface RawMergeRequest {
  iid?: number
  title?: string
  description?: string | null
  state?: string
  source_branch?: string
  target_branch?: string
  sha?: string
  work_in_progress?: boolean
  draft?: boolean
  merged_at?: string | null
  closed_at?: string | null
  changes_count?: string
  updated_at?: string
  author?: { username?: string }
  labels?: string[]
  diff_refs?: { base_sha?: string; start_sha?: string; head_sha?: string } | null
}

interface RawTreeEntry {
  id?: string
  name?: string
  type?: string
  path?: string
}

function mapMergeRequestToMeta(iid: number, mr: RawMergeRequest): PullRequestMeta {
  const headSha = mr.diff_refs?.head_sha ?? mr.sha ?? ""
  const baseSha = mr.diff_refs?.base_sha ?? ""
  const meta: PullRequestMeta = {
    number: typeof mr.iid === "number" ? mr.iid : iid,
    title: typeof mr.title === "string" ? mr.title : "",
    body: typeof mr.description === "string" ? mr.description : null,
    user: mr.author?.username ? { login: mr.author.username } : null,
    head: { sha: headSha, ref: mr.source_branch ?? "" },
    base: { sha: baseSha, ref: mr.target_branch ?? "" },
    draft: mr.draft === true || mr.work_in_progress === true,
    // GitLab MR state is "opened" | "closed" | "merged" | "locked"; map to the
    // GitHub "open" | "closed" pair (merged/locked collapse to "closed").
    state: mr.state === "opened" ? "open" : "closed",
    merged_at: mr.merged_at ?? null,
    closed_at: mr.closed_at ?? null,
    ...(Array.isArray(mr.labels) ? { labels: mr.labels.map((name) => ({ name })) } : {}),
  }
  return meta
}

function changeToFile(c: GitLabChange): PrChangedFile {
  const patch = typeof c.diff === "string" ? c.diff : ""
  let additions = 0
  let deletions = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1
  }
  const file: PrChangedFile = {
    filename: c.new_path ?? c.old_path ?? "",
    status: c.new_file ? "added" : c.deleted_file ? "removed" : c.renamed_file ? "renamed" : "modified",
    additions,
    deletions,
  }
  if (patch.length > 0) file.patch = patch
  return file
}

/**
 * Build a unified-diff block for one GitLab change: synthesize the
 * `diff --git` / `---` / `+++` file headers (which GitLab omits from its
 * per-file `diff`) and append the hunk body. `/dev/null` on the add/delete
 * side matches standard unified-diff convention.
 */
function synthesizeUnifiedDiff(c: GitLabChange): string {
  const oldPath = c.old_path ?? c.new_path ?? ""
  const newPath = c.new_path ?? c.old_path ?? ""
  const body = typeof c.diff === "string" ? c.diff : ""
  if (body.length === 0) return ""
  const header =
    `diff --git a/${oldPath} b/${newPath}\n` +
    `--- ${c.new_file ? "/dev/null" : `a/${oldPath}`}\n` +
    `+++ ${c.deleted_file ? "/dev/null" : `b/${newPath}`}\n`
  return header + (body.endsWith("\n") ? body : `${body}\n`)
}

function normalizeDiffRefs(refs: RawMergeRequest["diff_refs"]): GitLabDiffRefs | null {
  if (!refs) return null
  const { base_sha, start_sha, head_sha } = refs
  if (
    typeof base_sha !== "string" ||
    typeof start_sha !== "string" ||
    typeof head_sha !== "string" ||
    base_sha.length === 0 ||
    head_sha.length === 0
  ) {
    return null
  }
  return { base_sha, start_sha, head_sha }
}

/**
 * Consolidate every un-anchored inline finding into ONE fallback note body so
 * no finding is lost when a GitLab inline `position` is rejected (or diff_refs
 * couldn't be fetched). Each finding keeps its `path:line` prefix so the reader
 * can still locate it even without GitLab's line-anchor UI.
 */
function buildFallbackNote(comments: SubmitReviewComment[]): string {
  const header =
    "Sigilix could not anchor the following finding(s) to specific diff lines on GitLab; " +
    "they are re-posted here so nothing is lost:\n"
  const blocks = comments.map((c) => {
    const loc = `\`${c.path}\`${typeof c.line === "number" ? `:${c.line}` : ""}`
    return `\n---\n**${loc}**\n\n${c.body}`
  })
  return header + blocks.join("")
}
