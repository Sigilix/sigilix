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
  ReviewMemorySignal,
} from "./types"
import { categoryFromRoleHint as _unused } from "./marker"
import { computePathSha256, extractSigilixMarker } from "./marker"
import { parseDismissalSignal } from "./parse-dismissal"
import { appendSignal } from "./storage"

void _unused  // silence "unused import" — re-export keeps import-graph cohesion

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

/**
 * Best-effort capture of a reviewer dismissal reply. Never throws;
 * all KV / GH errors are logged-and-swallowed so the webhook path
 * stays clean. Caller is expected to wrap in `ctx.waitUntil(...)`.
 */
export async function captureReviewFeedback(args: CaptureArgs): Promise<void> {
  const { env, client, owner, repo, prNumber, replyComment, config } = args

  // Step 1: ID resolution + non-reply early exit
  const replyCommentId = replyComment.id
  const parentCommentId = replyComment.in_reply_to_id
  if (typeof parentCommentId !== "number") {
    emitTelemetry("review-memory-capture-skipped", {
      owner, repo, prNumber, commentId: replyCommentId,
      reason: "not-a-reply",
    })
    return
  }

  // Step 2: Gate check
  if (!captureGateOpen(env, config)) {
    emitTelemetry("review-memory-capture-skipped", {
      owner, repo, prNumber, commentId: replyCommentId,
      reason: "capture-disabled",
    })
    return
  }

  // Step 3: Seen-marker dedupe
  const seenKey = `feedback-capture-seen:${replyCommentId}`
  try {
    const seen = await env.OPENCLAW_STATE.get(seenKey)
    if (seen !== null) {
      emitTelemetry("review-memory-capture-skipped", {
        owner, repo, prNumber, commentId: replyCommentId,
        reason: "already-seen",
      })
      return
    }
  } catch (err) {
    // KV read failure on the seen-marker is best-effort; treat as
    // not-seen and continue. The signal-write read-modify-write
    // catches its own KV failures separately.
    emitTelemetry("review-memory-capture-failed", {
      owner, repo, prNumber, commentId: replyCommentId,
      stage: "kv-read",
      err: err instanceof Error ? err.message : String(err),
    })
  }

  // Step 4: Parent fetch
  let parentBody: string
  try {
    const parent = await client.getPullRequestReviewComment(
      owner, repo, parentCommentId,
    )
    if (parent === null) {
      emitTelemetry("review-memory-capture-skipped", {
        owner, repo, prNumber, commentId: replyCommentId,
        reason: "parent-fetch-failed",
      })
      return
    }
    parentBody = parent.body
  } catch (err) {
    emitTelemetry("review-memory-capture-failed", {
      owner, repo, prNumber, commentId: replyCommentId,
      stage: "parent-fetch",
      err: err instanceof Error ? err.message : String(err),
    })
    return
  }

  // Step 5: Marker extraction
  const marker = extractSigilixMarker(parentBody)
  if (!marker) {
    emitTelemetry("review-memory-capture-skipped", {
      owner, repo, prNumber, commentId: replyCommentId,
      reason: "not-a-reply-to-sigilix",
    })
    return
  }

  // Step 6: Dismissal-signal parse
  const dismissal = parseDismissalSignal(replyComment.body)
  if (!dismissal) {
    emitTelemetry("review-memory-capture-skipped", {
      owner, repo, prNumber, commentId: replyCommentId,
      reason: "no-dismissal-keyword",
    })
    return
  }

  // Step 7: Write seen-marker FIRST (best-effort dedupe under no-CAS)
  try {
    await env.OPENCLAW_STATE.put(seenKey, "1", {
      expirationTtl: SEEN_MARKER_TTL_SECONDS,
    })
  } catch (err) {
    emitTelemetry("review-memory-capture-failed", {
      owner, repo, prNumber, commentId: replyCommentId,
      stage: "kv-write",
      err: err instanceof Error ? err.message : String(err),
    })
    // Continue: signal writes are still useful even if dedupe missed
  }

  // Step 8: Parallel signal writes
  const signal: ReviewMemorySignal = {
    ts: new Date().toISOString(),
    prNumber,
    commentId: replyCommentId,
    fid: marker.fid,
    kind: dismissal.kind,
  }
  const pathSha256 = await computePathSha256(replyComment.path)
  const settled = await Promise.allSettled([
    appendSignal(env, owner, repo,
      { kind: "category", category: marker.cat },
      signal,
    ),
    appendSignal(env, owner, repo,
      { kind: "path-category", category: marker.cat, pathSha256 },
      signal,
    ),
  ])
  // Only emit `capture-written` for the scope(s) that actually
  // succeeded — appendSignal already emitted capture-failed for any
  // KV throw inside it.
  const catRes = settled[0]
  const pathRes = settled[1]
  if (
    (catRes?.status === "fulfilled" && catRes.value.written) ||
    (pathRes?.status === "fulfilled" && pathRes.value.written)
  ) {
    emitTelemetry("review-memory-capture-written", {
      owner, repo, prNumber, commentId: replyCommentId,
      category: marker.cat,
      catWritten: catRes?.status === "fulfilled" && catRes.value.written,
      pathWritten: pathRes?.status === "fulfilled" && pathRes.value.written,
    })
  }
}
