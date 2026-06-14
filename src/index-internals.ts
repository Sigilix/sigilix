// SIG-318 / SIG-376 (Tier-1 8/8): shared internal layer for the Cloudflare
// Workers entry module. Holds the GitHub-webhook payload shape + the
// pure pull-request job decision + the webhook-mention / review-memory
// capture helpers that BOTH the entry module (src/index.ts) and the
// GitHub-webhook leaf (src/index-github-webhook.ts) call. Living here (not
// in core) keeps the leaf->leaf edges acyclic and prevents any leaf from
// importing the entry module. Declarations are relocated VERBATIM from the
// pre-split src/index.ts (modulo the added `export` keyword + imports).

import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"
import { GitHubClient } from "@/src/shared/adapters/github"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import { type GhMentionSurface } from "@/src/lib/github-mention"
import { bodyMentionsBot, getMentionTriggers, isArcGithubLogin, stripQuotesAndCode } from "@/src/lib/mention"
import { parseSlashCommand, renderSlashCommandAck, isAuthorAllowedForSlashCommand } from "@/src/lib/slash-commands"
import { shouldQueueReviewThreadReply } from "@/src/lib/review-thread-reply"
import { postSlashCommandEyesAck } from "@/src/lib/slash-command-eyes-ack"
import { loadSigilixConfig, resolveReviewMemoryConfig } from "@/src/lib/sigilix-config"
import { collectPushChangedPaths, isIndexerEnabled, maybeEnqueuePushIndexJob } from "@/src/lib/index-producer"
import {
  captureDismissedReviewFeedback,
  captureReviewFeedback,
  captureTopLevelReviewFeedback,
} from "@/src/lib/review-memory/capture"

/**
 * Pure decision: given a `pull_request` webhook action + draft flag,
 * which jobs should we enqueue? Extracted so the gating intent is
 * directly testable without simulating the full webhook handler.
 *
 * Rules (matches the routing in handleGitHubWebhook):
 *   - Drafts and unsupported actions get nothing.
 *   - SIG-216: the `overview` boolean NO LONGER controls when the
 *     pr-overview comment renders. The overview comment is now posted
 *     inline by `handlePrReviewEnsemble` immediately before the review
 *     submit (CodeRabbit-style Walkthrough-then-Review). The boolean
 *     gates only the legacy `loadSigilixConfig` warmup + the
 *     `pr-labels` enqueue path that consumes it. Treat it as "fire the
 *     opt-in / labelling side effects" rather than "render the
 *     overview" — true for opened/synchronize/reopened/ready_for_review.
 *   - pr-review fires for the same actions EXCEPT `reopened` (closing
 *     + reopening a PR doesn't change the diff, so re-reviewing would
 *     be noise). The inline overview rides along with each review, so
 *     `reopened` PRs intentionally get neither.
 *   - When OPENCLAW_PR_REVIEW_SKIP_RELEASE_BRANCHES=on, PRs from a
 *     dev/develop/staging branch into main/master/release skip the
 *     pr-review job entirely (dev→main is a release-promotion of
 *     already-reviewed code; re-reviewing doubles spend + adds noise).
 *     The `overview: true` flag still fires so the release PR still
 *     gets its side-effect pass (labels + warmup).
 *   - A standalone `@sigilix ignore` directive in the PR body opts
 *     out of all automatic PR review routing for that webhook.
 */
const PR_BODY_SIGILIX_IGNORE_DIRECTIVE = /^@sigilix[ \t]+ignore$/i
const PR_BODY_SIGILIX_IGNORE_COMMENT = /(?:^|[ \t])<!--[ \t]*@sigilix[ \t]+ignore[ \t]*-->(?=[ \t]|$)/i

export function prBodyHasSigilixIgnoreDirective(prBody: string | null | undefined): boolean {
  if (typeof prBody !== "string") return false
  const cleaned = stripQuotesAndCode(prBody)
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (PR_BODY_SIGILIX_IGNORE_COMMENT.test(line)) return true
  }
  const withoutHtmlComments = cleaned.replace(/<!--[\s\S]*?(?:-->|$)/g, "")
  for (const rawLine of withoutHtmlComments.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (PR_BODY_SIGILIX_IGNORE_DIRECTIVE.test(line)) return true
  }
  return false
}

export function decidePullRequestJobs(args: {
  action: string
  draft: boolean
  prBody?: string | null | undefined
  baseRef?: string
  headRef?: string
  skipReleasePromotions?: boolean
}): { overview: boolean; review: boolean } {
  if (args.draft) return { overview: false, review: false }
  const supported = ["opened", "synchronize", "reopened", "ready_for_review"]
  if (!supported.includes(args.action)) return { overview: false, review: false }
  if (prBodyHasSigilixIgnoreDirective(args.prBody)) return { overview: false, review: false }
  let review = args.action !== "reopened"
  if (review && args.skipReleasePromotions && isReleasePromotion(args.baseRef, args.headRef)) {
    review = false
  }
  return { overview: true, review }
}

export const RELEASE_BASE_BRANCHES = new Set(["main", "master", "release", "production", "prod"])
export const PROMOTION_HEAD_BRANCHES = new Set(["dev", "develop", "development", "staging", "stage"])

export function isReleasePromotion(baseRef: string | undefined, headRef: string | undefined): boolean {
  if (!baseRef || !headRef) return false
  const base = baseRef.toLowerCase()
  const head = headRef.toLowerCase()
  return RELEASE_BASE_BRANCHES.has(base) && PROMOTION_HEAD_BRANCHES.has(head)
}

export interface GitHubWebhookPayload {
  action?: string
  installation?: {
    id?: number
    /** ARC-238: account.login is the owner identifier for the
     *  `installation.deleted` repo-discovery scan. */
    account?: { login?: string; type?: string }
  }
  repository?: {
    /** SIG-243: GitHub's immutable integer ID for the repository. Stable
     *  across rename, transfer, and ownership changes — unlike `name` +
     *  `owner.login` above, both of which mutate. Captured in every
     *  webhook handler so Phase 2+ can key by this instead of the
     *  mutable string pair. */
    id?: number
    name?: string
    owner?: {
      login?: string
      /** SIG-243: owner ID is also immutable across rename. Less load-
       *  bearing than `repository.id` (one repo can't move between
       *  orgs without the App being re-installed) but captured for
       *  observability + future tenant-scoping. */
      id?: number
    }
  }
  pull_request?: {
    number?: number
    head?: { sha?: string; ref?: string; repo?: { full_name?: string | null } | null }
    base?: { sha?: string; ref?: string }
    draft?: boolean
    merged?: boolean
    // SIG-44: title/body feed the merged-PR multi-corpus refresh.
    title?: string
    body?: string | null
    user?: { login?: string }
  }
  workflow_run?: {
    id?: number
    conclusion?: string | null
    head_sha?: string
    pull_requests?: Array<{ number?: number; head?: { sha?: string } }>
    event?: string
  }
  review?: {
    id?: number
    body?: string | null
    commit_id?: string | null
    state?: string
    user?: { login?: string }
  }
  comment?: {
    id?: number
    path?: string
    line?: number | null
    original_line?: number | null
    in_reply_to_id?: number
    body?: string
    user?: { login?: string }
    commit_id?: string
    original_commit_id?: string
    pull_request_review_id?: number | null
    // GitHub's relationship between the comment author and the
    // repository: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, FIRST_TIMER,
    // FIRST_TIME_CONTRIBUTOR, MANNEQUIN, NONE. Used by ARC-178 to gate
    // slash commands that trigger expensive review re-runs.
    author_association?: string
  }
  sender?: { login?: string }
  thread?: {
    node_id?: string
    comments?: Array<{ id?: number }>
  }
  // `issue_comment` events deliver an `issue` block. When the issue
  // is a PR, `issue.pull_request` is present (otherwise it's a plain
  // issue and we ignore the event).
  issue?: {
    number?: number
    pull_request?: { url?: string } | null
  }
  // ARC-234: installation-scoped events carry no repository field;
  // instead they ship one or both of these arrays. `repositories[]`
  // is the initial set on `installation.created`. `repositories_added[]`
  // is the delta on `installation_repositories.added`. Both share the
  // same entry shape (we only consume `full_name`, formatted "owner/repo").
  // SIG-243 Phase 1: GitHub's installation / installation_repositories
  // webhook payloads include an `id` (immutable integer) per repo
  // alongside `name` + `full_name`. Captured so the bootstrap queue
  // message carries the canonical ID from its first write.
  repositories?: Array<{ id?: number; name?: string; full_name?: string }>
  repositories_added?: Array<{ id?: number; name?: string; full_name?: string }>
  // ARC-238: `installation_repositories.removed` carries the delta;
  // `installation.deleted` does NOT carry a repo list (repos are
  // already gone) — the delete handler discovers affected repos by
  // walking `repo-index-manifest:` records and filtering by owner.
  repositories_removed?: Array<{ id?: number; name?: string; full_name?: string }>
  // ARC-237 / SIG-35: `push` event fields. Default-branch pushes refresh
  // the compatibility index. Tracked long-lived branches and active PR
  // head branches refresh isolated branch-scoped indexes. Branch deletes
  // enqueue branch-index cleanup.
  ref?: string
  after?: string
  before?: string
  size?: number
  commits?: Array<{
    added?: string[]
    modified?: string[]
    removed?: string[]
  }>
}

/**
 * ARC-189: ctx.waitUntil-side capture-feedback dispatch. Builds an
 * authenticated GitHubClient + loads sigilix.json + invokes
 * captureReviewFeedback. Best-effort end-to-end: errors logged-and-
 * swallowed so the webhook response never depends on KV/GH I/O here.
 *
 * Called from the `pull_request_review_comment.created` webhook
 * branch alongside (NOT in place of) the existing mention pipeline.
 */
export async function dispatchReviewMemoryCapture(args: {
  env: Env
  owner: string
  repo: string
  prNumber: number
  installationId: number
  comment: { id: number; body: string; path: string; in_reply_to_id?: number }
  /**
   * SIG-247 Phase 1: GitHub's immutable repo.id from the webhook
   * payload. When present and positive-integer, threads through to
   * `appendSignal` for the dual-write keyspace. Absent on legacy /
   * spoofed / malformed payloads; the capture path then falls back to
   * a `getRepository` lookup before going legacy-only.
   */
  repoId?: number
}): Promise<void> {
  const { env, owner, repo, prNumber, installationId, comment, repoId } = args
  try {
    if (env.OPENCLAW_REVIEW_MEMORY_CAPTURE !== "on") {
      // Cheap pre-flight: env-gate fails fast without paying the
      // installation-token + sigilix.json fetch costs.
      return
    }
    if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) return
    const token = await getInstallationToken({
      kv: env.OPENCLAW_STATE,
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      installationId,
    })
    const client = new GitHubClient({ token })
    // sigilix.json is fetched at the PR head sha. The webhook
    // payload doesn't carry headSha for the review-comment event;
    // fall back to the default branch via getFileContent's null
    // semantics — loadSigilixConfig accepts any ref string.
    const sigilixConfig = await loadSigilixConfig(client, owner, repo, "HEAD")
    const config = resolveReviewMemoryConfig(sigilixConfig)
    await captureReviewFeedback({
      env,
      client,
      owner,
      repo,
      prNumber,
      replyComment: comment,
      config,
      ...(repoId !== undefined ? { repoId } : {}),
    })
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "review-memory-capture-dispatch-failed",
        owner,
        repo,
        prNumber,
        commentId: comment.id,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}

export async function resolvePullRequestHeadRefForConfig(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string> {
  try {
    const pr = await client.getPullRequest(owner, repo, prNumber)
    const headSha = pr.head?.sha
    return typeof headSha === "string" && headSha.length > 0 ? headSha : "HEAD"
  } catch {
    return "HEAD"
  }
}

export async function dispatchTopLevelReviewMemoryCapture(args: {
  env: Env
  owner: string
  repo: string
  prNumber: number
  installationId: number
  comment: { id: number; body: string }
  repoId?: number
}): Promise<void> {
  const { env, owner, repo, prNumber, installationId, comment, repoId } = args
  try {
    if (env.OPENCLAW_REVIEW_MEMORY_CAPTURE !== "on") return
    if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) return
    const token = await getInstallationToken({
      kv: env.OPENCLAW_STATE,
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      installationId,
    })
    const client = new GitHubClient({ token })
    const configRef = await resolvePullRequestHeadRefForConfig(client, owner, repo, prNumber)
    const sigilixConfig = await loadSigilixConfig(client, owner, repo, configRef)
    const config = resolveReviewMemoryConfig(sigilixConfig)
    await captureTopLevelReviewFeedback({
      env,
      client,
      owner,
      repo,
      prNumber,
      comment,
      config,
      ...(repoId !== undefined ? { repoId } : {}),
    })
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "review-memory-capture-dispatch-failed",
        owner,
        repo,
        prNumber,
        commentId: comment.id,
        signal_source: "top-level-explicit",
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}

export async function dispatchDismissedReviewMemoryCapture(args: {
  env: Env
  owner: string
  repo: string
  prNumber: number
  installationId: number
  review: { id: number; body: string; commit_id?: string; user?: { login?: string } }
  headSha: string
}): Promise<void> {
  const { env, owner, repo, prNumber, installationId, review, headSha } = args
  try {
    if (env.OPENCLAW_REVIEW_MEMORY_CAPTURE !== "on") return
    if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) return
    const token = await getInstallationToken({
      kv: env.OPENCLAW_STATE,
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      installationId,
    })
    const client = new GitHubClient({ token })
    const sigilixConfig = await loadSigilixConfig(client, owner, repo, headSha)
    const config = resolveReviewMemoryConfig(sigilixConfig)
    await captureDismissedReviewFeedback({
      env,
      owner,
      repo,
      prNumber,
      review,
      headSha,
      config,
    })
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "review-memory-capture-dispatch-failed",
        owner,
        repo,
        prNumber,
        commentId: review.id,
        signal_source: "review-dismissed-stale",
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}

export interface QueueGithubMentionArgs {
  env: Env
  /**
   * ARC-190 Task 10: passed through so the slash-command 👀 ack can
   * run via `ctx.waitUntil(...)` — the reaction POST happens in the
   * background without blocking the webhook's 202 response.
   */
  ctx: ExecutionContext
  payload: GitHubWebhookPayload
  owner: string
  repo: string
  installationId: number
  surface: GhMentionSurface
  prNumber: number | undefined
}

/**
 * Common gating for both `issue_comment.created` and
 * `pull_request_review_comment.created`:
 *
 *   1. PR number + comment id are present
 *   2. comment author is NOT Sigilix itself (prevents reply loops)
 *   3. EITHER body @-mentions Sigilix, OR (review-comment surface AND has
 *      `in_reply_to_id`) — the second branch is the cheap webhook
 *      signal for "this might be a reply in Sigilix's thread"; the
 *      handler does the actual chain walk to confirm Sigilix was above.
 *      Wasted-queue cost is tiny (Cloudflare Queues are ~$0.40/M
 *      messages); the upside is users don't have to retype @arc on
 *      every reply.
 *
 * On pass, enqueues a `github-mention` JobMessage. The body itself is
 * re-fetched from GitHub at handler time so an edit between webhook
 * delivery and processing doesn't reply to stale text.
 */
export async function queueGithubMention(args: QueueGithubMentionArgs): Promise<Response> {
  const { env, ctx, payload, owner, repo, installationId, surface, prNumber } = args
  const comment = payload.comment
  if (!comment || typeof comment.id !== "number") {
    return new Response("missing comment\n", { status: 400 })
  }
  if (typeof prNumber !== "number") {
    return new Response("missing pr number\n", { status: 400 })
  }
  // Self-author guard runs BEFORE the mention check so Sigilix's own
  // replies (which obviously have `in_reply_to_id` on review-comment)
  // can't open a feedback loop via the implicit-thread path.
  if (isArcGithubLogin(comment.user?.login ?? null)) {
    return new Response("skip self\n", { status: 200 })
  }

  const body = comment.body ?? ""

  // Slash-command dispatch. Recognize `/sigilix <cmd>` at a line
  // start and route to a dedicated job type instead of the generic
  // mention-reply pipeline. Handles `review`, `improve`, `help`, and
  // `describe`. Other commands (e.g. future `ask`) fall silently
  // through to the @-mention pipeline (which means they're ignored
  // unless the same comment also @-mentions Sigilix); README
  // documents this.
  const cleaned = stripQuotesAndCode(body)
  const slashCmd = parseSlashCommand(cleaned)
  if (slashCmd) {
    // ACL gate: slash commands either trigger an LLM call (review,
    // improve) or post a comment (help) — on public repos any
    // commenter could otherwise spam them. Restrict to authors
    // GitHub considers trusted. CONTRIBUTOR is intentionally
    // excluded — anyone whose PR has merged becomes CONTRIBUTOR
    // forever, which is too broad a circle for a privileged channel.
    if (!isAuthorAllowedForSlashCommand(comment.author_association)) {
      const association = (comment.author_association ?? "").toUpperCase()
      console.log(
        JSON.stringify({
          event: "slash-command-rejected",
          reason: "untrusted_author_association",
          cmd: slashCmd.cmd,
          author_association: association || null,
          login: comment.user?.login ?? null,
          owner,
          repo,
          prNumber,
        }),
      )
      return new Response("forbidden\n", { status: 403 })
    }

    // ARC-191 unknown-arg fast path: post the usage comment and
    // return, BEFORE coalesce / dedupe / enqueue. The user's typo
    // shouldn't enter the queue and consume budget; the response is
    // synchronous and tells them how to re-invoke.
    if (slashCmd.cmd === "describe" && slashCmd.mode === "unknown") {
      try {
        const token = await getInstallationToken({
          kv: env.OPENCLAW_STATE,
          appId: env.GITHUB_APP_ID!,
          privateKey: env.GITHUB_PRIVATE_KEY!,
          installationId,
        })
        const client = new GitHubClient({ token })
        await client.createIssueComment(owner, repo, prNumber, renderSlashCommandAck(slashCmd))
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "slash-command-usage-post-failed",
            err: err instanceof Error ? err.message : String(err),
            cmd: "describe",
            rawArg: slashCmd.rawArg,
            owner,
            repo,
            prNumber,
          }),
        )
      }
      return new Response("usage posted\n", { status: 200 })
    }

    // Per-command coalesce lock: if the same (PR, command) is in
    // flight, drop subsequent invocations within 60s. Collapses N
    // concurrent posts into 1 ack + 1 LLM run. Keying includes the
    // command name so different commands on the same PR don't
    // accidentally suppress each other.
    // Coalesce key: mode-keyed for describe so `internal` and
    // `external` on the same PR don't suppress each other within
    // the 60s window. ARC-264: also apply-keyed so a `describe pr`
    // and `describe apply pr` on the same PR can both run — one
    // posts a comment, the other writes the body. Other commands
    // keep the existing key shape. (The `unknown` describe variant
    // returned via the fast path above, so here describe.mode is
    // always a canonical DescribeMode.)
    const coalesceKey =
      slashCmd.cmd === "describe"
        ? `slash-cmd:describe:${slashCmd.mode}${slashCmd.apply ? ":apply" : ""}:${owner}/${repo}#${prNumber}`
        : `slash-cmd:${slashCmd.cmd}:${owner}/${repo}#${prNumber}`
    const existing = await env.OPENCLAW_STATE.get(coalesceKey)
    if (existing) {
      console.log(
        JSON.stringify({
          event: "slash-command-coalesced",
          coalesceKey,
          owner,
          repo,
          prNumber,
          cmd: slashCmd.cmd,
        }),
      )
      return new Response("coalesced\n", { status: 202 })
    }
    await env.OPENCLAW_STATE.put(coalesceKey, String(Date.now()), {
      expirationTtl: 60, // 60s — long enough to swallow comment bursts
    })

    // ARC-190 Task 10: 👀 ack on the source comment so the user sees
    // visible feedback within ~1s. Mirrors the @-mention path
    // (github-mention.ts:131-147). Best-effort; runs via
    // ctx.waitUntil so the webhook can return 202 immediately. Fires
    // ONLY when the slash command parsed AND ACL passed AND coalesce
    // didn't hit — earlier branches return without touching this.
    ctx.waitUntil(
      postSlashCommandEyesAck({
        env,
        owner,
        repo,
        commentId: comment.id,
        surface,
        installationId,
      }),
    )

    let message: JobMessage
    switch (slashCmd.cmd) {
      case "review":
        message = {
          type: "pr-review-rerun",
          owner,
          repo,
          prNumber,
          installationId,
        }
        break
      case "full-review":
        // SIG-98: same handler as `review`, with a `forceFresh` flag
        // attached so future dedup layers on the rerun path have an
        // explicit bypass + telemetry can distinguish the two CTAs.
        message = {
          type: "pr-review-rerun",
          owner,
          repo,
          prNumber,
          installationId,
          forceFresh: true,
        }
        break
      case "improve":
        message = {
          type: "pr-improve",
          owner,
          repo,
          prNumber,
          installationId,
        }
        break
      case "help":
        message = {
          type: "pr-help",
          owner,
          repo,
          prNumber,
          installationId,
        }
        break
      case "describe":
        // mode === "unknown" was handled above by the fast path;
        // TypeScript narrows slashCmd here to the canonical-mode
        // variant of the describe union.
        message = {
          type: "pr-describe",
          owner,
          repo,
          prNumber,
          installationId,
          mode: slashCmd.mode,
          // ARC-264: thread the apply flag through to the queue
          // consumer. False (post a comment) is the describe v1
          // behavior; true (write the PR body) is the new path.
          apply: slashCmd.apply,
        }
        break
      case "pause":
        message = { type: "pr-pause", owner, repo, prNumber, installationId }
        break
      case "resume":
        message = { type: "pr-resume", owner, repo, prNumber, installationId }
        break
      case "ignore":
        message = { type: "pr-ignore", owner, repo, prNumber, installationId }
        break
      case "resolve":
        message = { type: "pr-resolve-threads", owner, repo, prNumber, installationId }
        break
      case "cancel":
        message = { type: "pr-cancel", owner, repo, prNumber, installationId }
        break
      default: {
        const _exhaustive: never = slashCmd
        return _exhaustive
      }
    }
    // CR PR #61 catch: roll back the coalesce key if enqueue fails.
    // Otherwise GitHub redelivers the webhook, sees the key, and
    // returns "coalesced" without ever queueing the command — the
    // original invocation gets silently dropped.
    try {
      await env.OPENCLAW_JOBS.send(message)
    } catch (err) {
      await env.OPENCLAW_STATE.delete(coalesceKey).catch(() => {})
      throw err
    }
    return new Response("queued slash-command\n", { status: 202 })
  }

  const triggers = getMentionTriggers(env.OPENCLAW_MENTION_TRIGGERS)
  const hasMention = bodyMentionsBot(body, triggers)

  // ARC-269: gate the implicit-thread-reply path. An explicit
  // @-mention always queues (the user typed our handle, intent is
  // clear). An inline review-comment reply WITHOUT a mention only
  // queues when the body looks like a real ask — empty / single-
  // ack / no-signal bodies were burning queue + LLM budget on
  // "fixed" / "thanks" / 👍 replies. The shape gate lives in
  // `shouldQueueReviewThreadReply`; the thread-root-owner gate
  // (was the root authored by Sigilix?) is the consumer's job.
  //
  // Note: this branch fires on ALL review-comment-without-mention
  // payloads, including top-level review comments. The gate's
  // `not-a-reply` reason filters those out. Prior to ARC-269 those
  // returned 200 "no mention"; they now return 200 "skip review-
  // reply: not-a-reply" with a structured telemetry event. Net
  // queue count is unchanged.
  const isReviewCommentWithoutMention = surface === "review-comment" && !hasMention
  // Pre-compute these so both the skip event and the dispatch
  // event carry the same payload-shape facts for post-rollout
  // tuning (code-review M4 catch).
  const bodyLength = body.length
  const bodyEndsWithQ = body.trim().endsWith("?")
  const hadInReplyToId = typeof comment.in_reply_to_id === "number"
  if (isReviewCommentWithoutMention) {
    const gate = shouldQueueReviewThreadReply({
      body,
      authorLogin: comment.user?.login ?? null,
      inReplyToId: comment.in_reply_to_id ?? null,
    })
    if (!gate.ok) {
      console.log(
        JSON.stringify({
          event: "review-reply-skipped",
          reason: gate.reason,
          owner,
          repo,
          prNumber,
          comment_id: comment.id,
          body_length: bodyLength,
          body_ends_with_q: bodyEndsWithQ,
          had_in_reply_to_id: hadInReplyToId,
        }),
      )
      // 200 not 202: we explicitly chose not to queue. The webhook
      // is acknowledged but no work is created.
      return new Response(`skip review-reply: ${gate.reason}\n`, { status: 200 })
    }
  } else if (!hasMention) {
    // Non-review-comment surface (issue comment) with no mention:
    // existing behavior, just drop. The implicit-thread path
    // doesn't apply here.
    return new Response("no mention\n", { status: 200 })
  }

  const message: JobMessage = {
    type: "github-mention",
    owner,
    repo,
    prNumber,
    installationId,
    surface,
    commentId: comment.id,
    ...(typeof comment.in_reply_to_id === "number" ? { threadRootId: comment.in_reply_to_id } : {}),
  }
  await env.OPENCLAW_JOBS.send(message)
  console.log(
    JSON.stringify({
      event: isReviewCommentWithoutMention ? "review-reply-dispatched" : "github-mention-dispatched",
      surface,
      owner,
      repo,
      prNumber,
      comment_id: comment.id,
      has_mention: hasMention,
      is_review_thread_reply: isReviewCommentWithoutMention,
      body_length: bodyLength,
      body_ends_with_q: bodyEndsWithQ,
      had_in_reply_to_id: hadInReplyToId,
    }),
  )
  return new Response("queued\n", { status: 202 })
}

/**
 * SIG-318 / SIG-366: ARC-237 / SIG-35 push-driven re-index sub-handler — the
 * `event === "push"` branch of the webhook router, lifted out of
 * `handleGitHubWebhook` (verbatim — only the closed-over `env` / `owner` / `repo` /
 * `installationId` / `payload` become params) so the entry-adjacent
 * `index-github-webhook.ts` stays under the 1k cap. Mirrors `queueGithubMention`
 * (an IO sub-handler returning a Response). The producer refreshes the default
 * branch, configured long-lived branches, and active same-repo PR branches on
 * already-indexed repos; push-storm coalescing falls out of ARC-235's freshness check.
 */
export async function handlePushEvent(args: {
  env: Env
  owner: string
  repo: string
  installationId: number
  payload: GitHubWebhookPayload
}): Promise<Response> {
  const { env, owner, repo, installationId, payload } = args
  if (!isIndexerEnabled(env)) {
    return new Response("push event ignored (indexer off)\n", { status: 200 })
  }
  const outcome = await maybeEnqueuePushIndexJob({
    env,
    owner,
    repo,
    // SIG-243 Phase 1: capture the immutable repo ID from the push
    // payload and thread it to the producer. The producer attaches
    // it to the queue message; the consumer persists it on the
    // manifest. Falls back to `undefined` (treated as legacy) if a
    // webhook arrives without the field. GitHub repo IDs are strictly
    // positive integers; the guard rejects 0 / negative / non-integer
    // / NaN / Infinity at the entry point so a spoofed or malformed
    // payload can't land an invalid `repo-tenant:0` key downstream.
    repoId:
      typeof payload.repository?.id === "number" && Number.isInteger(payload.repository.id) && payload.repository.id > 0
        ? payload.repository.id
        : undefined,
    installationId,
    ref: typeof payload.ref === "string" ? payload.ref : undefined,
    after: typeof payload.after === "string" ? payload.after : undefined,
    before: typeof payload.before === "string" ? payload.before : undefined,
    changedPaths: collectPushChangedPaths(
      payload.commits,
      typeof payload.size === "number" && Number.isInteger(payload.size) && payload.size >= 0
        ? payload.size
        : undefined,
    ),
  })
  if ("enqueued" in outcome && outcome.enqueued) {
    return new Response("push indexed\n", { status: 202 })
  }
  if ("failed" in outcome) {
    // Producer threw on OPENCLAW_JOBS.send (binding broken /
    // backpressure). Surface 503 so GitHub redelivers — the
    // enqueue is the only side-effect, idempotent on the consumer
    // side because chunk ids are content-addressed.
    return new Response("push enqueue failed\n", { status: 503 })
  }
  // Any other `{skipped: ...}` outcome is a deliberate no-op (the
  // producer logged the specific reason).
  return new Response("push skipped\n", { status: 200 })
}
