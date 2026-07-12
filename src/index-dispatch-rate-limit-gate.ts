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
import { checkRateLimit, isFullPaidStatus, readTenantSubscriptionStatus } from "@/src/features/tenancy"
import type { RateLimitDecision } from "@/src/features/tenancy"
import { readInstallationPlan } from "@/src/features/entitlements"
import { GitHubClient } from "@/src/shared/adapters/github"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import { attachExistingCheckRun, completeCheckRun } from "@/src/lib/pr-review-check-run"

/**
 * Hidden HTML marker on the over-cap notice. Lets a later push find an existing notice
 * on the PR and skip re-posting, instead of stacking one comment per push. Invisible in
 * rendered markdown; matched with a plain substring check on the comment body.
 */
const RATE_LIMIT_COMMENT_MARKER = "<!-- sigilix:rate-limit-notice -->"

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
  // Resolve the installation's plan/tier so the gate uses the tenant's real cap AND
  // real cost budget. readInstallationPlan THROWS on a missing binding or a D1 fault.
  //
  // sig-cost-primary: on a fault we must BYPASS the gate, not fall back to `null`.
  // `null` does NOT mean "no limit" — it normalizes to the FREE tier on BOTH dimensions
  // (resolveRateLimitCap(null) → the free count cap; normalizeBudgetTier(null) → "free"
  // → the free USD budget). The usage read is a SEPARATE D1 statement that can still
  // succeed, so a partial fault would apply the Free budget to a paying customer and
  // BLOCK a review they had every right to run — fail-CLOSED, the exact opposite of the
  // intent. (Harmless while only a count cap rode on the tier string and the gate was in
  // shadow; not harmless now that a USD budget rides on it and the gate enforces.)
  // An unknown tier is an infrastructure failure, not a free plan: let the review run.
  let tier: string | null = null
  let tierReadFailed = false
  try {
    tier = await readInstallationPlan(env, args.installationId)
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "rate-limit-tier-read-failed",
        installationId: args.installationId,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    tier = null
    tierReadFailed = true
  }

  // sig-trial-cap: a subscriber on their 14-day TRIAL gets the tier's FEATURES but HALF
  // its usage volume; only a fully-paid `active` subscription earns the full cap.
  // readTenantSubscriptionStatus never throws (null on any fault/absent), and
  // isFullPaidStatus treats a null/unknown status as NOT active → trialing (half), so a
  // read fault fails safe to the more-restrictive cap, never to full paid volume.
  // (Existing paid tenants are backfilled to 'active' by migration 0011, so this
  // fail-safe half never mis-applies to a pre-existing paying customer.)
  const subscriptionStatus = await readTenantSubscriptionStatus(env, args.installationId)
  const trialing = !isFullPaidStatus(subscriptionStatus)

  // `bypassReason` short-circuits checkRateLimit to allowed:true before any D1 read.
  // Both reasons end in the SAME allow, so precedence is a telemetry choice only: the
  // caller's explicit slash-command rerun wins, and "tier-read-failed" is reported when
  // the fault is the sole reason we are letting this review through.
  const bypassReason =
    args.bypassClosedSkip === true ? "slash-command-rerun" : tierReadFailed ? "tier-read-failed" : undefined

  const rateLimit = await checkRateLimit(env, {
    installationId: args.installationId,
    authorLogin: args.authorLogin,
    nowMs: Date.now(),
    tier,
    trialing,
    ...(bypassReason !== undefined ? { bypassReason } : {}),
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
      // Explain the ACTUAL binding dimension. Cost is designed to bind FIRST, so a
      // cost-blocked review is normally still under its count cap and `resetMs` (which
      // is count-based) is 0 — rendering the count numbers there would claim
      // "N of M reviews used … next slot in ~1m", every part of which is false.
      const body =
        rateLimit.limitedBy === "cost"
          ? `${RATE_LIMIT_COMMENT_MARKER}\n**Sigilix · Usage budget reached** — this repo has used its review budget for the past 5h. ` +
            `Reviews are metered by model spend, not PR count, so a large diff uses more of the budget than a small one. ` +
            `The window rolls continuously; the next review will run once earlier usage ages out (up to 5h).`
          : `${RATE_LIMIT_COMMENT_MARKER}\n**Sigilix · Rate limit reached** — ${rateLimit.used} of ${rateLimit.cap} reviews used in the past 5h. ` +
            `Next review slot in ~${Math.max(1, Math.ceil(rateLimit.resetMs / 60000))}m.`

      // Dedupe: a blocked author typically keeps pushing, and every push re-enters this
      // gate. Without this, each push posts another "budget reached" comment. One notice
      // per PR is enough — the user already knows. An existing marker counts as "posted"
      // so the review is still skipped (they have been told), not silently re-run.
      const existing = await client.listIssueComments(args.owner, args.repo, args.prNumber)
      if (existing.some((c) => (c.body ?? "").includes(RATE_LIMIT_COMMENT_MARKER))) {
        console.log(
          JSON.stringify({
            event: "rate-limit-comment-deduped",
            owner: args.owner,
            repo: args.repo,
            prNumber: args.prNumber,
          }),
        )
        posted = true
      } else {
        await client.createIssueComment(args.owner, args.repo, args.prNumber, body)
        posted = true
      }
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
