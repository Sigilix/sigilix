# Phase 4a.1 patch — diagnosis + proposed fix

**Status:** v1 draft — needs dual sign-off (Codex + Kimi K2.6) before implementation.

**Trigger:** review of 15 paired shadow telemetry records pulled from production KV on 2026-05-05. Raw data + analysis at `.claude/research/phase4b-shadow/`.

---

## Headline finding

**Phase 4 ensemble is non-functional in production:** 1/15 records produced a fully healthy ensemble verdict. The remaining 14 either lost quorum or had the synthesizer cut off by the orchestrator's outer timeout. Phase 4b cannot land on top of an unhealthy Phase 4a.

The mechanics are sound — the one healthy record (sigilix#41 SHA `2b2fb56`) ran cleanly: logic 35s, security 65s, perf 17s, tests 16s, synth 30s, total 96s, with the synthesizer producing one well-grounded finding. The shape of the platform is right. The settings are wrong.

---

## Three concrete bugs

### Bug 1 — `deepseek-v4-pro:cloud` (logic) is too slow for the 90s specialist budget

| Metric | Value |
|---|---|
| Successful logic runs | 2/15 (13%) |
| Successful latency (median / max) | 78s / 78s |
| Failure mode (12/15) | `Operation aborted` (specialist timeout) |
| Retries configured | 2 → 3 total attempts on primary |

The 78s median is *one* successful attempt. With `retries: 2` and primary-attempt latency this close to the wall, almost every retry path overshoots `SPECIALIST_TIMEOUT_MS = 90_000`. Logic is the most-blocking specialist (per-spec, "logic cannot fail"), but its current configuration guarantees it fails.

### Bug 2 — `kimi-k2.6:cloud` (synthesizer) is squeezed when specialists run long

| Metric | Value |
|---|---|
| Records where ≥2 specialists succeeded but synth never reached `verdict !== null` | 4/15 |
| Their `totalMs` | 199s, 211s, 211s, 211s |
| Their `internalError` | `Operation aborted` |

Specialists run in parallel up to `SPECIALIST_TIMEOUT_MS = 90s`. If the slowest takes the full 90s, synth starts at t=90s with `SYNTHESIZER_TIMEOUT_MS = 120s` of its own — but the *outer* `ORCHESTRATOR_TIMEOUT_MS = 240s` deadline fires at t=240s, leaving synth only 150s of effective budget. With four 8K-token specialist verdicts to read + diff + retrieval cache, kimi-k2.6 routinely needs more.

### Bug 3 — `minimax-m2.1:cloud` (performance primary) is unreliable

| Metric | Value |
|---|---|
| Successful perf runs | 12/15 (80%) |
| Of those, how many came from the `glm-5.1` fallback | 6/12 (50%) |

The fallback (`glm-5.1:cloud`) is winning half the time. We pay for two model calls each PR. Promote `glm-5.1` to primary; keep `minimax-m2.1` as fallback OR swap fallback to `kimi-k2.5:cloud` for cross-provider resilience.

### Bonus — pre-fix records pollute the data

4/15 records show `qwen3-coder:30b:cloud not found` errors on security/tests. PR #37 fixed this lineup; those records are pre-fix. They're noise; we ignore them in conclusions but flag them so reviewers aren't confused by the failure-reason histogram.

---

## Proposed patch (v1)

In `src/lib/triage-pr-review-ensemble.ts`:

| Constant | Current | Proposed | Rationale |
|---|---|---|---|
| `SPECIALIST_TIMEOUT_MS` | 90_000 | **150_000** | Cover one successful primary call (≤80s) + one retry on transient 503 (~80s) inside a single budget. With logic retries dropped to 1, this gives ~70s of slack. |
| `SYNTHESIZER_TIMEOUT_MS` | 120_000 | **180_000** | Real synth latency on 4× 8K-token verdict input has been observed at ~30-100s; 180s gives p99 headroom. |
| `ORCHESTRATOR_TIMEOUT_MS` | 240_000 | **360_000** | Specialists (≤150s parallel) + synth (≤180s) + pre-flight + GH calls + telemetry write. Cloudflare queue consumers allow up to 900s per batch, so 360s is well within bounds. |
| `SPECIALIST_CONFIGS.logic.retries` | 2 | **1** | Two retries is 3× latency on a model that already runs at 80s. With 150s timeout + cross-provider fallback, we'd rather burn the retry slot on the fallback than on a third primary attempt that's likely to exceed the new timeout. |
| `SPECIALIST_CONFIGS.performance.primary` | `minimax-m2.1:cloud` | **`glm-5.1:cloud`** | Already wins 50% of perf runs as fallback. Promote. |
| `SPECIALIST_CONFIGS.performance.fallback` | `glm-5.1:cloud` | **`kimi-k2.5:cloud`** | Cross-provider; same family as logic's fallback so we know it's reachable. |

No code structure changes. No new files. No new env vars. No telemetry schema bump.

---

## Tests to add / update

- `tests/triage-pr-review-ensemble.test.ts` — bump expected timeout boundaries in any test that asserts 90/120/240. Confirm the orchestrator still aborts cleanly when each individual budget is exceeded.
- New test: synth budget exceeded → record completes with `synthesizer.timedOut: true` and `synthesizer.verdict: null`, NOT a top-level `internalError: "Operation aborted"`.
- New test: logic primary takes 130s (within new 150s window) succeeds end-to-end with `attemptsUsed: 1`, no retry triggered.
- Static assertion: `SPECIALIST_TIMEOUT_MS + SYNTHESIZER_TIMEOUT_MS + 30s headroom ≤ ORCHESTRATOR_TIMEOUT_MS`.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Higher worst-case latency per ensemble (was 240s, now 360s) | Shadow mode only; Phase 3 is what posts to GitHub, so customer experience unchanged. Validated post-deploy on the next 5+ shadow records. |
| Retries dropped on logic → fewer chances to recover from 503 | Cross-provider fallback (`kimi-k2.5:cloud`) covers DeepSeek-side outages. Net resilience improved. |
| `glm-5.1:cloud` becomes new SPOF for perf | Fallback to `kimi-k2.5:cloud` is on different infra (Moonshot vs Z.ai). Two-provider coverage retained. |
| Cost ↑ | Orthogonal — daily budget cap (`OPENCLAW_ENSEMBLE_DAILY_BUDGET = 200`) is unchanged. |

---

## Sign-off requested

Two reviewers, per per-task dual-sign-off workflow:
- Codex (algorithm + correctness)
- Kimi K2.6 (design coherence with v3.1 LOCKED)

Lock criterion: both reviewers explicitly say "ship" with no major catches.

Implementation worktree: `.claude/worktrees/phase4a.1-patch`. Single commit, single PR. Branch name `fix/phase4a.1-timeouts-and-perf-primary`.
