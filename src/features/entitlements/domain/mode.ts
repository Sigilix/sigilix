// sig-free-tier-entitlements — the rollout-mode flag resolver (pure).
//
// OPENCLAW_ENTITLEMENTS_MODE is the master rollout switch for the entire paid-only
// gate. It lets us validate the boundary in shadow (log what WOULD be gated on the
// live traffic) BEFORE flipping to enforce, so nobody's PR reviews or paid surface
// changes behavior on a guess.
//
//   • "off"     (default / unset / unknown) — NO gating. Byte-identical to the
//                pre-entitlements behavior: the gate does not even read the plan.
//   • "shadow"  — resolve the plan and LOG what would be gated, but ALLOW it. Used
//                to confirm the plan→installation resolution is correct on real
//                traffic before enforcing.
//   • "enforce" — actually gate: an un-entitled installation is blocked from the
//                paid-only surface.
//
// Default OFF (NOT shadow): this ships dark. A missing/typo/blank env can never
// enable gating — the safe failure mode for a brand-new paid boundary is "behave
// exactly as we do today".

/** Entitlements rollout mode. */
export type EntitlementsMode = "off" | "shadow" | "enforce"

/**
 * Resolve the entitlements rollout mode. FAIL-SAFE to "off": only the exact
 * strings "shadow" and "enforce" (case-insensitive, trimmed) leave the default;
 * everything else — unset, "", "on", "true", a typo — is "off" (no gating).
 */
export function resolveEntitlementsMode(env: { OPENCLAW_ENTITLEMENTS_MODE?: string }): EntitlementsMode {
  const v = env.OPENCLAW_ENTITLEMENTS_MODE?.trim().toLowerCase()
  if (v === "enforce") return "enforce"
  if (v === "shadow") return "shadow"
  return "off"
}
