// Port: the per-repo code-graph READ surface the PR-review ensemble uses to
// ground a review with structural context (BFS neighbors, blast radius, and
// row-level context expansion for the PR's changed symbols). The per-tenant DO
// resolution + the `env` binding stay adapter-internal; the adapter (PR 11)
// holds `env` and forwards each call to the typed `repo-graph-client` wrappers.
// Types only; the payload vocabulary comes from the `@/shared/domain/graph-context`
// leaf, never the `@/do/repo-graph` infra layer.

import type {
  GraphContextNode,
  GraphContextExpansion,
} from "@/shared/domain/graph-context"

export interface GraphPort {
  /**
   * Expand `seedPaths` (K=2 BFS) over the repo's active graph and return
   * neighboring file nodes for injection as `[GRAPH CONTEXT]`. Returns
   * `{ nodes: [] }` when the graph is empty or the DO has no active version.
   */
  graphContext(args: {
    seedPaths: string[]
    maxFiles: number
    maxSymbolsPerHit: number
    maxEdgesPerSymbol: number
  }): Promise<{ nodes: GraphContextNode[] }>

  /**
   * SIG-143: name-based blast radius. Resolves the changed symbol NAMES to
   * symbol ids in the repo's active graph version — scoped to `changedPaths`
   * (the files the PR changed) as a name-collision guard — then returns the
   * caller and import-dependent file paths. When either `changedNames` or
   * `changedPaths` is empty, both lists are empty (fast-path inside the DO).
   */
  blastRadiusByNames(args: {
    changedNames: string[]
    changedPaths: string[]
  }): Promise<{ callerPaths: string[]; importDependents: string[] }>

  /**
   * SIG-286: row-level context expansion for a PR's changed symbols —
   * definition spans, same-file call sites, and import reference lines, all
   * scoped to the repo's active graph version. Resolution mirrors
   * blastRadiusByNames (names scoped to `changedPaths`). Returns
   * `{ graphAvailable: false, …empty }` when there is no active version or
   * either input list is empty (fast-path inside the DO).
   */
  contextExpansionForChangedSymbols(args: {
    changedNames: string[]
    changedPaths: string[]
    maxRows?: number
  }): Promise<GraphContextExpansion>
}
