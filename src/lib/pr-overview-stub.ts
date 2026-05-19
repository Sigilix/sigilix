// SIG-84 — synchronous "Reviewing…" stub for the pr-overview sticky.
//
// Founder direction (post-PR #100): the pr-overview sticky comment was
// posting ~30s AFTER the `pr-review` event on every PR push because
// both ran as independent parallel queue consumers. Reads backwards —
// approve first, then a long summary card.
//
// Fix: post a stub sticky comment SYNCHRONOUSLY at webhook time
// (sub-second), BEFORE enqueueing the heavy `pr-overview` + `pr-review`
// jobs. The overview handler then edits the stub in place when its
// Ollama call completes (~30s later). The review handler waits on a
// short KV-flag-keyed barrier before submitting, so the overview's
// comment id is guaranteed to be on the PR timeline before the review.
//
// Helper contract:
//   - Idempotent: a second webhook delivery for the same
//     (owner, repo, prNumber, headSha) must NOT create a second
//     comment. Fast path = KV flag check; fallback = scan PR comments
//     for an existing sigilix-overview marker.
//   - Best-effort: a failed stub-post is logged but does NOT throw.
//     The review-side wait has a 2s ceiling so the review still
//     proceeds in degraded mode — same ordering as today on that one
//     push.
//   - Caller responsibility: gate on `isPrOverviewEnabled(config)`
//     BEFORE calling — disabled-overview customers should never see a
//     stub posted.
//
// KV flag schema (TTL ~5min — long enough for the heaviest pr-review
// budget, short enough to clear between unrelated PRs on the same
// repo):
//   key:   `pr-overview-stub-posted:<owner>/<repo>#<prNumber>:<headSha>`
//   value: stringified comment id
//
// The flag is intentionally per-`(prNumber, headSha)`, not per-PR. A
// new push fires a new webhook with the new headSha — the new stub
// helper checks the new key, misses, scans, finds the prior stub,
// resets its body to `_Reviewing…_`, and rewrites the KV flag.

import type { Env } from "../index"
import { GitHubClient } from "./github"
import { getInstallationToken } from "./github-app"
import {
  OVERVIEW_MARKER,
  findExistingOverviewCommentId,
} from "./triage-pr-overview"

/**
 * Body posted by the stub. The marker on line 1 is what the overview
 * handler greps for to decide POST-vs-PATCH; sharing the same string
 * means the in-place edit Just Works.
 *
 * Body intentionally short. The "Sigilix Overview" heading mirrors
 * what `formatOverviewComment` renders on the final walkthrough, so
 * the customer sees the same surface throughout (placeholder →
 * completed) without a visual reflow.
 *
 * The `_Reviewing…_` italics + ellipsis is what CodeRabbit uses
 * (founder reference comparison: "two stickies, ordering matches
 * CodeRabbit"). Markdown italics render the same in light/dark mode.
 */
export const STUB_BODY = `${OVERVIEW_MARKER}

## Sigilix Overview

_Reviewing…_`

const STUB_KV_PREFIX = "pr-overview-stub-posted:"
const STUB_KV_TTL_SECONDS = 5 * 60

/**
 * Compute the KV flag key used to dedupe stub posts across webhook
 * deliveries. Exposed for tests.
 */
export function stubFlagKey(args: {
  owner: string
  repo: string
  prNumber: number
  headSha: string
}): string {
  return `${STUB_KV_PREFIX}${args.owner}/${args.repo}#${args.prNumber}:${args.headSha}`
}

export interface PostStubArgs {
  env: Env
  owner: string
  repo: string
  prNumber: number
  headSha: string
  installationId: number
  /**
   * Optional pre-built GitHubClient from the caller.
   *
   * Sigilix #5 fix (PR #104 review): when the webhook handler has
   * already minted an installation token to load `sigilix.json`, pass
   * the same client through so this helper doesn't duplicate the
   * `getInstallationToken` round-trip. Falls back to minting its own
   * token when omitted (legacy / standalone callers).
   */
  client?: GitHubClient
}

export type PostStubOutcome =
  | { kind: "posted"; commentId: number }
  | { kind: "kv-hit"; commentId: number }
  | { kind: "marker-scan-hit"; commentId: number }
  | { kind: "skipped-disabled" }
  | { kind: "failed"; reason: string }

/**
 * SIG-84: post (or reuse) the pr-overview stub sticky on the PR.
 *
 * Best-effort: any failure is captured into the return value but
 * NEVER thrown. The webhook handler awaits this synchronously, but
 * a transient GitHub 5xx or KV blip cannot be allowed to fail the
 * webhook (GitHub would redeliver — and the second delivery's stub-
 * post would be guarded by the same idempotency anyway).
 *
 * Caller MUST gate on `isPrOverviewEnabled(config)` before invoking
 * — this helper does NOT re-read the config. Keeps the helper
 * independent of the config-load side effect + lets the webhook
 * handler decide whether even to spend a config-load round trip.
 *
 * Resolution order (matches Codex Q2 sign-off):
 *   1. KV fast path. If `stubFlagKey(...)` is present, return
 *      `kv-hit` — a prior delivery already posted the stub.
 *   2. Marker scan fallback. List PR comments and look for the
 *      sigilix-overview marker (bilingual: also matches the legacy
 *      `openclaw:pr-overview` marker). If found, write its id to
 *      KV and return `marker-scan-hit` — handles cross-region KV
 *      misses + the openclaw→sigilix transition.
 *   3. Reset-or-create. With no prior stub for THIS head and an
 *      existing sticky for a PRIOR head, edit that sticky's body
 *      back to `_Reviewing…_` (so the overview handler can rewrite
 *      it again in place); otherwise create a fresh comment. Write
 *      KV flag in both branches.
 */
export async function postPrOverviewStubIfNeeded(
  args: PostStubArgs,
): Promise<PostStubOutcome> {
  const { env, owner, repo, prNumber, headSha, installationId } = args

  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    return { kind: "failed", reason: "github-app-not-configured" }
  }

  const flagKey = stubFlagKey({ owner, repo, prNumber, headSha })

  // ── 1. KV fast path ──────────────────────────────────────────────
  // Cloudflare KV is eventually consistent across regions, so a kv-hit
  // is authoritative but a kv-miss may still hide a stub from a
  // sibling Worker. The marker-scan fallback below covers that.
  try {
    const existing = await env.OPENCLAW_STATE.get(flagKey)
    if (existing !== null) {
      const parsed = Number(existing)
      if (Number.isFinite(parsed) && parsed > 0) {
        return { kind: "kv-hit", commentId: parsed }
      }
      // Malformed value — fall through and re-derive.
    }
  } catch (err) {
    // KV read failure is non-fatal; fall through to the marker scan +
    // create path. Worst case: an extra `listIssueComments` round-trip
    // on this delivery; the create path is still idempotent via the
    // marker scan.
    console.warn(JSON.stringify({
      event: "pr-overview-stub-kv-read-failed",
      owner, repo, prNumber, head_sha: headSha.slice(0, 7),
      err: err instanceof Error ? err.message : String(err),
    }))
  }

  // ── Build (or reuse) a GitHub client ─────────────────────────────
  // Sigilix #5 fix: if the caller passed in a pre-built client (the
  // webhook handler does this), reuse it. Otherwise mint a fresh
  // installation token. Auth gates all remaining work — a failure
  // here returns `failed` and no comment is posted.
  let client: GitHubClient
  if (args.client) {
    client = args.client
  } else {
    try {
      const token = await getInstallationToken({
        kv: env.OPENCLAW_STATE,
        appId: env.GITHUB_APP_ID,
        privateKey: env.GITHUB_PRIVATE_KEY,
        installationId,
      })
      client = new GitHubClient({ token })
    } catch (err) {
      console.error(JSON.stringify({
        event: "pr-overview-stub-auth-failed",
        owner, repo, prNumber, head_sha: headSha.slice(0, 7),
        err: err instanceof Error ? err.message : String(err),
      }))
      return { kind: "failed", reason: "auth-failed" }
    }
  }

  // ── 2. Marker scan fallback ──────────────────────────────────────
  // KV missed (delivery retry, cross-region replication delay, or
  // initial post happening on a different colo). Scan PR comments
  // and look for an existing sigilix-overview marker.
  let existingCommentId: number | null = null
  try {
    existingCommentId = await findExistingOverviewCommentId(
      client, owner, repo, prNumber,
    )
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-overview-stub-marker-scan-failed",
      owner, repo, prNumber, head_sha: headSha.slice(0, 7),
      err: err instanceof Error ? err.message : String(err),
    }))
    // Treat as no-existing-comment and try to create. The create call
    // below is the only remaining write; a transient listIssueComments
    // failure on a fresh PR shouldn't block the stub.
  }

  if (existingCommentId !== null) {
    // ── New-push reset path ───────────────────────────────────────
    // We have an existing sticky from a PRIOR head (no KV hit means
    // it wasn't from THIS head). Edit its body back to `_Reviewing…_`
    // so the overview handler can re-render it in place. The same
    // comment id stays — the GitHub timeline keeps the original
    // position; only the body morphs through states (matches
    // CodeRabbit's UX).
    //
    // For a duplicate webhook delivery for the SAME head the KV fast
    // path would have caught us above. Reaching this branch means
    // either (a) cross-region KV miss for the current head [edit-back-
    // to-self, harmless] or (b) new head landed [reset prior head's
    // body to placeholder, correct].
    try {
      await client.updateIssueComment(owner, repo, existingCommentId, STUB_BODY)
    } catch (err) {
      console.warn(JSON.stringify({
        event: "pr-overview-stub-update-failed",
        owner, repo, prNumber, head_sha: headSha.slice(0, 7),
        comment_id: existingCommentId,
        err: err instanceof Error ? err.message : String(err),
      }))
      // Even if the update failed we still write the flag — there IS a
      // comment on the PR carrying the marker, which is all the review
      // handler's wait gate cares about (it waits for the FLAG, and the
      // flag's contract is "a stub exists"). Trade-off: customer might
      // see a stale walkthrough briefly until the real overview lands.
    }
    await safeWriteFlag(env, flagKey, existingCommentId, owner, repo, prNumber, headSha)
    return { kind: "marker-scan-hit", commentId: existingCommentId }
  }

  // ── 3. Create path ───────────────────────────────────────────────
  let created: { id: number }
  try {
    created = await client.createIssueComment(owner, repo, prNumber, STUB_BODY)
  } catch (err) {
    console.error(JSON.stringify({
      event: "pr-overview-stub-create-failed",
      owner, repo, prNumber, head_sha: headSha.slice(0, 7),
      err: err instanceof Error ? err.message : String(err),
    }))
    return { kind: "failed", reason: "create-failed" }
  }
  await safeWriteFlag(env, flagKey, created.id, owner, repo, prNumber, headSha)
  console.log(JSON.stringify({
    event: "pr-overview-stub-posted",
    owner, repo, prNumber, head_sha: headSha.slice(0, 7),
    comment_id: created.id,
  }))
  return { kind: "posted", commentId: created.id }
}

/**
 * Best-effort KV write. A failure here means the review-side wait
 * will time out at 2s — same as today's worst case. Don't throw.
 */
async function safeWriteFlag(
  env: Env,
  key: string,
  commentId: number,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
): Promise<void> {
  try {
    await env.OPENCLAW_STATE.put(key, String(commentId), {
      expirationTtl: STUB_KV_TTL_SECONDS,
    })
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-overview-stub-kv-write-failed",
      owner, repo, prNumber, head_sha: headSha.slice(0, 7),
      comment_id: commentId,
      err: err instanceof Error ? err.message : String(err),
    }))
  }
}

// ─── SIG-84: review-side wait gate ──────────────────────────────────

/** Default wait ceiling for `waitForPrOverviewStub` — 2s per Codex Q1
 *  sign-off. Bounded so a missing stub doesn't block the review
 *  pipeline; long enough that the typical sub-second stub-post is
 *  almost always already done by the time the review's submit-prep
 *  reaches this gate. */
export const STUB_WAIT_MAX_MS = 2_000
/** Poll interval. 100ms gives ~20 polls within the ceiling — fine
 *  granularity without burning KV requests. */
export const STUB_WAIT_POLL_MS = 100

export interface WaitForStubArgs {
  env: Env
  owner: string
  repo: string
  prNumber: number
  headSha: string
  /** Overrides for tests. Production callers use the defaults. */
  maxMs?: number
  pollMs?: number
  /** Injectable for tests; production uses `Date.now`. */
  now?: () => number
  /** Injectable for tests; production uses a real timeout. */
  sleep?: (ms: number) => Promise<void>
}

export type WaitForStubOutcome =
  | { kind: "stub-present"; waitedMs: number }
  | { kind: "stub-absent"; waitedMs: number }
  | { kind: "stub-kv-error"; waitedMs: number }

/**
 * SIG-84: poll the KV `pr-overview-stub-posted` flag for up to
 * `maxMs` (default 2_000) at `pollMs` intervals (default 100). Returns
 * as soon as the flag appears. If the flag never appears, returns
 * `stub-absent` so the review handler can proceed in degraded mode
 * — same ordering as pre-SIG-84.
 *
 * Pure-ish: no GitHub calls. Only touches KV. Safe to invoke on every
 * pr-review submit; the cost is bounded by `maxMs`.
 *
 * Caller MUST gate on `isPrOverviewEnabled(config)` BEFORE calling —
 * disabled-overview customers should skip the wait entirely (Codex
 * Q5 tweak).
 */
export async function waitForPrOverviewStub(
  args: WaitForStubArgs,
): Promise<WaitForStubOutcome> {
  const {
    env, owner, repo, prNumber, headSha,
    maxMs = STUB_WAIT_MAX_MS,
    pollMs = STUB_WAIT_POLL_MS,
    now = () => Date.now(),
    sleep = defaultSleep,
  } = args

  const key = stubFlagKey({ owner, repo, prNumber, headSha })
  const startMs = now()

  // Fast first-read: vast majority of cases hit here (stub was written
  // synchronously at webhook time, review is ~30+s later).
  const first = await safeRead(env, key)
  if (first.kind === "ok" && first.value !== null) {
    return { kind: "stub-present", waitedMs: 0 }
  }
  if (first.kind === "error") {
    return { kind: "stub-kv-error", waitedMs: 0 }
  }

  // Poll loop. Bounded by wall-clock, NOT by iteration count — the
  // injected `sleep` may run faster than wall-clock in tests, so we
  // re-derive the budget from `now()` every iteration.
  while (now() - startMs < maxMs) {
    await sleep(pollMs)
    const read = await safeRead(env, key)
    if (read.kind === "ok" && read.value !== null) {
      return { kind: "stub-present", waitedMs: now() - startMs }
    }
    if (read.kind === "error") {
      return { kind: "stub-kv-error", waitedMs: now() - startMs }
    }
  }
  return { kind: "stub-absent", waitedMs: now() - startMs }
}

async function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function safeRead(
  env: Env,
  key: string,
): Promise<{ kind: "ok"; value: string | null } | { kind: "error" }> {
  try {
    const v = await env.OPENCLAW_STATE.get(key)
    return { kind: "ok", value: v }
  } catch {
    return { kind: "error" }
  }
}
