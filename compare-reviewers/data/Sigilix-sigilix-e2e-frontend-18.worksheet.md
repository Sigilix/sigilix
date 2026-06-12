# Reviewer worksheet — Sigilix/sigilix-e2e-frontend#18

https://github.com/Sigilix/sigilix-e2e-frontend/pull/18

Sigilix flagged **5**; CodeRabbit flagged **1**; Greptile flagged **2**.

Label each *real-world issue* once in the table at the bottom. If multiple tools flagged the same issue, put all refs in one row. Use `none` only for a ground-truth real bug every tool missed. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` src/components/UserDetail.tsx:26 _[logic]_ — **`useEffect` has an empty dependency array but reads `userId` — stale data on prop change**
- `s2` src/components/UserDetail.tsx:35 _[testing]_ — **New `UserDetail` component has no test coverage for its three runtime states**
- `s3` src/components/UserDetail.tsx:15 _[logic]_ — **`useEffect` never re‑fetches when `userId` changes**
- `s4` src/components/UserDetail.tsx:15 _[performance]_ — **`useEffect` missing `userId` dependency causes stale data and redundant fetches**
- `s5` src/components/UserDetail.tsx:35 _[testing]_ — **New `UserDetail` component has no test coverage despite multiple runtime branches**

### CodeRabbit findings

- `c1` src/components/UserDetail.tsx:26 — _⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_

### Greptile findings

- `g1` src/components/UserDetail.tsx:26 — The effect dependency array is empty, so the fetch only runs once on mount. When `userId` changes — which the JSDoc says happens every time the user clicks the list — the effect never re-runs and the component keeps displaying the first user's data indefinitely.
- `g2` src/components/UserDetail.tsx:15 — When `userId` changes the effect re-runs, but `user` is never cleared first. Because `user` is still non-null, the `if (!user) return <p>Loading…</p>` branch is skipped and the previous user's name and bio remain visible during the in-flight request. Adding `setUser(null)` along…

## Labels

<!-- outcome  ∈ real_bug | noise -->
<!-- category ∈ security | perf | logic | tests | style -->
<!-- findings: comma-separated refs, e.g. s1,c3,g2; use `none` for a real bug every tool missed -->

| findings | outcome | category | note |
|----------|-------|----------|------|
| s1,s3,s4,c1,g1 | real_bug | logic | useEffect missing `userId` dep → stale on prop change (Sigilix posted 3 near-dupes) |
| g2 | real_bug | logic | stale UI not cleared during in-flight fetch on userId change (Greptile unique) |
| s2,s5 | noise | tests | over-fire: UserDetail "untested" |
