# Reviewer worksheet — Sigilix/sigilix-e2e-backend#29

https://github.com/Sigilix/sigilix-e2e-backend/pull/29

Sigilix flagged **6**; CodeRabbit flagged **4**; Greptile flagged **3**.

Label each *real-world issue* once in the table at the bottom. If multiple tools flagged the same issue, put all refs in one row. Use `none` only for a ground-truth real bug every tool missed. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` src/routes/digest.ts:17 _[security]_ — **Missing authorization check — any authenticated user can query any user's activity count**
- `s2` src/routes/digest.ts:21 _[performance]_ — **N+1 DB queries: one `await query` per user ID in the `/digest` handler loop**
- `s3` src/routes/digest.ts:41 _[logic]_ — **`applyOrderedSteps` passes `step.params` directly to `query`, but `query` expects a flat bind array — nested arrays break the SQL bind**
- `s4` src/routes/digest.ts:41 _[testing]_ — **New digest endpoint and `applyOrderedSteps` export ship without any test coverage**
- `s5` src/routes/digest.ts:41 _[security]_ — **applyOrderedSteps accepts arbitrary SQL strings — design risk if exposed to untrusted callers**
- `s6` src/server.ts:18 _[testing]_ — **New route mount in `src/server.ts` has no integration test**

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
| s2,c3,g1 | real_bug | perf | N+1 serial `await` per user id in /digest |
| c1,g3 | real_bug | security | unbounded `userIds` array — no input cap |
| s1 | noise | security | over-fire: "authz on activity count" — team widget, debatable |
| s3 | noise | logic | speculative: nested-array bind (`params` is a flat array by contract) |
| s5 | noise | security | over-cautious: `applyOrderedSteps` "arbitrary SQL" is by design |
| c2 | noise | logic | unhandled-rejection / authz bundle |
| c4 | noise | logic | "add transaction wrapping" suggestion — not a defect |
| g2 | noise | style | raw-SQL executor exported from a route file |
| s4,s6 | noise | tests | over-fire: "untested" |
