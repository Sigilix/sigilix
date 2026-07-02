// Portal settings-UI gate (org admin vs member) — derives the caller's
// aggregate role from GitHub, using the same session GitHub user-to-server
// token + `GET /user/installations` pattern as onboarding-context-route.ts
// and auth-setup-route.ts's `userControlsInstallation`.
//
// Derivation (per connected installation):
//   - `account.type === "User"` (a personal install) AND `account.login`
//     matches the session's own login → the user owns it → "admin".
//   - `account.type === "Organization"` → check the caller's OWN membership
//     role in that org via `GET /user/memberships/orgs/{org}` (reports the
//     authenticated user's own membership, no extra scope needed).
// Aggregated across installations: admin of ANY connected installation/org
// wins. Otherwise "member".
//
// FAIL-SAFE, always: any error (missing token, GitHub 5xx, malformed JSON,
// no installations) resolves to "member" (least privilege) rather than
// throwing — this function must never be the reason /auth/me 500s. Never
// logs the access token, only the derived role + installation count.

export type UserRole = "admin" | "member"

type FetchImpl = typeof fetch

interface GitHubInstallationAccount {
  type?: string
  login?: string
}

interface GitHubInstallation {
  id?: number
  account?: GitHubInstallationAccount | null
}

interface UserInstallationsResponse {
  total_count?: number
  installations?: GitHubInstallation[]
}

interface OrgMembershipResponse {
  role?: string
  // GitHub returns "active" once the invite is accepted, "pending"
  // otherwise. An admin grant only counts once it's actually active — an
  // unaccepted pending-admin invite must not gate a real admin role.
  state?: string
}

// Defensive pagination cap — mirrors onboarding-context-route.ts /
// auth-setup-route.ts: real users never approach this, so hitting it means
// something's wrong upstream, not that we should spin forever.
const MAX_INSTALLATION_PAGES = 20

function githubHeaders(accessToken: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${accessToken}`,
    "user-agent": "sigilix-worker",
  }
}

/** Every installation the session's GitHub user-to-server token can see. Soft-fails to []. */
async function fetchInstallations(accessToken: string, fetchImpl: FetchImpl): Promise<GitHubInstallation[]> {
  const out: GitHubInstallation[] = []
  let seen = 0
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
    let res: Response
    try {
      res = await fetchImpl(`https://api.github.com/user/installations?per_page=100&page=${page}`, {
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
 * The caller's own membership in `orgLogin`, via
 * `GET /user/memberships/orgs/{org}` (reports the AUTHENTICATED user's own
 * membership). Soft-fails to `null` on any error — never throws.
 */
async function fetchOrgMembership(
  accessToken: string,
  orgLogin: string,
  fetchImpl: FetchImpl,
): Promise<OrgMembershipResponse | null> {
  let res: Response
  try {
    res = await fetchImpl(`https://api.github.com/user/memberships/orgs/${encodeURIComponent(orgLogin)}`, {
      headers: githubHeaders(accessToken),
    })
  } catch {
    return null
  }
  if (!res.ok) return null
  try {
    return (await res.json()) as OrgMembershipResponse
  } catch {
    return null
  }
}

/**
 * Resolve the session user's aggregate role ("admin" | "member") across every
 * GitHub App installation their user-to-server token can see. FAILS CLOSED to
 * "member" on any error — see file header.
 */
export async function resolveUserRole(
  accessToken: string,
  sessionLogin: string,
  fetchImpl: FetchImpl = fetch,
): Promise<UserRole> {
  try {
    const installations = await fetchInstallations(accessToken, fetchImpl)

    const ownsPersonalInstall = installations.some(
      (inst) => inst.account?.type === "User" && inst.account.login === sessionLogin,
    )

    // Dedup org logins (defensive — GitHub shouldn't surface the same org
    // twice, but a duplicate would otherwise cost an extra round-trip) and
    // check them all in parallel rather than serially, since a member of
    // several orgs otherwise pays one round-trip per org on every /auth/me.
    const orgLogins = [
      ...new Set(
        installations
          .map((inst) => inst.account)
          .filter(
            (account): account is GitHubInstallationAccount & { login: string } =>
              account?.type === "Organization" && typeof account.login === "string" && account.login.length > 0,
          )
          .map((account) => account.login),
      ),
    ]
    const orgMemberships = await Promise.all(orgLogins.map((org) => fetchOrgMembership(accessToken, org, fetchImpl)))
    // Only an ACTIVE admin grant counts — an unaccepted pending-admin invite
    // must not gate a real admin role.
    const isOrgAdmin = orgMemberships.some((m) => m?.role === "admin" && m.state === "active")

    const role: UserRole = ownsPersonalInstall || isOrgAdmin ? "admin" : "member"
    console.log(JSON.stringify({ event: "auth-me-role", role, installations: installations.length }))
    return role
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "auth-me-role-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return "member"
  }
}
