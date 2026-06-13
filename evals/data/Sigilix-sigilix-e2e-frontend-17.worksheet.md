# Reviewer worksheet — Sigilix/sigilix-e2e-frontend#17

https://github.com/Sigilix/sigilix-e2e-frontend/pull/17

Sigilix flagged **1**; CodeRabbit flagged **1**; Greptile flagged **2**.

Label each *real-world issue* once in the table at the bottom. If multiple tools flagged the same issue, put all refs in one row. Use `none` only for a ground-truth real bug every tool missed. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` src/components/UserBio.tsx:14 _[testing]_ — **Untrusted `bioHtml` rendered via `dangerouslySetInnerHTML` with no sanitization and no test coverage**

### CodeRabbit findings

- `c1` src/components/UserBio.tsx:14 — _⚠️ Potential issue_ | _🔴 Critical_

### Greptile findings

- `g1` src/components/UserBio.tsx:14 — **Stored XSS via unsanitized user HTML**
- `g2` src/components/UserBio.tsx:13 — `EDITOR_TIP_HTML` is a static string that bypasses React's auto-escaping for no gain. Converting it to a JSX element is idiomatic, keeps escape-safety in React's hands, and removes the only `dangerouslySetInnerHTML` call that is safe to eliminate.

## Labels

<!-- outcome  ∈ real_bug | noise -->
<!-- category ∈ security | perf | logic | tests | style -->
<!-- findings: comma-separated refs, e.g. s1,c3,g2; use `none` for a real bug every tool missed -->

| findings | outcome | category | note |
|----------|-------|----------|------|
| s1,c1,g1 | real_bug | security | stored XSS via unsanitized bioHtml (Sigilix named it INLINE now, tagged testing) |
| g2 | noise | security | trap: flags the SAFE static EDITOR_TIP_HTML constant |
