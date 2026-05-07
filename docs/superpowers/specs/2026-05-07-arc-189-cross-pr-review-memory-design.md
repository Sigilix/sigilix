# ARC-189 — Cross-PR review memory from feedback signals — design spec

**Status:** v4 — **APPROVED** by both signers. Kimi K2.6 returned a clean APPROVE on v4. Codex returned APPROVE-WITH-CHANGES with 3 trivial wording fixes (1 MAJOR rollout-instruction clarification + 2 MINOR text consistency); all 3 folded into this final revision. No outstanding architecture items. Ready for plan v1.
**Linear:** [ARC-189](https://linear.app/arc-and-anchor/issue/ARC-189/cross-pr-review-memory-from-feedback-signals)
**Branch:** `arc-189-cross-pr-memory`
**Sibling pre-LLM scanners (already shipped):** ARC-187 secret-scan, ARC-193 deterministic-checks, ARC-186 dep-vuln, ARC-181 AST rules, ARC-188 SARIF evidence
**Sibling post-review state (already shipped):** ARC-184 review manifest + stale markers

---

## 1. Problem

Sigilix is **stateless across PRs**. The same blind spots, the same low-signal nits, the same naming-convention noise come back PR after PR. Reviewers either ignore them or reply with "not relevant" / "false positive" / "ignore" — but Sigilix has no memory of those signals and re-emits the same class of comment next time.

ARC-189 adds a **minimal cross-PR review-memory store** so Sigilix can carry learned dismissal preferences across reviews on the same `(owner, repo, path?, category)` tuple. When a team has dismissed N+ findings of class C on path P in the last 90 days, the next review's synthesizer prompt receives a `[REVIEW MEMORY]` block that says "soften class C on path P" and the synth downgrades severity + shortens the comment body. v1 is soften-only; the `drop` action is deferred to v2 once we have telemetry to tune the threshold (§4.6).

**Greptile parallel:** Greptile learns from PR-thread feedback (replies, reactions, addressed/ignored). v1 of Sigilix matches the smallest subset that's high-signal: explicit textual dismissal replies. Reactions, addressed-detection, and inferred custom rules are explicit v2+ scope.

## 2. Acceptance criteria (v1, refined)

- [ ] Storage table for review feedback memories: repo, PR, path, category, signal type, summary, timestamps. (Implemented as KV records — Workers don't have D1 wired here.)
- [ ] Synthesizer prompt includes ≤ 5 relevant memories with deterministic truncation (recency desc → dismissal count desc → category alpha).
- [ ] Memory retrieval **gated by config + env, default OFF**.
- [ ] Tests: positive retrieval (memory matches → prompt block emitted), negative (no match → omit-empty), stale memory filtering (> 180 days excluded), threshold (< 3 dismissals → not active), key derivation (path-hash + category stability).

**Done when:** an integration test simulates 3 dismissal replies on `performance`-class findings in `tests/**` across 3 PRs, then a 4th PR triggers a review and the synth prompt contains a `[REVIEW MEMORY]` block instructing it to **soften** performance findings on test files (severity downgraded one tier, body shortened, `provenance.softened[]` populated).

## 3. Non-goals (v1)

- **No reaction-based learning.** GitHub `reaction.created` is not currently subscribed. Adding it expands webhook surface; defer to v2.
- **No `pull_request_review` (approve/dismiss) learning.** Same reason — not currently subscribed. v2.
- **No "comment was silently ignored" inference from PR-merged-without-edit.** Hard to attribute dismissal vs. accept; high false-positive risk. v2 with stronger heuristics.
- **No D1 / SQL-shaped storage.** v1 ships KV-only with structured keys. D1 deferred until access-pattern is validated.
- **No cross-repo learning.** Memories are scoped to `(owner, repo)`; no `(owner, *)` aggregation.
- **No memory editing UI.** v1 is read-mostly; v2 may add `/sigilix forget category=performance` slash command.

## 4. Architecture

### 4.1 Pipeline diagram

```
              Reviewer textual reply on a Sigilix comment thread
                                 │
                                 ▼
                    pull_request_review_comment.created
                    (issue_comment.created — deferred to v2, see §4.2)
                                 │
                                 ▼
              src/lib/handle-feedback-capture.ts (NEW) — runs via ctx.waitUntil()
                                 │
              parseDismissalSignal() — keyword regex (no quote stored in v1)
                                 │
              extractParentMarker() — read sigilix:fid:<>:cat:<>:sev:<>:path:<>
                                 │
                  KV write: review-memory:<owner>/<repo>:cat:<category>
                  KV write: review-memory:<owner>/<repo>:path:<pathSha256>:cat:<category>
                                 │
                                 ▼
                    [TTL 90d, append-on-read JSON shape]


                       Next PR review on same repo
                                 │
                                 ▼
                  triage-pr-review-ensemble.ts orchestrator
                                 │
                       resolveReviewMemoryConfig()
                       env-gate: OPENCLAW_REVIEW_MEMORY_ENABLED=on
                       config-gate: reviewMemory.enabled === true
                                 │
                                 ▼
              src/lib/review-memory/lookup.ts — runReviewMemoryLookup()
                  reads KV by (owner, repo, path?, category) keys
                  filters: ≥3 signals, ≤180d age, dedupe by category
                  caps: ≤5 memories, ≤200 tokens of rendered prompt
                                 │
                                 ▼
              renderReviewMemoryForPrompt(memories) → string block
                                 │
                                 ▼
                synthMessageWithMemory = `${synthMessageWithSarif}
                                          \n\n[REVIEW MEMORY — historical dismissals]
                                          \n${block}`
```

### 4.2 New webhook handler: `handle-feedback-capture.ts`

Dispatched from the existing `pull_request_review_comment.created` queue handler via `ctx.waitUntil(captureFeedback(...))` so KV read-modify-write does NOT block the webhook response or the review-trigger pipeline. Capture failure is best-effort and never propagates.

**v1 scope: ONLY `pull_request_review_comment.created` thread replies.** The event includes `in_reply_to_id` that points unambiguously at the parent inline comment, so parent detection is O(1) without thread traversal.

`issue_comment.created` (top-of-PR conversation replies) is **deferred to v2.** Top-level conversation comments don't carry an `in_reply_to_id` — distinguishing "reply to Sigilix" from "any other comment" requires walking `GET /repos/.../issues/<n>/comments` to find the closest preceding Sigilix comment by timestamp, which is brittle (multi-author interleaving) and adds an API call per webhook. We accept the v1 coverage gap; v2 will add it once we have telemetry on inline-vs-conversation reply ratios per repo. Estimated coverage loss: ~30-40% of dismissal replies based on a sampling pass on this repo's PR history.

**Idempotency (best-effort):** keyed by `(owner, repo, prNumber, commentId)` — a `feedback-capture-seen:<commentId>` 7-day marker dedupes webhook retries when the marker is already visible. Workers KV does not provide CAS, so two simultaneous deliveries of the same commentId can both pass the seen-check and both write a signal — at-most-one is NOT guaranteed. The 90-day signal window + threshold of 3 absorbs both same-comment double-writes (one extra signal does not change activation behavior) and different-comment race losses (§4.5 documents the activation-lag-by-one-review consequence). Tests cover concurrent delivery (§10).

### 4.3 Sigilix comment marker format

Every Sigilix-authored review comment (existing inline-comment posters in `triage-pr-review-ensemble.ts` + `pr-review-poster.ts`) gets a hidden HTML marker appended to the comment body:

```
<!-- sigilix:fid:abc1234567890ab:cat:performance:sev:warning:path:d4e5f6a7b8c9 -->
```

- `fid` — first **16 hex chars** of SHA-256 of `(ruleId|nullId, path, line, headline)`. 64-bit space, birthday-bound collision becomes material at ~4B markers across all repos — non-issue at any realistic scale. Deduplication key.
- `cat` — public-facing **category** label: `security` / `logic` / `performance` / `tests`. Note: this is the public name; the codebase also has an internal `roleHint` field that maps 1:1 onto these values today, but the marker uses `cat` so future internal renames don't require a marker migration.
- `sev` — `info` / `warning` / `error`.
- `path` — first **12 hex chars** of SHA-256 of the repo-relative file path. 48-bit space, birthday-bound collision risk ~1 in 16M for a 100-file repo, ~1 in 7000 for a 1M-file mono-repo. Acceptable for v1; KV keys use full SHA-256 (§4.4) for the precise dedupe.

Existing comment audit-markers (e.g., ARC-181's `<!-- ast/<ruleId>/<pathSha12>/<line> -->`) coexist; the new marker is in addition.

**Why two hash widths (12 vs 16):** the marker length budget pushes back on adding bytes (every Sigilix comment carries it), but `fid` collisions corrupt the dismissal-correlation primary key, so `fid` gets the wider 16. `path` is only used for human-debug telemetry + as a marker hint; the authoritative path key is the full SHA-256 in KV (§4.4).

### 4.4 Memory storage shape

KV namespace: existing `OPENCLAW_STATE`. Two parallel keyspaces, each value carrying its own `schemaVersion` so we can evolve the JSON shape without re-keying:

**Category-only (repo-wide):**
```
key:   review-memory:<owner>/<repo>:cat:<category>
TTL:   90d (refreshed on every write)
value: {
  "schemaVersion": 1,
  "category": "performance",
  "signals": [
    { "ts": "2026-04-12T18:30:11Z", "prNumber": 42, "fid": "abc1234567890ab",
      "kind": "dismissed-textual" }
  ],
  "lastUpdatedTs": "..."
}
```

**Path + category (file-scoped):**
```
key:   review-memory:<owner>/<repo>:path:<pathSha256>:cat:<category>
TTL:   90d
value: { same shape, scoped to one path; full SHA-256 prevents collision pollution at scale }
```

**No `evidenceQuote` field in v1.** Privacy review (Codex MAJOR + Kimi MAJOR on v1) flagged the redaction list as too narrow: the secret-scan regex set covers tokens but not reviewer names, emails, JIRA IDs, internal hostnames, service names, or any other free-text PII. Rather than ship an under-spec'd PII redactor, v1 stores ONLY the structured fields above. v2 may revisit with a real PII regex bundle.

**Key versioning:** the `:v1:` segment is dropped from keys; schema migration is value-driven via the `schemaVersion` field. Listing/migration is a single-prefix scan over `review-memory:<owner>/<repo>:`. A future v2 schema reads existing v1 JSON, transforms in place, and bumps `schemaVersion`; key shape never changes.

**Append-on-read** strategy: each write reads existing JSON, appends a new signal, prunes signals older than 180 days, re-writes with refreshed TTL.

**Cap on signals per key:** 50 entries. On overflow, drop **oldest** entries first (FIFO) since older signals are already filtered out by the 90d / 180d age filters anyway. Reservoir sampling is a v2 candidate if telemetry shows hot-key saturation eviction.

### 4.5 Activation thresholds

A memory is "**active**" — i.e., eligible to inject into the prompt — when:

- `signals.filter(s => s.kind === "dismissed-textual" && ageDays(s.ts) ≤ 90).length >= 3`
- AND (for path-scoped only) at least one signal in the last 30 days

Both thresholds are constants in v1; tunable via env in v2 if FP rate forces it.

**Best-effort activation under KV eventual consistency.** A signal written ≤ 60s before the next review's lookup may not yet be visible (Workers KV's read-after-write window). The acceptance test treats this as expected behavior: activation may lag by one review when the threshold-3 signal is the most recent write. We do not attempt CAS or read-after-write fences; the 90d/180d windows mean a single delayed activation is recoverable on the next PR. Telemetry events `review-memory-lookup-ran` includes `memoriesFound` so we can correlate activation lag if it ever matters.

### 4.6 Retrieval + render

`runReviewMemoryLookup({owner, repo, paths, env}) → ReviewMemoryFinding[]`:

1. For each unique `category` in `["security", "logic", "performance", "tests"]`, fetch the category-only key.
2. For each path in `paths` (the PR's reviewable files), fetch each path+category combination (parallel via `Promise.allSettled`, capped at 16 in-flight).
3. Filter to active memories per §4.5.
4. Cap at 5 memories total, sorted by `(recency desc, signals.length desc, category asc)`.
5. Return `[{ scope: "category" | "path-category", category, pathSha12?, signalCount, lastSignalTs, suggestedAction: "soften" }]`. Note: `pathSha12` is the 12-hex truncation of the path SHA-256 — never the raw repo-relative path (consistent with §9 privacy contract).

**v1 ships `"soften"` only.** Both signers flagged hardcoded `drop` at signalCount ≥ 5 as untuned. v1 always returns `"soften"`; the synth downgrades severity by one tier and shortens the body but does not omit the finding entirely. `"drop"` is gated behind a v2 telemetry pass and a `sigilix.json` `dropThreshold` knob.

`renderReviewMemoryForPrompt(memories): string`:

- **Per-memory budget:** ≤ 25 tokens per record. Each record is rendered as a single line; if `pathDisplay` would push over 25 tokens, truncate with `…` ellipsis at a token boundary.
- **Whole-record inclusion:** the global ≤ 200-token cap is enforced AFTER per-record rendering — if including a 5th record would overflow, drop it entirely rather than truncate mid-record.
- **Format:**

```
[REVIEW MEMORY — historical dismissals on this repo]

Reviewers have repeatedly dismissed these finding classes. The synth SHOULD
soften matching findings (downgrade severity, shorten body) and include them
in `provenance.softened[]` with `reason: "review-memory/<category>[/<pathSha12>]"`.

- category=performance, scope=repo, signals=4, last=2026-04-12 → soften
- category=tests, scope=path:d4e5f6a7b8c9, signals=5, last=2026-04-30 → soften
```

Empty when no active memories — omit-empty contract matches every other deterministic block. **The rendered prompt block contains ONLY the sha12 hash, never the raw repo-relative path** — consistent with §9's privacy contract. Synth correlates the hash to the current PR's path set via `sha256(path).slice(0, 12)` at render time.

**Token-cap accounting (Kimi MINOR on v3 — math reconciliation):** the 200-token global cap covers BOTH the header prose AND per-record lines AND inter-line separators. The implementation budgets header first (~55 tokens for `[REVIEW MEMORY — ...]` heading + the `Reviewers have repeatedly dismissed...` paragraph + the `provenance.softened[]` instruction), reserving 145 tokens for content. With per-record budget ≤ 25 tokens and ≤ 5 records, content fits in `5 × 25 + 4 × 1 (separators) = 129 tokens`, leaving ~16 tokens of slack for tokenizer variance. Tests guard total rendered block size against the 200-token cap directly, not just record-line count.

### 4.7 Synthesizer prompt change

In `triage-pr-review-ensemble.ts`, after the existing `synthMessageWithSarif`, prepend (when memories present):

```ts
const reviewMemoryBlock = renderReviewMemoryForPrompt(memories)
const synthMessageWithMemory = reviewMemoryBlock.length > 0
  ? `${synthMessageWithSarif}\n\n${reviewMemoryBlock}`
  : synthMessageWithSarif
```

Synthesizer system prompt gets one new instruction (versioned):

> When `[REVIEW MEMORY]` is present, treat each entry as evidence that the team has rejected this finding class. For each matching finding (same category and same path-scope when path-scoped), downgrade severity by one tier (`error` → `warning`, `warning` → `info`, `info` stays), shorten the body, and include `{ specialist, sourceFindingId, headline, reason: "review-memory/<category>[/<pathSha12>]" }` in `provenance.softened[]`. Do NOT omit findings entirely in v1.

**No ARC-184 review-manifest schema bump needed**, but the synth-output `SynthesizerProvenance` interface DOES need a small extension. The manifest stored in KV by ARC-184 contains only review headers (sha, file-list-hash, prompt-version, model-id, target-id) — adding `softened[]` to the synth-output JSON does not touch that record.

The synth-output JSON IS strictly validated by `isValidProvenance` in `src/lib/triage-pr-review-ensemble.ts:1683` (Kimi MAJOR catch on v2 — Codex bot's parser is not permissive about extra keys). Implementation tasks:

1. Extend `SynthesizerProvenance` to add `softened?: Array<{ specialist: SpecialistRole; sourceFindingId: string; headline: string; reason: string }>`. Field is optional so synths emitting old-shape JSON (no review memory) remain valid.
2. Extend `isValidProvenance` to accept missing OR array-shape `softened` and validate item shape when present.
3. Update the synth-output renderer (the function that turns `verdict.findings[]` into comment bodies) to apply the severity-downgrade-by-one-tier transformation referenced by `softened[].sourceFindingId` BEFORE rendering. v1 renders the softened version; v2 may visualize the softening to the reader.

This is a 3-step in-file extension, not a schema/version bump. PROMPT_VERSION still goes to "2" because the synth's user message changes (review-memory block injection), not because the output schema changes.

Specialists do NOT see review memory — we want them to surface the finding and let the synth decide. This mirrors how AST + SARIF supersession is handled today.

### 4.8 PROMPT_VERSION bump

`PROMPT_VERSION` in `src/prompts/pr-review.ts` increments from current `"1"` → `"2"`. This invalidates ARC-184 review manifests on the next push — the existing stale-mark path will fire `prompt-version-changed` for any open PRs at deploy time, which on a busy install would mark a large batch of open PRs stale all at once.

**One-shot kill-switch for the deploy window:** new env `OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE` (default unset / off). When set to `on`, the stale-mark path treats `manifest.promptVersion !== current.promptVersion` as a non-trigger reason (logged, not enacted). Both signers (Codex MAJOR + Kimi MAJOR on v1) flagged "deploy in a quiet window" alone as insufficient at scale.

**Operational guardrails (Kimi MAJOR on v2 — env-as-silent-footgun risk):**

The suppression env carries a companion timestamp env `OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE_SET_AT` (UNIX seconds, set at the same time as the suppression flag). The pair-of-envs pattern matches existing ops conventions: long-lived flags (`OPENCLAW_REVIEW_MANIFEST_ENABLED`) carry no timestamp, while one-shot deploy aids carry the `_SET_AT`.

**SET_AT fail-closed semantics** (Codex MAJOR + Kimi MAJOR on v3):

| `SUPPRESS=on`, SET_AT state | Behavior |
|---|---|
| Unset | Suppression IGNORED. Emit `review-stale-prompt-version-suppress-misconfig { reason: "set-at-missing" }`. Stale-mark check runs normally. |
| Non-numeric / malformed | Same as above with `reason: "set-at-malformed"`. |
| Numeric but in the future | Same as above with `reason: "set-at-future"` (clock-skew sanity check; > 60s in future is rejected). |
| Numeric and in the past, ≤ 72h old | Suppression APPLIES. Emit heartbeat (see below). |
| Numeric and > 72h old | Suppression IGNORED (fail-safe). Emit `review-stale-prompt-version-suppressed-stale` per check. |

The fail-closed default — `IGNORED` — is the conservative branch: misconfiguration causes stale-marking to *over-fire*, never to be silently disabled.

**Heartbeat mechanism — KV-backed throttle, piggybacked on stale-mark checks** (Kimi MAJOR on v3):

Sigilix is a stateless Worker; "fire once per 24h" requires either a Cron Trigger or a deduplication key. v1 uses a deduplication key for simplicity (no cron wiring needed).

- Key: `prompt-version-suppress-heartbeat-emitted-at` in `OPENCLAW_STATE`. Value is the UNIX-seconds timestamp of the most recent heartbeat emission.
- On each stale-mark check that observes `SUPPRESS=on`, after the SET_AT validation passes, the worker reads this key. If `now - lastEmit ≥ 24h` (or key absent), it emits the heartbeat event AND writes the new `now` value with a 7-day TTL. Workers KV does not provide CAS, so two concurrent stale-mark checks crossing the 24h boundary may both emit a heartbeat. **The throttle is best-effort; duplicate heartbeats are acceptable** (alert pipelines downstream should de-duplicate on `(deployVersion, ageHours)`).
- Trade-off documented: low-traffic repos may not trigger any stale-mark check in a 24-hour window, so the heartbeat may not fire. This is acceptable because in those repos the operational risk of stale-suppression is by definition low (no PRs flowing → no PRs being incorrectly un-staled).
- After **24h** age (per `now - SET_AT`), the heartbeat log level escalates from `info` to `warn`.
- After **72h**, the suppression hits the fail-safe path above (suppression ignored entirely).

Telemetry events:
- `review-stale-prompt-version-suppressed` — per-check skip (suppression applied successfully).
- `review-stale-prompt-version-suppressed-heartbeat { ageHours, deployVersion, level: "info" | "warn" }` — at most once per 24h.
- `review-stale-prompt-version-suppressed-stale { ageHours }` — fail-safe activated past 72h.
- `review-stale-prompt-version-suppress-misconfig { reason }` — SET_AT validation failed; suppression ignored.

## 5. Config + env

### 5.1 `sigilix.json` block

```json
{
  "reviewMemory": {
    "enabled": false,
    "captureOnly": false,
    "categories": ["security", "logic", "performance", "tests"],
    "maxInjectedMemories": 5,
    "minSignalThreshold": 3,
    "maxSignalAgeDays": 90
  }
}
```

- `enabled` (default `false`) — **strict-bool true** required to enable retrieval. Defaults to false to match the ticket's "default off" requirement. Note polarity flip vs. every other scanner.
- `captureOnly` (default `false`) — when `enabled: false` AND `captureOnly: true`, the capture pipeline still writes signals to KV but retrieval is suppressed. Lets a repo build up a corpus before turning on prompt injection.
- `categories` (default all four) — opt-in subset of role hints. Empty array = all categories.
- `maxInjectedMemories` — clamp to `[1, 10]`. Default `5`.
- `minSignalThreshold` — clamp to `[2, 20]`. Default `3`.
- `maxSignalAgeDays` — clamp to `[7, 365]`. Default `90`. Stale-filter (180d hard cap on retention) is not user-configurable in v1.

### 5.2 Env vars

```
OPENCLAW_REVIEW_MEMORY_ENABLED                    # "off" | "on"  (default "off")
OPENCLAW_REVIEW_MEMORY_CAPTURE                    # "off" | "on"  (default "off")
OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE            # "off" | "on"  (default "off"; one-shot deploy aid)
OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE_SET_AT     # UNIX seconds  (companion to above; required when above="on")
```

**AND-gate semantics for both pipelines:**

| Pipeline | Runs when |
|---|---|
| **Capture** | `OPENCLAW_REVIEW_MEMORY_CAPTURE === "on"` AND (`reviewMemory.enabled === true` OR `reviewMemory.captureOnly === true`) |
| **Retrieval** | `OPENCLAW_REVIEW_MEMORY_ENABLED === "on"` AND `reviewMemory.enabled === true` |

Both pipelines require the env flag, so ops can disable globally with a single env flip without a config push. The repo's sigilix.json then opts in: `enabled: true` turns on both capture and retrieval; `captureOnly: true` turns on capture-only. Both signers (Codex BLOCKING + Kimi BLOCKING on v1) flagged the v1 OR-gate semantics as a global-kill-switch escape hatch.

**Truth table** (for ops runbook — Kimi MINOR on v1):

| env CAPTURE | env ENABLED | sigilix.enabled | sigilix.captureOnly | Capture | Retrieval |
|:---:|:---:|:---:|:---:|:---:|:---:|
| off | off | * | * | ❌ | ❌ |
| on  | off | false | false | ❌ | ❌ |
| on  | off | false | true | ✅ | ❌ |
| on  | off | true | * | ✅ | ❌ |
| on  | on  | false | * | ❌ | ❌ |
| on  | on  | true | * | ✅ | ✅ |

## 6. Telemetry

```
{ "event": "review-memory-capture-skipped", "owner", "repo", "prNumber", "commentId", "reason" }
{ "event": "review-memory-capture-written", "owner", "repo", "prNumber", "commentId", "category", "scope", "signalCount" }
{ "event": "review-memory-capture-parse-failed", "owner", "repo", "prNumber", "commentId", "reason" }
{ "event": "review-memory-capture-failed", "owner", "repo", "prNumber", "commentId", "stage", "err" }
{ "event": "review-memory-lookup-skipped", "owner", "repo", "prNumber", "reason" }
{ "event": "review-memory-lookup-ran", "owner", "repo", "prNumber", "memoriesFound", "memoriesInjected", "durationMs" }
{ "event": "review-memory-lookup-failed", "owner", "repo", "prNumber", "err" }
{ "event": "review-memory-corrupt-record", "owner", "repo", "key", "reason" }
{ "event": "review-memory-injected", "owner", "repo", "prNumber", "category", "scope", "action", "signalCount" }
{ "event": "review-memory-stale-purged", "owner", "repo", "category", "scope", "purgedCount" }
{ "event": "review-stale-prompt-version-suppressed", "owner", "repo", "prNumber" }
{ "event": "review-stale-prompt-version-suppressed-heartbeat", "ageHours", "deployVersion", "level": "info|warn|error" }
{ "event": "review-stale-prompt-version-suppressed-stale", "owner", "repo", "prNumber", "ageHours" }
{ "event": "review-stale-prompt-version-suppress-misconfig", "owner", "repo", "prNumber", "reason": "set-at-missing|set-at-malformed|set-at-future" }
```

Skip reasons: `"capture-disabled"` / `"retrieval-disabled"` / `"not-a-reply-to-sigilix"` / `"no-marker-found"` / `"no-dismissal-keyword"` / `"already-seen"` / `"no-paths-to-query"`.

`stage` (capture-failed): `"kv-read"` / `"kv-write"` / `"json-parse"` / `"marker-extract"`. Distinguishes which step in the read-modify-write pipeline failed for diagnosis.

## 7. Pre-LLM facts pipeline placement

```
secret-scan       (ARC-187)
deterministic     (ARC-193)
dep-vuln-scan     (ARC-186)
ast-rules         (ARC-181)
sarif-evidence    (ARC-188)
review-memory     (ARC-189)  ← NEW (synth-only injection)
   │
   ▼
combinedFactsBlock  = [secretScan, depVulnBlock, astBlock, sarifBlock, deterministicBlock]   (specialists)
synthMessageWithMemory = synthMessageWithSarif + reviewMemoryBlock                            (synth only)
```

## 8. Error handling

- KV read failure on capture: skip with `review-memory-capture-failed` (no retry; signal will be lost — acceptable).
- KV read failure on lookup: omit the block, emit `review-memory-lookup-failed`. Review proceeds normally.
- Parser failure on stored JSON: drop that key, emit `review-memory-corrupt-record`, do NOT inject.
- All KV operations wrapped in `Promise.allSettled` with a 5s soft timeout per call (Workers KV typically responds in < 50ms).

## 9. Privacy + safety

- **Stored data:** category, severity, finding-ID-hash, path-hash (full SHA-256 in keys, sha12 in markers), ISO timestamp, PR number, comment ID. **No `evidenceQuote` in v1.**
- **Why no quote:** both signers flagged the v1 redaction list (secret-scan regex set only) as too narrow. Reviewer names, emails, JIRA IDs, internal hostnames, service names, Slack channel names — none caught by the secret-scan regexes. Rather than ship an under-spec'd PII redactor, v1 stores ZERO free-text. The dismissal *category* alone is sufficient signal for the activation threshold; the quote was only useful for human-debug audit, which we defer to v2 with a real PII bundle.
- **No raw paths anywhere — keys, values, or rendered prompts.** v1 uses path-hash only: full SHA-256 in KV keys (precise dedupe), sha12 in the prompt block + comment markers (human-readable). The raw repo-relative path is hashed at write-time and discarded. Operator-side debugging works by computing `sha256(known_path).slice(0, 12)` and grepping telemetry for that hash. Codex MINOR on v3 caught the prior wording's self-contradiction (storage shape vs §9 prose); v4 resolves it by dropping raw-path storage entirely.
- **No reviewer identity** — comment author login is NOT persisted. Memory aggregates dismissals across reviewers.
- **No PR title or body** — only PR number is recorded for cross-reference, not the title (which often has ticket IDs and human-readable summaries).

## 10. Test plan

| Test | Asserts |
|------|---------|
| `parseDismissalSignal — keywords trigger` | "not relevant" / "false positive" / "ignore" / "noise" / "dismiss" / "won't fix" / "wontfix" / "nit" all → `kind: "dismissed-textual"` |
| `parseDismissalSignal — neutral text ignored` | "Thanks for the catch" → null |
| `parseDismissalSignal — nit prefix vs nit reply` | "nit: actually let's keep this" → null (nit-prefixed real comment); "nit" alone → dismiss |
| `extractParentMarker — found` | comment body with `<!-- sigilix:fid:abc1234567890ab:cat:performance:sev:warning:path:d4e5f6a7b8c9 -->` → parsed correctly |
| `extractParentMarker — missing` | no marker → null |
| `runReviewMemoryLookup — disabled returns empty` | env=off → `[]` |
| `runReviewMemoryLookup — captureOnly true, retrieval false` | retrieval still empty |
| `runReviewMemoryLookup — happy path` | 3+ signals on a category → returned |
| `runReviewMemoryLookup — below threshold` | 2 signals → empty |
| `runReviewMemoryLookup — 91d boundary (retained but inactive)` | 3 signals all aged 91d → not active per §4.5 (≤ 90d filter), but record is NOT purged from KV (180d retention). Empty result returned. |
| `runReviewMemoryLookup — stale purge filter` | signals all > 180d → empty AND record gets pruned at next write |
| `runReviewMemoryLookup — caps at 5` | 12 active categories → 5 returned, deterministic order |
| `renderReviewMemoryForPrompt — empty` | `[]` → `""` (omit-empty) |
| `renderReviewMemoryForPrompt — soften only in v1` | signalCount ≥ 5 → action=soften (not drop) |
| `renderReviewMemoryForPrompt — per-record budget` | 26-token rendered record → ellipsis-truncated at 25 tokens |
| `renderReviewMemoryForPrompt — global token cap` | 5 records × 35 tokens → fewer records returned (whole-record inclusion only); none truncated mid-record |
| `renderReviewMemoryForPrompt — header counts toward cap` | empty record set with bare header → block fits in 200-token cap; full 5-record set with realistic headers stays ≤ 200 |
| `triage-pr-review-ensemble — synth-only injection` | review memory NOT in specialist prompt; IS in synth prompt |
| `handle-feedback-capture — idempotency` | webhook retry on same commentId → second write skipped |
| `handle-feedback-capture — non-reply ignored` | issue_comment without parent Sigilix marker → skipped |
| `handle-feedback-capture — KV write failure` | telemetry emitted; main webhook flow doesn't crash |
| `handle-feedback-capture — concurrent delivery (bounded duplicate tolerance)` | two simultaneous deliveries of same commentId → signals recorded ≤ 2 (NOT exactly 1; KV has no CAS so both can pass the seen-check). Telemetry: at least one `capture-written` fires; at most one `capture-skipped` with reason `already-seen`. Threshold-3 absorbs the duplicate. |
| `handle-feedback-capture — sequential same-commentId delivery (idempotent)` | second delivery > seen-marker propagation window → second write skipped via `already-seen` |
| `handle-feedback-capture — best-effort under KV race` | concurrent deliveries on different commentIds writing to same key → one signal may be lost; covered by 90d/threshold-3 absorption |
| Acceptance fixture: 3-PR sequence | After 3 dismissal captures, 4th PR's synth prompt contains the memory block with `action=soften` |

## 11. Rollout plan

1. **Deploy with `OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE=on`** AND its required companion `OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE_SET_AT=$(date +%s)` (UNIX seconds at the moment of the wrangler deploy command). Both must be set in the same `wrangler secret put` step — without `SET_AT`, the §4.8 fail-closed branch fires `review-stale-prompt-version-suppress-misconfig { reason: "set-at-missing" }` and stale-marking proceeds normally, defeating the spike-mitigation goal. Also set `OPENCLAW_REVIEW_MEMORY_CAPTURE=off` and `OPENCLAW_REVIEW_MEMORY_ENABLED=off`. The suppression prevents the stale-mark spike from the PROMPT_VERSION bump (§4.8). Open PRs continue with the v1 prompt; new PRs use v2. Verify zero `review-stale-marked` events fire from prompt-version-bump alone.
2. **24h after deploy**, remove `OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE`. Stale-mark resumes normal operation; any open PRs that were NOT yet re-pushed get marked at next webhook batch — spread over reviewer activity rather than a single deploy spike.
3. **Flip `CAPTURE=on`** for 1 week. Monitor telemetry: `review-memory-capture-written` rate, `review-memory-capture-failed` rate by stage, KV-size growth (read aggregate via `wrangler kv key list --prefix=review-memory:`).
4. **Flip `ENABLED=on` for the Sigilix repo only** (single-repo dogfood) via `sigilix.json` `reviewMemory.enabled: true`. 1 week. Monitor `review-memory-injected` events; verify softened findings actually reflect dismissal patterns by sampling.
5. **After dogfood proves out**, document the toggle in README and announce to other teams.

## 12. Migration / cleanup

- No data migration — first deploy starts empty.
- **TTL semantics:** KV key TTL is set to 90 days on every write and refreshes on each subsequent write to the same key. A "hot" key on a noisy repo may live indefinitely as long as new signals keep landing. Per-signal aging is enforced at write-time: signals with `ageDays(ts) > 180` are purged from the JSON value before re-writing, and §4.5 retrieval filters at 90d. Cold keys (no writes for 90 days) auto-expire via TTL.
- v2 candidate: a `/sigilix forget --category=performance --path=tests/` slash command that deletes a memory key.

## 13. Risks + open questions (for sign-off)

1. **Marker collision risk.** Existing ARC-181 markers (`<!-- ast/<id>/<hash>/<line> -->`) are different format, so no collision. The new `sigilix:fid:...` marker is on its own line at the very end, hidden HTML. Acceptable noise.
2. **PROMPT_VERSION bump churn.** Mitigated by `OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE=on` one-shot env (§4.8 / rollout §11). Both signers' BLOCKING/MAJOR concern resolved.
3. **KV eventual consistency.** Activation may lag by one review when the threshold-3 signal is the most recent write. Documented as best-effort behavior in §4.5; acceptance test reflects this.
4. **False positives from "nit" keyword.** Match `nit` only when it's the entire reply OR followed by `.` / `!` / end-of-string; not as a prefix to a real comment ("nit: actually here's why..."). Test coverage in §10.
5. **Cross-account reviews on shared infra.** `(owner, repo)` keying is correct for forks → a fork's dismissals do NOT pollute the upstream repo's memory.
6. **Schema evolution.** Value-driven via `schemaVersion: 1`; KV key shape stable. v2 reads existing v1 JSON and transforms in place.
7. **Read-modify-write race.** Concurrent webhook deliveries on the SAME key can lose signals (one write overwrites the other). Workers KV does not support CAS in the v1 API surface; we accept best-effort under the threshold-3 absorption. Tests in §10 quantify the loss bound.
8. **`captureOnly` operator clarity.** Truth table in §5.2 + explicit note in the ops runbook.

---

## Sign-off matrix

| Reviewer | v1 Decision | v2 Decision | v3 Decision | v4 Decision |
|---|---|---|---|---|
| Codex | BLOCK | APPROVE-WITH-CHANGES (3 MAJOR + 2 MINOR) | APPROVE-WITH-CHANGES (2 MAJOR + 2 MINOR — all addressed in v4) | APPROVE-WITH-CHANGES (1 MAJOR rollout-clarif + 2 MINOR text — all folded inline) |
| Kimi K2.6 | APPROVE-WITH-CHANGES | APPROVE-WITH-CHANGES (2 MAJOR + 1 MINOR) | APPROVE-WITH-CHANGES (2 MAJOR + 1 MINOR — all addressed in v4) | **APPROVE** |

### v3 → v4 changelog

- **§4.8 + §5.2:** SET_AT fail-closed semantics tabled — missing/malformed/future/non-numeric → suppression IGNORED with `review-stale-prompt-version-suppress-misconfig` telemetry. Codex MAJOR + Kimi MAJOR.
- **§4.8:** heartbeat mechanism specified as KV-backed throttle (`prompt-version-suppress-heartbeat-emitted-at` key, 24h dedupe, piggybacked on stale-mark checks); low-traffic-repo trade-off documented. Kimi MAJOR.
- **§9:** raw paths NEVER stored — keys, values, or rendered prompts. Earlier wording self-contradicted on JSON storage; v4 drops raw path entirely. Codex MINOR.
- **§4.6:** per-record budget reduced to ≤ 25 tokens so header (55) + 5×25 records + separators ≤ 200 (with ~16 tokens of tokenizer slack). Kimi MINOR caught the math.
- **§10:** added bounded-duplicate-tolerance test (signals ≤ 2 per commentId race), sequential-idempotency test, 91d-boundary lookup test (retained but inactive), header-counts-toward-cap test. Codex MAJOR + Codex MINOR.
- **§6:** added `review-stale-prompt-version-suppress-misconfig` event.

### v2 → v3 changelog

- **§2 + §1:** AC + problem statement say "soften" only (was "drop / soften") — Codex MINOR.
- **§4.1:** removed `issue_comment.created` from pipeline diagram — Codex MAJOR.
- **§4.2:** idempotency wording softened to "best-effort dedupe" + explicit no-CAS callout — Codex MAJOR.
- **§4.6:** rendered prompt block uses `pathSha12` only (no raw path) consistent with §9 — Codex MAJOR. Token-cap accounting clarified to include header prose — Kimi MINOR.
- **§4.7:** clarified `provenance.softened[]` requires a 3-step `SynthesizerProvenance` interface + validator + renderer extension (NOT just a permissive parser) — Kimi MAJOR after re-reading `isValidProvenance`.
- **§4.8:** added `OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE_SET_AT` companion env + heartbeat events at 24h/72h escalation + 72h hard fail-safe — Kimi MAJOR.
- **§5.2 + §6:** new env + new telemetry events (`*-heartbeat`, `*-stale`).
- **§12:** TTL semantics clarified — key TTL refreshes per write, per-signal pruning at 180d — Codex MINOR.

### v1 → v2 changelog

- **§4.1 + §4.2:** capture moved to `ctx.waitUntil()`; v1 scope clarified to ONLY `pull_request_review_comment.created` (issue_comment deferred to v2 with documented coverage gap of 30-40%); KV best-effort under concurrent deliveries (no CAS).
- **§4.3:** marker hashes bumped — `fid` sha7 → sha16; `path` sha7 → sha12. Renamed `roleHint` → public `category` everywhere.
- **§4.4:** dropped `:v1:` from KV keys (schema versioning is value-driven via `schemaVersion`); KV-key paths now use full SHA-256, markers use sha12 for human readability; removed `evidenceQuote` from v1 storage entirely (privacy redaction list too narrow).
- **§4.5:** activation explicitly best-effort under KV eventual consistency; one-review activation lag documented.
- **§4.6 + §4.7:** v1 ships `"soften"` only (`drop` deferred until telemetry); per-memory token budget ≤40 tokens with whole-record inclusion only; synth instruction softens severity by one tier into `provenance.softened[]`.
- **§4.8:** added `OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE` one-shot deploy env to absorb stale-mark spike.
- **§5.1:** removed `dropThreshold` since v1 is soften-only; renamed `roleHint` → `category` in config field too.
- **§5.2:** AND-gate semantics tightened — capture requires `env CAPTURE=on AND (enabled=true OR captureOnly=true)`; added truth table.
- **§6:** added `review-memory-capture-failed`, `review-memory-lookup-failed`, `review-memory-corrupt-record`, `review-stale-prompt-version-suppressed` events.
- **§9:** explicit no-quote-stored statement; no PR title/body persisted.
- **§10:** added "nit prefix vs nit reply" test, per-record budget test, global token cap test, concurrent-delivery race tests (idempotency-bound and best-effort-loss-bound).
- **§11:** rollout adds explicit prompt-version-suppression deploy phase.
- **§13:** risks updated to reflect v2 mitigations.
