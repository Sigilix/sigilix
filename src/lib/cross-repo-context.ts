// Cross-repo review context: when the per-installation flag is ON, a PR review
// is grounded not only in the PR's own repo index but also in its SIBLING repos
// in the SAME GitHub App installation.
//
// ISOLATION IS THE WHOLE POINT. Siblings are resolved ONLY from
// `listIndexedRepos(env, { owner })` — the `repo-index-manifest:*` KV set the
// indexer writes on install / push and the uninstall handler deletes. A GitHub
// App installation is tied to a single account (the `owner`), so filtering the
// indexed-repo set by the PR repo's owner yields exactly the repos in the same
// installation — never another tenant's, and never a repo the app isn't
// installed on (no manifest ⇒ never surfaced). This module NEVER takes a repo
// list from the caller, the diff, or user input: the only source is the
// owner-scoped manifest set. Default OFF ⇒ `[]` ⇒ unchanged single-repo review.

import { listIndexedRepos } from "@/src/shared/adapters/github/github-installation"
import { indexNamespace } from "@/src/lib/repo-index-manifest"
import {
  getLinearConnectionByInstallation,
  resolveLinearTeamBinding,
  resolveLinearTeamBindingForRepo,
  resolveLinearTeamEffectiveRepos,
  type LinearRepoRef,
  type LinearTeamBinding,
} from "@/src/features/linear-integration"

type LinearRepoScopeEnv = { SIGILIX_PLATFORM_DB?: D1Database }

export interface BindingRepoScope {
  /** The team's PRIMARY repo (original case), used as the weighted-highest namespace. */
  primary: { owner: string; repo: string }
  /** Lowercased `<owner>/<repo>` of the primary — the retrieval namespace. */
  primaryNamespace: string
  /** Lowercased sibling namespaces (deduped, primary excluded, capped). */
  siblingNamespaces: string[]
  /** Exact effective D1 binding set, before the retrieval fan-out cap. */
  allNamespaces: string[]
  /** How many siblings were dropped by the `MAX_CROSS_REPO_SIBLINGS` cap (for logging). */
  truncated: number
}

/**
 * Split a resolved Linear team binding into its primary repo + capped cross-repo
 * sibling namespaces — the ONE home for the primary/sibling fan-out every Linear
 * surface (triage, mention-reply, agent-run) reuses. Returns null when the
 * binding is inaccessible or resolves to no valid repo, so callers fail closed
 * exactly as the SIG-242 single-binding guard did. Pure orchestration over the
 * store's `resolveLinearTeamEffectiveRepos` + the shared cap.
 */
export async function resolveBindingRepoScope(
  env: LinearRepoScopeEnv,
  binding: LinearTeamBinding,
  expectedInstallationId: number,
): Promise<BindingRepoScope | null> {
  if (binding.installationId !== expectedInstallationId || binding.accessState !== "allowed") return null
  const effective = await resolveLinearTeamEffectiveRepos(env, binding)
  const primaryFull = effective[0]?.githubRepoFullName
  if (!primaryFull) return null
  const [owner, repo] = primaryFull.split("/")
  if (!owner || !repo) return null
  const primaryNamespace = `${owner}/${repo}`.toLowerCase()
  const rest = [
    ...new Set(
      effective
        .slice(1)
        .map((r) => r.githubRepoFullName.trim().toLowerCase())
        .filter((ns) => ns.length > 0 && ns !== primaryNamespace),
    ),
  ]
  const siblingNamespaces = rest.slice(0, MAX_CROSS_REPO_SIBLINGS)
  return {
    primary: { owner, repo },
    primaryNamespace,
    siblingNamespaces,
    allNamespaces: [primaryNamespace, ...rest],
    truncated: rest.length - siblingNamespaces.length,
  }
}

/**
 * Hard cap on how many sibling namespaces we fan out to. Bounds the retrieval
 * budget (and blast radius) on large orgs regardless of how many repos are
 * indexed under the owner. The per-chunk cap lives in `retrieval.ts`.
 */
export const MAX_CROSS_REPO_SIBLINGS = 8

/** Per-installation flag gate. Default OFF (any value other than "on"). */
export function crossRepoContextEnabled(env: { OPENCLAW_CROSS_REPO_CONTEXT?: string }): boolean {
  return (env.OPENCLAW_CROSS_REPO_CONTEXT ?? "").trim().toLowerCase() === "on"
}

/**
 * Resolve the sibling repo namespaces to fold into a cross-repo review, with
 * hard tenant isolation (see the module header). Returns `[]` — i.e. unchanged
 * single-repo behavior — when the flag is off, KV is unbound, the manifest read
 * fails, or the owner has no other indexed repos. The PR repo's own namespace
 * is excluded (it is always queried as the weighted-highest primary). The
 * result is sorted (determinism) and capped at `MAX_CROSS_REPO_SIBLINGS`.
 */
export async function resolveCrossRepoNamespaces(
  env: { OPENCLAW_STATE?: KVNamespace; OPENCLAW_CROSS_REPO_CONTEXT?: string },
  owner: string,
  repo: string,
): Promise<string[]> {
  if (!crossRepoContextEnabled(env)) return []
  if (!env.OPENCLAW_STATE) return []

  const base = indexNamespace(owner, repo)
  let indexed: string[]
  try {
    // Owner-scoped: `listIndexedRepos` filters the manifest set to `<owner>/*`
    // (lowercased), so this can only ever return same-installation namespaces.
    indexed = await listIndexedRepos({ OPENCLAW_STATE: env.OPENCLAW_STATE }, { owner })
  } catch (error) {
    console.warn("cross-repo namespace resolution failed", { error: String(error), owner })
    return []
  }

  const siblings = indexed.filter((ns) => ns !== base && ns.startsWith(`${owner.toLowerCase()}/`))
  siblings.sort()
  return siblings.slice(0, MAX_CROSS_REPO_SIBLINGS)
}

/** Map effective repo refs to `<owner>/<repo>` pairs, dropping any malformed name. */
function effectiveReposToOwnerRepo(repos: LinearRepoRef[]): Array<{ owner: string; repo: string }> {
  return repos.flatMap((r) => {
    const [owner, repo] = r.githubRepoFullName.split("/")
    return owner && repo ? [{ owner, repo }] : []
  })
}

/**
 * The `{ owner, repo }` set a Linear team grounds context in — its EXPLICITLY
 * configured multi-repo selection, or every installation repo when `useAllRepos`
 * — resolved by installation + team via the immutable connection→binding chain.
 * Reused by the Slack assistant to widen its retrieve-tool repo scope beyond the
 * channel's own mapping. Fail-soft `[]` (D1 unbound, no active connection, no
 * allowed binding, or any error) ⇒ callers keep their existing single-repo scope.
 */
export async function resolveLinearTeamRepoScope(
  env: LinearRepoScopeEnv,
  installationId: number,
  teamId: string,
): Promise<Array<{ owner: string; repo: string }>> {
  if (!env.SIGILIX_PLATFORM_DB) return []
  try {
    const connection = await getLinearConnectionByInstallation(env, installationId)
    if (!connection || connection.status !== "active") return []
    const binding = await resolveLinearTeamBinding(env, connection.organizationId, teamId)
    if (!binding || binding.installationId !== installationId || binding.accessState !== "allowed") return []
    return effectiveReposToOwnerRepo(await resolveLinearTeamEffectiveRepos(env, binding))
  } catch (error) {
    console.warn("linear team repo scope resolution failed", { error: String(error), installationId, teamId })
    return []
  }
}

/**
 * Sibling namespaces from the Linear team EXPLICITLY configured for `owner/repo`,
 * EXCLUDING that repo's own namespace. Unlike `resolveCrossRepoNamespaces`, this
 * is NOT gated behind `OPENCLAW_CROSS_REPO_CONTEXT` — an admin explicitly binding
 * multiple repos to the team IS the opt-in. Lowercased, deduped, sorted, capped at
 * `MAX_CROSS_REPO_SIBLINGS`. Fail-soft `[]` (D1 unbound, repo not in any allowed
 * team binding, or error) ⇒ unchanged single-repo behavior.
 */
export async function resolveConfiguredCrossRepoNamespaces(
  env: LinearRepoScopeEnv,
  installationId: number,
  owner: string,
  repo: string,
): Promise<string[]> {
  if (!env.SIGILIX_PLATFORM_DB) return []
  const base = indexNamespace(owner, repo)
  try {
    const binding = await resolveLinearTeamBindingForRepo(env, installationId, `${owner}/${repo}`)
    if (!binding || binding.installationId !== installationId || binding.accessState !== "allowed") return []
    const repos = await resolveLinearTeamEffectiveRepos(env, binding)
    const namespaces = repos
      .map((r) => r.githubRepoFullName.trim().toLowerCase())
      .filter((ns) => ns.length > 0 && ns !== base)
    return [...new Set(namespaces)].sort().slice(0, MAX_CROSS_REPO_SIBLINGS)
  } catch (error) {
    console.warn("configured cross-repo namespace resolution failed", { error: String(error), owner, repo })
    return []
  }
}

/**
 * PR-review cross-repo namespaces: the union of the auto-discovery siblings
 * (`OPENCLAW_CROSS_REPO_CONTEXT`-gated, same-installation manifest set) and the
 * team's EXPLICITLY configured Linear repo set (always honored). Configured
 * namespaces rank FIRST (admin intent), then auto-discovery; deduped, the PR
 * repo's own namespace excluded, capped at `MAX_CROSS_REPO_SIBLINGS` (truncation
 * logged, never silent). `[]` ⇒ unchanged single-repo review.
 */
export async function resolveReviewCrossRepoNamespaces(
  env: LinearRepoScopeEnv & { OPENCLAW_STATE?: KVNamespace; OPENCLAW_CROSS_REPO_CONTEXT?: string },
  installationId: number,
  owner: string,
  repo: string,
): Promise<string[]> {
  const [configured, auto] = await Promise.all([
    resolveConfiguredCrossRepoNamespaces(env, installationId, owner, repo),
    resolveCrossRepoNamespaces(env, owner, repo),
  ])
  const base = indexNamespace(owner, repo)
  const merged = [...new Set([...configured, ...auto])].filter((ns) => ns !== base)
  if (merged.length > MAX_CROSS_REPO_SIBLINGS) {
    console.log(
      JSON.stringify({
        event: "review-cross-repo-siblings-capped",
        owner,
        repo,
        total: merged.length,
        capped: MAX_CROSS_REPO_SIBLINGS,
      }),
    )
  }
  return merged.slice(0, MAX_CROSS_REPO_SIBLINGS)
}
