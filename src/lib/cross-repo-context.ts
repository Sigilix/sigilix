// Cross-repo review context: when the per-installation flag is ON, a PR review
// is grounded not only in the PR's own repo index but also in its SIBLING repos
// in the SAME GitHub App installation.
//
// ISOLATION IS THE WHOLE POINT. Automatic siblings are the intersection of
// two independent sources: the exact installation's D1 `repo` rows (tenant
// authority) and the owner-scoped `repo-index-manifest:*` KV set (proof that a
// retrieval namespace exists). Owner alone is NOT an authorization boundary:
// stale/reinstalled installations can share an owner. Missing or degraded D1
// therefore fails automatic discovery closed. Default OFF ⇒ `[]` ⇒ unchanged
// single-repo review.

import { listIndexedRepos } from "@/src/shared/adapters/github/github-installation"
import { indexNamespace } from "@/src/lib/repo-index-manifest"
import { listRepoFullNamesForInstallation } from "@/src/features/tenancy"
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
  /** Immutable ids + live names for exact canonical repository-context reads. */
  effectiveRepositories: Array<{ repositoryId: number; fullName: string }>
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
    effectiveRepositories: effective.map((repository) => ({
      repositoryId: repository.githubRepoId,
      fullName: repository.githubRepoFullName,
    })),
    truncated: rest.length - siblingNamespaces.length,
  }
}

/**
 * Hard cap on how many sibling namespaces we fan out to. Bounds the retrieval
 * budget (and blast radius) on large orgs regardless of how many exact-
 * installation repositories are indexed. The per-chunk cap lives in
 * `retrieval.ts`.
 */
export const MAX_CROSS_REPO_SIBLINGS = 8

/** Per-installation flag gate. Default OFF (any value other than "on"). */
export function crossRepoContextEnabled(env: { OPENCLAW_CROSS_REPO_CONTEXT?: string }): boolean {
  return (env.OPENCLAW_CROSS_REPO_CONTEXT ?? "").trim().toLowerCase() === "on"
}

/**
 * Resolve the sibling repo namespaces to fold into a cross-repo review, with
 * hard tenant isolation (see the module header). Returns `[]` — i.e. unchanged
 * single-repo behavior — when the flag is off, either store is unbound, either
 * read fails, the reviewed base repo is not registered to the exact
 * installation, or no other authorized repo has an index manifest. The PR
 * repo's own namespace is excluded (it is always queried as the
 * weighted-highest primary). The result is sorted (determinism) and capped at
 * `MAX_CROSS_REPO_SIBLINGS`.
 */
export async function resolveCrossRepoNamespaces(
  env: LinearRepoScopeEnv & { OPENCLAW_STATE?: KVNamespace; OPENCLAW_CROSS_REPO_CONTEXT?: string },
  installationId: number,
  owner: string,
  repo: string,
): Promise<string[]> {
  if (!crossRepoContextEnabled(env)) return []
  if (!Number.isSafeInteger(installationId) || installationId <= 0) return []
  if (!env.OPENCLAW_STATE || !env.SIGILIX_PLATFORM_DB) return []

  const base = indexNamespace(owner, repo)
  let indexed: string[]
  let installationRepos: string[]
  try {
    const resolved = await Promise.all([
      listIndexedRepos({ OPENCLAW_STATE: env.OPENCLAW_STATE }, { owner }),
      listRepoFullNamesForInstallation(env, installationId),
    ])
    ;[indexed, installationRepos] = resolved
  } catch {
    console.warn(JSON.stringify({ event: "review-cross-repo-automatic-resolution-failed" }))
    return []
  }

  // The namespace helpers return lowercase by contract; D1 preserves display
  // casing in `full_name`, so canonicalize only that side of the intersection.
  const exactInstallation = new Set(installationRepos.map((name) => name.trim().toLowerCase()).filter(Boolean))
  const candidates = indexed.filter((ns) => ns !== base && ns.startsWith(`${owner.toLowerCase()}/`))
  const eligible = exactInstallation.has(base) ? candidates.filter((ns) => exactInstallation.has(ns)) : []
  eligible.sort()
  const capped = Math.max(0, eligible.length - MAX_CROSS_REPO_SIBLINGS)
  console.log(
    JSON.stringify({
      event: "review-cross-repo-automatic-scope",
      candidates: candidates.length,
      eligible: eligible.length,
      dropped: candidates.length - eligible.length,
      capped,
    }),
  )
  return eligible.slice(0, MAX_CROSS_REPO_SIBLINGS)
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
 * multiple repos to the team IS the opt-in. The binding lookup includes the exact
 * installation id, and binding writes atomically prove every repo id belongs to
 * that same installation. Lowercased, deduped, sorted, capped at
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
 * (`OPENCLAW_CROSS_REPO_CONTEXT`-gated, exact-installation D1 ∩ manifest set)
 * and the
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
  if (!Number.isSafeInteger(installationId) || installationId <= 0) return []
  const [configured, auto] = await Promise.all([
    resolveConfiguredCrossRepoNamespaces(env, installationId, owner, repo),
    resolveCrossRepoNamespaces(env, installationId, owner, repo),
  ])
  const base = indexNamespace(owner, repo)
  const candidates = configured.length + auto.length
  const merged = [...new Set([...configured, ...auto])].filter((ns) => ns !== base)
  if (merged.length > MAX_CROSS_REPO_SIBLINGS) {
    console.log(
      JSON.stringify({
        event: "review-cross-repo-siblings-capped",
        candidates,
        eligible: merged.length,
        dropped: candidates - merged.length,
        capped: merged.length - MAX_CROSS_REPO_SIBLINGS,
      }),
    )
  }
  return merged.slice(0, MAX_CROSS_REPO_SIBLINGS)
}
