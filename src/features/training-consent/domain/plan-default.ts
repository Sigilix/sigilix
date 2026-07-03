// sig-training-data-consent — the plan-based DEFAULT consent resolver (pure).
//
// This decides consent ONLY when there is NO explicit row in
// data_learning_consent. An explicit row always wins (handled by the gate). The
// default is deliberately FAIL-CLOSED: it grants (opt-out) for a small, explicit
// allowlist of SELF-SERVE / INDIVIDUAL plans and DENIES (opt-in) for everything
// else — team, enterprise, and — critically — any unknown/unset plan. So a paid
// TEAM whose plan we cannot positively identify as individual is treated as
// DENIED, never accidentally retained.
//
// POLICY (founder-confirmed): the individual/self-serve tiers default ON
// (opt-out) — the single user is the sole data owner and the ToS they accepted
// discloses the opt-out; they can toggle OFF at any time via the consent POST.
// `free` IS included ("small folks" default on, can turn off). The multi-owner
// tiers (team, enterprise) default OFF (opt-in) and require an explicit admin
// YES. Everyone can toggle either way — only the DEFAULT differs by tier.

import type { ConsentDecision } from "@/src/features/training-consent/domain/types"

/**
 * The ONLY plans that default to consent = granted (opt-out). These are the
 * SELF-SERVE / INDIVIDUAL tiers (`free`, `individual`, `pro`, `max`, `ultra`) —
 * a single data owner, opt-out disclosed via ToS. Every value NOT in this set
 * (team, enterprise, "default", unknown, unset, typo) defaults to DENIED.
 *
 * Keep this an explicit ALLOWLIST, never a denylist: the safe failure mode is
 * "deny", so the burden is on a plan to prove it is individual-opt-out, not on
 * the resolver to prove it is team-opt-in.
 */
export const OPT_OUT_PLANS: ReadonlySet<string> = new Set<string>(["free", "individual", "pro", "max", "ultra"])

/** Lowercase + trim a raw plan/tier string. `null`/`undefined`/blank → "". */
export function normalizePlan(plan: string | null | undefined): string {
  return (plan ?? "").trim().toLowerCase()
}

/**
 * Resolve the DEFAULT consent for an org on a given plan, used only when no
 * explicit consent row exists. FAIL-CLOSED: granted only for an allowlisted
 * self-serve / individual plan; denied for team / enterprise / unknown / unset.
 */
export function resolveDefaultConsent(plan: string | null | undefined): ConsentDecision {
  return OPT_OUT_PLANS.has(normalizePlan(plan)) ? "granted" : "denied"
}
