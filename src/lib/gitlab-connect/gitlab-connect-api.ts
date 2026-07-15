// sig-gitlab-connector: the thin GitLab REST v4 calls the connect flow needs,
// authenticated with the human's OAuth access token (Bearer) — SEPARATE from the
// review-path `GitLabClient` (which uses a PRIVATE-TOKEN project credential).
//
// Kept minimal + typed to exactly the fields the connect flow reads. Every call
// targets `${baseOrigin}/api/v4` (or the OAuth `/oauth/*` endpoints for the token
// exchange). NEVER logs a token, code, or secret.
//
// Access-level constant: GitLab's Maintainer role is access_level 40. Creating a
// webhook + a project access token both require Maintainer/Owner, so the connect
// flow gates project selection on `access_level >= MAINTAINER_ACCESS_LEVEL`.

export const MAINTAINER_ACCESS_LEVEL = 40

const DEFAULT_BASE_URL = "https://gitlab.com"

/** Normalize the configured origin (strip trailing slashes). */
export function gitlabOrigin(baseUrl?: string): string {
  return (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
}

function apiBase(baseUrl?: string): string {
  return `${gitlabOrigin(baseUrl)}/api/v4`
}

export interface GitLabOAuthTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  scope?: string
  error?: string
  error_description?: string
}

/** Exchange an authorization `code` for an OAuth access token. */
export async function exchangeOAuthCode(args: {
  baseUrl?: string
  clientId: string
  clientSecret: string
  code: string
  redirectUri: string
}): Promise<GitLabOAuthTokenResponse> {
  const res = await fetch(`${gitlabOrigin(args.baseUrl)}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      grant_type: "authorization_code",
      redirect_uri: args.redirectUri,
    }),
  })
  const body = (await res.json().catch(() => ({}))) as GitLabOAuthTokenResponse
  if (!res.ok || !body.access_token) {
    throw new Error(`gitlab oauth token exchange failed: HTTP ${res.status} ${body.error ?? ""}`)
  }
  return body
}

/** Build the GitLab OAuth authorize URL for the connect flow (`api` scope). */
export function buildAuthorizeUrl(args: {
  baseUrl?: string
  clientId: string
  redirectUri: string
  state: string
}): string {
  const u = new URL(`${gitlabOrigin(args.baseUrl)}/oauth/authorize`)
  u.searchParams.set("client_id", args.clientId)
  u.searchParams.set("redirect_uri", args.redirectUri)
  u.searchParams.set("response_type", "code")
  u.searchParams.set("scope", "api")
  u.searchParams.set("state", args.state)
  return u.toString()
}

function bearerHeaders(token: string, hasBody = false): Record<string, string> {
  const h: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "user-agent": "sigilix-worker",
  }
  if (hasBody) h["content-type"] = "application/json"
  return h
}

export interface GitLabApiUser {
  id: number
  username: string
}

/** `GET /user` — the authenticated GitLab user (id used for membership checks). */
export async function fetchGitLabUser(baseUrl: string | undefined, token: string): Promise<GitLabApiUser> {
  const res = await fetch(`${apiBase(baseUrl)}/user`, { headers: bearerHeaders(token) })
  if (!res.ok) throw new Error(`gitlab GET /user failed: HTTP ${res.status}`)
  const body = (await res.json()) as Partial<GitLabApiUser>
  if (typeof body.id !== "number" || typeof body.username !== "string") {
    throw new Error("gitlab GET /user returned an unexpected shape")
  }
  return { id: body.id, username: body.username }
}

export interface GitLabProject {
  id: number
  path_with_namespace: string
  name: string
  /** The caller's own access level on the project, when GitLab includes it. */
  accessLevel: number | null
}

interface RawGitLabProject {
  id?: number
  path_with_namespace?: string
  name?: string
  permissions?: {
    project_access?: { access_level?: number } | null
    group_access?: { access_level?: number } | null
  } | null
}

function mapProject(raw: RawGitLabProject): GitLabProject | null {
  if (typeof raw.id !== "number" || typeof raw.path_with_namespace !== "string") return null
  const project = raw.permissions?.project_access?.access_level
  const group = raw.permissions?.group_access?.access_level
  const accessLevel = Math.max(typeof project === "number" ? project : 0, typeof group === "number" ? group : 0)
  return {
    id: raw.id,
    path_with_namespace: raw.path_with_namespace,
    name: typeof raw.name === "string" ? raw.name : raw.path_with_namespace,
    accessLevel: accessLevel > 0 ? accessLevel : null,
  }
}

/**
 * `GET /projects?membership=true&min_access_level=40` — the user's Maintainer+
 * projects (the ones they can actually add a webhook to). Paginated, capped so a
 * user in hundreds of projects can't stall the request. min_access_level scopes
 * server-side; we still record accessLevel for the connect-time re-check.
 */
export async function listMaintainerProjects(
  baseUrl: string | undefined,
  token: string,
  opts?: { maxPages?: number; perPage?: number },
): Promise<GitLabProject[]> {
  const perPage = opts?.perPage ?? 100
  const maxPages = opts?.maxPages ?? 5
  const out: GitLabProject[] = []
  for (let page = 1; page <= maxPages; page++) {
    const u = new URL(`${apiBase(baseUrl)}/projects`)
    u.searchParams.set("membership", "true")
    u.searchParams.set("min_access_level", String(MAINTAINER_ACCESS_LEVEL))
    u.searchParams.set("per_page", String(perPage))
    u.searchParams.set("page", String(page))
    u.searchParams.set("order_by", "last_activity_at")
    u.searchParams.set("simple", "false")
    const res = await fetch(u.toString(), { headers: bearerHeaders(token) })
    if (!res.ok) throw new Error(`gitlab GET /projects failed: HTTP ${res.status}`)
    const rows = (await res.json()) as RawGitLabProject[]
    if (!Array.isArray(rows) || rows.length === 0) break
    for (const raw of rows) {
      const mapped = mapProject(raw)
      if (mapped) out.push(mapped)
    }
    if (rows.length < perPage) break
  }
  return out
}

/**
 * `GET /projects/:id` — re-fetch a single project to VERIFY the connecting user's
 * access level before provisioning anything. Returns null on 403/404 (the user
 * cannot see the project — treat as "not a member", never as an error to leak).
 */
export async function fetchProject(
  baseUrl: string | undefined,
  token: string,
  projectId: number,
  options?: { signal?: AbortSignal },
): Promise<GitLabProject | null> {
  const res = await fetch(`${apiBase(baseUrl)}/projects/${projectId}`, {
    headers: bearerHeaders(token),
    ...(options?.signal ? { signal: options.signal } : {}),
  })
  if (res.status === 403 || res.status === 404) return null
  if (!res.ok) throw new Error(`gitlab GET /projects/${projectId} failed: HTTP ${res.status}`)
  return mapProject((await res.json()) as RawGitLabProject)
}

export interface GitLabHook {
  id: number
}

/**
 * `POST /projects/:id/hooks` — create the MR-review webhook pointing at
 * `${webhookUrl}` with `merge_requests_events` and the generated per-project
 * `token` (echoed back verbatim in the `X-Gitlab-Token` header we verify).
 */
export async function createMergeRequestHook(args: {
  baseUrl?: string
  token: string
  projectId: number
  webhookUrl: string
  webhookSecret: string
  signal?: AbortSignal
}): Promise<GitLabHook> {
  const res = await fetch(`${apiBase(args.baseUrl)}/projects/${args.projectId}/hooks`, {
    method: "POST",
    headers: bearerHeaders(args.token, true),
    body: JSON.stringify({
      url: args.webhookUrl,
      token: args.webhookSecret,
      merge_requests_events: true,
      push_events: false,
      enable_ssl_verification: true,
    }),
    ...(args.signal ? { signal: args.signal } : {}),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`gitlab POST hooks failed: HTTP ${res.status} ${text.slice(0, 200)}`)
  }
  const body = (await res.json()) as Partial<GitLabHook>
  if (typeof body.id !== "number") throw new Error("gitlab POST hooks returned no id")
  return { id: body.id }
}

/**
 * `DELETE /projects/:id/hooks/:hookId` with the OAuth Bearer token — used for
 * CONNECT-TIME ROLLBACK (the OAuth token is still valid), e.g. undoing the hook
 * when the subsequent review-token provisioning fails. Best-effort; never throws.
 */
export async function deleteMergeRequestHook(args: {
  baseUrl?: string
  token: string
  projectId: number
  hookId: number
}): Promise<void> {
  try {
    await fetch(`${apiBase(args.baseUrl)}/projects/${args.projectId}/hooks/${args.hookId}`, {
      method: "DELETE",
      headers: bearerHeaders(args.token),
    })
  } catch {
    /* best-effort */
  }
}

function privateTokenHeaders(token: string): Record<string, string> {
  return { accept: "application/json", "private-token": token, "user-agent": "sigilix-worker" }
}

/**
 * `DELETE /projects/:id/hooks/:hookId` on disconnect, authenticated with the
 * long-lived review PROJECT ACCESS TOKEN (PRIVATE-TOKEN), NOT the OAuth token —
 * so disconnect still cleans up the hook after the ~1h OAuth window has closed
 * (Codex sign-off #4). Best-effort: never throws (a failed cleanup only leaves an
 * orphaned hook, which 401s harmlessly once its secret is purged).
 */
export async function deleteHookWithReviewToken(args: {
  baseUrl?: string
  reviewToken: string
  projectId: number
  hookId: number
}): Promise<void> {
  try {
    await fetch(`${apiBase(args.baseUrl)}/projects/${args.projectId}/hooks/${args.hookId}`, {
      method: "DELETE",
      headers: privateTokenHeaders(args.reviewToken),
    })
  } catch {
    /* best-effort */
  }
}

/**
 * `DELETE /projects/:id/access_tokens/:tokenId` — revoke the review token on
 * disconnect (best-effort), authenticated with the token itself (it holds the
 * Maintainer `api` scope required). Never throws.
 */
export async function revokeProjectAccessToken(args: {
  baseUrl?: string
  reviewToken: string
  projectId: number
  patId: number
}): Promise<void> {
  try {
    await fetch(`${apiBase(args.baseUrl)}/projects/${args.projectId}/access_tokens/${args.patId}`, {
      method: "DELETE",
      headers: privateTokenHeaders(args.reviewToken),
    })
  } catch {
    /* best-effort */
  }
}

export interface GitLabProjectAccessToken {
  id: number
  token: string
}

/**
 * `POST /projects/:id/access_tokens` — provision the STABLE review credential
 * (scope `api`, Maintainer role) so the review client keeps working long after
 * the human's short-lived OAuth token expires. GitLab requires an expiry; we set
 * the max the API accepts on gitlab.com (~1 year). Returns the one-time token
 * value (only ever returned at creation).
 */
export async function createProjectAccessToken(args: {
  baseUrl?: string
  token: string
  projectId: number
  name: string
  expiresAtIso: string
  signal?: AbortSignal
}): Promise<GitLabProjectAccessToken> {
  const res = await fetch(`${apiBase(args.baseUrl)}/projects/${args.projectId}/access_tokens`, {
    method: "POST",
    headers: bearerHeaders(args.token, true),
    body: JSON.stringify({
      name: args.name,
      scopes: ["api"],
      access_level: MAINTAINER_ACCESS_LEVEL,
      expires_at: args.expiresAtIso,
    }),
    ...(args.signal ? { signal: args.signal } : {}),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`gitlab POST access_tokens failed: HTTP ${res.status} ${text.slice(0, 200)}`)
  }
  const body = (await res.json()) as Partial<GitLabProjectAccessToken>
  if (typeof body.id !== "number" || typeof body.token !== "string") {
    throw new Error("gitlab POST access_tokens returned an unexpected shape")
  }
  return { id: body.id, token: body.token }
}

/** An ISO date ~364 days out — the review token's expiry (GitLab requires one). */
export function reviewTokenExpiryIso(now = Date.now()): string {
  return new Date(now + 364 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}
