# Reviewer worksheet — Sigilix/sigilix-e2e-fullstack#21

https://github.com/Sigilix/sigilix-e2e-fullstack/pull/21

Sigilix flagged **5**; CodeRabbit flagged **2**; Greptile flagged **0**.

Label each *real-world issue* once in the table at the bottom. If multiple tools flagged the same issue, put all refs in one row. Use `none` only for a ground-truth real bug every tool missed. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` server/api.ts:26 _[security]_ — **Client-supplied `isAdmin` field used for server-side authorization**
- `s2` server/api.ts:28 _[logic]_ — **Authorization gate trusts client-supplied `isAdmin` boolean**
- `s3` server/api.ts:31 _[testing]_ — **New destructive endpoint ships without any test coverage**
- `s4` server/api.ts:30 _[logic]_ — **DELETE query succeeds silently when invoice does not exist**
- `s5` server/api.ts:30 _[logic]_ — **Route parameter `:id` is not validated before use in SQL**

### CodeRabbit findings

- `c1` server/api.ts:7 — _⚠️ Potential issue_ | _🔴 Critical_
- `c2` server/api.ts:32 — _⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_

### Greptile findings

_(none)_

## Labels

<!-- outcome  ∈ real_bug | noise -->
<!-- category ∈ security | perf | logic | tests | style -->
<!-- findings: comma-separated refs, e.g. s1,c3,g2; use `none` for a real bug every tool missed -->

| findings | outcome | category | note |
|----------|-------|----------|------|
| s1,s2,c1,c2 | real_bug | security | server trusts client-supplied `isAdmin` — authz bypass on delete |
| s4 | real_bug | logic | DELETE succeeds silently on a missing invoice (no 404) |
| s5 | noise | security | FP: ":id not validated before SQL" — the query is parameterized (`$1`) |
| s3 | noise | tests | over-fire: delete endpoint "untested" |
