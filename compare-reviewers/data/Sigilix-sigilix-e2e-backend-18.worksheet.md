# Reviewer worksheet — Sigilix/sigilix-e2e-backend#18

https://github.com/Sigilix/sigilix-e2e-backend/pull/18

Sigilix flagged **1**; CodeRabbit flagged **3**.

Label each *real-world issue* once in the table at the bottom. If both bots flagged the same issue, put both refs in one row and use a `both_*` label. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` src/routes/session.ts:1 _[testing]_ — **Authentication endpoint ships without test coverage**

### CodeRabbit findings

- `c1` src/routes/session.ts:6 — _⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_
- `c2` src/routes/session.ts:16 — _⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_
- `c3` src/routes/session.ts:14 — _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

## Labels

<!-- label    ∈ sigilix_only_real_bug | sigilix_only_noise | cr_only_real_bug | cr_only_noise | both_real | both_noise -->
<!-- category ∈ security | perf | logic | tests | style -->
<!-- findings: comma-separated refs, e.g. s1,c3 -->

| findings | label | category | note |
|----------|-------|----------|------|
| s1 | sigilix_only_real_bug | tests | auth endpoint untested |
| c1 | cr_only_real_bug | security | empty SESSION_SECRET allows auth bypass |
| c2 | cr_only_real_bug | logic | split('.') breaks payload containing dots |
| c3 | cr_only_real_bug | security | non-constant-time token compare |
