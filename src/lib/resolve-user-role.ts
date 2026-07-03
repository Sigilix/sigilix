// Portal settings-UI gate (org admin vs member) — derives the caller's
// aggregate role from GitHub, using the same session GitHub user-to-server
// token + `GET /user/installations` pattern as onboarding-context-route.ts
// and auth-setup-route.ts's `userControlsInstallation`.
//
// Derivation:
//   1. `GET /user/installations` — the installations the user's token can
//      see. A personal install (`account.type === "User"`) whose
//      `account.login` matches the session's own login → the user owns it →
//      "admin".
//   2. `GET /user/memberships/orgs?state=active` — the caller's OWN org
//      memberships (each item carries `.role` and `.organization.login`).
//      This is the AUTHENTICATED user's self-memberships list, so it works
//      with a plain user-to-server token and requires NO org permission /
//      `read:org` scope — no GitHub App permission change, no org
//      re-approval. Fetched ONCE, not per-org.
//   3. For each ORGANIZATION installation, look up the user's role in that
//      org from the memberships map; `role === "admin"` (state is already
//      "active" from the query filter) → "admin".
// Aggregated: admin of ANY connected installation/org wins. Otherwise
// "member".
//
// FAIL-SAFE, always: any error (missing token, GitHub 5xx, malformed JSON,
// no installations, no memberships) resolves to "member" (least privilege)
// rather than throwing — this function must never be the reason /auth/me
// 500s. Never logs the access token, only the derived role + counts.

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

interface OrgMembershipItem {
  role?: string
  // GitHub returns "active" once the invite is accepted, "pending"
  // otherwise. We filter to state=active in the query and re-check
  // defensively so an unaccepted pending-admin invite can't gate admin.
  state?: string
  organization?: { login?: string } | null
}

// Defensive pagination cap — mirrors onboarding-context-route.ts /
// auth-setup-route.ts: real users never approach this, so hitting it means
// something's wrong upstream, not that we should spin forever.
const MAX_PAGES = 20

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
  for (let page = 1; page <= MAX_PAGES; page++) {
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
 * The caller's OWN active org memberships via
 * `GET /user/memberships/orgs?state=active` (the authenticated user's
 * self-memberships list — no org permission / `read:org` scope needed).
 * Paginated. Soft-fails to whatever was collected so far (never throws).
 */
async function fetchOwnOrgMemberships(accessToken: string, fetchImpl: FetchImpl): Promise<OrgMembershipItem[]> {
  const out: OrgMembershipItem[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    let res: Response
    try {
      res = await fetchImpl(`https://api.github.com/user/memberships/orgs?state=active&per_page=100&page=${page}`, {
        headers: githubHeaders(accessToken),
      })
    } catch {
      break
    }
    if (!res.ok) break
    let body: OrgMembershipItem[]
    try {
      body = (await res.json()) as OrgMembershipItem[]
    } catch {
      break
    }
    const items = Array.isArray(body) ? body : []
    out.push(...items)
    // This list endpoint has no total_count; stop on a short/empty page.
    if (items.length < 100) break
  }
  return out
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
    const [installations, memberships] = await Promise.all([
      fetchInstallations(accessToken, fetchImpl),
      fetchOwnOrgMemberships(accessToken, fetchImpl),
    ])

    const ownsPersonalInstall = installations.some(
      (inst) => inst.account?.type === "User" && inst.account.login === sessionLogin,
    )

    // org-login → is the caller an ACTIVE admin of it. Only active admin
    // grants count (a pending-admin invite must not gate admin).
    const adminOrgs = new Set<string>()
    for (const m of memberships) {
      const login = m.organization?.login
      if (typeof login === "string" && login && m.role === "admin" && m.state === "active") {
        adminOrgs.add(login)
      }
    }

    // The user is an org admin for our purposes only if they're an admin of
    // an org that actually has Sigilix installed (a connected org install).
    const isOrgAdmin = installations.some(
      (inst) =>
        inst.account?.type === "Organization" &&
        typeof inst.account.login === "string" &&
        adminOrgs.has(inst.account.login),
    )

    const role: UserRole = ownsPersonalInstall || isOrgAdmin ? "admin" : "member"
    console.log(
      JSON.stringify({
        event: "auth-me-role",
        role,
        installations: installations.length,
        adminOrgs: adminOrgs.size,
      }),
    )
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

/**
 * SIG-303 — is the session user an admin/owner of ONE SPECIFIC installation?
 *
 * {@link resolveUserRole} above is the AGGREGATE role ("admin of ANY connected
 * install") used by the settings UI. That is WRONG for a per-installation
 * authorization gate: a user who merely owns a personal install (→ aggregate
 * "admin") but is only a MEMBER of org B must NOT be treated as an admin of org
 * B. This function answers the scoped question — admin of `installationId`
 * specifically — so `GET /v1/usage?scope=org&installationId=<B>` can't leak org
 * B's aggregate + per-developer usage to a non-admin of B.
 *
 * Admin of `installationId` iff that installation is either:
 *   • the user's OWN personal install (account.type "User", login === session), or
 *   • an ORGANIZATION install where the user is an ACTIVE admin of that org.
 * An installation the token can't see (not in the list) → false.
 *
 * FAILS CLOSED to false on any error (least privilege) — mirrors resolveUserRole.
 */
export async function isAdminOfInstallation(
  accessToken: string,
  sessionLogin: string,
  installationId: number,
  fetchImpl: FetchImpl = fetch,
): Promise<boolean> {
  try {
    const [installations, memberships] = await Promise.all([
      fetchInstallations(accessToken, fetchImpl),
      fetchOwnOrgMemberships(accessToken, fetchImpl),
    ])
    const target = installations.find((inst) => inst.id === installationId)
    if (!target) return false // not visible to the caller's token → not an admin of it

    if (target.account?.type === "User") {
      return target.account.login === sessionLogin
    }
    if (target.account?.type === "Organization" && typeof target.account.login === "string") {
      const orgLogin = target.account.login
      return memberships.some((m) => m.organization?.login === orgLogin && m.role === "admin" && m.state === "active")
    }
    return false
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "is-admin-of-installation-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return false
  }
}
