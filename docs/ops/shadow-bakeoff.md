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

Set the env var in `wrangler.toml` (or via `wrangler secret`):
```toml
SHADOW_BAKEOFF_ROLES = "synth"
```
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
