# Shadow bake-off decision report — JSON schema (SIG-86)

The CLI at `scripts/bakeoff-report.ts` writes two artifacts per run:

- `docs/bakeoff-reports/bakeoff-report-<YYYY-MM-DD>.json` — canonical
- `docs/bakeoff-reports/bakeoff-report-<YYYY-MM-DD>.md` — human-facing summary

The JSON is the source of truth — acceptance gates (CI exit code,
operator sign-off, downstream automation) MUST key off the JSON
fields below. The Markdown is a courtesy rendering that may evolve
without notice.

## Top-level

```ts
interface DecisionReport {
  /** When the CLI ran (ISO 8601 UTC). */
  generatedAt: string
  /** Inclusive window bounds (ISO 8601). */
  since: string
  until: string
  /** Effective aggregator config used for this run. */
  config: {
    minSampleSize: number       // default 100
    p95LatencyBarMs: number     // default 60_000
    overlapBar: number          // default 0.5
    confidence: 0.95 | 0.99     // default 0.95
  }
  /** One entry per role that produced any events in the window,
   *  sorted alphabetically by role name. */
  roles: RoleReport[]
}
```

## Per-role

```ts
interface RoleReport {
  /** "logic" | "security" | "performance" | "tests" | "synth" */
  role: string
  /** Number of `shadow-verdict-comparison` events in the window. */
  sampleSize: number
  /** First-event values; null when no comparisons fired (e.g., only
   *  attempt events landed). */
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
  /** See "Overall-verdict combinator" section below. Includes the
   *  extra `pass_pending_manual_review` value that role-level
   *  combinator emits but per-metric `MetricVerdict` does not. */
  overallVerdict: RoleVerdict
}
```

## Per-metric

```ts
type MetricVerdict =
  | "pass"
  | "fail"
  | "inconclusive"
  | "inconclusive_pending_manual_review"

interface MetricResult {
  verdict: MetricVerdict
  /** One-line human-readable explanation. The Markdown report
   *  surfaces this verbatim next to the verdict badge. */
  reason: string
  /** Raw numeric / structured value, attached so reviewers can audit
   *  the underlying numbers. Shape varies per metric — see below. */
  value?: unknown
}
```

### `validVerdictRate.value`

```ts
{
  shadowValid: number      // shadow runs that produced a verdict
  prodValid: number        // prod runs that produced a verdict
  sample: number           // sampleSize
  shadowRate: number       // shadowValid / sample
  prodRate: number         // prodValid / sample
  deltaCi: { lower: number; upper: number }  // 2-prop CI on shadow - prod
}
```

`pass` when `deltaCi.lower >= 0` (shadow not meaningfully worse than
prod). `fail` when `deltaCi.upper < 0`. Otherwise `inconclusive`.

### `p95LatencyMs.value`

```ts
{
  p50: number | null       // ms
  p95: number | null       // ms — the metric this verdict gates on
  attemptCount: number     // sum of shadow-model-attempt-completed events
  barMs: number            // config.p95LatencyBarMs
}
```

Computed from `shadow-model-attempt-completed.elapsedMs` per Codex Q5
— the bar is the per-attempt cap, not role-level elapsed.
`pass` when `p95 <= barMs`. `fail` otherwise.

### `transientFailureRate.value`

```ts
{
  shadowFailures: number   // shadowFailureReason !== null
  prodFailures: number     // prodVerdictOk === false (proxy)
  sample: number
  shadowRate: number
  prodRate: number
  deltaCi: { lower: number; upper: number }  // 2-prop CI on shadow - prod
}
```

Lower-is-better: `pass` when `deltaCi.upper <= 0` (shadow ≤ prod).
`fail` when `deltaCi.lower > 0`.

v1 proxies prod transient failures by `prodVerdictOk === false`
because the harness doesn't emit per-attempt events on the prod
side. Coarse — refining requires the prod telemetry pipeline to also
emit `model-attempt-completed` events with `outcome` distinguishing
"failed" from "ok-but-no-verdict".

### `findingsOverlapScore4Plus.value`

```ts
{
  overlap: number          // sum of score4PlusOverlapCount across events
  prodOnly: number         // sum of score4PlusProdOnlyCount
  ratio: number | null     // overlap / (overlap + prodOnly)
  ci: { lower: number; upper: number }  // Wilson CI on the ratio
  bar: number              // config.overlapBar (default 0.5)
}
```

`pass` when `ci.lower >= bar`. `fail` when `ci.upper < bar`. The
metric is gated on having ≥ `minSampleSize` events that carry the
SIG-86 `score4Plus*` schema fields — older events show up as
`inconclusive` because score histograms alone can't reconstruct the
score-filtered overlap (tuple identity is lost).

### `netUniqueUsefulFindings`

Always `inconclusive_pending_manual_review` in v1. The metric
requires founder labels on shadow-only score-4+ findings and the
harness doesn't yet emit inspectable samples. A future PR will add
the founder-label pipeline + automatic verdict.

### `cutShortRate.value`

```ts
{
  count: number            // total shadow-cut-short events
  sampleSize: number
  reasons?: Record<string, number>  // breakdown by ShadowCutShortReason
}
```

Regression flag — `fail` on any non-zero count, even pre-100 samples
(per Codex Q5). A single cut-short means the shadow runner missed
its grace deadline — investigate before continuing the bake-off.

### `runFailedRate.value`

```ts
{
  count: number            // total shadow-run-failed events
  sampleSize: number
  sampleMessages?: string[]  // up to 3 example error messages
}
```

Same regression-flag treatment as `cutShortRate`. Any non-zero count
means the shadow code path itself crashed — page the on-call.

## Overall-verdict combinator

```ts
type RoleVerdict = MetricVerdict | "pass_pending_manual_review"

function combineVerdicts(verdicts: MetricVerdict[]): RoleVerdict {
  if (verdicts.includes("fail")) return "fail"
  if (verdicts.includes("inconclusive")) return "inconclusive"
  if (verdicts.includes("inconclusive_pending_manual_review")) {
    return "pass_pending_manual_review"
  }
  return "pass"
}
```

Priority (top wins):
1. **`fail`** — any single metric `fail` poisons the role.
2. **`inconclusive`** — any genuine inconclusive (sample-size floor,
   schema-gating, statistical straddle).
3. **`pass_pending_manual_review`** — every machine-verifiable metric
   passes, AND `netUniqueUsefulFindings` is
   `inconclusive_pending_manual_review` (the v1 always-manual case).
   Operator-actionable signal: "bars all green, go inspect the
   shadow-only score-4+ samples and ratify."
4. **`pass`** — every metric passes including the manual-review one
   (only reachable once the founder-label pipeline is wired).

The CLI exits 1 only if any role's `overallVerdict` is `fail` —
cron callers can pager on the exit code. `pass_pending_manual_review`
and `inconclusive` both exit 0; the operator's expected to read the
Markdown summary for actionable verdicts.
