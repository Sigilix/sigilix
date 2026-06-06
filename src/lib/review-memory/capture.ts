// ARC-189 — Capture pipeline (Task 9).
//
// Dispatched from the existing `pull_request_review_comment.created`
// queue handler via `ctx.waitUntil(captureReviewFeedback(...))` so KV
// read-modify-write does NOT block the webhook response or the
// review-trigger pipeline.
//
// Pipeline (spec §4.2):
//   1. Resolve IDs from webhook payload:
//        replyCommentId  = payload.comment.id          (dedupe + signal)
//        parentCommentId = payload.comment.in_reply_to_id  (parent fetch)
//      Reject if parentCommentId is absent (top-level comment, not a
//      reply).
//   2. Gate-check: env CAPTURE on AND
//      (sigilix.json `enabled === true` OR `captureOnly === true`).
//   3. Read seen-marker `feedback-capture-seen:<replyCommentId>`; if
//      present → already-seen skip + exit.
//   4. Fetch parent comment body via
//      client.getPullRequestReviewComment(owner, repo, parentCommentId).
//   5. extractSigilixMarker(parentBody); null → skip.
//   6. parseDismissalSignal(replyBody); null → skip.
//   7. Write seen-marker FIRST (best-effort dedupe; no-CAS).
//   8. In parallel via Promise.allSettled, write category-scope and
//      path-category-scope signals. The path-scope KV key uses the
//      FULL SHA-256 of `replyComment.path` so it matches the
//      lookup keyspace (lookup hashes its `paths[]` arg the same way).
//   9. Emit `review-memory-capture-written` telemetry.
//
// Best-effort: never throws; all KV / GH errors logged-and-swallowed.

import type { Env } from "../../index"
import type { GitHubClient } from "../github"
import type {
  ResolvedReviewMemoryConfig,
  ReviewMemoryClaim,
  ReviewMemorySignal,
  SigilixCommentMarker,
} from "./types"
import {
  computePathSha256,
  extractSigilixMarker,
  hydrateClaimIds,
} from "./marker"
import { isArcGithubLogin } from "../mention"
import {
  parseReviewFeedbackSignal,
  type ParsedReviewFeedback,
} from "./parse-dismissal"
import { appendSignal } from "./storage"
import { recordOutcome } from "../precision-profile/store"
import { recordDismissalMetric } from "../validation-metrics-client"
import type { FindingOutcome } from "../precision-profile/types"
import {
  parseFindingOutcomeMarkers,
} from "../pr-finding-markers"
import type { DismissReason } from "../dismiss-reasons"

const SEEN_MARKER_TTL_SECONDS = 7 * 24 * 60 * 60

interface CaptureArgs {
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  /**
   * Reply comment from `pull_request_review_comment.created` payload.
   * Required fields:
   *   - `id`: the reply's own comment ID (dedupe key + signal record)
   *   - `body`: reply text (scanned by parseDismissalSignal)
   *   - `in_reply_to_id`: parent comment ID (fetched via REST for the
   *     parent body, where the sigilix marker lives)
   *   - `path`: file path the comment is anchored to (hashed for the
   *     path-category KV key)
   */
  replyComment: {
    id: number
    body: string
    in_reply_to_id?: number
    path: string
  }
  config: ResolvedReviewMemoryConfig
  /**
   * SIG-247 Phase 1: GitHub's immutable `repo.id` for dual-write. When
   * absent (legacy webhook payload, spoofed event, missing field),
   * the capture path calls `client.getRepository(owner, repo)` before
   * falling back to legacy-only writes — that fallback keeps the new
   * keyspace populated even on rare payload-shape gaps.
   */
  repoId?: number
}

interface TopLevelCaptureArgs {
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  comment: {
    id: number
    body: string
  }
  config: ResolvedReviewMemoryConfig
  repoId?: number
}

interface DismissedReviewCaptureArgs {
  env: Env
  owner: string
  repo: string
  prNumber: number
  review: {
    id: number
    body: string
    commit_id?: string
    user?: { login?: string }
  }
  headSha: string
  config: ResolvedReviewMemoryConfig
}

type SignalSource =
  | "inline-reply"
  | "top-level-explicit"
  | "review-dismissed-stale"

interface TrustedSigilixSource {
  body: string
  marker: SigilixCommentMarker | null
  path?: string
}

function emitTelemetry(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }))
}

function captureGateOpen(
  env: Env,
  config: ResolvedReviewMemoryConfig,
): boolean {
  if (env.OPENCLAW_REVIEW_MEMORY_CAPTURE !== "on") return false
  return config.enabled || config.captureOnly
}

function seenKeyFor(source: SignalSource, id: number): string {
  return source === "inline-reply"
    ? `feedback-capture-seen:${id}`
    : `feedback-capture-seen:${source}:${id}`
}

async function markSeen(
  env: Env,
  key: string,
  fields: Record<string, unknown>,
): Promise<void> {
  try {
    await env.OPENCLAW_STATE.put(key, "1", {
      expirationTtl: SEEN_MARKER_TTL_SECONDS,
    })
  } catch (err) {
    emitTelemetry("review-memory-capture-failed", {
      ...fields,
      stage: "kv-write",
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

async function alreadySeen(
  env: Env,
  key: string,
  fields: Record<string, unknown>,
): Promise<boolean> {
  try {
    const seen = await env.OPENCLAW_STATE.get(key)
    if (seen !== null) {
      emitTelemetry("review-memory-capture-skipped", {
        ...fields,
        reason: "already-seen",
      })
      return true
    }
  } catch (err) {
    emitTelemetry("review-memory-capture-failed", {
      ...fields,
      stage: "kv-read",
      err: err instanceof Error ? err.message : String(err),
    })
  }
  return false
}

async function resolveRepoIdForCapture(args: {
  client: GitHubClient
  owner: string
  repo: string
  repoId?: number
  fields: Record<string, unknown>
}): Promise<number | undefined> {
  if (args.repoId !== undefined) return args.repoId
  try {
    const repoMeta = await args.client.getRepository(args.owner, args.repo)
    if (
      repoMeta &&
      typeof repoMeta.id === "number" &&
      Number.isInteger(repoMeta.id) &&
      repoMeta.id > 0
    ) {
      return repoMeta.id
    }
  } catch (err) {
    emitTelemetry("review-memory-capture-failed", {
      ...args.fields,
      stage: "repo-id-fallback",
      err: err instanceof Error ? err.message : String(err),
    })
  }
  return undefined
}

async function hydrateClaimsForSignal(args: {
  marker: SigilixCommentMarker
  fields: Record<string, unknown>
}): Promise<ReviewMemoryClaim[] | undefined> {
  if (!args.marker.claims || args.marker.claims.length === 0) return undefined
  try {
    return await hydrateClaimIds(args.marker.claims)
  } catch (err) {
    emitTelemetry("review-memory-capture-failed", {
      ...args.fields,
      stage: "claim-hydrate",
      err: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

async function recordDismissalReasonMetric(
  env: Env,
  dismissReason: DismissReason | undefined,
  fields: Record<string, unknown>,
): Promise<void> {
  await recordDismissalMetric(env, {
    reason: dismissReason ?? "unlabeled",
  }).catch((err) => {
    emitTelemetry("review-memory-capture-failed", {
      ...fields,
      stage: "dismissal-metric",
      err: err instanceof Error ? err.message : String(err),
    })
  })
}

async function recordPrecisionOutcomesFromBody(args: {
  env: Env
  owner: string
  repo: string
  prNumber: number
  commentId: number
  source: SignalSource
  body: string
  outcome: FindingOutcome
}): Promise<number> {
  const markers = parseFindingOutcomeMarkers(args.body)
  if (markers.length === 0) {
    emitTelemetry("review-feedback-outcome-skipped", {
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      commentId: args.commentId,
      signal_source: args.source,
      outcome: args.outcome,
      reason: "no-fingerprint",
    })
    return 0
  }
  let recorded = 0
  for (const marker of markers) {
    const ok = await recordOutcome(args.env, {
      repoId: `${args.owner}/${args.repo}`,
      category: marker.category,
      patternHash: marker.patternHash,
      outcome: args.outcome,
    }).catch(() => false)
    if (ok) recorded += 1
  }
  if (recorded > 0) {
    emitTelemetry("review-feedback-outcome-recorded", {
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      commentId: args.commentId,
      signal_source: args.source,
      outcome: args.outcome,
      pattern_count: recorded,
    })
  }
  return recorded
}

async function writeDismissalMemorySignal(args: {
  env: Env
  owner: string
  repo: string
  prNumber: number
  commentId: number
  source: SignalSource
  marker: SigilixCommentMarker
  path?: string
  dismissReason?: DismissReason
  repoId?: number
}): Promise<void> {
  const fields = {
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
    commentId: args.commentId,
    signal_source: args.source,
  }
  const signal: ReviewMemorySignal = {
    ts: new Date().toISOString(),
    prNumber: args.prNumber,
    commentId: args.commentId,
    fid: args.marker.fid,
    kind: "dismissed-textual",
    sev: args.marker.sev,
  }
  if (args.dismissReason) signal.dismissReason = args.dismissReason
  const claims = await hydrateClaimsForSignal({ marker: args.marker, fields })
  if (claims) signal.claims = claims

  const writes: Array<Promise<Awaited<ReturnType<typeof appendSignal>>>> = [
    appendSignal(args.env, args.owner, args.repo,
      { kind: "category", category: args.marker.cat },
      signal,
      args.repoId,
    ),
  ]
  if (args.path !== undefined) {
    const pathSha256 = await computePathSha256(args.path)
    writes.push(
      appendSignal(args.env, args.owner, args.repo,
        { kind: "path-category", category: args.marker.cat, pathSha256 },
        signal,
        args.repoId,
      ),
    )
  }
  const settled = await Promise.allSettled(writes)
  const catValue =
    settled[0]?.status === "fulfilled" ? settled[0].value : undefined
  const pathValue =
    settled[1]?.status === "fulfilled" ? settled[1].value : undefined
  const catWritten = catValue?.written === true
  const pathWritten = pathValue?.written === true
  if (catWritten || pathWritten) {
    emitTelemetry("review-memory-capture-written", {
      ...fields,
      category: args.marker.cat,
      catWritten,
      pathWritten,
      repo_id_present: args.repoId !== undefined,
      legacy_written:
        catValue?.legacyWritten === true ||
        pathValue?.legacyWritten === true,
      new_written:
        catValue?.newWritten === true ||
        pathValue?.newWritten === true,
      partial_dual_write:
        catValue?.partialDualWrite === true ||
        pathValue?.partialDualWrite === true,
      key_mode: args.repoId !== undefined ? "dual" : "legacy-only",
      claims_present: claims !== undefined,
      claim_count: claims?.length ?? 0,
      claim_types: claims?.map((c) => c.type) ?? [],
      claim_confidences: claims?.map((c) => c.confidence) ?? [],
    })
  }
}

async function applyFeedbackToTrustedSource(args: {
  env: Env
  owner: string
  repo: string
  prNumber: number
  commentId: number
  source: SignalSource
  feedback: ParsedReviewFeedback
  trusted: TrustedSigilixSource
  repoId?: number
}): Promise<void> {
  const precisionOutcome =
    args.feedback.outcome === "dismissed" ? "dismissed" : "accepted"
  await recordPrecisionOutcomesFromBody({
    env: args.env,
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
    commentId: args.commentId,
    source: args.source,
    body: args.trusted.body,
    outcome: precisionOutcome,
  })
  if (args.feedback.outcome !== "dismissed") return
  await recordDismissalReasonMetric(args.env, args.feedback.dismissReason, {
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
    commentId: args.commentId,
    signal_source: args.source,
  })
  if (args.trusted.marker === null) {
    // Fingerprint-only correlations still feed precision outcomes; review
    // memory needs the legacy marker metadata, so it stops here.
    emitTelemetry("review-memory-capture-skipped", {
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      commentId: args.commentId,
      signal_source: args.source,
      reason: "no-marker-found",
    })
    return
  }
  await writeDismissalMemorySignal({
    env: args.env,
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
    commentId: args.commentId,
    source: args.source,
    marker: args.trusted.marker,
    ...(args.trusted.path !== undefined ? { path: args.trusted.path } : {}),
    ...(args.feedback.dismissReason !== undefined
      ? { dismissReason: args.feedback.dismissReason }
      : {}),
    ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
  })
}

/**
 * Best-effort capture of a reviewer dismissal reply. Never throws;
 * all KV / GH errors are logged-and-swallowed so the webhook path
 * stays clean. Caller is expected to wrap in `ctx.waitUntil(...)`.
 */
export async function captureReviewFeedback(args: CaptureArgs): Promise<void> {
  const { env, client, owner, repo, prNumber, replyComment, config } = args
  let repoId = args.repoId
  const source: SignalSource = "inline-reply"

  // Step 1: ID resolution + non-reply early exit
  const replyCommentId = replyComment.id
  const parentCommentId = replyComment.in_reply_to_id
  if (typeof parentCommentId !== "number") {
    emitTelemetry("review-memory-capture-skipped", {
      owner, repo, prNumber, commentId: replyCommentId,
      signal_source: source,
      reason: "not-a-reply",
    })
    return
  }

  // Step 2: Gate check
  if (!captureGateOpen(env, config)) {
    emitTelemetry("review-memory-capture-skipped", {
      owner, repo, prNumber, commentId: replyCommentId,
      signal_source: source,
      reason: "capture-disabled",
    })
    return
  }

  // Step 3: Seen-marker dedupe
  const seenKey = seenKeyFor(source, replyCommentId)
  const baseFields = {
    owner, repo, prNumber, commentId: replyCommentId,
    signal_source: source,
  }
  if (await alreadySeen(env, seenKey, baseFields)) return

  // Step 4: Parent fetch
  let parentBody: string
  let parentLogin: string | undefined
  try {
    const parent = await client.getPullRequestReviewComment(
      owner, repo, parentCommentId,
    )
    if (parent === null) {
      emitTelemetry("review-memory-capture-skipped", {
        ...baseFields,
        reason: "parent-fetch-failed",
      })
      return
    }
    parentBody = parent.body
    parentLogin = parent.user?.login
  } catch (err) {
    emitTelemetry("review-memory-capture-failed", {
      ...baseFields,
      stage: "parent-fetch",
      err: err instanceof Error ? err.message : String(err),
    })
    return
  }

  // Step 4.5 (SIG-247 Phase 1): parent App-author gate. The marker
  // parser is a pure body regex (marker.ts:167-211) — without an
  // author check, any commenter can paste a valid marker into their
  // own inline comment and reply "false positive" to themselves to
  // write a dismissal signal. Require the parent comment to be
  // authored by the Sigilix App before trusting its marker.
  if (!isArcGithubLogin(parentLogin)) {
    emitTelemetry("review-memory-capture-skipped", {
      ...baseFields,
      reason: "parent-not-sigilix-author",
      parent_login_present: parentLogin !== undefined,
    })
    return
  }

  // Step 5: Marker extraction
  const marker = extractSigilixMarker(parentBody)
  if (!marker) {
    emitTelemetry("review-memory-capture-skipped", {
      ...baseFields,
      reason: "not-a-reply-to-sigilix",
    })
    return
  }

  // Step 6: Feedback-signal parse
  const feedback = parseReviewFeedbackSignal(replyComment.body)
  if (!feedback) {
    emitTelemetry("review-memory-capture-skipped", {
      ...baseFields,
      reason: "no-dismissal-keyword",
    })
    return
  }

  // Step 7: Write seen-marker FIRST (best-effort dedupe under no-CAS)
  await markSeen(env, seenKey, baseFields)

  // Step 7.5 (SIG-247 Phase 1): resolve repoId for dual-write. The
  // webhook handler passes `args.repoId` when `payload.repository.id`
  // is a positive integer. On rare payload-shape gaps (legacy event,
  // spoofed delivery, missing field), fall back to a one-call
  // getRepository lookup — this keeps the new keyspace populated even
  // when the payload is incomplete. Any fallback error degrades to
  // legacy-only writes, never throws.
  repoId = await resolveRepoIdForCapture({
    client, owner, repo, fields: baseFields,
    ...(repoId !== undefined ? { repoId } : {}),
  })

  // Step 8: normalized sinks
  await applyFeedbackToTrustedSource({
    env,
    owner,
    repo,
    prNumber,
    commentId: replyCommentId,
    source,
    feedback,
    trusted: { body: parentBody, marker, path: replyComment.path },
    ...(repoId !== undefined ? { repoId } : {}),
  })
}

function sourceMatchesExplicitCorrelation(args: {
  sourceBody: string
  explicitMarker: SigilixCommentMarker | null
  explicitFingerprints: ReadonlySet<string>
}): boolean {
  const sourceMarker = extractSigilixMarker(args.sourceBody)
  if (
    args.explicitMarker !== null &&
    sourceMarker !== null &&
    sourceMarker.fid === args.explicitMarker.fid
  ) {
    return true
  }
  if (args.explicitFingerprints.size === 0) return false
  return parseFindingOutcomeMarkers(args.sourceBody)
    .some((m) => args.explicitFingerprints.has(m.patternHash))
}

export function hasExplicitTopLevelReviewFeedbackSignal(body: unknown): boolean {
  if (typeof body !== "string") return false
  if (!parseReviewFeedbackSignal(body)) return false
  return extractSigilixMarker(body) !== null ||
    parseFindingOutcomeMarkers(body).length > 0
}

export function hasStaleDismissedReviewFeedbackSignal(
  review: unknown,
  headSha: unknown,
): boolean {
  if (
    typeof review !== "object" ||
    review === null ||
    typeof headSha !== "string" ||
    headSha.length === 0
  ) {
    return false
  }
  const r = review as {
    body?: unknown
    commit_id?: unknown
    user?: { login?: unknown }
  }
  if (typeof r.body !== "string") return false
  if (!isArcGithubLogin(typeof r.user?.login === "string" ? r.user.login : null)) {
    return false
  }
  if (
    typeof r.commit_id !== "string" ||
    r.commit_id.length === 0 ||
    r.commit_id === headSha
  ) {
    return false
  }
  return parseFindingOutcomeMarkers(r.body).length > 0
}

async function findTrustedSigilixSourceForTopLevel(args: {
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  explicitMarker: SigilixCommentMarker | null
  explicitFingerprints: ReadonlySet<string>
}): Promise<TrustedSigilixSource | null> {
  const [pr, reviews, issueComments, reviewComments] = await Promise.all([
    args.client.getPullRequest(args.owner, args.repo, args.prNumber),
    args.client.listPullRequestReviews(args.owner, args.repo, args.prNumber),
    args.client.listIssueComments(args.owner, args.repo, args.prNumber),
    args.client.listPullRequestReviewComments(args.owner, args.repo, args.prNumber),
  ])
  if (
    typeof pr.body === "string" &&
    isArcGithubLogin(pr.user?.login ?? null) &&
    sourceMatchesExplicitCorrelation({
      sourceBody: pr.body,
      explicitMarker: args.explicitMarker,
      explicitFingerprints: args.explicitFingerprints,
    })
  ) {
    return {
      body: pr.body,
      marker: extractSigilixMarker(pr.body),
    }
  }
  for (const review of reviews) {
    if (!isArcGithubLogin(review.user?.login ?? null)) continue
    if (!sourceMatchesExplicitCorrelation({
      sourceBody: review.body,
      explicitMarker: args.explicitMarker,
      explicitFingerprints: args.explicitFingerprints,
    })) continue
    return {
      body: review.body,
      marker: extractSigilixMarker(review.body),
    }
  }
  for (const comment of reviewComments) {
    if (!isArcGithubLogin(comment.user?.login ?? null)) continue
    if (!sourceMatchesExplicitCorrelation({
      sourceBody: comment.body,
      explicitMarker: args.explicitMarker,
      explicitFingerprints: args.explicitFingerprints,
    })) continue
    return {
      body: comment.body,
      marker: extractSigilixMarker(comment.body),
      path: comment.path,
    }
  }
  for (const comment of issueComments) {
    if (!isArcGithubLogin(comment.user?.login ?? null)) continue
    if (!sourceMatchesExplicitCorrelation({
      sourceBody: comment.body,
      explicitMarker: args.explicitMarker,
      explicitFingerprints: args.explicitFingerprints,
    })) continue
    return {
      body: comment.body,
      marker: extractSigilixMarker(comment.body),
    }
  }
  return null
}

/**
 * SIG-185: best-effort capture for top-level PR conversation comments.
 *
 * Top-level GitHub issue comments have no reply-chain parent, so this path
 * requires explicit correlation in the human comment body (a copied Sigilix
 * marker or hidden finding fingerprint) and verifies that correlation against
 * a real Sigilix-authored PR comment/review comment before recording anything.
 * No timeline-order heuristic is trusted.
 */
export async function captureTopLevelReviewFeedback(
  args: TopLevelCaptureArgs,
): Promise<void> {
  const { env, client, owner, repo, prNumber, comment, config } = args
  const source: SignalSource = "top-level-explicit"
  const baseFields = {
    owner, repo, prNumber, commentId: comment.id,
    signal_source: source,
  }
  if (!captureGateOpen(env, config)) {
    emitTelemetry("review-memory-capture-skipped", {
      ...baseFields,
      reason: "capture-disabled",
    })
    return
  }

  const feedback = parseReviewFeedbackSignal(comment.body)
  if (!feedback) {
    emitTelemetry("review-memory-capture-skipped", {
      ...baseFields,
      reason: "no-dismissal-keyword",
    })
    return
  }
  const explicitMarker = extractSigilixMarker(comment.body)
  const explicitFingerprints = new Set(
    parseFindingOutcomeMarkers(comment.body).map((m) => m.patternHash),
  )
  if (explicitMarker === null && explicitFingerprints.size === 0) {
    emitTelemetry("review-memory-capture-skipped", {
      ...baseFields,
      reason: "no-marker-found",
    })
    return
  }

  const seenKey = seenKeyFor(source, comment.id)
  if (await alreadySeen(env, seenKey, baseFields)) return

  let trusted: TrustedSigilixSource | null
  try {
    trusted = await findTrustedSigilixSourceForTopLevel({
      client, owner, repo, prNumber, explicitMarker, explicitFingerprints,
    })
  } catch (err) {
    emitTelemetry("review-memory-capture-failed", {
      ...baseFields,
      stage: "source-verify",
      err: err instanceof Error ? err.message : String(err),
    })
    return
  }
  if (trusted === null) {
    emitTelemetry("review-memory-capture-skipped", {
      ...baseFields,
      reason: "not-a-reply-to-sigilix",
    })
    return
  }

  await markSeen(env, seenKey, baseFields)
  const repoId = await resolveRepoIdForCapture({
    client, owner, repo, fields: baseFields,
    ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
  })
  await applyFeedbackToTrustedSource({
    env,
    owner,
    repo,
    prNumber,
    commentId: comment.id,
    source,
    feedback,
    trusted,
    ...(repoId !== undefined ? { repoId } : {}),
  })
}

/**
 * SIG-185: formal GitHub review dismissal capture. A GitHub review dismissal is
 * not the same as a reviewer saying "false positive"; record only a stale
 * SIG-147 outcome, and only when the dismissed Sigilix review was for an older
 * commit than the current PR head and its body contains mappable finding
 * fingerprints.
 */
export async function captureDismissedReviewFeedback(
  args: DismissedReviewCaptureArgs,
): Promise<void> {
  const { env, owner, repo, prNumber, review, headSha, config } = args
  const source: SignalSource = "review-dismissed-stale"
  const baseFields = {
    owner, repo, prNumber, commentId: review.id,
    signal_source: source,
  }
  if (!captureGateOpen(env, config)) {
    emitTelemetry("review-memory-capture-skipped", {
      ...baseFields,
      reason: "capture-disabled",
    })
    return
  }
  if (!isArcGithubLogin(review.user?.login ?? null)) {
    emitTelemetry("review-memory-capture-skipped", {
      ...baseFields,
      reason: "parent-not-sigilix-author",
      parent_login_present: review.user?.login !== undefined,
    })
    return
  }
  if (!review.commit_id || review.commit_id === headSha) {
    emitTelemetry("review-memory-capture-skipped", {
      ...baseFields,
      reason: "review-dismissed-without-stale-sha",
    })
    return
  }
  const seenKey = seenKeyFor(source, review.id)
  if (await alreadySeen(env, seenKey, baseFields)) return
  await markSeen(env, seenKey, baseFields)
  await recordPrecisionOutcomesFromBody({
    env,
    owner,
    repo,
    prNumber,
    commentId: review.id,
    source,
    body: review.body,
    outcome: "stale",
  })
}
