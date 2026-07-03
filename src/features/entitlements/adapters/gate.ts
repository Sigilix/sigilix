// sig-free-tier-entitlements — the ONE gate every paid-only surface calls.
// Combines the rollout mode (OPENCLAW_ENTITLEMENTS_MODE), the installation→plan
// lookup (fail-closed), and the pure entitlement policy into a single decision a
// surface acts on:
//
//   • blocked   — the surface MUST NOT run the paid feature (enforce + not
//                 entitled). This is the only field a caller needs to branch on.
//   • wouldBlock — the surface would be blocked but mode is shadow (allow +
//                 telemeter). Surfaces don't act on this; the gate logs it.
//
// mode="off" is a strict no-op: the gate does NOT read D1 and returns an
// allow-everything decision, so the pre-entitlements code path is byte-identical.
//
// FAIL-CLOSED: any error resolving the plan (D1 fault, absent binding) is caught
// here and treated as an unknown plan → not entitled. In enforce that blocks; in
// shadow it would-block; in off it stays a no-op.

import type { Env } from "@/src/shared/types/env"
import { isFeatureEntitled, type EntitledFeature } from "@/src/features/entitlements/domain/entitlements"
import { resolveEntitlementsMode, type EntitlementsMode } from "@/src/features/entitlements/domain/mode"
import { readInstallationPlan } from "@/src/features/entitlements/adapters/d1-plan-read"

/** The outcome a gated surface acts on. */
export interface EntitlementDecision {
  mode: EntitlementsMode
  feature: EntitledFeature
  /** The resolved plan/tier, or null when unknown (absent row / lookup fault). */
  plan: string | null
  /** Whether the plan is entitled to the feature (the raw policy result). */
  entitled: boolean
  /** enforce + !entitled — the surface must skip the paid feature. */
  blocked: boolean
  /** shadow + !entitled — would block; the surface allows but the gate logs it. */
  wouldBlock: boolean
}

/**
 * Resolve the entitlement for one surface invocation. Emits a single structured
 * telemetry line in shadow (would-gate) and enforce (gated) so the rollout is
 * observable; off is silent. Never throws — a lookup fault fails closed to a
 * denied plan.
 */
export async function resolveEntitlement(
  env: Pick<Env, "OPENCLAW_ENTITLEMENTS_MODE" | "SIGILIX_PLATFORM_DB">,
  args: { installationId: number; feature: EntitledFeature },
): Promise<EntitlementDecision> {
  const { installationId, feature } = args
  const mode = resolveEntitlementsMode(env)

  // off — strict no-op. No D1 read, allow everything. Byte-identical to the
  // pre-entitlements path.
  if (mode === "off") {
    return { mode, feature, plan: null, entitled: true, blocked: false, wouldBlock: false }
  }

  let plan: string | null = null
  let entitled: boolean
  try {
    plan = await readInstallationPlan(env, installationId)
    entitled = isFeatureEntitled(plan, feature)
  } catch (err) {
    // FAIL-CLOSED: an unresolvable plan is treated as not entitled.
    entitled = false
    console.warn(
      JSON.stringify({
        event: "entitlements-plan-lookup-failed",
        feature,
        installationId,
        mode,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }

  const blocked = mode === "enforce" && !entitled
  const wouldBlock = mode === "shadow" && !entitled

  if (blocked || wouldBlock) {
    console.log(
      JSON.stringify({
        event: blocked ? "entitlements-gated" : "entitlements-would-gate",
        feature,
        installationId,
        // plan is a low-cardinality tier label (free/pro/…), never user content.
        plan,
        mode,
      }),
    )
  }

  return { mode, feature, plan, entitled, blocked, wouldBlock }
}
