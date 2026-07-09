// SIG-38 (Task 1) — pure rate-limit knobs (domain layer).
//
// Pure, side-effect-free utilities the per-tenant rate-limit layer needs:
//   1. resolveRateLimitMode  — env-flag → "off" | "shadow" | "enforce".
//   2. resolveRateLimitCap   — tier string → numeric per-window cap (seam for SIG-41).
//   3. decideRateLimit       — (used, cap, burst) → allowed boolean (fail-open).
//   4. computeResetMs        — when will the oldest slot free up? (ms until reset).
//   5. formatUsageFooter     — the _Sigilix · N of M reviews used …_ footer line.
//
// Domain-layer contract: NO env reads, NO I/O, NO clock calls, NO network.
// All non-deterministic inputs (env, now) are injected by the caller.
// The only import is the `Env` type (type-only; zero runtime cost).

import type { Env } from "@/src/shared/types/env"

// ─── RateLimitMode ───────────────────────────────────────────────────────────

export type RateLimitMode = "off" | "shadow" | "enforce"

// ─── resolveRateLimitMode ────────────────────────────────────────────────────

/**
 * Resolve the per-tenant rate-limit feature-flag from the Worker env.
 *
 * Three-state rollout:
 *   - `"enforce"` — reviews are rejected when a tenant exceeds their rolling-window cap.
 *   - `"off"`     — rate-limit logic fully bypassed.
 *   - `"shadow"`  — (default) rate-limit state is tracked and telemetered; no blocking.
 *
 * Absent, unknown, or mis-cased values all resolve to `"shadow"` (the safe,
 * observable default — mirrors `resolveQuotaMode` in `./quota.ts` exactly,
 * with `"shadow"` as the fallthrough instead of `"off"`).
 */
export function resolveRateLimitMode(env: Pick<Env, "SIGILIX_RATE_LIMIT_MODE">): RateLimitMode {
  const v = env.SIGILIX_RATE_LIMIT_MODE?.trim().toLowerCase()
  if (v === "enforce") return "enforce"
  if (v === "off") return "off"
  return "shadow"
}

// ─── Window constants ─────────────────────────────────────────────────────────

/**
 * Rolling window duration (5 hours in ms).
 *
 * Free-launch retune (2026-06-30): SIG-38 originally shipped at 1h/cap-3 (the
 * "CodeRabbit way" steer). The free-tier spec is 5h window / 1-2 reviews per
 * developer; `DEFAULT_RATE_LIMIT_CAP` below is the upper end (2) of that range.
 */
export const RATE_LIMIT_WINDOW_MS = 18_000_000

/** Default per-window review cap (free / OSS / CLI tier). */
export const DEFAULT_RATE_LIMIT_CAP = 2

/**
 * Burst allowance: the number of reviews above `cap` a tenant may consume
 * before the gate fires.
 *
 * Set to 0 (literal cap): a review is metered at finalize() AFTER it runs,
 * so at admission `used` reflects prior reviews only. With burst=1 the cap+1-th
 * review (used=cap < cap+1) would be admitted, giving an effective cap+1/hr.
 * burst=0 → allow when `used < cap + 0`, enforcing a literal cap/hr (reviews
 * at used=0…cap-1 admitted; used=cap denied).
 */
export const RATE_LIMIT_BURST = 0

// ─── Linear-triage window/cap constants ──────────────────────────────────────
//
// Free-launch caps (2026-06-26): Linear triage gets its OWN rolling-window
// cap, counted via a SEPARATE ledger (`triage_usage_ledger`, independent of
// the PR-review `usage_ledger`) so hitting one cap never consumes the other's
// budget. The window happens to equal `RATE_LIMIT_WINDOW_MS` today (both 5h),
// but the two are deliberately separate named constants — tuning one must
// never silently retune the other.

/** Rolling window duration for the Linear-triage cap (5 hours in ms). */
export const TRIAGE_RATE_LIMIT_WINDOW_MS = 18_000_000

/** Default per-window Linear-triage cap (free tier — the upper end of the 2-3 range). */
export const DEFAULT_TRIAGE_RATE_LIMIT_CAP = 3

// ─── resolveRateLimitCap ─────────────────────────────────────────────────────

/**
 * The Pro base cap (per rolling window) — the anchor of the paid-tier ladder. Every
 * other paid tier is expressed as an integer MULTIPLE of this base, so the founder's
 * confirmed ratios stay obvious in code rather than hidden in magic numbers.
 */
export const RATE_LIMIT_CAP_BASE = 5

/**
 * Per-tier multiplier of `RATE_LIMIT_CAP_BASE` — the founder-confirmed usage ladder:
 *   pro         1×  → 5      (base)
 *   teams       2×  → 10     (2× pro; feature-complete, top-tier entitlements)
 *   max         5×  → 25     (5× pro)
 *   ultra       50× → 250    (10× max = 50× pro — the highest self-serve paid tier)
 *   enterprise 100× → 500    (2× ultra — the CONTRACT tier, the highest cap of all)
 * `enterprise` is set on tenant.tier manually when a team signs a contract (never via
 * self-serve Stripe); it sits ABOVE ultra as the top of the ladder.
 * (Free is the DEFAULT_RATE_LIMIT_CAP floor, not a multiple of the base.)
 */
const TIER_CAP_MULTIPLIER: Record<"pro" | "teams" | "max" | "ultra" | "enterprise", number> = {
  pro: 1,
  teams: 2,
  max: 5,
  ultra: 50,
  enterprise: 100,
}

/**
 * Return the per-rolling-window review cap for a given subscription tier.
 *
 * This is the seam that SIG-41 (Stripe) will replace with live tier data.
 * Until then the caps are static, conservative defaults that the Stripe
 * entitlement layer will override per tenant after billing is wired.
 *
 * Tier matching is case-insensitive. Unknown, null, or undefined tiers
 * fall back to `DEFAULT_RATE_LIMIT_CAP` (the free-tier floor).
 *
 * TRIAL CAP (sig-trial-cap): during a 14-day trial a subscriber gets the tier's
 * FEATURES (gated elsewhere, unchanged) but HALF the tier's usage VOLUME. Passing
 * `trialing = true` halves the resolved cap deterministically — `round(full / 2)` —
 * with a hard `DEFAULT_RATE_LIMIT_CAP` floor so a trial is NEVER worse than Free and
 * never resolves to zero/negative. When the trial converts to `active`, the caller
 * passes `trialing = false` and the FULL tier cap is restored. Halved caps:
 * pro 5→3, teams 10→5, max 25→13, ultra 250→125 (free 2→2, floored).
 *
 * ENTERPRISE is the CONTRACT tier: set manually on tenant.tier when a team signs, never
 * sold via self-serve Stripe, so it can NEVER be on a trial. It therefore ignores the
 * `trialing` flag entirely and always resolves to its full top cap (500 = 2× ultra) —
 * this keeps enterprise at full volume even if a stray `trialing = true` is passed when
 * the contract tenant has no Stripe `active` status row.
 *
 * TODO (SIG-41): replace the static map with Stripe entitlement lookup.
 */
export function resolveRateLimitCap(tier?: string | null, trialing = false): number {
  const t = tier?.trim().toLowerCase()
  const full = ((): number => {
    if (t === "pro" || t === "teams" || t === "max" || t === "ultra" || t === "enterprise") {
      return RATE_LIMIT_CAP_BASE * TIER_CAP_MULTIPLIER[t]
    }
    switch (t) {
      // Legacy, non-Stripe-writable tiers kept for back-compat (billing only ever
      // writes free/pro/teams/max/ultra); explicit values, outside the base ladder.
      case "pro_plus":
      case "pro+":
        return 10
      // oss / cli / free / unknown / null / undefined → the Free floor.
      default:
        return DEFAULT_RATE_LIMIT_CAP
    }
  })()
  // Enterprise is contract-set (never sold via Stripe) → it can never be on a trial, so
  // it always earns its full top cap regardless of the trialing flag.
  if (!trialing || t === "enterprise") return full
  // Trial → HALF the tier's volume, deterministic + floored at the Free cap so a
  // trial is never below Free and never zero/negative/unlimited.
  return Math.max(DEFAULT_RATE_LIMIT_CAP, Math.round(full / 2))
}

/**
 * True ONLY when the subscription status positively proves a fully-paid `active`
 * subscription — the sole state that earns a tier's FULL usage volume. Every other
 * value ('trialing', null, unknown, blank, 'past_due', 'canceled', …) returns false,
 * so the caller applies the halved trial volume.
 *
 * FAIL-SAFE RESTRICTIVE: absence of proof of `active` never grants full paid volume —
 * an unknown/missing status is treated as a trial (half), never as a paid subscriber.
 */
export function isFullPaidStatus(status: string | null | undefined): boolean {
  return status?.trim().toLowerCase() === "active"
}

// ─── Cost-based budgets (sig-cost-based-metering) ─────────────────────────────
//
// The count cap above answers "how MANY reviews per window"; this answers "how
// many DOLLARS of model spend per window". A single 200K-token ensemble review
// costs far more than a 5K-token one, so a flat request count over- or under-
// charges the tenant relative to real spend. The rate-limit read now SUMs the
// per-review `cost_usd` in the window (migration 0014) and the enforcer gates on
// it: cost is the PRIMARY enforced dimension; the count cap stays as a cheap
// secondary guardrail against abuse (many tiny requests). See check-rate-limit.ts.
//
// ─────────────────────── THE FOUNDER'S BUSINESS DECISION ───────────────────────
// The numbers in `TIER_COST_BUDGET_USD` are a MARGIN/positioning decision, not an
// engineering one. Edit THIS ONE TABLE (or the env overrides) to tune them; nothing
// else changes. They are per-DEVELOPER (the rate limit is keyed by author_login, and
// the self-serve tiers are per-seat), USD of blended model spend, and PROVISIONAL —
// starting points pending calibration against real-usage data.
//
// FOUNDER-SPECIFIED GENEROSITY LADDER (the source of truth for these defaults):
//     Free  ≪  Pro  <  Teams  <  Max  <  Ultra  ≪  Enterprise(∞)
//   • FREE is TIGHT — a taste. Model/CLI use is low, but a PR review is costly
//     (~$0.35 avg, large ones more), so a single big review can legitimately
//     one-shot the free budget — intended, and it protects the AWS/GCP credits.
//   • TEAMS sits ABOVE Pro on purpose: it is a per-SEAT volume play ($20/seat), and
//     orgs don't max every seat, so per-seat generosity can exceed Pro ($30) even
//     though the per-seat price is lower. (This is why the cost ladder does NOT
//     match the count-cap ladder — don't "fix" it to match.)
//   • ENTERPRISE is a signed CONTRACT tier (billed separately) → `null` = UNBOUNDED.
//
// The founder's targets are the WEEKLY headline budget (the generosity a user feels):
//   Free ~$1.5 · Pro ~$15 · Teams ~$22/seat · Max ~$40 · Ultra ~$70 · Enterprise ∞.
// The SESSION column is the 5h rolling window; it is seeded at ≈ weekly ÷ 4 as a burst
// guard (not a full week's spend in one sitting). ENFORCEMENT differs by pool:
//   • PR pool (check-rate-limit.ts) enforces the SESSION window only — its existing
//     single rolling read. WEEKLY there is display-only (/v1/usage); until PR-pool
//     weekly enforcement lands, a maximally-active seat can exceed the PR weekly
//     figure (a known roadmap gap, verify-math §3).
//   • SEAT pool (check-usage-pool.ts) already reads BOTH windows for counts, so it
//     enforces BOTH the session AND weekly cost budgets (CLI + chatbot).
//
// TUNING NOTE: a POSITIVE number is a budget; a NEGATIVE env override means "no cap"
// (unbounded); an env override of "0" is a valid budget of $0 → blocks every request
// (a kill switch, NOT "unlimited" — unlimited is a negative override).

export type CostBudgetWindow = "session" | "weekly"

/**
 * Per-tier USD budget of blended model spend per window, per developer.
 * `null` = UNBOUNDED (no cost gate). Edit these numbers to tune margin/positioning.
 * session ≈ weekly ÷ 4 (the enforced 5h burst guard); weekly = the founder's headline.
 */
export const TIER_COST_BUDGET_USD: Readonly<
  Record<"free" | "pro" | "teams" | "max" | "ultra" | "enterprise", Record<CostBudgetWindow, number | null>>
> = {
  free: { session: 0.375, weekly: 1.5 },
  pro: { session: 3.75, weekly: 15.0 },
  teams: { session: 5.5, weekly: 22.0 }, // per-seat volume play → above Pro (intended)
  max: { session: 10.0, weekly: 40.0 },
  ultra: { session: 17.5, weekly: 70.0 },
  enterprise: { session: null, weekly: null }, // contract tier → unbounded
}

/** The Free-tier budget floor a trial can never fall below (mirrors the count-cap floor). */
const COST_BUDGET_FLOOR = TIER_COST_BUDGET_USD.free

/**
 * Env override for each (self-serve tier × window). A valid non-negative number
 * overrides the table; a NEGATIVE override means "no cap" (→ `null`, unbounded);
 * a blank/non-numeric override is ignored (falls back to the table). Enterprise
 * has no override row — it is always unbounded.
 */
const COST_BUDGET_ENV: Record<"free" | "pro" | "teams" | "max" | "ultra", Record<CostBudgetWindow, keyof Env>> = {
  free: { session: "SIGILIX_COST_BUDGET_FREE_SESSION", weekly: "SIGILIX_COST_BUDGET_FREE_WEEKLY" },
  pro: { session: "SIGILIX_COST_BUDGET_PRO_SESSION", weekly: "SIGILIX_COST_BUDGET_PRO_WEEKLY" },
  teams: { session: "SIGILIX_COST_BUDGET_TEAMS_SESSION", weekly: "SIGILIX_COST_BUDGET_TEAMS_WEEKLY" },
  max: { session: "SIGILIX_COST_BUDGET_MAX_SESSION", weekly: "SIGILIX_COST_BUDGET_MAX_WEEKLY" },
  ultra: { session: "SIGILIX_COST_BUDGET_ULTRA_SESSION", weekly: "SIGILIX_COST_BUDGET_ULTRA_WEEKLY" },
}

/** Normalize a tier string to a known budget key, or `null` for unknown/free-ish. */
function normalizeBudgetTier(tier?: string | null): "free" | "pro" | "teams" | "max" | "ultra" | "enterprise" {
  const t = tier?.trim().toLowerCase()
  if (t === "pro" || t === "teams" || t === "max" || t === "ultra" || t === "enterprise") return t
  if (t === "team") return "teams" // PLAN_NAMES carries both "team" and "teams" — same budget row.
  // oss / cli / free / pro_plus / unknown / null → the Free floor (pro_plus is a
  // legacy count-cap tier with no cost-budget row; treat as Free for cost).
  return "free"
}

/**
 * Resolve the effective per-window USD cost budget for a tier.
 *
 * Precedence: env override (valid number) → `TIER_COST_BUDGET_USD` table.
 * Returns `null` for an UNBOUNDED budget (enterprise, or a negative override).
 *
 * TRIAL (sig-trial-cap parity): during a 14-day trial a subscriber gets HALF the
 * tier's spend volume — `budget / 2`, floored at the Free budget so a trial is
 * never below Free and never zero. ENTERPRISE ignores `trialing` (contract tier,
 * never on a trial) and always resolves to `null` (unbounded).
 *
 * Env is INJECTED (never imported) — the domain-layer contract; the caller passes
 * the Worker env, mirroring `resolveUsagePoolCap`.
 */
export function resolveTierCostBudgetUsd(
  env: Partial<Env>,
  tier: string | null | undefined,
  window: CostBudgetWindow,
  trialing = false,
): number | null {
  const key = normalizeBudgetTier(tier)
  // Enterprise = unbounded, regardless of env or trial.
  if (key === "enterprise") return null

  // Base = env override (when a valid number) else the table.
  let base: number | null = TIER_COST_BUDGET_USD[key][window]
  const raw = env[COST_BUDGET_ENV[key][window]]
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw.trim())
    if (Number.isFinite(n)) base = n < 0 ? null : n
  }
  if (base === null) return null // explicit "no cap" override

  if (!trialing) return base
  // Trial → half the spend volume, floored at the Free budget for this window so a
  // trial is never below Free and never zero/negative, and CLAMPED at `base` so it
  // can never EXCEED the full (non-trial) budget — the outer `Math.min(base, …)`
  // guards the pathological case where an operator overrides this tier BELOW the
  // Free floor (without it, `max(floor, base/2)` could hand a trialing dev a larger
  // budget than a paid one on the same tier — verify-math §2 warning).
  const floor = COST_BUDGET_FLOOR[window] ?? 0
  return Math.min(base, Math.max(floor, base / 2))
}

/**
 * Return `true` (allowed) when the window's consumed cost is under the budget.
 *
 * Mirrors `decideRateLimit`'s fail-open discipline:
 *   • `budgetUsd === null`  → UNBOUNDED → always allowed.
 *   • non-finite `consumedUsd` / `budgetUsd` → allowed (a read fault never blocks).
 *   • otherwise blocks only on clear, finite evidence: `consumedUsd >= budgetUsd`.
 *
 * `>=` (not `>`): the budget is a ceiling on ALREADY-consumed spend measured at
 * admission — once a developer has spent their full budget in the window, the next
 * review is denied (parity with `decideUsagePool`, which also blocks at `used >= cap`).
 */
export function decideCostBudget(consumedUsd: number, budgetUsd: number | null): boolean {
  if (budgetUsd === null) return true
  if (!Number.isFinite(consumedUsd) || !Number.isFinite(budgetUsd)) return true
  return consumedUsd < budgetUsd
}

// ─── decideRateLimit ─────────────────────────────────────────────────────────

/**
 * Return `true` (allowed) when the tenant is within their rolling-window cap.
 *
 * A burst allowance is included: the tenant may consume up to `cap + burst`
 * reviews before being blocked, i.e. `used < cap + burst` → allowed.
 *
 * Fail-open: when `used` or `cap` is non-finite (NaN, ±Infinity) the call
 * is allowed. Blocks only when we have clear, finite evidence of excess.
 */
export function decideRateLimit(used: number, cap: number, burst: number): boolean {
  if (!Number.isFinite(used) || !Number.isFinite(cap)) return true
  return used < cap + burst
}

// ─── computeResetMs ──────────────────────────────────────────────────────────

/**
 * Return the number of milliseconds until at least one review slot opens up.
 *
 * When the tenant is within cap (`used < cap + burst`) → 0 (no wait).
 *
 * When over cap:
 *   `needed = used − (cap + burst) + 1`
 *   The `needed`-th oldest in-window review (index `needed − 1` in
 *   `windowRowsAscMs`) ages out of the window at `rowMs + windowMs`.
 *   Returns `max(0, resetAt − nowMs)`.
 *
 * If the required row is missing or non-finite, returns `windowMs`
 * (conservative fallback — no earlier information available).
 *
 * @param windowRowsAscMs Timestamps (epoch ms) of reviews in the current
 *   window, sorted ascending (oldest first).
 * @param windowMs        Rolling window duration in ms.
 * @param used            Number of reviews consumed in the window.
 * @param cap             Per-window review cap for this tenant.
 * @param burst           Burst allowance (same as passed to `decideRateLimit`).
 * @param nowMs           Current epoch time in ms.
 */
export function computeResetMs(
  windowRowsAscMs: readonly number[],
  windowMs: number,
  used: number,
  cap: number,
  burst: number,
  nowMs: number,
): number {
  if (decideRateLimit(used, cap, burst)) return 0
  const needed = used - (cap + burst) + 1
  const rowMs = windowRowsAscMs[needed - 1]
  if (rowMs === undefined || !Number.isFinite(rowMs)) return windowMs
  return Math.max(0, rowMs + windowMs - nowMs)
}

// ─── formatUsageFooter ───────────────────────────────────────────────────────

/**
 * Render the per-tenant usage footer appended to review bodies.
 *
 * Format (under cap — no reset clause):
 *   `_Sigilix · 2 of 3 reviews used in past 5h_`
 *
 * Format (over cap — with reset clause):
 *   `_Sigilix · 4 of 3 reviews used in past 5h · resets in 23m_`
 *
 * The reset countdown is ceiled to whole minutes with a floor of 1m so the
 * line never reads "resets in 0m". The italic underscore wrapping matches the
 * existing `_Sigilix · …_` footer style used in the render layer
 * (review-body.ts ~line 223).
 */
export function formatUsageFooter(used: number, cap: number, resetMs: number): string {
  const usagePart = `_Sigilix · ${used} of ${cap} reviews used in past 5h`
  if (resetMs <= 0) return `${usagePart}_`
  const m = Math.max(1, Math.ceil(resetMs / 60_000))
  return `${usagePart} · resets in ${m}m_`
}
