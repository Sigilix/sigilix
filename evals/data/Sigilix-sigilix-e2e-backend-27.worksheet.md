# Reviewer worksheet — Sigilix/sigilix-e2e-backend#27

https://github.com/Sigilix/sigilix-e2e-backend/pull/27

Sigilix flagged **2**; CodeRabbit flagged **2**; Greptile flagged **2**.

Label each *real-world issue* once in the table at the bottom. If multiple tools flagged the same issue, put all refs in one row. Use `none` only for a ground-truth real bug every tool missed. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` src/routes/billing.ts:30 _[security]_ — **IDOR: /users/:id/payment-methods returns any user's payment methods with no authorization check**
- `s2` src/routes/billing.ts:34 _[testing]_ — **New billing endpoints ship with no test coverage**

### CodeRabbit findings

- `c1` src/routes/billing.ts:25 — _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_
- `c2` src/routes/billing.ts:35 — _⚠️ Potential issue_ | _🔴 Critical_

### Greptile findings

- `g1` src/routes/billing.ts:35 — **Missing authorization check — any user can read any user's payment methods**
- `g2` src/routes/billing.ts:35 — **Unhandled promise rejections in async route handlers**

## Labels

<!-- outcome  ∈ real_bug | noise -->
<!-- category ∈ security | perf | logic | tests | style -->
<!-- findings: comma-separated refs, e.g. s1,c3,g2; use `none` for a real bug every tool missed -->

| findings | outcome | category | note |
|----------|-------|----------|------|
| s1,c2,g1 | real_bug | security | IDOR on /users/:id/payment-methods (Sigilix: ONE clean finding now — dedup-collapse worked) |
| c1 | noise | logic | "add error handling" / unhandled rejection |
| g2 | noise | logic | unhandled promise rejections — pervasive |
| s2 | noise | tests | over-fire: "no test coverage" |
