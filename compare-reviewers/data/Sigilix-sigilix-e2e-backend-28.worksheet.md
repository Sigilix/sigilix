# Reviewer worksheet — Sigilix/sigilix-e2e-backend#28

https://github.com/Sigilix/sigilix-e2e-backend/pull/28

Sigilix flagged **3**; CodeRabbit flagged **1**; Greptile flagged **3**.

Label each *real-world issue* once in the table at the bottom. If multiple tools flagged the same issue, put all refs in one row. Use `none` only for a ground-truth real bug every tool missed. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` src/routes/coupons.ts:12 _[security]_ — **Missing authorization check — any authenticated user can redeem any coupon code**
- `s2` src/routes/coupons.ts:36 _[testing]_ — **New coupon redemption endpoint ships without tests for its two reachable branches**
- `s3` src/server.ts:18 _[testing]_ — **New route registration in server.ts has no test verifying the coupon endpoint is mounted**

### CodeRabbit findings

- `c1` src/routes/coupons.ts:34 — _⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_

### Greptile findings

- `g1` src/routes/coupons.ts:35 — **TOCTOU race — stock can go negative**
- `g2` src/routes/coupons.ts:36 — **Unhandled promise rejections on DB errors**
- `g3` src/routes/coupons.ts:33 — **No per-user duplicate-redemption guard**

## Labels

<!-- outcome  ∈ real_bug | noise -->
<!-- category ∈ security | perf | logic | tests | style -->
<!-- findings: comma-separated refs, e.g. s1,c3,g2; use `none` for a real bug every tool missed -->

| findings | outcome | category | note |
|----------|-------|----------|------|
| c1,g1 | real_bug | logic | TOCTOU race — coupon stock can go negative under concurrency |
| s1 | noise | security | over-fire: "any user can redeem any coupon" — redemption is open to users by design |
| g3 | noise | logic | speculative: no per-user duplicate-redemption guard |
| g2 | noise | logic | "unhandled promise rejections" — pre-existing repo pattern |
| s2,s3 | noise | tests | over-fire: redeem endpoint/mount "untested" |
