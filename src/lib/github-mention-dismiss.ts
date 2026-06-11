// SIG-376 (SIG-318 Tier-1 4/8): the `@sigilix dismiss [<reason>]` review-
// dismissal subsystem lifted out of `github-mention.ts` so that god-file
// stays under the 1,000-line budget. The command parser, the KV
// single-flight lock, the dedupe-record serialization, the GitHub
// dismissal call, and the reply renderer are pure relocations — bodies are
// byte-identical to their prior in-file definitions; only the surrounding
// `export` keywords (so the core can import them) + the import paths differ.
//
// The dismiss-record union types + the dismiss-only constants live here too
// (the helpers and the core both reference them); the core re-exports the
// public types so every existing importer of `./github-mention` is
// unchanged.
//
// Leaf module: depends only on dismiss-reasons / slash-commands /
// dismiss-prior-reviews + the GitHubClient type — it does NOT import the
// core `github-mention.ts`, so there is no cycle.

import type { GitHubClient } from "@/src/shared/adapters/github"
import { isAuthorAllowedForSlashCommand } from "./slash-commands"
import { LEGACY_REVIEW_BODY_MARKER, SIGILIX_BOT_LOGIN, SIGILIX_REVIEW_BODY_MARKER } from "./dismiss-prior-reviews"
import { type DismissReason, isDismissReason, parseDismissReason } from "./dismiss-reasons"

const REPLY_MARKER = "<!-- sigilix:gh-mention-reply -->"
const DISMISS_IN_PROGRESS_TTL = 60 * 15
export const DISMISS_IN_PROGRESS_KIND = "review-dismiss-in-progress"
export const DISMISS_DEDUPE_KIND = "review-dismiss-result"

type ReviewDismissClient = Pick<GitHubClient, "listPullRequestReviews" | "dismissReview">

export type ReviewDismissResult =
  | { kind: "dismissed"; reviewId: number }
  | { kind: "not-found" }
  | { kind: "list-failed"; error: string }
  | { kind: "dismiss-failed"; reviewId: number; error: string }

export type ReviewDismissDedupeRecord =
  | { kind: typeof DISMISS_IN_PROGRESS_KIND; token?: string; createdAt?: number }
  | {
      kind: typeof DISMISS_DEDUPE_KIND
      result: ReviewDismissResult
      replyCommentId?: number
      /**
       * SIG-173: the canonical reason label parsed off the dismiss command
       * at write time. Persisted so a replayed reply renders identical copy
       * (the reason is in the bot's acknowledgement line). Older records
       * written before this field shipped omit it; the parser defaults
       * those to `"unlabeled"` on read.
       */
      dismissReason?: DismissReason
    }

export function serializeReviewDismissInProgressRecord(token?: string): string {
  const record: ReviewDismissDedupeRecord = token
    ? { kind: DISMISS_IN_PROGRESS_KIND, token, createdAt: Date.now() }
    : { kind: DISMISS_IN_PROGRESS_KIND }
  return JSON.stringify(record)
}

export function serializeReviewDismissDedupeRecord(
  result: ReviewDismissResult,
  replyCommentId?: number,
  dismissReason?: DismissReason,
): string {
  const record: ReviewDismissDedupeRecord = {
    kind: DISMISS_DEDUPE_KIND,
    result,
    ...(typeof replyCommentId === "number" ? { replyCommentId } : {}),
    ...(dismissReason ? { dismissReason } : {}),
  }
  return JSON.stringify(record)
}

export function parseReviewDismissDedupeRecord(value: string | null): ReviewDismissDedupeRecord | null {
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
    result?: unknown
    replyCommentId?: unknown
  }
  if (record.kind === DISMISS_IN_PROGRESS_KIND) {
    return {
      kind: DISMISS_IN_PROGRESS_KIND,
      ...(typeof record.token === "string" && record.token.length > 0 ? { token: record.token } : {}),
      ...(typeof record.createdAt === "number" ? { createdAt: record.createdAt } : {}),
    }
  }
  if (record.kind !== DISMISS_DEDUPE_KIND || !isReviewDismissResult(record.result)) {
    return null
  }
  // SIG-173: optional reason — present on records written after this PR
  // ships; absent on legacy records (caller falls back to "unlabeled").
  const dismissReason = isDismissReason((record as { dismissReason?: unknown }).dismissReason)
    ? (record as { dismissReason: DismissReason }).dismissReason
    : undefined
  return {
    kind: DISMISS_DEDUPE_KIND,
    result: record.result,
    ...(typeof record.replyCommentId === "number" ? { replyCommentId: record.replyCommentId } : {}),
    ...(dismissReason ? { dismissReason } : {}),
  }
}

type ReviewDismissLock =
  | { acquired: true; token: string }
  | { acquired: false; record: ReviewDismissDedupeRecord | null }

export async function acquireReviewDismissInProgressLock(kv: KVNamespace, key: string): Promise<ReviewDismissLock> {
  const before = parseReviewDismissDedupeRecord(await kv.get(key))
  if (before) return { acquired: false, record: before }

  const token = createReviewDismissLockToken()
  await kv.put(key, serializeReviewDismissInProgressRecord(token), {
    expirationTtl: DISMISS_IN_PROGRESS_TTL,
  })

  // Workers KV has no CAS primitive. The token readback gives us a
  // create-if-missing single-flight guard: only the request that can see
  // its own sentinel is allowed to perform the GitHub dismissal.
  const after = parseReviewDismissDedupeRecord(await kv.get(key))
  if (after?.kind === DISMISS_IN_PROGRESS_KIND && after.token === token) {
    return { acquired: true, token }
  }
  if (after?.kind !== DISMISS_DEDUPE_KIND) {
    await releaseReviewDismissInProgressLock(kv, key, token)
  }
  return { acquired: false, record: after }
}

export async function releaseReviewDismissInProgressLock(kv: KVNamespace, key: string, token: string): Promise<void> {
  try {
    const current = parseReviewDismissDedupeRecord(await kv.get(key))
    if (current?.kind === DISMISS_IN_PROGRESS_KIND && current.token === token) {
      await kv.delete(key)
    }
  } catch (err) {
    console.warn("[gh-mention] dismiss lock cleanup failed", {
      key,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

function createReviewDismissLockToken(): string {
  return crypto.randomUUID()
}

function isReviewDismissResult(value: unknown): value is ReviewDismissResult {
  if (typeof value !== "object" || value === null) return false
  const result = value as {
    kind?: unknown
    reviewId?: unknown
    error?: unknown
  }
  switch (result.kind) {
    case "dismissed":
      return typeof result.reviewId === "number"
    case "not-found":
      return true
    case "list-failed":
      return typeof result.error === "string"
    case "dismiss-failed":
      return typeof result.reviewId === "number" && typeof result.error === "string"
    default:
      return false
  }
}

/**
 * Pre-stripped command prefixes the parser accepts before the optional
 * reason label. Order matters — the longest prefix wins on match attempt
 * so a body like "dismiss this review too-minor" parses as "too-minor"
 * not "this review too-minor".
 */
const DISMISS_COMMAND_PREFIXES = ["dismiss this review", "dismiss review", "dismiss"] as const

/**
 * SIG-173 follow-up: shape the residual after stripping a dismiss prefix
 * must match before we treat the body as a real dismiss command. Without
 * this, `dismiss the irrelevant context you raised here is concerning`
 * would trip a real dismissal. The shape is deliberately label-like:
 * starts with an alphanumeric, then alphanumerics + hyphen/underscore/space
 * only, no longer than 32 chars total. Combined with the MAX_REST_WORDS
 * gate this admits all canonical labels (and the hyphen/space variants
 * the alias table recognizes) but rejects free prose.
 */
const REASON_REST_SHAPE = /^[a-z0-9][a-z0-9 _-]{0,31}$/
const MAX_REST_WORDS = 3

/**
 * Strip wrappers people commonly type around a single-word label
 * (`*not-a-bug*`, `` `too-minor` ``, `_wrong-context_`, `not-a-bug 🎉`)
 * BEFORE the shape gate so the label still parses. Conservative — runs
 * once, doesn't touch interior characters.
 */
function stripReasonWrappers(rest: string): string {
  let out = rest
  // Trailing emoji (most common case: celebration / shrug at end of comment).
  // Strip any trailing run of: \p{Extended_Pictographic} (the emoji bases
  // we care about — celebration, gestures, etc), skin-tone modifiers
  // (U+1F3FB..U+1F3FF), the ZWJ that joins emoji sequences (U+200D), and
  // the variation selector that picks the emoji-presentation form
  // (U+FE0F). One sweep peels off `🎉`, `🤷‍♀️`, `👍🏽`, etc. without
  // touching label chars like `*` or `#` (which Emoji_Component would
  // also match — keycap bases).
  out = out.replace(/[\s‍️\u{1F3FB}-\u{1F3FF}\p{Extended_Pictographic}]+$/gu, "")
  // Surrounding markdown emphasis: *, _, `. Strip ONE matching pair at the
  // ends so `*not-a-bug*` → `not-a-bug` without touching internal underscores
  // in `not_a_bug`.
  const wrapperPair = /^([*_`])(.+)\1$/
  const m = wrapperPair.exec(out)
  if (m && m[2] !== undefined) out = m[2]
  return out.trim()
}

/**
 * SIG-173: parse `@sigilix dismiss [<reason>]`. Returns `{kind: "dismiss",
 * reason}` when the body is a dismiss command (reason defaults to
 * `"unlabeled"` for bare `dismiss` AND for invalid-but-label-shaped values
 * — typos shouldn't silently fail the dismiss). Returns null when the body
 * isn't a dismiss command at all, including the case where the residual
 * after stripping the prefix is free prose, not a label.
 *
 * Pure — exported for tests.
 */
export function parseDismissCommand(question: string): { kind: "dismiss"; reason: DismissReason } | null {
  const normalized = question
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
  for (const prefix of DISMISS_COMMAND_PREFIXES) {
    if (normalized === prefix) {
      return { kind: "dismiss", reason: "unlabeled" }
    }
    if (normalized.startsWith(`${prefix} `)) {
      const raw = normalized.slice(prefix.length + 1).trim()
      const rest = stripReasonWrappers(raw)
      if (rest.length === 0) {
        return { kind: "dismiss", reason: "unlabeled" }
      }
      // Gate the residual to label-shape only — anything else (prose,
      // sentences, special chars) means this body was about something
      // else that happened to start with "dismiss".
      if (!REASON_REST_SHAPE.test(rest) || rest.split(/\s+/).length > MAX_REST_WORDS) {
        return null
      }
      const parsed = parseDismissReason(rest)
      // Label-shaped but not in the alias table → still a dismiss command,
      // just unlabeled. A typo on a label shouldn't swallow the dismiss.
      return { kind: "dismiss", reason: parsed ?? "unlabeled" }
    }
  }
  return null
}

/**
 * Boolean wrapper kept for back-compat with existing callers + tests that
 * only need the yes/no question. New code should call `parseDismissCommand`
 * to also recover the reason label.
 */
export function isReviewDismissRequest(question: string): boolean {
  return parseDismissCommand(question) !== null
}

/**
 * SIG-173 follow-up: single decision point for "which reason wins on a
 * replay". The dedupe-record's persisted reason is canonical the moment
 * it exists — a fresh @sigilix dismiss command coming in with a different
 * label must NOT silently overwrite history on the next dedupe-record
 * write. A legacy record (pre-SIG-173, no `dismissReason` field) signals
 * "original dismiss was unlabeled" and is preserved as `"unlabeled"` for
 * the same reason: don't let the new label rewrite the original intent.
 * Only when no `DISMISS_DEDUPE_KIND` record exists at all do we fall back
 * to the fresh parse.
 *
 * Pure — exported for tests.
 */
export function preferPersistedReason(record: ReviewDismissDedupeRecord | null, fresh: DismissReason): DismissReason {
  if (record?.kind === DISMISS_DEDUPE_KIND) {
    return record.dismissReason ?? "unlabeled"
  }
  return fresh
}

/**
 * The dismiss command mutates PR review state, so it uses the same trust
 * boundary as slash commands: only users GitHub marks as repo owner,
 * organization member, or explicit collaborator can run it.
 */
export function isAuthorAllowedForReviewDismiss(association: string | null | undefined): boolean {
  return isAuthorAllowedForSlashCommand(association)
}

export async function dismissLatestBlockingSigilixReview(args: {
  client: ReviewDismissClient
  owner: string
  repo: string
  prNumber: number
}): Promise<ReviewDismissResult> {
  let reviews: Awaited<ReturnType<ReviewDismissClient["listPullRequestReviews"]>>
  try {
    reviews = await args.client.listPullRequestReviews(args.owner, args.repo, args.prNumber)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.warn(
      JSON.stringify({
        event: "gh-mention-dismiss-list-failed",
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
        err: error,
      }),
    )
    return { kind: "list-failed", error }
  }

  const target = reviews
    .filter(
      (r) =>
        r.state === "CHANGES_REQUESTED" &&
        r.user?.login === SIGILIX_BOT_LOGIN &&
        (r.body.includes(SIGILIX_REVIEW_BODY_MARKER) || r.body.includes(LEGACY_REVIEW_BODY_MARKER)),
    )
    // Review IDs are monotonic; sort defensively instead of relying on
    // REST list ordering when choosing the latest blocking Sigilix review.
    .sort((a, b) => b.id - a.id)[0]

  if (!target) {
    console.log(
      JSON.stringify({
        event: "gh-mention-dismiss-no-blocking-review",
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
      }),
    )
    return { kind: "not-found" }
  }

  try {
    await args.client.dismissReview(
      args.owner,
      args.repo,
      args.prNumber,
      target.id,
      "Dismissed by explicit @sigilix dismiss request.",
    )
    console.log(
      JSON.stringify({
        event: "gh-mention-dismissed-blocking-review",
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
        review_id: target.id,
      }),
    )
    return { kind: "dismissed", reviewId: target.id }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.warn(
      JSON.stringify({
        event: "gh-mention-dismiss-failed",
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
        review_id: target.id,
        err: error,
      }),
    )
    return { kind: "dismiss-failed", reviewId: target.id, error }
  }
}

/**
 * SIG-173: render the bot's reply to `@sigilix dismiss [<reason>]`. The
 * `reason` argument is the canonical reason label that landed in the
 * persisted `WithdrawalRecord` + the `/metrics/dismissals` counter; surfacing
 * it in the reply gives the reviewer immediate confirmation that we
 * registered the label. Bare dismiss + invalid input both reach here as
 * `"unlabeled"` — we skip the reason line in that case so the reply stays
 * clean for the common path.
 */
export function formatReviewDismissReply(result: ReviewDismissResult, reason: DismissReason = "unlabeled"): string {
  const reasonSuffix = reason !== "unlabeled" ? ` (reason: ${reason})` : ""
  switch (result.kind) {
    case "dismissed":
      return `${REPLY_MARKER}\nDismissed the latest blocking Sigilix review${reasonSuffix}. GitHub should recalculate the PR review decision shortly.`
    case "not-found":
      return `${REPLY_MARKER}\nI couldn't find an active blocking Sigilix review to dismiss on this PR.`
    case "list-failed":
      return `${REPLY_MARKER}\nI saw the dismiss request, but couldn't list this PR's reviews from GitHub. Please retry in a moment.`
    case "dismiss-failed":
      return `${REPLY_MARKER}\nI found the blocking Sigilix review, but GitHub rejected the dismissal request. Please verify the GitHub App has permission to dismiss pull request reviews and retry.`
  }
}
