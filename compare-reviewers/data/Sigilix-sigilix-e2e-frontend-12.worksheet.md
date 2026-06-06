# Reviewer worksheet — Sigilix/sigilix-e2e-frontend#12

https://github.com/Sigilix/sigilix-e2e-frontend/pull/12

Sigilix flagged **4**; CodeRabbit flagged **2**.

Label each *real-world issue* once in the table at the bottom. If both bots flagged the same issue, put both refs in one row and use a `both_*` label. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` src/hooks/usePagedUsers.ts:25 _[logic]_ — **Stale closure in `loadMore` captures initial `cursor`, `done`, and `loading` values**
- `s2` src/hooks/usePagedUsers.ts:17 _[testing]_ — **New pagination hook ships without test coverage**
- `s3` src/api/client.ts:28 _[testing]_ — **New getUsersPaged API method lacks test coverage**
- `s4` src/components/UserList.tsx:12 _[testing]_ — **UserList component filter logic untested**

### CodeRabbit findings

- `c1` src/components/UserList.tsx:15 — _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_
- `c2` src/hooks/usePagedUsers.ts:36 — _⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_

## Labels

<!-- label    ∈ sigilix_only_real_bug | sigilix_only_noise | cr_only_real_bug | cr_only_noise | both_real | both_noise -->
<!-- category ∈ security | perf | logic | tests | style -->
<!-- findings: comma-separated refs, e.g. s1,c3 -->

| findings | label | category | note |
|----------|-------|----------|------|
| s1 | sigilix_only_real_bug | logic | stale closure in loadMore |
| s2 | sigilix_only_real_bug | tests | pagination hook untested |
| s3 | sigilix_only_real_bug | tests | getUsersPaged untested |
| s4 | sigilix_only_real_bug | tests | UserList filter untested |
| c1 | cr_only_real_bug | logic | error short-circuit discards already-loaded users |
| c2 | cr_only_real_bug | logic | StrictMode double-invoke concern |
