# Reviewer worksheet — Sigilix/sigilix-e2e-backend#30

https://github.com/Sigilix/sigilix-e2e-backend/pull/30

Sigilix flagged **4**; CodeRabbit flagged **3**; Greptile flagged **3**.

Label each *real-world issue* once in the table at the bottom. If multiple tools flagged the same issue, put all refs in one row. Use `none` only for a ground-truth real bug every tool missed. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` src/rate-limit.ts:34 _[logic]_ — **Refill discards sub‑interval remainder, causing systematic token loss**
- `s2` src/rate-limit.ts:14 _[performance]_ — **Unbounded `Map` in `TokenBucket` causes memory leak under load**
- `s3` src/rate-limit.ts:54 _[testing]_ — **New token‑bucket rate limiter ships without any test coverage**
- `s4` src/server.ts:17 _[testing]_ — **Rate‑limit middleware integration in server has no test**

### CodeRabbit findings

- `c1` src/rate-limit.ts:15 — _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_
- `c2` src/rate-limit.ts:35 — _⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_
- `c3` src/server.ts:17 — _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

### Greptile findings

- `g1` src/rate-limit.ts:34 — Advance `lastRefill` by whole intervals rather than snapping it to `now`. This keeps the refill window anchored to a fixed grid instead of sliding forward on every hit, so users are never penalized with a longer-than-`intervalMs` wait between refills.
- `g2` src/rate-limit.ts:15 — **Unbounded `buckets` map grows forever**
- `g3` src/rate-limit.ts:50 — **`req.ip` fallback reaches dead code — all requests are already authenticated**

## Labels

<!-- outcome  ∈ real_bug | noise -->
<!-- category ∈ security | perf | logic | tests | style -->
<!-- findings: comma-separated refs, e.g. s1,c3,g2; use `none` for a real bug every tool missed -->

| findings | outcome | category | note |
|----------|-------|----------|------|
| s1,c2,g1 | real_bug | logic | token-bucket refill discards sub-interval remainder → rate drift (T4) |
| s2,c1,g2 | real_bug | perf | unbounded `buckets` Map — memory growth |
| c3 | real_bug | security | rate limiter runs after auth — can't protect against auth brute-force |
| g3 | noise | logic | minor: `req.ip` fallback unreachable (all requests authed) |
| s3,s4 | noise | tests | over-fire: "untested" |
