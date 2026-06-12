# Reviewer worksheet — Sigilix/sigilix-e2e-frontend#19

https://github.com/Sigilix/sigilix-e2e-frontend/pull/19

Sigilix flagged **2**; CodeRabbit flagged **1**; Greptile flagged **0**.

Label each *real-world issue* once in the table at the bottom. If multiple tools flagged the same issue, put all refs in one row. Use `none` only for a ground-truth real bug every tool missed. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` src/components/Dashboard.tsx:14 _[performance]_ — **Inline object in `useEffect` dependency array triggers `getUsers` on every render**
- `s2` src/components/Dashboard.tsx:40 _[testing]_ — **New Dashboard component has no test coverage**

### CodeRabbit findings

- `c1` src/components/Dashboard.tsx:26 — _⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_

### Greptile findings

_(none)_

## Labels

<!-- outcome  ∈ real_bug | noise -->
<!-- category ∈ security | perf | logic | tests | style -->
<!-- findings: comma-separated refs, e.g. s1,c3,g2; use `none` for a real bug every tool missed -->

| findings | outcome | category | note |
|----------|-------|----------|------|
| s1,c1 | real_bug | perf | inline `fetchOptions` object → effect refires/refetches every render |
| s2 | noise | tests | over-fire: Dashboard "untested" |
