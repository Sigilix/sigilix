# Review latency + cost SLO dashboard

**Status**: Living document. Updated when an SLO threshold shifts, a model price changes, or plan tiers land (SIG-41).
**Owner**: Sigilix Engine team.
**Linear**: [SIG-149](https://linear.app/sigilix/issue/SIG-149). Cross-refs: SIG-41 (tiers), SIG-116 (fetch concurrency), SIG-2/78 (budgets), [SIG-220 latency budget](./review-latency-budget.md).

---

## Why this exists

The multi-agent ensemble produces deeper reviews but is slower and costlier than single-pass alternatives. Without per-review latency + cost visibility we can't defend the ensemble approach, price/gate tiers honestly, or catch a regression before a customer does.

The ensemble already emits fine-grained telemetry (`ensemble-phase-completed`, `model-attempt-completed` with tokens, `specialist-fanout-summary`, `synth-summary`, `do-review-run-timing`). What was missing — and what SIG-149 adds — is a single **per-review roll-up** a dashboard can aggregate and an alert can key on without re-joining N per-attempt events at query time.

---

## The signal: `review-slo-summary`

Emitted exactly once per review from `finalize()` in `src/lib/triage-pr-review-ensemble.ts` (the single choke point every exit path funnels through — `posted`, `errored`, `stale_head`, skip-notice). Defined in `src/lib/ensemble-slo-telemetry.ts`.

```jsonc
{
  "event": "review-slo-summary",
  "owner": "Sigilix", "repo": "sigilix", "prNumber": 149, "headSha": "abcdef1",
  "tier": "default",
  "status": "posted",              // ensemble exit status — filter no-ops out of latency percentiles
  "totalMs": 248120,               // ensemble-handler span (startMs → finalize); see latency note below
  "latencyBudgetMs": 300000,       // tier SLO, echoed so the dashboard needs no second lookup
  "latencyOverBudget": false,      // per-review; the ALERT uses the fleet p95, not this field
  "timeToFirstOverviewMs": 248010, // startMs → overview posted; null if no overview this run
  "overviewBudgetMs": 300000,      // tier SLO for time-to-first-overview
  "overviewLatencyOverBudget": false,
  "totalInputTokens": 41200,
  "totalOutputTokens": 8800,
  "costUsd": 0.0412,               // modeled (MODEL_PRICING), NOT billed — see cost note
  "costBudgetUsd": 0.5,
  "costOverBudget": false,         // per-review (cost is additive, not a percentile)
  "sloBreached": false,            // latency || cost || overview over budget — the cheap alert predicate
  "byModelUsd": { "deepseek-v4-pro:cloud": 0.031, "kimi-k2.6:cloud": 0.010 }
}
```

### What `totalMs` measures (and doesn't)

`totalMs` is the **ensemble-handler span**: `telemetry.startMs` (handler entry) → `finalize()`. It includes fan-out + synth + post-validation + submit. It does **not** include webhook→queue-pickup→check-create. For the broader consumer span use `do-review-run-timing.consumerWallMs`; for the full customer-visible push→review-visible budget (≤360s) see [review-latency-budget.md](./review-latency-budget.md). The 300s `latencyBudgetMs` is sized to leave ~60s headroom under that 360s end-to-end target.

### What `timeToFirstOverviewMs` measures (and the caveat)

`startMs` (handler entry) → the moment the inline PR overview/walkthrough is posted (the first customer-visible content). `null` when the run posts no overview (skipped on budget, or an early bail before the overview step) — null is **excluded** from the overview p95, not counted as 0.

**Caveat:** SIG-216 currently posts the overview late — on the critical path, just before submit — so today this value is ~equal to `totalMs`. It only becomes a meaningfully *earlier* signal once the overview moves off the critical path ([review-latency-budget.md](./review-latency-budget.md) "Lever 1"). The budget is set equal to the full-review budget for now; **re-tune (and tighten) from real data**, especially after Lever 1.

### What `costUsd` is (and isn't)

A **modeled estimate**: tokens (summed across every settled attempt — specialist primary + retries + cross-provider fallback + synth + synth retry) × `MODEL_PRICING` in `ensemble-slo-telemetry.ts`. It is **not** a billed figure — self-hosted / Ollama-cloud rates aren't exposed per call. Use it for relative trend + budget-breach signal, not invoicing. Unknown models fall back to `DEFAULT_PRICING` (sized high so a new model over-estimates rather than hiding spend). **Keep `MODEL_PRICING` in sync with `SPECIALIST_CONFIGS` / synth config when models change.**

---

## SLO targets (per tier)

Defined in `SLO_TARGETS` (`src/lib/ensemble-slo-telemetry.ts`). Source of truth — edit there, this table mirrors it.

| Tier | time-to-first-overview (p95) | time-to-full-review (p95) | cost/review (modeled) |
|---|---|---|---|
| `default` | ≤ 300s | ≤ 300s | ≤ $0.50 |

(time-to-first-overview == full-review for now — see the caveat above; tighten after Lever 1.)

**Tiers**: Sigilix has no customer plan-tier concept in code yet (SIG-41). One `default` tier ships today; the table + the `tier` event field are keyed by string so SIG-41 can add `free`/`pro`/… rows without touching the emitter or the dashboard query. Until then every review reports `tier: "default"`.

The cost threshold is a **starting** value — re-tune from the first week of real `review-slo-summary` data.

---

## Dashboard

Both options aggregate the same `review-slo-summary` event.

### Option A — Workers Logs (Logpush → query)

Filter `event = "review-slo-summary"`, then build:

- **Time-to-full-review p50/p95/p99** — percentile of `totalMs`, filtered to `status = "posted"` (exclude `stale_head`/`errored` no-ops so they don't deflate latency). Overlay `latencyBudgetMs` as a threshold line.
- **Time-to-first-overview p50/p95** — percentile of `timeToFirstOverviewMs`, filtered to **non-null** (exclude runs that posted no overview — null ≠ 0). Overlay `overviewBudgetMs`. Expect this to track full-review until Lever 1 ships, then drop.
- **Cost/review p50/p95 + daily sum** — percentile and `sum(costUsd)` bucketed by day. Stacked by `byModelUsd` keys for per-model attribution.
- **SLO breach rate** — `count(sloBreached = true) / count(*)` over the window.
- **Tokens/review** — `totalInputTokens` + `totalOutputTokens` percentiles (cost sanity check).

Group all panels by `tier` so they fan out automatically when SIG-41 lands.

### Option B — Analytics Engine (if/when wired)

If a future change writes these to an Analytics Engine dataset, map: blobs = `owner`, `repo`, `tier`, `status`; doubles = `totalMs`, `costUsd`, `totalInputTokens`, `totalOutputTokens`. Then `quantileWeighted(0.95, totalMs)` grouped by `tier` is the canonical p95 panel.

> The current emitter is `console.log`-only (Workers Logs / `wrangler tail`). Option A works today with zero further code. Option B is a follow-up if log-based percentiles prove too coarse.

---

## Alerting

Two rules, both over the `review-slo-summary` stream.

1. **Latency p95 breach (fleet, not per-review).** Over a rolling 1h window of `status = "posted"` reviews, fire when `p95(totalMs) > latencyBudgetMs` for the tier. Per-review `latencyOverBudget` is **not** the trigger — one slow review is noise; a slow p95 is the SLO. Implement as a scheduled query (Workers Logs saved search / Analytics Engine query on a cron) since CF metric-notifications don't compute percentiles natively.
2. **Overview p95 breach (fleet).** Same shape as rule 1 but on `p95(timeToFirstOverviewMs)` (non-null only) vs `overviewBudgetMs`. Low value until Lever 1 (it mirrors rule 1 today); wire it now so the panel + alert exist when the overview moves earlier.
3. **Cost breach (per-review).** Fire when any review emits `sloBreached = true` with `costOverBudget = true`. Cost is additive, so a single over-budget review is a real signal (a runaway retry loop, a mispriced model). Cheap predicate — a log alert on the boolean.

Page severity: latency/overview p95 = warning (degradation); cost = warning, escalate if sustained > 1h (spend).

---

## Verification

1. Trigger a dogfood review; `wrangler tail` and confirm exactly one `review-slo-summary` per review with non-zero `totalMs` and `costUsd`.
2. Confirm a pre-fan-out bail (`stale_head`) still emits the event with `costUsd: 0`, `sloBreached: false` (no tokens spent, no false breach).
3. Confirm the dashboard percentiles populate and the `latencyBudgetMs` threshold line renders.
4. Force a breach in staging (lower `timeToFullReviewMs` temporarily) and confirm the alert fires.

Unit coverage for the cost/SLO math + event shape: `tests/ensemble-slo-telemetry.test.ts`.
