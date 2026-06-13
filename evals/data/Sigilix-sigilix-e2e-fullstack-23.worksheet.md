# Reviewer worksheet — Sigilix/sigilix-e2e-fullstack#23

https://github.com/Sigilix/sigilix-e2e-fullstack/pull/23

Sigilix flagged **3**; CodeRabbit flagged **2**; Greptile flagged **0**.

Label each *real-world issue* once in the table at the bottom. If multiple tools flagged the same issue, put all refs in one row. Use `none` only for a ground-truth real bug every tool missed. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` shared/refund.ts:17 _[logic]_ — **Floating-point precision loss in proratedRefundCents produces incorrect refund amounts**
- `s2` server/api.ts:28 _[logic]_ — **No input validation on daysUsed and daysTotal — negative, zero, and inverted values accepted**
- `s3` server/api.ts:30 _[error-handling]_ — **Unhandled DB query rejection — pool.query failure crashes the handler**

### CodeRabbit findings

- `c1` server/api.ts:35 — _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_
- `c2` server/api.ts:35 — _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

### Greptile findings

_(none)_

## Labels

<!-- outcome  ∈ real_bug | noise -->
<!-- category ∈ security | perf | logic | tests | style -->
<!-- findings: comma-separated refs, e.g. s1,c3,g2; use `none` for a real bug every tool missed -->

| findings | outcome | category | note |
|----------|-------|----------|------|
| s1 | real_bug | logic | float-money precision in proratedRefundCents (Sigilix only — CR/Greptile missed it) |
| s2,c1 | real_bug | logic | invalid proration window / div-by-zero (daysTotal=0) not rejected |
| s3 | noise | logic | unhandled DB rejection — pervasive pattern |
| c2 | noise | style | "return documented field name" — minor naming |
