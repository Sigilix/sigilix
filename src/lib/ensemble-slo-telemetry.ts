// SIG-149 (Phase B0) — per-review latency + cost SLO telemetry for the
// ensemble review path. Like `ensemble-perf-telemetry.ts`, every emitter
// here is `console.log`-only: no behavior change, no branches in the
// production hot path. This module adds the ONE event the existing
// per-attempt/per-phase telemetry was missing — a per-review roll-up a
// dashboard and an alert can key on directly.
//
// Why a per-review roll-up when we already emit per-attempt tokens +
// per-phase latency?
//   - A CF Logs / Workers Analytics dashboard that wants "p95 time-to-
//     full-review" or "cost per review" would otherwise have to re-join
//     N `model-attempt-completed` events back to a review by (owner,
//     repo, prNumber, headSha) and sum them at query time. That join is
//     fragile (partial events on crashed runs) and expensive. Emitting
//     one pre-summed `review-slo-summary` per review makes the dashboard
//     a flat aggregation and the alert a single predicate (`sloBreached`).
//   - It is also the only place "cost" exists: per-attempt events carry
//     raw token counts; this module turns tokens → USD via `MODEL_PRICING`
//     and compares the result against a per-tier budget.
//
// Scope honesty (read before trusting the numbers):
//   - TIERS: Sigilix has no customer plan-tier concept in code yet
//     (SIG-41). The SLO table below ships a single `default` tier; the
//     shape is keyed by tier string so SIG-41 can add `free`/`pro`/…
//     rows without touching emitters or the dashboard query.
//   - COST: `MODEL_PRICING` is an operator-maintained ESTIMATE, not a
//     billed figure. Self-hosted/Ollama-cloud rates drift and are not
//     exposed by the provider per-call, so the cost field is "what we
//     model it at," surfaced for relative trend + budget-breach signal,
//     not for invoicing. Unknown models fall back to `DEFAULT_PRICING`
//     so a new model name never silently drops to $0.

import { type EnsembleRunCtx } from "./ensemble-perf-telemetry"

// ─── pricing ────────────────────────────────────────────────────────

/** USD per 1,000,000 tokens, split by direction. */
export interface ModelPricing {
  inputPerMTokUsd: number
  outputPerMTokUsd: number
}

/** Operator-maintained estimate. Keys match the `model` string the
 *  ensemble passes to `chat()` (e.g. `deepseek-v4-pro:cloud`). Keep this
 *  table in sync with `SPECIALIST_CONFIGS` / synth config when models
 *  change. Numbers are deliberately conservative cloud-inference
 *  estimates — see the module header on why these are not billed rates. */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  "deepseek-v4-pro:cloud": { inputPerMTokUsd: 0.6, outputPerMTokUsd: 1.7 },
  "kimi-k2.6:cloud": { inputPerMTokUsd: 0.6, outputPerMTokUsd: 2.5 },
  "glm-5.1:cloud": { inputPerMTokUsd: 0.4, outputPerMTokUsd: 1.6 },
  "qwen3:cloud": { inputPerMTokUsd: 0.3, outputPerMTokUsd: 0.9 },
  "minimax:cloud": { inputPerMTokUsd: 0.3, outputPerMTokUsd: 1.1 },
}

/** Applied to any model not in `MODEL_PRICING`. Sized at the high end of
 *  the table so an untracked model over-estimates cost rather than
 *  hiding spend — a too-high number trips the budget alert (visible),
 *  a too-low one doesn't (silent). */
export const DEFAULT_PRICING: ModelPricing = {
  inputPerMTokUsd: 0.6,
  outputPerMTokUsd: 2.5,
}

export function pricingForModel(model: string): ModelPricing {
  return MODEL_PRICING[model] ?? DEFAULT_PRICING
}

// ─── token accumulation ─────────────────────────────────────────────

/** Per-review token totals, keyed by the model that produced them.
 *  Mutated in place by the recorder so the orchestrator can hang it
 *  straight off the telemetry object. */
export type TokenUsageByModel = Record<string, { inputTokens: number; outputTokens: number }>

/**
 * Build the callback the orchestrator hangs on `perfCtx.recordTokens`.
 * Fires once per settled model attempt (success OR parse-failure — both
 * burned tokens), so the totals reflect true spend including retries and
 * cross-provider fallbacks.
 *
 * `undefined` counts are treated as "no data" and skipped — never
 * coerced to 0 — so a provider that doesn't surface usage leaves the
 * model absent rather than logging a misleading zero. Pure aside from
 * the in-place mutation of `sink`; exported for tests.
 */
export function makeTokenRecorder(
  sink: TokenUsageByModel,
): (model: string, inputTokens?: number, outputTokens?: number) => void {
  return (model, inputTokens, outputTokens) => {
    if (inputTokens === undefined && outputTokens === undefined) return
    const entry = sink[model] ?? { inputTokens: 0, outputTokens: 0 }
    if (inputTokens !== undefined) entry.inputTokens += inputTokens
    if (outputTokens !== undefined) entry.outputTokens += outputTokens
    sink[model] = entry
  }
}

export interface ReviewCost {
  totalUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  /** Per-model USD breakdown for cost-attribution drilldown. */
  byModelUsd: Record<string, number>
}

/** Pure tokens → USD using `MODEL_PRICING`. Exported for tests. */
export function computeReviewCost(usage: TokenUsageByModel): ReviewCost {
  let totalUsd = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  const byModelUsd: Record<string, number> = {}
  for (const [model, t] of Object.entries(usage)) {
    const price = pricingForModel(model)
    const usd =
      (t.inputTokens / 1_000_000) * price.inputPerMTokUsd + (t.outputTokens / 1_000_000) * price.outputPerMTokUsd
    byModelUsd[model] = usd
    totalUsd += usd
    totalInputTokens += t.inputTokens
    totalOutputTokens += t.outputTokens
  }
  return { totalUsd, totalInputTokens, totalOutputTokens, byModelUsd }
}

// ─── SLO targets ────────────────────────────────────────────────────

export interface SloTarget {
  /** Wall-clock budget for the ensemble-handler span — `telemetry.startMs`
   *  (handler entry) → `finalize()`. This covers fan-out + synth + post,
   *  but NOT webhook→queue-pickup→check-create (see `do-review-run-timing`
   *  for the broader consumer span). The production ALERT compares the
   *  FLEET p95 of `totalMs` against this, not any single run — one slow
   *  review is not an SLO breach, a slow p95 is. Sized at 300s to leave
   *  ~60s headroom under the documented ≤360s end-to-end push→visible
   *  budget (docs/ops/review-latency-budget.md, SIG-220). */
  timeToFullReviewMs: number
  /** SIG-149: wall-clock budget for time-to-first-overview — `startMs`
   *  (handler entry) → the moment the inline PR overview/walkthrough is
   *  posted (the first customer-visible content). Like full-review, the
   *  ALERT keys on the fleet p95, not a single run.
   *
   *  CAVEAT: SIG-216 currently posts the overview late (on the critical
   *  path, just before submit), so this is ~equal to full-review TODAY —
   *  it only becomes an early signal once the overview moves off the
   *  critical path (review-latency-budget.md "Lever 1"). Sized equal to
   *  the full-review budget for now; emit the measured value and re-tune
   *  (and tighten) from `review-slo-summary` data. Not all reviews post
   *  an overview (skipped on budget, never reached on early bails), so
   *  the measured value is absent on those runs and not evaluated. */
  timeToFirstOverviewMs: number
  /** USD budget for a single review's modeled cost. Compared per-review
   *  (`costUsd > budget`) because cost is additive, not a percentile.
   *  This is a STARTING threshold — re-tune from the first week of
   *  `review-slo-summary` data once real per-review spend is visible. */
  costPerReviewUsd: number
}

/** Per-tier SLO table. One `default` tier today (see module header on
 *  SIG-41). Add rows keyed by plan-tier when tiers land — emitters and
 *  the dashboard query read this table by key, so no other code changes. */
export const SLO_TARGETS: Readonly<Record<string, SloTarget>> = {
  default: { timeToFullReviewMs: 300_000, timeToFirstOverviewMs: 300_000, costPerReviewUsd: 0.5 },
}

export type ReviewTier = keyof typeof SLO_TARGETS | (string & {})

export const DEFAULT_TIER: ReviewTier = "default"

export function resolveSloTarget(tier: ReviewTier = DEFAULT_TIER): SloTarget {
  return SLO_TARGETS[tier] ?? SLO_TARGETS[DEFAULT_TIER]!
}

export interface SloEvaluation {
  tier: ReviewTier
  target: SloTarget
  /** Per-review latency vs the tier budget. Informational on the event;
   *  the production ALERT keys on the fleet p95 of `totalMs`, computed in
   *  the CF Logs query (a single run over budget is noise). */
  latencyOverBudget: boolean
  /** Per-review modeled cost vs the tier budget. */
  costOverBudget: boolean
  /** Time-to-first-overview vs the tier budget. `false` when this run
   *  posted no overview (no data ≠ breach — same discipline as tokens). */
  overviewLatencyOverBudget: boolean
  /** True when ANY dimension is over budget. The single field a cheap
   *  log-alert predicate can fire on. */
  sloBreached: boolean
}

/** Pure SLO evaluation. Exported for tests. `timeToFirstOverviewMs` is
 *  optional — when absent (the run posted no overview) the overview
 *  dimension is treated as "no data" and never counts as a breach. */
export function evaluateReviewSlo(args: {
  tier?: ReviewTier
  totalMs: number
  costUsd: number
  timeToFirstOverviewMs?: number
}): SloEvaluation {
  const tier = args.tier ?? DEFAULT_TIER
  const target = resolveSloTarget(tier)
  const latencyOverBudget = args.totalMs > target.timeToFullReviewMs
  const costOverBudget = args.costUsd > target.costPerReviewUsd
  const overviewLatencyOverBudget =
    args.timeToFirstOverviewMs !== undefined && args.timeToFirstOverviewMs > target.timeToFirstOverviewMs
  return {
    tier,
    target,
    latencyOverBudget,
    costOverBudget,
    overviewLatencyOverBudget,
    sloBreached: latencyOverBudget || costOverBudget || overviewLatencyOverBudget,
  }
}

// ─── review-slo-summary event ───────────────────────────────────────

export interface ReviewSloSummary {
  tier: ReviewTier
  /** Final ensemble status (`posted`/`errored`/`stale_head`/…), so the
   *  dashboard can exclude no-op exits from latency percentiles. */
  status: string
  /** Queue-pickup → finalize wall-clock for the whole review. */
  totalMs: number
  /** SLO latency budget for this tier (echoed so the dashboard needs no
   *  second lookup to draw the threshold line). */
  latencyBudgetMs: number
  latencyOverBudget: boolean
  /** Time-to-first-overview for this review, or `null` when no overview
   *  was posted (skipped on budget / early bail). Null is excluded from
   *  the dashboard's overview p95, not treated as 0. */
  timeToFirstOverviewMs: number | null
  /** Tier overview budget, echoed for the dashboard threshold line. */
  overviewBudgetMs: number
  overviewLatencyOverBudget: boolean
  totalInputTokens: number
  totalOutputTokens: number
  costUsd: number
  costBudgetUsd: number
  costOverBudget: boolean
  /** EITHER dimension over budget — the alert predicate. */
  sloBreached: boolean
  /** Per-model USD breakdown for cost-attribution drilldown. */
  byModelUsd: Record<string, number>
}

export function emitReviewSloSummary(ctx: EnsembleRunCtx, summary: ReviewSloSummary): void {
  console.log(
    JSON.stringify({
      event: "review-slo-summary",
      owner: ctx.owner,
      repo: ctx.repo,
      prNumber: ctx.prNumber,
      headSha: ctx.headSha.slice(0, 7),
      ...summary,
    }),
  )
}

/**
 * One-call convenience used by `finalize()`: turn accumulated token
 * usage + total wall-clock into a fully-evaluated `review-slo-summary`
 * and emit it. Returns the evaluation so the caller can log/act on a
 * breach if it wants. Never throws on a missing tier (`resolveSloTarget`
 * falls back to default). Pure aside from the emit; exported for tests.
 */
export function emitReviewSlo(
  ctx: EnsembleRunCtx,
  args: {
    tier?: ReviewTier
    status: string
    totalMs: number
    usage: TokenUsageByModel
    /** Absent when the run posted no overview. */
    timeToFirstOverviewMs?: number
  },
): SloEvaluation {
  const cost = computeReviewCost(args.usage)
  const eval_ = evaluateReviewSlo({
    // Conditional spread (not `tier: args.tier`) under
    // exactOptionalPropertyTypes — an explicit `undefined` isn't
    // assignable to the optional `tier?`.
    ...(args.tier !== undefined ? { tier: args.tier } : {}),
    ...(args.timeToFirstOverviewMs !== undefined ? { timeToFirstOverviewMs: args.timeToFirstOverviewMs } : {}),
    totalMs: args.totalMs,
    costUsd: cost.totalUsd,
  })
  emitReviewSloSummary(ctx, {
    tier: eval_.tier,
    status: args.status,
    totalMs: args.totalMs,
    latencyBudgetMs: eval_.target.timeToFullReviewMs,
    latencyOverBudget: eval_.latencyOverBudget,
    timeToFirstOverviewMs: args.timeToFirstOverviewMs ?? null,
    overviewBudgetMs: eval_.target.timeToFirstOverviewMs,
    overviewLatencyOverBudget: eval_.overviewLatencyOverBudget,
    totalInputTokens: cost.totalInputTokens,
    totalOutputTokens: cost.totalOutputTokens,
    costUsd: cost.totalUsd,
    costBudgetUsd: eval_.target.costPerReviewUsd,
    costOverBudget: eval_.costOverBudget,
    sloBreached: eval_.sloBreached,
    byModelUsd: cost.byModelUsd,
  })
  return eval_
}
