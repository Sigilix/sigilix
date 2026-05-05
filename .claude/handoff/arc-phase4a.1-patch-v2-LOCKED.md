# Phase 4a.1 patch — v2 LOCKED

**Status:** LOCKED 2026-05-05. Both reviewers conditionally signed off:
- **Codex:** "ship with 3 changes" (synth timeout handling, math, tests)
- **Kimi K2.6:** "ship with 1 tweak" (raise outer timeout to ≥390s)

This v2 integrates both reviewers' catches. v1 lives at `arc-phase4a.1-patch-v1.md` for audit.

**Trigger:** 14/15 production shadow records were unhealthy (1 fully-healthy ensemble verdict in the corpus, 7 lost quorum, 4 internal_error at 200s, 3 partial). Three concrete root causes identified (`./_report.md`).

---

## Patch summary

In `src/lib/triage-pr-review-ensemble.ts`:

| Change | Before | After | Why |
|---|---|---|---|
| `SPECIALIST_TIMEOUT_MS` | 90s | **180s** | Median successful logic latency = 78s; one primary attempt + one retry on transient 503 needs ~80+0.8+80 ≈ 161s. 180s leaves 19s slack. |
| `SYNTHESIZER_TIMEOUT_MS` | 120s | **180s** | Real synth latency on 4× 8K-token verdict input observed at 30-100s; 180s gives p99 headroom for cross-specialist disagreement cases. |
| `ORCHESTRATOR_TIMEOUT_MS` | 240s | **400s** | 180+180+40s headroom for pre-flight + diff parse + stale-head guards + telemetry write. Cloudflare queue ceiling is 900s. |
| `SPECIALIST_CONFIGS.logic.retries` | 2 | **1** | Two retries × 78s = 234s of primary attempts, exceeds new specialist budget. One retry + cross-provider fallback gives better resilience per unit time. |
| `SPECIALIST_CONFIGS.performance.primary` | `minimax-m2.1:cloud` | **`glm-5.1:cloud`** | Won 6/12 fallback runs; minimax primary unreliable. |
| `SPECIALIST_CONFIGS.performance.fallback` | `glm-5.1:cloud` | **`kimi-k2.5:cloud`** | Cross-provider; two-provider coverage retained. |
| **NEW** `RETRIEVAL_PREFLIGHT_TIMEOUT_MS` | (uncapped) | **15_000** | Bound retrieval variance so the synth budget is not eaten by a slow Vectorize fetch (Kimi catch). |

Plus one structural code change:

**Local synth timeout handling.** Today, `await withComposedTimeout(runSynthesizer, ...)` rejects on synth-specific timeout and bubbles to the orchestrator's outer catch, surfacing as `internalError: "Operation aborted"` with `synthesizer: null` in telemetry. v2 wraps the synth call in a try/catch that:
- Distinguishes synth-local AbortError from outer-orch abort (compare `error.cause` or `signal === orchCtrl.signal`)
- Writes `telemetry.synthesizer = { timedOut: true, model, modelUsed, attemptsUsed, elapsedMs, verdict: null }` on synth-only timeout
- Lets outer-orch aborts continue to bubble (those are still genuine internal errors)

This makes the spec's promised telemetry shape (`synthesizer.timedOut: true`) reachable. Codex's blocking catch.

---

## Tests (must land in same PR)

1. **Synth budget exceeded → record completes with `synthesizer.timedOut: true`** and verdict `null`. Top-level `internalError` is null. Replaces the current behavior where synth timeout produces `internalError: "Operation aborted"`.
2. **Logic primary takes 130s** (within new 180s window) → succeeds with `attemptsUsed: 1`, no retry triggered, no fallback fired.
3. **Static budget invariant.** Add a compile-time-ish runtime assertion or test:
   `SPECIALIST_TIMEOUT_MS + SYNTHESIZER_TIMEOUT_MS + 40_000 (RESERVED_HEADROOM_MS) ≤ ORCHESTRATOR_TIMEOUT_MS`.
4. **Pre-flight retrieval timeout.** Mock `retrieveChunks` taking 30s → orchestrator gives up after 15s, sets `retrievalCacheStats.preflightFailed: true` + `retrievalCacheStats.preflightTimedOut: true`, continues with empty snapshot per v3.1 §8.
5. **Kimi-k2.5 performance fallback schema parsing.** Mock kimi-k2.5 emitting a valid `PR_REVIEW_SCHEMA` JSON for the perf specialist; assert `runSpecialist({role:"performance"})` returns a non-null verdict with `modelUsed === "kimi-k2.5:cloud"`.
6. **Derived `MAX_CALLS_PER_ENSEMBLE_RUN` admission.** With logic retries dropped from 2 to 1, the upper bound is now 16 calls (was 17): 4 primary + 4 retries (1 logic + 1 each) + 4 fallbacks + 1 synth + 1 synth fallback + 1 pre-flight + 1 reserve. Update or add a test that asserts the daily budget admission can run 16 attempts and bails at 17.

---

## Risk register (updated)

| Risk | Mitigation | New / existing |
|---|---|---|
| Higher worst-case wall-clock per ensemble (240s → 400s) | Shadow mode only — Phase 3 posts customer-facing review. Validated post-deploy on next ≥5 shadow records. | existing |
| Logic retries dropped → fewer chances on transient 503 | Cross-provider `kimi-k2.5:cloud` fallback active; net resilience preserved. | existing |
| `glm-5.1:cloud` becomes new perf SPOF | Fallback to `kimi-k2.5:cloud` (Moonshot vs Z.ai). | existing |
| **Kimi-k2.5 fallback concentration** — logic AND performance both fall back to Moonshot. | Acceptable; noted. If Moonshot has a regional outage, two specialists degrade simultaneously. Long-term we may rotate logic's fallback to a third provider. | **new** (Kimi catch) |
| **glm-5.1 verdicts may be shallower than minimax-m2.1's** — promotion validates *reliability*, not comparative *quality*. | Spot-check next ≥6 perf verdicts; if findings volume drops materially, demote glm-5.1 back to fallback and try a different primary (`minimax-m2.2` or `glm-5.5` when available). | **new** (Kimi catch) |
| Cost ↑ from longer ensembles | Daily budget cap (`OPENCLAW_ENSEMBLE_DAILY_BUDGET = 200`) unchanged. Per-PR cost depends on actual model pricing — flagged for ops review at month-end. | existing |
| Pre-flight retrieval failure path now gates on a 15s timer | Retrieval-cache spec (v3.1 §8) already permits empty pre-flight snapshot; specialists can still call `retrieve_codebase` themselves. New telemetry field tracks `preflightTimedOut` distinct from generic `preflightFailed`. | new |

---

## Implementation sequencing

1. **Worktree:** `.claude/worktrees/phase4a.1-patch`
2. **Branch:** `fix/phase4a.1-timeouts-and-perf-primary`
3. **Files modified:**
   - `src/lib/triage-pr-review-ensemble.ts` — constants, perf model lineup, logic retries, synth try/catch, pre-flight timeout
   - `tests/triage-pr-review-ensemble.test.ts` — new tests #1-#6
   - `tests/run-with-retry-and-fallback.test.ts` — bump model name in comment if needed
4. **Telemetry schema:** unchanged (still v3); new optional fields `retrievalCacheStats.preflightTimedOut` and `synthesizer.timedOut` are pre-existing in the schema (the latter just wasn't being populated).
5. **Mode flip:** none. Phase 4 stays in shadow mode (`OPENCLAW_ENSEMBLE_REVIEW_MODE=shadow`). Post-merge, monitor next ≥10 shadow records and verify the corpus health flips from 1/15 → ≥7/10.
6. **Code review:** CodeRabbit + manual.

---

## Sign-off ledger

| Reviewer | Round | Verdict | Catches → integrated in v2 |
|---|---|---|---|
| Codex | r1 | ship with 3 changes | (1) local synth timeout handling, (2) specialist timeout 150→180s, (3) tests for k2.5 fallback + max-calls admission |
| Kimi K2.6 | r1 | ship with 1 tweak | (4) outer timeout ≥390s; integrated as 400s with 40s headroom |

Both r1 verdicts are conditional-ship. v2 integrates all catches faithfully; no second round needed unless implementation diverges.
