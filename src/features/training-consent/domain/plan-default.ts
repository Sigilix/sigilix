// sig-training-data-consent — the plan-based DEFAULT consent resolver (pure).
//
// This decides consent ONLY when there is NO explicit row in
// data_learning_consent. An explicit row always wins (handled by the gate). The
// default is deliberately FAIL-CLOSED: it grants (opt-out) for a small, explicit
// allowlist of PERSONAL paid plans and DENIES (opt-in) for everything else —
// team, enterprise, free, and — critically — any unknown/unset plan. So a paid
// TEAM whose plan we cannot positively identify as personal is treated as DENIED,
// never accidentally retained.

import type { ConsentDecision } from "@/src/features/training-consent/domain/types"

/**
 * The ONLY plans that default to consent = granted (opt-out). These are the
 * PERSONAL / individual paid tiers — the user is the sole data owner and the
 * launch policy is opt-out for them. Every value NOT in this set (team,
 * enterprise, free, "default", unknown, unset, typo) defaults to DENIED.
 *
 * Keep this an explicit ALLOWLIST, never a denylist: the safe failure mode is
 * "deny", so the burden is on a plan to prove it is individual-opt-out, not on
 * the resolver to prove it is team-opt-in.
 */
export const OPT_OUT_PLANS: ReadonlySet<string> = new Set<string>(["individual", "pro", "max", "ultra"])

/** Lowercase + trim a raw plan/tier string. `null`/`undefined`/blank → "". */
export function normalizePlan(plan: string | null | undefined): string {
  return (plan ?? "").trim().toLowerCase()
}

/**
 * Resolve the DEFAULT consent for an org on a given plan, used only when no
 * explicit consent row exists. FAIL-CLOSED: granted only for an allowlisted
 * personal paid plan; denied for team / enterprise / free / unknown / unset.
 */
export function resolveDefaultConsent(plan: string | null | undefined): ConsentDecision {
  return OPT_OUT_PLANS.has(normalizePlan(plan)) ? "granted" : "denied"
}
