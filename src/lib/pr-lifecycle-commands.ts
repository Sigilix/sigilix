// SIG-98 — `/sigilix pause / resume / ignore / resolve` lifecycle
// commands.
//
// Each command is its own queue-job handler. They share the GitHub
// installation-token bootstrap + ack-comment pattern with the other
// slash-command handlers (pr-improve, pr-help, pr-describe) but do
// NOT call the ensemble or any LLM — they flip a per-PR KV flag, post
// an ack comment, and emit a telemetry event.
//
// Pause/ignore flags live under:
//   - `pr-paused:<owner>/<repo>#<prNumber>`  (24h TTL)
//   - `pr-ignored:<owner>/<repo>#<prNumber>` (no TTL)
//
// They're read at `enqueuePrReviewJob` time (see
// `src/do/webhook-enqueue.ts`) — when set, the webhook handler skips
// the pr-review enqueue entirely. The gate runs BEFORE the DO call so
// a paused/ignored PR never warms the DO state machine.
//
// `resolve` walks every Sigilix-authored review thread on the PR via
// GraphQL and calls `resolveReviewThread`. Threads from other
// reviewers are untouched.
//
// All four handlers are best-effort: a failed comment-post or
// GraphQL error logs structured telemetry and returns. The customer
// can always retry the slash command.

import type { Env } from "@/src/shared/types/env"
import { GitHubClient } from "@/src/shared/adapters/github"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import { renderSlashCommandAck, type SlashCommand } from "./slash-commands"
import { SIGILIX_BOT_LOGIN } from "./dismiss-prior-reviews"

/**
 * SIG-98 — per-PR KV key shapes. Exported so the webhook-side gate in
 * `enqueuePrReviewJob` reads from the same source of truth.
 *
 * Pure string helpers — no KV calls.
 */
export function buildPausedKey(owner: string, repo: string, prNumber: number): string {
  return `pr-paused:${owner}/${repo}#${prNumber}`
}

export function buildIgnoredKey(owner: string, repo: string, prNumber: number): string {
  return `pr-ignored:${owner}/${repo}#${prNumber}`
}

/** 24h pause window, matching the ticket spec. */
export const PR_PAUSE_TTL_SECONDS = 24 * 60 * 60

interface LifecycleHandlerArgs {
  env: Env
  owner: string
  repo: string
  prNumber: number
  installationId: number
}

/**
 * Post the same ack comment the user would have seen from a synchronous
 * dispatcher. The queue path keeps the coalesce window + ACL gate
 * uniform across commands; we just post here instead of in the webhook.
 */
async function postAck(args: LifecycleHandlerArgs, cmd: SlashCommand): Promise<void> {
  if (!args.env.GITHUB_APP_ID || !args.env.GITHUB_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY required")
  }
  const token = await getInstallationToken({
    kv: args.env.OPENCLAW_STATE,
    appId: args.env.GITHUB_APP_ID,
    privateKey: args.env.GITHUB_PRIVATE_KEY,
    installationId: args.installationId,
  })
  const client = new GitHubClient({ token })
  await client.createIssueComment(args.owner, args.repo, args.prNumber, renderSlashCommandAck(cmd))
}

/**
 * `/sigilix pause` — write `pr-paused:<...>` with a 24h TTL, post ack,
 * emit telemetry. Subsequent `pull_request.synchronize` webhooks skip
 * the pr-review enqueue while the key is live; the entry expires on
 * its own or gets cleared by `/sigilix resume`.
 */
export async function handlePrPause(args: LifecycleHandlerArgs): Promise<void> {
  const key = buildPausedKey(args.owner, args.repo, args.prNumber)
  await args.env.OPENCLAW_STATE.put(key, String(Date.now()), {
    expirationTtl: PR_PAUSE_TTL_SECONDS,
  })
  console.log(
    JSON.stringify({
      event: "pr-review-paused",
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      ttlSeconds: PR_PAUSE_TTL_SECONDS,
    }),
  )
  try {
    await postAck(args, { cmd: "pause" })
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "slash-command-ack-failed",
        cmd: "pause",
        err: err instanceof Error ? err.message : String(err),
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
      }),
    )
  }
}

/**
 * `/sigilix resume` — clear BOTH the paused and ignored keys (resume is
 * a single reversal CTA per the ticket spec) and post ack. KV
 * `delete` is idempotent, so the no-flag case is a no-op for both.
 *
 * CodeRabbit catch on PR #110: do NOT swallow KV delete errors. Pre-
 * fix the handler had `.catch(() => {})` per delete, so a KV outage
 * could leave pause/ignore set while the user got a green "resumed"
 * ack and assumed auto-review was re-enabled. The fix lets the
 * delete error bubble out of the handler so the queue retries the
 * message; the deletes + ack post are all idempotent under retry
 * (KV.delete on an absent key is a no-op; duplicate ack comments are
 * cheap and visible to the user).
 */
export async function handlePrResume(args: LifecycleHandlerArgs): Promise<void> {
  const pausedKey = buildPausedKey(args.owner, args.repo, args.prNumber)
  const ignoredKey = buildIgnoredKey(args.owner, args.repo, args.prNumber)
  await Promise.all([args.env.OPENCLAW_STATE.delete(pausedKey), args.env.OPENCLAW_STATE.delete(ignoredKey)])
  console.log(
    JSON.stringify({
      event: "pr-review-resumed",
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
    }),
  )
  try {
    await postAck(args, { cmd: "resume" })
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "slash-command-ack-failed",
        cmd: "resume",
        err: err instanceof Error ? err.message : String(err),
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
      }),
    )
  }
}

/**
 * `/sigilix ignore` — write `pr-ignored:<...>` with NO TTL. Same gate
 * as pause, but permanent until `/sigilix resume` clears it.
 */
export async function handlePrIgnore(args: LifecycleHandlerArgs): Promise<void> {
  const key = buildIgnoredKey(args.owner, args.repo, args.prNumber)
  // No expirationTtl → permanent until explicitly deleted.
  await args.env.OPENCLAW_STATE.put(key, String(Date.now()))
  console.log(
    JSON.stringify({
      event: "pr-review-ignored",
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
    }),
  )
  try {
    await postAck(args, { cmd: "ignore" })
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "slash-command-ack-failed",
        cmd: "ignore",
        err: err instanceof Error ? err.message : String(err),
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
      }),
    )
  }
}

/**
 * `/sigilix resolve` — list all unresolved review threads on the PR
 * via GraphQL and call `resolveReviewThread` for those whose root
 * comment was posted by `sigilix[bot]`. Threads from human reviewers
 * or other bots are NOT touched — the ticket spec is "mark the
 * conversation thread as resolved via GitHub API" for *Sigilix's own*
 * threads. Bulk-resolving humans' threads would be customer-hostile.
 *
 * Best-effort: per-thread mutation failures log and continue so a
 * single permission glitch doesn't abort the whole pass.
 */
export async function handlePrResolveThreads(args: LifecycleHandlerArgs): Promise<void> {
  const tag = {
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
  }
  if (!args.env.GITHUB_APP_ID || !args.env.GITHUB_PRIVATE_KEY) {
    console.error(
      JSON.stringify({
        event: "pr-resolve-threads-misconfigured",
        reason: "missing_github_app_credentials",
        ...tag,
      }),
    )
    return
  }
  const token = await getInstallationToken({
    kv: args.env.OPENCLAW_STATE,
    appId: args.env.GITHUB_APP_ID,
    privateKey: args.env.GITHUB_PRIVATE_KEY,
    installationId: args.installationId,
  })
  const client = new GitHubClient({ token })

  let resolved = 0
  let skippedNotSigilix = 0
  let alreadyResolved = 0
  let mutationFailures = 0
  try {
    const threads = await client.listPullRequestReviewThreads(args.owner, args.repo, args.prNumber)
    for (const t of threads) {
      if (t.isResolved) {
        alreadyResolved += 1
        continue
      }
      // Identify Sigilix-rooted threads by the FIRST comment's author.
      // GitHub doesn't expose a thread-level "originator" field, so the
      // first comment's login is the canonical source. Empty threads
      // (`comments` array missing or empty) skip — defensive, should
      // not happen in practice.
      const rootLogin = t.firstCommentLogin
      if (rootLogin !== SIGILIX_BOT_LOGIN) {
        skippedNotSigilix += 1
        continue
      }
      try {
        await client.resolveReviewThread(t.id)
        resolved += 1
      } catch (err) {
        mutationFailures += 1
        console.error(
          JSON.stringify({
            event: "pr-resolve-thread-mutation-failed",
            threadId: t.id,
            err: err instanceof Error ? err.message : String(err),
            ...tag,
          }),
        )
      }
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "pr-resolve-threads-list-failed",
        err: err instanceof Error ? err.message : String(err),
        ...tag,
      }),
    )
    // Fall through to the ack so the user knows we tried, even if
    // listing the threads itself failed. The ack copy is generic
    // enough not to over-promise here.
  }
  console.log(
    JSON.stringify({
      event: "pr-review-resolved",
      resolved,
      alreadyResolved,
      skippedNotSigilix,
      mutationFailures,
      ...tag,
    }),
  )
  try {
    await client.createIssueComment(args.owner, args.repo, args.prNumber, renderSlashCommandAck({ cmd: "resolve" }))
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "slash-command-ack-failed",
        cmd: "resolve",
        err: err instanceof Error ? err.message : String(err),
        ...tag,
      }),
    )
  }
}

/**
 * SIG-329 — `/sigilix cancel` — abort the in-flight review for this PR.
 * Unlike pause/ignore (which gate FUTURE pushes via KV flags), cancel
 * targets the CURRENT run: it POSTs the PR's `PrReviewRunDO` `/cancel`
 * route, which finalizes the run and closes its check immediately
 * instead of waiting on the watchdog. Then it posts the ack comment.
 *
 * `/cancel` is idempotent (a second cancel on a terminal run is a 200
 * no-op), so a transport / 5xx failure throws to let the queue
 * redeliver. The ack-post failure is logged but not re-thrown, matching
 * the other lifecycle handlers.
 */
export async function handlePrCancel(args: LifecycleHandlerArgs): Promise<void> {
  const tag = { owner: args.owner, repo: args.repo, prNumber: args.prNumber }
  const id = args.env.PR_REVIEW_RUN.idFromName(`${args.owner}/${args.repo}#${args.prNumber}`)
  const stub = args.env.PR_REVIEW_RUN.get(id)
  const res = await stub.fetch("https://do.internal/cancel", { method: "POST" })
  if (res.status >= 500) {
    throw new Error(`pr-review-do-cancel-failed status=${res.status}`)
  }
  const body = (await res.json().catch(() => ({}))) as {
    cancelled?: boolean
    reason?: string
  }
  console.log(
    JSON.stringify({
      event: "pr-review-cancelled-command",
      cancelled: body.cancelled ?? false,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      ...tag,
    }),
  )
  try {
    await postAck(args, { cmd: "cancel" })
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "slash-command-ack-failed",
        cmd: "cancel",
        err: err instanceof Error ? err.message : String(err),
        ...tag,
      }),
    )
  }
}
