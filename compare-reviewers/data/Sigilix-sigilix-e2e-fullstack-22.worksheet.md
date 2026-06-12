# Reviewer worksheet — Sigilix/sigilix-e2e-fullstack#22

https://github.com/Sigilix/sigilix-e2e-fullstack/pull/22

Sigilix flagged **1**; CodeRabbit flagged **0**; Greptile flagged **0**.

Label each *real-world issue* once in the table at the bottom. If multiple tools flagged the same issue, put all refs in one row. Use `none` only for a ground-truth real bug every tool missed. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` web/InvoiceFooter.tsx:18 _[testing]_ — **New `InvoiceFooter` component ships without any test coverage**

### CodeRabbit findings

_(none)_

### Greptile findings

_(none)_

## Labels

<!-- outcome  ∈ real_bug | noise -->
<!-- category ∈ security | perf | logic | tests | style -->
<!-- findings: comma-separated refs, e.g. s1,c3,g2; use `none` for a real bug every tool missed -->

| findings | outcome | category | note |
|----------|-------|----------|------|
| s1 | noise | tests | trap: "InvoiceFooter untested" — pure glue over a same-PR tested helper (SIG-347 over-fire) |
