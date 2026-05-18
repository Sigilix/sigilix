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
`shadowFailureReason`.

Findings overlap matches on `(path, line, category)` tuple — same
line different category is NOT a match.

### `shadow-cut-short`
Emitted when a shadow promise didn't settle within
`SHADOW_FINALIZE_GRACE_MS` (5s) of prod returning. Caps the worst-case
consumer-wall extension so a pathologically slow shadow can't push
the worker past the 900s CF Queues ceiling. The shadow's
`shadow-verdict-comparison` event does NOT emit for this role.

Fields: `role` (specialist role or `"synth"`), `elapsedAtCutMs`,
`reason` (`"grace_deadline"` or `"orch_aborted"`).

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

## Safety net

Shadow code paths are wrapped in defensive try/catch so a shadow
crash CANNOT take down the prod return. If you see
`shadow-synth-emit-error` events, file the failure but assume prod
is fine — the customer review still posted.
