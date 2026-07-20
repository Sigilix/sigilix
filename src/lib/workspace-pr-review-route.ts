// sig-pr-interface-fixes — GET /v1/workspace/prs/:installationId/:repo/:number/review.
//
// Returns Sigilix's review stack for ONE pull request, sourced LIVE from the
// GitHub API with the repo's installation token: the bot's inline review
// comments (grouped by file) plus its latest review summary. Powers the
// portal's per-PR review feed (PullRequestsPanel.tsx's RealPrDetail) — the
// portal previously had no per-PR endpoint and rendered an "honest empty"
// link-out; this replaces that with the real grouped review.
//
// Auth (mirrors workspace-prs-route.ts): a portal browser SESSION cookie
// (requireSession) is tried FIRST; a request with no session falls back to a
// bearer API key (requireApiTenant). Neither → 401. CORS'd for the portal
// origins (portal-cors.ts, wired in index.ts alongside /v1/workspace/prs).
//
// Tenant isolation (CRITICAL — fail-closed): the caller may only read a review
// for an installation it OWNS.
//   - Session path: `installationId` must be in the set the session's GitHub
//     user-to-server token can see (`GET /user/installations`). Not owned → 403.
//   - Api-key path: the key's own `installationId` must equal the requested one
//     (the legacy global-key sentinel is Sigilix-internal and may read any).
//     Mismatch → 403.
// The ownership gate runs BEFORE any installation token is minted or any repo
// data is fetched, so a caller can never probe another tenant's PR.
//
// GitHub fetch: `GET /repos/{owner}/{repo}/pulls/{n}/comments` (inline review
// comments, paginated) + `GET .../issues/{n}/comments` (the editable overview
// sticky) + `GET .../pulls/{n}/reviews` (review-submission fallback). All are
// filtered to the Sigilix bot author (SIGILIX_BOT_LOGIN) — CodeRabbit / human /
// other-bot comments never appear. Inline comments are grouped by file path
// (grouping is the pure, unit-tested `groupReviewComments` below).
//
// The `summary` is the OVERVIEW — the bot's `<!-- sigilix:pr-overview -->`
// sticky issue comment (summary / quality gates / important files / findings),
// picked by `pickOverviewComment`. Under SIG-471 the PR *review-submission* body
// was gutted to just the `<!-- sigilix:pr-review -->` marker (the inline comments
// speak for themselves), so the real overview lives ONLY in that editable sticky;
// reading the review body alone is why the portal used to render a raw marker with
// an empty body. The review-submission summary (`latestReviewSummary`) stays as a
// fallback for legacy PRs that predate the sticky.
//
// Fail-closed on config/auth; fail-loud on GitHub faults: a missing GitHub App
// config is 503, a mint/fetch failure is 502 — the portal shows a retriable
// error state rather than a misleading empty review.

import { requireSession } from "@/src/lib/auth-middleware"
import { getValidGithubToken } from "@/src/lib/github-user-token"
import { requireApiTenant, LEGACY_TENANT_INSTALLATION_ID } from "@/src/lib/api-key-resolver"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import { SIGILIX_BOT_LOGIN } from "@/src/shared/domain/sigilix-identity"
import { OVERVIEW_MARKER, LEGACY_OVERVIEW_MARKER } from "@/src/lib/triage-pr-overview-scan"
import type { Env } from "@/src/shared/types/env"

const MAX_INSTALLATION_PAGES = 20
const MAX_COMMENT_PAGES = 10
const PER_PAGE = 100

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

// ─── Response shape (matches the portal's WorkspacePrReview) ──────

export interface PrReviewComment {
  id: number
  line: number | null
  body: string
  diffHunk: string | null
}

export interface PrReviewFile {
  path: string
  comments: PrReviewComment[]
}

export interface PrReviewSummary {
  id: number
  state: string
  body: string
}

export interface WorkspacePrReviewResponse {
  installationId: number
  repo: string
  prNumber: number
  summary: PrReviewSummary | null
  files: PrReviewFile[]
}

// ─── GitHub wire shapes (only the fields we read) ────────────────

interface GithubReviewComment {
  id?: unknown
  path?: unknown
  line?: unknown
  original_line?: unknown
  body?: unknown
  diff_hunk?: unknown
  user?: { login?: unknown } | null
  created_at?: unknown
}

interface GithubReview {
  id?: unknown
  state?: unknown
  body?: unknown
  submitted_at?: unknown
  user?: { login?: unknown } | null
}

/** True when a GitHub actor object is the Sigilix bot. */
function isSigilixAuthor(user: { login?: unknown } | null | undefined): boolean {
  return !!user && typeof user.login === "string" && user.login === SIGILIX_BOT_LOGIN
}

/**
 * Group Sigilix inline review comments by file path, preserving first-seen file
 * order and per-file comment order. Pure — no IO — so it's unit-tested with
 * plain inputs. Only the fields the portal renders are projected; a comment
 * with a non-string path is skipped (it can't be anchored to a file group).
 * `line` prefers GitHub's current `line`, falling back to `original_line`
 * (a comment on an outdated commit still anchors), else null.
 */
export function groupReviewComments(comments: GithubReviewComment[]): PrReviewFile[] {
  const files: PrReviewFile[] = []
  const byPath = new Map<string, PrReviewFile>()
  for (const c of comments) {
    if (!isSigilixAuthor(c.user)) continue
    const path = typeof c.path === "string" ? c.path : ""
    if (path === "") continue
    const line = typeof c.line === "number" ? c.line : typeof c.original_line === "number" ? c.original_line : null
    const comment: PrReviewComment = {
      id: typeof c.id === "number" ? c.id : 0,
      line,
      body: typeof c.body === "string" ? c.body : "",
      diffHunk: typeof c.diff_hunk === "string" ? c.diff_hunk : null,
    }
    let group = byPath.get(path)
    if (!group) {
      group = { path, comments: [] }
      byPath.set(path, group)
      files.push(group)
    }
    group.comments.push(comment)
  }
  return files
}

/** A comment/review body stripped of HTML comments (Sigilix markers), for an
 *  "is there anything to render?" check. `<!-- sigilix:pr-review -->\n` → "". */
function bodyWithoutMarkers(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, "").trim()
}

/**
 * The Sigilix bot's most recent review summary with RENDERABLE content, or null.
 * A body that is only the SIG-471 `<!-- sigilix:pr-review -->` marker (or empty)
 * is skipped — returning it would re-expose the raw-marker/empty-body failure the
 * overview sticky exists to fix, on the legacy fallback path. Ties on
 * `submitted_at` (or a missing timestamp) keep the last-seen — GitHub returns
 * reviews oldest-first, so the last of equal timestamps is the freshest.
 */
export function latestReviewSummary(reviews: GithubReview[]): PrReviewSummary | null {
  let best: PrReviewSummary | null = null
  let bestAt = ""
  for (const r of reviews) {
    if (!isSigilixAuthor(r.user)) continue
    const body = typeof r.body === "string" ? r.body : ""
    if (bodyWithoutMarkers(body) === "") continue
    const at = typeof r.submitted_at === "string" ? r.submitted_at : ""
    if (best === null || at >= bestAt) {
      best = {
        id: typeof r.id === "number" ? r.id : 0,
        state: typeof r.state === "string" ? r.state : "",
        body,
      }
      bestAt = at
    }
  }
  return best
}

interface GithubIssueComment {
  id?: unknown
  body?: unknown
  updated_at?: unknown
  user?: { login?: unknown } | null
}

/**
 * The Sigilix "overview" sticky — the bot's `<!-- sigilix:pr-overview -->` (or
 * legacy `<!-- openclaw:pr-overview -->`) issue comment, whose body carries the
 * customer-facing summary / quality gates / important files / findings. There is
 * exactly one sticky per PR (the review pipeline PATCHes it in place); on the
 * off chance of duplicates we keep the most recently updated. Returns it shaped
 * like a `PrReviewSummary` (`state: "OVERVIEW"`) so the portal renders it in the
 * same summary slot, or null when no sticky exists (legacy PRs → the caller
 * falls back to the review-submission summary). Pure — exported for tests.
 */
export function pickOverviewComment(comments: GithubIssueComment[]): PrReviewSummary | null {
  let best: PrReviewSummary | null = null
  let bestAt = ""
  for (const c of comments) {
    if (!isSigilixAuthor(c.user)) continue
    const body = typeof c.body === "string" ? c.body : ""
    if (!body.includes(OVERVIEW_MARKER) && !body.includes(LEGACY_OVERVIEW_MARKER)) continue
    const at = typeof c.updated_at === "string" ? c.updated_at : ""
    if (best === null || at >= bestAt) {
      best = { id: typeof c.id === "number" ? c.id : 0, state: "OVERVIEW", body }
      bestAt = at
    }
  }
  return best
}

// ─── Path parsing ────────────────────────────────────────────────

interface ParsedPath {
  installationId: number
  owner: string
  repo: string
  prNumber: number
}

/**
 * Parse `/v1/workspace/prs/:installationId/:repo/:number/review`. `:repo` is the
 * percent-encoded `owner/repo` (the portal calls `encodeURIComponent(repo)`),
 * so it arrives as a single path segment; we decode then split on the first
 * slash. Returns null on any malformed segment.
 */
export function parseReviewPath(pathname: string): ParsedPath | null {
  const prefix = "/v1/workspace/prs/"
  if (!pathname.startsWith(prefix)) return null
  const rest = pathname.slice(prefix.length)
  const match = /^(\d+)\/([^/]+)\/(\d+)\/review$/.exec(rest)
  if (!match) return null
  const installationId = Number(match[1])
  const prNumber = Number(match[3])
  if (!Number.isSafeInteger(installationId) || installationId <= 0) return null
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null
  let repoFull: string
  try {
    repoFull = decodeURIComponent(match[2]!)
  } catch {
    return null
  }
  const slash = repoFull.indexOf("/")
  if (slash <= 0 || slash === repoFull.length - 1) return null
  const owner = repoFull.slice(0, slash)
  const repo = repoFull.slice(slash + 1)
  if (repo.includes("/")) return null
  return { installationId, owner, repo, prNumber }
}

// ─── Ownership (tenant isolation) ────────────────────────────────

const githubHeaders = (auth: string): HeadersInit => ({
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  authorization: auth,
  "user-agent": "sigilix-worker",
})

/** Installation ids the session's user-to-server token can see. Soft-fails to []. */
async function fetchUserInstallationIds(accessToken: string): Promise<number[]> {
  const ids: number[] = []
  let seen = 0
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
    let res: Response
    try {
      res = await fetch(`https://api.github.com/user/installations?per_page=100&page=${page}`, {
        headers: githubHeaders(`Bearer ${accessToken}`),
      })
    } catch {
      break
    }
    if (!res.ok) break
    let body: { total_count?: number; installations?: Array<{ id?: number }> }
    try {
      body = (await res.json()) as { total_count?: number; installations?: Array<{ id?: number }> }
    } catch {
      break
    }
    const installs = Array.isArray(body.installations) ? body.installations : []
    for (const inst of installs) if (typeof inst.id === "number") ids.push(inst.id)
    seen += installs.length
    const total = typeof body.total_count === "number" ? body.total_count : seen
    if (installs.length === 0 || seen >= total) break
  }
  return ids
}

// ─── GitHub fetch ────────────────────────────────────────────────

/** Fetch all pages of the bot's inline review comments for a PR. Throws on a non-OK page. */
async function fetchReviewComments(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<GithubReviewComment[]> {
  const all: GithubReviewComment[] = []
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/comments?per_page=${PER_PAGE}&page=${page}`,
      { headers: githubHeaders(`token ${token}`) },
    )
    if (!res.ok) throw new Error(`comments HTTP ${res.status}`)
    const arr = (await res.json()) as GithubReviewComment[]
    if (!Array.isArray(arr) || arr.length === 0) break
    all.push(...arr)
    if (arr.length < PER_PAGE) break
  }
  return all
}

/** Fetch the PR's reviews (single page — a PR rarely has >100 review summaries). Throws on non-OK. */
async function fetchReviews(token: string, owner: string, repo: string, prNumber: number): Promise<GithubReview[]> {
  const res = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/reviews?per_page=${PER_PAGE}`,
    { headers: githubHeaders(`token ${token}`) },
  )
  if (!res.ok) throw new Error(`reviews HTTP ${res.status}`)
  const arr = (await res.json()) as GithubReview[]
  return Array.isArray(arr) ? arr : []
}

/**
 * Fetch all pages of the PR's issue comments — the timeline the overview sticky
 * lives in (a PR is an issue, so its top-level comments are `/issues/{n}/comments`,
 * distinct from the inline review comments on `/pulls/{n}/comments`). Throws on a
 * non-OK page so the handler fails loud (retriable) rather than dropping the
 * overview silently.
 */
async function fetchIssueComments(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<GithubIssueComment[]> {
  const all: GithubIssueComment[] = []
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${prNumber}/comments?per_page=${PER_PAGE}&page=${page}`,
      { headers: githubHeaders(`token ${token}`) },
    )
    if (!res.ok) throw new Error(`issue comments HTTP ${res.status}`)
    const arr = (await res.json()) as GithubIssueComment[]
    if (!Array.isArray(arr) || arr.length === 0) break
    all.push(...arr)
    if (arr.length < PER_PAGE) break
  }
  return all
}

// ─── Handler ─────────────────────────────────────────────────────

/** GET /v1/workspace/prs/:installationId/:repo/:number/review — see file header. */
export async function handleWorkspacePrReviewRoute(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const parsed = parseReviewPath(new URL(request.url).pathname)
  if (!parsed) return json({ error: "not_found" }, 404)

  // ── Auth + ownership (fail-closed) ──
  const authed = await requireSession(request, env, ctx)
  if (authed) {
    if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) {
      console.error(JSON.stringify({ event: "pr-review-encryption-key-missing" }))
      return json({ error: "misconfigured" }, 503)
    }
    let accessToken: string
    try {
      accessToken = await getValidGithubToken({
        env,
        sessionId: authed.sessionId,
        record: authed.record,
        encryptionKeyB64url: env.OPENCLAW_SESSION_ENCRYPTION_KEY,
      })
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "pr-review-decrypt-failed",
          err: error instanceof Error ? error.message : String(error),
        }),
      )
      return json({ error: "pr_review_failed" }, 500)
    }
    const owned = await fetchUserInstallationIds(accessToken)
    if (!owned.includes(parsed.installationId)) {
      return json({ error: "forbidden" }, 403)
    }
  } else {
    const apiAuth = await requireApiTenant(request, env, ctx)
    if ("response" in apiAuth) return apiAuth.response // 401
    const callerId = apiAuth.caller.installationId
    const owns = callerId === LEGACY_TENANT_INSTALLATION_ID || callerId === parsed.installationId
    if (!owns) return json({ error: "forbidden" }, 403)
  }

  // ── Mint the installation token (fail-closed on missing config) ──
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    return json({ error: "grounded_not_configured" }, 503)
  }
  let token: string
  try {
    token = await getInstallationToken({
      kv: env.OPENCLAW_STATE,
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      installationId: parsed.installationId,
    })
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "pr-review-token-failed",
        installationId: parsed.installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return json({ error: "github_unavailable" }, 502)
  }

  // ── Fetch + shape the review stack (fail-loud so the portal can retry) ──
  try {
    const [comments, reviews, issueComments] = await Promise.all([
      fetchReviewComments(token, parsed.owner, parsed.repo, parsed.prNumber),
      fetchReviews(token, parsed.owner, parsed.repo, parsed.prNumber),
      fetchIssueComments(token, parsed.owner, parsed.repo, parsed.prNumber),
    ])
    // Prefer the editable overview sticky (the real summary/gates/files body);
    // fall back to the review-submission summary for legacy PRs without a sticky.
    const summary = pickOverviewComment(issueComments) ?? latestReviewSummary(reviews)
    return json(
      {
        installationId: parsed.installationId,
        repo: `${parsed.owner}/${parsed.repo}`,
        prNumber: parsed.prNumber,
        summary,
        files: groupReviewComments(comments),
      } satisfies WorkspacePrReviewResponse,
      200,
    )
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "pr-review-fetch-failed",
        installationId: parsed.installationId,
        repo: `${parsed.owner}/${parsed.repo}`,
        prNumber: parsed.prNumber,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return json({ error: "github_unavailable" }, 502)
  }
}
