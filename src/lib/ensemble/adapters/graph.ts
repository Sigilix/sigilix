// SIG-363 (PR 11) — the graph-read adapter (adapters layer): implements
// `GraphPort` by forwarding each call to the typed `repo-graph-client` wrappers,
// closing over the per-review `(env, owner, repo)` scope so the port methods stay
// context-free `(args)` shapes.
//
// DOCUMENTED LATERAL: `../../repo-graph-client` is a `lib` sibling, not an
// adapter — the low-level per-tenant DO client stays in `lib` because the indexer
// WRITE path (`writeFileGraph` / `commitGraph` / `deleteGraph`) also uses it. This
// adapter wraps only the three READ wrappers the ensemble needs. The factory takes
// `(env, owner, repo)` (not just `env`) because the RepoGraph DO is per-tenant and
// each RPC is scoped to one `(owner, repo)`. Dormant seam — PR 12 wires it.

import type { Env } from "@/shared/types/env"
import type { GraphPort } from "../ports/graph"
import {
  graphContextFor,
  blastRadiusByNamesFor,
  contextExpansionForChangedSymbolsFor,
} from "../../repo-graph-client"

export function makeGraphAdapter(env: Env, owner: string, repo: string): GraphPort {
  return {
    graphContext(args) {
      return graphContextFor(env, owner, repo, args)
    },
    blastRadiusByNames(args) {
      return blastRadiusByNamesFor(env, owner, repo, args)
    },
    contextExpansionForChangedSymbols(args) {
      return contextExpansionForChangedSymbolsFor(env, owner, repo, args)
    },
  }
}
