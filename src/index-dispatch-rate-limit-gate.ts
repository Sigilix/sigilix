// SIG-38 Task 5: rate-limit gate extracted from `index-dispatch.ts` to keep that
// file within the 1000-line budget (COMPLIANCE §4/§6 — zero-behavior move).
//
// `runRateLimitGate` encapsulates the per-developer rolling-window cap check:
//   • Calls checkRateLimit (fail-open, never throws).
//   • When denied: posts a visible PR comment (best-effort), closes the check run
//     as "skipped", and returns { skipped: true }.
//   • When denied but comment fails: falls through → returns { skipped: false }
//     so the caller runs the review (FAIL-OPEN contract).
//   • When allowed: returns { skipped: false } immediately.
//
// The caller threads `rateLimit` into Task 7's `finalStatusUpdate` footer.

import type { Env } from "@/src/shared/types/env"
import { checkRateLimit } from "@/src/features/tenancy"
import type { RateLimitDecision } from "@/src/features/tenancy"
import { GitHubClient } from "@/src/shared/adapters/github"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import { attachExistingCheckRun, completeCheckRun } from "@/src/lib/pr-review-check-run"

export interface RateLimitGateResult {
  /** true = caller must return immediately (rate-limited + comment posted). */
  skipped: boolean
  /** Always present; the caller can use `.footer` for the status update. */
  rateLimit: RateLimitDecision
}

/**
 * Per-developer rate-limit gate for the `pr-review` dispatch callback.
 *
 * PLACEMENT: AFTER the sensitive-repo skip, BEFORE `const checkRun`.
 * PLACEMENT RATIONALE: /pickup already happened when the callback runs; the
 * wrapper posts /run-result(success) after any `return`, matching the
 * sensitive-repo skip contract.
 *
 * Never throws — all I/O is wrapped in try/catch with fail-open fallback.
 */
export async function runRateLimitGate(
  env: Env,
  args: {
    installationId: number
    authorLogin: string | undefined
    bypassClosedSkip: boolean | undefined
    owner: string
    repo: string
    prNumber: number
    checkRunId: number | undefined
  },
): Promise<RateLimitGateResult> {
  const rateLimit = await checkRateLimit(env, {
    installationId: args.installationId,
    authorLogin: args.authorLogin,
    nowMs: Date.now(),
    ...(args.bypassClosedSkip === true ? { bypassReason: "slash-command-rerun" } : {}),
  })

  if (!rateLimit.allowed) {
    // enforce + over-cap. Post visible comment FIRST; only skip if it posts.
    let posted = false
    try {
      if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) throw new Error("missing_github_app_credentials")
      const token = await getInstallationToken({
        kv: env.OPENCLAW_STATE,
        appId: env.GITHUB_APP_ID,
        privateKey: env.GITHUB_PRIVATE_KEY,
        installationId: args.installationId,
      })
      const client = new GitHubClient({ token })
      const mins = Math.max(1, Math.ceil(rateLimit.resetMs / 60000))
      await client.createIssueComment(
        args.owner,
        args.repo,
        args.prNumber,
        `**Sigilix · Rate limit reached** — ${rateLimit.used} of ${rateLimit.cap} reviews used in the past 5h. Next review slot in ~${mins}m.`,
      )
      posted = true
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "rate-limit-comment-failed",
          owner: args.owner,
          repo: args.repo,
          prNumber: args.prNumber,
          err: err instanceof Error ? err.message : String(err),
        }),
      )
    }
    if (posted) {
      console.log(
        JSON.stringify({
          event: "rate-limit-skip-applied",
          owner: args.owner,
          repo: args.repo,
          prNumber: args.prNumber,
          used: rateLimit.used,
          cap: rateLimit.cap,
          resetMs: rateLimit.resetMs,
        }),
      )
      // Best-effort check-run close. The comment is already posted and the review
      // is decided-skipped, so a failure here must NOT throw (that would let the DO
      // retry the job and post a DUPLICATE rate-limit comment) — log and skip anyway.
      if (args.checkRunId !== undefined) {
        try {
          const handle = await attachExistingCheckRun({
            env,
            owner: args.owner,
            repo: args.repo,
            installationId: args.installationId,
            checkRunId: args.checkRunId,
          })
          await completeCheckRun({ handle, conclusion: "skipped" })
        } catch (err) {
          console.warn(
            JSON.stringify({
              event: "rate-limit-check-close-failed",
              owner: args.owner,
              repo: args.repo,
              prNumber: args.prNumber,
              err: err instanceof Error ? err.message : String(err),
            }),
          )
        }
      }
      return { skipped: true, rateLimit }
    }
    // comment post FAILED → FAIL-OPEN: fall through and run the review (never silently drop).
  }

  return { skipped: false, rateLimit }
}
