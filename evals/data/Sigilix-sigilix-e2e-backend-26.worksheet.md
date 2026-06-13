# Reviewer worksheet — Sigilix/sigilix-e2e-backend#26

https://github.com/Sigilix/sigilix-e2e-backend/pull/26

Sigilix flagged **6**; CodeRabbit flagged **2**; Greptile flagged **4**.

Label each *real-world issue* once in the table at the bottom. If multiple tools flagged the same issue, put all refs in one row. Use `none` only for a ground-truth real bug every tool missed. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` src/routes/search.ts:60 _[performance]_ — **CSV export materializes up to 1000 rows into a single string before sending**
- `s2` src/routes/search.ts:63 _[testing]_ — **New search and CSV export endpoints ship with no test coverage**
- `s3` src/routes/search.ts:33 _[error-handling]_ — **Unhandled promise rejection: `query()` call has no try/catch or error handler**
- `s4` src/server.ts:18 _[testing]_ — **New route mount in server.ts has no integration test**
- `s5` src/routes/search.ts:33 _[logic]_ — **Search endpoint returns `nextCursor: null` but never computes a real cursor**
- `s6` src/routes/search.ts:33 _[performance]_ — **Search endpoint uses `ILIKE` with leading/trailing wildcards — no index can accelerate this query**

### CodeRabbit findings

- `c1` src/routes/search.ts:33 — _⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_
- `c2` src/routes/search.ts:54 — _⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_

### Greptile findings

- `g1` src/routes/search.ts:32 — **SQL injection via string-interpolated `q`**
- `g2` src/routes/search.ts:54 — **CSV export only filters by `name`, not `email`**
- `g3` src/routes/search.ts:39 — **RFC 4180: carriage returns are not escaped**
- `g4` src/routes/search.ts:63 — **CSV uses `\n` line endings instead of `\r\n`**

## Labels

<!-- outcome  ∈ real_bug | noise -->
<!-- category ∈ security | perf | logic | tests | style -->
<!-- findings: comma-separated refs, e.g. s1,c3,g2; use `none` for a real bug every tool missed -->

| findings | outcome | category | note |
|----------|-------|----------|------|
| c1,g1 | real_bug | security | SQLi via interpolated `q` — Sigilix flagged it only in the summary, NOT inline |
| s5 | real_bug | logic | search `nextCursor` always null — pagination never advances |
| s6 | real_bug | perf | `ILIKE` leading wildcard — non-indexable |
| s1 | noise | perf | CSV buffers ≤1000 rows — minor |
| s3 | noise | logic | unhandled promise rejection — pervasive repo pattern |
| s2,s4 | noise | tests | over-fire: "no test coverage" |
| c2,g2 | noise | logic | CSV name-only filter — minor/debatable |
| g3 | noise | style | RFC4180 CR — pedantic |
| g4 | noise | style | RFC4180 `\n` — pedantic |
