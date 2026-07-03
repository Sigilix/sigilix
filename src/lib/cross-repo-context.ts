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
