// SIG-138 Task 6 — Thin typed wrappers for RepoGraphDO.
//
// Resolves the per-tenant DO stub via indexNamespace(owner, repo) and
// exposes typed async helpers used by the indexer write path (T7) and
// the GDPR delete path (T8).  No runtime unit tests — tsc validates
// types; T7/T8 exercise the wrappers end-to-end.

import type { Env } from "../index"
import { indexNamespace } from "./repo-index-manifest"
import type { RepoGraphDO, UpsertFileGraphArgs } from "../do/repo-graph"

// Env declares REPO_GRAPH_DO as the unparameterised DurableObjectNamespace
// (matching the rest of the codebase's convention — see PR_REVIEW_RUN).
// We cast to the typed variant here so RPC method calls type-check against
// the DO's public interface.  The cast is safe: wrangler.toml binds exactly
// RepoGraphDO to the REPO_GRAPH_DO name.
function graphStub(
  env: Env,
  owner: string,
  repo: string,
): DurableObjectStub<RepoGraphDO> {
  const ns = env.REPO_GRAPH_DO as unknown as DurableObjectNamespace<RepoGraphDO>
  const id = ns.idFromName(indexNamespace(owner, repo))
  return ns.get(id)
}

export async function writeFileGraph(
  env: Env,
  owner: string,
  repo: string,
  args: UpsertFileGraphArgs,
): Promise<void> {
  await graphStub(env, owner, repo).upsertFileGraph(args)
}

export async function commitGraph(
  env: Env,
  owner: string,
  repo: string,
  runId: string,
): Promise<void> {
  await graphStub(env, owner, repo).commitGraphVersion(runId)
}

export async function deleteGraph(
  env: Env,
  owner: string,
  repo: string,
): Promise<void> {
  await graphStub(env, owner, repo).deleteRepoGraph()
}
