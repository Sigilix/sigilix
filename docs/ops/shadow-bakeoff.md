# Shadow-Mode Model Bake-Off (ARC-283 Phase B1b)

Operator reference for the shadow harness that lets us evaluate
candidate model lineups (per ARC-292) on real PR traffic without
exposing customers to the candidate.

## What it does

For each role in `SHADOW_BAKEOFF_ROLES` (CSV of `logic`/`security`/
`performance`/`tests`/`synth`), the orchestrator fires a parallel
`runWithRetryAndFallback` call against the CANDIDATE lineup defined
in `src/lib/shadow-bakeoff-config.ts:SHADOW_BAKEOFF_LINEUP`. The
shadow verdict is logged, never posted. Production behavior is
unaffected.

## Enabling shadow

`SHADOW_BAKEOFF_ROLES` is declared with an empty default in the
`[vars]` block of `wrangler.toml`. To enable shadow:

- **Local dev / preview deploys** — edit `[vars]` in `wrangler.toml`:
  ```toml
  [vars]
  SHADOW_BAKEOFF_ROLES = "synth"
  ```
  Commits the value into source — fine for non-prod environments.

- **Production** — use `wrangler secret put SHADOW_BAKEOFF_ROLES` (or
  the Cloudflare dashboard under Workers & Pages → sigilix → Settings
  → Variables → Add encrypted variable). Secrets override the `[vars]`
  default per-environment, so prod can flip shadow on without a code
  change.

Empty string / unset = shadow off everywhere (default).

Recommended rollout order (per Codex ARC-292):
1. `synth`            — highest customer impact (PR #97 demo).
2. `security,tests`   — coder-model candidates; high false-positive risk.
3. `performance`      — fallback swap only; primary already defended by ARC-167.
4. `logic`            — fallback swap only.

## Events emitted

### `shadow-model-attempt-completed`
One per LLM attempt in the shadow runner. Same shape as
`model-attempt-completed` (prod) so log analyzers can join on
`(role, attemptKind, attemptIndex)`.

Fields: `role`, `attemptKind` (primary/retry/fallback),
`attemptIndex`, `model`, `timeoutMs`, `startedAtMs`, `endedAtMs`,
`elapsedMs`, `outcome` (ok/failed/aborted/timeout), `failureReason`
(when outcome ≠ ok).

### `shadow-verdict-comparison`
One per role with shadow enabled, emitted after BOTH prod + shadow
settle. Carries the post-hoc diff.

Fields: `role`, `prodModel`, `shadowModel`, `prodVerdictOk`,
`shadowVerdictOk`, `prodElapsedMs`, `shadowElapsedMs`,
`prodAttemptsUsed`, `shadowAttemptsUsed`, `prodFindingsCount`,
`shadowFindingsCount`, `overlapCount`, `prodOnlyCount`,
`shadowOnlyCount`, `prodScoreHistogram`, `shadowScoreHistogram`,
`score4PlusOverlapCount`, `score4PlusProdOnlyCount`,
`score4PlusShadowOnlyCount`, `score4PlusProdFindingsCount`,
`score4PlusShadowFindingsCount`, `shadowFailureReason`.

Findings overlap matches on `(path, line, category)` tuple — same
line different category is NOT a match.

The `score4Plus*` fields (SIG-86) are derived counts on the score-4+
filtered subset of findings — the aggregator computes the canonical
overlap-with-prod ratio as
`score4PlusOverlapCount / (score4PlusOverlapCount + score4PlusProdOnlyCount)`
because score histograms alone lose the tuple identity needed to
filter-then-overlap. Older events emitted before SIG-86 omit these
fields; the aggregator surfaces them as `inconclusive`.

### `shadow-cut-short`
Emitted when a shadow promise didn't settle within
`SHADOW_FINALIZE_GRACE_MS` (5s) of prod returning, OR when the outer
orchestrator aborted before the shadow could settle. Caps the
worst-case consumer-wall extension so a pathologically slow shadow
can't push the worker past the 900s CF Queues ceiling. The shadow's
`shadow-verdict-comparison` event does NOT emit for this role.

In addition to logging, the orchestrator now `.abort()`s the per-shadow
`AbortController` on every cut, so the in-flight provider request
actually stops (pre-CR-2, the request kept consuming rate-limit + wall-
clock capacity past the cut).

Fields: `role` (specialist role or `"synth"`), `elapsedAtCutMs`,
`reason` (`"grace_deadline"` or `"orch_aborted"`).

### `shadow-run-failed`
Emitted when the shadow runner promise itself rejects (the runner
threw outside its own try/catch). The shadow runners catch every
internal failure into a structured `{verdictOk:false, ...}` result,
so this event indicates either a programming bug or a host-environment
failure (memory limit, runtime tear-down). Distinct from
`shadow-cut-short` so dashboards can distinguish a runner crash from
a benign time-expiry — pre-CR-1 both paths emitted `shadow-cut-short`
and hid real failure signal in the cut-short bucket.

The per-shadow `AbortController` is `.abort("run_failed")`'d
defensively (the runner's own `.finally()` should have cleared it
already since the promise settled).

Fields: `role` (specialist role or `"synth"`), `message`.

### `shadow-specialist-emit-error` / `shadow-synth-emit-error`
Defensive: emitted only when the shadow comparison emit itself
throws (shadow runners catch internally, so these should be rare).
Customer-visible prod review is unaffected — these are pure
telemetry diagnostics.

Fields: `role` (specialist only), `message`.

## Decision criteria

Codex's acceptance bar (per ARC-292):

| Metric                          | Bar                              |
|---------------------------------|----------------------------------|
| shadow valid-verdict rate       | ≥ prod baseline                  |
| shadow p95 elapsed              | ≤ 60s per-attempt cap            |
| shadow timeout / 503 / 429 rate | ≤ prod                           |
| findings overlap with prod      | ≥ 50% on score-4+ findings       |
| net unique useful findings      | ≥ 0 (founder-eyeballed sample)   |

If all five hold over ≥ 100 PR reviews, escalate to canary (Sigilix
internal repos + one low-risk customer). If shadow synth fails the
JSON/provenance bar OR shows timeout-rate regression, revert
`SHADOW_BAKEOFF_ROLES`.

## What shadow does NOT do

- Does NOT post verdicts. Ever.
- Does NOT mutate KV / Queue / DO state.
- Does NOT replace the prod model on its own — that's a separate PR
  after shadow data signs off.
- Does NOT fine-tune. ARC-292 explicitly defers fine-tuning until
  20-50 customers or 1000 labeled outcomes.

## Provider-overlap cost

When `SHADOW_BAKEOFF_ROLES` enables a role whose candidate lineup shares a provider with the prod lineup (e.g., shadow logic primary `deepseek-v4-pro:cloud` matches prod's `deepseek-v4-pro:cloud`), the role doubles that provider's rate-limit pressure on every review. This is the explicit bake-off cost — there is no way to evaluate "keep this primary" without paying the call.

Roles where shadow and prod share at least one model (as of the lineup at `SHADOW_BAKEOFF_LINEUP`):

| Role         | Overlap                                                    |
|--------------|------------------------------------------------------------|
| logic        | primary `deepseek-v4-pro:cloud` (same as prod)             |
| performance  | primary `glm-5.1:cloud` (same as prod)                     |
| security     | candidate primary = prod fallback (`qwen3-coder-next`)     |
| tests        | candidate primary = prod fallback (`qwen3-coder-next`)     |
| synth        | candidate primary = prod fallback (`deepseek-v4-flash`)    |

If you observe new rate-limit 429s on a candidate's provider after enabling shadow, disable the role until the candidate provider's capacity has been confirmed for the doubled load.

## Safety net

Shadow code paths are wrapped in defensive try/catch so a shadow
crash CANNOT take down the prod return. If you see
`shadow-synth-emit-error` events, file the failure but assume prod
is fine — the customer review still posted.

## Running the decision-report aggregator (SIG-86 / Phase B1c)

The aggregator at `src/lib/bakeoff-report.ts` consumes the events
documented above and produces a per-metric verdict in
`pass | fail | inconclusive | inconclusive_pending_manual_review`
against the bars in the table above. The
`inconclusive_pending_manual_review` tier is reserved for
`netUniqueUsefulFindings` in v1 (founder-eyeballed metric). The
operator CLI wraps the aggregator for on-demand runs.

### Inputs

The aggregator reads Logpush NDJSON (one event per line — the
standard CF Logs export shape). For the v1 MVP, the operator
materializes the log files locally:

```sh
# One-time setup: configure CF Logpush to write to R2 hourly.
# See https://developers.cloudflare.com/logs/logpush/ for the binding.

# Per-run: pull recent objects to a local dir.
wrangler r2 object get <bucket>/<key> --file events.ndjson
```

A future PR will land an `--r2` flag that streams directly from the
bucket; until then, the operator-pull flow above is the contract.

### Running the report

```sh
npm run bakeoff-report -- \
  --input ./events.ndjson \
  --since 2026-04-19T00:00:00Z \
  --until 2026-05-19T00:00:00Z
```

Defaults:
- `--since` → 30 days before `--until`
- `--until` → now (UTC)
- `--out`   → `docs/bakeoff-reports/`

The CLI writes `docs/bakeoff-reports/bakeoff-report-<YYYY-MM-DD>.json`
+ `.md`. Exit code is non-zero if any role's overall verdict is
`fail` — so a cron caller can wire pager alerts to the exit code
without parsing JSON.

Pass `--print-only` to skip file writes and dump both artifacts to
stdout (useful for piping into another tool or for one-off inspection).

### Decision report shape

The full schema lives at `docs/ops/bakeoff-report-schema.md`. The
canonical artifact is the JSON; the Markdown is a human-friendly
summary that surfaces the verdict badges + per-metric reasons.

### When to call it `pass`

The aggregator emits one of four role-level verdicts:

- `fail` — any metric failed. The CLI exits 1; pager-worthy.
- `inconclusive` — sample size too low OR a metric's CI genuinely
  straddles the bar. Collect more data.
- `pass_pending_manual_review` — every machine-verifiable metric
  passed; the manual `netUniqueUsefulFindings` is still
  `inconclusive_pending_manual_review`. The bake-off is green on the
  bars the aggregator can compute — the operator inspects the
  shadow-only score-4+ samples and ratifies.
- `pass` — every metric passed including the manual-review one. Only
  reachable once the founder-label pipeline is wired (post-v1).

The CLI exits 1 only on `fail`. `pass_pending_manual_review` and
`inconclusive` exit 0 — the operator reads the Markdown summary for
context.
