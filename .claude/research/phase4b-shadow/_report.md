# Phase 4b shadow data — corrected summary

**Total records:** 6
**Fully healthy (4/4 specialists + synth ok):** 0 / 6
**Partially healthy (≥2 specialists ok but synth failed):** 0 / 6
**Quorum lost (<2 specialists succeeded):** 4 / 6
**Fell back to Phase 3:** 3 / 6

## Mechanical health

- Wall-clock: median **91.3s** · p95 **315.8s** · max **315.8s**
- Synthesizer: ran on **2/6** · succeeded on **2/2**
- Fell-back reasons: `stale_head_before_fanout` × 3, `specialists_failed` × 1

## Per-specialist

| Role | Runs | Success rate | Fell to fallback | Median latency | p95 latency | Mean findings | Top failure reasons |
|------|------|--------------|------------------|----------------|-------------|---------------|----------------------|
| logic | 3 | 0% | 0 | — | — | — | Operation aborted×3 |
| security | 3 | 33% | 0 | 35.2s | 35.2s | 0 | Operation aborted×2 |
| performance | 3 | 100% | 0 | 108.9s | 121.2s | 1.67 | — |
| tests | 3 | 67% | 0 | 149.6s | 149.6s | 5 | Operation aborted×1 |

## Per-record (chronological)

| Time (UTC) | PR | SHA | Quorum | Synth | Findings | Total | FellBack | Logic | Security | Perf | Tests |
|------------|----|-----|--------|-------|----------|-------|----------|-------|----------|------|-------|
| 17:53:16 | sigilix#42 | 92576bd | 1/4 | — | — | 91s | specialists_failed | Operation aborted | Operation aborted | 50s | Operation aborted |
| 18:25:32 | sigilix#42 | 81c52c5 | 0/4 | — | — | 0s | stale_head_before_fanout | — | — | — | — |
| 18:25:51 | sigilix#42 | 17de38f | 0/4 | — | — | 1s | stale_head_before_fanout | — | — | — | — |
| 18:26:04 | sigilix#42 | 13a74b4 | 3/4 | ok | 6 | 302s | — | Operation aborted | 35s | 109s | 128s |
| 19:14:20 | sigilix#43 | 49488d3 | 0/4 | — | — | 0s | stale_head_before_fanout | — | — | — | — |
| 19:14:40 | sigilix#43 | dccf3e4 | 2/4 | ok | 8 | 316s | — | Operation aborted | Operation aborted | 121s | 150s |
