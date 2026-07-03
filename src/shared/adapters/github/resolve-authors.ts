// sig-pr-interface-fixes — resolve GitHub author identities (avatar + numeric
// id) for a set of logins.
//
// The workspace PR list is built from the D1 usage_ledger, which stores only
// `author_login` — no avatar, no numeric id. To render a real profile photo
// (including for GitHub App / bot authors, whose `[bot]` login 404s on the
// legacy `github.com/<login>.png` URL) the portal needs GitHub's own
// `avatar_url`. This helper enriches a batch of distinct logins via
// `GET /users/{login}` (public data — the URL-encoded `[bot]` suffix resolves
// fine and returns the canonical `.../in/<app_id>` avatar for bots).
//
// Fail-soft by design: the workspace panel must never break because a GitHub
// lookup hiccuped. Any per-login failure (network, non-OK, parse) simply omits
// that login from the result map — the caller then falls back to a login-only
// author (the portal renders a colored initial). A missing/blank token skips
// enrichment entirely (empty map).
//
// Bounded: distinct logins are deduped case-insensitively and each is fetched
// at most once; a hard cap guards against an anomalous result set.

const RESOLVE_CAP = 100

export interface ResolvedAuthor {
  login: string
  id: number
  avatarUrl: string
}

interface GithubUserResponse {
  login?: unknown
  id?: unknown
  avatar_url?: unknown
}

function githubHeaders(accessToken: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${accessToken}`,
    "user-agent": "sigilix-worker",
  }
}

/** Resolve one login to its GitHub identity, or null on any failure. */
async function resolveOne(login: string, accessToken: string): Promise<ResolvedAuthor | null> {
  try {
    const res = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
      headers: githubHeaders(accessToken),
    })
    if (!res.ok) return null
    const body = (await res.json()) as GithubUserResponse
    const id = typeof body.id === "number" ? body.id : null
    const avatarUrl = typeof body.avatar_url === "string" ? body.avatar_url : null
    const resolvedLogin = typeof body.login === "string" ? body.login : login
    if (id === null || avatarUrl === null) return null
    return { login: resolvedLogin, id, avatarUrl }
  } catch {
    return null
  }
}

/**
 * Resolve a batch of author logins to `{ login, id, avatarUrl }`, keyed by
 * lowercased login. Deduped, bounded, fully fail-soft. A missing token OR an
 * empty login set returns an empty map (no GitHub calls). Never throws.
 */
export async function resolveGithubAuthors(
  logins: Array<string | null | undefined>,
  accessToken: string | null,
): Promise<Map<string, ResolvedAuthor>> {
  const out = new Map<string, ResolvedAuthor>()
  if (!accessToken) return out

  const distinct: string[] = []
  const seen = new Set<string>()
  for (const raw of logins) {
    if (typeof raw !== "string" || raw === "") continue
    const key = raw.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    distinct.push(raw)
    if (distinct.length >= RESOLVE_CAP) break
  }
  if (distinct.length === 0) return out

  const resolved = await Promise.all(distinct.map((login) => resolveOne(login, accessToken)))
  for (const author of resolved) {
    if (author) out.set(author.login.toLowerCase(), author)
  }
  return out
}
