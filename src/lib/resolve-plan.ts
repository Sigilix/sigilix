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

import type { Env } from "@/src/shared/types/env"

/** The canonical plan set. Order is low→high tier. */
export const PLAN_NAMES = ["free", "pro", "max", "ultra", "team", "enterprise"] as const
export type PlanName = (typeof PLAN_NAMES)[number]

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
