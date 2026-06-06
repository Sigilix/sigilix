# Reviewer worksheet — Sigilix/sigilix-e2e-frontend#13

https://github.com/Sigilix/sigilix-e2e-frontend/pull/13

Sigilix flagged **5**; CodeRabbit flagged **7**.

Label each *real-world issue* once in the table at the bottom. If both bots flagged the same issue, put both refs in one row and use a `both_*` label. Leave a finding out of the table only if it is a pure duplicate of a row you already wrote.

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

## Labels

<!-- label    ∈ sigilix_only_real_bug | sigilix_only_noise | cr_only_real_bug | cr_only_noise | both_real | both_noise -->
<!-- category ∈ security | perf | logic | tests | style -->
<!-- findings: comma-separated refs, e.g. s1,c3 -->

| findings | label | category | note |
|----------|-------|----------|------|
| s2,c3 | both_real | security | both flagged ActivityFeed dangerouslySetInnerHTML XSS |
| s4,c6 | both_real | security | both flagged NotificationsPanel innerHTML XSS |
| s1 | sigilix_only_real_bug | perf | N+1 fetches per feed item |
| s3 | sigilix_only_real_bug | security | CommentThread jQuery .html() XSS |
| s5 | sigilix_only_real_bug | logic | stale bodyHtml race in preview effect |
| c2 | cr_only_real_bug | security | activity API returns untrusted HTML |
| c4 | cr_only_real_bug | security | DigestBanner XSS |
| c5 | cr_only_real_bug | security | EmbedCard iframe XSS |
| c7 | cr_only_real_bug | logic | summary not cleared when list empties |
| c1 | cr_only_noise | style | @types/dompurify deprecated -- hygiene, not a bug |
