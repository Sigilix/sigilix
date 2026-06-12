# Reviewer worksheet — Sigilix/sigilix-e2e-backend#26

https://github.com/Sigilix/sigilix-e2e-backend/pull/26

Sigilix flagged **2**; CodeRabbit flagged **2**; Greptile flagged **4**.

Label each *real-world issue* once in the table at the bottom. If multiple tools flagged the same issue, put all refs in one row. Use `none` only for a ground-truth real bug every tool missed. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` src/routes/search.ts:31 _[testing]_ — **New search endpoint ships with zero test coverage despite containing SQL injection and multiple branches**
- `s2` src/server.ts:18 _[testing]_ — **New route mount in server.ts has no integration test**

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
| c1,g1,s1 | real_bug | security | SQLi via interpolated `q`; Sigilix bundled it into a tests finding + flagged it in the summary |
| c2,g2 | noise | logic | CSV export filters name-only vs search name+email — minor/debatable intent |
| g3 | noise | style | RFC4180 carriage-return escaping — pedantic |
| g4 | noise | style | RFC4180 `\n` vs `\r\n` — pedantic |
| s2 | noise | tests | over-fire: server.ts mount "untested" |
