# ARC-184 — Implementation plan

**Status:** v3 — fully dual-signed-off (Codex + Kimi APPROVE-WITH-CHANGES, all blocking + major findings addressed)
**Spec:** `docs/superpowers/specs/2026-05-06-arc-184-review-provenance-stale-markers-design.md` (v3, fully signed off)
**Branch:** `arc-184-review-provenance`

Tasks are independent micro-commits — each ends in a tsc-clean + green-test commit so any task can be reviewed (and rolled back) in isolation. TDD where it pays; pure-modules first, integration glue last.

---

## Task 1: `PROMPT_VERSION` constant in `src/prompts/pr-review.ts`

**Files:** `src/prompts/pr-review.ts`

- [ ] Add `export const PROMPT_VERSION = "1"` immediately above `PR_REVIEW_PROMPT`.
- [ ] Add a docblock on `PROMPT_VERSION`: "Bump on substantive scope/style changes — typo fixes do NOT bump. Mismatch against the recorded value drives the ARC-184 stale marker."
- [ ] Run `npx tsc --noEmit`. Expected: clean.
- [ ] Commit: `feat(arc-184): export PROMPT_VERSION on the pr-review prompt`

---

## Task 2: `review-manifest.ts` — schema + KV serdes with tagged read result (TDD)

**Files:** `src/lib/review-manifest.ts`, `tests/review-manifest.test.ts`

Codex spec catch (BLOCKING #2 on plan v1): a bare `null` return loses the reason needed for `review-manifest-invalid` telemetry. Returning a tagged result preserves that.

- [ ] **Step 1: failing tests.** Add `tests/review-manifest.test.ts` with cases for:
  - `readReviewManifest` returns `{kind: "missing"}` for unknown PR
  - returns `{kind: "ok", manifest}` with the parsed v1 record (target.kind = "review")
  - returns `{kind: "ok", manifest}` with target.kind = "issue-comment"
  - returns `{kind: "invalid", reason: "wrong-version"}` on `v: 2` (forward-compat — caller treats as missing for stale-mark, logs as invalid for telemetry)
  - returns `{kind: "invalid", reason: "shape"}` on missing `headSha` / `target` / etc.
  - returns `{kind: "invalid", reason: "json-parse"}` on JSON parse error
  - returns `{kind: "missing"}` on KV read error (rare; never throws to caller)
  - `writeReviewManifest` round-trips through fakeKV — `readReviewManifest` returns `{kind: "ok", manifest}` matching the input
  - write failures are swallowed (KV `put` throws; function returns false rather than throwing)
- [ ] **Step 2: implementation.** Mirror the structure of `src/lib/incremental-review.ts`. Export `ReviewManifestV1`, `ReviewTarget`, `ReadResult = {kind: "ok", manifest} | {kind: "missing"} | {kind: "invalid", reason: "wrong-version" | "shape" | "json-parse"}`, `readReviewManifest`, `writeReviewManifest`. KV key prefix `pr-review-manifest:`. TTL 30 days.
- [ ] **Step 3:** `npx tsc --noEmit && npx vitest run tests/review-manifest.test.ts` — all pass.
- [ ] Commit: `feat(arc-184): review-manifest schema + tagged read result for telemetry`

---

## Task 3: `review-manifest.ts` — drift predicate (TDD)

**Files:** `src/lib/review-manifest.ts`, `tests/review-manifest.test.ts`

- [ ] **Step 1: failing tests.** Add a `describe("detectReviewStale")` block:
  - returns `{stale: false}` when manifest === current on all four fields
  - returns `{stale: true, reasons: ["head"]}` on head SHA differing
  - returns `{stale: true, reasons: ["base"]}` on base SHA differing
  - returns `{stale: true, reasons: ["file-list"]}` on file-list-hash differing
  - returns `{stale: true, reasons: ["prompt-version"]}` on prompt-version differing
  - returns multiple reasons when more than one differs
  - **Head-SHA short-circuit** (KV consistency mitigation per spec §13a-1): when `manifest.headSha === current.headSha`, return `{stale: false}` regardless of other deltas
- [ ] **Step 2: implementation.** Pure function `detectReviewStale(manifest, current) → {stale, reasons[]}`.
- [ ] **Step 3:** tests pass.
- [ ] Commit: `feat(arc-184): drift predicate detectReviewStale`

---

## Task 4: `review-manifest.ts` — file-list-hash helper (TDD)

**Files:** `src/lib/review-manifest.ts`, `tests/review-manifest.test.ts`

- [ ] **Step 1: failing tests.** Add `describe("computeFileListHash")` block:
  - empty file list → stable, deterministic hex digest
  - single file (no rename) → expected hash
  - multiple files unsorted in input → same hash regardless of input order
  - rename (filename + previous_filename) hashes differently from added new file with same final name
  - removed-status file is included
  - >3000-cap path returns sentinel `sha256:overflow:<count>`
  - asserts the exact serialization format (`filename\0previous_filename\n`-delimited, sorted) via a known fixture
- [ ] **Step 2: implementation.** Use Web-Crypto subtle digest (`crypto.subtle.digest("SHA-256", ...)`) — Worker-runtime safe; no Node-only APIs. Return hex string. **Ownership note (Kimi MINOR #5):** the helper itself accepts `{overflow: boolean, entries}` and returns either the hex digest OR the `sha256:overflow:<count>` sentinel — caller decides what to pass; the helper does the formatting. Keeps the integration site readable and the helper pure (no scattered sentinel construction).
- [ ] **Step 3:** tests pass; `npx tsc --noEmit` clean.
- [ ] Commit: `feat(arc-184): computeFileListHash with rename + overflow handling`

---

## Task 4a: drift predicate — overflow + invalid-reason coverage (TDD additions)

**Files:** `tests/review-manifest.test.ts`

Codex plan catch (MAJOR #7): overflow semantics need explicit drift coverage; otherwise the `sha256:overflow:<count>` carve-out is just a comment.

- [ ] Add to `describe("detectReviewStale")`:
  - `overflow-vs-overflow` (both manifest and current have `sha256:overflow:N`) → drift on file-list **NOT** detected (we can't compare overflows reliably; rely on head/base instead)
  - `overflow-vs-normal` → drift on file-list **NOT** detected for the same reason; head/base/prompt-version still detect normally
  - `normal-vs-overflow` → same as above
- [ ] Verify the existing drift tests still pass.
- [ ] Commit: `test(arc-184): drift predicate — overflow file-list semantics`

---

## Task 5: `review-manifest.ts` — stale-block render + idempotency (TDD)

**Files:** `src/lib/review-manifest.ts`, `tests/review-manifest.test.ts`

- [ ] **Step 1: failing tests.** Add `describe("applyStaleBlock")`:
  - inserts after the leading `<!-- openclaw:pr-review -->` marker when no prior block exists
  - replaces an existing block in place (idempotent — running it twice is the same as once)
  - re-application doesn't accumulate blank lines
  - body without the openclaw marker prepends the block
  - 65000-char limit: when body + block would exceed, truncates body and appends a "review body truncated" pointer
  - rejects accidental marker-like prose in code blocks (literal-marker contract)
- [ ] **Step 2: implementation.** `renderStaleBlock(manifest, current)` returns the bracketed block string; `applyStaleBlock(body, block)` applies the regex per spec §6 idempotency-replacement-algorithm pseudocode.
- [ ] **Step 3:** tests pass.
- [ ] Commit: `feat(arc-184): renderStaleBlock + applyStaleBlock with literal-marker idempotency`

---

## Task 6: GitHub client surface — add `getReview`, `updateReviewBody`, `getIssueComment` (TDD)

**Files:** `src/lib/github.ts`, `tests/github.test.ts` (add coverage if it exists; otherwise add a focused mocked-fetch test in a new file)

- [ ] **Step 1: failing tests.** Mock the underlying `restGet` / `restPatch` and assert each new method targets the right endpoint with the right body shape.
- [ ] **Step 2: implementation.**
  - `getReview(owner, repo, prNumber, reviewId): Promise<{ body: string } | null>` — null on 404.
  - `updateReviewBody(owner, repo, prNumber, reviewId, body): Promise<void>` — PATCH `/repos/{o}/{r}/pulls/{n}/reviews/{id}` with `{ body }`.
  - `getIssueComment(owner, repo, commentId): Promise<{ body: string } | null>` — null on 404.
  - `updateIssueComment` already exists (§4 of spec confirmed); reuse it.
- [ ] **Step 3:** tsc + tests pass.
- [ ] Commit: `feat(arc-184): GitHub client — getReview, updateReviewBody, getIssueComment`

---

## Task 7: Sticky-summary footer (Reviewed against `<sha>` at `<ts>`) (TDD)

**Files:** `src/lib/triage-pr-review.ts`, `tests/triage-pr-review.test.ts`

- [ ] **Step 1: failing tests.** Snapshot/assert that:
  - `formatReviewBody` output ends with `_Reviewed against \`<headShort>\` at <ISO timestamp>._\n` (regex match)
  - `buildFallbackBody` output also ends with the same line
  - Body is well-under 65000 chars after the addition (no truncation triggered on a small fixture)
  - **Writer-side cap** (Codex MINOR #9): when synthesizing a body whose summary + findings would push past 65000 with the footer attached, the writer truncates the *summary/findings*, NOT the footer. Test with a forced-large `summary` ≥ 64000 chars and assert: (a) the footer is intact in the output; (b) total length ≤ 65000; (c) the truncated section ends with a marker `_[summary truncated to fit GitHub's 65535 limit]_`.
- [ ] **Step 2: implementation.** Pass `headSha` + `now()` (or `Date.now()` when not provided) into both renderers; append the line just above the closing marker. Apply cap at writer time.
- [ ] **Step 3:** All triage-pr-review tests pass; tsc clean.
- [ ] Commit: `feat(arc-184): sticky summary footer with reviewed-at SHA + timestamp + writer cap`

---

## Task 7b: GitHub client — `listPullFilesForManifest` + `getMergeBase` (TDD)

**Files:** `src/lib/github.ts`, `tests/github.test.ts`

Codex plan catch (BLOCKING #1: helper must exist before Task 8 uses it; MAJOR #3: merge-base helper missing entirely from plan v1).

- [ ] **Step 1: failing tests for `listPullFilesForManifest`.** Mock pagination:
  - 100 + 100 + 47 items → 247 returned with `{filename, previous_filename, status}` only
  - exactly-100 page-1 + 0 on page-2 → 100 returned, no overflow
  - 30 full pages of 100 items → returns first 3000 entries with `overflow: true` + `entries: 3000` (does NOT continue past page 30)
  - rename items carry `previous_filename`
  - removed items carry `status: "removed"`
- [ ] **Step 2: implementation.** `listPullFilesForManifest(owner, repo, prNumber): Promise<{overflow: boolean, entries: Array<{filename, previous_filename: string | null, status}>}>`. Drains `?per_page=100&page=N` until `< 100` or page > 30. Distinct from existing `listPullRequestFiles` (which is capped at 50 and used elsewhere — leave that helper untouched).
- [ ] **Step 3: failing tests for `getMergeBase`.** Mock `/repos/{o}/{r}/compare/{base}...{head}` with `application/vnd.github+json`:
  - 200 with `{merge_base_commit: {sha: "abc1234"}}` → returns `"abc1234"`
  - 200 with no `merge_base_commit` → returns null
  - 404 → returns null
  - 422 → returns null (force-push from unrelated history)
- [ ] **Step 4: implementation.** `getMergeBase(owner, repo, base, head): Promise<string | null>` — best-effort; never throws.
- [ ] **Step 5:** tests pass; tsc clean.
- [ ] Commit: `feat(arc-184): listPullFilesForManifest + getMergeBase helpers`

---

## Task 8: Manifest write on submitReview success (TDD; single-agent path)

**Files:** `src/lib/triage-pr-review.ts`, `tests/triage-pr-review.test.ts`

Codex plan catch (MAJOR #6: assert the FULL manifest per Linear AC #1, not just a subset).

- [ ] **Step 1: failing tests.** Add a test: handler with mocked `submitReview` returning `{id: 4242}`, mocked `listPullFilesForManifest` returning a fixture file list, mocked `getMergeBase` returning a fixture SHA, and `writeReviewManifest` stub. Assert the stub is called once with EVERY manifest field set:
  - `v: 1`
  - `prNumber` (matches input)
  - `baseSha`, `headSha`, `mergeBaseSha` (from inputs/mocks)
  - `fileListHash` (matches `computeFileListHash(fixture)`)
  - `promptVersion` (matches `PROMPT_VERSION`)
  - `modelId` (matches the configured model env)
  - `target: { kind: "review", reviewId: 4242 }`
  - `reviewedAt` ≈ `Date.now()`
- [ ] Add a test for telemetry: `review-manifest-written` log fires with `{owner, repo, prNumber, headSha, baseSha, modelId, promptVersion, target}` (per spec §12).
- [ ] Add a test: KV write throws → `review-manifest-write-failed` log fires; review still succeeds.
- [ ] **Step 2: implementation.** After `client.submitReview(...)` returns successfully, fetch file list via `listPullFilesForManifest`, fetch merge-base via `getMergeBase`, build the manifest, then call `writeReviewManifest` inside try/catch. Failures go to `review-manifest-write-failed` telemetry; do NOT abort the review.
- [ ] **Step 3:** tests pass; full `npm test` pass.
- [ ] Commit: `feat(arc-184): write review manifest after successful submitReview (single-agent path)`

---

## Task 9: Manifest write on submitReview success (ensemble + 422-fallback paths)

**Files:** `src/lib/triage-pr-review-ensemble.ts`, `tests/triage-pr-review-ensemble.test.ts`

- [ ] Mirror Task 8 for the ensemble path. Two write sites:
  - Successful `submitReview` (post mode) → `target: { kind: "review", reviewId }`
  - 422 fallback that posts as issue comment → `target: { kind: "issue-comment", commentId }`
- [ ] Shadow mode does NOT write a manifest (per spec §8) — assert no `writeReviewManifest` call when mode is shadow.
- [ ] Add tests for both successful paths with full manifest assertion (same shape as Task 8 step 1).
- [ ] Commit: `feat(arc-184): write manifest from ensemble + 422-fallback paths`

---

## Task 10: Stale-mark queue handler `triage-pr-stale-mark.ts` (TDD)

**Files:** `src/lib/triage-pr-stale-mark.ts`, `tests/triage-pr-stale-mark.test.ts`

Codex plan catch (MAJOR #5: §5 eventual-consistency retry path; MAJOR #8: BOTH target kinds; MINOR #10: marker round-trip regression).

- [ ] **Step 1: failing tests.** Mock GitHub client + KV. Cases:
  - manifest missing at re-read → no-op + `review-manifest-missing`
  - manifest invalid (e.g. `kind: "invalid", reason: "shape"`) → no-op + `review-manifest-invalid` with the reason
  - manifest's `reviewedAt` newer than the snapshot → no-op + `review-stale-superseded`
  - drift predicate returns false (head-match short-circuit) → no-op + `review-stale-not-detected`
  - drift true, **review-target** GET returns 404 → `review-stale-target-missing`
  - drift true, **issue-comment-target** GET returns 404 → `review-stale-target-missing`
  - drift true, **review-target** GET returns body → `applyStaleBlock` + `updateReviewBody` PATCH called once with the new body, then `review-stale-marked` { target: { kind: "review", id }, reasons }
  - drift true, **issue-comment-target** GET returns body → `applyStaleBlock` + `updateIssueComment` PATCH called once, then `review-stale-marked` { target: { kind: "issue-comment", id }, reasons }
  - PATCH returns 5xx → `review-stale-mark-failed { status }`, retry-bubbled
  - PATCH returns 403 → `review-stale-mark-failed { status: 403 }` and NO retry (operator-visible permission gap)
  - **Eventual-consistency retry**: `listPullFilesForManifest` returns empty entries on first call AND the PR has commits ahead of base. Handler retries up to 3 times with 1s back-off, emitting `review-stale-current-state-empty-retry { attempt: 1|2|3 }`. After 3 retries, abort with `review-stale-mark-failed { reason: "empty-files-after-retry" }`.
  - **Marker round-trip regression** (spec §15a): a body containing literal `<!-- sigilix:stale-marker:start -->...<!-- sigilix:stale-marker:end -->` already inserted by a prior pass. Handler replaces the block in place — body length doesn't grow each run; markers don't accumulate.
- [ ] **Step 2: implementation.** Per spec §9.
- [ ] **Step 3:** tests pass.
- [ ] Commit: `feat(arc-184): handlePrStaleMark — drift detection + non-destructive PATCH for both target kinds`

---

## Task 11: `index.ts` — `pr-stale-mark` JobMessage + dispatch case + webhook enqueue (TDD on dispatch)

**Files:** `src/index.ts`, `tests/decide-pr-jobs.test.ts`

Kimi plan catch (MAJOR #3): `currentPromptVersion` MUST be in the job payload — consumer must not re-read the prompt file because it may have been redeployed between enqueue and consume.

- [ ] **Step 1: failing tests.** Extend `decide-pr-jobs.test.ts` (or add a new webhook integration test if cleaner):
  - synchronize action for an open PR with non-draft + base/head + an existing manifest in KV → enqueues both `pr-review` and `pr-stale-mark`
  - the `pr-stale-mark` payload includes `manifestSnapshot` (from KV) AND `currentPromptVersion` (from local constant) AND `newHeadSha` AND `newBaseSha`
  - synchronize action with NO existing manifest → enqueues only `pr-review` (no stale-mark)
  - opened action → enqueues only `pr-review` (no stale-mark; nothing to be stale)
  - edited action with NO base change → behaves same as synchronize (enqueues both when manifest exists)
- [ ] **Step 2: implementation.**
  - Add `pr-stale-mark` to the `JobMessage` union with the shape from spec §9, including `currentPromptVersion: string`.
  - Add a dispatch case in the queue handler that calls `handlePrStaleMark` and passes `currentPromptVersion` through.
  - In the webhook handler `pull_request` branch, after `decision.review`, read the manifest from KV (best-effort try/catch). When a manifest exists AND the action is `synchronize` or `edited`, enqueue `pr-stale-mark` alongside `pr-review` with `currentPromptVersion = PROMPT_VERSION` from `src/prompts/pr-review.ts`.
- [ ] **Step 3:** tsc clean; `npm test` clean.
- [ ] Commit: `feat(arc-184): webhook enqueues pr-stale-mark with prompt-version pin alongside pr-review`

---

## Task 12: Kill-switch `OPENCLAW_REVIEW_MANIFEST_ENABLED`

**Files:** `src/index.ts`, `src/lib/review-manifest.ts`, `tests/review-manifest.test.ts`

- [ ] Add the env var to the `Env` interface in `src/index.ts`.
- [ ] In the read/write paths of `review-manifest.ts`, short-circuit (return null / no-op) when `env.OPENCLAW_REVIEW_MANIFEST_ENABLED !== "on"` AND the value is set to anything else (default treated as `"on"` for backwards-compat).
- [ ] In the webhook enqueue path, skip the stale-mark enqueue when disabled.
- [ ] Tests cover both: enabled (writes manifest) and explicit-off (no manifest write).
- [ ] Commit: `feat(arc-184): OPENCLAW_REVIEW_MANIFEST_ENABLED kill-switch`

---

## Task 13: README + telemetry doc updates

**Files:** `README.md`, `docs/` if any operator docs exist

- [ ] Add a "Review provenance + stale markers (ARC-184)" section to README explaining the manifest, drift triggers, the kill-switch, the App-permission requirement (`pull_requests: write` + `issues: write`).
- [ ] Note the in-flight-review race + KV consistency caveats from spec §13a so operators can interpret edge-case telemetry.
- [ ] Commit: `docs(arc-184): README — review-manifest + stale-marker reference`

---

## Task 14: Final integration pass — typecheck, lint, full test, CodeRabbit, push PR

- [ ] `npx tsc --noEmit` — expect clean.
- [ ] `npm test` — expect clean. Test count delta: ~+50 (manifest serdes, drift, file-list-hash, render, github client, two triage paths, stale-mark handler, decide-pr-jobs).
- [ ] `coderabbit review --plain --type committed --base main` — triage findings.
- [ ] `gh pr create` with body that includes `Closes ARC-184` + per-task summary table.
- [ ] **Operator follow-up note in PR body:** confirm `issues: write` permission on the Sigilix GitHub App.

---

## Self-review checklist (before presenting for sign-off)

- [ ] **Spec coverage:** every numbered section in the spec maps to ≥1 task.
- [ ] **Type names** consistent across declaration & call sites: `ReviewManifestV1`, `ReviewTarget`, `ReadResult`, `detectReviewStale`, `computeFileListHash`, `renderStaleBlock`, `applyStaleBlock`, `readReviewManifest`, `writeReviewManifest`, `handlePrStaleMark`, `listPullFilesForManifest`, `getMergeBase`.
- [ ] **No premature abstraction** — each helper is justified by ≥1 caller.
- [ ] **No Node-only API** — Web-Crypto for SHA-256, fetch via the existing GitHubClient.
- [ ] **No new dependency.**
- [ ] **TDD where it pays:** tasks 2-7b, 8-10. Tasks 1, 11-13 are integration glue or trivially small.

---

## Sign-off summary

### Codex (v1 → v2)

| Codex finding | v2/v3 change |
|---|---|
| **[BLOCKING #1]** Task 8 uses `listPullFiles` from Task 10 (broken atomicity) | New Task 7b adds `listPullFilesForManifest` + `getMergeBase` BEFORE Task 8 (now uses both helpers). Task 10 in v1 is gone. |
| **[BLOCKING #2]** `readReviewManifest` returning bare `null` loses telemetry reason | Task 2 now returns tagged `ReadResult` with `kind: "missing" \| "ok" \| "invalid"` + `reason`. |
| **[MAJOR #3]** Merge-base helper missing | Task 7b explicitly adds `getMergeBase`. |
| **[MAJOR #4]** Telemetry coverage gaps | Tasks 8/9/10 now assert `review-manifest-written`, `review-manifest-write-failed`, `review-manifest-missing`, `review-manifest-invalid`, `review-stale-detected`. |
| **[MAJOR #5]** Empty-file-list eventual-consistency retry | Task 10 adds the 3-attempt retry test with `review-stale-current-state-empty-retry`. |
| **[MAJOR #6]** Task 8/9 manifest assertion too thin | Task 8 now asserts every manifest field per Linear AC. |
| **[MAJOR #7]** Overflow drift tests missing | New Task 4a covers overflow-vs-overflow / overflow-vs-normal cases. |
| **[MAJOR #8]** Both target-kind PATCH coverage | Task 10 covers BOTH review and issue-comment GET/PATCH paths separately, including 404/403. |
| **[MINOR #9]** Footer 65k truncation untested | Task 7 adds the writer-side cap test with truncation marker. |
| **[MINOR #10]** Marker round-trip regression test | Task 10 adds the marker-replace-in-place test (idempotent re-application). |
| **[NIT #11]** Permission summary inconsistency | Spec v3 already corrected (sign-off summary clean). |

### Kimi (v2 → v3)

| Kimi finding | v3 change |
|---|---|
| **[BLOCKING #1]** Task ordering (same as Codex BLOCKING #1) | Already addressed via Task 7b. |
| **[MAJOR #2]** Missing telemetry events | Already addressed in Tasks 8/9/10 via Codex MAJOR #4. |
| **[MAJOR #3]** `pr-stale-mark` payload missing `currentPromptVersion` | Task 11 now explicitly includes `currentPromptVersion` in the JobMessage shape and the consumer signature. |
| **[MINOR #4]** Writer 65k truncation untested (same as Codex MINOR #9) | Already addressed in Task 7. |
| **[MINOR #5]** Overflow sentinel ownership ambiguous | Task 4 clarified: `computeFileListHash` accepts the overflow flag and returns either hex or sentinel — single source of truth. |
