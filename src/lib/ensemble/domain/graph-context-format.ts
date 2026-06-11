// SIG-318 (PR 12g-2): the SIG-138 / SIG-143 graph-context PURE helpers + their
// constants. These format graph-expansion nodes + blast-radius paths into the
// `[GRAPH CONTEXT]` prompt block, compute the SIG-86 vector-vs-graph overlap
// stats, and parse the OPENCLAW_GRAPH_RETRIEVAL flag value. They were exported
// (and unit-tested) from `triage-pr-review-ensemble.ts`; with their only non-test
// callers (the graph-expansion block) moving to ensemble/app/context/gather-graph,
// they relocate to the domain (the inward dependency direction) and are re-exported
// from the god-file to preserve its public surface. Never imports the orchestrator.
//
// SIG-375 (SIG-318 env→Config): the two graph-retrieval helpers are now PURE
// value-parsers taking the RAW flag string — they no longer read `env` (the
// domain-purity fix). The edge (`../config.ts`) reads `env.OPENCLAW_GRAPH_RETRIEVAL`
// once into `EnsembleConfig.flags`; the env-taking `graphRetrievalEnabled` /
// `graphRetrievalMode` wrappers the shim re-exports live there too.

// SIG-143: max blast-radius paths folded into the prompt graph-context block.
// Mirrors the ≤4 cap on BFS graph-node additions — keeps the additive context
// from crowding out the primary vector-hit retrieval.
export const GRAPH_BLAST_PROMPT_CAP = 4

// SIG-143: blast-radius name resolution is implemented — the graph block calls
// `blastRadiusByNamesFor` with the PR's changed symbol names, which the DO
// resolves to symbol_ids in the active version. With resolution live, a raw
// `post` is honored (no longer coerced to `shadow`).
export const BLAST_RADIUS_RESOLUTION_READY = true

/** Returns true when the raw OPENCLAW_GRAPH_RETRIEVAL value is "shadow" or "post". */
export function parseGraphRetrievalEnabled(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase()
  return v === "shadow" || v === "post"
}

/**
 * Returns the effective graph-retrieval mode for the raw OPENCLAW_GRAPH_RETRIEVAL
 * value: "off" | "shadow" | "post".
 *
 * While BLAST_RADIUS_RESOLUTION_READY is false, a raw value of "post" is
 * coerced to "shadow" — blast-radius resolution is inert (SIG-143) and the
 * graph-routed path is not ready for production. A config flip to "post"
 * will take effect only after the constant is flipped true.
 */
export function parseGraphRetrievalMode(raw: string | undefined): "off" | "shadow" | "post" {
  const v = (raw ?? "").trim().toLowerCase()
  const mode = v === "post" ? "post" : v === "shadow" ? "shadow" : "off"
  if (mode === "post" && !BLAST_RADIUS_RESOLUTION_READY) {
    return "shadow"
  }
  return mode
}

/**
 * Render graph-expansion nodes as the `[GRAPH CONTEXT]` content string.
 * Each line is `<path> (hopN, <edgeKind>)`. Empty array → empty string.
 */
export function formatGraphContext(nodes: { path: string; hop: number; edgeKind: string }[]): string {
  return nodes.map((n) => `${n.path} (hop${n.hop}, ${n.edgeKind})`).join("\n")
}

/**
 * Render blast-radius file paths (callers + import dependents of the changed
 * symbols) as additional `[GRAPH CONTEXT]` lines for folding into the prompt
 * alongside the BFS-neighbor lines (SIG-143). Each line is
 * `<path> (blast, caller|importer)`.
 *
 * Paths in `exclude` (vector-hit seeds + BFS graph nodes) are skipped so the
 * block never repeats context already present, a path that is both a caller
 * and a dependent appears once (caller wins), and the result is capped at
 * `cap` lines for prompt-size safety. Callers are listed before importers;
 * within each group, input order is preserved. Empty input → empty string.
 */
export function formatGraphBlastContext(args: {
  callerPaths: string[]
  dependentPaths: string[]
  exclude: ReadonlySet<string>
  cap: number
}): string {
  const seen = new Set(args.exclude)
  const lines: string[] = []
  const add = (path: string, role: string): void => {
    if (lines.length >= args.cap || seen.has(path)) return
    seen.add(path)
    lines.push(`${path} (blast, ${role})`)
  }
  for (const p of args.callerPaths) add(p, "caller")
  for (const p of args.dependentPaths) add(p, "importer")
  return lines.join("\n")
}

/**
 * Compute overlap statistics between vector-hit seed paths and
 * graph-expanded node paths for the SIG-86 bake-off.
 *
 * - `jaccard`: |intersection| / |union|. 0 when both sets are empty.
 * - `addedCount`: paths in graph that were NOT in vector hits (net-new context).
 */
export function graphOverlapStats(a: { vectorPaths: string[]; graphPaths: string[] }): {
  jaccard: number
  addedCount: number
} {
  const v = new Set(a.vectorPaths)
  const g = new Set(a.graphPaths)
  const inter = [...g].filter((p) => v.has(p)).length
  const union = new Set([...a.vectorPaths, ...a.graphPaths]).size
  return {
    jaccard: union === 0 ? 0 : inter / union,
    addedCount: [...g].filter((p) => !v.has(p)).length,
  }
}
