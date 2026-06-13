# Reviewer worksheet — Sigilix/sigilix-e2e-frontend#20

https://github.com/Sigilix/sigilix-e2e-frontend/pull/20

Sigilix flagged **1**; CodeRabbit flagged **2**; Greptile flagged **0**.

Label each *real-world issue* once in the table at the bottom. If multiple tools flagged the same issue, put all refs in one row. Use `none` only for a ground-truth real bug every tool missed. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` src/api/membership-cache.ts:14 _[logic]_ — **Cache key collision from concatenating org and user IDs without a separator**

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
| s1,c2 | real_bug | logic | membership cache key collision — orgId+userId no delimiter (T4; Sigilix CAUGHT it now, missed last run) |
| c1 | noise | logic | enhancement: dedupe in-flight requests |
