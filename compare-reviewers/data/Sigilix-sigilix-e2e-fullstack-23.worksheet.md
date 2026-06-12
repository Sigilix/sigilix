# Reviewer worksheet — Sigilix/sigilix-e2e-fullstack#23

https://github.com/Sigilix/sigilix-e2e-fullstack/pull/23

Sigilix flagged **3**; CodeRabbit flagged **2**; Greptile flagged **0**.

Label each *real-world issue* once in the table at the bottom. If multiple tools flagged the same issue, put all refs in one row. Use `none` only for a ground-truth real bug every tool missed. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` server/api.ts:29 _[security]_ — **Missing authentication and authorization on refund-quote endpoint**
- `s2` shared/refund.ts:18 _[testing]_ — **New financial computation function ships without any test coverage**
- `s3` shared/refund.ts:18 _[logic]_ — **Floating-point precision loss in prorated refund calculation**

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
| s3 | real_bug | logic | float-money precision in `proratedRefundCents` (Sigilix only) |
| c1 | real_bug | logic | invalid proration window / div-by-zero (`daysTotal=0`) not rejected |
| s1 | real_bug | security | refund-quote endpoint exposes invoice data with no auth |
| c2 | noise | style | "return documented field name" — minor naming |
| s2 | noise | tests | over-fire: refund fn "untested" |
