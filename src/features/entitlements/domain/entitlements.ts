// sig-free-tier-entitlements — the SINGLE source of truth for "is this paid-only
// feature available on this plan" (pure, no IO). Every gated worker surface
// resolves its installation's plan and then asks THIS module. Because the tier
// set and the per-feature policy both live here, moving the paid/free boundary
// (adding a feature, opening one to free, changing the entitled tiers) is a
// one-file edit.
//
// POLICY (founder-confirmed 2026-07-02): CI-failure triage, the Slack assistant,
// Linear triage/agent, and CLI bring-your-own-model-key are Pro/Teams/Max/Ultra
// ONLY. Free — and `individual`, and any unknown/unset plan — get core PR reviews
// but NOT these four.
//
// cli_byok is enforced DIFFERENTLY from the other three. The three worker surfaces
// have a server call site that branches on `resolveEntitlement(...).blocked`.
// "Bring your own model key" never routes through the Worker — the CLI (the
// opencode fork) talks to the user's own model provider directly, and the portal
// has no server BYOK endpoint — so there is no server request to reject. Its
// enforcement is therefore a DISPLAY/CONFIG gate: the CLI/portal read this same
// policy (`isFeatureEntitled`) to disable the BYOK control and show `upsellFor`,
// backed by the Terms. The policy lives here so that gate reads one source of
// truth, and so a future server touchpoint is a one-line `resolveEntitlement`
// call like the others.
//
// FAIL-CLOSED: the entitled set is an explicit ALLOWLIST. Anything we cannot
// positively identify as one of {pro, teams, max, ultra} — free, individual, team,
// enterprise, "default", unknown, unset, a typo — is NOT entitled. The burden is
// on a plan to prove it is entitled, never on this resolver to prove it is not.

/**
 * The paid-only feature surfaces this layer gates. Extend the union (and the
 * policy map below) to gate a new surface — no other file changes to add a
 * feature to the vocabulary.
 *
 *   • ci_triage — CI-failure triage sticky comment (`handleCiTriage`).
 *   • slack     — the Slack app-mention assistant (`/slack/events`).
 *   • linear    — Linear triage + the assign→PR agent.
 *   • cli_byok  — bring-your-own model-key in the CLI/portal. Client-side only
 *                 (no Worker request carries a user model key), so it is gated at
 *                 the display/config layer + Terms, not a server call site.
 */
export type EntitledFeature = "ci_triage" | "slack" | "linear" | "cli_byok"

/**
 * The tiers entitled to the paid-only features — {pro, teams, max, ultra}. The one
 * place the paid boundary is defined. Compared case-insensitively against a normalized
 * plan string (see `normalizePlan`). `teams` is FEATURE-COMPLETE (SSO + admin + all
 * connectors) — it earns every entitled feature, like the top consumer tier; only its
 * usage VOLUME differs (2× pro; see resolveRateLimitCap).
 */
export const ENTITLED_TIERS: ReadonlySet<string> = new Set<string>(["pro", "teams", "max", "ultra"])

/**
 * The per-feature policy: which features currently require an entitled tier.
 * ALL FOUR do today. When a feature is opened to free (or a new tier of gating
 * is introduced), change it HERE — the surfaces never re-decide policy, they
 * only ask `isFeatureEntitled`.
 */
const REQUIRES_ENTITLED_TIER: Record<EntitledFeature, boolean> = {
  ci_triage: true,
  slack: true,
  linear: true,
  cli_byok: true,
}

/** Lowercase + trim a raw plan/tier string. `null`/`undefined`/blank → "". */
export function normalizePlan(plan: string | null | undefined): string {
  return (plan ?? "").trim().toLowerCase()
}

/**
 * True when `plan` is entitled to `feature`. FAIL-CLOSED: a feature that requires
 * an entitled tier is granted ONLY when the normalized plan is in
 * `ENTITLED_TIERS`; every other plan (free, individual, team, enterprise,
 * unknown, unset) is denied. A feature not requiring an entitled tier is always
 * granted (none today).
 */
export function isFeatureEntitled(plan: string | null | undefined, feature: EntitledFeature): boolean {
  if (!REQUIRES_ENTITLED_TIER[feature]) return true
  return ENTITLED_TIERS.has(normalizePlan(plan))
}
