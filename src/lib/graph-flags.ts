/**
 * True iff the graph write path is active. Mirrors the idiom used by
 * OPENCLAW_BRANCH_AWARE_RETRIEVAL: both "on" and "shadow" enable the
 * path so it can be validated before full rollout.
 */
export function graphIndexEnabled(env: { OPENCLAW_GRAPH_INDEX?: string }): boolean {
  const v = (env.OPENCLAW_GRAPH_INDEX ?? "").trim().toLowerCase()
  return v === "on" || v === "shadow"
}

/**
 * SIG-407: tri-state mode for the @-mention Q&A symbol-aware retrieval expansion.
 *   - "off" (default / unset / anything unrecognized): no expansion. The DO is
 *     never queried; the prompt / tool output is byte-identical to today.
 *   - "shadow": build the symbol block + emit telemetry, but inject NOTHING — the
 *     posted output stays byte-identical, so cost/coverage can be measured in prod
 *     with zero answer-quality risk before flip.
 *   - "on": inject the expanded block.
 * Trims + lowercases the raw value, mirroring `graphIndexEnabled` above.
 */
export type MentionSymbolExpansionMode = "off" | "shadow" | "on"

export function mentionSymbolExpansionMode(env: {
  OPENCLAW_MENTION_SYMBOL_EXPANSION?: string
}): MentionSymbolExpansionMode {
  const v = (env.OPENCLAW_MENTION_SYMBOL_EXPANSION ?? "").trim().toLowerCase()
  return v === "on" ? "on" : v === "shadow" ? "shadow" : "off"
}
