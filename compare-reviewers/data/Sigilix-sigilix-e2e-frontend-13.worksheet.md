# Reviewer worksheet — Sigilix/sigilix-e2e-frontend#13

https://github.com/Sigilix/sigilix-e2e-frontend/pull/13

Sigilix flagged **5**; CodeRabbit flagged **7**; Greptile flagged **0**.

Label each *real-world issue* once in the table at the bottom. If multiple tools flagged the same issue, put all refs in one row. Use `none` only for a ground-truth real bug every tool missed. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

### Sigilix findings

- `s1` src/components/ActivityFeed.tsx:38 _[performance]_ — **N+1 network requests: each feed item fetches its own embed preview and comments**
- `s2` src/components/ActivityFeed.tsx:34 _[testing]_ — **ActivityFeed renders untrusted user HTML without React sanitization**
- `s3` src/components/CommentThread.tsx:19 _[testing]_ — **CommentThread injects comment bodies via jQuery .html() without client-side sanitization**
- `s4` src/components/NotificationsPanel.tsx:24 _[testing]_ — **NotificationsPanel injects bodyHtml directly into innerHTML**
- `s5` src/components/NotificationsPanel.tsx:24 _[logic]_ — **Race condition in preview rendering assigns `bodyHtml` from older data**

### CodeRabbit findings

- `c1` package.json:18 — _⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_
- `c2` src/api/activity.ts:45 — _⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_
- `c3` src/components/ActivityFeed.tsx:34 — _⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_
- `c4` src/components/DigestBanner.tsx:16 — _⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_
- `c5` src/components/EmbedCard.tsx:20 — _⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_
- `c6` src/components/NotificationsPanel.tsx:24 — _⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_
- `c7` src/components/NotificationsPanel.tsx:33 — _⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_

### Greptile findings

_(none)_

## Labels

<!-- outcome  ∈ real_bug | noise -->
<!-- category ∈ security | perf | logic | tests | style -->
<!-- findings: comma-separated refs, e.g. s1,c3,g2; use `none` for a real bug every tool missed -->

| findings | outcome | category | note |
|----------|-------|----------|------|
| s2,c3 | real_bug | security | both flagged ActivityFeed dangerouslySetInnerHTML XSS |
| s4,c6 | real_bug | security | both flagged NotificationsPanel innerHTML XSS |
| s1 | real_bug | perf | N+1 fetches per feed item |
| s3 | real_bug | security | CommentThread jQuery .html() XSS |
| s5 | real_bug | logic | stale bodyHtml race in preview effect |
| c2 | real_bug | security | activity API returns untrusted HTML |
| c4 | real_bug | security | DigestBanner XSS |
| c5 | real_bug | security | EmbedCard iframe XSS |
| c7 | real_bug | logic | summary not cleared when list empties |
| c1 | noise | style | @types/dompurify deprecated -- hygiene, not a bug |
