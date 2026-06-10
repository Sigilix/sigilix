# Reviewer worksheet — Sigilix/sigilix-e2e-fullstack#18

https://github.com/Sigilix/sigilix-e2e-fullstack/pull/18

Sigilix flagged **3**; CodeRabbit flagged **3**; Greptile flagged **0**.

Label each *real-world issue* once in the table at the bottom. If multiple tools flagged the same issue, put all refs in one row. Use `none` only for a ground-truth real bug every tool missed. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` server/invoice-summary.ts:14 _[error-handling]_ — **Unhandled promise rejection on database query will crash the process under load**
- `s2` server/invoice-summary.ts:12 _[security]_ — **New endpoint has no authentication: any caller can read per-status invoice summary data**
- `s3` server/invoice-summary.ts:1 _[testing]_ — **New endpoint ships without test coverage**

### CodeRabbit findings

- `c1` server/invoice-summary.ts:5 — _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_
- `c2` server/invoice-summary.ts:30 — _⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_
- `c3` server/invoice-summary.ts:19 — _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

### Greptile findings

_(none)_

## Labels

<!-- outcome  ∈ real_bug | noise -->
<!-- category ∈ security | perf | logic | tests | style -->
<!-- findings: comma-separated refs, e.g. s1,c3,g2; use `none` for a real bug every tool missed -->

| findings | outcome | category | note |
|----------|-------|----------|------|
| s1,c2 | real_bug | logic | both flagged unhandled async rejection crashing the route |
| s2 | real_bug | security | no auth on invoice-summary endpoint |
| s3 | real_bug | tests | endpoint untested |
| c1 | real_bug | logic | fail fast when DATABASE_URL missing |
| c3 | real_bug | logic | ::int casts on aggregates can overflow |
