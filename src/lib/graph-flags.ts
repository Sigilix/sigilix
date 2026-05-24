/**
 * True iff the graph write path is active. Mirrors the idiom used by
 * OPENCLAW_BRANCH_AWARE_RETRIEVAL: both "on" and "shadow" enable the
 * path so it can be validated before full rollout.
 */
export function graphIndexEnabled(env: { OPENCLAW_GRAPH_INDEX?: string }): boolean {
  const v = (env.OPENCLAW_GRAPH_INDEX ?? "").trim().toLowerCase()
  return v === "on" || v === "shadow"
}
