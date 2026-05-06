# ARC-184 — Review provenance + stale markers — design spec

**Status:** v3 — fully dual-signed-off (Codex + Kimi APPROVE-WITH-CHANGES, all blocking + major findings addressed)
**Linear:** [ARC-184](https://linear.app/arc-and-anchor/issue/ARC-184/review-input-provenance-persist-manifest-mark-stale-on-pr-change)
**Reference:** `withgraphite/dismiss-stale-approvals/latest_artifact.sh` (Graphite's pattern)

---

## 1. Problem

When a PR changes after Sigilix has already reviewed it (force-push, rebase, base shift, file additions), the prior review still appears valid in the GitHub UI. A reviewer skimming the conversation can't tell at a glance whether the green check / red request-changes corresponds to the diff currently on screen. Worst case: an engineer merges based on a stale APPROVE that no longer reflects the code.

Sigilix already runs an incremental-review path (ARC-194) that stores the last-reviewed head SHA in `OPENCLAW_STATE` to scope the next diff. ARC-184 generalizes that record into a full **review manifest** and uses it to mark prior reviews stale when the underlying diff has meaningfully changed — without spending another model call.

## 2. Acceptance criteria (from Linear)

- Every successful review stores a manifest (PR number, base SHA, head SHA, merge base, file-list hash, prompt version, model id, target id).
- Sticky summary shows the reviewed head SHA (short, 7 chars).
- PR head / base / file-list-hash / prompt-version change → prior review marked stale via a PATCH to its body. **No new model call.**
- Tests: unchanged PR (no marker), head changed, base changed, file-list changed, prompt-version changed, missing-manifest, malformed-manifest, target-already-deleted.

## 3. Architecture

```
+-----------+   1   +-----------------+        +-----------+   3   +---------------+
| webhook   | ----> | ack             | -----> | enqueue   | ----> | review queue  |
| (PR sync, |       | (returns 202)   |        | review +  |       | runs review,  |
|  edited)  |       |                 |        | maybe     |       | submitReview, |
+-----------+       +-----------------+        | stale-mk  |       | writes fresh  |
                                               +-----------+       | manifest      |
                                                    |              +---------------+
                                                    | 2 (parallel job)
                                                    v
                                               +---------------+
                                               | stale-mk      |
                                               | queue handler |
                                               | reads mft,    |
                                               | computes drift|
                                               | PATCH prior   |
                                               +---------------+
```

The reconcile gate is implemented as a **separate queue job** (`pr-stale-mark`) enqueued in parallel with `pr-review` from the same webhook handler. Two reasons:

1. **Webhook budget.** Computing drift correctly requires fetching `/repos/{o}/{r}/pulls/{n}/files` (paginated; spec §5). That is several GitHub round trips and easily blows past the ~50 ms webhook budget. Enqueueing both jobs preserves the fast-200 guarantee and gives the stale mark up to the queue's 15-minute budget for retries.
2. **Retry semantics.** The queue handler already has structured retry. A transient PATCH 5xx is retried automatically rather than being silently swallowed inside the webhook path.

The stale-mark job runs *in parallel* with the review job — it reads the prior manifest, computes drift, and PATCHes the prior review. Latency is typically 1-3 s after webhook arrival, well before the new review (30-90 s) lands. No ordering requirement between the two jobs: even if the new review lands first, the stale mark just no-ops because there's no longer a "prior" review at the captured `target.id` (the manifest is rewritten by the review handler).

(Implementation note: the stale-mark job consults the manifest snapshot taken at enqueue time — see §9.)

## 4. Manifest schema

Stored as a single KV record per PR, keyed `pr-review-manifest:<owner>/<repo>#<n>`. Separate from the existing `pr-last-reviewed:<owner>/<repo>#<n>` (which only holds the SHA pair for incremental-diff selection — different lifecycle, different consumers, leave it alone).

```ts
export type ReviewTarget =
  | { kind: "review";        reviewId: number }
  | { kind: "issue-comment"; commentId: number }

export interface ReviewManifestV1 {
  v: 1                          // schema version — bump for breaking changes
  prNumber: number
  baseSha: string               // PR base ref's SHA at review time
  headSha: string               // PR head ref's SHA at review time
  mergeBaseSha: string | null   // git merge-base(base, head); null when GitHub returns no base
  fileListHash: string          // hex SHA-256 of `${path}\0${prev_path ?? ""}\n`-joined sorted file list
  promptVersion: string         // monotonic string from src/prompts/pr-review.ts (PROMPT_VERSION export)
  modelId: string               // e.g. "qwen3-coder:480b-cloud" — recorded for forensic clarity
  target: ReviewTarget          // unified — either a review.id or a fallback issue-comment.id
  reviewedAt: number            // ms since epoch
}
```

`target` is the **only** PATCH addressee: the writer captures whichever surface it actually posted to (review on the success path, issue-comment on the 422 fallback). If neither was captured (e.g. shadow mode, or fallback that swallowed without posting), no manifest is written — fail-safe.

**Strict parse** — corrupt records (wrong shape, `v !== 1`, missing keys) are treated as **missing manifest** (no stale marking, no error). Forward-compat: future `v: 2` records seen by a v1-aware client are treated as missing (stale-marker degrades gracefully; the review still runs).

**TTL:** 30 days (matches existing `pr-last-reviewed` TTL). PRs left open longer than that lose the manifest and won't get a stale marker on the next push — acceptable; that's edge-of-edge.

## 5. Drift detection

A review is **stale** when *any* of these differ between the manifest and the current PR state:

1. `headSha` — most common case; force-push or new commit.
2. `baseSha` — base branch advanced (e.g. main moved while PR is open).
3. `fileListHash` — covers the rare case where head SHA is the same but the *set of paths* the review reasoned about changed (cherry-picks, rebase preserving SHAs but altering file scope).
4. `promptVersion` — Sigilix's prompt itself changed; prior verdict was generated under different instructions.

`mergeBaseSha` is recorded but **NOT** part of the drift check by itself — it changes whenever `baseSha` does, so it's redundant input to the predicate (kept for forensic value). `modelId` is also recorded but **NOT** a drift trigger (model upgrades happen often; cost prohibits invalidating every open PR per swap).

### File-list hash construction

The hash function is fully specified so writer and reader agree:

```
sha256_hex(
  for each file F in sorted([all changed files in the PR]):
    push(F.filename + "\0" + (F.previous_filename ?? "") + "\n")
)
```

- **Source:** `GET /repos/{o}/{r}/pulls/{n}/files?per_page=100&page=N`, paginated until `< per_page` items returned. The reader fully drains pagination — silently truncating at page 1 would let a rename in a large PR silently produce false negatives.
- **Sorting:** lexicographic byte order on `filename`. Renames sort by `filename` (the new name).
- **Renames:** include both new and previous filenames in the hashed line so a rename without content change still drifts the hash.
- **Removed files:** included; `filename` is the path that was removed (status = "removed").
- **Cap:** `pulls/files` returns at most 3000 entries even with pagination (GitHub limit). Beyond that, `fileListHash` is set to a sentinel `sha256:overflow:<count>` and excluded from drift detection — head/base/promptVersion still apply. Telemetry records the overflow.

### Current-state source

| Field | Source | Pagination | Notes |
|---|---|---|---|
| `headSha` | `payload.pull_request.head.sha` | n/a | Always present on `pull_request.synchronize` and `edited` |
| `baseSha` | `payload.pull_request.base.sha` | n/a | Always present |
| `mergeBaseSha` | `GET /repos/{o}/{r}/compare/{base}...{head}` → `merge_base_commit.sha` | n/a | One round trip; null on 404/422 |
| `fileListHash` | `GET /repos/{o}/{r}/pulls/{n}/files` | yes (full drain) | Already used elsewhere; reuse helper |
| `promptVersion` | local constant | n/a | Same string the writer captured |

Eventual consistency: GitHub's REST endpoints can lag by a few seconds after a force-push. The stale-mark job retries with a 1-2 s back-off if the file list looks empty AND the PR has commits ahead of base — that's the only real failure mode and is captured as `review-stale-current-state-empty-retry`. After 3 retries, abort with telemetry.

## 6. Stale-mark mechanism

When drift is detected, PATCH the prior review's body to insert a stale notice between the existing head marker and the body content:

```
<!-- openclaw:pr-review -->

<!-- sigilix:stale-marker:start -->
> [!WARNING]
> **This review is stale.** Reviewed head `<oldHeadShort>` against base `<oldBaseShort>`. PR is now at `<newHeadShort>` against base `<newBaseShort>`. Run `/sigilix review` to re-review the current diff, or wait — Sigilix will refresh on the next push.
<!-- sigilix:stale-marker:end -->

<existing review body unchanged below>
```

### Idempotency / non-destructive PATCH

The stale-mark handler:
1. **GETs the current body** (`/repos/{o}/{r}/pulls/{n}/reviews/{review_id}` for review target, `/repos/{o}/{r}/issues/comments/{comment_id}` for issue-comment target).
2. **Locates** the existing `<!-- sigilix:stale-marker:start -->` … `<!-- sigilix:stale-marker:end -->` block, if any.
3. **Replaces** the existing block (or inserts immediately after the leading `<!-- openclaw:pr-review -->` marker if no block exists).
4. **PATCHes** the body. Other content the user / GitHub / Sigilix may have touched between the GET and PATCH is preserved. (We don't use `If-Match` because GitHub doesn't support it on these endpoints; the GET-modify-PATCH window is short — milliseconds — and the stale block is idempotent on re-application.)

### Already-deleted target

If GET returns 404 (the prior review or comment was deleted), the stale-mark handler emits `review-stale-target-missing` and exits cleanly. The next successful review will write a fresh manifest. No retries on 404; do retry on 5xx.

### Permission audit (Kimi spec catch)

| PATCH path | Required App permission |
|---|---|
| `/repos/{o}/{r}/pulls/{n}/reviews/{review_id}` | `pull_requests: write` |
| `/repos/{o}/{r}/issues/comments/{comment_id}` | **`issues: write`** (NOT covered by `pull_requests: write` alone) |

The Sigilix App **must declare both** `pull_requests: write` AND `issues: write`. The current App manifest is verified before this work merges (operator follow-up: re-confirm `issues: write` on the App's permissions page; if missing, request the upgrade and re-install on every installation). Without `issues: write`, the fallback issue-comment stale-mark would 403 — handler treats 403 as a non-retryable failure with `review-stale-mark-failed { status: 403 }` so the operator sees the gap immediately.

### Length cap (Kimi spec catch)

GitHub review bodies and issue comments are capped at 65,535 characters. Stale notice block (~350 chars) + sticky-summary footer (~80 chars) need to fit alongside the original body. Handler enforces:

1. If `originalBody.length + STALE_BLOCK.length > 65000`, **truncate the original body** at 65000 minus block length, append `\n\n_[review body truncated to fit stale notice; full review at <PR URL>]_`. Sigilix's review bodies almost never approach this cap (typical: 2-8 KB), so the truncate is a defense-in-depth measure rather than a common path.
2. The footer added in §7 is itself never truncated — it's added at write time before the body is pushed to GitHub, so the writer applies the cap there too.

### Idempotency replacement algorithm (Kimi spec catch)

The stale block is bounded by **literal** marker comments and replaced via a **single, multiline-anchored** regex. Pseudocode:

```ts
const MARKER_START = "<!-- sigilix:stale-marker:start -->"
const MARKER_END   = "<!-- sigilix:stale-marker:end -->"
const BLOCK_RE = new RegExp(
  `${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}\\n?`,
  "m"  // single match, multiline OK
)

function applyStaleBlock(body: string, block: string): string {
  if (BLOCK_RE.test(body)) return body.replace(BLOCK_RE, block)
  // No existing block — insert immediately after the leading openclaw marker.
  const HEAD_RE = /^(<!-- openclaw:pr-review -->\n)/
  if (HEAD_RE.test(body)) return body.replace(HEAD_RE, `$1\n${block}\n`)
  return `${block}\n\n${body}`
}
```

Key properties: (a) literal markers — accidental user prose like "stale-marker:start" inside a code block doesn't match because the angle brackets / dashes are required; (b) lazy `.*?` between markers prevents over-matching across two stacked blocks; (c) trailing `\n?` consumed so re-application doesn't leak blank lines.

## 7. Sticky-summary footer

Append a single line to the existing `formatReviewBody` / `buildFallbackBody` outputs:

```
_Reviewed against `<headShort>` at <ISO-8601 timestamp>._
```

Plain prose, italics, monospaced SHA. Consistent across success-and-fallback paths. Rendered just above the closing marker so it sits below the findings section in normal reading order.

## 8. Where the manifest gets written

After a successful `submitReview` in:
- `src/lib/triage-pr-review.ts` (`handlePrReview` — single-agent path)
- `src/lib/triage-pr-review-ensemble.ts` (post-mode submit)
- The 422 fallback path in `triage-pr-review-ensemble.ts:815` (issue-comment fallback) when it actually succeeds

NOT written in:
- Shadow-mode ensemble runs (no review posted to GitHub → no target id to track).
- Fallback that swallows a 422 without posting (no artifact to track).

The write is wrapped in try/catch and never blocks the review flow — manifest is best-effort, same as the incremental-review marker. KV write errors are logged via `review-manifest-write-failed`.

## 9. Where the reconcile gate fires

In the webhook handler (`src/index.ts`), inside `pull_request` handling for `synchronize` and `edited` actions, **after** the existing `decidePullRequestJobs` decision and **alongside** the existing `pr-review` enqueue.

The webhook handler enqueues the `pr-stale-mark` job with the **manifest snapshot it just read** as message payload:

```ts
type StaleMarkJob = {
  type: "pr-stale-mark"
  owner: string
  repo: string
  prNumber: number
  installationId: number
  manifestSnapshot: ReviewManifestV1
  newHeadSha: string
  newBaseSha: string
  // promptVersion read at enqueue time so the consumer doesn't have
  // to re-read it (avoids race with a concurrent prompt deploy).
  currentPromptVersion: string
}
```

The consumer (`handlePrStaleMark`):
1. Re-reads the manifest from KV (the snapshot is just to detect "was there a manifest at webhook time?").
2. If the manifest was overwritten by a concurrent review handler (newer `reviewedAt`), no-op + `review-stale-superseded`.
3. Otherwise computes current state (file-list-hash via paginated fetch, merge-base via compare API).
4. If `detectReviewStale(manifestSnapshot, current) === true`, calls `markPriorReviewStale`.
5. Telemetry on every branch.

Why re-read the manifest: between enqueue and consume, the review handler might have just written a fresh manifest on the new head SHA. We MUST NOT mark *that* as stale — it's the up-to-date one.

The webhook handler does NOT call `detectReviewStale` itself before enqueueing — that requires the file-list fetch which exceeds the webhook budget. The job runs unconditionally; the consumer no-ops if drift turns out to be false. (Worst case: one wasted KV read + one wasted compare API call. Acceptable.)

## 10. New files

- `src/lib/review-manifest.ts` — schema, KV read/write, drift predicate, stale-render
- `src/lib/triage-pr-stale-mark.ts` — queue handler `handlePrStaleMark`
- `tests/review-manifest.test.ts` — unit tests for parser + drift predicate + render + file-list-hash
- `tests/triage-pr-stale-mark.test.ts` — unit tests for the handler with mocked KV + GitHub client

## 11. Modified files

- `src/lib/triage-pr-review.ts` — write manifest after successful submitReview
- `src/lib/triage-pr-review-ensemble.ts` — write manifest after successful submitReview (post mode + 422 fallback)
- `src/lib/github.ts` — add `updateReviewBody(owner, repo, prNumber, reviewId, body)` and `getReview(...)`/`getIssueComment(...)` for the GET-modify-PATCH path
- `src/prompts/pr-review.ts` — export `PROMPT_VERSION = "1"` constant; bump-on-substantive-changes comment block
- `src/index.ts` — add `pr-stale-mark` JobMessage variant + dispatch case; enqueue alongside `pr-review` on `synchronize` / `edited`
- `tests/triage-pr-review.test.ts` — add coverage for "submitReview return value reaches manifest write"
- `tests/triage-pr-review-ensemble.test.ts` — same as above for the ensemble path
- `tests/decide-pr-jobs.test.ts` — add coverage for "edited action enqueues stale-mark"

## 12. Telemetry

| Event | Fields | When |
|---|---|---|
| `review-manifest-written` | `{owner, repo, prNumber, headSha, baseSha, modelId, promptVersion, target: { kind, id }}` | KV write success after submitReview |
| `review-manifest-write-failed` | `{owner, repo, prNumber, err: string}` | KV write rejection |
| `review-manifest-missing` | `{owner, repo, prNumber}` (sampled 1:10) | Stale-mark consumer reads manifest = null |
| `review-manifest-invalid` | `{owner, repo, prNumber, reason: "wrong-version"|"shape"|"json-parse"}` | Stale-mark consumer reads malformed |
| `review-stale-detected` | `{owner, repo, prNumber, reasons: ("head"|"base"|"file-list"|"prompt-version")[], manifestHeadSha, currentHeadSha, manifestBaseSha, currentBaseSha, manifestPromptVersion, currentPromptVersion}` | Drift predicate true |
| `review-stale-not-detected` | `{owner, repo, prNumber}` (sampled 1:20) | Drift predicate false |
| `review-stale-current-state-empty-retry` | `{owner, repo, prNumber, attempt: 1\|2\|3}` | File list empty on a fast-arriving sync webhook; retrying |
| `review-stale-superseded` | `{owner, repo, prNumber}` | Manifest reviewedAt advanced between enqueue and consume |
| `review-stale-target-missing` | `{owner, repo, prNumber, target: { kind, id }}` | GET returned 404 (review/comment deleted) |
| `review-stale-marked` | `{owner, repo, prNumber, target: { kind, id }, reasons: string[]}` | PATCH success |
| `review-stale-mark-failed` | `{owner, repo, prNumber, target: { kind, id }, err: string, status?: number}` | PATCH non-2xx; status when available |

## 13. Decisions explicitly NOT in scope

1. **Editing inline review comments individually.** v1 only marks the top-level review body. Inline comments stay as-is — re-reviewing rebuilds them anyway, and editing N inline comments per stale event multiplies API surface for marginal value.
2. **Re-issuing the review state (APPROVE → COMMENT) on stale.** GitHub's API can't change a submitted review's `state`. The stale notice in the body is the only signal a v1 reader gets; that's enough.
3. **Auto-running a fresh review on stale-detect.** Existing `synchronize` webhook handling already enqueues a new review (with incremental-diff selection). We don't duplicate that — the stale mark just covers the gap *between* webhook arrival and queue completion.
4. **Cross-PR memory** (per ARC-189). Different ticket; different KV shape.
5. **`If-Match` / ETag for non-destructive PATCH.** GitHub doesn't support it on these endpoints. The GET-modify-PATCH window is too short for human-edits to race meaningfully; we accept the risk.

## 13a. Known v1 limitations (Kimi spec catches — accepted, documented, addressed in v2 if signal)

1. **KV eventual consistency.** Cloudflare KV propagates writes globally with up to ~60 s of staleness. A manifest written by a review that just landed may not be visible to the *next* webhook hitting a different edge. Effects:
   - **Spurious stale mark:** webhook reads stale (older) manifest, computes drift against new HEAD that the manifest was actually about → false stale mark applied. **Mitigation:** the consumer compares `manifest.headSha === payload.head.sha`. If they match, no stale mark fires regardless of other drift. (This is in-spec — head match is a hard short-circuit.) The remaining false-stale window is "headSha differs but the new manifest from the just-landed review hasn't propagated yet." We accept this — it's eventually correct on the *next* webhook within ~60 s.
   - **Missed stale mark:** webhook reads new manifest before the consumer reads its snapshot → consumer thinks no manifest existed at enqueue. The new review's manifest correctly reflects current state, so a subsequent diff change will mark it stale. The "missed" event is the gap during the in-flight review, addressed below.
   - **GA path:** if telemetry surfaces user-impacting consistency issues, migrate the manifest to D1 (already a Worker binding) for read-after-write consistency. v1 keeps KV; we measure first.
2. **In-flight review race.** A `synchronize` webhook arriving while the previous review is still in-queue (no manifest yet) sees `manifest = null` and emits `review-manifest-missing` without a stale mark. The just-completing review will then post unmarked, even though it reviewed an older head SHA than the webhook's payload says is current. v1 documents this as **accepted gap** — the webhook itself enqueues a fresh `pr-review` job that will correctly re-review against the new head; the unmarked old review lasts only seconds (until the new one lands). If user feedback says even that brief window is unacceptable, v2 can write a `pr-review-pending:<owner>/<repo>#<n>` sentinel at job-enqueue time and have the stale-mark consumer wait-and-retry once. Out of v1 scope.
3. **PATCH wall-clock latency.** §9's "fast 200 ack" claim refers to the webhook handler's CPU + KV-write path. The actual stale-mark PATCH happens in the queue, which has its own 15-minute budget. The webhook handler itself does *no* GitHub-side work for stale marking. Slow GitHub PATCHes degrade time-to-stale-notice, not webhook ack latency.

## 14. Migration / rollout

- KV reads are forward-compatible: missing key = no manifest, no stale check fires. Safe to deploy without a backfill.
- After deploy, the next review of every active PR writes a v1 manifest. Drift detection becomes effective on the *second* review of each PR (or any later push).
- Kill-switch: env var `OPENCLAW_REVIEW_MANIFEST_ENABLED` (default `"on"`). When set to anything else, write/read paths short-circuit. Single-flag rollback if a bug surfaces.

## 15. Decisions on prior open questions (resolved during sign-off)

1. **`modelId` is NOT a stale trigger** (Codex, recorded).
2. **`PROMPT_VERSION` is monotonic string** with a "bump only on substantive change" comment in the prompt file (Codex, recorded).
3. **HTML marker comments are safe** in GitHub Markdown bodies for both review and issue-comment surfaces; round-trip preserved across PATCH (Codex, recorded). We will add a regression test that round-trips a body containing a marker block through a PATCH against a real fixture.

---

## Sign-off summary

### Codex (v1 → v2)

Codex returned APPROVE-WITH-CHANGES on v1. v2 addresses every finding:

| Codex finding | v2 change |
|---|---|
| **[BLOCKING]** Inconsistent target schema (§4 reviewId vs §6 target.kind) | Unified — `target: ReviewTarget` is the only addressee in §4. |
| **[MAJOR]** 50ms webhook budget unrealistic | Reconcile is now its own queue job (`pr-stale-mark`), enqueued from the webhook. §3 + §9 rewritten. |
| **[MAJOR]** File-list hash needs pagination + rename behavior | §5 fully specifies hash construction, source endpoint, pagination, renames, removed files, 3000-cap overflow. |
| **[MAJOR]** Current-state source underspecified | §5 adds a per-field source table including the compare API for merge-base. |
| **[MAJOR]** PATCH must fetch + replace marker block, handle deleted artifacts | §6 specifies GET-modify-PATCH semantics, idempotent replace, 404 handling. |
| **[MAJOR]** Prompt-version drift requires fresh review enqueue | The webhook handler always enqueues `pr-review` on `synchronize`/`edited` independently — stale-mark runs in parallel. The drift trigger doesn't depend on a review being enqueued, but it lines up. |
| **[MINOR]** Permissions clarification | §6 confirms `pull_requests: write` covers both targets when editing self-authored artifacts. |
| **[MINOR]** Telemetry needs more dimensions | §12 expanded with manifest-vs-current SHAs, target id, status code. |
| **[MINOR]** Missing/malformed manifest telemetry absent | §12 adds `review-manifest-missing` (sampled) and `review-manifest-invalid` with reason. |
| **[NIT]** Stale copy wording | Fixed: "Reviewed head `<old>` against base `<old>`. PR is now at `<new>` against base `<new>`." |

### Kimi K2.6 (v2 → v3)

| Kimi finding | v3 change |
|---|---|
| **[BLOCKING]** target schema (already addressed in v2) | No change — same fix as Codex. |
| **[MAJOR]** Webhook file-list source (already addressed by queue-job design in v2) | No change. |
| **[MAJOR]** Cloudflare KV eventual consistency | New §13a-1 documents head-SHA short-circuit + GA path to D1 if telemetry warrants. |
| **[MAJOR]** In-flight review race (manifest not yet written when webhook fires) | New §13a-2 documents the gap as accepted v1 limitation; outlines `pr-review-pending` sentinel as v2 if needed. |
| **[MAJOR]** Verify `issues: write` permission | New "Permission audit" subsection in §6 — both `pull_requests: write` AND `issues: write` declared, operator follow-up to verify on App. |
| **[MINOR]** 65535-char body cap overflow | New "Length cap" subsection in §6 — truncate-original-with-pointer when stale block + footer would push past 65000. |
| **[MINOR]** Idempotency replacement algorithm | New "Idempotency replacement algorithm" subsection in §6 — literal markers, lazy multiline regex, escape via `escapeRegex`. |
| **[NIT]** 50ms webhook budget conflates CPU vs wall-clock | New §13a-3 clarifies: webhook does no GitHub work for stale marking; PATCH happens in queue with its 15-min budget. |
