// sig-workspace-prs — GET /v1/workspace/prs.
//
// Powers the portal's Pull-requests workspace page: two sections built from
// the SAME underlying D1 usage_ledger scan — `org` (every Sigilix-reviewed
// PR across the caller's installations) and `mine` (the subset of `org`
// authored by the signed-in user, case-insensitive login match).
//
// Auth is EITHER a portal session cookie (requireSession — browser callers)
// OR a bearer api key (requireApiTenant — CLI/automation callers). Session is
// tried first since this is a portal-first page; a request with no session
// cookie falls back to the bearer path. CORS'd for the portal origins
// (portal-cors.ts, wired alongside /v1/onboarding/context in index.ts).
//
// Installation scoping:
//   - Session path: every installation the session's GitHub user-to-server
//     token can see via `GET /user/installations` — same call the setup
//     wizard's repo picker uses (onboarding-context-route.ts), but this route
//     only needs the installation ids, not the repo listing, so it's a
//     smaller local helper rather than reusing that route's private
//     functions. Soft-fails to [] on any GitHub error (never blocks the
//     panel) — mirrors onboarding-context-route.ts's fetchInstallations.
//   - Api-key path: the key's own installationId. The legacy global-key
//     sentinel (LEGACY_TENANT_INSTALLATION_ID) stays broad on purpose —
//     it is Sigilix-internal, never handed to an external tenant — matching
//     callerOwnsInstallation's existing legacy semantics in
//     api-key-resolver.ts. A real per-tenant key is scoped to exactly its
//     own installation; it can never see another tenant's rows.
//
// Display cap: each section (`org`, `mine`) is independently capped at
// PER_SECTION_LIMIT distinct PRs, newest-first, AFTER collapsing the adapter's
// raw ledger rows (see d1-workspace-prs-read.ts's RECENT_LIMIT comment for why
// the raw scan is wider than this). `mine` is sliced from the full collapsed
// set rather than from an already-capped `org` list — otherwise a less-active
// author's PR that ranks outside `org`'s top 100 (because busier PRs from
// other authors outrank it) would never reach `mine`, even though `mine`
// itself has plenty of room.
//
// Fail-soft on the DATA path: a D1 read fault (readRecentWorkspacePrs ->
// { ok: false }, which itself already warn-logs the underlying error) or a
// GitHub installations-listing error resolves to `{ org: [], mine: [] }` at
// 200 — the panel never breaks because the ledger or GitHub is unhappy.
// 401 without either auth. Two AUTH-adjacent paths intentionally do NOT
// soft-fail, matching onboarding-context-route.ts's precedent: a missing
// OPENCLAW_SESSION_ENCRYPTION_KEY is a genuine misconfiguration (503), and a
// session access-token decrypt failure (a session integrity problem, not a
// transient data-source hiccup) is a 500 — the panel failing loudly there is
// preferable to silently mis-scoping a query.

import { requireSession } from "@/src/lib/auth-middleware"
import { decryptAccessToken } from "@/src/lib/auth-session"
import { requireApiTenant, LEGACY_TENANT_INSTALLATION_ID } from "@/src/lib/api-key-resolver"
import { readRecentWorkspacePrs, collapseWorkspacePrs, type WorkspacePrSummary } from "@/src/features/tenancy"
import { resolveGithubAuthors } from "@/src/shared/adapters/github/resolve-authors"
import type { Env } from "@/src/shared/types/env"

// sig-pr-interface-fixes: re-exported so index.ts imports both workspace-PR
// handlers on one line (the index god-file is at its max-lines budget).
export { handleWorkspacePrReviewRoute } from "@/src/lib/workspace-pr-review-route"

const MAX_INSTALLATION_PAGES = 20
const PER_SECTION_LIMIT = 100

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

interface GitHubInstallation {
  id?: number
}

interface UserInstallationsResponse {
  total_count?: number
  installations?: GitHubInstallation[]
}

function githubHeaders(accessToken: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${accessToken}`,
    "user-agent": "sigilix-worker",
  }
}

/** Every installation id the session's GitHub user-to-server token can see. Soft-fails to []. */
async function fetchUserInstallationIds(accessToken: string): Promise<number[]> {
  const ids: number[] = []
  let seen = 0
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
    let res: Response
    try {
      res = await fetch(`https://api.github.com/user/installations?per_page=100&page=${page}`, {
        headers: githubHeaders(accessToken),
      })
    } catch {
      break
    }
    if (!res.ok) break
    let body: UserInstallationsResponse
    try {
      body = (await res.json()) as UserInstallationsResponse
    } catch {
      break
    }
    const installs = Array.isArray(body.installations) ? body.installations : []
    for (const inst of installs) {
      if (typeof inst.id === "number") ids.push(inst.id)
    }
    seen += installs.length
    const total = typeof body.total_count === "number" ? body.total_count : seen
    if (installs.length === 0 || seen >= total) break
  }
  return ids
}

/** GitHub author identity attached to each PR row — `avatarUrl` is valid for
 *  EVERY author including bots/apps (the login-based `github.com/<login>.png`
 *  URL 404s for a `[bot]` login). Resolved via GitHub (resolve-authors.ts) on
 *  the session path; null-valued on the api-key path (no user token). */
export interface WorkspacePrAuthor {
  login: string | null
  avatar_url: string | null
  id: number | null
}

/** A PR row in the response: the collapsed ledger summary plus a resolved
 *  `author` object. `authorLogin` is kept as a transitional flat field. */
export type WorkspacePrRow = WorkspacePrSummary & { author: WorkspacePrAuthor }

export interface WorkspacePrsResponse {
  org: WorkspacePrRow[]
  mine: WorkspacePrRow[]
}

/** GET /v1/workspace/prs — see file header. */
export async function handleWorkspacePrsRoute(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const authed = await requireSession(request, env, ctx)

  let scope: number[] | "all"
  let sessionLogin: string | null = null
  let accessToken: string | null = null

  if (authed) {
    if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) {
      console.error(JSON.stringify({ event: "workspace-prs-encryption-key-missing" }))
      return json({ error: "misconfigured" }, 503)
    }
    sessionLogin = authed.record.login

    let token: string
    try {
      token = await decryptAccessToken(
        { encryptedAccessToken: authed.record.encryptedAccessToken, iv: authed.record.iv },
        authed.sessionId,
        env.OPENCLAW_SESSION_ENCRYPTION_KEY,
      )
    } catch (error) {
      // Never log the token itself — only the fact that decryption failed.
      console.error(
        JSON.stringify({
          event: "workspace-prs-decrypt-failed",
          err: error instanceof Error ? error.message : String(error),
        }),
      )
      return json({ error: "workspace_prs_failed" }, 500)
    }

    accessToken = token
    scope = await fetchUserInstallationIds(token)
  } else {
    const apiAuth = await requireApiTenant(request, env, ctx)
    if ("response" in apiAuth) return apiAuth.response
    scope = apiAuth.caller.installationId === LEGACY_TENANT_INSTALLATION_ID ? "all" : [apiAuth.caller.installationId]
    // No user identity on the api-key path — `mine` is empty (see file header).
  }

  const read = await readRecentWorkspacePrs(env, scope)
  if (!read.ok) {
    return json({ org: [], mine: [] } satisfies WorkspacePrsResponse, 200)
  }

  const collapsed = collapseWorkspacePrs(read.rows)
  const mine = sessionLogin
    ? collapsed.filter((pr) => pr.authorLogin !== null && pr.authorLogin.toLowerCase() === sessionLogin!.toLowerCase())
    : []

  const orgPage = collapsed.slice(0, PER_SECTION_LIMIT)
  const minePage = mine.slice(0, PER_SECTION_LIMIT)

  // Enrich every displayed author with GitHub's real identity (avatar + id) so
  // the portal can render a profile photo — including for bot/app authors,
  // whose `[bot]` login 404s on the legacy login-based avatar URL. Best-effort
  // (resolveGithubAuthors is fully fail-soft): a lookup miss / api-key caller
  // with no token yields a login-only author and the portal shows an initial.
  const authors = await resolveGithubAuthors(
    [...orgPage, ...minePage].map((pr) => pr.authorLogin),
    accessToken,
  )
  const attachAuthor = (pr: WorkspacePrSummary): WorkspacePrRow => {
    const resolved = pr.authorLogin ? authors.get(pr.authorLogin.toLowerCase()) : undefined
    return {
      ...pr,
      author: {
        login: pr.authorLogin,
        avatar_url: resolved?.avatarUrl ?? null,
        id: resolved?.id ?? null,
      },
    }
  }

  return json(
    {
      org: orgPage.map(attachAuthor),
      mine: minePage.map(attachAuthor),
    } satisfies WorkspacePrsResponse,
    200,
  )
}
