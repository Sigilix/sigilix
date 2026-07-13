// sig-org-members — resolve an installation's ACTUAL GitHub member roster via
// the installed App, so the portal Organization → Members tab shows real people
// (not only the activity-derived seats). Reused by org-overview-route.ts's admin
// branch to merge the roster with the usage-derived seats + seat overrides.
//
// The App installation token (getInstallationToken — the same credential the
// review pipeline uses) is what lists the roster, so this works regardless of
// the CALLER's own GitHub scopes: an org admin sees the whole org even though
// their user-to-server token has no `read:org`.
//
//   - ORGANIZATION install → GET /orgs/{org}/members (needs the App's "Members"
//     org read permission; absent → fail-soft empty, source unchanged).
//   - PERSONAL (account.type "User") install → the repo COLLABORATORS deduped
//     by immutable GitHub user ID across the installation's repos (there is no
//     org roster).
//
// FULLY FAIL-SOFT: a missing App credential / KV binding, a non-positive
// installation id, or any GitHub error resolves to an empty roster + a reason,
// never a throw — the caller then renders just the activity-derived seats. This
// is a READ enrichment; it must never turn the org page into a 5xx.

import {
  listInstallationCollaborators,
  listOrgMembers,
  type GitHubMember,
} from "@/src/shared/adapters/github/github-app"
import type { Env } from "@/src/shared/types/env"

export interface RosterResult {
  /** GitHub members keyed downstream by immutable `githubUserId`; login/avatar are display-only. */
  members: GitHubMember[]
  /** True only when every App-roster page was consumed without an error/cap. */
  complete: boolean
  /** Which listing produced `members` (or "none" when the fetch was skipped/failed). */
  source: "org" | "collaborators" | "none"
  /** A short machine reason when the roster is empty/partial (for the caller to log). */
  reason?: string
}

/**
 * Fetch the installation's GitHub member roster. See the file header for the
 * org-vs-personal split and the fail-soft contract.
 */
export async function fetchInstallationRoster(
  env: Pick<Env, "OPENCLAW_STATE" | "GITHUB_APP_ID" | "GITHUB_PRIVATE_KEY">,
  installationId: number,
  accountLogin: string,
  accountType: string,
): Promise<RosterResult> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY || !env.OPENCLAW_STATE) {
    return { members: [], complete: false, source: "none", reason: "app_unconfigured" }
  }
  if (!Number.isInteger(installationId) || installationId <= 0) {
    return { members: [], complete: false, source: "none", reason: "no_installation" }
  }

  const common = {
    kv: env.OPENCLAW_STATE,
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
    installationId,
  } as const

  // An Organization install lists org members; anything else (a "User" personal
  // install, or an unknown type) has no org roster, so fall back to the repo
  // collaborators the installation can see.
  if (accountType === "Organization" && accountLogin !== "") {
    const res = await listOrgMembers(common.kv, common.appId, common.privateKey, common.installationId, accountLogin)
    return {
      members: res.items,
      complete: res.complete,
      source: "org",
      ...(res.items.length === 0 || !res.complete ? { reason: "org_members_unavailable" } : {}),
    }
  }

  const res = await listInstallationCollaborators(common.kv, common.appId, common.privateKey, common.installationId)
  return {
    members: res.items,
    complete: res.complete,
    source: "collaborators",
    ...(res.items.length === 0 || !res.complete ? { reason: "collaborators_unavailable" } : {}),
  }
}
