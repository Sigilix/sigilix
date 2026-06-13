# Reviewer worksheet — Sigilix/sigilix-e2e-backend#30

https://github.com/Sigilix/sigilix-e2e-backend/pull/30

Sigilix flagged **2**; CodeRabbit flagged **3**; Greptile flagged **3**.

Label each *real-world issue* once in the table at the bottom. If multiple tools flagged the same issue, put all refs in one row. Use `none` only for a ground-truth real bug every tool missed. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` src/rate-limit.ts:14 _[performance]_ — **Unbounded `buckets` Map grows without eviction**
- `s2` src/rate-limit.ts:49 _[performance]_ — **`'anon'` fallback collapses all unauthenticated traffic into one bucket**

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
| c2,g1 | real_bug | logic | token-bucket refill drift (T4) — Sigilix MISSED it this run (it CAUGHT it last run) |
| s1,c1,g2 | real_bug | perf | unbounded buckets Map — memory growth |
| c3 | real_bug | security | rate limiter runs after auth — no brute-force protection |
| s2 | noise | perf | "anon fallback" — no unauthenticated traffic (auth middleware) |
| g3 | noise | logic | req.ip fallback dead code |
