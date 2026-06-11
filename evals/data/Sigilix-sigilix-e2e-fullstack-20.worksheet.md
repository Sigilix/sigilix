# Reviewer worksheet — Sigilix/sigilix-e2e-fullstack#20

https://github.com/Sigilix/sigilix-e2e-fullstack/pull/20

Sigilix flagged **15**; CodeRabbit flagged **0**; Greptile flagged **9**.

Label each *real-world issue* once in the table at the bottom. If multiple tools flagged the same issue, put all refs in one row. Use `none` only for a ground-truth real bug every tool missed. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` server/payments.ts:178 _[security]_ — **SQL injection in webhook handler via string interpolation of event.invoiceId**
- `s2` server/payments.ts:148 _[performance]_ — **N+1 query loop fetches refunds one payment at a time**
- `s3` server/payments.ts:136 _[security]_ — **SQL injection in GET /api/payments via string interpolation of idsParam into IN clause**
- `s4` server/payments.ts:30 _[security]_ — **Missing authorization check on POST /api/invoices/:id/charge — any authenticated user can charge any invoice**
- `s5` server/payments.ts:44 _[logic]_ — **Race condition: payment INSERT is not awaited before SUM query, causing missed status flip**
- `s6` server/payments.ts:182 _[testing]_ — **New payments module with multiple branches, parser/coercion logic, and a security-sensitive webhook handler ships with zero tests**
- `s7` server/payments.ts:50 _[logic]_ — **Charge handler reports `paidCents` including the new amount before the INSERT is durable**
- `s8` server/payments.ts:131 _[logic]_ — **Pagination offset is off-by-one: `page * limit` skips the first page's results**
- `s9` server/refunds.ts:11 _[logic]_ — **Floating-point precision loss in `computeRefundCents`: `amountDollars * 100` can produce non-integer cents**
- `s10` server/payments.ts:178 _[logic]_ — **Webhook handler is not idempotent: no deduplication on `event.id`**
- `s11` server/auth.ts:28 _[testing]_ — **New auth middleware with a critical authentication branch ships without tests**
- `s12` server/refunds.ts:38 _[testing]_ — **New refund module with a dollars-to-cents conversion function and a database write path ships without tests**
- `s13` server/payments.ts:149 _[performance]_ — **N+1 query loop fetches refunds one payment at a time**
- `s14` server/payments.ts:51 _[logic]_ — **Charge handler flips invoice status to `'paid'` unconditionally when `paidCents > 0`, ignoring the invoice's `amount_cents`**
- `s15` server/api.ts:9 _[testing]_ — **New Express middleware setup in api.ts ships without tests**

### CodeRabbit findings

_(none)_

### Greptile findings

- `g1` server/payments.ts:180 — **SQL Injection via template literal in webhook handler**
- `g2` server/payments.ts:48 — Missing `await` on the payment INSERT means the subsequent `SUM` query runs before the row is visible. The code compensates by adding `amountCents` manually, but under concurrent requests both calls would read the same stale sum and independently add the same amount — double-cou…
- `g3` server/payments.ts:141 — Wrong pagination offset for 1-based pages. With the current formula `page * limit`, page 1 gives offset 20, page 2 gives offset 40 — so the first page of results is always skipped.
- `g4` server/payments.ts:54 — An invoice is flipped to `paid` as soon as `paidCents > 0`, meaning a single-cent partial payment settles the full invoice regardless of its `amount_cents`. The condition should require the running total to reach or exceed the invoice face value.
- `g5` server/refunds.ts:8 — **Refund API accepts dollars; charge API accepts cents**
- `g6` server/payments.ts:166 — **Webhook HMAC is over re-serialised JSON, not raw bytes**
- `g7` server/payments.ts:36 — **Charge endpoint does not scope by `customer_id`**
- `g8` server/payments.ts:36 — The charge endpoint returns HTTP 200 with an error body when the invoice is not found. Clients relying on the HTTP status code won't see the failure.
- `g9` server/payments.ts:180 — **Webhook idempotency is not actually enforced by `event.id`**

## Labels

<!-- outcome  ∈ real_bug | noise -->
<!-- category ∈ security | perf | logic | tests | style -->
<!-- findings: comma-separated refs, e.g. s1,c3,g2; use `none` for a real bug every tool missed -->

| findings | outcome | category | note |
|----------|-------|----------|------|
| | | | |
