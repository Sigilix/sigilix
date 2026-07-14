// PTS SIG-578 — scorecard builder + formatter (pure; shared by the live eval and the CLI).
//
// Turns per-condition aggregates into (a) a machine-readable scorecard object and (b) a
// condition x metric ASCII table with 95% CIs and deltas vs the baseline (Control-B).
// No model, no I/O — unit-tested in pts-continuity-score.test.ts.

import { deltaCI, type ConditionAgg, type MeanCI } from "./pts-continuity-corpus"

export interface MetricCell {
  mean: number
  lo: number
  hi: number
  /** Delta vs baseline (Control-B) with a 95% CI on the difference. Null for the baseline row. */
  deltaVsBaseline: { delta: number; lo: number; hi: number } | null
}

export interface ScorecardRow {
  condition: string
  n: number
  errored: number
  taskSuccessRate: MetricCell
  retention: MetricCell
  tokens: MetricCell
  latencyMs: MetricCell
}

export interface Scorecard {
  model: string
  scenarioIds: string[]
  runsPerCondition: number
  baselineCondition: string
  rows: ScorecardRow[]
  generatedAt: string
}

function cell(metric: MeanCI, baseline: MeanCI | null): MetricCell {
  return {
    mean: metric.mean,
    lo: metric.lo,
    hi: metric.hi,
    deltaVsBaseline: baseline ? deltaCI(metric, baseline) : null,
  }
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))

/** Clamp a proportion metric's CI bounds to [0,1]. The Wald normal approx can push a
 *  small-n retention/success CI past the bounds (e.g. 1/6 successes -> lo < 0); the mean and
 *  sd are unchanged, so `deltaCI` (which reads sd) is unaffected — only the displayed
 *  interval is corrected. Never applied to tokens/latency, which are unbounded. */
function clampProportionCI(m: MeanCI): MeanCI {
  return { ...m, lo: clamp01(m.lo), hi: clamp01(m.hi) }
}

/** Build the scorecard object. `baselineId` (Control-B) drives the delta columns. */
export function buildScorecard(args: {
  model: string
  scenarioIds: string[]
  runsPerCondition: number
  baselineId: string
  aggregates: ConditionAgg[]
}): Scorecard {
  const foundBase = args.aggregates.find((a) => a.condition === args.baselineId) ?? null
  // If the baseline has NO non-errored runs, its mean is a meaningless 0, and a delta of
  // (target - 0) would print a large FAKE positive that reads like a real finding. Drop the
  // baseline entirely in that case so every non-baseline row shows no delta (rendered N/A).
  const base = foundBase && foundBase.n > 0 ? foundBase : null
  const rows: ScorecardRow[] = args.aggregates.map((a) => {
    const isBase = a.condition === args.baselineId
    const b = isBase ? null : base
    return {
      condition: a.condition,
      n: a.n,
      errored: a.errored,
      taskSuccessRate: cell(clampProportionCI(a.taskSuccessRate), b ? clampProportionCI(b.taskSuccessRate) : null),
      retention: cell(clampProportionCI(a.retention), b ? clampProportionCI(b.retention) : null),
      tokens: cell(a.tokens, b?.tokens ?? null),
      latencyMs: cell(a.latencyMs, b?.latencyMs ?? null),
    }
  })
  return {
    model: args.model,
    scenarioIds: args.scenarioIds,
    runsPerCondition: args.runsPerCondition,
    baselineCondition: args.baselineId,
    rows,
    generatedAt: new Date().toISOString(),
  }
}

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`
const pctDelta = (x: number): string => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}pp`
const num = (x: number): string => Math.round(x).toLocaleString("en-US")
const numDelta = (x: number): string => `${x >= 0 ? "+" : ""}${Math.round(x).toLocaleString("en-US")}`

function padEnd(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length)
}

/** Render the condition x metric scorecard as an ASCII table. Deltas are shown vs the
 *  baseline (Control-B) for every non-baseline row: retention/success in pp, tokens/latency
 *  as absolute deltas. A negative retention delta on Control-B vs Control-A is the
 *  working-state LOSS from naive compaction — the number the PTS program exists to close. */
export function formatScorecard(sc: Scorecard): string {
  const lines: string[] = []
  lines.push("")
  lines.push(`┌─ PTS DEEP-WORK CONTINUITY SCORECARD · model=${sc.model} · ${sc.runsPerCondition}×/condition ─┐`)
  lines.push(`  scenarios: ${sc.scenarioIds.join(", ")}`)
  lines.push(`  baseline (delta reference): ${sc.baselineCondition}`)
  lines.push("")
  const header = [
    padEnd("condition", 34),
    padEnd("n", 4),
    padEnd("task-success", 22),
    padEnd("retention", 22),
    padEnd("tokens", 20),
    padEnd("latency(ms)", 18),
  ].join(" ")
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const r of sc.rows) {
    const success = `${pct(r.taskSuccessRate.mean)}${
      r.taskSuccessRate.deltaVsBaseline ? ` (${pctDelta(r.taskSuccessRate.deltaVsBaseline.delta)})` : ""
    }`
    const retention = `${pct(r.retention.mean)}${
      r.retention.deltaVsBaseline ? ` (${pctDelta(r.retention.deltaVsBaseline.delta)})` : ""
    }`
    const tokens = `${num(r.tokens.mean)}${
      r.tokens.deltaVsBaseline ? ` (${numDelta(r.tokens.deltaVsBaseline.delta)})` : ""
    }`
    const latency = `${num(r.latencyMs.mean)}${
      r.latencyMs.deltaVsBaseline ? ` (${numDelta(r.latencyMs.deltaVsBaseline.delta)})` : ""
    }`
    lines.push(
      [
        padEnd(r.condition, 34),
        padEnd(`${r.n}${r.errored ? `/${r.errored}e` : ""}`, 4),
        padEnd(success, 22),
        padEnd(retention, 22),
        padEnd(tokens, 20),
        padEnd(latency, 18),
      ].join(" "),
    )
    lines.push(
      padEnd("", 34) +
        `  95%CI retention [${pct(r.retention.lo)}, ${pct(r.retention.hi)}]  ·  success [${pct(
          r.taskSuccessRate.lo,
        )}, ${pct(r.taskSuccessRate.hi)}]`,
    )
  }
  lines.push("─".repeat(header.length))
  lines.push("  delta columns = (condition − baseline). Retention delta of Control-A vs Control-B = the")
  lines.push("  working-state a PTS mechanism must recover. n/Xe = X errored runs excluded from means.")
  lines.push("└" + "─".repeat(Math.max(0, header.length - 1)) + "┘")
  return lines.join("\n")
}
