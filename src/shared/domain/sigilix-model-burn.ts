// sig-cost-based-metering — per-model BURN RATE + upsell nudge (pure domain leaf).
//
// FOUNDER-CONFIRMED DESIGN: every model is available on EVERY tier — nothing is
// gated by plan. A premium model (Astraeus/GLM) just costs more per token, so it
// BURNS the tier's single cost budget faster, creating natural usage-driven upgrade
// pressure. To make "budget burns faster → upgrade" CONVERT instead of CONFUSE, the
// usage surface shows a transparent per-model relative burn rate + a soft "switch to
// a cheaper model, or upgrade" hint. This module is the pure math behind that.
//
// The numbers below are REPRESENTATIVE blended $/MTok for the Sigilix-branded served
// (MaaS) models — used ONLY to derive the RELATIVE burn multipliers + an approximate
// "tasks remaining" figure for the UI. They are NOT billing rates (billing uses the
// real measured per-review cost, computeReviewCost). Tunable — edit this one table.
// Imports nothing (pure leaf), so any layer can read it.

/** Representative blended $/MTok per Sigilix model (NOT billing; UI burn-rate only). */
export const SIGILIX_MODEL_BURN_USD_PER_MTOK: Readonly<Record<string, number>> = {
  boreas: 0.3, // Qwen3-Next-80B — the economical default
  pyroeis: 0.35, // Gemini 3.5 Flash — comparable to Boreas
  astraeus: 1.9, // GLM-5 — premium (~6× Boreas per token)
}

/** Display order (cheapest → priciest) for the burn table. */
const BURN_MODEL_ORDER = ["boreas", "pyroeis", "astraeus"] as const

/**
 * Representative tokens consumed by ONE task, used to translate a remaining USD
 * budget into an intuitive "≈ N Boreas tasks left". Grounded in observed prod
 * ledger data (~400K tokens / PR review). Tunable estimate, not a guarantee.
 */
export const REPRESENTATIVE_TASK_TOKENS = 400_000

/** The cheapest model (min $/MTok) — the "switch to me to stretch your budget" target. */
export function cheapestBurnModel(): string {
  let best: string = BURN_MODEL_ORDER[0]
  for (const m of BURN_MODEL_ORDER) {
    if ((SIGILIX_MODEL_BURN_USD_PER_MTOK[m] ?? Infinity) < (SIGILIX_MODEL_BURN_USD_PER_MTOK[best] ?? Infinity)) best = m
  }
  return best
}

/** The priciest model (max $/MTok) — the "burns fastest" model for the nudge copy. */
export function priciestBurnModel(): string {
  let worst: string = BURN_MODEL_ORDER[0]
  for (const m of BURN_MODEL_ORDER) {
    if ((SIGILIX_MODEL_BURN_USD_PER_MTOK[m] ?? -Infinity) > (SIGILIX_MODEL_BURN_USD_PER_MTOK[worst] ?? -Infinity))
      worst = m
  }
  return worst
}

export interface ModelBurn {
  model: string
  /** $/MTok relative to the cheapest model (cheapest = 1.0), rounded to 1 dp. */
  relative: number
}

/**
 * The per-model relative burn table, cheapest first (cheapest = 1.0×). e.g.
 * `[{boreas,1}, {pyroeis,1.2}, {astraeus,6.3}]` → "Astraeus ≈ 6× Boreas per task".
 * Guards divide-by-zero: a zero/absent cheapest rate yields all-1.0 (no signal
 * rather than Infinity).
 */
export function modelBurnTable(): ModelBurn[] {
  const min = SIGILIX_MODEL_BURN_USD_PER_MTOK[cheapestBurnModel()] ?? 0
  return BURN_MODEL_ORDER.map((model) => {
    const rate = SIGILIX_MODEL_BURN_USD_PER_MTOK[model] ?? 0
    const relative = min > 0 ? Math.round((rate / min) * 10) / 10 : 1
    return { model, relative }
  })
}

/**
 * Approximate number of `model` tasks the remaining USD budget can still fund, for
 * the "≈ N tasks left" UI. `null` when the budget is unbounded (enterprise) or the
 * model rate is unknown/zero. Floors at 0; whole tasks (floor).
 */
export function approxTasksRemaining(remainingUsd: number | null, model: string): number | null {
  if (remainingUsd === null || !Number.isFinite(remainingUsd)) return null
  const rate = SIGILIX_MODEL_BURN_USD_PER_MTOK[model]
  if (rate === undefined || rate <= 0) return null
  const perTaskUsd = (REPRESENTATIVE_TASK_TOKENS / 1_000_000) * rate
  if (perTaskUsd <= 0) return null
  return Math.max(0, Math.floor(remainingUsd / perTaskUsd))
}

/**
 * A soft, non-annoying upsell nudge for the usage surface, or `null` when none is
 * warranted. Fires only when the budget is BOUNDED and running low
 * (`remainingPct <= threshold`) — never on an unbounded (enterprise) or comfortable
 * budget, so it stays a nudge, not noise. Copy names the priciest model's multiplier
 * and points at the cheaper model + an upgrade, matching the founder's upsell intent.
 *
 * @param remainingPct 0–100 percent of the window budget still available, or null
 *   (unbounded → no nudge).
 * @param threshold    Percent at/below which to nudge (default 25).
 */
export function usageUpsellHint(remainingPct: number | null, threshold = 25): string | null {
  if (remainingPct === null || !Number.isFinite(remainingPct)) return null
  if (remainingPct > threshold) return null
  const cheapest = cheapestBurnModel()
  const priciest = priciestBurnModel()
  const table = modelBurnTable()
  const priciestRel = table.find((t) => t.model === priciest)?.relative ?? 1
  const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
  return (
    `${cap(priciest)} uses ~${priciestRel}× your budget per task — ` +
    `switch to ${cap(cheapest)} to stretch it, or upgrade for a bigger budget.`
  )
}
