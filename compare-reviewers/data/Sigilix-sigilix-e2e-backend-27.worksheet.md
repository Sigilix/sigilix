# Reviewer worksheet — Sigilix/sigilix-e2e-backend#27

https://github.com/Sigilix/sigilix-e2e-backend/pull/27

Sigilix flagged **4**; CodeRabbit flagged **2**; Greptile flagged **2**.

Label each *real-world issue* once in the table at the bottom. If multiple tools flagged the same issue, put all refs in one row. Use `none` only for a ground-truth real bug every tool missed. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` src/routes/billing.ts:30 _[security]_ — **Missing authorization check on GET /users/:id/payment-methods allows any authenticated user to read any user's saved payment cards**
- `s2` src/routes/billing.ts:34 _[security]_ — **IDOR: `/users/:id/payment-methods` returns any user's saved cards with no authorization check**
- `s3` src/routes/billing.ts:28 _[security]_ — **`/users/:id/payment-methods` lacks authorization — any authenticated user can look up any member's saved cards**
- `s4` src/routes/billing.ts:1 _[testing]_ — **New billing routes ship without any test coverage**

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
| s1,s2,s3,c2,g1 | real_bug | security | IDOR on /users/:id/payment-methods (Sigilix posted 3 near-duplicates) |
| s4 | noise | tests | over-fire: billing routes "untested" |
| c1 | noise | logic | "add error handling for unhandled rejection" — pre-existing repo pattern |
| g2 | noise | logic | "unhandled promise rejections" — pre-existing repo pattern |
