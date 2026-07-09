// sig-user-profile — the single source of truth for "what plan is this user on".
//
// THE BILLING SEAM (read this before wiring Stripe):
//   Today there is no subscription/billing store, so a user's plan is the
//   deployment-wide display default from the OPENCLAW_PLAN env var (validated
//   against the known set, else "free"). This is honest: every caller sees the
//   same value, and it is never fabricated to "pro".
//
//   When Stripe / a subscription store lands, change EXACTLY ONE place —
//   `resolveUserPlan` below — to look the plan up by githubUserId (the row that
//   billing writes) and fall back to `resolvePlanFromEnv` when there is no
//   subscription on file. Every consumer already calls through this function, so
//   the account badge, the usage panel, and the org page all start reflecting the
//   real per-user plan the moment that lookup exists — no other file changes.
//
// Consumers:
//   • user-profile-route.ts  → GET /v1/profile  (account badge + settings page)
//   • usage-route.ts         → GET /v1/usage    (usage panel / CLI bars)
//   • org-overview-route.ts  → GET /v1/org/overview

import { readInstallationPlan } from "@/src/features/entitlements"
import type { Env } from "@/src/shared/types/env"

/** The canonical plan set. Order is low→high tier. */
export const PLAN_NAMES = ["free", "pro", "teams", "max", "ultra", "team", "enterprise"] as const
export type PlanName = (typeof PLAN_NAMES)[number]

/**
 * Tier rank low→high, for picking the strongest plan among several installations
 * (a user in a paid org + a free personal install must read as the paid tier).
 * "team" is the legacy alias of "teams" and ranks the same.
 */
const PLAN_RANK: Record<PlanName, number> = {
  free: 0,
  pro: 1,
  teams: 2,
  team: 2,
  max: 3,
  ultra: 4,
  enterprise: 5,
}

/** Numeric rank for a plan (higher = stronger tier). */
export function planRank(plan: PlanName): number {
  return PLAN_RANK[plan]
}

/**
 * The deployment-wide plan default from OPENCLAW_PLAN, validated against the
 * known set; anything absent/unknown resolves to "free". This is the fallback
 * the billing seam defers to when a user has no subscription on file.
 */
export function resolvePlanFromEnv(env: Pick<Env, "OPENCLAW_PLAN">): PlanName {
  const raw = env.OPENCLAW_PLAN
  return (PLAN_NAMES as readonly string[]).includes(raw ?? "") ? (raw as PlanName) : "free"
}

/**
 * The REAL plan for an installation — the authoritative `tenant.tier` in D1, the
 * SAME source the entitlements gate + rate-limit caps enforce on (readInstallationPlan).
 * This is what the portal must display everywhere (account menu, org settings,
 * plan-under-name, the usage panel header) so a paid org never reads as "free".
 *
 * Falls back to the deployment default (resolvePlanFromEnv) when: the id is
 * non-positive, there is no tenant row yet, the tier string is unrecognized, or
 * the D1 read faults (missing binding / transient error) — a display read must
 * never 5xx, and an unknown tier degrading to the env default is the safe,
 * honest direction (it never fabricates a paid tier).
 */
export async function resolveInstallationPlan(
  env: Pick<Env, "OPENCLAW_PLAN" | "SIGILIX_PLATFORM_DB">,
  installationId: number,
): Promise<PlanName> {
  if (Number.isInteger(installationId) && installationId > 0) {
    try {
      const tier = await readInstallationPlan(env, installationId)
      if (tier != null && (PLAN_NAMES as readonly string[]).includes(tier)) {
        return tier as PlanName
      }
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "resolve-installation-plan-failed",
          installationId,
          err: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }
  return resolvePlanFromEnv(env)
}

/**
 * The user's REAL plan. This is the seam Stripe/subscription billing wires into
 * (see the file header) — today it returns the deployment default for every
 * user. Async + githubUserId-scoped on purpose so the future per-user billing
 * lookup is a body-only change with no signature churn at any call site.
 */
export async function resolveUserPlan(env: Pick<Env, "OPENCLAW_PLAN">, _githubUserId?: number): Promise<PlanName> {
  // BILLING SEAM: replace this line with a lookup by `_githubUserId` in the
  // subscription store, falling back to resolvePlanFromEnv(env) when none.
  return resolvePlanFromEnv(env)
}
