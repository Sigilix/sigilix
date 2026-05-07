# ARC-189 — Cross-PR review memory — implementation plan v2

**Status:** v3 — **APPROVED** with 6 trivial inline fixes folded. Codex v2 BLOCK on 2 plan typos (Task 9 commentId / Task 10a gate condition); Kimi v2 APPROVE-WITH-CHANGES on 2 MINOR. All 6 fixes applied inline below; both signers said "Yes, ready to start implementation."
**Spec:** `docs/superpowers/specs/2026-05-07-arc-189-cross-pr-review-memory-design.md` (v4 APPROVED)
**Branch:** `arc-189-cross-pr-memory`
**Linear:** [ARC-189](https://linear.app/arc-and-anchor/issue/ARC-189/cross-pr-review-memory-from-feedback-signals)

**v1 → v2:** v1 received BLOCK (Codex) + APPROVE-WITH-CHANGES (Kimi). Combined 8 unique BLOCKING items + 5 MAJOR + 4 MINOR. v2 addresses all of them — see "v1 → v2 changelog" at the end of this doc. Verifications against the actual repo were performed for every BLOCKING item before rewriting.

---

## 0. Sequencing principle

Strictly TDD per task per the `feedback_per_task_workflow` rule. Each task: tests-first → impl → tsc clean → CR pass → commit. Per-task README updates (per the `feedback_readmes_per_directory` rule), not batched. Most tasks are one commit; integration tasks may split into impl + CR-fix-pass.

## 1. Repo verification facts (informing this plan)

Verified against `arc-189-cross-pr-memory` head before authoring v2:

- **KV namespace:** `OPENCLAW_STATE` is the existing binding in `wrangler.toml` (line 5). **NO new KV binding required**; we reuse it. Plan adds documentation to `wrangler.toml` comments + README only.
- **Test infra:** `tests/_test-utils/` does NOT exist. Existing tests use inline mocks (`as unknown as GitHubClient` per `sigilix.json` guidance + lightweight stub functions in each test file). v2 follows this pattern; no shared `kv-mock.ts` is created.
- **PrReviewFinding shape:** `score: number` clamped to `[1, 5]` (`src/lib/triage-pr-review.ts:108`). NOT a string severity. Soften = score decrement, NOT severity-tier-downgrade.
- **`StaleResult` shape:** `{ stale: boolean; reasons: StaleReason[] }` where `StaleReason = "head" | "base" | "file-list" | "prompt-version"` (`src/lib/review-manifest.ts:159`). Suppression filters the `reasons` array; stale-marking proceeds when other reasons remain.
- **Synth provenance consumer:** ONE site (`src/lib/triage-pr-review-ensemble.ts:1893` — `synthOutput.provenance.findings[i]`). Single in-file consumer; no other module reads `provenance` directly.
- **Existing GH client surface:** `listPullRequestReviewComments(owner, repo, prNumber)` exists at `src/lib/github.ts:225`. Single-comment getter does NOT exist; v2 adds `getPullRequestReviewComment(owner, repo, commentId)` as part of the marker-fetch path.
- **Webhook handler `pull_request_review_comment.created`:** dispatched from `src/index.ts:1143`. The webhook payload includes `comment.in_reply_to_id` (a number) but does NOT include the parent comment body — the marker fetch needs an explicit GH API call.
- **Existing comment posting body site:** `src/lib/triage-pr-review-ensemble.ts:707` (`body: meta.body ?? ""`). The marker emission happens at the body-construction site that feeds `submitReview`.

## 2. Dependency graph

```
                              Task 1 (types)
                                    │
        ┌────────────┬───────────┬──┴─────────────┬─────────────┐
        ▼            ▼           ▼                ▼             ▼
    Task 2        Task 3       Task 4          Task 7         Task 8
   (marker)   (parse-dismiss) (storage)       (config)      (env wiring)
        │            │           │                │             │
        │            │           ▼                │             │
        │            │       Task 5 ────────┐     │             │
        │            │       (lookup)       │     │             │
        │            │           │          │     │             │
        │            │           ▼          │     │             │
        │            │       Task 6         │     │             │
        │            │       (render)       │     │             │
        │            │           │          │     │             │
        │            ▼           ▼          ▼     ▼             ▼
        ▼      Task 9 (capture pipeline) ────────────┐
    Task 2.5  ┌──────────┴────────────────┐          │
    (marker   │                           │          │
   emission   │     Task 10a              │      Task 11
   on posted  │  (ensemble synth          │ (stale-mark suppress
    comments) │   wiring + telemetry)     │   ONLY prompt-version)
              │           │               │
              │     Task 10b              │
              │  (provenance.softened     │
              │   + score decrement       │
              │   + PROMPT_VERSION="2")   │
              │           │               │
              └───────────┴───────────────┘
                          │
                          ▼
              Task 12 (acceptance + dogfood + final docs)
```

Key insight from the v1 review: **Task 2.5 (marker emission on posted comments) is a NEW task** — without it, captures would never find a parent marker and the whole pipeline would silently no-op (Codex BLOCKING B1).

## 3. Task list (13 tasks)

### Task 1 — `src/lib/review-memory/types.ts` (NEW)

**Outputs:**
- `ReviewMemoryCategory = "security" | "logic" | "performance" | "tests"` literal union.
- `ReviewMemorySignal = { ts: string; prNumber: number; fid: string; kind: "dismissed-textual" }`.
- `ReviewMemoryRecord = { schemaVersion: 1; category: ReviewMemoryCategory; pathSha256?: string; signals: ReviewMemorySignal[]; lastUpdatedTs: string }`.
- `ReviewMemoryFinding = { scope: "category" | "path-category"; category: ReviewMemoryCategory; pathSha12?: string; signalCount: number; lastSignalTs: string; suggestedAction: "soften" }`.
- `ResolvedReviewMemoryConfig` shape per spec §5.1 (post-defaults).
- `SigilixCommentMarker = { fid: string; cat: ReviewMemoryCategory; sev: "info"|"warning"|"error"; pathSha12: string }`.
- `ReviewMemoryStorageScope = { kind: "category"; category } | { kind: "path-category"; category; pathSha256 }`.

**Tests:** none (pure types). Coverage proven by downstream module tests. README: brief module purpose stub.

**Commit 1.**

### Task 2 — `src/lib/review-memory/marker.ts` (NEW)

**Depends on:** Task 1.

**Outputs:**
- `buildSigilixMarker({ ruleId, path, line, headline, category, severity }) → Promise<string>` — emits `<!-- sigilix:fid:<sha16>:cat:<cat>:sev:<sev>:path:<sha12> -->`. Uses Web-Crypto SHA-256.
- `extractSigilixMarker(commentBody: string) → SigilixCommentMarker | null` — strict regex parse; returns null on missing/malformed/extra fields.
- `computeFid({ ruleId, path, line, headline }) → Promise<string>` — sha16 of the canonical fingerprint string. Canonical form: `\`${ruleId ?? "none"}|${path}|${line}|${headline}\`` — `null`/`undefined` ruleIds resolve to the literal sentinel `"none"` so synth-emitted findings (no ruleId) get a stable fid (Codex MINOR on plan v2). Test `computeFid` with both `ruleId: "X"` and `ruleId: null` to assert different but stable hashes.
- `computePathSha256(path: string) → Promise<string>` — used by both the marker and KV-key-builder.

**Tests** (~18 cases, `tests/review-memory-marker.test.ts`):
- Same input → same marker
- Differing in any one of (ruleId, path, line, headline) → different fid
- Different path with same other fields → different `path` segment
- `extractSigilixMarker` parses a well-formed marker
- Returns null for: missing fid, missing cat, missing sev, missing path, malformed sev value, malformed cat value, marker not at end of body, multiple sigilix markers (returns last)
- Ignores ARC-181's `<!-- ast/... -->` markers (different format, won't match regex)
- Coexists with ARC-181 markers in same body
- `computeFid` matches a known SHA-256 reference for fixed input
- 16 hex chars exact length on `fid`; 12 hex chars on `path`

**Commit 2.**

### Task 2.5 — Sigilix marker emission on posted comments (EDIT) **[NEW v2 task; addresses Codex BLOCKING B1]**

**Depends on:** Task 2.

**Edits to `src/lib/triage-pr-review-ensemble.ts` near comment-body construction (line ~707):**
- For each finding-derived comment body, call `buildSigilixMarker()` with the finding's `ruleId|null`, `path`, `line`, `headline`, role-hint mapped to category, and severity tier mapped from `score`. Append marker to body on its own line.
- Severity-tier mapping for marker emission (NOT for runtime soften — different concept): `score >= 5 → "error"`, `score >= 3 → "warning"`, `score < 3 → "info"`. This is captured in `markerSeverityFromScore(score: number) → "info"|"warning"|"error"` (pure helper in `marker.ts`).
- Role-hint-to-category mapping: 1:1 today but isolated in `categoryFromRoleHint(roleHint: SpecialistRole) → ReviewMemoryCategory` for future safety.

**Tests** (~10 cases, extend `tests/triage-pr-review-ensemble.test.ts` + new section in `tests/review-memory-marker.test.ts`):
- Posted comment body ends with a sigilix marker line
- Marker preserves both ARC-181 audit marker + the new sigilix marker (both present)
- `markerSeverityFromScore` mapping table tests
- `categoryFromRoleHint` mapping table tests (4 hints × 4 categories)
- Body without marker (e.g., synthesizer-emitted summary text) gets the marker appended only if it's a finding-anchored inline comment, not the top-level review body

**README:** add a paragraph on the marker schema in `src/lib/review-memory/README.md`.

**Commit 2.5.**

### Task 3 — `src/lib/review-memory/parse-dismissal.ts` (NEW)

**Depends on:** Task 1.

**Outputs:**
- `parseDismissalSignal(body: string) → { kind: "dismissed-textual" } | null` — regex over normalized body.
- Keywords (anywhere in body, case-insensitive): `not relevant`, `false positive`, `ignore`, `noise`, `dismiss`, `won't fix`, `wontfix`. Plus `nit` only when matched as a bare reply (`/^\s*nit[.!]?\s*$/i`) — never as a prefix to a longer comment (per spec §13 risk #4).

**Tests** (~14 cases, `tests/review-memory-parse-dismissal.test.ts`):
- Each keyword in the set → dismiss
- `nit:` followed by real text → null
- `nit.` alone → dismiss; `nit` alone → dismiss; `Nit!` alone → dismiss
- Mixed-case keywords (`NOT RELEVANT`, `False Positive`) → dismiss
- Emoji-decorated text containing keyword → dismiss
- Neutral text (`Thanks for the catch`, `LGTM`, `Good point`) → null
- Empty / whitespace-only → null
- Keyword inside code fence triple-backtick block → null (regex scoped to non-code text)

**Commit 3.**

### Task 4 — `src/lib/review-memory/storage.ts` (NEW)

**Depends on:** Tasks 1, 2 (for `computePathSha256`).

**Outputs:**
- `buildKey(owner, repo, scope: ReviewMemoryStorageScope) → string` — exact spec §4.4 format (`review-memory:<owner>/<repo>:cat:<category>` for category-scope, `review-memory:<owner>/<repo>:path:<sha256>:cat:<category>` for path-category).
- `readMemory(env, owner, repo, scope) → Promise<ReviewMemoryRecord | null>` — returns null on missing key, on JSON parse failure (with telemetry), and on any KV throw.
- `appendSignal(env, owner, repo, scope, signal) → Promise<{ written: boolean; signalCount: number }>` — read-modify-write; prunes signals older than 180d; FIFO-caps at 50 signals; refreshes 90d TTL.
- `pruneStaleSignals(record, nowMs, retentionDaysHard = 180) → ReviewMemoryRecord` — pure function for testability.

**KV binding used:** existing `env.OPENCLAW_STATE`. **No `wrangler.toml` change.**

**Tests** (~22 cases, `tests/review-memory-storage.test.ts`, KV mocked inline per the existing convention):
- `buildKey` cases (category, path-category)
- `readMemory` returns null on missing, parses on present
- `readMemory` returns null on corrupt JSON + emits `review-memory-corrupt-record` telemetry
- `appendSignal` creates record on first signal; appends on subsequent
- `appendSignal` refreshes TTL on every write
- `appendSignal` prunes 181d signals at write time
- `appendSignal` FIFO-caps at 50 (51st write drops oldest by ts)
- `pruneStaleSignals` pure: same inputs → same outputs
- KV failure on read → null result + `review-memory-lookup-failed` telemetry; throw not propagated
- KV failure on write → `review-memory-capture-failed { stage: "kv-write" }`; throw not propagated
- Schema-version mismatch (e.g. `schemaVersion: 99`) treated as corrupt-record

**Commit 4.**

### Task 5 — `src/lib/review-memory/lookup.ts` (NEW)

**Depends on:** Tasks 1, 4.

**Outputs:**
- `runReviewMemoryLookup({ env, owner, repo, prNumber, paths, config }) → Promise<{ skipped: true; reason: ReviewMemorySkipReason; findings: [] } | { skipped: false; findings: ReviewMemoryFinding[]; durationMs: number }>`.
- Internal pure helper `isMemoryActive(record, config, nowMs) → boolean` per spec §4.5.
- Internal pure helper `selectTopMemories(findings, maxN = 5) → ReviewMemoryFinding[]` — sorts by (recency desc, signalCount desc, category asc); caps at maxN.

**Tests** (~20 cases, `tests/review-memory-lookup.test.ts`):
- `retrieval-disabled-env` skip when env off
- `retrieval-disabled-config` skip when sigilix.json `enabled: false`
- captureOnly=true, retrieval flags off → `retrieval-disabled-config`
- Empty paths → `no-paths-to-query`
- 3 fresh signals on category → 1 active finding
- 2 signals → not active
- All signals 91d (boundary) → not active (Codex MINOR catch on v3 spec)
- All signals > 180d → not active (and lookup doesn't prune; that's append-time)
- Path-category requires ≥1 signal in trailing 30d
- 12 active categories → 5 returned, deterministic order
- Categories filter: `config.categories: ["security"]` → only security memories returned (Kimi MAJOR on v1 plan)
- KV read failures don't crash; emit `review-memory-lookup-failed`; return empty
- `Promise.allSettled` parallelism asserted via mock call-count

**Commit 5.**

### Task 6 — `src/lib/review-memory/render.ts` (NEW)

**Depends on:** Task 1.

**Outputs:**
- `renderReviewMemoryForPrompt(memories: ReviewMemoryFinding[]) → string` — empty string when memories empty (omit-empty contract).
- Internal `estimateTokens(s: string) → number` — 4-chars-per-token approximation matching the rest of the codebase.

**Token budget per spec §4.6:** ≤25 tokens per record, ≤200 total (header ≈55 + 5×25 records + separators ≤200, with ~16 tokens slack).

**Tests** (~12 cases, `tests/review-memory-render.test.ts`):
- Empty input → ""
- 1 record → header + 1 line
- 5 typical records → ≤200 tokens
- Per-record budget: 26-token rendered record → ellipsis-truncated at 25 at a token boundary
- Whole-record inclusion: 5×35 records → fewer records returned, none truncated mid-record
- Header counts toward cap: header-only block fits ≤55 tokens
- Block emits `pathSha12` only, NEVER raw paths (regex assertion against any `/`-containing path-display)
- Deterministic output for same input
- `provenance.softened` instruction line present in header

**Commit 6.**

### Task 7 — `sigilix-config.ts` `reviewMemory` config (EDIT)

**Depends on:** Task 1.

**Edits to `src/lib/sigilix-config.ts`:**
- Add `reviewMemory?: { enabled?: boolean; captureOnly?: boolean; categories?: ReviewMemoryCategory[]; maxInjectedMemories?: number; minSignalThreshold?: number; maxSignalAgeDays?: number }` to `SigilixConfig`.
- Parser: strict-bool (`enabled === true`, `captureOnly === true`); clamp `maxInjectedMemories ∈ [1, 10]` (default 5), `minSignalThreshold ∈ [2, 20]` (default 3), `maxSignalAgeDays ∈ [7, 365]` (default 90); dedupe + filter `categories` against the literal-union set.
- New resolver: `resolveReviewMemoryConfig(config: SigilixConfig | null) → ResolvedReviewMemoryConfig`.

**Tests** (~14 cases, `tests/sigilix-config-review-memory.test.ts`):
- Default config → `enabled: false, captureOnly: false`, all clamps at defaults, all 4 categories implicit
- `enabled: true` literal → enabled
- Strict bool: truthy non-bool (`1`, `"true"`) → false
- `captureOnly: true` standalone → captureOnly true, enabled false
- `categories: ["security", "bogus"]` → bogus dropped
- `categories: []` → all 4 implied
- All clamps: 0/100/-1/999 inputs all clamped per range
- All-bad config (every field wrong type) → all defaults

**Commit 7.**

### Task 8 — `Env` interface + env validation (EDIT)

**Depends on:** none (parallelizable with Tasks 2/3/4/5/6/7).

**Edits to `src/index.ts`:**
- Extend `Env` with `OPENCLAW_REVIEW_MEMORY_ENABLED?: string`, `OPENCLAW_REVIEW_MEMORY_CAPTURE?: string`, `OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE?: string`, `OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE_SET_AT?: string`.
- Validation: each accepts `"on" | "off" | undefined`; non-conforming values emit `review-memory-config-rejected` and treated as off (matches existing env-validation precedent in `index.ts`).
- Add wrangler.toml comment block documenting the new env vars near existing `[vars]` section. **No KV binding addition.**

**Tests** (extend existing env-validation suite):
- Each new env accepts on/off/undefined
- Non-conforming values treated as off + telemetry fires

**Commit 8.**

### Task 9 — Capture pipeline via `ctx.waitUntil()` (EDIT/NEW) **[architectural — see B5 fix below]**

**Depends on:** Tasks 1, 2 (marker.extract), 3 (parse-dismissal), 4 (storage), 7 (config), 8 (env).

**New file `src/lib/review-memory/capture.ts`:**
- Export `captureReviewFeedback(args) → Promise<void>` (resolves on best-effort completion; never throws).
- Steps:
  1. Resolve IDs from webhook payload: `replyCommentId = payload.comment.id` (used for dedupe + signal `commentId` field), `parentCommentId = payload.comment.in_reply_to_id`. **Require parentCommentId to be a number**; if absent (top-level review comment, not a reply), emit `not-a-reply` skip + exit.
  2. Gate-check: env CAPTURE on AND (sigilix.json `enabled === true` OR `captureOnly === true`); else emit skip + exit.
  3. Read seen-marker `feedback-capture-seen:<replyCommentId>`; if present → emit `already-seen` skip + exit.
  4. **Fetch parent comment body** via new `client.getPullRequestReviewComment(owner, repo, parentCommentId)` (NOT replyCommentId — Codex BLOCKING on plan v2). The webhook payload only carries `in_reply_to_id`, not the parent body.
  5. Call `extractSigilixMarker(parentBody)`; null → emit `not-a-reply-to-sigilix` skip + exit.
  6. Call `parseDismissalSignal(replyBody)`; null → emit `no-dismissal-keyword` skip + exit.
  7. Write seen-marker FIRST (best-effort dedupe; spec §4.2 documented as no-CAS).
  8. In parallel via `Promise.allSettled`, write category-scope and path-category-scope signals.
  9. Emit `capture-written` telemetry.

**New method on `GitHubClient` (in `src/lib/github.ts`):**
- `getPullRequestReviewComment(owner, repo, commentId): Promise<{ id: number; body: string; user: { login: string } | null; in_reply_to_id?: number }>` — wraps `GET /repos/{owner}/{repo}/pulls/comments/{commentId}` (the standalone single-comment endpoint per GitHub REST API).
- 1 unit test in the github-client suite for the path/headers shape.

**Edits to existing webhook dispatcher in `src/index.ts:1143` (the `pull_request_review_comment.created` branch):**
- After existing mention-parsing + review-trigger logic, IFF gates are on, dispatch `ctx.waitUntil(captureReviewFeedback(args))` so KV work never blocks the webhook response or the review-trigger pipeline.

**Tests** (~20 cases, `tests/review-memory-capture.test.ts`):
- Gate disabled via env → no KV touched
- Gate disabled via config → no KV touched
- captureOnly=true (env capture on, enabled false) → captures
- Happy path: parent has marker, reply has dismiss keyword → both KV writes + `capture-written`
- Parent fetch returns 404 → `parent-fetch-failed` telemetry; no KV writes; no throw
- Parent has no marker → `not-a-reply-to-sigilix`; no KV writes
- Reply has no dismiss keyword → `no-dismissal-keyword`; no KV writes
- `feedback-capture-seen` already present → `already-seen` skip
- Sequential delivery (same commentId after seen-marker propagation) → second write skipped
- **Concurrent delivery (bounded duplicate tolerance):** two simultaneous deliveries of same commentId → signals recorded ≤ 2 (NOT exactly 1; KV no-CAS); both telemetry events fire
- KV write failure on category scope → `capture-failed { stage: "kv-write" }` for category; path-scope still attempts
- Webhook throw cannot propagate out (best-effort) — wrap-in-try assertion
- `getPullRequestReviewComment` mocked at the GH-client surface

**Commit 9 (impl + tests). Likely commit 9b for CR fix-pass.**

### Task 10a — Ensemble synth wiring + telemetry (EDIT) **[Codex MAJOR: split from v1 Task 10]**

**Depends on:** Tasks 5, 6, 7.

**Edits to `src/lib/triage-pr-review-ensemble.ts`:**
- Import `runReviewMemoryLookup` and `renderReviewMemoryForPrompt`.
- After the existing `synthMessageWithSarif` block, gate on `cfg.enabled === true && env.OPENCLAW_REVIEW_MEMORY_ENABLED === "on"` and call lookup with `filePaths`.
- Render block; build `synthMessageWithMemory` by appending the memory block IFF the memory block itself is non-empty (NOT gated on whether SARIF was non-empty — Codex BLOCKING on plan v2):
  ```ts
  const synthMessageWithMemory = memoryBlock.length > 0
    ? `${synthMessageWithSarif}\n\n${memoryBlock}`
    : synthMessageWithSarif
  ```
- Replace `userMessage: synthMessageWithSarif` → `userMessage: synthMessageWithMemory` in the synth call site.
- Add to `EnsembleTelemetry`: `reviewMemory?: { skipped: true; reason: ReviewMemorySkipReason; findingsCount: 0 } | { skipped: false; findingsCount: number; memoriesInjected: number; durationMs: number }`.
- **Specialist prompt UNCHANGED** — review memory is synth-only per spec §4.7.

**Tests** (extend `tests/triage-pr-review-ensemble.test.ts` ~6 cases):
- Specialist prompts contain NO review-memory block
- Synth prompt contains review-memory block when active memories
- Synth prompt unchanged when retrieval skipped
- Telemetry `reviewMemory` populated correctly on each gate/path

**Commit 10a.**

### Task 10b — `provenance.softened[]` interface + score-decrement renderer + PROMPT_VERSION="2" (EDIT)

**Depends on:** Task 10a.

**Edits to `src/lib/triage-pr-review-ensemble.ts`:**
- Extend `SynthesizerProvenance` to add `softened?: Array<{ specialist: SpecialistRole; sourceFindingId: string; headline: string; reason: string }>`. Optional → backward compatible.
- Update `isValidProvenance` (line 1683) to validate softened item shape when present (mirror existing `dropped` validation pattern).

**Edits to the post-synth comment-rendering site (line ~1893):**
- Build a Set of `softened.sourceFindingId` strings.
- For each finding being rendered: if its source ID is in the softened set, compute `effectiveScore = Math.max(1, finding.score - 1)` into a local variable and pass that to the render function. **Do NOT mutate `finding.score`** (Kimi MINOR on plan v2 — preserve immutability of the original `PrReviewFinding` so downstream telemetry/manifest reflects the synth's actual emitted score, not the post-softening score).
- This is `score`-based, NOT severity-tier-based — verified `PrReviewFinding.score: number ∈ [1,5]` (Codex BLOCKING B2 fix).

**Edits to synth system prompt in `src/prompts/pr-review.ts`:**
- Append the §4.7 instruction: when `[REVIEW MEMORY]` is present, emit `provenance.softened[]` entries for matching findings; do NOT omit findings entirely in v1.
- **Bump `PROMPT_VERSION` from `"1"` to `"2"`.** This invalidates all open-PR review manifests on first deploy; the rollout sequence in §11 sets `OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE=on` BEFORE this bump lands.

**Tests** (extend ~10 cases):
- `provenance.softened` missing → valid (backward compat)
- `provenance.softened: []` → valid
- Valid softened item → accepted; malformed item (missing field, wrong type) → rejected
- Score-decrement applied: finding with `score: 4` referenced in softened → renders with score 3
- `score: 1` referenced in softened → renders with score 1 (clamp)
- Finding NOT in softened set → score unchanged
- PROMPT_VERSION constant equals "2"

**Commit 10b.**

### Task 11 — Stale-mark prompt-version suppression (EDIT) **[Codex BLOCKING B3 fix]**

**Depends on:** Task 8 (env vars defined).

**Edits to `src/lib/triage-pr-stale-mark.ts`:**
- After the existing `detectReviewStale(...)` call returns `staleResult.reasons`, evaluate `evaluatePromptVersionSuppression(env, now)`:
  - SET_AT validation table (spec §4.8) returns one of `"off" | "applies" | "set-at-missing" | "set-at-malformed" | "set-at-future" | "set-at-stale"`.
- If `suppression.applies`: **filter `"prompt-version"` out of `staleResult.reasons`**, NOT skip stale-marking entirely. If filtered reasons are non-empty (head/base/file-list still drift), proceed with stale-marking using the filtered reasons. If filtered reasons are empty, skip stale-marking and emit `review-stale-prompt-version-suppressed`.
- If `applies: false` and `reason !== "off"`: emit corresponding misconfig/stale telemetry; stale-marking proceeds with the original reasons (fail-closed default).
- KV-backed heartbeat throttle (key `prompt-version-suppress-heartbeat-emitted-at`, **intentionally a global singleton — NOT owner/repo-scoped — because the suppression env is process-wide, not per-repo**, per Kimi MINOR on plan v2). 7-day TTL, 24h dedupe. Best-effort under no-CAS — duplicate heartbeats are acceptable. 24h+ → log level `warn`; 72h+ → fail-safe activates (`applies: false, reason: "set-at-stale"`).

**Tests** (~16 cases, `tests/triage-pr-stale-mark-suppression.test.ts`):
- Env unset → `applies: false, reason: "off"`; no telemetry; full reasons fire
- env on, SET_AT unset → `set-at-missing`; misconfig telemetry; full reasons fire
- env on, SET_AT non-numeric → `set-at-malformed`
- env on, SET_AT 2 minutes in future → `set-at-future` (clock-skew sanity > 60s)
- env on, SET_AT 1h ago, ONLY prompt-version reason → suppressed; skip; `review-stale-prompt-version-suppressed`
- env on, SET_AT 1h ago, head + prompt-version reasons → stale-marking proceeds with `reasons: ["head"]`; `prompt-version-suppressed` also fires alongside
- env on, SET_AT 25h ago → applies; heartbeat at warn level
- env on, SET_AT 73h ago → fail-safe: `set-at-stale`; original reasons fire normally
- Heartbeat KV throttle: 2 checks within 24h → 1 heartbeat
- Concurrent checks crossing 24h → up to 2 heartbeats (best-effort)

**Commit 11.**

### Task 12 — Acceptance test + dogfood + final docs (NEW/EDIT)

**Depends on:** Tasks 1, 2, 4, 5, 6, 9, 10a, 10b.

**New `tests/review-memory-acceptance.test.ts`:**
- Direct module call style (NOT full webhook E2E — Codex MAJOR catch on v1 plan): construct an in-memory KV mock + `client.getPullRequestReviewComment` mock returning fixture parents with sigilix markers.
- Sequence:
  1. Call `captureReviewFeedback(...)` 3 times with synthetic webhook payloads on `tests/utils.ts` performance findings, each reply containing a dismissal keyword.
  2. Assert KV state: 1 category-scope record + 1 path-category-scope record, each with 3 signals.
  3. Call `runReviewMemoryLookup(...)` for a hypothetical 4th PR with paths `["tests/utils.ts"]`. Assert returns 1 path-category finding with `signalCount: 3, suggestedAction: "soften"`.
  4. Call `renderReviewMemoryForPrompt(...)` and assert the block contains the soften instruction + the path's sha12 (NOT the raw path).
  5. Manually thread the rendered block into a synthMessageWithMemory string and assert its presence (full ensemble run is not invoked — that's an integration concern out of scope for this acceptance).

**Edits to `sigilix.json`:**
- Dogfood entry: `"reviewMemory": { "enabled": true, "categories": ["performance", "tests"], "maxInjectedMemories": 5, "minSignalThreshold": 3, "maxSignalAgeDays": 90 }`. `enabled: true` is intentional ONLY on the Sigilix repo per rollout phase 4 (§11). Capture in production starts after phase 3 env flip.

**Edits to `README.md`:**
- Final overview pass: add a 3-paragraph "Cross-PR review memory (ARC-189)" section + a `### reviewMemory` config block reference. Per-task README updates from Tasks 2.5/4/5/6/9/10/11 already cover the per-module surface; this is the user-facing overview.

**Commit 12.**

## 4. Cross-cutting concerns

### 4.1 PROMPT_VERSION="2" rollout (deploy-time, NOT a code task)

Rollout sequence (out of band of the PR; documented in PR description):

1. Set BOTH env vars in the same rollout shell script — note this is **two `wrangler secret put` invocations**, not one combined call:
   ```bash
   echo on | wrangler secret put OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE
   date +%s | wrangler secret put OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE_SET_AT
   ```
2. Merge the ARC-189 PR (Task 10b lands `PROMPT_VERSION="2"`).
3. Wait 24h; verify zero `review-stale-marked` events fire from prompt-version-bump alone.
4. Remove both envs (also two invocations: `wrangler secret delete ...`).
5. Then proceed to phase 3 of spec §11 (flip CAPTURE=on for 1 week of telemetry).

### 4.2 Test infrastructure

- No shared `tests/_test-utils/` directory is created.
- KV mocks: each test file authors a local `makeKvStub()` matching the existing pattern. The recurring shape is small (`get`, `put`, `delete` on an in-memory `Map`) so duplication is acceptable.
- GH client mocks: continue using `as unknown as GitHubClient` casts on per-test stubs (per `sigilix.json` guidance).

### 4.3 Backward compatibility

- `provenance.softened[]` is OPTIONAL → old synth outputs validate.
- `sigilix.json` without `reviewMemory` → defaults (all features off).
- KV records carry `schemaVersion: 1` → value-driven schema migration path (spec §4.4).
- Existing review-comment posting is **semantically unchanged** for repos with the feature off, but bodies do gain an inert HTML marker line at the end (per Task 2.5 — markers are emitted unconditionally so that the capture pipeline can find them whenever CAPTURE flips on later, without retroactively re-posting comments). When CAPTURE=off the marker is just an unused HTML comment that humans don't see in rendered Markdown.

### 4.4 Per-task README placement

- `src/lib/review-memory/README.md` (NEW): created in Task 1 with module overview; updated in Task 2 (marker), Task 3 (parse-dismissal), Task 4 (storage), Task 5 (lookup), Task 6 (render), Task 9 (capture). One README living next to the module sources.
- Top-level `README.md`: per-task touches when user-facing config surface changes (Tasks 7 + 12), plus the final overview in Task 12.

## 5. Risk gates

Per-task quality gates (per `feedback_per_task_workflow`):
1. Tests authored first (file exists + initially red).
2. tsc clean (`npx tsc --noEmit`).
3. All tests pass.
4. CodeRabbit local pass: `coderabbit review --plain -t uncommitted`.
5. Per-task commit (no batching; integration tasks may split into impl + CR-fix-pass).
6. README updated in same commit.

## 6. Estimated commits

- Tasks 1, 2, 2.5, 3, 4, 5, 6, 7, 8: 9 commits (one each).
- Task 9: 1–2 commits (impl + likely CR fix-pass).
- Task 10a: 1 commit.
- Task 10b: 1 commit (the prompt-version bump).
- Task 11: 1–2 commits.
- Task 12: 1 commit.

**Total:** ~14–16 commits. Branch `arc-189-cross-pr-memory` is already cut from current main (commit `aa5a166`).

## 7. Out of scope (explicit deferrals to v2)

- `issue_comment.created` thread reply support (spec §4.2).
- Reaction-based dismissal capture (`reaction.created` webhook subscription).
- `pull_request_review.dismissed` event subscription.
- `"drop"` action (vs current soften-only).
- D1-backed storage (KV-only in v1).
- Cross-repo memory aggregation.
- `/sigilix forget` slash command.
- PII redactor for an `evidenceQuote` field (we don't store the quote at all in v1).
- Cron Trigger for daily heartbeat (KV-backed throttle in v1).

---

## v1 → v2 changelog

**BLOCKING fixes (Codex 5 + Kimi 5; some overlap → 8 unique items addressed):**

1. **Codex B1 (NEW Task 2.5):** added explicit task wiring `buildSigilixMarker()` into the posted-comment body construction site at `src/lib/triage-pr-review-ensemble.ts:707`. Without this, capture would silently no-op forever.
2. **Codex B2:** soften = score decrement (`Math.max(1, score - 1)`), NOT severity-tier-downgrade. Verified `PrReviewFinding.score: number ∈ [1,5]` at `src/lib/triage-pr-review.ts:108`.
3. **Codex B3 (Task 11 reformulated):** stale-mark suppression now FILTERS `"prompt-version"` out of the `reasons[]` array; only skips stale-marking when that's the only reason. Other drift (head/base/file-list) still fires during the deploy window.
4. **Codex/Kimi B4:** dropped fictional `tests/_test-utils/kv-mock.ts`. Verified does not exist; v2 follows the existing inline-mock convention.
5. **Codex/Kimi B5:** added `getPullRequestReviewComment` method to `GitHubClient` (Task 9.5 inline). Webhook payload only carries `in_reply_to_id`; parent body needs explicit GH API fetch.
6. **Kimi B1:** dependency graph corrected — Task 1 strictly precedes Tasks 2/3/4/6/7. Tasks 5/9/10/11 dependencies pinned.
7. **Kimi B2:** KV namespace explicitly callout — reuse `OPENCLAW_STATE`, no `wrangler.toml` change.
8. **Kimi B5 (provenance audit):** verified single consumer at `triage-pr-review-ensemble.ts:1893`; no other modules read `provenance` directly.

**MAJOR fixes:**

- Task 10 split into 10a (ensemble wiring) + 10b (provenance.softened + score decrement + PROMPT_VERSION bump) for review-isolation.
- Task 12 acceptance reformulated as direct module calls (NOT full webhook E2E).
- Rollout §4.1 explicit: TWO `wrangler secret put` invocations, not one.
- Task 5 added category-filter test (Kimi MAJOR on v1 plan).
- Task 11 insertion point pinned: AFTER `detectReviewStale`, BEFORE any stale-mark side effects.
- Hidden parallelism noted: Tasks 10/11 disjoint files, may run concurrently if needed.

**MINOR fixes:**

- README placement distributed per-task (per `feedback_readmes_per_directory`), not batched in Task 12.
- Module file naming follows existing repo convention (`review-memory/marker.ts`, `review-memory/storage.ts` — domain-named like `review-manifest.ts`).
- Test count budgets clamped to per-task discipline; redundant happy-path cases trimmed.

---

## Sign-off matrix

| Reviewer | v1 Decision | v2 Decision | v3 Decision |
|---|---|---|---|
| Codex | BLOCK (5 BLOCKING + 5 MAJOR + 4 MINOR) | BLOCK (2 BLOCKING typo-level + 2 MINOR — all folded inline in v3) | **APPROVED via inline fixes** |
| Kimi K2.6 | APPROVE-WITH-CHANGES (5 BLOCKING + 5 MAJOR + 3 MINOR) | APPROVE-WITH-CHANGES (2 MINOR — all folded inline in v3) | **APPROVED via inline fixes** |

### v2 → v3 changelog (all inline-folded text fixes, no architecture changes)

- **Codex BLOCKING:** Task 9 — fetch parent via `parentCommentId = payload.comment.in_reply_to_id`, NOT the reply's own commentId. Reply's id is for dedupe + signal storage.
- **Codex BLOCKING:** Task 10a — gate memory append on `memoryBlock.length > 0` (was wrongly gated on `sarifBlock.length > 0` — copy-paste bug).
- **Codex MINOR:** §4.3 wording — "semantically unchanged" with inert HTML marker, not "unchanged."
- **Codex MINOR:** Task 2 — `computeFid` canonicalizes null `ruleId` to literal `"none"` sentinel.
- **Kimi MINOR:** Task 10b — softened-finding rendering uses a local `effectiveScore` variable; do NOT mutate `PrReviewFinding.score`.
- **Kimi MINOR:** Task 11 — heartbeat throttle key is intentionally a global singleton (env-driven, not owner/repo-scoped).
