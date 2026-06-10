// SIG-170 — Stable per-finding upsert for unanchored / body-fallback
// review comments.
//
// Background
// ----------
// When GitHub rejects an inline anchor (out-of-diff range, deleted
// line, fork-PR limitation) Sigilix has historically posted a fresh
// body comment per push, producing reviewer-spam: the same finding
// re-appears as a brand-new top-level PR comment on every
// `synchronize`. SIG-170 replaces the per-push POST with a content-
// fingerprinted upsert so the same finding edits its prior comment
// in place.
//
// Design (per research §Recommendation, citations in the handoff
// doc `.claude/handoff/sig-170-fingerprint-research.md`)
//
//   1. Fingerprint = `computeUnanchoredFingerprint(ruleId | category |
//      path | normalisedBody)` truncated to 16 hex chars. Excludes
//      raw `line` (the whole point of "unanchored" is the line moved)
//      and raw body snippets (rotates on prompt-template tweaks).
//   2. Marker embedded in the comment body via
//      `buildSigilixUnanchoredMarker` — same schema as the inline
//      marker with a `:loc:unanchored` trailer so the dismissal
//      pipeline (PR #142 + SIG-173) keeps working unchanged.
//   3. Detection = KV fast path first, then marker-scan recovery.
//      KV key: `unanchored-comment:${owner}:${repo}:${prNumber}:${fingerprint}`
//      → comment ID (number). 7-day TTL — long enough for active PRs;
//      the marker-scan fallback covers TTL'd entries on rare-edit PRs.
//   4. Withdrawal short-circuits the upsert before any GitHub call
//      (CodeQL/Semgrep model — research §Q4).
//   5. Race-protection model (SIG-170 H1 fix-up: docstring corrected,
//      behaviour unchanged):
//
//      - Same-SHA re-entry: bounded by the existing PrReviewRunDO
//        single-flight from ARC-190 (`decideEnqueueAction` returns
//        `dedupe-active`). The DO key is (owner, repo, prNumber,
//        headSha), so two writers on the same head cannot interleave.
//
//      - Across-SHA `synchronize` storm: NOT bounded. The DO key
//        includes headSha, so two writers on different SHAs of the
//        same PR can both miss KV AND both miss the marker scan (the
//        first writer's POST hasn't completed before the second
//        writer's scan reads). Net: 2 comments on this push, which
//        the dismissal pipeline + the next push's marker scan
//        converge to 1 on the subsequent run. Acceptable trade-off
//        — widening the DO key to (owner, repo, prNumber) for the
//        upsert phase would serialise ALL upserts on a busy PR and
//        reduce parallelism more than the rare double-post warrants.
//
//      - Stale-KV recovery (the actual case the `*-stale-kv-recovered`
//        event fires on): when a cached comment id becomes invalid
//        (the comment was deleted by a reviewer or a sweep, or a
//        prior writer rewrote KV), the marker scan returns a fresher
//        live id and we PATCH that one. Emits the recovery telemetry
//        so dashboards can flag the self-heal — the upsert succeeded
//        but the cache was lying.
//
// Telemetry events (SIG-170 H1 fix-up: all renamed to the
// `unanchored-comment-upsert-*` kebab-case prefix so dashboards key
// off a single greppable namespace):
//   - `unanchored-comment-upsert-hit-kv`               — KV cache hit → PATCH
//   - `unanchored-comment-upsert-hit-scan`             — KV miss, marker found by scan → PATCH + backfill KV
//   - `unanchored-comment-upsert-miss-created`         — KV miss + scan miss → POST + write KV
//   - `unanchored-comment-upsert-withdrawn-skipped`    — fingerprint matches withdrawal → no GitHub call
//   - `unanchored-comment-upsert-stale-kv-recovered`   — KV held a stale id; scan returned a fresher one

import type { Env } from "@/src/shared/types/env"
import type { GitHubClient } from "@/src/shared/adapters/github"
import {
  buildSigilixUnanchoredMarker,
  computeUnanchoredFingerprint,
  findFingerprintInCommentBody,
} from "./review-memory/marker"
import type {
  ReviewMemoryCategory,
  ReviewMemorySeverityLabel,
} from "./review-memory/types"
import {
  filterWithdrawnFindings,
  type WithdrawalRecord,
} from "./review-withdrawal-store"

// 7-day TTL: long enough to span active PR lifecycles without
// occupying KV indefinitely. Mirrors the
// `pr-review-comment-fallback` dedupe TTL in
// `review-comment-fallback.ts` for operational consistency.
const KV_TTL_SECONDS = 7 * 24 * 60 * 60

// Per-PR pagination cap on the marker-scan recovery path. Mirrors
// `github.ts::listIssueComments`'s while-loop cap (50 pages × 100
// comments/page = 5000 comments) — pathological PRs are accepted as
// out-of-scope; the recovery path simply falls through to POST.
const MARKER_SCAN_PAGE_CAP = 50

export type UnanchoredUpsertOutcome =
  | "hit_marker_via_kv"
  | "hit_marker_via_scan"
  | "miss_created"
  | "withdrawn_skipped"
  | "race_detected"

export interface UnanchoredUpsertResult {
  outcome: UnanchoredUpsertOutcome
  fingerprint: string
  /** GitHub comment id after the upsert. Absent on `withdrawn_skipped`. */
  commentId?: number
}

export interface UnanchoredUpsertFinding {
  /** Repo-relative file path the finding applies to. */
  path: string
  /** Best-effort line for withdrawal matching. Not in the fingerprint. */
  line: number
  /** Finding body — markdown allowed. Used for normalised fingerprint + posted. */
  body: string
  /** Sigilix finding category (1:1 with the marker `cat:` field). */
  category: ReviewMemoryCategory
  /** Severity label for the marker `sev:` field. */
  severity: ReviewMemorySeverityLabel
  /**
   * Sigilix's per-finding rule identifier (e.g. `evidenceId` on the
   * `PrReviewFinding` type). Null/undefined canonicalises to the
   * `"none"` sentinel used by the inline marker.
   */
  ruleId?: string | null
}

export interface UpsertUnanchoredCommentArgs {
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  finding: UnanchoredUpsertFinding
  /**
   * Already-loaded PR withdrawal records (call
   * `loadWithdrawals(env, owner, repo, prNumber)` once per run and
   * pass through for every upsert). Empty array = no suppression.
   */
  withdrawals: ReadonlyArray<WithdrawalRecord>
  /**
   * Optional injection point for test stubs of the marker-scan
   * pagination. Production callers omit; tests pass a fake to keep
   * `GitHubClient` mocks small.
   */
  listIssueCommentsPage?: (
    owner: string,
    repo: string,
    issueNumber: number,
    page: number,
  ) => Promise<ReadonlyArray<{ id: number; body: string }>>
}

function emit(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }))
}

function kvKey(owner: string, repo: string, prNumber: number, fingerprint: string): string {
  return `unanchored-comment:${owner}:${repo}:${prNumber}:${fingerprint}`
}

/**
 * Render the comment body posted to GitHub: caller's `finding.body`
 * with the SIG-170 unanchored marker appended on its own line. Caller
 * is responsible for any wrapping prose / heading — this helper keeps
 * the marker mechanism orthogonal to the rendering.
 *
 * Pure — exported for tests.
 */
export function renderUnanchoredCommentBody(args: {
  body: string
  marker: string
}): string {
  const trimmed = args.body.trimEnd()
  // Match the inline-marker convention of `\n\n<marker>` at the end
  // so a comment-thread reply doesn't visually butt up against the
  // hidden marker line.
  return `${trimmed}\n\n${args.marker}`
}

/**
 * Read the KV-cached comment id for a fingerprint. Returns null on
 * cache miss, malformed entry, or KV read failure (best-effort —
 * cache misses fall through to the scan recovery path).
 */
async function readKvCachedCommentId(
  env: Env,
  key: string,
): Promise<number | null> {
  try {
    const raw = await env.OPENCLAW_STATE.get(key)
    if (!raw) return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  } catch {
    return null
  }
}

async function writeKvCachedCommentId(
  env: Env,
  key: string,
  commentId: number,
): Promise<void> {
  try {
    await env.OPENCLAW_STATE.put(key, String(commentId), {
      expirationTtl: KV_TTL_SECONDS,
    })
  } catch {
    // KV write failures aren't fatal — the marker in the comment body
    // is the durable source of truth and the next run recovers via
    // the scan path. Log so on-call notices a persistent failure.
    console.warn(JSON.stringify({
      event: "unanchored-comment-upsert-kv-write-failed",
      key,
    }))
  }
}

/**
 * Paginated marker scan. Walks PR issue comments looking for a body
 * that contains the target fingerprint, returning the matching
 * comment id (or null if none found within the page cap).
 *
 * Mirrors `github.ts::listIssueComments`'s pagination pattern
 * (50-page cap, 100 comments per page) but short-circuits on the
 * first match instead of materialising the full list.
 */
async function scanForFingerprintMarker(args: {
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  fingerprint: string
  listIssueCommentsPage?: UpsertUnanchoredCommentArgs["listIssueCommentsPage"]
}): Promise<number | null> {
  const fetchPage = args.listIssueCommentsPage
    ?? ((owner, repo, issueNumber, page) =>
      args.client.listIssueCommentsPage(owner, repo, issueNumber, page))
  for (let page = 1; page <= MARKER_SCAN_PAGE_CAP; page++) {
    let items: ReadonlyArray<{ id: number; body: string }>
    try {
      items = await fetchPage(args.owner, args.repo, args.prNumber, page)
    } catch (err) {
      console.warn(JSON.stringify({
        event: "unanchored-comment-upsert-scan-failed",
        owner: args.owner, repo: args.repo, pr_number: args.prNumber,
        page,
        err: err instanceof Error ? err.message : String(err),
      }))
      return null
    }
    if (items.length === 0) return null
    for (const c of items) {
      const fid = findFingerprintInCommentBody(c.body)
      if (fid === args.fingerprint) return c.id
    }
    if (items.length < 100) return null
  }
  return null
}

/**
 * Per-finding upsert primitive. Computes the fingerprint, consults
 * the withdrawal store, then runs the KV → scan → POST/PATCH flow.
 *
 * Returns a structured outcome so callers can flush per-result
 * telemetry to a sink without re-running classification logic.
 *
 * Best-effort: GitHub-side failures (POST or PATCH thrown) propagate
 * — the caller decides whether to fall through to the wrapped
 * `postReviewCommentFallback` or surface the error.
 */
export async function upsertUnanchoredComment(
  args: UpsertUnanchoredCommentArgs,
): Promise<UnanchoredUpsertResult> {
  const { env, client, owner, repo, prNumber, finding, withdrawals } = args
  const fingerprint = await computeUnanchoredFingerprint({
    ruleId: finding.ruleId ?? null,
    category: finding.category,
    path: finding.path,
    body: finding.body,
  })
  const tag = {
    owner, repo, pr_number: prNumber,
    fingerprint, path: finding.path, category: finding.category,
  }

  // Withdrawal check MUST run before any GitHub call (CodeQL / Semgrep
  // model — research §Q4). filterWithdrawnFindings keys on
  // (path, line ± tolerance, Jaccard-on-body) — re-use the same
  // primitive PR #142 uses for the inline path so withdrawn signal
  // stays withdrawn regardless of which renderer fired.
  if (withdrawals.length > 0) {
    const { suppressed } = filterWithdrawnFindings(
      [{ path: finding.path, line: finding.line, body: finding.body }],
      withdrawals,
    )
    if (suppressed.length > 0) {
      emit("unanchored-comment-upsert-withdrawn-skipped", tag)
      return { outcome: "withdrawn_skipped", fingerprint }
    }
  }

  const { marker } = await buildSigilixUnanchoredMarker({
    ruleId: finding.ruleId ?? null,
    category: finding.category,
    severity: finding.severity,
    path: finding.path,
    body: finding.body,
  })
  const body = renderUnanchoredCommentBody({ body: finding.body, marker })

  const key = kvKey(owner, repo, prNumber, fingerprint)
  const cachedId = await readKvCachedCommentId(env, key)
  if (cachedId !== null) {
    try {
      await client.updateIssueComment(owner, repo, cachedId, body)
      emit("unanchored-comment-upsert-hit-kv", { ...tag, comment_id: cachedId })
      // Refresh TTL so an actively-edited fingerprint doesn't expire
      // mid-PR. Same id, same key — just resets the 7-day clock.
      await writeKvCachedCommentId(env, key, cachedId)
      return { outcome: "hit_marker_via_kv", fingerprint, commentId: cachedId }
    } catch (err) {
      // 404 on PATCH most likely means the comment was deleted (by
      // a reviewer or by a sweep). Fall through to the marker-scan
      // path; if no replacement exists we POST fresh and rewrite KV.
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(JSON.stringify({
        event: "unanchored-comment-upsert-kv-patch-failed",
        ...tag, comment_id: cachedId, err: msg,
      }))
      // Best-effort delete the stale KV entry before falling through —
      // otherwise the next call also wastes a PATCH on a dead id.
      try {
        await env.OPENCLAW_STATE.delete(key)
      } catch {
        // Ignored — TTL eventually cleans it up.
      }
    }
  }

  // Marker-scan recovery path. KV either missed, held a stale id, or
  // the PATCH failed — paginate PR comments to find a still-live
  // marker for this fingerprint.
  const scannedId = await scanForFingerprintMarker({
    client, owner, repo, prNumber, fingerprint,
    ...(args.listIssueCommentsPage !== undefined
      ? { listIssueCommentsPage: args.listIssueCommentsPage }
      : {}),
  })
  if (scannedId !== null) {
    // If KV held a DIFFERENT id than the scan found, a concurrent
    // writer beat us — record the race and converge on the scan's id
    // (the comment that actually exists right now).
    const isStaleKvRecovery = cachedId !== null && cachedId !== scannedId
    if (isStaleKvRecovery) {
      // SIG-170 H1 (fix-up): renamed from `upsert.race_detected`.
      // This fires when KV held a stale id and the scan returned a
      // fresher one — i.e. self-healing the cache, NOT detecting a
      // concurrent first-write race (across-SHA double-posts aren't
      // bounded; see the model docstring at the top of this file).
      emit("unanchored-comment-upsert-stale-kv-recovered", {
        ...tag, kv_comment_id: cachedId, scan_comment_id: scannedId,
      })
    }
    await client.updateIssueComment(owner, repo, scannedId, body)
    emit("unanchored-comment-upsert-hit-scan", {
      ...tag, comment_id: scannedId,
      ...(isStaleKvRecovery ? { recovered_from_stale_kv: true } : {}),
    })
    await writeKvCachedCommentId(env, key, scannedId)
    return {
      outcome: isStaleKvRecovery ? "race_detected" : "hit_marker_via_scan",
      fingerprint,
      commentId: scannedId,
    }
  }

  // Cache + marker both miss — first time we've posted this finding
  // (or all prior copies were deleted). POST fresh.
  const created = await client.createIssueComment(owner, repo, prNumber, body)
  const commentId = typeof created === "object" && created !== null && "id" in created
    ? Number((created as { id: unknown }).id)
    : NaN
  if (!Number.isFinite(commentId) || commentId <= 0) {
    // GitHub returned 2xx with no id — log + bail without writing
    // KV. The next run scans the body and recovers.
    console.warn(JSON.stringify({
      event: "unanchored-comment-upsert-create-no-id",
      ...tag,
    }))
    return { outcome: "miss_created", fingerprint }
  }
  await writeKvCachedCommentId(env, key, commentId)
  emit("unanchored-comment-upsert-miss-created", { ...tag, comment_id: commentId })
  return { outcome: "miss_created", fingerprint, commentId }
}
