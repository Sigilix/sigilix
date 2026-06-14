// SIG-84 — synchronous review-in-progress stub for the pr-overview sticky.
//
// ─── SIG-219 restoration (2026-05-26) ─────────────────────────────────
//
// SIG-216 (2026-05-25) DEPRECATED this file under the theory that the
// inline overview render inside `handlePrReviewEnsemble` would land
// the overview comment and the formal review in the same time window,
// removing the need for a pre-review "Reviewing…" sticky.
//
// Founder feedback after dogfooding SIG-216: the WANTED UX is closer
// to CodeRabbit — a sticky comment appears immediately on push saying
// "Reviewing…" and MORPHS into the overview when the models finish.
// SIG-216 lost that affordance entirely.
//
// SIG-219 restores the webhook-time stub-post. The new pipeline:
//
//   1. Webhook fires → `postPrOverviewStubIfNeeded` lands the
//      "Reviewing…" sticky within the webhook ack window (sub-second).
//   2. Review ensemble runs in parallel (the SIG-216 win — no
//      synchronous wait barrier).
//   3. Inline overview path inside `handlePrReviewEnsemble` finds
//      the stub via its existing `scanComments` + PATCH logic and
//      rewrites the body in place — no second comment, no ordering
//      barrier needed.
//
// The SIG-216 deprecation comments below are KEPT for history. The
// `waitForPrOverviewStub` helper REMAINS unwired (the new inline path
// removes the need for a wait barrier — the inline render itself is
// the synchronization point now).
//
// ─── SIG-216 deprecation rationale (historical, no longer active) ─────
//
// SIG-216 dropped this entire pre-review-stub pattern in favor of an
// inline overview render inside the ensemble. The ordering guarantee
// was preserved by serializing the overview generation onto the
// review handler's critical path — no separate queue job, no wait
// barrier, no stub. SIG-219 keeps the inline render but layers the
// stub back on top so users see a "Reviewing…" sticky immediately.
//
// ─── Pre-SIG-216 design (kept for context) ──────────────────────────
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
// (SIG-219 keeps the stub-post; the barrier wait is NOT restored — the
// inline overview render inside the ensemble handles ordering.)
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
// resets its body to the review-in-progress placeholder, and rewrites
// the KV flag.

import type { Env } from "@/src/shared/types/env"
import { GitHubClient } from "@/src/shared/adapters/github"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import { OVERVIEW_MARKER, LEGACY_OVERVIEW_MARKER, findExistingOverviewComment } from "./triage-pr-overview"
import { REVIEW_STATUS_BLOCK_END, REVIEW_STATUS_BLOCK_START, buildReviewStatusBlock } from "./pr-review-status-render"
import { renderPrOverviewWaitingArt } from "./pr-overview-waiting-art"

/**
 * Body posted by the stub. The marker on line 1 is what the overview
 * handler greps for to decide POST-vs-PATCH; sharing the same string
 * means the in-place edit Just Works. The v2 stub marker lets
 * `isStubBody` distinguish a real loading state from a completed
 * overview that merely mentions "reviewing".
 */
const STUB_V2_MARKER = "<!-- sigilix:pr-overview-stub:v2 -->"
const DEFAULT_STUB_HEAD_SHA = "0".repeat(40)

export function buildPrOverviewStubBody(args: { prNumber: number; headSha: string }): string {
  const body = `${OVERVIEW_MARKER}

${STUB_V2_MARKER}

**Sigilix is reviewing this pull request.**

A structured overview will replace this note when retrieval and specialist review complete.

${renderPrOverviewWaitingArt(`queued:${args.prNumber}:${args.headSha}`)}`
  return `${body}

${buildReviewStatusBlock({
  phase: "queued",
  headSha: args.headSha,
  sequence: 0,
  specialists: {
    total: 4,
    completed: 0,
    dispatched: ["logic", "security", "performance", "tests"],
  },
  footerSeed: `queued:${args.prNumber}:${args.headSha}`,
})}`
}

export const STUB_BODY = buildPrOverviewStubBody({
  prNumber: 0,
  headSha: DEFAULT_STUB_HEAD_SHA,
})

/**
 * SIG-96: detect whether an existing overview-sticky body is a stub
 * placeholder vs a completed summary. Used by
 * `postPrOverviewStubIfNeeded` to decide whether the reset-to-stub
 * edit on a subsequent push is a no-op idempotent re-write (existing
 * body IS the stub) or would clobber a real summary (existing body
 * is something else, preserve it).
 *
 * CodeRabbit catch on PR #111 (Major): the previous impl substring-
 * matched `_Reviewing…_` anywhere in the body, so a completed
 * summary that happened to quote the placeholder (e.g., a Sigilix-
 * reviews-its-own-PR meta-block, or any future content that
 * mentions the stub format verbatim) got misclassified as a stub
 * and triggered the reset path — clobbering exactly the summary
 * SIG-96 was meant to preserve. Tightened to a whole-body match
 * against exact legacy forms plus the v2 marker-gated placeholder.
 *
 * Non-string input now returns `false`. Pre-fix it returned `true`
 * (defensive "no body = treat as stub") but no real call site
 * actually feeds non-string bodies — `findExistingOverviewComment`
 * filters by `typeof c.body === "string"`. The new semantics
 * (`false` = "this isn't a stub, don't clobber it") matches the
 * function's literal name.
 *
 * Pure — exported for tests.
 */
function buildLegacyStubFormVariants(): readonly string[] {
  // Both marker prefixes × both ellipsis flavors = 4 exact stub
  // strings to whole-match against. Trimmed at compare time.
  const HEADING_BLOCK = "\n\n## Sigilix Overview\n\n"
  const PLACEHOLDER_UNICODE = "_Reviewing…_"
  const PLACEHOLDER_ASCII = "_Reviewing..._"
  return [
    `${OVERVIEW_MARKER}${HEADING_BLOCK}${PLACEHOLDER_UNICODE}`,
    `${OVERVIEW_MARKER}${HEADING_BLOCK}${PLACEHOLDER_ASCII}`,
    `${LEGACY_OVERVIEW_MARKER}${HEADING_BLOCK}${PLACEHOLDER_UNICODE}`,
    `${LEGACY_OVERVIEW_MARKER}${HEADING_BLOCK}${PLACEHOLDER_ASCII}`,
  ].map((s) => s.trim())
}

const LEGACY_STUB_FORM_VARIANTS = buildLegacyStubFormVariants()

function isV2StubBody(trimmed: string): boolean {
  for (const marker of [OVERVIEW_MARKER, LEGACY_OVERVIEW_MARKER]) {
    const oldV2Stub = !trimmed.includes(REVIEW_STATUS_BLOCK_START) && trimmed.endsWith("\n```")
    const currentV2Stub = trimmed.endsWith(REVIEW_STATUS_BLOCK_END)
    if (trimmed.startsWith(marker) && trimmed.includes(STUB_V2_MARKER) && (oldV2Stub || currentV2Stub)) {
      return true
    }
  }
  return false
}

export function isStubBody(body: string | null | undefined): boolean {
  if (typeof body !== "string") return false
  const trimmed = body.trim()
  return LEGACY_STUB_FORM_VARIANTS.includes(trimmed) || isV2StubBody(trimmed)
}

const STUB_KV_PREFIX = "pr-overview-stub-posted:"
const STUB_KV_TTL_SECONDS = 5 * 60

// SIG-92: in-flight tombstone for concurrent webhook deliveries.
// GitHub redelivers slow 202 responses and occasionally fires the same
// `(owner, repo, prNumber, headSha)` event twice within ~1s. The
// existing KV-flag + marker-scan flow races: both deliveries can
// observe an empty KV + empty marker-scan and both create comments.
//
// Coordination: the FIRST delivery to reach the create path writes
// this tombstone with a short TTL. Later deliveries observe the
// tombstone, poll the final flag for ~1.5s, and short-circuit to
// `kv-hit` when the leader's create completes.
//
// Best-effort by design: KV is eventually consistent, so two truly-
// simultaneous deliveries can both observe an empty tombstone +
// proceed. The marker-scan fallback still narrows that window — the
// remaining failure mode is rare and self-corrects on the next push.
const STUB_INFLIGHT_KV_PREFIX = "pr-overview-stub-inflight:"
const STUB_INFLIGHT_TTL_SECONDS = 60
const STUB_CONCURRENT_POLL_INTERVAL_MS = 300
// Code-reviewer MAJOR on PR review: was 10 attempts (~3s). The webhook
// path already adds up to 10s for the create call (STUB_GITHUB_API_TIMEOUT_MS);
// stacking 3s of poll on top risked tripping GitHub's ~10s redelivery
// threshold on the follower. 5 attempts × 300ms = 1.5s ceiling — the
// leader's create typically finishes well under 1s.
const STUB_CONCURRENT_POLL_MAX_ATTEMPTS = 5 // ~1.5s ceiling

// SIG-91 follow-up: hard timeout on GitHub API calls in the webhook
// path. 10s is generous for createIssueComment / updateIssueComment
// (typical p95 < 1s). On timeout, we return a structured failure and
// let the webhook return 202 without the stub; review-side then falls
// through its 2s wait fallback (per SIG-84 contract).
export const STUB_GITHUB_API_TIMEOUT_MS = 10_000

/**
 * Race `p` against a `ms` timeout. Resolves to `{ kind: "ok", value }`
 * on success, `{ kind: "timeout" }` if the timer fires first. The
 * original promise keeps running (orphaned) — we don't propagate
 * cancellation into `fetch` here because GitHubClient's createIssueComment
 * / updateIssueComment don't accept signals; the orphaned request will
 * complete server-side regardless. Timeout semantics are about
 * UNBLOCKING the webhook handler, not about cancelling GitHub work.
 */
async function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<{ kind: "ok"; value: T } | { kind: "timeout" }> {
  let timerId: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
    timerId = setTimeout(() => resolve({ kind: "timeout" }), ms)
  })
  try {
    return await Promise.race([p.then((value) => ({ kind: "ok" as const, value })), timeoutPromise])
  } finally {
    if (timerId !== undefined) clearTimeout(timerId)
  }
}

/**
 * SIG-92: poll the final stub flag for up to
 * `STUB_CONCURRENT_POLL_MAX_ATTEMPTS * STUB_CONCURRENT_POLL_INTERVAL_MS`.
 * Returns the parsed commentId on the first attempt that observes a
 * valid value, or `null` after all attempts. Each iteration swallows
 * KV-read errors and continues — a transient KV blip during polling
 * shouldn't abort the wait.
 *
 * Code-reviewer MINOR on PR review: read FIRST, sleep on subsequent
 * iterations. The leader's create may have completed between the
 * caller's tombstone read and the call into this function — checking
 * once before sleeping saves up to STUB_CONCURRENT_POLL_INTERVAL_MS
 * on the happy path where the leader was already done.
 */
async function pollForFinalFlag(env: Env, flagKey: string): Promise<number | null> {
  for (let attempt = 0; attempt < STUB_CONCURRENT_POLL_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, STUB_CONCURRENT_POLL_INTERVAL_MS))
    }
    try {
      const existing = await env.OPENCLAW_STATE.get(flagKey)
      if (existing !== null) {
        const parsed = Number(existing)
        if (Number.isFinite(parsed) && parsed > 0) return parsed
      }
    } catch {
      // Keep polling — transient KV failures aren't a reason to abort.
    }
  }
  return null
}

/**
 * Compute the KV flag key used to dedupe stub posts across webhook
 * deliveries. Exposed for tests.
 */
export function stubFlagKey(args: { owner: string; repo: string; prNumber: number; headSha: string }): string {
  return `${STUB_KV_PREFIX}${args.owner}/${args.repo}#${args.prNumber}:${args.headSha}`
}

/**
 * SIG-92: KV key for the concurrent-delivery tombstone. Exposed for
 * tests + so the webhook handler (or future operator tooling) can
 * read it for telemetry correlation.
 */
export function stubInflightKey(args: { owner: string; repo: string; prNumber: number; headSha: string }): string {
  return `${STUB_INFLIGHT_KV_PREFIX}${args.owner}/${args.repo}#${args.prNumber}:${args.headSha}`
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
  // SIG-91 follow-up: a GitHub API call (createIssueComment /
  // updateIssueComment) exceeded `STUB_GITHUB_API_TIMEOUT_MS`. The
  // webhook handler still returns 202 promptly; review-side falls
  // through its 2s wait fallback per the SIG-84 contract.
  | { kind: "timeout"; phase: "create" | "update" }
  // Round-5 CR Major catch: the marker-scan path found a prior sticky
  // but `updateIssueComment` threw (race-to-delete, permission
  // revocation, 5xx, etc.). We do NOT write the KV flag and we do NOT
  // advertise the stub as ready — review-side falls through to the 2s
  // wait fallback. The `commentId` is still surfaced for telemetry.
  | { kind: "update-failed"; commentId: number }

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
 *      existing sticky for a PRIOR head, edit that sticky's body back
 *      to the review-in-progress placeholder (so the overview handler
 *      can rewrite it again in place); otherwise create a fresh
 *      comment. Write KV flag in both branches.
 */
export async function postPrOverviewStubIfNeeded(args: PostStubArgs): Promise<PostStubOutcome> {
  const { env, owner, repo, prNumber, headSha, installationId } = args

  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    return { kind: "failed", reason: "github-app-not-configured" }
  }

  const flagKey = stubFlagKey({ owner, repo, prNumber, headSha })
  const stubBody = buildPrOverviewStubBody({ prNumber, headSha })

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
    console.warn(
      JSON.stringify({
        event: "pr-overview-stub-kv-read-failed",
        owner,
        repo,
        prNumber,
        head_sha: headSha.slice(0, 7),
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }

  // ── 1.5. SIG-92 concurrent-delivery short-circuit ────────────────
  // If a prior delivery for the same (owner, repo, prNumber, headSha)
  // is already in flight (or wrote+expired+missed the final KV write),
  // its tombstone is still visible. Poll the final flag for ~1.5s —
  // the leader's create typically finishes in well under a second. On
  // success: return `kv-hit` with the leader's commentId. On poll
  // timeout: fall through (the leader may have failed; we'll attempt).
  //
  // The tombstone-write below happens regardless of whether we found a
  // peer — so the third delivery (if any) shortcuts on EITHER our
  // tombstone OR the leader's tombstone, whichever it sees first.
  const inflightKey = stubInflightKey({ owner, repo, prNumber, headSha })
  let priorInflight: string | null = null
  try {
    priorInflight = await env.OPENCLAW_STATE.get(inflightKey)
  } catch {
    // Best-effort: swallow + fall through. Either we'll see no peer
    // and post normally, or the marker scan + KV fast path on a later
    // delivery will catch us.
  }
  if (priorInflight !== null) {
    const polled = await pollForFinalFlag(env, flagKey)
    if (polled !== null) {
      console.log(
        JSON.stringify({
          event: "pr-overview-stub-concurrent-detected",
          owner,
          repo,
          prNumber,
          head_sha: headSha.slice(0, 7),
          comment_id: polled,
          prior_inflight: priorInflight.slice(0, 8),
          mode: "polled-win",
        }),
      )
      return { kind: "kv-hit", commentId: polled }
    }
    console.warn(
      JSON.stringify({
        event: "pr-overview-stub-concurrent-poll-timeout",
        owner,
        repo,
        prNumber,
        head_sha: headSha.slice(0, 7),
        prior_inflight: priorInflight.slice(0, 8),
      }),
    )
  }
  // Write our own tombstone so any LATER delivery that arrives during
  // our create round-trip can poll instead of racing us. Best-effort —
  // a KV put failure here just degrades us to the pre-SIG-92 behavior
  // (marker-scan catches most races; the rare double-post self-corrects
  // on the next push).
  try {
    await env.OPENCLAW_STATE.put(inflightKey, crypto.randomUUID(), {
      expirationTtl: STUB_INFLIGHT_TTL_SECONDS,
    })
  } catch {
    // Swallow.
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
      console.error(
        JSON.stringify({
          event: "pr-overview-stub-auth-failed",
          owner,
          repo,
          prNumber,
          head_sha: headSha.slice(0, 7),
          err: err instanceof Error ? err.message : String(err),
        }),
      )
      return { kind: "failed", reason: "auth-failed" }
    }
  }

  // ── 2. Marker scan fallback ──────────────────────────────────────
  // KV missed (delivery retry, cross-region replication delay, or
  // initial post happening on a different colo). Scan PR comments
  // and look for an existing sigilix-overview marker.
  //
  // SIG-96: fetch BODY alongside id so we can distinguish a stale
  // stub from a completed summary on subsequent pushes. Pre-fix the
  // helper returned only the id and the caller unconditionally reset
  // the body to a placeholder, clobbering prior summaries on every
  // push.
  let existingComment: { id: number; body: string } | null = null
  try {
    existingComment = await findExistingOverviewComment(client, owner, repo, prNumber)
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "pr-overview-stub-marker-scan-failed",
        owner,
        repo,
        prNumber,
        head_sha: headSha.slice(0, 7),
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    // Treat as no-existing-comment and try to create. The create call
    // below is the only remaining write; a transient listIssueComments
    // failure on a fresh PR shouldn't block the stub.
  }

  if (existingComment !== null) {
    const existingCommentId = existingComment.id

    // SIG-96: if the existing sticky already carries a completed
    // summary (anything other than the placeholder stub), do NOT
    // overwrite it. The overview handler will PATCH it atomically when
    // the fresh render finishes; in the meantime a reviewer landing
    // mid-rerender sees the prior head's summary instead of an empty
    // placeholder. This is the regression fix — pre-fix every push
    // erased the prior summary for the ~30-90s rerender window.
    if (!isStubBody(existingComment.body)) {
      console.log(
        JSON.stringify({
          event: "pr-overview-stub-skipped-existing-summary",
          owner,
          repo,
          prNumber,
          head_sha: headSha.slice(0, 7),
          comment_id: existingCommentId,
        }),
      )
      await safeWriteFlag(env, flagKey, existingCommentId, owner, repo, prNumber, headSha)
      return { kind: "marker-scan-hit", commentId: existingCommentId }
    }

    // ── New-push reset path (existing body IS the stub) ───────────
    // Rare race: cross-region KV miss for the current head's stub, or
    // the legacy openclaw-marker stub from a pre-rebrand sticky. The
    // re-update is idempotent (same body in, same body out) but keeps
    // the SIG-91 timeout-cap path exercised. Same code below as the
    // pre-SIG-96 behavior — only the gate above is new.
    //
    // For a duplicate webhook delivery for the SAME head the KV fast
    // path would have caught us above. Reaching this branch means
    // either (a) cross-region KV miss for the current head [edit-back-
    // to-self, harmless] or (b) the prior body was itself a stub
    // (e.g., a previous webhook timed out before the overview
    // handler rendered the summary — the stub is what's on the
    // timeline and the reset is a no-op).
    // SIG-91 follow-up: cap the update at STUB_GITHUB_API_TIMEOUT_MS.
    // On timeout we emit telemetry and return `{kind: "timeout"}` so
    // the webhook returns 202 promptly. We do NOT write the KV flag on
    // timeout — the review-side wait should fall through to the 2s
    // fallback rather than be told "stub exists" when we can't confirm
    // GitHub accepted the body.
    //
    // Round-5 CR Major catch: the same gating applies to a thrown
    // `updateIssueComment` (race-to-delete, permission revocation, 5xx).
    // We previously wrote the KV flag and returned `marker-scan-hit`
    // regardless — that advertised a stub the helper couldn't confirm
    // was writable. Now we emit telemetry and return `update-failed`
    // without writing the flag; the review-side 2s wait fallback
    // covers the gap. Net effect: that one push's review may submit
    // before the (broken) overview, same degraded mode as a stub-post
    // failure.
    try {
      const raced = await raceWithTimeout(
        client.updateIssueComment(owner, repo, existingCommentId, stubBody),
        STUB_GITHUB_API_TIMEOUT_MS,
      )
      if (raced.kind === "timeout") {
        console.warn(
          JSON.stringify({
            event: "pr-overview-stub-post-timeout",
            phase: "update",
            owner,
            repo,
            prNumber,
            head_sha: headSha.slice(0, 7),
            comment_id: existingCommentId,
            timeout_ms: STUB_GITHUB_API_TIMEOUT_MS,
          }),
        )
        return { kind: "timeout", phase: "update" }
      }
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "pr-overview-stub-update-failed",
          owner,
          repo,
          prNumber,
          head_sha: headSha.slice(0, 7),
          comment_id: existingCommentId,
          err: err instanceof Error ? err.message : String(err),
        }),
      )
      // Do NOT write the KV flag and do NOT return `marker-scan-hit` —
      // we can't confirm the stub body is on the timeline. Surface
      // `update-failed` so callers (and tests) can distinguish this
      // from the success path; the review-side wait will fall through
      // to its 2s ceiling per the SIG-84 contract.
      return { kind: "update-failed", commentId: existingCommentId }
    }
    await safeWriteFlag(env, flagKey, existingCommentId, owner, repo, prNumber, headSha)
    return { kind: "marker-scan-hit", commentId: existingCommentId }
  }

  // ── 3. Create path ───────────────────────────────────────────────
  // SIG-91 follow-up: cap the create at STUB_GITHUB_API_TIMEOUT_MS too.
  // Same rationale as the update branch — webhook must not block on a
  // hung GitHub API. On timeout, return `{kind: "timeout"}` and DON'T
  // write the KV flag.
  let created: { id: number }
  try {
    const raced = await raceWithTimeout(
      client.createIssueComment(owner, repo, prNumber, stubBody),
      STUB_GITHUB_API_TIMEOUT_MS,
    )
    if (raced.kind === "timeout") {
      console.warn(
        JSON.stringify({
          event: "pr-overview-stub-post-timeout",
          phase: "create",
          owner,
          repo,
          prNumber,
          head_sha: headSha.slice(0, 7),
          timeout_ms: STUB_GITHUB_API_TIMEOUT_MS,
        }),
      )
      return { kind: "timeout", phase: "create" }
    }
    created = raced.value
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "pr-overview-stub-create-failed",
        owner,
        repo,
        prNumber,
        head_sha: headSha.slice(0, 7),
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    return { kind: "failed", reason: "create-failed" }
  }
  await safeWriteFlag(env, flagKey, created.id, owner, repo, prNumber, headSha)
  console.log(
    JSON.stringify({
      event: "pr-overview-stub-posted",
      owner,
      repo,
      prNumber,
      head_sha: headSha.slice(0, 7),
      comment_id: created.id,
    }),
  )
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
    console.warn(
      JSON.stringify({
        event: "pr-overview-stub-kv-write-failed",
        owner,
        repo,
        prNumber,
        head_sha: headSha.slice(0, 7),
        comment_id: commentId,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
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
export async function waitForPrOverviewStub(args: WaitForStubArgs): Promise<WaitForStubOutcome> {
  const {
    env,
    owner,
    repo,
    prNumber,
    headSha,
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

async function safeRead(env: Env, key: string): Promise<{ kind: "ok"; value: string | null } | { kind: "error" }> {
  try {
    const v = await env.OPENCLAW_STATE.get(key)
    return { kind: "ok", value: v }
  } catch {
    return { kind: "error" }
  }
}
