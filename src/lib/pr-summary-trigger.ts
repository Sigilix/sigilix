// SIG-437: the `@sigilix summary` webhook trigger decision. Kept out of the
// webhook handler proper so (a) the handler stays within its file-size budget
// and (b) the gate is unit-testable in isolation.
//
// Pure decision: given the flag value, the action, the PR body, and the head
// SHA, return the `pr-summary` JobMessage to enqueue, or null. The webhook does
// the actual best-effort `ctx.waitUntil(env.OPENCLAW_JOBS.send(...))`.
//
// Gate (ALL must hold):
//   - OPENCLAW_PR_SUMMARY_MODE === "on" (default-off → null → pure no-op)
//   - the action carries an editable body (opened / edited / reopened /
//     ready_for_review) — NOT synchronize/closed/etc.
//   - a head SHA is present (pinned for the stale-head guard + dedupe key)
//   - the body has a fresh `@sigilix summary` trigger OUTSIDE any existing
//     managed block (parseSummaryCommand strips the block first, so our own
//     body-PATCH `edited` event can't re-trigger)

import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"
import { parsePrSummaryMode } from "./pr-summary-mode"
import { parseSummaryCommand } from "./pr-summary-command"

/** Actions whose webhook payload carries an editable PR body. */
const BODY_BEARING_ACTIONS = new Set(["opened", "edited", "reopened", "ready_for_review"])

export interface PrSummaryTriggerInput {
  /** Raw `OPENCLAW_PR_SUMMARY_MODE`. */
  mode: string | undefined
  /** Raw `OPENCLAW_MENTION_TRIGGERS`. */
  mentionTriggers: string | undefined
  /** The `pull_request` webhook action. */
  action: string | undefined
  owner: string
  repo: string
  prNumber: number
  /** PR head SHA from the webhook payload. */
  headSha: string | undefined
  body: string | null | undefined
  installationId: number
}

/**
 * Returns the `pr-summary` job to enqueue, or null when the gate doesn't pass.
 * Pure — exported for tests + the webhook.
 */
export function decidePrSummaryJob(input: PrSummaryTriggerInput): Extract<JobMessage, { type: "pr-summary" }> | null {
  if (parsePrSummaryMode(input.mode) !== "on") return null
  if (!BODY_BEARING_ACTIONS.has(input.action ?? "")) return null
  const headSha = input.headSha ?? ""
  if (headSha.length === 0) return null
  if (!parseSummaryCommand(input.body, input.mentionTriggers)) return null
  return {
    type: "pr-summary",
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    headSha,
    installationId: input.installationId,
  }
}

/**
 * Webhook-side wrapper: decide via `decidePrSummaryJob`, then best-effort
 * enqueue on `ctx.waitUntil` with a `.catch` so a queue-send failure never
 * blocks or fails the webhook ack (Codex MUST-FIX #1). No-op when the gate
 * doesn't pass. Keeps the `pull_request` webhook handler within its size budget.
 */
export function maybeEnqueuePrSummary(args: {
  env: Env
  ctx: ExecutionContext
  action: string | undefined
  owner: string
  repo: string
  installationId: number
  /** The webhook `pull_request` object — only the fields the gate reads. The
   *  webhook narrows `number` to a real number before we get here, but the
   *  payload type leaves it optional, so we accept `number | undefined` and the
   *  gate no-ops when it's absent. */
  pr: { number?: number | undefined; body?: string | null; head?: { sha?: string } }
}): void {
  if (typeof args.pr.number !== "number") return
  const job = decidePrSummaryJob({
    mode: args.env.OPENCLAW_PR_SUMMARY_MODE,
    mentionTriggers: args.env.OPENCLAW_MENTION_TRIGGERS,
    action: args.action,
    owner: args.owner,
    repo: args.repo,
    prNumber: args.pr.number,
    headSha: args.pr.head?.sha,
    body: args.pr.body,
    installationId: args.installationId,
  })
  if (!job) return
  args.ctx.waitUntil(
    args.env.OPENCLAW_JOBS.send(job).catch((err: unknown) => {
      console.warn(
        JSON.stringify({
          event: "pr-summary-enqueue-failed",
          owner: args.owner,
          repo: args.repo,
          prNumber: args.pr.number,
          action: args.action,
          err: err instanceof Error ? err.message : String(err),
        }),
      )
    }),
  )
}
