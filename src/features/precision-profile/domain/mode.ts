// SIG-147: resolve the precision-profile rollout mode from its env flag.
// Mirrors review-memory's `resolveClaimShadowMode` three-state rollout so the
// signal can bake in `shadow` (compute + telemeter, no output change) before a
// per-repo `enforce` flip.

import type { PrecisionMode } from "./types"

/**
 * `OPENCLAW_PRECISION_PROFILE_MODE` → mode. Unknown/empty defaults to `off`
 * (the safe default — no read, no suppression) so the feature is dark until
 * explicitly enabled.
 */
export function resolvePrecisionMode(raw: string | undefined): PrecisionMode {
  switch (raw) {
    case "shadow":
      return "shadow"
    case "enforce":
      return "enforce"
    default:
      return "off"
  }
}
