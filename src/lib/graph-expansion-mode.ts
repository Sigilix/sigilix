// SIG-286: graph-context body-expansion mode parser — extracted to its own
// light module so the metrics route (and any other reader) can resolve the mode
// without importing the 9000-line review ensemble. Mirrors the SIG-285
// `./verification/mode` split.

import type { Env } from "../shared/types/env"

/**
 * graph-context body-expansion mode — "off" | "shadow" | "post".
 *
 * Case-insensitive, whitespace-tolerant; unknown/unset → "off". `shadow`
 * COMPUTES + emits `graph-expansion-shadow` telemetry without touching the
 * prompt; `post` additionally injects the targeted cross-file expansion
 * (SIG-286 PR1, `renderGraphExpansionForPrompt`) into logic+tests+synth.
 */
export function graphExpansionMode(env: Env): "off" | "shadow" | "post" {
  const v = (env.OPENCLAW_GRAPH_EXPANSION ?? "").trim().toLowerCase()
  if (v === "post") return "post"
  if (v === "shadow") return "shadow"
  return "off"
}

/**
 * SIG-286 PR2 — deterministic A/B arm for the targeted-inject experiment.
 *
 * Among reviews that WOULD inject (the render is non-empty), TREATMENT gets the
 * cross-file inject and CONTROL does NOT — split ~50/50 by a stable 32-bit hash
 * of the head SHA. Stable so a re-review of the same head stays in the same arm
 * (no flip-flop), and deterministic so the arm can be re-derived for analysis.
 * The point: the inject improves reasoning about the CHANGED code, so its
 * findings land on the diff, not on the snippets — only a control arm reveals
 * whether it actually catches MORE real findings (the FN payoff). Pure.
 */
export function injectArm(headSha: string): "treatment" | "control" {
  let h = 0
  for (let i = 0; i < headSha.length; i++) h = (Math.imul(h, 31) + headSha.charCodeAt(i)) | 0
  return (h & 1) === 0 ? "treatment" : "control"
}
