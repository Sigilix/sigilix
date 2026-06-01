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
} from "./types"
import { categoryFromRoleHint as _unused } from "./marker"
import {
  computePathSha256,
  extractSigilixMarker,
  hydrateClaimIds,
} from "./marker"
import { isArcGithubLogin } from "../mention"
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
  /**
   * SIG-247 Phase 1: GitHub's immutable `repo.id` for dual-write. When
   * absent (legacy webhook payload, spoofed event, missing field),
   * the capture path calls `client.getRepository(owner, repo)` before
   * falling back to legacy-only writes — that fallback keeps the new
   * keyspace populated even on rare payload-shape gaps.
   */
  repoId?: number
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
  let repoId = args.repoId

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
  let parentLogin: string | undefined
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
    parentLogin = parent.user?.login
  } catch (err) {
    emitTelemetry("review-memory-capture-failed", {
      owner, repo, prNumber, commentId: replyCommentId,
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
      owner, repo, prNumber, commentId: replyCommentId,
      reason: "parent-not-sigilix-author",
      parent_login_present: parentLogin !== undefined,
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

  // Step 7.5 (SIG-247 Phase 1): resolve repoId for dual-write. The
  // webhook handler passes `args.repoId` when `payload.repository.id`
  // is a positive integer. On rare payload-shape gaps (legacy event,
  // spoofed delivery, missing field), fall back to a one-call
  // getRepository lookup — this keeps the new keyspace populated even
  // when the payload is incomplete. Any fallback error degrades to
  // legacy-only writes, never throws.
  if (repoId === undefined) {
    try {
      const repoMeta = await client.getRepository(owner, repo)
      if (
        repoMeta &&
        typeof repoMeta.id === "number" &&
        Number.isInteger(repoMeta.id) &&
        repoMeta.id > 0
      ) {
        repoId = repoMeta.id
      }
    } catch (err) {
      emitTelemetry("review-memory-capture-failed", {
        owner, repo, prNumber, commentId: replyCommentId,
        stage: "repo-id-fallback",
        err: err instanceof Error ? err.message : String(err),
      })
      // Continue with repoId still undefined — appendSignal degrades
      // to legacy-only writes per its positive-integer guard.
    }
  }

  // Step 8: Parallel signal writes
  const signal: ReviewMemorySignal = {
    ts: new Date().toISOString(),
    prNumber,
    commentId: replyCommentId,
    fid: marker.fid,
    kind: dismissal.kind,
    // SIG-114 PR 3: carry the finding's severity tier (always present on a
    // valid marker) so the signal self-reports severity for the offline
    // FP-rate metric beyond the telemetry window (TELEMETRY_TTL_DAYS).
    sev: marker.sev,
  }
  // SIG-114 PR 4: stamp the canonical dismiss reason when the reply stated one
  // (e.g. a reply of "@sigilix dismiss not-a-bug" on the finding's thread).
  // Opt-in via the strict alias table — absent on freeform replies, which stay
  // `unlabeled`. Per-finding (the marker gives the fid), unlike the review-level
  // explicit `@sigilix dismiss` command.
  if (dismissal.dismissReason) signal.dismissReason = dismissal.dismissReason
  // SIG-276 Phase 2: copy the finding's write-time claims (carried on the
  // parent marker) onto the dismissal signal, recomputing each id. The
  // SAME signal object is appended to both the category and path-scope
  // records, so claims land on both. Absent on legacy/claimless markers —
  // we omit the key entirely rather than store an empty array.
  //
  // Claims are ADDITIVE on top of the core dismissal signal. `hydrateClaimIds`
  // awaits crypto.subtle (id = sha16); per this file's never-throws contract
  // its failure must NOT abort the signal write, so we guard it and degrade
  // to no claims + telemetry rather than letting it propagate past the
  // appendSignal calls below.
  let claims: ReviewMemoryClaim[] | undefined
  if (marker.claims && marker.claims.length > 0) {
    try {
      claims = await hydrateClaimIds(marker.claims)
    } catch (err) {
      emitTelemetry("review-memory-capture-failed", {
        owner, repo, prNumber, commentId: replyCommentId,
        stage: "claim-hydrate",
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (claims) signal.claims = claims
  const pathSha256 = await computePathSha256(replyComment.path)
  const settled = await Promise.allSettled([
    appendSignal(env, owner, repo,
      { kind: "category", category: marker.cat },
      signal,
      repoId,
    ),
    appendSignal(env, owner, repo,
      { kind: "path-category", category: marker.cat, pathSha256 },
      signal,
      repoId,
    ),
  ])
  // Only emit `capture-written` for the scope(s) that actually
  // succeeded — appendSignal already emitted capture-failed for any
  // KV throw inside it.
  const catRes = settled[0]
  const pathRes = settled[1]
  const catValue =
    catRes?.status === "fulfilled" ? catRes.value : undefined
  const pathValue =
    pathRes?.status === "fulfilled" ? pathRes.value : undefined
  const catWritten = catValue?.written === true
  const pathWritten = pathValue?.written === true
  if (catWritten || pathWritten) {
    emitTelemetry("review-memory-capture-written", {
      owner, repo, prNumber, commentId: replyCommentId,
      category: marker.cat,
      catWritten,
      pathWritten,
      // SIG-247 Phase 1 canary fields
      repo_id_present: repoId !== undefined,
      legacy_written:
        catValue?.legacyWritten === true ||
        pathValue?.legacyWritten === true,
      new_written:
        catValue?.newWritten === true ||
        pathValue?.newWritten === true,
      partial_dual_write:
        catValue?.partialDualWrite === true ||
        pathValue?.partialDualWrite === true,
      key_mode: repoId !== undefined ? "dual" : "legacy-only",
      // SIG-276 Phase 2 canary fields. Enum types + raw (uncalibrated)
      // confidences only — never reviewer/finding free-text. The raw
      // confidence is logged deliberately so a later phase can calibrate
      // it before it drives any softening (SIG-276 bake-off / Phase 4).
      claims_present: claims !== undefined,
      claim_count: claims?.length ?? 0,
      claim_types: claims?.map((c) => c.type) ?? [],
      claim_confidences: claims?.map((c) => c.confidence) ?? [],
    })
  }
}
