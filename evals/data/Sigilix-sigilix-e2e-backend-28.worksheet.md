# Reviewer worksheet — Sigilix/sigilix-e2e-backend#28

https://github.com/Sigilix/sigilix-e2e-backend/pull/28

Sigilix flagged **6**; CodeRabbit flagged **1**; Greptile flagged **3**.

Label each *real-world issue* once in the table at the bottom. If multiple tools flagged the same issue, put all refs in one row. Use `none` only for a ground-truth real bug every tool missed. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` src/routes/coupons.ts:30 _[logic]_ — **Race condition in stock decrement allows overselling the coupon's remaining stock**
- `s2` src/routes/coupons.ts:30 _[logic]_ — **Coupon stock decrement is unscoped — any authenticated user can drain any coupon's stock**
- `s3` src/routes/coupons.ts:30 _[logic]_ — **Race condition: stock decrement and redemption insert are not atomic, allowing `remaining` to go negative under concurrent requests**
- `s4` src/routes/coupons.ts:30 _[logic]_ — **No idempotency guard: retried or duplicate requests insert duplicate redemption rows**
- `s5` src/routes/coupons.ts:30 _[error-handling]_ — **Unhandled DB rejection after stock decrement: UPDATE succeeds but INSERT fails, losing the redemption record**
- `s6` src/routes/coupons.ts:16 _[logic]_ — **`code` is used directly from `req.params.code` with no validation**

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
| s1,s3,c1,g1 | real_bug | logic | TOCTOU race — stock can go negative (Sigilix CAUGHT it now; missed it last run) |
| s2 | noise | security | over-fire: "any user can redeem" — redemption open by design |
| s4,g3 | noise | logic | speculative: idempotency / per-user dup guard |
| s5,g2 | noise | logic | unhandled DB rejection — pervasive pattern |
| s6 | noise | logic | FP: `req.params.code` "no validation" — query is parameterized |
