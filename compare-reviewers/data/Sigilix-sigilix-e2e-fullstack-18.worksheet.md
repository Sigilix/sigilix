# Reviewer worksheet — Sigilix/sigilix-e2e-fullstack#18

https://github.com/Sigilix/sigilix-e2e-fullstack/pull/18

Sigilix flagged **3**; CodeRabbit flagged **3**.

Label each *real-world issue* once in the table at the bottom. If both bots flagged the same issue, put both refs in one row and use a `both_*` label. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` server/invoice-summary.ts:14 _[error-handling]_ — **Unhandled promise rejection on database query will crash the process under load**
- `s2` server/invoice-summary.ts:12 _[security]_ — **New endpoint has no authentication: any caller can read per-status invoice summary data**
- `s3` server/invoice-summary.ts:1 _[testing]_ — **New endpoint ships without test coverage**

### CodeRabbit findings

- `c1` server/invoice-summary.ts:5 — _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_
- `c2` server/invoice-summary.ts:30 — _⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_
- `c3` server/invoice-summary.ts:19 — _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

## Labels

<!-- label    ∈ sigilix_only_real_bug | sigilix_only_noise | cr_only_real_bug | cr_only_noise | both_real | both_noise -->
<!-- category ∈ security | perf | logic | tests | style -->
<!-- findings: comma-separated refs, e.g. s1,c3 -->

| findings | label | category | note |
|----------|-------|----------|------|
| s1,c2 | both_real | logic | both flagged unhandled async rejection crashing the route |
| s2 | sigilix_only_real_bug | security | no auth on invoice-summary endpoint |
| s3 | sigilix_only_real_bug | tests | endpoint untested |
| c1 | cr_only_real_bug | logic | fail fast when DATABASE_URL missing |
| c3 | cr_only_real_bug | logic | ::int casts on aggregates can overflow |
