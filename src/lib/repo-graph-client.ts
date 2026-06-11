// SIG-138 Task 6 — Thin typed wrappers for RepoGraphDO.
//
// Resolves the per-tenant DO stub via indexNamespace(owner, repo) and
// exposes typed async helpers used by the indexer write path (T7) and
// the GDPR delete path (T8).  No runtime unit tests — tsc validates
// types; T7/T8 exercise the wrappers end-to-end.

import type { Env } from "@/src/shared/types/env"
import { indexNamespace } from "./repo-index-manifest"
import type { RepoGraphDO, UpsertFileGraphArgs, GraphContextNode, GraphContextExpansion } from "@/src/do/repo-graph"

// Env declares REPO_GRAPH_DO as the unparameterised DurableObjectNamespace.
// Unlike PR_REVIEW_RUN (which is fetch-based and never calls RPC methods,
// so it stays bare), we cast to the typed variant here because we call RPC
// methods on the stub and need the type-check against RepoGraphDO's public
// interface.  The cast is safe: wrangler.toml binds exactly RepoGraphDO to
// the REPO_GRAPH_DO name.
function graphStub(env: Env, owner: string, repo: string): DurableObjectStub<RepoGraphDO> {
  const ns = env.REPO_GRAPH_DO as unknown as DurableObjectNamespace<RepoGraphDO>
  const id = ns.idFromName(indexNamespace(owner, repo))
  return ns.get(id)
}

export async function writeFileGraph(env: Env, owner: string, repo: string, args: UpsertFileGraphArgs): Promise<void> {
  await graphStub(env, owner, repo).upsertFileGraph(args)
}

export async function commitGraph(env: Env, owner: string, repo: string, runId: string): Promise<void> {
  await graphStub(env, owner, repo).commitGraphVersion(runId)
}

export async function debugActiveGraphVersion(env: Env, owner: string, repo: string): Promise<string | null> {
  return graphStub(env, owner, repo).debugActiveVersion()
}

export async function deleteGraph(env: Env, owner: string, repo: string): Promise<void> {
  await graphStub(env, owner, repo).deleteRepoGraph()
}

// ─── Phase 2 read wrappers ─────────────────────────────────────────

/**
 * Expand `seedPaths` (K=2 BFS) over the repo's active graph and return
 * neighboring file nodes for injection as `[GRAPH CONTEXT]`. Returns
 * `{ nodes: [] }` when the graph is empty or the DO has no active version.
 */
export async function graphContextFor(
  env: Env,
  owner: string,
  repo: string,
  args: {
    seedPaths: string[]
    maxFiles: number
    maxSymbolsPerHit: number
    maxEdgesPerSymbol: number
  },
): Promise<{ nodes: GraphContextNode[] }> {
  return graphStub(env, owner, repo).contextForVectorHits(args)
}

/**
 * Return the set of caller and import-dependent file paths for the given
 * changed symbol IDs. When `changedSymbolIds` is empty, both lists are
 * empty (fast-path — no DO query).
 */
export async function blastRadiusFor(
  env: Env,
  owner: string,
  repo: string,
  args: { changedSymbolIds: string[] },
): Promise<{ callerPaths: string[]; importDependents: string[] }> {
  return graphStub(env, owner, repo).blastRadius(args)
}

/**
 * SIG-143: name-based blast radius. Resolves the changed symbol NAMES to
 * symbol ids in the repo's active graph version — scoped to `changedPaths`
 * (the files the PR changed) as a name-collision guard — then returns the
 * caller and import-dependent file paths. When either `changedNames` or
 * `changedPaths` is empty, both lists are empty (fast-path inside the DO).
 */
export async function blastRadiusByNamesFor(
  env: Env,
  owner: string,
  repo: string,
  args: { changedNames: string[]; changedPaths: string[] },
): Promise<{ callerPaths: string[]; importDependents: string[] }> {
  return graphStub(env, owner, repo).blastRadiusByNames(args)
}

/**
 * SIG-286: row-level context expansion for a PR's changed symbols — definition
 * spans, same-file call sites, and import reference lines, all scoped to the
 * repo's active graph version. Resolution mirrors blastRadiusByNamesFor (names
 * scoped to `changedPaths`). Returns `{ graphAvailable: false, …empty }` when
 * there is no active version or either input list is empty (fast-path inside
 * the DO).
 */
export async function contextExpansionForChangedSymbolsFor(
  env: Env,
  owner: string,
  repo: string,
  args: { changedNames: string[]; changedPaths: string[]; maxRows?: number },
): Promise<GraphContextExpansion> {
  return graphStub(env, owner, repo).contextExpansionForChangedSymbols(args)
}
