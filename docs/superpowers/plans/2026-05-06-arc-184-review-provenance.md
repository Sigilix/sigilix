# ARC-184 — Implementation plan

**Status:** DRAFT v1 — pending dual sign-off (Kimi + Codex)
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

## Task 2: `review-manifest.ts` — schema + KV serdes (TDD)

**Files:** `src/lib/review-manifest.ts`, `tests/review-manifest.test.ts`

- [ ] **Step 1: failing tests.** Add `tests/review-manifest.test.ts` with cases for:
  - `readReviewManifest` returns null for unknown PR
  - returns the parsed v1 record on hit (target.kind = "review")
  - returns the parsed v1 record with target.kind = "issue-comment"
  - returns null on `v: 2` (forward-compat)
  - returns null on shape mismatch (missing `headSha` etc.)
  - returns null on JSON parse error
  - `writeReviewManifest` round-trips through fakeKV and is readable by `readReviewManifest`
  - write failures are swallowed (KV `put` throws; function does not)
- [ ] **Step 2: implementation.** Mirror the structure of `src/lib/incremental-review.ts`. Export `ReviewManifestV1`, `ReviewTarget`, `readReviewManifest`, `writeReviewManifest`. KV key prefix `pr-review-manifest:`. TTL 30 days (reuse the `TTL_SECONDS` literal).
- [ ] **Step 3:** `npx tsc --noEmit && npx vitest run tests/review-manifest.test.ts` — all pass.
- [ ] Commit: `feat(arc-184): review-manifest schema + KV serdes`

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
- [ ] **Step 2: implementation.** Use Web-Crypto subtle digest (`crypto.subtle.digest("SHA-256", ...)`) — Worker-runtime safe; no Node-only APIs. Return hex string.
- [ ] **Step 3:** tests pass; `npx tsc --noEmit` clean.
- [ ] Commit: `feat(arc-184): computeFileListHash with rename + overflow handling`

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
- [ ] **Step 2: implementation.** Pass `headSha` + `now()` (or `Date.now()` when not provided) into both renderers; append the line just above the closing marker.
- [ ] **Step 3:** All triage-pr-review tests pass; tsc clean.
- [ ] Commit: `feat(arc-184): sticky summary footer with reviewed-at SHA + timestamp`

---

## Task 8: Manifest write on submitReview success (TDD; single-agent path)

**Files:** `src/lib/triage-pr-review.ts`, `tests/triage-pr-review.test.ts`

- [ ] **Step 1: failing tests.** Add a test: handler returns the review.id from a mocked `submitReview`, and the writeReviewManifest stub is called once with a manifest containing that review.id, the headSha, the PROMPT_VERSION, and a non-empty fileListHash.
- [ ] **Step 2: implementation.** After `client.submitReview(...)` returns successfully, compute the file-list-hash (reuse the helper, fetch the file list from a new helper that wraps `/pulls/{n}/files` — already wanted in §5 of spec), then call `writeReviewManifest` inside try/catch. Failures go to `review-manifest-write-failed` telemetry; do NOT abort the review.
- [ ] **Step 3:** tests pass; full `npm test` pass.
- [ ] Commit: `feat(arc-184): write review manifest after successful submitReview (single-agent path)`

---

## Task 9: Manifest write on submitReview success (ensemble + 422-fallback paths)

**Files:** `src/lib/triage-pr-review-ensemble.ts`, `tests/triage-pr-review-ensemble.test.ts`

- [ ] Mirror Task 8 for the ensemble path. Two write sites:
  - Successful `submitReview` (post mode) → `target: { kind: "review", reviewId }`
  - 422 fallback that posts as issue comment → `target: { kind: "issue-comment", commentId }`
- [ ] Shadow mode does NOT write a manifest (per spec §8).
- [ ] Add tests for both paths.
- [ ] Commit: `feat(arc-184): write manifest from ensemble + 422-fallback paths`

---

## Task 10: GitHub `pulls/files` paginated fetch helper (TDD)

**Files:** `src/lib/github.ts`, `tests/github.test.ts`

- [ ] **Step 1: failing tests.** Mock pagination: 100 items + 100 items + 47 items → 247 returned. Assert hash-input shape matches what `computeFileListHash` consumes.
- [ ] **Step 2: implementation.** `listPullFiles(owner, repo, prNumber): Promise<Array<{filename, previous_filename, status}>>`. Drains `?per_page=100&page=N` until `< 100` returned. Cap at 30 pages (3000 entries) — beyond that, the helper returns `{overflow: true, entries: [...]}`. Caller decides what to do (overflow path → sentinel hash).
- [ ] **Step 3:** tests pass.
- [ ] Commit: `feat(arc-184): listPullFiles paginated fetch with 3000-cap overflow guard`

---

## Task 11: Stale-mark queue handler `triage-pr-stale-mark.ts` (TDD)

**Files:** `src/lib/triage-pr-stale-mark.ts`, `tests/triage-pr-stale-mark.test.ts`

- [ ] **Step 1: failing tests.** Mock GitHub client + KV. Cases:
  - manifest missing at re-read → no-op + `review-manifest-missing`
  - manifest's `reviewedAt` newer than the snapshot → no-op + `review-stale-superseded`
  - drift predicate returns false (head-match short-circuit) → no-op + `review-stale-not-detected`
  - drift true, GET returns 404 → `review-stale-target-missing`
  - drift true, GET returns body → applyStaleBlock + PATCH called once with the new body, then `review-stale-marked`
  - PATCH returns 5xx → `review-stale-mark-failed { status }`, retry-bubbled
  - PATCH returns 403 → `review-stale-mark-failed { status: 403 }` and NO retry (operator-visible permission gap)
- [ ] **Step 2: implementation.** Per spec §9.
- [ ] **Step 3:** tests pass.
- [ ] Commit: `feat(arc-184): handlePrStaleMark — drift detection + non-destructive PATCH`

---

## Task 12: `index.ts` — `pr-stale-mark` JobMessage + dispatch case + webhook enqueue (TDD on dispatch)

**Files:** `src/index.ts`, `tests/decide-pr-jobs.test.ts`

- [ ] **Step 1: failing tests.** Extend `decide-pr-jobs.test.ts` (or add a new webhook integration test if cleaner) covering: synchronize action for an open PR with non-draft + base/head + an existing manifest in KV → enqueues both `pr-review` and `pr-stale-mark` with the snapshot.
- [ ] **Step 2: implementation.**
  - Add `pr-stale-mark` to the `JobMessage` union with the shape per spec §9.
  - Add a dispatch case in the queue handler that calls `handlePrStaleMark`.
  - In the webhook handler `pull_request` branch, after `decision.review`, read the manifest from KV (best-effort try/catch). When a manifest exists AND the action is `synchronize` or `edited`, enqueue `pr-stale-mark` alongside `pr-review`.
- [ ] **Step 3:** tsc clean; `npm test` clean.
- [ ] Commit: `feat(arc-184): webhook enqueues pr-stale-mark alongside pr-review on synchronize/edited`

---

## Task 13: Kill-switch `OPENCLAW_REVIEW_MANIFEST_ENABLED`

**Files:** `src/index.ts`, `src/lib/review-manifest.ts`, `tests/review-manifest.test.ts`

- [ ] Add the env var to the `Env` interface in `src/index.ts`.
- [ ] In the read/write paths of `review-manifest.ts`, short-circuit (return null / no-op) when `env.OPENCLAW_REVIEW_MANIFEST_ENABLED !== "on"` AND the value is set to anything else (default treated as `"on"` for backwards-compat).
- [ ] In the webhook enqueue path, skip the stale-mark enqueue when disabled.
- [ ] Tests cover both: enabled (writes manifest) and explicit-off (no manifest write).
- [ ] Commit: `feat(arc-184): OPENCLAW_REVIEW_MANIFEST_ENABLED kill-switch`

---

## Task 14: README + telemetry doc updates

**Files:** `README.md`, `docs/` if any operator docs exist

- [ ] Add a "Review provenance + stale markers (ARC-184)" section to README explaining the manifest, drift triggers, the kill-switch, the App-permission requirement (`pull_requests: write` + `issues: write`).
- [ ] Note the in-flight-review race + KV consistency caveats from spec §13a so operators can interpret edge-case telemetry.
- [ ] Commit: `docs(arc-184): README — review-manifest + stale-marker reference`

---

## Task 15: Final integration pass — typecheck, lint, full test, CodeRabbit, push PR

- [ ] `npx tsc --noEmit` — expect clean.
- [ ] `npm test` — expect clean. Test count delta: ~+50 (manifest serdes, drift, file-list-hash, render, github client, two triage paths, stale-mark handler, decide-pr-jobs).
- [ ] `coderabbit review --plain --type committed --base main` — triage findings.
- [ ] `gh pr create` with body that includes `Closes ARC-184` + per-task summary table.
- [ ] **Operator follow-up note in PR body:** confirm `issues: write` permission on the Sigilix GitHub App.

---

## Self-review checklist (before presenting for sign-off)

- [ ] **Spec coverage:** every numbered section in the spec maps to ≥1 task.
- [ ] **Type names** consistent across declaration & call sites: `ReviewManifestV1`, `ReviewTarget`, `detectReviewStale`, `computeFileListHash`, `renderStaleBlock`, `applyStaleBlock`, `readReviewManifest`, `writeReviewManifest`, `handlePrStaleMark`, `listPullFiles`.
- [ ] **No premature abstraction** — each helper is justified by ≥1 caller.
- [ ] **No Node-only API** — Web-Crypto for SHA-256, fetch via the existing GitHubClient.
- [ ] **No new dependency.**
- [ ] **TDD where it pays:** tasks 2-7, 11. Tasks 1, 8-10, 12-14 are integration glue or trivially small.
