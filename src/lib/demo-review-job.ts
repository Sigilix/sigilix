// sig-public-demo (async) — the OFF-REQUEST-PATH half of POST /v1/demo/review.
//
// The public demo runs the FULL ensemble (~70-120s, up to ~2 min on a big diff). A
// Cloudflare fetch handler is killed near ~100s, so a synchronous demo review slower
// than that never returns and never caches — the browser just sees "could not reach
// the review service." This module runs that same review as a QUEUE JOB instead: the
// queue consumer gets up to 15 minutes of wall-clock (see src/index.ts `queue`), far
// more than the review needs.
//
// It reuses the EXACT engine entry point, args, and recall-safety handling the old
// synchronous path used (`handlePrReviewEnsemble` in `dryRun` + `forceFullCoverage`
// with the write-throwing `diffReviewClient`, review-memory/learnings forced off).
// The ONLY move is WHERE it runs (the queue consumer, not the request) and WHERE the
// result lands (the KV job record the GET poll reads, in addition to the PR@SHA cache
// the sync path already wrote).
//
// COST/RECALL invariants preserved verbatim from the sync path:
//   • the reservation made by the POST is always reconciled with `settleDemoSpend` —
//     on success with the REAL cost, on ANY failure with the assumed cost (a crashed
//     or diff-fetch-failed run keeps its reservation; a demo run that spent tokens is
//     never free);
//   • an errored / no-verdict engine result resolves the job to `error`, NEVER a
//     `done` with an empty findings array, and is NEVER written to the PR@SHA cache;
//   • a DEGRADED (specialist-unavailable) review resolves to `done` but carries
//     `incomplete.rolesMissing` and says so in the summary.

import type { Env } from "@/src/shared/types/env"
import type { GitHubClient } from "@/src/shared/adapters/github"
import type { PrReviewFinding, CodeContext } from "@/src/shared/domain/pr-review-finding"
import { handlePrReviewEnsemble } from "@/src/lib/ensemble/app/orchestrator"
import { isDryRunEngineFailure, type DryRunReview } from "@/src/lib/ensemble/app/session"
import { computeReviewCost } from "@/src/lib/ensemble-slo-telemetry"
import { severityLabelForScore } from "@/src/lib/ensemble/domain/verdict"
import { trustWord } from "@/src/lib/trust-ledger-render"
import { diffReviewClient } from "@/src/lib/api-review-diff-client"
import { ungroundedEnv } from "@/src/lib/api-review-route"
import { attachCodeContextToReview } from "@/src/shared/util/diff-code-context"
import {
  settleDemoSpend,
  writeDemoCache,
  writeDemoJob,
  DEMO_ASSUMED_COST_USD,
  type DemoEnv,
  type DemoPrTarget,
} from "@/src/lib/demo-review-guards"
import { fetchPrDiff } from "@/src/lib/demo-review-github"
import type { DemoFinding, DemoReviewResponse, DemoJobRecord } from "@/src/lib/api-demo-review-route"

/** The `demo-review` queue-message shape. Structurally the fields the async run needs;
 *  imported by value nowhere (the discriminated `JobMessage` union owns the canonical
 *  type), so this local alias just names the slice this module consumes. */
export interface DemoReviewJob {
  jobId: string
  owner: string
  repo: string
  prNumber: number
  headSha: string
  baseSha: string
  title: string
  changedFiles: number
  reservedAtMs: number
}

/** Cap the evidence snippet we echo back per finding (display only). */
const MAX_EVIDENCE_LINES = 12
const MAX_EVIDENCE_CHARS = 800

/**
 * The env the demo engine runs under. `ungroundedEnv` already stubs code-index + graph
 * retrieval inert (a stranger's repo is not indexed, and this also means no tenant's
 * indexed code can ever be reached). On TOP of that, review-memory and learnings are
 * forced OFF — exactly as `/v1/review`'s Mode B does (`groundedReviewEnv`) and for the
 * same reason: the demo passes no `repoId`, so leaving them on would read stale legacy
 * owner/repo records AND could fire the SIG-280 shadow KV write keyed on a STRANGER's
 * owner/repo. Off → the demo review is a pure read with no cross-tenant reach, robustly
 * (a structural guarantee) rather than incidentally.
 */
export function demoEngineEnv(env: DemoEnv): Env {
  return ungroundedEnv({ ...env, OPENCLAW_REVIEW_MEMORY_ENABLED: "off", OPENCLAW_LEARNINGS_MODE: "off" })
}

/** The cited lines from the diff slice the renderer already computes — display
 *  evidence, exactly what the PR review would show. Never gates anything. */
function evidenceFrom(context: CodeContext | undefined): string | undefined {
  if (!context || context.lines.length === 0) return undefined
  const text = context.lines
    .slice(0, MAX_EVIDENCE_LINES)
    .map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`)
    .join("\n")
  return text.length > MAX_EVIDENCE_CHARS ? `${text.slice(0, MAX_EVIDENCE_CHARS)}…` : text
}

function toDemoFinding(finding: PrReviewFinding): DemoFinding {
  const evidence = evidenceFrom(finding.codeContext)
  return {
    severity: severityLabelForScore(finding.score),
    title: finding.headline,
    body: finding.body,
    file: finding.path,
    line: finding.line,
    confidence: trustWord(finding.trust).toLowerCase() as DemoFinding["confidence"],
    ...(evidence !== undefined ? { evidence } : {}),
  }
}

/** Shape the engine's dry-run review into the public demo contract. Typed as the real
 *  `DryRunReview` (not a structural subset) so a change to that shape — e.g. dropping
 *  `incomplete` or `unanchoredFindings` — is a compile error here, not a silently
 *  dropped finding or a degraded-banner that stops firing. */
export function buildResponse(
  target: DemoPrTarget,
  meta: { title: string; changedFiles: number },
  review: DryRunReview | undefined,
  diff: string,
  durationMs: number,
): DemoReviewResponse {
  const base = {
    repo: `${target.owner}/${target.repo}`,
    prNumber: target.prNumber,
    title: meta.title,
    cached: false,
  }
  // A genuinely-empty review (nothing to review / no findings) is a legitimate clean
  // pass — distinct from an engine failure, which resolves the job to `error`.
  if (!review) {
    return {
      ...base,
      summary: "Sigilix found no reviewable changes in this pull request.",
      stats: { filesReviewed: meta.changedFiles, findingsCount: 0, durationMs },
      findings: [],
    }
  }
  // RECALL-SAFETY: include the BODY-ONLY (unanchored) findings, not just the inline
  // ones. In a diff-only/ungrounded review the model often cites a line that isn't an
  // added line, so its finding lands in `unanchoredFindings`; dropping those would make
  // a review whose only issue is body-only render as "0 findings" — a real finding
  // rendering as a clean pass. Every other renderer in the repo merges both lists.
  const enriched = attachCodeContextToReview(
    { verdict: review.verdict, unanchoredFindings: review.unanchoredFindings },
    diff,
  )
  const findings = [...enriched.verdict.findings, ...enriched.unanchoredFindings].map(toDemoFinding)
  const rolesMissing = review.incomplete?.rolesMissing ?? []
  // RECALL-SAFETY: a degraded review says so in the human-facing summary too — a
  // partial review must never read as a confident clean pass.
  const summary =
    rolesMissing.length > 0
      ? `${review.verdict.summary}\n\n⚠️ Partial coverage: ${rolesMissing.join(", ")} did not complete, so this review ran on incomplete input.`
      : review.verdict.summary
  return {
    ...base,
    summary,
    stats: { filesReviewed: meta.changedFiles, findingsCount: findings.length, durationMs },
    findings,
    ...(rolesMissing.length > 0 ? { incomplete: { rolesMissing: [...rolesMissing] } } : {}),
  }
}

/** RECALL-SAFETY: the job-record shape for a review that could not complete. Mirrors the
 *  sync path's `review_failed` 500 — a poll gets an explicit `error`, never a clean pass. */
function errorRecord(error: string, message: string): DemoJobRecord {
  return { status: "error", error, message }
}

/**
 * Run the async demo review to completion and resolve its poll-job record. Invoked by
 * the queue consumer (`dispatchJob` → `case "demo-review"`), which has a ~15-min budget.
 * The IP quota was already consumed and the spend reserved by the POST handler; this
 * function fetches the diff, runs the ensemble, reconciles the reservation, and writes
 * the result to BOTH the PR@SHA cache (`writeDemoCache`) and the job record the GET poll
 * reads (`writeDemoJob`).
 *
 * It NEVER throws — the outer guard converts ANY unexpected error into a resolved `error`
 * record, because a throw here would make the queue consumer `message.retry()` and RE-RUN
 * the ensemble (up to `MAX_RETRIES`), re-spending the model budget on each retry. The
 * inner paths already handle the expected failures; the guard is the cost backstop for
 * anything unforeseen (keeps the reservation — over-counting is the cost-safe direction).
 */
export async function runDemoReviewJob(job: DemoReviewJob, env: DemoEnv): Promise<void> {
  try {
    await executeDemoReview(job, env)
  } catch (error) {
    await settleDemoSpend(env, new Date(job.reservedAtMs), DEMO_ASSUMED_COST_USD)
    console.error(
      JSON.stringify({
        event: "demo-review-unexpected-error",
        repo: `${job.owner}/${job.repo}`,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    await writeDemoJob(
      env,
      job.jobId,
      errorRecord("review_failed", "The review could not be completed. Please try again."),
    )
  }
}

async function executeDemoReview(job: DemoReviewJob, env: DemoEnv): Promise<void> {
  const target: DemoPrTarget = { owner: job.owner, repo: job.repo, prNumber: job.prNumber }
  const repoLabel = `${job.owner}/${job.repo}`
  // Reconcile against the SAME UTC-day the POST reserved on (crossing midnight is rare;
  // this keeps the reservation and its settlement on one key, exactly like the old
  // single-`now` sync path).
  const reservedAt = new Date(job.reservedAtMs)

  // Diff fetch moved off the request path (a 400KB diff exceeds the 128KB queue-message
  // cap). Public-repo + PR meta + size cap were already validated synchronously by the
  // POST; a failure here is almost always transient GitHub unavailability. Keep the
  // reservation (no tokens spent, but a refund helper does not exist and over-counting
  // is the cost-safe direction) and resolve the job to `error`.
  const diff = await fetchPrDiff(env, target)
  if (!diff.ok) {
    await settleDemoSpend(env, reservedAt, DEMO_ASSUMED_COST_USD)
    const message =
      diff.failure.kind === "too_large"
        ? "That PR's diff is too large for the demo."
        : "GitHub could not be reached right now. Try again shortly."
    const code = diff.failure.kind === "too_large" ? "too_large" : "github_unavailable"
    console.error(JSON.stringify({ event: "demo-review-diff-failed", repo: repoLabel, kind: diff.failure.kind }))
    await writeDemoJob(env, job.jobId, errorRecord(code, message))
    return
  }

  const startedMs = Date.now()
  let result
  try {
    result = await handlePrReviewEnsemble({
      scmProvider: "github",
      owner: target.owner,
      repo: target.repo,
      prNumber: target.prNumber,
      headSha: job.headSha,
      installationId: 0, // no installation → no usage_ledger row
      env: demoEngineEnv(env), // no index/graph retrieval AND review-memory/learnings OFF
      githubClient: diffReviewClient({
        owner: target.owner,
        repo: target.repo,
        prNumber: target.prNumber,
        headSha: job.headSha,
        baseSha: job.baseSha,
        diff: diff.value,
      }) as unknown as GitHubClient,
      dryRun: true, // READ-ONLY: nothing is posted to the PR
      forceFullCoverage: true,
    })
  } catch (error) {
    // The engine threw before reporting telemetry — it may still have spent. Charge the
    // assumed cost (the reservation already stands) and resolve to error, never a pass.
    await settleDemoSpend(env, reservedAt, DEMO_ASSUMED_COST_USD)
    console.error(
      JSON.stringify({
        event: "demo-review-failed",
        repo: repoLabel,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    await writeDemoJob(
      env,
      job.jobId,
      errorRecord("review_failed", "The review could not be completed. Please try again."),
    )
    return
  }

  // Charge the REAL cost the ensemble reports, reconciling the reservation. `?? {}` so
  // a telemetry shape that ever omits the ledger can't throw past settleDemoSpend.
  const costUsd = computeReviewCost(result.telemetry.tokenUsageByModel ?? {}).totalUsd
  await settleDemoSpend(env, reservedAt, costUsd)

  // RECALL-SAFETY: an engine failure resolves to `error`, NEVER `done` with empty
  // findings, and is NEVER cached (the next caller gets a real attempt).
  if (isDryRunEngineFailure(result)) {
    const telemetry = result.telemetry as { internalError?: string; fellBackReason?: string }
    console.error(
      JSON.stringify({
        event: "demo-review-engine-failure",
        repo: repoLabel,
        reason: telemetry.internalError ?? telemetry.fellBackReason ?? "engine error",
      }),
    )
    await writeDemoJob(
      env,
      job.jobId,
      errorRecord("review_failed", "The review could not be completed. Please try again."),
    )
    return
  }

  const body = buildResponse(
    target,
    { title: job.title, changedFiles: job.changedFiles },
    result.dryRunReview,
    diff.value,
    Date.now() - startedMs,
  )
  await writeDemoCache(env, target, job.headSha, body)
  await writeDemoJob(env, job.jobId, { status: "done", ...body })
  console.log(
    JSON.stringify({
      event: "demo-review-completed",
      repo: repoLabel,
      prNumber: target.prNumber,
      findings: body.stats.findingsCount,
      costUsd: Number(costUsd.toFixed(4)),
      durationMs: body.stats.durationMs,
    }),
  )
}
