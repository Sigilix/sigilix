# Reviewer worksheet — Sigilix/sigilix-e2e-frontend#12

https://github.com/Sigilix/sigilix-e2e-frontend/pull/12

Sigilix flagged **4**; CodeRabbit flagged **2**; Greptile flagged **0**.

Label each *real-world issue* once in the table at the bottom. If multiple tools flagged the same issue, put all refs in one row. Use `none` only for a ground-truth real bug every tool missed. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` src/hooks/usePagedUsers.ts:25 _[logic]_ — **Stale closure in `loadMore` captures initial `cursor`, `done`, and `loading` values**
- `s2` src/hooks/usePagedUsers.ts:17 _[testing]_ — **New pagination hook ships without test coverage**
- `s3` src/api/client.ts:28 _[testing]_ — **New getUsersPaged API method lacks test coverage**
- `s4` src/components/UserList.tsx:12 _[testing]_ — **UserList component filter logic untested**

### CodeRabbit findings

- `c1` src/components/UserList.tsx:15 — _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_
- `c2` src/hooks/usePagedUsers.ts:36 — _⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_

### Greptile findings

_(none)_

## Labels

<!-- outcome  ∈ real_bug | noise -->
<!-- category ∈ security | perf | logic | tests | style -->
<!-- findings: comma-separated refs, e.g. s1,c3,g2; use `none` for a real bug every tool missed -->

| findings | outcome | category | note |
|----------|-------|----------|------|
| s1 | real_bug | logic | stale closure in loadMore |
| s2 | real_bug | tests | pagination hook untested |
| s3 | real_bug | tests | getUsersPaged untested |
| s4 | real_bug | tests | UserList filter untested |
| c1 | real_bug | logic | error short-circuit discards already-loaded users |
| c2 | real_bug | logic | StrictMode double-invoke concern |
