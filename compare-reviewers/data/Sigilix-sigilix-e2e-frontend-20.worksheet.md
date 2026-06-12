# Reviewer worksheet — Sigilix/sigilix-e2e-frontend#20

https://github.com/Sigilix/sigilix-e2e-frontend/pull/20

Sigilix flagged **5**; CodeRabbit flagged **2**; Greptile flagged **0**.

Label each *real-world issue* once in the table at the bottom. If multiple tools flagged the same issue, put all refs in one row. Use `none` only for a ground-truth real bug every tool missed. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` src/api/membership-cache.ts:7 _[security]_ — **Cache lacks TTL/eviction, leading to stale permissions and unbounded memory growth**
- `s2` src/api/membership-cache.ts:7 _[performance]_ — **Module-level `cache` Map grows without bound — no eviction or TTL**
- `s3` src/api/membership-cache.ts:38 _[testing]_ — **New exported module with fetch, caching, and error paths has no test coverage**
- `s4` src/api/membership-cache.ts:7 _[performance]_ — **Module-level `Map` cache grows without bound — no eviction or TTL**
- `s5` src/api/membership-cache.ts:38 _[testing]_ — **New membership-cache module ships without test coverage**

### CodeRabbit findings

- `c1` src/api/membership-cache.ts:7 — _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_
- `c2` src/api/membership-cache.ts:12 — _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

### Greptile findings

_(none)_

## Labels

<!-- outcome  ∈ real_bug | noise -->
<!-- category ∈ security | perf | logic | tests | style -->
<!-- findings: comma-separated refs, e.g. s1,c3,g2; use `none` for a real bug every tool missed -->

| findings | outcome | category | note |
|----------|-------|----------|------|
| c2 | real_bug | logic | membership cache key collision — `orgId+userId` no delimiter (T4; CodeRabbit only) |
| s1,s2,s4 | real_bug | perf | membership cache unbounded / no-TTL (Sigilix; stale-perms + memory) |
| c1 | noise | logic | enhancement: dedupe in-flight requests |
| s3,s5 | noise | tests | over-fire: membership-cache "untested" |
