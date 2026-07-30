// SIG-318 / SIG-376 (Tier-1 8/8): queue-dispatch leaf of the Cloudflare
// Workers entry module. Holds `dispatchJob` — the second-largest
// declaration — plus the three job-run helpers only it calls
// (`postSlashCommandAck`, `prClosedOrMerged`, `prMetaIsClosedOrMerged`).
// Relocated VERBATIM from the pre-split src/index.ts (modulo the added
// `export` keyword + imports). The switch statement is untouched; it
// imports nothing from the entry module.

import { flushFindingEventLog } from "@/src/lib/finding-event-flush"
import type { FindingEventCapture, PostedFindingCapture } from "@/src/lib/ensemble/app/finding-event-capture"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"
import { GitHubClient } from "@/src/shared/adapters/github"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import { triageIssue } from "@/src/lib/triage"
import { runLinearAgentRun } from "@/src/lib/linear-agent-run"
import { linearTenantContextFromJob } from "@/src/features/linear-integration"
import { handleMention } from "@/src/lib/mention-reply"
import { renderSlashCommandAck, type SlashCommand } from "@/src/lib/slash-commands"
import { handlePrOverview } from "@/src/lib/triage-pr-overview"
import { handlePrLabels } from "@/src/lib/triage-pr-labels"
import { handleCiTriage } from "@/src/lib/triage-ci"
import { handlePrImprove } from "@/src/lib/triage-pr-improve"
import { handlePrDescribe } from "@/src/lib/triage-pr-describe"
import { handlePrSummary } from "@/src/lib/triage-pr-summary"
import { handleOverviewProofUpdate } from "@/src/lib/overview-proof-update"
import {
  handlePrPause,
  handlePrResume,
  handlePrIgnore,
  handlePrResolveThreads,
  handlePrCancel,
} from "@/src/lib/pr-lifecycle-commands"
import { handlePrStaleMark } from "@/src/lib/triage-pr-stale-mark"
import { handlePrReviewEnsemble } from "@/src/lib/triage-pr-review-ensemble"
import { dispatchGitLabMrReview } from "@/src/index-dispatch-gitlab"
import { runDemoReviewJob } from "@/src/lib/demo-review-job"
import { parseEnsembleConfig } from "@/src/lib/ensemble/config"
import { recordValidationMetrics } from "@/src/lib/validation-metrics-client"
import type { ValidationRejectionEvent } from "@/src/do/validation-metrics"
import { recordGraphMetrics } from "@/src/lib/graph-metrics-client"
import type { GraphRetrievalSample } from "@/src/do/graph-metrics"
import { recordGraphExpansionMetrics } from "@/src/lib/graph-expansion-metrics-client"
import type { GraphExpansionSample } from "@/src/do/graph-expansion-metrics"
import { isRepoSensitive } from "@/src/lib/repo-policy"
import { handleGithubMention } from "@/src/lib/github-mention"
import { runPrReviewWithDoCallback } from "@/src/do/consumer-wrapper"
import { enqueuePrReviewJob } from "@/src/do/webhook-enqueue"
import { handleIndexRepoJob } from "@/src/lib/indexer"
import { handleCorpusPrUpsert, handleCorpusPrBackfill, handleCorpusIssueUpsert } from "@/src/lib/multi-corpus-jobs"
import { finalStatusUpdate } from "@/src/lib/pr-review-status-phases"
import {
  attachExistingCheckRun,
  startInProgressCheckRun,
  completeCheckRun,
  parseReviewOutputSurface,
  type SigilixCheckConclusion,
} from "@/src/lib/pr-review-check-run"
import { deleteRepoIndex } from "@/src/lib/index-delete"
import { branchStateRepo } from "@/src/lib/index-branch"
import { postReviewWorkBlocked } from "@/src/index-dispatch-post-review-work"
import { runRateLimitGate } from "@/src/index-dispatch-rate-limit-gate"
import { handleMcpMemoryExpireJob } from "@/src/do/mcp/mcp-memory-jobs"
import { handleConsolidateClusterJob } from "@/src/lib/memory-consolidate-cluster"
import { consumeActivitySeatCommand, recoverOrgSeatBillingOperation } from "@/src/features/billing"
import { makeGitHubRepositoryContextReviewIdentity } from "@/src/features/repository-context"
import { runSlackMentionJob } from "@/src/index-slack-webhook"
/**
 * Post the slash-command ack comment for `cmd` on the given PR.
 * Used by pr-review-rerun and pr-improve queue handlers so the user
 * gets fast feedback that the command was received before the
 * (potentially 30-90s) LLM call completes. Throws on auth/comment
 * failure so callers can decide whether to swallow.
 */
export async function postSlashCommandAck(
  env: Env,
  cmd: SlashCommand,
  args: { owner: string; repo: string; prNumber: number; installationId: number },
): Promise<void> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY required")
  }
  const token = await getInstallationToken({
    kv: env.OPENCLAW_STATE,
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
    installationId: args.installationId,
  })
  const client = new GitHubClient({ token })
  await client.createIssueComment(args.owner, args.repo, args.prNumber, renderSlashCommandAck(cmd))
}

/**
 * Pure decision: is this PR "no longer open" — merged, or closed-unmerged? The
 * GitHub REST `state` is only "open" | "closed"; `merged` is inferred from a
 * non-null `merged_at` (a merged PR reports `state: "closed"` too, but we check
 * both so the predicate is robust to partial mocks). Exported for tests.
 */
export function prMetaIsClosedOrMerged(pr: { merged_at?: string | null; state?: "open" | "closed" }): boolean {
  return pr.merged_at != null || pr.state === "closed"
}

/**
 * Whether the PR is already merged or closed at job-run time. Used to skip an
 * automatic re-review of a PR that's no longer open: under model-backend
 * contention a `pr-review` job can be redelivered and re-run minutes AFTER the
 * PR merged, posting a useless after-the-fact review and burning the model
 * budget once per redelivery. FAILS OPEN — missing creds or any fetch error
 * returns `false` so we never wrongly skip a live review (recall over thrift).
 */
export async function prClosedOrMerged(
  env: Env,
  args: { owner: string; repo: string; prNumber: number; installationId: number },
): Promise<boolean> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) return false
  try {
    const token = await getInstallationToken({
      kv: env.OPENCLAW_STATE,
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      installationId: args.installationId,
    })
    const pr = await new GitHubClient({ token }).getPullRequest(args.owner, args.repo, args.prNumber)
    return prMetaIsClosedOrMerged(pr)
  } catch {
    return false
  }
}

export async function dispatchJob(
  job: JobMessage,
  env: Env,
  backgroundWaitUntil?: (promise: Promise<void>) => void,
): Promise<void> {
  switch (job.type) {
    case "linear-triage":
      return triageIssue(job.issueId, env, linearTenantContextFromJob(job))
    case "linear-mention":
      return handleMention(job.commentId, env, {
        // Missing on pre-SIG-225 in-flight jobs; preserve the legacy mention gate.
        triggerReason: job.triggerReason ?? "mention",
        ...(linearTenantContextFromJob(job) ? { tenant: linearTenantContextFromJob(job)! } : {}),
      })
    case "slack-mention":
      return runSlackMentionJob(env, job)
    case "pr-overview":
      // handlePrOverview returns the verdict only under the SIG-304 CLI dryRun
      // seam; the webhook dispatch ignores it and stays Promise<void>.
      return handlePrOverview({
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        headSha: job.headSha,
        installationId: job.installationId,
        env,
        ...(job.force ? { force: true } : {}),
        ...(job.skipDedupe ? { skipDedupe: true } : {}),
      }).then(() => {})
    case "pr-labels":
      // ARC-265/SIG-135: auto-label picker. Short-circuits only when
      // `sigilix.json::labels.enabled` is false; otherwise it uses
      // customLabels or falls back to existing repo labels.
      return handlePrLabels({
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        headSha: job.headSha,
        installationId: job.installationId,
        env,
      })
    case "pr-review": {
      // Skip an automatic (re-)review of a PR that's no longer open. Under
      // model-backend contention a pr-review job can be redelivered and re-run
      // minutes AFTER the PR merged, posting a useless after-the-fact review
      // and re-burning the model budget per redelivery. Fails open (see
      // `prClosedOrMerged`). `bypassClosedSkip` (set when a slash-command rerun
      // re-enqueues a pr-review message) overrides this — an explicit
      // user-requested rerun on a merged PR still runs.
      if (
        job.bypassClosedSkip !== true &&
        (await prClosedOrMerged(env, {
          owner: job.owner,
          repo: job.repo,
          prNumber: job.prNumber,
          installationId: job.installationId,
        }))
      ) {
        console.log(
          JSON.stringify({
            event: "pr-review-skipped-pr-not-open",
            owner: job.owner,
            repo: job.repo,
            prNumber: job.prNumber,
            headSha: job.headSha.slice(0, 7),
          }),
        )
        // Complete any pre-created check run (the SIG-220 fast-path row) so it
        // doesn't hang `in_progress` forever on a skipped job — mirrors the
        // label-gate skip path below.
        if (job.checkRunId !== undefined) {
          const handle = await attachExistingCheckRun({
            env,
            owner: job.owner,
            repo: job.repo,
            installationId: job.installationId,
            checkRunId: job.checkRunId,
          })
          await completeCheckRun({ handle, conclusion: "skipped" })
        }
        return
      }
      // ARC-289 diagnostic logging — emit on EVERY queue-handler entry into the
      // pr-review case so we can correlate duplicate dispatches (PR #96 saw 2×
      // ensemble runs on the same commit, 51s apart). The fields surface the
      // dispatch path: `runId` present → DO-routed (dedupe path); absent →
      // user rerun or older queued message; `staleHeadRequeueDepth > 0` →
      // ARC-251 requeue. Common (runId, headSha) ⇒ queue redelivery; distinct
      // runIds ⇒ webhook double-fire or warmup re-review.
      console.log(
        JSON.stringify({
          event: "pr-review-dispatch-received",
          owner: job.owner,
          repo: job.repo,
          prNumber: job.prNumber,
          headSha: job.headSha.slice(0, 7),
          runId: typeof job.runId === "string" ? job.runId : null,
          staleHeadRequeueDepth: job.staleHeadRequeueDepth ?? 0,
          dispatchedAt: Date.now(),
        }),
      )
      // ARC-190: string runId messages use the DO dedupe/retry path.
      // Mutable telemetry sinks — the ensemble pushes into these; each is flushed
      // exactly once in the finally below, off the review hot path and non-fatal.
      // Per-sink semantics are documented on EnsembleHandlerArgs (orchestrator-types).
      const validationSink: ValidationRejectionEvent[] = [] // SIG-119
      const findingEventSink: FindingEventCapture[] = [] // SIG-606 gate captures
      const postedFindingSink: PostedFindingCapture[] = [] // SIG-606 reconcile authority
      const graphMetricsSink: GraphRetrievalSample[] = [] // SIG-152
      const graphExpansionMetricsSink: GraphExpansionSample[] = [] // SIG-286 PR2.5
      const repositoryContextIdentity =
        job.repoId === undefined ? null : makeGitHubRepositoryContextReviewIdentity(job.installationId, job.repoId)
      const baseArgs = {
        scmProvider: "github" as const,
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        headSha: job.headSha,
        installationId: job.installationId,
        env,
        // SIG-318 (PR 5a): parse the typed ensemble config once here at the edge
        // and inject it; the handler reads it instead of env.OPENCLAW_*.
        ensembleConfig: parseEnsembleConfig(env),
        validationSink,
        findingEventSink,
        postedFindingSink,
        graphMetricsSink,
        graphExpansionMetricsSink,
        ...(backgroundWaitUntil !== undefined ? { backgroundWaitUntil } : {}),
        // ARC-251: thread the stale-head requeue depth into both review
        // pipelines (webhook omits → 0; requeues carry it so the cap holds).
        ...(job.staleHeadRequeueDepth !== undefined ? { staleHeadRequeueDepth: job.staleHeadRequeueDepth } : {}),
        // SIG-247: immutable repo.id; legacy messages fall back to getRepository.
        ...(job.repoId !== undefined ? { repoId: job.repoId } : {}),
        ...(repositoryContextIdentity !== null ? { repositoryContextIdentity } : {}),
        // VERIFIED unlock Phase 2: runner-receipt re-review → non-incremental (avoids SIG-459 empty-delta).
        ...(job.forceFullCoverage ? { forceFullCoverage: true } : {}),
      }
      return runPrReviewWithDoCallback(
        job,
        env,
        async (statusReporter) => {
          // ARC-258 follow-up: warmup signaling now lives inside the
          // pr-overview sticky (a "Sigilix is warming up its index"
          // callout at the top, gated on `repo-index-manifest:<repo>`
          // existence). The pr-review path no longer posts a separate
          // warmup comment. See `src/lib/triage-pr-overview.ts` and
          // `src/lib/warmup.ts::enqueueWarmupRerunsForIndex`.

          // ARC-280: routing collapsed. The pre-ARC-275 decision matrix
          // (ensemble-shadow vs ensemble-post vs phase3-agentic vs
          // phase3-singleshot-legacy) is gone — there's exactly one
          // review pipeline now (`handlePrReviewEnsemble`) plus the
          // intentional sensitive-repo skip. Phase 3 single-shot
          // reviewer + the `routeReview` decision layer are deleted in
          // this ticket; the ensemble owns submit, verify, retry, and
          // comment-fallback end-to-end (ARC-277 / ARC-278 / ARC-279).
          if (isRepoSensitive(env.OPENCLAW_SENSITIVE_REPOS, job.owner, job.repo)) {
            console.log(
              JSON.stringify({
                event: "pr-review-skipped",
                reason: "repo_in_sensitive_denylist",
                owner: job.owner,
                repo: job.repo,
                prNumber: job.prNumber,
              }),
            )
            // SIG-220: when the DO created the check upstream (so the
            // user already sees "Sigilix · In progress" in the GitHub
            // UI) and the dispatcher then skips for a sensitive-repo
            // policy, we must close the check ourselves — otherwise
            // it hangs `in_progress` forever. Map to `skipped` (wire
            // `neutral`) per the existing advisory-bot convention.
            // No-op when `checkRunId` is absent (legacy messages or
            // upstream create failed → no orphan to close).
            if (job.checkRunId !== undefined) {
              const handle = await attachExistingCheckRun({
                env,
                owner: job.owner,
                repo: job.repo,
                installationId: job.installationId,
                checkRunId: job.checkRunId,
              })
              await completeCheckRun({ handle, conclusion: "skipped" })
            }
            return
          }
          // SIG-38: per-developer rate-limit gate (logic extracted to
          // index-dispatch-rate-limit-gate.ts to keep this file under the 1000-line budget).
          // Placement: AFTER sensitive-repo skip; BEFORE `const checkRun` so the check
          // run is never created for a rate-limited job. `rateLimit` stays in scope so
          // Task 7 can thread `rateLimit.footer` into `finalStatusUpdate`.
          const { skipped: rateLimitSkipped, rateLimit } = await runRateLimitGate(env, {
            installationId: job.installationId,
            authorLogin: job.authorLogin,
            bypassClosedSkip: job.bypassClosedSkip,
            owner: job.owner,
            repo: job.repo,
            prNumber: job.prNumber,
            checkRunId: job.checkRunId,
          })
          if (rateLimitSkipped) return
          // SIG-220: when the upstream `PrReviewRunDO.handleEnqueue`
          // created the customer-visible check (the new fast path —
          // visible to the user within ~1–2s of push), the dispatcher
          // ATTACHES to that existing row instead of creating a new
          // one. Fallback (legacy queue messages without `checkRunId`,
          // slash-command reruns, stale-head helper requeues) keeps
          // the pre-SIG-220 dispatcher-time create path — best-effort
          // throughout; a null handle means the completion below is
          // a no-op.
          const checkRun =
            job.checkRunId !== undefined
              ? await attachExistingCheckRun({
                  env,
                  owner: job.owner,
                  repo: job.repo,
                  installationId: job.installationId,
                  checkRunId: job.checkRunId,
                })
              : await startInProgressCheckRun({
                  env,
                  owner: job.owner,
                  repo: job.repo,
                  headSha: job.headSha,
                  installationId: job.installationId,
                })
          let conclusion: SigilixCheckConclusion | null = null
          let reviewMeta: import("./lib/triage-pr-review-ensemble").ReviewMeta | undefined = undefined
          try {
            const result = await handlePrReviewEnsemble(
              statusReporter !== undefined ? { ...baseArgs, statusReporter } : baseArgs,
            )
            if (result.status === "posted") {
              const blocked = await postReviewWorkBlocked(result.postReviewWork, {
                owner: job.owner,
                repo: job.repo,
                prNumber: job.prNumber,
                headSha: job.headSha,
              })
              const statusUpdate = finalStatusUpdate({
                status: blocked ? "errored" : result.status,
                owner: job.owner,
                repo: job.repo,
                prNumber: job.prNumber,
                ...(result.reviewMeta !== undefined ? { reviewMeta: result.reviewMeta } : {}),
                ...(rateLimit.mode === "enforce" && rateLimit.footer ? { rateLimitFooter: rateLimit.footer } : {}),
              })
              if (statusUpdate !== null) statusReporter?.report(statusUpdate)
              conclusion = blocked ? "blocked" : result.reviewMeta?.surface === "comment" ? "failure" : "success"
              reviewMeta = result.reviewMeta
              return
            }
            const statusUpdate = finalStatusUpdate({
              status: result.status,
              owner: job.owner,
              repo: job.repo,
              prNumber: job.prNumber,
              ...(result.reviewMeta !== undefined ? { reviewMeta: result.reviewMeta } : {}),
              ...(rateLimit.mode === "enforce" && rateLimit.footer ? { rateLimitFooter: rateLimit.footer } : {}),
            })
            if (statusUpdate !== null) statusReporter?.report(statusUpdate)
            if (result.status === "stale_head") {
              conclusion = "skipped"
              return
            }
            // ARC-280 + follow-up: ARC-279 handles "synth ran but
            // submit didn't persist" via comment-fallback. The
            // remaining `skipped`/`errored` paths split into:
            //   - sensitive-repo: handled above, never reaches here
            //   - label gate: legitimate user-config skip → success
            //   - errored + skip-notice posted (router_no_specialists,
            //     specialists_all_failed, synth retry exhausted,
            //     internal_error): map to failure + thread reviewMeta
            //     so the Check Run title says "Couldn't review — see
            //     PR comment"
            //   - errored without skip-notice (rare; the helper
            //     itself failed to post): generic "Review failed"
            conclusion = result.status === "errored" ? "failure" : "success"
            reviewMeta = result.reviewMeta
          } catch (err) {
            conclusion = "failure"
            throw err
          } finally {
            await statusReporter?.flush()
            // Best-effort completion. `null` conclusion means we
            // returned before assigning one (shouldn't happen with the
            // current branches, but defensive). Map it to `failure` so
            // the check doesn't hang in_progress.
            // SIG-216: thread prNumber into reviewMeta so the check-run
            // summary can render the `[View review](pr-url)` link. When
            // the ensemble didn't return a reviewMeta (degraded paths),
            // the summary degrades to the link-less fallback — that's
            // intentional, not worth scaffolding a synthetic reviewMeta.
            const reviewMetaForComplete =
              reviewMeta !== undefined ? { ...reviewMeta, prNumber: job.prNumber } : undefined
            await completeCheckRun({
              handle: checkRun,
              conclusion: conclusion ?? "failure",
              // SIG-144: thread the configured output surface so the
              // check-run completer knows whether to post Checks
              // annotations (annotations | both) in addition to the
              // PR review comments the ensemble already posted.
              surface: parseReviewOutputSurface(env.OPENCLAW_REVIEW_OUTPUT_SURFACE),
              ...(reviewMetaForComplete !== undefined ? { reviewMeta: reviewMetaForComplete } : {}),
            })
            // SIG-119: flush collected validator-rejection telemetry once.
            // Non-fatal — a metrics failure must never affect the review.
            if (validationSink.length > 0) {
              try {
                await recordValidationMetrics(env, {
                  owner: job.owner,
                  repo: job.repo,
                  prNumber: job.prNumber,
                  headSha: job.headSha,
                  events: validationSink,
                })
              } catch (err) {
                console.log(
                  JSON.stringify({
                    event: "validation-metrics-record-error",
                    owner: job.owner,
                    repo: job.repo,
                    prNumber: job.prNumber,
                    error: err instanceof Error ? err.message : String(err),
                  }),
                )
              }
            }
            await flushFindingEventLog(env, job, findingEventSink, postedFindingSink) // SIG-606, fail-soft
            // SIG-152: flush the per-review graph-retrieval sample once.
            // Non-fatal — same guarantees as the validation flush above.
            const graphSample = graphMetricsSink[0]
            if (graphSample) {
              try {
                await recordGraphMetrics(env, {
                  owner: job.owner,
                  repo: job.repo,
                  prNumber: job.prNumber,
                  headSha: job.headSha,
                  sample: graphSample,
                })
              } catch (err) {
                console.log(
                  JSON.stringify({
                    event: "graph-metrics-record-error",
                    owner: job.owner,
                    repo: job.repo,
                    prNumber: job.prNumber,
                    error: err instanceof Error ? err.message : String(err),
                  }),
                )
              }
            }
            // SIG-286 PR2.5: flush the per-review graph-expansion sample once.
            // Non-fatal — same guarantees as the graph-retrieval flush above.
            const expansionSample = graphExpansionMetricsSink[0]
            if (expansionSample) {
              try {
                await recordGraphExpansionMetrics(env, { sample: expansionSample })
              } catch (err) {
                console.log(
                  JSON.stringify({
                    event: "graph-expansion-metrics-record-error",
                    owner: job.owner,
                    repo: job.repo,
                    prNumber: job.prNumber,
                    error: err instanceof Error ? err.message : String(err),
                  }),
                )
              }
            }
          }
        },
        backgroundWaitUntil,
      )
    }
    case "pr-review-rerun": {
      // ARC-178: `/sigilix review` slash command. Resolve the current
      // head SHA from PR meta, post an ack comment, clear the per-
      // (PR, headSha) dedupe lock the previous run installed, then
      // re-enqueue a regular pr-review job (which goes through the
      // standard routing: sensitive gate, ensemble vs Phase 3, etc.).
      const tag = { owner: job.owner, repo: job.repo, prNumber: job.prNumber }
      try {
        if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
          console.error(
            JSON.stringify({
              event: "pr-review-rerun-misconfigured",
              reason: "missing_github_app_credentials",
              ...tag,
            }),
          )
          return
        }
        const token = await getInstallationToken({
          kv: env.OPENCLAW_STATE,
          appId: env.GITHUB_APP_ID,
          privateKey: env.GITHUB_PRIVATE_KEY,
          installationId: job.installationId,
        })
        const client = new GitHubClient({ token })
        const meta = await client.getPullRequest(job.owner, job.repo, job.prNumber)
        const headSha = meta.head.sha
        if (!headSha) {
          console.error(
            JSON.stringify({
              event: "pr-review-rerun-skipped",
              reason: "no_head_sha",
              ...tag,
            }),
          )
          return
        }
        // SIG-247 Phase 1: resolve the immutable repo.id before
        // enqueuing so both silent warmup reruns AND user-typed slash
        // reruns carry it through to the consumer. Without this, both
        // rerun paths would fall back to legacy-only review-memory
        // reads — defeating the transfer-proof property of Phase 1.
        // Best-effort: a failed/null lookup falls back to undefined.
        let rerunRepoId: number | undefined
        try {
          const repoMeta = await client.getRepository(job.owner, job.repo)
          if (repoMeta && typeof repoMeta.id === "number" && Number.isInteger(repoMeta.id) && repoMeta.id > 0) {
            rerunRepoId = repoMeta.id
          }
        } catch (err) {
          console.warn(
            JSON.stringify({
              event: "pr-review-rerun-repo-id-fetch-failed",
              err: err instanceof Error ? err.message : String(err),
              ...tag,
            }),
          )
        }
        // Post ack comment so the user knows the request was received.
        // Best-effort: a failed ack doesn't block the re-review.
        //
        // ARC-236 (code-reviewer M1 catch on PR #80): when the rerun
        // is fired automatically by `enqueueWarmupRerunsForIndex`
        // after indexing completes, the customer didn't type a slash
        // command — the ack would be unsolicited noise on every
        // open PR. Skip the ack when `silent` is set.
        if (!job.silent) {
          // SIG-98 (CodeRabbit catch on PR #110): use the
          // `full-review` ack text when the rerun originated from a
          // `/sigilix full review` slash command (forceFresh: true).
          // The two acks differ — "...with cumulative-diff dedup
          // bypass..." vs the plain rerun copy — and rendering the
          // wrong one on the dedup-bypass path was misleading.
          const ackCmd: SlashCommand = job.forceFresh === true ? { cmd: "full-review" } : { cmd: "review" }
          try {
            await client.createIssueComment(job.owner, job.repo, job.prNumber, renderSlashCommandAck(ackCmd))
          } catch (err) {
            console.error(
              JSON.stringify({
                event: "slash-command-ack-failed",
                err: err instanceof Error ? err.message : String(err),
                cmd: ackCmd.cmd,
                ...tag,
              }),
            )
          }
        }
        // ARC-280: Phase 3's legacy single-shot dedupe lock is gone
        // (handlePrReview deleted). The ensemble uses its own per-
        // (PR, headSha) coalesce + lastReviewedSha guard inside
        // `handlePrReviewEnsemble`; the slash command's rerun
        // intent is preserved by the ensemble's own re-run logic
        // (the user-triggered enqueue bypasses the per-headSha
        // dedupe because each rerun is treated as a fresh job).

        // SIG-11: silent reruns (warmup fan-out from
        // `enqueueWarmupRerunsForIndex`) MUST route through
        // `enqueuePrReviewJob` so DO `/enqueue` dedup catches the
        // case where a normal webhook-driven review just ran on the
        // same headSha. Before this, the raw `OPENCLAW_JOBS.send`
        // bypassed both the DO and the consumer-wrapper's runId
        // check (consumer-wrapper.ts:66-68 short-circuits when
        // runId is absent), producing a duplicate full-ensemble run
        // — evidenced on PR #96 (`8ad306a` ran twice, ~46s + ~115s).
        //
        // Note (code-reviewer MINOR on PR review): DO's
        // `decideEnqueueAction` returns `dedupe-terminal` for
        // `done | failed | idle` runs. Warmup reruns after a FAILED
        // prior run will silently no-op too — intentional. Warmup is
        // opportunistic post-indexing fan-out; a real failure won't
        // be fixed by an automatic retry, and the customer can
        // always `/sigilix review` to force a fresh run.
        //
        // Slash-command reruns (silent !== true) keep the raw send:
        // a user who typed `/sigilix review` is explicitly asking
        // for a fresh review, and the existing comment above
        // documents that intentional bypass.
        if (job.silent === true) {
          const enq = await enqueuePrReviewJob(env, {
            owner: job.owner,
            repo: job.repo,
            prNumber: job.prNumber,
            headSha,
            baseSha: meta.base?.sha ?? null,
            installationId: job.installationId,
            // No webhook delivery — this is queue-internal.
            deliveryId: null,
            // SIG-247 Phase 1: thread the repo.id so silent warmup
            // reruns carry it into RunState + the consumer's
            // review-memory lookup.
            ...(rerunRepoId !== undefined ? { repoId: rerunRepoId } : {}),
            // SIG-38: thread PR author login so the DO-path silent rerun
            // carries it into RunState and the consumer can enforce rate limits.
            ...(meta.user?.login ? { authorLogin: meta.user.login } : {}),
          })
          if (!enq.ok) {
            // Codex MEDIUM on PR review: silent warmup reruns are
            // best-effort optimization, NOT customer-facing. The
            // surrounding try/catch swallows + logs the throw and
            // returns — so re-throwing here would NOT trigger a
            // queue retry. Log explicitly and continue.
            console.error(
              JSON.stringify({
                event: "pr-review-rerun-enqueue-failed",
                reason: `do-${enq.reason}`,
                silent: true,
                ...tag,
              }),
            )
          } else {
            // Codex LOW on PR review: emit rerun-context telemetry
            // so we can count how often warmup reruns are being
            // suppressed by DO dedup vs newly enqueued. The DO's
            // own `do-review-deduped` log carries (owner, repo,
            // prNumber, runId, action) — correlate by timestamp +
            // (owner, repo, prNumber).
            console.log(
              JSON.stringify({
                event: "pr-review-rerun-silent-routed",
                route: enq.route,
                ...tag,
              }),
            )
          }
        } else {
          const reviewMessage: JobMessage = {
            type: "pr-review",
            owner: job.owner,
            repo: job.repo,
            prNumber: job.prNumber,
            headSha,
            installationId: job.installationId,
            // A slash-command rerun is an EXPLICIT user request: bypass the
            // merged/closed-PR skip guard so it runs even after merge.
            bypassClosedSkip: true,
            // SIG-247 Phase 1: slash-command raw-sends bypass the DO
            // path, so they thread repoId directly into the JobMessage
            // here. Consumer reads it into `baseArgs` and on into the
            // ensemble's review-memory lookup.
            ...(rerunRepoId !== undefined ? { repoId: rerunRepoId } : {}),
            // SIG-38: thread PR author login directly into the raw
            // queue send so the consumer can enforce per-author rate
            // limits on slash-command reruns.
            ...(meta.user?.login ? { authorLogin: meta.user.login } : {}),
          }
          await env.OPENCLAW_JOBS.send(reviewMessage)
          // SIG-98 — telemetry so we can tell `/sigilix review` apart
          // from `/sigilix full review` in the future. Both paths
          // already bypass the noop-merge cumulative-diff guard (which
          // only runs on the webhook `synchronize` path); `forceFresh`
          // is the explicit bypass switch for any future dedup layer
          // that DOES apply to rerun jobs.
          console.log(
            JSON.stringify({
              event: "pr-review-rerun-dispatched",
              forceFresh: job.forceFresh === true,
              ...tag,
            }),
          )
        }
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "pr-review-rerun-error",
            err: err instanceof Error ? err.message : String(err),
            ...tag,
          }),
        )
      }
      return
    }
    case "pr-improve":
      // ARC-179: `/sigilix improve` slash command. Single-shot LLM
      // call producing apply-able GitHub suggested-change comments.
      // Independent of the ensemble; fail-soft on ack but re-throws
      // on the actual run so queue retries get a chance.
      try {
        await postSlashCommandAck(
          env,
          { cmd: "improve" },
          {
            owner: job.owner,
            repo: job.repo,
            prNumber: job.prNumber,
            installationId: job.installationId,
          },
        )
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "slash-command-ack-failed",
            err: err instanceof Error ? err.message : String(err),
            owner: job.owner,
            repo: job.repo,
            prNumber: job.prNumber,
            cmd: "improve",
          }),
        )
      }
      return handlePrImprove({
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        installationId: job.installationId,
        env,
      })
    case "pr-help": {
      // `/sigilix help` — post a static command-list comment. No model
      // call. `renderSlashCommandAck("help")` returns the full
      // help-body markdown (the body IS the response), so the same
      // ack helper used by other slash commands does the entire job.
      try {
        await postSlashCommandAck(
          env,
          { cmd: "help" },
          {
            owner: job.owner,
            repo: job.repo,
            prNumber: job.prNumber,
            installationId: job.installationId,
          },
        )
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "pr-help-error",
            err: err instanceof Error ? err.message : String(err),
            owner: job.owner,
            repo: job.repo,
            prNumber: job.prNumber,
          }),
        )
      }
      return
    }
    case "pr-describe":
      // ARC-191 / ARC-264: `/sigilix describe [apply] [mode]`.
      // Single-shot LLM call producing a PR description / changelog
      // draft. With `apply: false` (default) it posts a top-level
      // comment with marker-wrapped body. With `apply: true` it
      // writes the same draft into the PR body in place. Both paths
      // share the same model call + verdict; only the post step
      // differs. Independent of the ensemble; does NOT consume the
      // ensemble daily budget.
      try {
        await postSlashCommandAck(
          env,
          { cmd: "describe", mode: job.mode, apply: job.apply },
          {
            owner: job.owner,
            repo: job.repo,
            prNumber: job.prNumber,
            installationId: job.installationId,
          },
        )
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "slash-command-ack-failed",
            err: err instanceof Error ? err.message : String(err),
            owner: job.owner,
            repo: job.repo,
            prNumber: job.prNumber,
            cmd: "describe",
            mode: job.mode,
            apply: job.apply,
          }),
        )
      }
      return handlePrDescribe({
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        installationId: job.installationId,
        mode: job.mode,
        apply: job.apply,
        env,
      })
    case "pr-summary":
      // SIG-437: `@sigilix summary` — handler soft-fails on every branch.
      return handlePrSummary(job, env)
    case "pr-stale-mark":
      // ARC-184: review-provenance stale marker. Independent of any
      // model call; consumes only GitHub-side metadata + a single
      // PATCH per drift. Wrapped in try/catch so a failure here never
      // blocks the queue dispatch loop — the handler itself emits
      // structured telemetry on every branch.
      try {
        await handlePrStaleMark({
          env,
          owner: job.owner,
          repo: job.repo,
          prNumber: job.prNumber,
          installationId: job.installationId,
          manifestSnapshot: job.manifestSnapshot,
          newHeadSha: job.newHeadSha,
          newBaseSha: job.newBaseSha,
          currentPromptVersion: job.currentPromptVersion,
        })
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "pr-stale-mark-bubbled",
            err: err instanceof Error ? err.message : String(err),
            owner: job.owner,
            repo: job.repo,
            prNumber: job.prNumber,
          }),
        )
        throw err
      }
      return
    // SIG-471 (quiet-VERIFIED): re-run ONLY the receipt-join + patch the
    // overview Proof line in place (no specialist run, no second review).
    case "overview-proof-update":
      return handleOverviewProofUpdate(job, env)
    case "ci-triage":
      return handleCiTriage({
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        runId: job.runId,
        headSha: job.headSha,
        installationId: job.installationId,
        env,
      })
    case "github-mention":
      return handleGithubMention({
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        installationId: job.installationId,
        ...(job.repoId !== undefined ? { repoId: job.repoId } : {}),
        surface: job.surface,
        commentId: job.commentId,
        ...(job.threadRootId !== undefined ? { threadRootId: job.threadRootId } : {}),
        env,
      })
    case "mcp-memory-expire":
      return handleMcpMemoryExpireJob(job, env)
    case "org-activity-seat-command":
      return consumeActivitySeatCommand(env, job)
    case "org-seat-billing-reconcile":
      return recoverOrgSeatBillingOperation(env, job)
    case "index-repo":
      // ARC-235: bootstrap jobs walk/filter files; shards continue via tokens.
      // See src/lib/indexer.ts for the complete state machine.
      return handleIndexRepoJob({ job, env })
    case "delete-repo-index": {
      const repoState = job.branch ? await branchStateRepo(job.repo, job.branch) : job.repo
      const result = await deleteRepoIndex({
        env,
        owner: job.owner,
        repo: repoState,
        reason: job.reason,
      })
      if (result.status === "partial") {
        throw new Error(`delete-repo-index partial for ${job.owner}/${repoState}`)
      }
      return
    }
    case "pr-pause":
      // SIG-98: `/sigilix pause` — 24h auto-review pause.
      return handlePrPause({
        env,
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        installationId: job.installationId,
      })
    case "pr-resume":
      // SIG-98: `/sigilix resume` — clears pause + ignore flags.
      return handlePrResume({
        env,
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        installationId: job.installationId,
      })
    case "pr-ignore":
      // SIG-98: `/sigilix ignore` — permanent auto-review opt-out.
      return handlePrIgnore({
        env,
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        installationId: job.installationId,
      })
    case "pr-resolve-threads":
      // SIG-98: `/sigilix resolve` — mark Sigilix-rooted threads
      // resolved via the GraphQL `resolveReviewThread` mutation.
      return handlePrResolveThreads({
        env,
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        installationId: job.installationId,
      })
    case "pr-cancel":
      // SIG-329: `/sigilix cancel` — abort the in-flight review by
      // terminating its PrReviewRunDO run + closing the check.
      return handlePrCancel({
        env,
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        installationId: job.installationId,
      })
    case "corpus-pr-upsert":
      // SIG-44: embed a merged PR into the pr: multi-corpus namespace.
      return handleCorpusPrUpsert(env, {
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        title: job.title,
        body: job.body,
      })
    case "corpus-pr-backfill": // SIG-44: 90-day merged-PR backfill on repo onboarding.
      return handleCorpusPrBackfill(
        env,
        {
          owner: job.owner,
          repo: job.repo,
          installationId: job.installationId,
          ...(job.force !== undefined ? { force: job.force } : {}),
        },
        Date.now(),
      )
    case "corpus-issue-upsert":
      // SIG-44: embed a Linear issue into the issue: multi-corpus namespace.
      return handleCorpusIssueUpsert(env, {
        linearIssueId: job.linearIssueId,
        ...(linearTenantContextFromJob(job) ? { tenant: linearTenantContextFromJob(job)! } : {}),
      })
    case "linear-agent-run":
      // Assignee/AgentSession trigger; tenant context routes auth and the session ack.
      return runLinearAgentRun(job.issueId, env, job.sessionId, linearTenantContextFromJob(job))
    case "gitlab-mr-review":
      // sig-gitlab-adapter (GitLab PR 3): resolve the per-project token + run the
      // allowlist gate, build the GitLab review client via GitLabScmProvider, and
      // run the SAME SCM-agnostic ensemble GitHub uses (posting through the GitLab
      // client). Recall-safety is enforced inside (an errored run surfaces a note).
      return dispatchGitLabMrReview(job, env, backgroundWaitUntil)
    case "consolidate-cluster": // Gardener P2: consolidate one cleared cluster (self-gates on OPENCLAW_MEMORY_CONSOLIDATE; fail-soft inside).
      return handleConsolidateClusterJob(job, env)
    case "demo-review": // sig-public-demo (async): PUBLIC no-signup demo, run off-request. See demo-review-job.ts.
      return runDemoReviewJob(job, env)
    default: {
      // Exhaustiveness check — an unhandled JobMessage variant is a compile error (`never`) and a loud throw.
      const exhaustive: never = job
      throw new Error(`unknown queue job type: ${JSON.stringify(exhaustive).slice(0, 200)}`)
    }
  }
}
