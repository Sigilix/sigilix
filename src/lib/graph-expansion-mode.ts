// SIG-286: graph-context body-expansion mode parser — extracted to its own
// light module so the metrics route (and any other reader) can resolve the mode
// without importing the 9000-line review ensemble. Mirrors the SIG-285
// `./verification/mode` split.

import type { Env } from "../index"

/**
 * graph-context body-expansion mode — "off" | "shadow" | "post".
 *
 * Case-insensitive, whitespace-tolerant; unknown/unset → "off". Both "shadow"
 * and "post" only COMPUTE + emit `graph-expansion-shadow` telemetry; neither
 * injects the enriched context into any prompt yet. `post` is parsed so the
 * config surface exists, but injection is RESERVED for the SIG-286 inject PR.
 */
export function graphExpansionMode(env: Env): "off" | "shadow" | "post" {
  const v = (env.OPENCLAW_GRAPH_EXPANSION ?? "").trim().toLowerCase()
  if (v === "post") return "post"
  if (v === "shadow") return "shadow"
  return "off"
}
