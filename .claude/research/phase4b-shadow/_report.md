# Phase 4b shadow data — corrected summary

**Total records:** 15
**Fully healthy (4/4 specialists + synth ok):** 1 / 15
**Partially healthy (≥2 specialists ok but synth failed):** 4 / 15
**Quorum lost (<2 specialists succeeded):** 7 / 15
**Fell back to Phase 3:** 0 / 15

## Mechanical health

- Wall-clock: median **95.7s** · p95 **211.1s** · max **211.1s**
- Synthesizer: ran on **4/15** · succeeded on **4/4**
- Fell-back reasons: `internal_error` × 4, `specialists_failed` × 7

## Per-specialist

| Role | Runs | Success rate | Fell to fallback | Median latency | p95 latency | Mean findings | Top failure reasons |
|------|------|--------------|------------------|----------------|-------------|---------------|----------------------|
| logic | 15 | 13% | 0 | 78.4s | 78.4s | 1 | Operation aborted×12, Ollama HTTP 503: {"error":"Server overloaded, please retry shortly (ref: 63be6f24-0203-4cd8-8e28-7337f117dfd1)"}
×1 |
| security | 15 | 53% | 1 | 53.4s | 65.0s | 0.25 | Ollama HTTP 404: {"error": "model 'qwen3-coder:30b:cloud' not found"}
×4, Operation aborted×3 |
| performance | 15 | 80% | 6 | 21.0s | 85.8s | 0.92 | Operation aborted×3 |
| tests | 15 | 27% | 0 | 49.6s | 67.1s | 1.25 | Operation aborted×7, Ollama HTTP 404: {"error": "model 'qwen3-coder:30b:cloud' not found"}
×4 |

## Per-record (chronological)

| Time (UTC) | PR | SHA | Quorum | Synth | Findings | Total | FellBack | Logic | Security | Perf | Tests |
|------------|----|-----|--------|-------|----------|-------|----------|-------|----------|------|-------|
| 18:48:30 | openclaw-worker#36 | c7a56b2 | 1/4 | — | — | 19s | specialists_failed | Ollama HTTP 503: { | Ollama HTTP 404: { | 17s | Ollama HTTP 404: { |
| 18:58:35 | openclaw-worker#36 | a228c23 | 1/4 | — | — | 91s | specialists_failed | Operation aborted | Ollama HTTP 404: { | 16s | Ollama HTTP 404: { |
| 19:22:57 | openclaw-worker#37 | b21d0ab | 1/4 | — | — | 91s | specialists_failed | Operation aborted | Ollama HTTP 404: { | 21s | Ollama HTTP 404: { |
| 19:40:35 | openclaw-worker#37 | ce46ac4 | 1/4 | — | — | 91s | specialists_failed | Operation aborted | Ollama HTTP 404: { | 26s | Ollama HTTP 404: { |
| 19:58:15 | openclaw-worker#37 | dc04979 | 2/4 | — | — | 211s | internal_error | Operation aborted | 53s | 22s | Operation aborted |
| 03:03:20 | openclaw-worker#39 | cd39faa | 3/4 | ok | 0 | 141s | — | Operation aborted | 32s | 10s | 67s |
| 03:03:35 | openclaw-worker#38 | 4fe47e4 | 0/4 | — | — | 91s | specialists_failed | Operation aborted | Operation aborted | Operation aborted | Operation aborted |
| 03:17:09 | openclaw-worker#38 | da4ba2b | 2/4 | — | — | 211s | internal_error | Operation aborted | 53s | 67s | Operation aborted |
| 03:19:28 | openclaw-worker#39 | b944930 | 2/4 | ok | 0 | 128s | — | Operation aborted | 58s | 36s | Operation aborted |
| 03:26:30 | openclaw-worker#39 | a179c4c | 2/4 | ok | 0 | 135s | — | Operation aborted | 10s | 17s | Operation aborted |
| 03:26:35 | openclaw-worker#38 | 41f8708 | 0/4 | — | — | 91s | specialists_failed | Operation aborted | Operation aborted | Operation aborted | Operation aborted |
| 03:26:44 | openclaw-worker#40 | 5b93e86 | 1/4 | — | — | 91s | specialists_failed | Operation aborted | Operation aborted | 86s | Operation aborted |
| 04:46:09 | sigilix#41 | b175201 | 2/4 | — | — | 211s | internal_error | Operation aborted | 13s | Operation aborted | 50s |
| 05:06:37 | sigilix#41 | 2b2fb56 | 4/4 | ok | 1 | 96s | — | 35s | 65s | 17s | 16s |
| 05:39:57 | sigilix#41 | 35667ed | 4/4 | — | — | 199s | internal_error | 78s | 41s | 7s | 25s |
