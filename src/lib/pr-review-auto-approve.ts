// SIG-223: state-machine-only auto-APPROVE when the latest blocking
// Sigilix review's finding threads are resolved on the same head SHA.

import type { PullRequestMeta, ReviewComment, SubmitReviewBody } from "@/src/shared/types/github"
import { LEGACY_REVIEW_BODY_MARKER, SIGILIX_BOT_LOGIN, SIGILIX_REVIEW_BODY_MARKER } from "./dismiss-prior-reviews"
import { stripQuotesAndCode } from "./mention"
import { isAuthorAllowedForSlashCommand } from "./slash-commands"

const FINDING_COMMENT_MARKER = "<!-- sigilix:pr-review-finding -->"
const AUTO_APPROVE_IN_PROGRESS_TTL_SECONDS = 15 * 60
const AUTO_APPROVE_RESULT_TTL_SECONDS = 30 * 24 * 60 * 60
const AUTO_APPROVE_IN_PROGRESS_KIND = "review-auto-approve-in-progress"
const AUTO_APPROVE_APPROVED_KIND = "review-auto-approve-result"
const TRUSTED_THREAD_RESOLVED_KIND = "trusted-thread-resolved"

type ResolutionMode = "thread-resolved" | "dismiss-cmd"
type FailurePhase = "list-reviews" | "get-pr" | "list-resolution-state" | "lock" | "submit"

export type AutoApproveTrigger = "thread-resolved" | "review-comment-created" | "issue-command"

interface PullRequestReview {
  id: number
  state: string
  user: { login: string } | null
  body: string
  commitId: string | null
}

interface ReviewThread {
  id: string
  isResolved: boolean
  firstCommentId?: number
  firstCommentLogin: string | null
}

type AutoApproveDedupeRecord =
  | { kind: typeof AUTO_APPROVE_IN_PROGRESS_KIND; token: string; createdAt: number }
  | {
      kind: typeof AUTO_APPROVE_APPROVED_KIND
      reviewId: number
      approvalReviewId: number
      headSha: string
      approvedAt: number
    }

type AutoApproveLock = { acquired: true; token: string } | { acquired: false }

export interface AutoApproveClient {
  getPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequestMeta>
  listPullRequestReviews(owner: string, repo: string, prNumber: number): Promise<PullRequestReview[]>
  listPullRequestReviewComments(owner: string, repo: string, prNumber: number): Promise<ReviewComment[]>
  listPullRequestReviewThreads(owner: string, repo: string, prNumber: number): Promise<ReviewThread[]>
  submitReview(
    owner: string,
    repo: string,
    prNumber: number,
    review: SubmitReviewBody,
  ): Promise<{ id: number; state: string }>
}

export type AutoApproveResult =
  | { kind: "approved"; reviewId: number; approvalReviewId: number; resolvedCount: number; totalCount: number }
  | { kind: "already-approved" }
  | { kind: "duplicate" }
  | { kind: "head-moved"; priorHeadSha: string; currentHeadSha: string }
  | { kind: "partial"; resolvedCount: number; totalCount: number }
  | {
      kind: "no-op"
      reason: "no-sigilix-review" | "not-blocking" | "missing-review-head" | "no-findings" | "stale-review"
    }
  | { kind: "failed"; phase: FailurePhase; error: string }

export interface MaybeAutoApproveArgs {
  env: { OPENCLAW_STATE: KVNamespace }
  client: AutoApproveClient
  owner: string
  repo: string
  prNumber: number
  trigger: AutoApproveTrigger
}

export async function markTrustedAutoApproveThreadResolved(args: {
  env: { OPENCLAW_STATE: KVNamespace }
  owner: string
  repo: string
  prNumber: number
  threadId: string
  senderLogin: string
}): Promise<void> {
  await args.env.OPENCLAW_STATE.put(
    trustedThreadResolvedKey(args.owner, args.repo, args.prNumber, args.threadId),
    JSON.stringify({
      kind: TRUSTED_THREAD_RESOLVED_KIND,
      threadId: args.threadId,
      senderLogin: args.senderLogin,
      resolvedAt: Date.now(),
    }),
    { expirationTtl: AUTO_APPROVE_RESULT_TTL_SECONDS },
  )
}

export function bodyHasSigilixResolutionCommand(body: string | null | undefined): boolean {
  if (typeof body !== "string") return false
  const cleaned = stripQuotesAndCode(body)
  return cleaned
    .split(/\r?\n/)
    .some((line) => /(?:^|\s)@sigilix\s+(?:dismiss|resolved|resolve)(?:\b|$)/i.test(line.trim()))
}

export async function maybeAutoApproveResolvedSigilixReview(args: MaybeAutoApproveArgs): Promise<AutoApproveResult> {
  const tag = { owner: args.owner, repo: args.repo, prNumber: args.prNumber }
  let reviews: PullRequestReview[]
  try {
    reviews = await args.client.listPullRequestReviews(args.owner, args.repo, args.prNumber)
  } catch (err) {
    return failed("list-reviews", err, tag)
  }

  const latest = latestSigilixReview(reviews)
  if (!latest) return { kind: "no-op", reason: "no-sigilix-review" }
  if (latest.state === "APPROVED") return { kind: "already-approved" }
  if (!isAutoApprovableReview(latest)) return { kind: "no-op", reason: "not-blocking" }
  if (!latest.commitId) return { kind: "no-op", reason: "missing-review-head" }

  let pr: PullRequestMeta
  try {
    pr = await args.client.getPullRequest(args.owner, args.repo, args.prNumber)
  } catch (err) {
    return failed("get-pr", err, tag)
  }
  const currentHeadSha = pr.head.sha
  if (currentHeadSha !== latest.commitId) {
    console.log(
      JSON.stringify({
        event: "pr-review-auto-approve-skipped-head-moved",
        ...tag,
        prior_head_sha: latest.commitId,
        current_head_sha: currentHeadSha,
      }),
    )
    return { kind: "head-moved", priorHeadSha: latest.commitId, currentHeadSha }
  }

  const key = autoApproveKey(args.owner, args.repo, args.prNumber, latest.id, currentHeadSha)
  let lock: AutoApproveLock
  try {
    lock = await acquireAutoApproveInProgressLock(args.env.OPENCLAW_STATE, key)
  } catch (err) {
    return failed("lock", err, tag)
  }
  if (!lock.acquired) return { kind: "duplicate" }

  let comments: ReviewComment[]
  let threads: ReviewThread[]
  try {
    ;[comments, threads] = await Promise.all([
      args.client.listPullRequestReviewComments(args.owner, args.repo, args.prNumber),
      args.client.listPullRequestReviewThreads(args.owner, args.repo, args.prNumber),
    ])
  } catch (err) {
    await releaseAutoApproveInProgressLock(args.env.OPENCLAW_STATE, key, lock.token)
    return failed("list-resolution-state", err, tag)
  }

  const roots = latestFindingRoots(comments, latest.id)
  if (roots.length === 0) {
    await releaseAutoApproveInProgressLock(args.env.OPENCLAW_STATE, key, lock.token)
    return { kind: "no-op", reason: "no-findings" }
  }

  const resolved = resolveFindingRoots({
    roots,
    comments,
    threads,
    prAuthor: pr.user?.login ?? null,
    trustedThreadIds: await trustedResolvedThreadIds(
      args.env.OPENCLAW_STATE,
      args.owner,
      args.repo,
      args.prNumber,
      threads,
    ),
  })
  if (resolved.resolvedCount < roots.length) {
    console.log(
      JSON.stringify({
        event: "pr-review-auto-approve-skipped-partial",
        ...tag,
        headSha: currentHeadSha,
        review_id: latest.id,
        resolved_count: resolved.resolvedCount,
        total_count: roots.length,
        resolution_modes: resolved.modeCounts,
      }),
    )
    await releaseAutoApproveInProgressLock(args.env.OPENCLAW_STATE, key, lock.token)
    return { kind: "partial", resolvedCount: resolved.resolvedCount, totalCount: roots.length }
  }

  try {
    const freshReviews = await args.client.listPullRequestReviews(args.owner, args.repo, args.prNumber)
    const latestFresh = latestSigilixReview(freshReviews)
    if (!latestFresh) {
      await releaseAutoApproveInProgressLock(args.env.OPENCLAW_STATE, key, lock.token)
      return { kind: "no-op", reason: "no-sigilix-review" }
    }
    if (latestFresh.state === "APPROVED" && latestFresh.commitId === currentHeadSha) {
      await args.env.OPENCLAW_STATE.put(
        key,
        JSON.stringify({
          kind: AUTO_APPROVE_APPROVED_KIND,
          reviewId: latest.id,
          approvalReviewId: 0,
          headSha: currentHeadSha,
          approvedAt: Date.now(),
        }),
        { expirationTtl: AUTO_APPROVE_RESULT_TTL_SECONDS },
      ).catch(() => undefined)
      return { kind: "duplicate" }
    }
    if (latestFresh.id !== latest.id || latestFresh.commitId !== latest.commitId) {
      console.log(
        JSON.stringify({
          event: "pr-review-auto-approve-skipped-stale-review",
          ...tag,
          headSha: currentHeadSha,
          review_id: latest.id,
          latest_review_id: latestFresh.id,
          latest_review_head_sha: latestFresh.commitId,
        }),
      )
      await releaseAutoApproveInProgressLock(args.env.OPENCLAW_STATE, key, lock.token)
      return { kind: "no-op", reason: "stale-review" }
    }
    if (!isAutoApprovableReview(latestFresh)) {
      await releaseAutoApproveInProgressLock(args.env.OPENCLAW_STATE, key, lock.token)
      return { kind: "no-op", reason: "not-blocking" }
    }
  } catch (err) {
    await releaseAutoApproveInProgressLock(args.env.OPENCLAW_STATE, key, lock.token)
    return failed("list-reviews", err, tag)
  }

  try {
    const approval = await args.client.submitReview(args.owner, args.repo, args.prNumber, {
      event: "APPROVE",
      commit_id: currentHeadSha,
      body: `${SIGILIX_REVIEW_BODY_MARKER}\nAll prior findings addressed.`,
    })
    await args.env.OPENCLAW_STATE.put(
      key,
      JSON.stringify({
        kind: AUTO_APPROVE_APPROVED_KIND,
        reviewId: latest.id,
        approvalReviewId: approval.id,
        headSha: currentHeadSha,
        approvedAt: Date.now(),
      }),
      { expirationTtl: AUTO_APPROVE_RESULT_TTL_SECONDS },
    ).catch(() => undefined)
    console.log(
      JSON.stringify({
        event: "pr-review-auto-approved-on-resolution",
        ...tag,
        headSha: currentHeadSha,
        review_id: latest.id,
        approval_review_id: approval.id,
        resolved_count: resolved.resolvedCount,
        resolution_modes: resolved.modeCounts,
        trigger: args.trigger,
      }),
    )
    return {
      kind: "approved",
      reviewId: latest.id,
      approvalReviewId: approval.id,
      resolvedCount: resolved.resolvedCount,
      totalCount: roots.length,
    }
  } catch (err) {
    await releaseAutoApproveInProgressLock(args.env.OPENCLAW_STATE, key, lock.token)
    return failed("submit", err, tag)
  }
}

function latestSigilixReview(reviews: PullRequestReview[]): PullRequestReview | null {
  return (
    reviews
      .filter(
        (review) =>
          review.user?.login === SIGILIX_BOT_LOGIN &&
          (review.body.includes(SIGILIX_REVIEW_BODY_MARKER) || review.body.includes(LEGACY_REVIEW_BODY_MARKER)),
      )
      .sort((a, b) => b.id - a.id)[0] ?? null
  )
}

function isAutoApprovableReview(review: PullRequestReview): boolean {
  if (review.state === "CHANGES_REQUESTED") return true
  return review.state === "COMMENTED" && /\bneeds response\b/i.test(review.body)
}

function latestFindingRoots(comments: ReviewComment[], reviewId: number): ReviewComment[] {
  return comments.filter(
    (comment) =>
      comment.pull_request_review_id === reviewId &&
      comment.user?.login === SIGILIX_BOT_LOGIN &&
      typeof comment.in_reply_to_id !== "number" &&
      comment.body.includes(FINDING_COMMENT_MARKER),
  )
}

function resolveFindingRoots(args: {
  roots: ReviewComment[]
  comments: ReviewComment[]
  threads: ReviewThread[]
  prAuthor: string | null
  trustedThreadIds: Set<string>
}): { resolvedCount: number; modeCounts: Record<ResolutionMode, number> } {
  const byId = new Map(args.comments.map((comment) => [comment.id, comment]))
  const threadByRootId = new Map<number, ReviewThread>()
  for (const thread of args.threads) {
    if (typeof thread.firstCommentId === "number") threadByRootId.set(thread.firstCommentId, thread)
  }
  const modeCounts: Record<ResolutionMode, number> = { "thread-resolved": 0, "dismiss-cmd": 0 }
  let resolvedCount = 0

  for (const root of args.roots) {
    const mode = resolutionModeForRoot({
      root,
      comments: args.comments,
      byId,
      threadByRootId,
      prAuthor: args.prAuthor,
      trustedThreadIds: args.trustedThreadIds,
    })
    if (!mode) continue
    resolvedCount += 1
    modeCounts[mode] += 1
  }
  return { resolvedCount, modeCounts }
}

function resolutionModeForRoot(args: {
  root: ReviewComment
  comments: ReviewComment[]
  byId: Map<number, ReviewComment>
  threadByRootId: Map<number, ReviewThread>
  prAuthor: string | null
  trustedThreadIds: Set<string>
}): ResolutionMode | null {
  const thread = args.threadByRootId.get(args.root.id)
  if (thread?.isResolved && args.trustedThreadIds.has(thread.id)) return "thread-resolved"

  const replies = args.comments.filter(
    (comment) => comment.id !== args.root.id && descendsTo(args.byId, comment, args.root.id),
  )
  const explicit = replies.find(
    (reply) =>
      bodyHasSigilixResolutionCommand(reply.body) &&
      reply.user?.login !== SIGILIX_BOT_LOGIN &&
      reply.user?.login !== args.prAuthor &&
      isAuthorAllowedForSlashCommand(reply.author_association),
  )
  if (explicit) return "dismiss-cmd"
  return null
}

function descendsTo(byId: Map<number, ReviewComment>, comment: ReviewComment, rootId: number): boolean {
  let curId = comment.in_reply_to_id
  for (let i = 0; i < 32; i++) {
    if (typeof curId !== "number") return false
    if (curId === rootId) return true
    const next = byId.get(curId)
    if (!next) return false
    curId = next.in_reply_to_id
  }
  return false
}

function autoApproveKey(owner: string, repo: string, prNumber: number, reviewId: number, headSha: string): string {
  return `pr-review-auto-approve:${owner}/${repo}#${prNumber}:${reviewId}:${headSha}`
}

function trustedThreadResolvedKey(owner: string, repo: string, prNumber: number, threadId: string): string {
  return `pr-review-auto-approve-thread-resolved:${owner}/${repo}#${prNumber}:${threadId}`
}

async function trustedResolvedThreadIds(
  kv: KVNamespace,
  owner: string,
  repo: string,
  prNumber: number,
  threads: ReviewThread[],
): Promise<Set<string>> {
  const trusted = new Set<string>()
  await Promise.all(
    threads.map(async (thread) => {
      try {
        if (await kv.get(trustedThreadResolvedKey(owner, repo, prNumber, thread.id))) trusted.add(thread.id)
      } catch (err) {
        console.warn(
          JSON.stringify({
            event: "pr-review-auto-approve-trusted-thread-read-failed",
            owner,
            repo,
            prNumber,
            threadId: thread.id,
            err: err instanceof Error ? err.message : String(err),
          }),
        )
      }
    }),
  )
  return trusted
}

async function acquireAutoApproveInProgressLock(kv: KVNamespace, key: string): Promise<AutoApproveLock> {
  const before = await kv.get(key)
  if (before) return { acquired: false }

  const token = crypto.randomUUID()
  await kv.put(key, JSON.stringify({ kind: AUTO_APPROVE_IN_PROGRESS_KIND, token, createdAt: Date.now() }), {
    expirationTtl: AUTO_APPROVE_IN_PROGRESS_TTL_SECONDS,
  })

  const after = parseAutoApproveDedupeRecord(await kv.get(key))
  if (after?.kind === AUTO_APPROVE_IN_PROGRESS_KIND && after.token === token) {
    return { acquired: true, token }
  }
  await releaseAutoApproveInProgressLock(kv, key, token)
  return { acquired: false }
}

async function releaseAutoApproveInProgressLock(kv: KVNamespace, key: string, token: string): Promise<void> {
  try {
    const current = parseAutoApproveDedupeRecord(await kv.get(key))
    if (current?.kind === AUTO_APPROVE_IN_PROGRESS_KIND && current.token === token) {
      await kv.delete(key)
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "pr-review-auto-approve-lock-release-failed",
        key,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}

function parseAutoApproveDedupeRecord(value: string | null): AutoApproveDedupeRecord | null {
  if (!value) return null
  let raw: unknown
  try {
    raw = JSON.parse(value)
  } catch {
    return null
  }
  if (typeof raw !== "object" || raw === null) return null
  const record = raw as {
    kind?: unknown
    token?: unknown
    createdAt?: unknown
    reviewId?: unknown
    approvalReviewId?: unknown
    headSha?: unknown
    approvedAt?: unknown
  }
  if (
    record.kind === AUTO_APPROVE_IN_PROGRESS_KIND &&
    typeof record.token === "string" &&
    typeof record.createdAt === "number"
  ) {
    return { kind: AUTO_APPROVE_IN_PROGRESS_KIND, token: record.token, createdAt: record.createdAt }
  }
  if (
    record.kind === AUTO_APPROVE_APPROVED_KIND &&
    typeof record.reviewId === "number" &&
    typeof record.approvalReviewId === "number" &&
    typeof record.headSha === "string" &&
    typeof record.approvedAt === "number"
  ) {
    return {
      kind: AUTO_APPROVE_APPROVED_KIND,
      reviewId: record.reviewId,
      approvalReviewId: record.approvalReviewId,
      headSha: record.headSha,
      approvedAt: record.approvedAt,
    }
  }
  return null
}

function failed(
  phase: FailurePhase,
  err: unknown,
  tag: { owner: string; repo: string; prNumber: number },
): AutoApproveResult {
  const error = err instanceof Error ? err.message : String(err)
  console.warn(JSON.stringify({ event: "pr-review-auto-approve-failed", phase, ...tag, err: error }))
  return { kind: "failed", phase, error }
}
