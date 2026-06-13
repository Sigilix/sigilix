# Reviewer worksheet — Sigilix/sigilix-e2e-backend#29

https://github.com/Sigilix/sigilix-e2e-backend/pull/29

Sigilix flagged **7**; CodeRabbit flagged **4**; Greptile flagged **3**.

Label each *real-world issue* once in the table at the bottom. If multiple tools flagged the same issue, put all refs in one row. Use `none` only for a ground-truth real bug every tool missed. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` src/routes/digest.ts:28 _[performance]_ — **N+1 sequential DB queries per request in `POST /digest`**
- `s2` src/routes/digest.ts:19 _[performance]_ — **N+1 sequential DB queries per request in `POST /digest`**
- `s3` src/routes/digest.ts:28 _[error-handling]_ — **No error handling around the per-user queries — a single DB failure crashes the whole request**
- `s4` src/routes/digest.ts:41 _[error-handling]_ — **`applyOrderedSteps` accepts arbitrary `sql` and `params` with no validation**
- `s5` src/routes/digest.ts:16 _[error-handling]_ — **No upper bound on the number of user ids — a malicious client can send thousands**
- `s6` src/routes/digest.ts:16 _[error-handling]_ — **Empty `userIds` array produces a valid 200 response with an empty digest — no indication of missing input**
- `s7` src/routes/digest.ts:16 _[error-handling]_ — **No validation that user ids are non-empty strings**

### CodeRabbit findings

- `c1` src/routes/digest.ts:17 — _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_
- `c2` src/routes/digest.ts:29 — _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_
- `c3` src/routes/digest.ts:26 — _⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_
- `c4` src/routes/digest.ts:43 — _⚠️ Potential issue_ | _🔴 Critical_

### Greptile findings

- `g1` src/routes/digest.ts:26 — **N+1 queries per request**
- `g2` src/routes/digest.ts:43 — **Raw-SQL executor exported from a web route file**
- `g3` src/routes/digest.ts:17 — No upper bound on the number of user IDs is enforced. Even after the N+1 issue is fixed, an unbounded array can generate a very large `ANY($1)` array parameter and result set. Capping the input to the documented maximum keeps behaviour predictable.

## Labels

<!-- outcome  ∈ real_bug | noise -->
<!-- category ∈ security | perf | logic | tests | style -->
<!-- findings: comma-separated refs, e.g. s1,c3,g2; use `none` for a real bug every tool missed -->

| findings | outcome | category | note |
|----------|-------|----------|------|
| s1,s2,c3,g1 | real_bug | perf | N+1 serial await in /digest (Sigilix posted a near-dup s1/s2) |
| s5,c1,g3 | real_bug | security | unbounded userIds — no input cap |
| s3 | noise | logic | unhandled rejection on per-user query — pervasive |
| s4,c4,g2 | noise | logic | applyOrderedSteps "arbitrary SQL" — by design (must-be-serial helper) |
| s6 | noise | logic | speculative: empty userIds → 200 |
| s7 | noise | logic | speculative: userIds non-empty-string validation |
| c2 | noise | logic | unhandled rejection / authz bundle |
