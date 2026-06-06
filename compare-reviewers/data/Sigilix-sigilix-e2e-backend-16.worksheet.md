# Reviewer worksheet — Sigilix/sigilix-e2e-backend#16

https://github.com/Sigilix/sigilix-e2e-backend/pull/16

Sigilix flagged **2**; CodeRabbit flagged **2**.

Label each *real-world issue* once in the table at the bottom. If both bots flagged the same issue, put both refs in one row and use a `both_*` label. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` src/routes/profile.ts:22 _[security]_ — **No length validation on the `bio` field**
- `s2` src/routes/profile.ts:1 _[testing]_ — **New profile endpoint ships without test coverage**

### CodeRabbit findings

- `c1` src/routes/profile.ts:23 — _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_
- `c2` src/routes/profile.ts:37 — _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

## Labels

<!-- label    ∈ sigilix_only_real_bug | sigilix_only_noise | cr_only_real_bug | cr_only_noise | both_real | both_noise -->
<!-- category ∈ security | perf | logic | tests | style -->
<!-- findings: comma-separated refs, e.g. s1,c3 -->

| findings | label | category | note |
|----------|-------|----------|------|
| s1 | sigilix_only_real_bug | security | no length cap on bio field |
| s2 | sigilix_only_real_bug | tests | profile endpoint untested |
| c1 | cr_only_real_bug | logic | unguarded req.body causes 500 |
| c2 | cr_only_real_bug | logic | DB failures unhandled |
