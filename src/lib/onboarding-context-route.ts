// #155 onboarding-backend slice 3 (portal endpoints) — GET
// /v1/onboarding/context.
//
// Session-authed (requireSession) + CORS'd (portal-cors.ts, wired in
// index.ts) — powers the portal setup wizard's repo picker. Reuses the same
// GitHub user-to-server token + `GET /user/installations` pattern as
// auth-setup-route.ts's `userControlsInstallation`, but here the caller
// WANTS the full list (to let the user choose an installation + repos to
// onboard), not a single-id existence check, so it also walks each
// installation's repos via `GET /user/installations/{id}/repositories`.
//
// This is informational context for a wizard, not a trust decision (unlike
// /setup's ownership check), so GitHub errors soft-fail to an empty list
// rather than failing the whole request — a user should still see the
// wizard even if one installation's repo listing has a transient hiccup.

import { requireSession } from "@/src/lib/auth-middleware"
import { decryptAccessToken } from "@/src/lib/auth-session"
import { connectUserKey } from "@/src/lib/gitlab-connect/gitlab-connect-oauth"
import { getConnection, getUserConnectionIds } from "@/src/lib/gitlab-connect/gitlab-connect-store"
import type { Env } from "@/src/shared/types/env"

// Defensive pagination caps — mirrors auth-setup-route.ts's
// MAX_INSTALLATION_PAGES rationale: real users never approach these, so
// hitting the cap means something's wrong upstream, not that we should
// spin forever.
const MAX_INSTALLATION_PAGES = 20
const MAX_REPOS_PER_INSTALLATION = 100

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

interface GitHubUserResponse {
  login?: string
  name?: string | null
}

interface GitHubInstallation {
  id?: number
  account?: { login?: string } | null
}

interface UserInstallationsResponse {
  total_count?: number
  installations?: GitHubInstallation[]
}

interface GitHubRepo {
  full_name?: string
  description?: string | null
}

interface InstallationRepositoriesResponse {
  total_count?: number
  repositories?: GitHubRepo[]
}

export interface OnboardingContextRepo {
  fullName: string
  description: string | null
}

export interface OnboardingContextInstallation {
  installationId: number
  account: string
  repos: OnboardingContextRepo[]
}

export interface OnboardingContextResponse {
  user: { login: string; name: string | null }
  installations: OnboardingContextInstallation[]
  /** GitLab projects the caller has connected via the one-click connect flow
   *  (sig-gitlab-connector). A GitLab-only user has NO GitHub App installation,
   *  so `installations` is empty even though they're fully set up — the portal's
   *  returning-user gate treats a positive count here as onboarding-complete so
   *  they land in the app, not the wizard. Provider-agnostic: keyed by the
   *  session's stable `connectUserKey`, so it covers GitLab-login users who have
   *  no GitHub id (the profile store, keyed on github_user_id, can't). */
  gitlabConnectionCount: number
}

/** Count the GitLab projects THIS user still owns — mirrors the ownership
 *  filter in the connect-status handler so a stale index entry (a project since
 *  taken over / disconnected) never inflates the count. Soft-fails to 0 (a KV
 *  hiccup must never block the wizard nor falsely mark someone onboarded). */
async function countOwnedGitLabConnections(env: Env, userId: string): Promise<number> {
  try {
    const ids = await getUserConnectionIds(env, userId)
    let owned = 0
    for (const id of ids) {
      const conn = await getConnection(env, id)
      if (conn && conn.userId === userId) owned++
    }
    return owned
  } catch {
    return 0
  }
}

function githubHeaders(accessToken: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${accessToken}`,
    "user-agent": "sigilix-worker",
  }
}

/** Soft-fail to the session's cached login when GET /user errors — never blocks the wizard. */
async function fetchGitHubUser(
  accessToken: string,
  fallbackLogin: string,
): Promise<{ login: string; name: string | null }> {
  let res: Response
  try {
    res = await fetch("https://api.github.com/user", { headers: githubHeaders(accessToken) })
  } catch {
    return { login: fallbackLogin, name: null }
  }
  if (!res.ok) return { login: fallbackLogin, name: null }
  let body: GitHubUserResponse
  try {
    body = (await res.json()) as GitHubUserResponse
  } catch {
    return { login: fallbackLogin, name: null }
  }
  return {
    login: typeof body.login === "string" && body.login ? body.login : fallbackLogin,
    name: typeof body.name === "string" ? body.name : null,
  }
}

/** Every installation the session's GitHub user-to-server token can see. Soft-fails to []. */
async function fetchInstallations(accessToken: string): Promise<GitHubInstallation[]> {
  const out: GitHubInstallation[] = []
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
    out.push(...installs)
    seen += installs.length
    const total = typeof body.total_count === "number" ? body.total_count : seen
    if (installs.length === 0 || seen >= total) break
  }
  return out
}

/**
 * One installation's repos, paginated, capped at MAX_REPOS_PER_INSTALLATION.
 * Soft-fails to whatever was collected so far (never throws).
 */
async function fetchInstallationRepos(accessToken: string, installationId: number): Promise<OnboardingContextRepo[]> {
  const repos: OnboardingContextRepo[] = []
  let seen = 0
  for (let page = 1; page <= MAX_INSTALLATION_PAGES && repos.length < MAX_REPOS_PER_INSTALLATION; page++) {
    let res: Response
    try {
      res = await fetch(
        `https://api.github.com/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
        { headers: githubHeaders(accessToken) },
      )
    } catch {
      break
    }
    if (!res.ok) break
    let body: InstallationRepositoriesResponse
    try {
      body = (await res.json()) as InstallationRepositoriesResponse
    } catch {
      break
    }
    const pageRepos = Array.isArray(body.repositories) ? body.repositories : []
    for (const r of pageRepos) {
      if (repos.length >= MAX_REPOS_PER_INSTALLATION) break
      if (typeof r.full_name === "string" && r.full_name) {
        repos.push({ fullName: r.full_name, description: typeof r.description === "string" ? r.description : null })
      }
    }
    seen += pageRepos.length
    const total = typeof body.total_count === "number" ? body.total_count : seen
    if (pageRepos.length === 0 || seen >= total) break
  }
  return repos
}

/** GET /v1/onboarding/context — session-authed. Feeds the portal setup wizard's repo picker. */
export async function handleOnboardingContextRoute(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const authed = await requireSession(request, env, ctx)
  if (!authed) return json({ error: "unauthenticated" }, 401)

  if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) {
    console.error(JSON.stringify({ event: "onboarding-context-encryption-key-missing" }))
    return json({ error: "misconfigured" }, 503)
  }

  let accessToken: string
  try {
    accessToken = await decryptAccessToken(
      { encryptedAccessToken: authed.record.encryptedAccessToken, iv: authed.record.iv },
      authed.sessionId,
      env.OPENCLAW_SESSION_ENCRYPTION_KEY,
    )
  } catch (error) {
    // Never log the token itself — only the fact that decryption failed.
    console.error(
      JSON.stringify({
        event: "onboarding-context-decrypt-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return json({ error: "context_failed" }, 500)
  }

  const [user, rawInstallations, gitlabConnectionCount] = await Promise.all([
    fetchGitHubUser(accessToken, authed.record.login),
    fetchInstallations(accessToken),
    countOwnedGitLabConnections(env, connectUserKey(authed.record)),
  ])

  const installations: OnboardingContextInstallation[] = []
  for (const inst of rawInstallations) {
    if (typeof inst.id !== "number") continue
    const repos = await fetchInstallationRepos(accessToken, inst.id)
    installations.push({
      installationId: inst.id,
      account: typeof inst.account?.login === "string" ? inst.account.login : "",
      repos,
    })
  }

  const body: OnboardingContextResponse = { user, installations, gitlabConnectionCount }
  return json(body, 200)
}
