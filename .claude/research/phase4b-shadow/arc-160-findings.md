# ARC-160 — Re-pull shadow telemetry post Phase 4a.1

**Date pulled:** 2026-05-05 ~22:40 UTC (≈4 hours after Phase 4a.1 deploy at 18:24:58 UTC, ≈3.5 hours after Phase 5 auth deploy at 19:13:17 UTC)

## Acceptance criteria — status

From the resume doc: ≥10 fresh records, ≥70% fully healthy, 0 records with `internalError: "Operation aborted"`.

| Criterion | Target | Actual | Verdict |
|---|---|---|---|
| Fresh records (post-deploy) | ≥10 | **2** real ensemble runs (3 stale_head fallbacks excluded, 1 pre-deploy excluded) | **NOT MET — insufficient traffic** |
| Fully healthy (4/4 + synth) | ≥70% | **0/2** (0%) | NOT MET |
| `internalError: "Operation aborted"` records | 0 | **0** at the orchestrator level | MET |

**Not enough PR traffic has accumulated yet.** Only PR #42 (Phase 4a.1) and PR #43 (Phase 5 auth) merged after the deploy, producing 2 real ensemble runs total. ARC-160 should re-poll after more PRs land, or after running synthetic triage against an open PR.

## What Phase 4a.1 fixed

Comparing pre-deploy (15 records on PRs 36-41) vs post-deploy (2 real runs on PRs 42-43):

| Symptom | Pre-deploy | Post-deploy | Change |
|---|---|---|---|
| Mass "Operation aborted" (4/4 specialists abort at elapsedMs=0) | 2/15 (13%) — PRs 38 4fe47e4, 41f8708 | 0/2 | **fixed** |
| totalMs clamped at ~91s (old 90s cap leaking through) | 6/15 | 0/2 | **fixed** |
| Synthesizer reaches success | unknown (pre-deploy summarizer schema didn't surface this cleanly) | 2/2 | **healthy** |
| Wall-clock under 400s | n/a (lower budget) | 2/2 (302s, 316s) | **healthy** |
| Logic specialist (`deepseek-v4-pro:cloud`) succeeds | 5/15 (33%) | **0/2 (0%)** | **regressed** |

So Phase 4a.1 did its job on the orchestrator-level cascade failure: the synth, performance, and tests specialists now reliably complete, the static budget invariant fires at module load, and fallback `glm-5.1:cloud` works on the perf role. **But the deepseek-v4-pro logic specialist is consistently aborting at elapsedMs=0 in both post-deploy runs**, which Phase 4a.1 did not address.

## New failure pattern — logic specialist abort

Both real post-deploy runs share an identical failure fingerprint on the logic role:

```
role:           "logic"
model:          "deepseek-v4-pro:cloud"
modelUsed:      null              ← never reached the request stage
attemptsUsed:   null              ← attempt loop never logged a first attempt
elapsedMs:      0                 ← aborted before any time elapsed
timedOut:       true
failureReason:  "Operation aborted"
```

`attemptsUsed: null` and `modelUsed: null` together mean the call was aborted before the per-attempt instrumentation could record anything — the `AbortSignal` fired before `runOneAttempt` (or whatever the inner call function is named) had a chance to run.

Run 2 (PR #43, sha dccf3e4) shows the same pattern on **security** as well:
- security: `model=deepseek-v4-flash:cloud`, `elapsedMs=0`, `attemptsUsed=null`, aborted

Run 1 (PR #42, sha 13a74b4) had security succeed (`elapsedMs=35230, attemptsUsed=1`).

Hypotheses to investigate:

1. **Concurrency / rate-limit at deepseek-v4 family.** Both v4-pro and v4-flash hit the same provider; if the provider rate-limits new connections from the Worker IP, the second/third concurrent connection request might get an immediate connection-level abort. Tests (also v4-flash) succeeded in both runs, so it's not a flat per-model cap — but the abort lands on whichever role's fanout fires later, suggestive of a connect-time race.
2. **`waitUntil` / signal racing in the new pre-flight retrieval gate.** Phase 4a.1 added `RETRIEVAL_PREFLIGHT_TIMEOUT_MS=15s`. If the AbortSignal from preflight is being composed into the specialist signal incorrectly (or fires before the specialist begins), it'd produce exactly this `elapsedMs=0` + `attemptsUsed=null` fingerprint.
3. **`deepseek-v4-pro:cloud` provider issue.** Logic happens to be the only role assigned `v4-pro`; a model-specific provider problem would consistently knock out logic. Worth checking the OpenClaw / provider gateway logs for v4-pro at the run timestamps (18:26:04 and 19:14:40 UTC).

`logic.retries` was also reduced from 2→1 in Phase 4a.1. If the abort is triggered by an internal AbortSignal, retries can't help — but the previous `retries=2` may have been masking an intermittent provider issue that's now fully exposed.

## Recommended next steps

Hold ARC-161 (router activation) and ARC-162 (Devstral A/B) — both depend on ARC-160 acceptance, which is not met.

1. **Wait for more traffic** (or trigger synthetic ensemble runs) and re-poll. Need ≥10 real post-deploy records before drawing conclusions.
2. **Investigate the elapsedMs=0 abort fingerprint.** Look at `specialist call` site in `src/lib/triage-pr-review-ensemble.ts`:
   - Where are `attemptsUsed` and `modelUsed` initialized?
   - What composes the AbortSignal feeding the specialist call?
   - Does `RETRIEVAL_PREFLIGHT_TIMEOUT_MS` propagate into the specialist signal?
3. **Add structured logging when failureReason is `Operation aborted` and elapsedMs=0**, capturing which AbortSignal fired (preflight, orchestrator, headroom, parent fetch).
4. **Spot-check the OpenClaw / Workers AI gateway logs** for `deepseek-v4-pro:cloud` calls at 2026-05-05 18:26:04 UTC and 19:14:40 UTC to confirm whether the request reached the provider at all.

## Per-record post-deploy detail

```
2026-05-05 18:25:32 PR42 81c52c5  fellBack=stale_head_before_fanout  totalMs=478ms       ← orchestration race, ignore
2026-05-05 18:25:51 PR42 17de38f  fellBack=stale_head_before_fanout  totalMs=~1s         ← orchestration race, ignore
2026-05-05 18:26:04 PR42 13a74b4  3/4 quorum, synth ok, 6 findings, totalMs=302s
                                  logic    aborted (elapsedMs=0, attemptsUsed=null)
                                  security ok    (35.2s)
                                  perf     ok    (108.9s, glm-5.1:cloud)
                                  tests    ok    (128.0s, deepseek-v4-flash:cloud)
                                  synth    ok    (134.8s, kimi-k2.6:cloud)
2026-05-05 19:14:20 PR43 49488d3  fellBack=stale_head_before_fanout  totalMs=478ms       ← orchestration race, ignore
2026-05-05 19:14:40 PR43 dccf3e4  2/4 quorum, synth ok, 8 findings, totalMs=316s
                                  logic    aborted (elapsedMs=0, attemptsUsed=null)
                                  security aborted (elapsedMs=0, attemptsUsed=null)
                                  perf     ok    (121.2s, glm-5.1:cloud)
                                  tests    ok    (149.6s, deepseek-v4-flash:cloud)
                                  synth    ok    (134.8s, kimi-k2.6:cloud)
```

## Files

- `_report.md` — auto-generated summarizer output (current run, 6 records)
- `_summary.json` — structured form
- `raw/` — 6 fresh post-deploy candidate records
- `raw/pre-deploy/` — 15 archived stale records from PRs 36-41
- `keys.txt` — original key list (pre-deploy snapshot)
