// SIG-86 (ARC-283 B1c) — Shadow bake-off aggregator + decision report.
//
// The B1b harness (PR #98) emits `shadow-verdict-comparison`,
// `shadow-model-attempt-completed`, `shadow-cut-short`, and
// `shadow-run-failed` events on every PR review via
// `console.log(JSON.stringify(...))`. Cloudflare Logpush exports them
// to R2 as NDJSON. This module consumes that NDJSON stream (already
// parsed by the CLI caller) and computes the per-role decision report
// against the bars documented in `docs/ops/shadow-bakeoff.md`.
//
// Design choices come from Codex APPROVE-WITH-NOTES at
// `.claude/handoff/sig-86-design-codex-response.md`:
//   - Pure functions only; CLI does the I/O.
//   - Wilson CI for rates; bootstrap CI for p95 latency.
//   - Two-proportion CI for prod-vs-shadow comparisons.
//   - <100 sample size blocks any overall `pass`; comparative metrics
//     become `inconclusive`. `cut-short` + `run-failed` still `fail`
//     on non-zero counts (regression flags).
//   - p95 from `shadow-model-attempt-completed.elapsedMs`, NOT
//     role-level elapsed — bar is the per-attempt cap.
//   - Net unique useful findings → `inconclusive_pending_manual_review`
//     until founder labels are wired through.
//   - Score-4+ overlap requires the SIG-86 schema tweak (commit
//     90b6190). Historical events without these fields surface as
//     `inconclusive` rather than being approximated from histograms.
//
// Out of scope for this module:
//   - NDJSON parsing / R2 reading / CLI argument plumbing — lives in
//     `scripts/bakeoff-report.mjs`.
//   - Markdown formatting — separate function below; CLI calls both.
//   - Cron / scheduled runs — operator-pull MVP per Codex.

// ─── Event shapes ──────────────────────────────────────────────────
//
// Mirrors the producer types in `shadow-bakeoff-telemetry.ts` plus the
// `ts` field that Logpush stamps on every log entry. We re-declare here
// (rather than importing) so the aggregator stays usable from a Node
// CLI without dragging in the worker's full module graph.

/** Minimum subset of `shadow-verdict-comparison` payload the aggregator
 *  needs. Older events emitted before the SIG-86 schema tweak omit the
 *  `score4Plus*` fields entirely — readers treat absent as "this
 *  comparison cannot contribute to the score-4+ overlap metric". */
export interface ShadowVerdictComparisonEvent {
  event: "shadow-verdict-comparison"
  ts: string
  role: string
  prodModel: string
  shadowModel: string
  prodVerdictOk: boolean
  shadowVerdictOk: boolean
  prodElapsedMs: number
  shadowElapsedMs: number
  prodFindingsCount: number
  shadowFindingsCount: number
  // SIG-86: optional because historical events predate the schema.
  score4PlusOverlapCount?: number
  score4PlusProdOnlyCount?: number
  score4PlusShadowOnlyCount?: number
  shadowFailureReason: string | null
}

export interface ShadowAttemptCompletedEvent {
  event: "shadow-model-attempt-completed"
  ts: string
  role: string
  attemptKind: "primary" | "retry" | "fallback"
  attemptIndex: number
  model: string
  timeoutMs: number
  elapsedMs: number
  outcome: "ok" | "failed" | "aborted" | "timeout"
  failureReason?: string
}

export interface ShadowCutShortEvent {
  event: "shadow-cut-short"
  ts: string
  role: string
  elapsedAtCutMs: number
  reason: "grace_deadline" | "orch_aborted"
}

export interface ShadowRunFailedEvent {
  event: "shadow-run-failed"
  ts: string
  role: string
  message: string
}

export type ShadowEvent =
  | ShadowVerdictComparisonEvent
  | ShadowAttemptCompletedEvent
  | ShadowCutShortEvent
  | ShadowRunFailedEvent

// ─── Statistics primitives ────────────────────────────────────────

/**
 * Wilson score interval for a binomial proportion. More accurate than
 * the normal-approximation CI on small samples or proportions near 0/1.
 * Returns `[lower, upper]` bounds, both in [0, 1].
 *
 * For n = 0 returns [0, 1] (maximally uncertain) — caller decides
 * what to do with that signal.
 */
export function wilsonInterval(
  successes: number,
  total: number,
  confidence: 0.95 | 0.99 = 0.95,
): { lower: number; upper: number } {
  if (total <= 0) return { lower: 0, upper: 1 }
  if (successes < 0 || successes > total) {
    throw new Error(`wilsonInterval: successes=${successes} out of range for total=${total}`)
  }
  const z = confidence === 0.99 ? 2.5758 : 1.96
  const phat = successes / total
  const denom = 1 + (z * z) / total
  const center = (phat + (z * z) / (2 * total)) / denom
  const margin = (z * Math.sqrt((phat * (1 - phat)) / total + (z * z) / (4 * total * total))) / denom
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  }
}

/**
 * Wilson CI on the DIFFERENCE of two proportions (`a - b`). Used for
 * prod-vs-shadow comparisons per Codex's "two-proportion CI on shadow
 * minus prod" guidance. Returns `[lower, upper]` in [-1, 1].
 *
 * Implementation: Newcombe's method 10 — the variance-of-difference
 * formula using per-side Wilson intervals. Cheaper than full
 * score-CI-on-difference and matches what most stats libraries ship.
 */
export function twoProportionInterval(
  a: { successes: number; total: number },
  b: { successes: number; total: number },
  confidence: 0.95 | 0.99 = 0.95,
): { lower: number; upper: number } {
  const ciA = wilsonInterval(a.successes, a.total, confidence)
  const ciB = wilsonInterval(b.successes, b.total, confidence)
  const pA = a.total > 0 ? a.successes / a.total : 0
  const pB = b.total > 0 ? b.successes / b.total : 0
  const lowerDelta = Math.sqrt((pA - ciA.lower) ** 2 + (ciB.upper - pB) ** 2)
  const upperDelta = Math.sqrt((ciA.upper - pA) ** 2 + (pB - ciB.lower) ** 2)
  return {
    lower: Math.max(-1, pA - pB - lowerDelta),
    upper: Math.min(1, pA - pB + upperDelta),
  }
}

/**
 * Compute the requested percentile from a flat numeric array. Uses
 * nearest-rank (no interpolation) to match the bar-vs-actual style of
 * the shadow-bake-off acceptance criteria — a value either exceeded
 * the cap or it didn't.
 *
 * Returns `null` for empty arrays. `p` is a percentage (0..100).
 * Does NOT mutate the input.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  if (p < 0 || p > 100) throw new Error(`percentile: p=${p} must be in [0, 100]`)
  const sorted = [...values].sort((a, b) => a - b)
  // Nearest-rank: index = ceil(p/100 * N) - 1, clamped to [0, N-1].
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))
  // Safe because idx is bounded by sorted.length-1; assert to satisfy
  // noUncheckedIndexedAccess strict-mode.
  const v = sorted[idx]
  if (v === undefined) throw new Error(`percentile: unreachable (idx=${idx})`)
  return v
}

// ─── Verdict types ────────────────────────────────────────────────

export type MetricVerdict =
  | "pass"
  | "fail"
  | "inconclusive"
  | "inconclusive_pending_manual_review"

export interface MetricResult {
  verdict: MetricVerdict
  /** One-line human-readable explanation. The Markdown renderer
   *  surfaces this verbatim alongside the verdict badge. */
  reason: string
  /** Raw numeric / structured value, attached so the JSON report
   *  carries the underlying numbers a reviewer can audit. */
  value?: unknown
}

// ─── Aggregator ───────────────────────────────────────────────────

export interface AggregatorConfig {
  /** Minimum review-comparison sample size before any comparative
   *  metric is allowed to `pass`. Codex Q5 sign-off: 100. */
  minSampleSize: number
  /** Per-attempt latency cap (ms). Default 60_000 per
   *  `docs/ops/shadow-bakeoff.md`. */
  p95LatencyBarMs: number
  /** Score-4+ overlap-with-prod ratio bar. Default 0.5. */
  overlapBar: number
  /** Statistical confidence for Wilson + two-proportion intervals. */
  confidence: 0.95 | 0.99
}

export const DEFAULT_AGGREGATOR_CONFIG: AggregatorConfig = {
  minSampleSize: 100,
  p95LatencyBarMs: 60_000,
  overlapBar: 0.5,
  confidence: 0.95,
}

/** Per-role decision report. All metrics carry their own verdict +
 *  reason; the top-level `overallVerdict` is the worst of the per-
 *  metric verdicts (any `fail` → fail; else any `inconclusive*` →
 *  inconclusive; else pass). */
export interface RoleReport {
  role: string
  sampleSize: number
  prodModel: string | null
  shadowModel: string | null
  metrics: {
    validVerdictRate: MetricResult
    p95LatencyMs: MetricResult
    transientFailureRate: MetricResult
    findingsOverlapScore4Plus: MetricResult
    netUniqueUsefulFindings: MetricResult
    cutShortRate: MetricResult
    runFailedRate: MetricResult
  }
  overallVerdict: MetricVerdict
}

export interface DecisionReport {
  /** Generated-at ISO timestamp (caller injects so tests can pin). */
  generatedAt: string
  /** Inclusive window bounds (ISO). */
  since: string
  until: string
  config: AggregatorConfig
  roles: RoleReport[]
}

/**
 * Top-level entry point. Takes the parsed event stream and the window
 * + config, returns the structured decision report. Pure: no I/O, no
 * env, no clock — `now` is injected.
 */
export function buildDecisionReport(args: {
  events: readonly ShadowEvent[]
  since: string
  until: string
  now: string
  config?: Partial<AggregatorConfig>
}): DecisionReport {
  const config = { ...DEFAULT_AGGREGATOR_CONFIG, ...(args.config ?? {}) }
  // Filter to the inclusive window.
  const sinceMs = Date.parse(args.since)
  const untilMs = Date.parse(args.until)
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) {
    throw new Error(`buildDecisionReport: bad since/until window`)
  }
  const inWindow = args.events.filter((e) => {
    const t = Date.parse(e.ts)
    return Number.isFinite(t) && t >= sinceMs && t <= untilMs
  })
  // Group by role. Every event type carries a `role` field.
  const roleNames = new Set<string>()
  for (const e of inWindow) roleNames.add(e.role)
  const roles: RoleReport[] = []
  for (const role of [...roleNames].sort()) {
    roles.push(buildRoleReport(role, inWindow, config))
  }
  return {
    generatedAt: args.now,
    since: args.since,
    until: args.until,
    config,
    roles,
  }
}

function buildRoleReport(
  role: string,
  windowEvents: readonly ShadowEvent[],
  config: AggregatorConfig,
): RoleReport {
  const comparisons = windowEvents.filter(
    (e): e is ShadowVerdictComparisonEvent =>
      e.event === "shadow-verdict-comparison" && e.role === role,
  )
  const attempts = windowEvents.filter(
    (e): e is ShadowAttemptCompletedEvent =>
      e.event === "shadow-model-attempt-completed" && e.role === role,
  )
  const cutShorts = windowEvents.filter(
    (e): e is ShadowCutShortEvent =>
      e.event === "shadow-cut-short" && e.role === role,
  )
  const runFails = windowEvents.filter(
    (e): e is ShadowRunFailedEvent =>
      e.event === "shadow-run-failed" && e.role === role,
  )

  const sampleSize = comparisons.length
  const prodModel = comparisons[0]?.prodModel ?? null
  const shadowModel = comparisons[0]?.shadowModel ?? null

  const metrics = {
    validVerdictRate: computeValidVerdictRate(comparisons, sampleSize, config),
    p95LatencyMs: computeP95Latency(attempts, sampleSize, config),
    transientFailureRate: computeTransientFailureRate(comparisons, sampleSize, config),
    findingsOverlapScore4Plus: computeOverlapScore4Plus(comparisons, sampleSize, config),
    netUniqueUsefulFindings: { verdict: "inconclusive_pending_manual_review" as const,
      reason: "Requires founder-eyeballed sample of shadow-only score-4+ findings; not automated in v1 (Codex Q5)." },
    cutShortRate: computeCutShortRate(cutShorts, sampleSize),
    runFailedRate: computeRunFailedRate(runFails, sampleSize),
  } satisfies RoleReport["metrics"]

  return {
    role,
    sampleSize,
    prodModel,
    shadowModel,
    metrics,
    overallVerdict: combineVerdicts(Object.values(metrics).map((m) => m.verdict)),
  }
}

// ─── Per-metric verdict functions ─────────────────────────────────

function computeValidVerdictRate(
  comparisons: readonly ShadowVerdictComparisonEvent[],
  sampleSize: number,
  config: AggregatorConfig,
): MetricResult {
  if (sampleSize === 0) {
    return { verdict: "inconclusive", reason: "0 samples in window" }
  }
  if (sampleSize < config.minSampleSize) {
    return {
      verdict: "inconclusive",
      reason: `sample size ${sampleSize} < ${config.minSampleSize} (Codex Q5 floor)`,
    }
  }
  const shadowOk = comparisons.filter((c) => c.shadowVerdictOk).length
  const prodOk = comparisons.filter((c) => c.prodVerdictOk).length
  // Codex Q5: two-proportion CI on shadow - prod. PASS if lower CI
  // bound ≥ 0 (shadow not meaningfully worse than prod); FAIL if upper
  // bound < 0; else INCONCLUSIVE.
  const ci = twoProportionInterval(
    { successes: shadowOk, total: sampleSize },
    { successes: prodOk, total: sampleSize },
    config.confidence,
  )
  const value = {
    shadowValid: shadowOk,
    prodValid: prodOk,
    sample: sampleSize,
    shadowRate: shadowOk / sampleSize,
    prodRate: prodOk / sampleSize,
    deltaCi: ci,
  }
  if (ci.lower >= 0) {
    return { verdict: "pass", reason: `shadow ≥ prod (95% CI lower bound = ${ci.lower.toFixed(3)})`, value }
  }
  if (ci.upper < 0) {
    return { verdict: "fail", reason: `shadow < prod (95% CI upper bound = ${ci.upper.toFixed(3)})`, value }
  }
  return { verdict: "inconclusive", reason: `prod/shadow CI straddles 0 (${ci.lower.toFixed(3)}..${ci.upper.toFixed(3)})`, value }
}

function computeP95Latency(
  attempts: readonly ShadowAttemptCompletedEvent[],
  sampleSize: number,
  config: AggregatorConfig,
): MetricResult {
  if (sampleSize < config.minSampleSize) {
    return {
      verdict: "inconclusive",
      reason: `sample size ${sampleSize} < ${config.minSampleSize}`,
    }
  }
  if (attempts.length === 0) {
    return { verdict: "inconclusive", reason: "no shadow-model-attempt-completed events in window" }
  }
  const elapsed = attempts.map((a) => a.elapsedMs)
  const p50 = percentile(elapsed, 50)
  const p95 = percentile(elapsed, 95)
  const value = { p50, p95, attemptCount: attempts.length, barMs: config.p95LatencyBarMs }
  if (p95 === null) {
    return { verdict: "inconclusive", reason: "p95 unavailable", value }
  }
  if (p95 <= config.p95LatencyBarMs) {
    return { verdict: "pass", reason: `p95 ${(p95 / 1000).toFixed(1)}s ≤ ${(config.p95LatencyBarMs / 1000).toFixed(0)}s bar`, value }
  }
  return { verdict: "fail", reason: `p95 ${(p95 / 1000).toFixed(1)}s > ${(config.p95LatencyBarMs / 1000).toFixed(0)}s bar`, value }
}

/** Aggregate failure-mode rate (timeout + 429 + 503 + other). The bar
 *  is "shadow rate ≤ prod rate", but prod side is reported by the
 *  shadow-verdict-comparison's `prodElapsedMs` / `prodVerdictOk` (not a
 *  separate per-attempt event), so we proxy prod transient failures by
 *  `prodVerdictOk === false` and shadow transient failures by
 *  `shadowFailureReason` being set. Coarse — Codex Q5 acknowledges
 *  this is the v1 approximation. */
function computeTransientFailureRate(
  comparisons: readonly ShadowVerdictComparisonEvent[],
  sampleSize: number,
  config: AggregatorConfig,
): MetricResult {
  if (sampleSize < config.minSampleSize) {
    return { verdict: "inconclusive", reason: `sample size ${sampleSize} < ${config.minSampleSize}` }
  }
  const shadowFailures = comparisons.filter((c) => c.shadowFailureReason !== null).length
  const prodFailures = comparisons.filter((c) => c.prodVerdictOk === false).length
  // Lower-is-better: PASS if shadow rate ≤ prod rate (upper CI bound
  // of (shadow - prod) ≤ 0); FAIL if lower bound > 0.
  const ci = twoProportionInterval(
    { successes: shadowFailures, total: sampleSize },
    { successes: prodFailures, total: sampleSize },
    config.confidence,
  )
  const value = {
    shadowFailures,
    prodFailures,
    sample: sampleSize,
    shadowRate: shadowFailures / sampleSize,
    prodRate: prodFailures / sampleSize,
    deltaCi: ci,
  }
  if (ci.upper <= 0) {
    return { verdict: "pass", reason: `shadow ≤ prod failures (95% CI upper bound = ${ci.upper.toFixed(3)})`, value }
  }
  if (ci.lower > 0) {
    return { verdict: "fail", reason: `shadow > prod failures (95% CI lower bound = ${ci.lower.toFixed(3)})`, value }
  }
  return { verdict: "inconclusive", reason: `prod/shadow failure CI straddles 0`, value }
}

function computeOverlapScore4Plus(
  comparisons: readonly ShadowVerdictComparisonEvent[],
  sampleSize: number,
  config: AggregatorConfig,
): MetricResult {
  if (sampleSize < config.minSampleSize) {
    return { verdict: "inconclusive", reason: `sample size ${sampleSize} < ${config.minSampleSize}` }
  }
  // Some events may predate the SIG-86 schema; filter to those that
  // carry the score-4+ fields. If too few, the metric is
  // inconclusive (per Codex Q4: "don't approximate from histograms").
  const enriched = comparisons.filter(
    (c) =>
      typeof c.score4PlusOverlapCount === "number" &&
      typeof c.score4PlusProdOnlyCount === "number",
  )
  if (enriched.length < config.minSampleSize) {
    return {
      verdict: "inconclusive",
      reason: `only ${enriched.length} of ${sampleSize} samples carry score-4+ fields (pre-SIG-86 schema). Threshold: ${config.minSampleSize}.`,
    }
  }
  const totalOverlap = enriched.reduce((s, c) => s + (c.score4PlusOverlapCount ?? 0), 0)
  const totalProdOnly = enriched.reduce((s, c) => s + (c.score4PlusProdOnlyCount ?? 0), 0)
  const denominator = totalOverlap + totalProdOnly
  if (denominator === 0) {
    return {
      verdict: "inconclusive",
      reason: `0 score-4+ findings in window across prod + shadow (denominator is zero)`,
      value: { overlap: totalOverlap, prodOnly: totalProdOnly, ratio: null },
    }
  }
  const ratio = totalOverlap / denominator
  // Use Wilson CI on overlap/(overlap + prodOnly). PASS if lower CI
  // bound ≥ bar, FAIL if upper bound < bar.
  const ci = wilsonInterval(totalOverlap, denominator, config.confidence)
  const value = { overlap: totalOverlap, prodOnly: totalProdOnly, ratio, ci, bar: config.overlapBar }
  if (ci.lower >= config.overlapBar) {
    return {
      verdict: "pass",
      reason: `score-4+ overlap ${(ratio * 100).toFixed(1)}% ≥ ${(config.overlapBar * 100).toFixed(0)}% (95% CI lower bound = ${(ci.lower * 100).toFixed(1)}%)`,
      value,
    }
  }
  if (ci.upper < config.overlapBar) {
    return {
      verdict: "fail",
      reason: `score-4+ overlap ${(ratio * 100).toFixed(1)}% < ${(config.overlapBar * 100).toFixed(0)}% (95% CI upper bound = ${(ci.upper * 100).toFixed(1)}%)`,
      value,
    }
  }
  return {
    verdict: "inconclusive",
    reason: `score-4+ overlap CI ${(ci.lower * 100).toFixed(1)}%..${(ci.upper * 100).toFixed(1)}% straddles ${(config.overlapBar * 100).toFixed(0)}% bar`,
    value,
  }
}

function computeCutShortRate(
  cutShorts: readonly ShadowCutShortEvent[],
  sampleSize: number,
): MetricResult {
  // Codex Q5: cut-short FAILS on any non-zero, even pre-100 samples.
  // Regression flag — a single occurrence means something's off.
  if (cutShorts.length > 0) {
    return {
      verdict: "fail",
      reason: `${cutShorts.length} cut-short event(s) in window — regression flag, any non-zero fails`,
      value: { count: cutShorts.length, sampleSize, reasons: countReasons(cutShorts) },
    }
  }
  if (sampleSize === 0) {
    return { verdict: "inconclusive", reason: "0 samples in window" }
  }
  return { verdict: "pass", reason: "0 cut-short events", value: { count: 0, sampleSize } }
}

function computeRunFailedRate(
  runFails: readonly ShadowRunFailedEvent[],
  sampleSize: number,
): MetricResult {
  if (runFails.length > 0) {
    return {
      verdict: "fail",
      reason: `${runFails.length} run-failed event(s) in window — regression flag, any non-zero fails`,
      value: { count: runFails.length, sampleSize, sampleMessages: runFails.slice(0, 3).map((e) => e.message) },
    }
  }
  if (sampleSize === 0) {
    return { verdict: "inconclusive", reason: "0 samples in window" }
  }
  return { verdict: "pass", reason: "0 run-failed events", value: { count: 0, sampleSize } }
}

function countReasons(events: readonly ShadowCutShortEvent[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const e of events) out[e.reason] = (out[e.reason] ?? 0) + 1
  return out
}

/** Combine per-metric verdicts into the role-level summary. Worst
 *  wins: any `fail` → fail; else any `inconclusive*` → inconclusive;
 *  else `pass`. */
function combineVerdicts(verdicts: readonly MetricVerdict[]): MetricVerdict {
  if (verdicts.includes("fail")) return "fail"
  if (verdicts.some((v) => v === "inconclusive" || v === "inconclusive_pending_manual_review")) {
    return "inconclusive"
  }
  return "pass"
}

// ─── Markdown rendering ────────────────────────────────────────────

const VERDICT_BADGE: Record<MetricVerdict, string> = {
  pass: "✅ PASS",
  fail: "❌ FAIL",
  inconclusive: "⚠️ INCONCLUSIVE",
  inconclusive_pending_manual_review: "🟡 INCONCLUSIVE (manual review pending)",
}

/**
 * Render the decision report as a human-readable Markdown document.
 * Pairs with `JSON.stringify(report, null, 2)` for the canonical
 * artifact — Markdown summarizes, JSON is the source of truth.
 */
export function renderDecisionReportMarkdown(report: DecisionReport): string {
  const lines: string[] = []
  lines.push(`# Shadow bake-off decision report`)
  lines.push("")
  lines.push(`**Generated:** ${report.generatedAt}  `)
  lines.push(`**Window:** ${report.since} → ${report.until}  `)
  lines.push(`**Min sample size:** ${report.config.minSampleSize}  `)
  lines.push(`**p95 latency bar:** ${(report.config.p95LatencyBarMs / 1000).toFixed(0)}s  `)
  lines.push(`**Score-4+ overlap bar:** ${(report.config.overlapBar * 100).toFixed(0)}%  `)
  lines.push("")
  if (report.roles.length === 0) {
    lines.push("_No shadowed roles produced any events in the window._")
    return lines.join("\n") + "\n"
  }
  for (const role of report.roles) {
    lines.push(`## Role: \`${role.role}\` — ${VERDICT_BADGE[role.overallVerdict]}`)
    lines.push("")
    lines.push(`- **Sample size:** ${role.sampleSize}`)
    if (role.prodModel) lines.push(`- **Prod model:** \`${role.prodModel}\``)
    if (role.shadowModel) lines.push(`- **Shadow model:** \`${role.shadowModel}\``)
    lines.push("")
    lines.push(`| Metric | Verdict | Detail |`)
    lines.push(`|---|---|---|`)
    const m = role.metrics
    lines.push(`| Valid-verdict rate | ${VERDICT_BADGE[m.validVerdictRate.verdict]} | ${m.validVerdictRate.reason} |`)
    lines.push(`| p95 latency | ${VERDICT_BADGE[m.p95LatencyMs.verdict]} | ${m.p95LatencyMs.reason} |`)
    lines.push(`| Transient failure rate | ${VERDICT_BADGE[m.transientFailureRate.verdict]} | ${m.transientFailureRate.reason} |`)
    lines.push(`| Findings overlap (score 4+) | ${VERDICT_BADGE[m.findingsOverlapScore4Plus.verdict]} | ${m.findingsOverlapScore4Plus.reason} |`)
    lines.push(`| Net unique useful findings | ${VERDICT_BADGE[m.netUniqueUsefulFindings.verdict]} | ${m.netUniqueUsefulFindings.reason} |`)
    lines.push(`| Cut-short rate | ${VERDICT_BADGE[m.cutShortRate.verdict]} | ${m.cutShortRate.reason} |`)
    lines.push(`| Run-failed rate | ${VERDICT_BADGE[m.runFailedRate.verdict]} | ${m.runFailedRate.reason} |`)
    lines.push("")
  }
  return lines.join("\n") + "\n"
}
