// SIG-318 / SIG-376 (Tier-1 8/8): GitHub-webhook leaf of the Cloudflare
// Workers entry module. Holds `handleGitHubWebhook` — the single largest
// declaration in the entry module — relocated VERBATIM from the pre-split
// src/index.ts (modulo the added `export` keyword + imports). The shared
// payload type + the mention/capture helpers it calls live in
// src/index-internals.ts (a leaf->leaf edge, acyclic); it imports nothing
// from the entry module.

import type { Env } from "@/src/shared/types/env"
import { GitHubClient } from "@/src/shared/adapters/github"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import { verifyGitHubWebhook } from "@/src/shared/adapters/github/github-webhook-verify"
import { readReviewManifest } from "@/src/lib/review-manifest"
import { PROMPT_VERSION } from "@/src/prompts/pr-review"
import {
  hasExplicitTopLevelReviewFeedbackSignal,
  hasStaleDismissedReviewFeedbackSignal,
} from "@/src/lib/review-memory/capture"
import { isPrOverviewEnabled, loadSigilixConfig } from "@/src/lib/sigilix-config"
import { maybeEnqueuePrSummary } from "@/src/lib/pr-summary-trigger"
import { postDraftPrSkipNotice, supersedeDraftPrSkipNotice } from "@/src/lib/pr-draft-skip-notice"
import { enqueuePrReviewJob } from "@/src/do/webhook-enqueue"
import { computeDiffHash, readPriorReviewDiffHash } from "@/src/lib/noop-merge-detect"
import {
  enqueueIndexJobsForRepos,
  isIndexerEnabled,
  maybeEnqueuePullRequestBranchIndexJobs,
  type IndexJobReason,
} from "@/src/lib/index-producer"
import { multiCorpusEnabled } from "@/src/lib/multi-corpus"
import { postPrOverviewStubIfNeeded } from "@/src/lib/pr-overview-stub"
import { handleInstallReposRemoved, handleInstallationDeleted } from "@/src/lib/index-delete"
import {
  type GitHubWebhookPayload,
  decidePullRequestJobs,
  queueGithubMention,
  handlePushEvent,
  dispatchReviewMemoryCapture,
  dispatchTopLevelReviewMemoryCapture,
  dispatchDismissedReviewMemoryCapture,
} from "@/src/index-internals"
import {
  handleReviewThreadAutoApproveWebhook,
  maybeScheduleAutoApproveFromIssueComment,
  maybeScheduleAutoApproveFromReviewComment,
} from "@/src/index-github-auto-approve"
import { handleWorkflowRunEvent } from "@/src/index-github-workflow-run"

export async function handleGitHubWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY || !env.GITHUB_WEBHOOK_SECRET) {
    return new Response("github app not configured\n", { status: 503 })
  }

  const rawBody = await request.text()
  const sig = request.headers.get("x-hub-signature-256") ?? ""
  const event = request.headers.get("x-github-event") ?? ""

  const verified = await verifyGitHubWebhook(rawBody, sig, env.GITHUB_WEBHOOK_SECRET)
  if (!verified) {
    return new Response("invalid signature\n", { status: 401 })
  }

  let payload: GitHubWebhookPayload
  try {
    payload = JSON.parse(rawBody) as GitHubWebhookPayload
  } catch {
    return new Response("invalid json\n", { status: 400 })
  }

  // GitHub fires `ping` when a webhook URL is set or updated. Ack and
  // move on — no installation/repo context, nothing to enqueue.
  if (event === "ping") {
    return new Response("pong\n", { status: 200 })
  }

  // App-level events have no repository field. ARC-234 intercepts the
  // two install-onboarding events that drive the customer-ready
  // indexing pipeline (`installation.created` initial set +
  // `installation_repositories.added` deltas). ARC-238 intercepts the
  // two deletion events. The rest stay dropped.
  if (
    event === "installation" ||
    event === "installation_repositories" ||
    event === "installation_target" ||
    event === "github_app_authorization"
  ) {
    const installationId = payload.installation?.id
    // ARC-238 (Codex v1 B6): uninstall + repos-removed delete fires
    // REGARDLESS of `OPENCLAW_INDEXER_ENABLED`. If the operator turns
    // the indexer off for cost reasons, prior customer data must
    // still be deletable on uninstall (GDPR / SOC 2).
    if (event === "installation_repositories" && payload.action === "removed" && typeof installationId === "number") {
      const removed = payload.repositories_removed ?? []
      try {
        const { results, anyError } = await handleInstallReposRemoved({
          env,
          installationId,
          repositories: removed,
        })
        if (anyError) {
          console.error(
            JSON.stringify({
              event: "index-delete-fanout-partial",
              installation_id: installationId,
              reason: "install-repos-removed",
              count: results.length,
            }),
          )
          return new Response("delete fanout partial\n", { status: 503 })
        }
        return new Response("repos-removed deleted\n", { status: 202 })
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "index-delete-fanout-threw",
            installation_id: installationId,
            reason: "install-repos-removed",
            err: err instanceof Error ? err.message : String(err),
          }),
        )
        return new Response("delete fanout threw\n", { status: 503 })
      }
    }
    if (event === "installation" && payload.action === "deleted" && typeof installationId === "number") {
      const ownerLogin = payload.installation?.account?.login
      if (typeof ownerLogin !== "string" || ownerLogin.length === 0) {
        // No account.login means we can't disambiguate which repos to
        // delete. Log + return 200 so GitHub doesn't redeliver — there's
        // no actionable retry from our side.
        console.error(
          JSON.stringify({
            event: "index-delete-missing-account-login",
            installation_id: installationId,
          }),
        )
        return new Response("missing account.login\n", { status: 200 })
      }
      try {
        const { results, anyError } = await handleInstallationDeleted({
          env,
          installationId,
          ownerLogin,
          // code-reviewer HIGH-1: GitHub ships `repositories[]` on
          // `installation.deleted`. Use it as the authoritative
          // discovery source so we clean up indexer-disabled installs
          // (no repo-index-manifest to find) too. KV scan still runs
          // as a backup for orphans.
          ...(Array.isArray(payload.repositories) ? { repositoriesFromPayload: payload.repositories } : {}),
        })
        if (anyError) {
          console.error(
            JSON.stringify({
              event: "index-delete-fanout-partial",
              installation_id: installationId,
              reason: "install-deleted",
              count: results.length,
            }),
          )
          return new Response("delete fanout partial\n", { status: 503 })
        }
        return new Response("installation deleted\n", { status: 202 })
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "index-delete-fanout-threw",
            installation_id: installationId,
            reason: "install-deleted",
            err: err instanceof Error ? err.message : String(err),
          }),
        )
        return new Response("delete fanout threw\n", { status: 503 })
      }
    }

    if (
      isIndexerEnabled(env) &&
      typeof installationId === "number" &&
      ((event === "installation" && payload.action === "created") ||
        (event === "installation_repositories" && payload.action === "added"))
    ) {
      const repositories = event === "installation" ? (payload.repositories ?? []) : (payload.repositories_added ?? [])
      const reason: IndexJobReason = event === "installation" ? "install" : "install-repos-added"
      try {
        const result = await enqueueIndexJobsForRepos({
          env,
          installationId,
          repositories,
          reason,
        })
        // Codex v2 N5: when EVERY non-sensitive enqueue failed (e.g.
        // the OPENCLAW_JOBS binding is broken), surface 503 so GitHub
        // redelivers. Partial successes return 202 — per-repo failures
        // are already logged and redelivery would double-enqueue the
        // successful ones.
        //
        // CodeRabbit catch on PR #76: subtract `sensitiveSkipped` from
        // the denominator. An install where every repo is on the
        // sensitive denylist has `attempted > 0 && succeeded === 0`
        // but is NOT a fanout failure — it's a deliberate no-op, and
        // 503'ing would trigger an infinite GitHub redelivery loop
        // (each redelivery would hit the same denylist and 503 again).
        const nonSensitiveAttempts = result.attempted - result.sensitiveSkipped
        if (nonSensitiveAttempts > 0 && result.succeeded === 0) {
          console.error(
            JSON.stringify({
              event: "index-job-fanout-total-failure",
              installation_id: installationId,
              attempted: result.attempted,
              per_repo_failed: result.perRepoFailed,
              sensitive_skipped: result.sensitiveSkipped,
              reason,
            }),
          )
          return new Response("index fanout failed\n", { status: 503 })
        }
        console.log(
          JSON.stringify({
            event: "index-job-fanout-done",
            installation_id: installationId,
            reason,
            ...result,
          }),
        )
        // SIG-44: alongside code indexing, enqueue a 90-day merged-PR
        // backfill per repo so the pr: corpus is populated on onboarding.
        // Best-effort + fully isolated: a failure here never changes the
        // index-fanout response (GitHub redelivery would re-run the code
        // index, which is the load-bearing path). Flag-gated.
        if (multiCorpusEnabled(env)) {
          for (const r of repositories) {
            const fullName = typeof r?.full_name === "string" ? r.full_name : ""
            const [bOwner, bRepo] = fullName.split("/")
            if (!bOwner || !bRepo) continue
            try {
              await env.OPENCLAW_JOBS.send({
                type: "corpus-pr-backfill",
                owner: bOwner,
                repo: bRepo,
                installationId,
              })
            } catch (err) {
              console.warn(
                JSON.stringify({
                  event: "corpus-pr-backfill-enqueue-failed",
                  owner: bOwner,
                  repo: bRepo,
                  err: err instanceof Error ? err.message : String(err),
                }),
              )
            }
          }
        }
        return new Response("indexed\n", { status: 202 })
      } catch (err) {
        // Defensive: enqueueIndexJobsForRepos has per-repo try/catch
        // internally so this branch is for unexpected throws (env
        // shape mismatch, etc.). Surface 503 so GitHub redelivers.
        console.error(
          JSON.stringify({
            event: "index-job-fanout-threw",
            installation_id: installationId,
            reason,
            err: err instanceof Error ? err.message : String(err),
          }),
        )
        return new Response("index fanout threw\n", { status: 503 })
      }
    }
    return new Response("app-level event ignored\n", { status: 200 })
  }

  const installationId = payload.installation?.id
  const owner = payload.repository?.owner?.login
  const repo = payload.repository?.name
  if (!installationId || !owner || !repo) {
    return new Response("missing installation / repo\n", { status: 400 })
  }

  if (event === "pull_request") {
    const action = payload.action
    const pr = payload.pull_request
    if (!pr || typeof pr.number !== "number") {
      return new Response("missing pr\n", { status: 400 })
    }
    const headRepoFullName = pr.head?.repo?.full_name
    const headIsSameRepo =
      typeof headRepoFullName === "string" && headRepoFullName.toLowerCase() === `${owner}/${repo}`.toLowerCase()
    if (headIsSameRepo) {
      ctx.waitUntil(
        maybeEnqueuePullRequestBranchIndexJobs({
          env,
          owner,
          repo,
          installationId,
          action,
          draft: pr.draft,
          headRef: pr.head?.ref,
          baseRef: pr.base?.ref,
          merged: pr.merged,
        }).catch((err) => {
          console.warn(
            JSON.stringify({
              event: "index-pr-branch-enqueue-failed",
              owner,
              repo,
              prNumber: pr.number,
              action,
              err: err instanceof Error ? err.message : String(err),
            }),
          )
        }),
      )
    } else {
      console.log(
        JSON.stringify({
          event: "index-pr-branch-skip-fork",
          owner,
          repo,
          prNumber: pr.number,
          head_repo: headRepoFullName,
        }),
      )
    }
    // SIG-44: a merged PR refreshes the pr: multi-corpus namespace with its
    // title/body + derived verdict. Placed BEFORE the draft/skip returns
    // below (a closed PR otherwise short-circuits at decidePullRequestJobs).
    // Fire-and-forget via waitUntil; flag-gated; never blocks the ack.
    if (multiCorpusEnabled(env) && action === "closed" && pr.merged === true) {
      ctx.waitUntil(
        env.OPENCLAW_JOBS.send({
          type: "corpus-pr-upsert",
          owner,
          repo,
          prNumber: pr.number,
          title: typeof pr.title === "string" ? pr.title : "",
          body: typeof pr.body === "string" ? pr.body : "",
        }).catch((err) => {
          console.warn(
            JSON.stringify({
              event: "corpus-pr-upsert-enqueue-failed",
              owner,
              repo,
              prNumber: pr.number,
              err: err instanceof Error ? err.message : String(err),
            }),
          )
        }),
      )
    }
    if (pr.draft) {
      const headSha = pr.head?.sha ?? ""
      const supportedDraftActions = new Set(["opened", "synchronize", "reopened", "converted_to_draft"])
      if (headSha && supportedDraftActions.has(action ?? "")) {
        try {
          const token = await getInstallationToken({
            kv: env.OPENCLAW_STATE,
            appId: env.GITHUB_APP_ID,
            privateKey: env.GITHUB_PRIVATE_KEY,
            installationId,
          })
          const client = new GitHubClient({ token })
          await postDraftPrSkipNotice({
            env,
            client,
            owner,
            repo,
            prNumber: pr.number,
            headSha,
          })
        } catch (err) {
          console.warn(
            JSON.stringify({
              event: "pr-draft-skip-notice-auth-failed",
              owner,
              repo,
              prNumber: pr.number,
              headSha: headSha.slice(0, 7),
              err: err instanceof Error ? err.message : String(err),
            }),
          )
        }
      }
      return new Response("skip draft\n", { status: 200 })
    }
    const decideArgs: Parameters<typeof decidePullRequestJobs>[0] = {
      action: action ?? "",
      draft: false,
      prBody: pr.body,
      skipReleasePromotions: env.OPENCLAW_PR_REVIEW_SKIP_RELEASE_BRANCHES === "on",
    }
    if (pr.base?.ref) decideArgs.baseRef = pr.base.ref
    if (pr.head?.ref) decideArgs.headRef = pr.head.ref
    const decision = decidePullRequestJobs(decideArgs)
    // SIG-437: `@sigilix summary` gate + best-effort enqueue (default-off →
    // no-op), BEFORE the overview/review early return so a summary-only edit fires.
    maybeEnqueuePrSummary({ env, ctx, action, owner, repo, installationId, pr })
    if (!decision.overview && !decision.review) {
      return new Response("skip pr action\n", { status: 200 })
    }
    const prNumber = pr.number
    const headSha = pr.head?.sha ?? ""
    if (!headSha) return new Response("missing head sha\n", { status: 400 })

    // SIG-219 restoration of the pre-review "Reviewing…" sticky:
    //
    // SIG-216 originally dropped the stub-post entirely under the
    // theory that the inline overview render inside the ensemble
    // (immediately before `submitReview`) would land both comments
    // in the same time window — CodeRabbit-style Walkthrough +
    // Review.
    //
    // Founder feedback (2026-05-26): the WANTED UX is closer to
    // CodeRabbit's actual behavior — a sticky "Reviewing…" comment
    // appears immediately on push and MORPHS into the overview when
    // the models finish, rather than appearing only at the end.
    // SIG-216 lost that "reviewing" affordance entirely. Restore
    // the stub-post here so:
    //
    //   1. The "Reviewing…" sticky lands within the webhook ack
    //      window (~sub-second).
    //   2. The inline overview path inside `handlePrReviewEnsemble`
    //      finds the stub via its existing `scanComments` + PATCH
    //      logic and rewrites the body in place — no second
    //      comment is created, no ordering wait is needed.
    //   3. The SIG-216 win (no separate `pr-overview` queue job
    //      stretching wall-clock by ~30s) is preserved: we only
    //      dispatch the standalone pr-overview job for the
    //      review-skipped branch below, exactly as before.
    //
    // We still load sigilix.json + build the GitHub client here for
    // the `ready_for_review` draft-skip supersede call below, the
    // stub-post itself, and future webhook-time gates. Best-effort:
    // `loadSigilixConfig` never throws — missing/invalid config
    // resolves to `EMPTY_CONFIG`, which has `overview === undefined`,
    // which `isPrOverviewEnabled` treats as enabled (default-on per
    // Codex Q5). The pr-review ensemble re-loads the config at the
    // head SHA itself, so a failure here is non-blocking.
    let webhookSigilixConfig: Awaited<ReturnType<typeof loadSigilixConfig>> | null = null
    let webhookClient: GitHubClient | null = null
    if (decision.overview || decision.review) {
      try {
        const token = await getInstallationToken({
          kv: env.OPENCLAW_STATE,
          appId: env.GITHUB_APP_ID,
          privateKey: env.GITHUB_PRIVATE_KEY,
          installationId,
        })
        webhookClient = new GitHubClient({ token })
        webhookSigilixConfig = await loadSigilixConfig(webhookClient, owner, repo, headSha)
      } catch (err) {
        // Auth + config-load failures here are non-blocking: the
        // ensemble re-loads config at the head SHA and gates the
        // inline overview render itself; the draft-skip supersede
        // is best-effort.
        console.warn(
          JSON.stringify({
            event: "pr-overview-webhook-config-load-failed",
            owner,
            repo,
            prNumber,
            head_sha: headSha.slice(0, 7),
            err: err instanceof Error ? err.message : String(err),
          }),
        )
      }
    }
    const overviewEnabled = isPrOverviewEnabled(webhookSigilixConfig)

    if (action === "ready_for_review" && webhookClient !== null) {
      try {
        await supersedeDraftPrSkipNotice({
          client: webhookClient,
          owner,
          repo,
          prNumber,
          headSha,
        })
      } catch (err) {
        console.warn(
          JSON.stringify({
            event: "pr-draft-skip-notice-supersede-unexpected-failed",
            owner,
            repo,
            prNumber,
            headSha: headSha.slice(0, 7),
            err: err instanceof Error ? err.message : String(err),
          }),
        )
      }
    }

    if (decision.overview && !overviewEnabled) {
      // SIG-216: customer opted out of pr-overview via
      // `sigilix.overview.enabled = false`. The ensemble's inline
      // overview render is gated on the same flag — log here so the
      // disable signal stays visible at webhook time.
      //
      // SIG-90: pr-labels is ENQUEUED INDEPENDENTLY below (founder
      // direction "labels should exist"). It is NOT gated by
      // overview.enabled.
      console.log(
        JSON.stringify({
          event: "pr-overview-skipped-disabled",
          owner,
          repo,
          prNumber,
          head_sha: headSha.slice(0, 7),
        }),
      )
    }
    // ARC-265 + SIG-90: auto-label picker fires alongside pr-overview
    // (same webhook events: opened / synchronize / reopened /
    // ready_for_review). Independent of `overview.enabled` per
    // founder direction — labels are a separate product capability
    // and should be available even when overview is opted out.
    // The handler short-circuits only if `labels.enabled:false`.
    if (decision.overview) {
      await env.OPENCLAW_JOBS.send({
        type: "pr-labels",
        owner,
        repo,
        prNumber,
        headSha,
        installationId,
      })
    }
    // SIG-216 + this fix-up — overview normally runs inline inside the
    // review handler (drop-the-stub pattern: the two comments land in
    // the same window). But when the review is skipped
    // (`decision.overview && !decision.review`, e.g. release-branch
    // gate via OPENCLAW_PR_REVIEW_SKIP_RELEASE_BRANCHES), the ensemble
    // never fires, so the inline overview never lands. Restore the
    // legacy standalone `pr-overview` queue dispatch for that branch
    // ONLY — when both decisions are true, the inline path remains
    // the single source of truth.
    //
    // Skipped when the config disables overview (`overviewEnabled`
    // is the result of `isPrOverviewEnabled` against the head-SHA
    // config loaded above). The corresponding telemetry event
    // `pr-overview-skipped-disabled` already fired up the file.
    if (decision.overview && !decision.review && overviewEnabled) {
      await env.OPENCLAW_JOBS.send({
        type: "pr-overview",
        owner,
        repo,
        prNumber,
        headSha,
        installationId,
      })
    }
    // pr-review fires on `opened`, `ready_for_review`, AND `synchronize`
    // so the bot keeps verifying after each fix push (and can flip to
    // APPROVE when the diff is clean). The consumer carries a per-
    // (prNumber, headSha) dedupe key + a stale-head guard, so retries
    // and out-of-order delivery don't produce duplicate or wrong-diff
    // reviews. `ready_for_review` catches drafts that were skipped on
    // `opened`. See decidePullRequestJobs() for the gating contract.
    if (decision.review) {
      const baseSha: string | null = pr.base?.sha ?? null
      // SIG-89: skip pr-review dispatch on byte-identical `synchronize`
      // pushes (Update-branch button, rebase-on-main no-op force push,
      // empty commit, merge-from-main without resolution drift). The
      // prior review still applies — re-running the ensemble would
      // burn budget + post a redundant timeline entry. CodeRabbit
      // demonstrates this UX; SIG-89 brings Sigilix to parity.
      //
      // First-review pushes (no prior hash stashed) and `opened` /
      // `reopened` / `ready_for_review` actions are unaffected — only
      // `synchronize` triggers the diff-hash compare. The pr-overview
      // path above is intentionally unaffected.
      //
      // Best-effort: any failure (KV miss, diff-fetch error, hash
      // mismatch) falls through to the existing dispatch path so the
      // worst case is a wasted review run, never a missed review.
      //
      // Kill-switch: set `OPENCLAW_NOOP_MERGE_SKIP_ENABLED=off` to
      // disable the entire compare path without redeploying — useful
      // if the diff-fetch latency tax or a false-skip regression
      // surfaces in prod. `webhookClient` is non-null whenever
      // decision.overview or decision.review is true and auth
      // succeeded above (line 1531-1552); we check it here so the
      // fall-through-on-auth-failure path stays safe.
      //
      // Diff fetch is capped at 2s via `AbortSignal.timeout(2000)`
      // so a slow GitHub response can't stall the webhook past
      // GitHub's ~10s redelivery threshold. On timeout/abort the
      // catch falls through to the normal dispatch path (fail-open).
      let skipNoopMerge = false
      if (env.OPENCLAW_NOOP_MERGE_SKIP_ENABLED !== "off" && action === "synchronize" && webhookClient !== null) {
        try {
          const prior = await readPriorReviewDiffHash(env, owner, repo, prNumber)
          if (prior !== null) {
            const currentDiff = await webhookClient.getPullRequestDiff(owner, repo, prNumber, {
              signal: AbortSignal.timeout(2000),
            })
            const currentHash = await computeDiffHash(currentDiff)
            if (currentHash === prior.diffHash) {
              skipNoopMerge = true
              console.log(
                JSON.stringify({
                  event: "pr-review-skipped-noop-merge",
                  owner,
                  repo,
                  prNumber,
                  priorHeadSha: prior.reviewedHeadSha,
                  newHeadSha: headSha,
                  diffHashSha7: currentHash.slice(0, 7),
                }),
              )
            }
          }
        } catch (err) {
          console.warn(
            JSON.stringify({
              event: "pr-review-noop-merge-detect-failed",
              owner,
              repo,
              prNumber,
              err: err instanceof Error ? err.message : String(err),
            }),
          )
        }
      }
      if (skipNoopMerge) {
        return new Response("queued\n", { status: 202 })
      }
      // SIG-219: post the "Reviewing…" sticky in the background so it
      // lands on the PR timeline within ~1s of the webhook ack
      // without blocking the ack itself. The inline overview path
      // inside `handlePrReviewEnsemble` will find the marker comment
      // via its `scanComments` + PATCH logic when the ensemble
      // completes (minutes later) and morph the body in place — no
      // second comment is created, no ordering barrier is required.
      //
      // Sigilix bot P2 PERF catch on PR #180: the original
      // implementation was `await postPrOverviewStubIfNeeded(...)`
      // on the webhook response path. That call does 2–4 sequential
      // network round-trips (KV idempotency read, GitHub
      // `listComments` marker scan, GitHub POST on first delivery,
      // KV flag write) for ~400–1500ms typical and multi-second
      // under API spikes. The repo's perf rules target ~50ms for the
      // webhook ack — `ctx.waitUntil` lets the work continue after
      // the 202 returns. There's no race with the inline overview's
      // own `scanComments`: the review handler doesn't run that
      // scan until after specialist fan-out + synth (minutes), long
      // after the stub-post has landed.
      //
      // Placement: AFTER the noop-merge skip-short-circuit (so a
      // diff-identical synchronize push doesn't flash an orphan
      // "Reviewing…" sticky that never updates), BEFORE the queue
      // enqueue (so the stub-post is queued first; ordering doesn't
      // matter for correctness but reads better in logs).
      //
      // Best-effort throughout: `postPrOverviewStubIfNeeded` returns
      // a structured outcome but never throws. The KV flag + marker
      // scan make a second webhook delivery for the same
      // (owner, repo, prNumber, headSha) idempotent — webhook
      // redelivery, an internal 5xx with retry, and rapid double
      // pushes all converge on a single sticky.
      //
      // Gates:
      //   - `overviewEnabled` — opt-out customers don't get a stub.
      //   - `webhookClient !== null` — auth succeeded; otherwise
      //     skip the stub-post and let the inline overview path
      //     POST a fresh comment from scratch when the ensemble
      //     runs.
      if (overviewEnabled && webhookClient !== null) {
        ctx.waitUntil(
          postPrOverviewStubIfNeeded({
            env,
            owner,
            repo,
            prNumber,
            headSha,
            installationId,
            client: webhookClient,
          })
            .then((stubOutcome) => {
              console.log(
                JSON.stringify({
                  event: "pr-overview-stub-outcome",
                  owner,
                  repo,
                  prNumber,
                  head_sha: headSha.slice(0, 7),
                  outcome: stubOutcome.kind,
                  ...("commentId" in stubOutcome ? { comment_id: stubOutcome.commentId } : {}),
                  ...("reason" in stubOutcome ? { reason: stubOutcome.reason } : {}),
                  ...("phase" in stubOutcome ? { phase: stubOutcome.phase } : {}),
                }),
              )
            })
            .catch((err) => {
              // `postPrOverviewStubIfNeeded` is structured-outcome
              // (never throws), but the `.then` callback above could
              // technically throw (JSON.stringify on a circular object,
              // etc.). Catch + log so a deferred error can't propagate
              // up to the runtime and surface as an unhandled rejection.
              console.warn(
                JSON.stringify({
                  event: "pr-overview-stub-deferred-failed",
                  owner,
                  repo,
                  prNumber,
                  head_sha: headSha.slice(0, 7),
                  err: err instanceof Error ? err.message : String(err),
                }),
              )
            }),
        )
      }
      // SIG-174: automatic webhook reviews always route through the
      // DO-backed post path. Awaited (NOT ctx.waitUntil) so a DO
      // failure surfaces as 503 to GitHub for redelivery.
      //
      // SIG-247 Phase 1: extract the immutable repo.id from the
      // webhook payload with the same positive-integer guard the
      // push-indexer uses (line 2827-2832). Threads through to
      // RunState + JobMessage so the consumer's review-memory lookup
      // hits the dual-write keyspace.
      const prReviewRepoId =
        typeof payload.repository?.id === "number" &&
        Number.isInteger(payload.repository.id) &&
        payload.repository.id > 0
          ? payload.repository.id
          : undefined
      // SIG-374: webhook-arrival anchor for the queue-wait decomposition.
      // Joins do-review-enqueued (same deliveryId) so the monitor can
      // split webhook→enqueue from enqueue→pickup. Emitted only on the
      // pr-review enqueue path — not per webhook delivery.
      console.log(
        JSON.stringify({
          event: "pr-review-webhook-arrived",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          deliveryId: request.headers.get("x-github-delivery"),
          arrivedAtMs: Date.now(),
        }),
      )
      const enq = await enqueuePrReviewJob(env, {
        owner,
        repo,
        prNumber,
        headSha,
        baseSha,
        installationId,
        deliveryId: request.headers.get("x-github-delivery"),
        ...(prReviewRepoId !== undefined ? { repoId: prReviewRepoId } : {}),
      })
      if (!enq.ok) {
        return new Response("do enqueue failed\n", { status: 503 })
      }
      // ARC-184: when the action is `synchronize` or `edited` AND a
      // prior review-manifest exists, enqueue a parallel `pr-stale-mark`
      // job. The stale-mark consumer detects drift and PATCHes the
      // prior review's body with a stale notice — this gives the user
      // an immediate "old verdict no longer applies" signal while the
      // fresh review is in flight (~30-90s).
      //
      // No manifest = no prior review to mark stale (first-review or
      // pre-ARC-184 PR). Skip silently. Kill-switch via
      // OPENCLAW_REVIEW_MANIFEST_ENABLED=off short-circuits both the
      // KV read and the enqueue.
      if (
        env.OPENCLAW_REVIEW_MANIFEST_ENABLED !== "off" &&
        (action === "synchronize" || action === "edited") &&
        baseSha
      ) {
        try {
          const result = await readReviewManifest(env, owner, repo, prNumber)
          if (result.kind === "ok") {
            await env.OPENCLAW_JOBS.send({
              type: "pr-stale-mark",
              owner,
              repo,
              prNumber,
              installationId,
              manifestSnapshot: result.manifest,
              newHeadSha: headSha,
              newBaseSha: baseSha,
              currentPromptVersion: PROMPT_VERSION,
            })
          }
        } catch (err) {
          console.error(
            JSON.stringify({
              event: "pr-stale-mark-enqueue-failed",
              err: err instanceof Error ? err.message : String(err),
              owner,
              repo,
              prNumber,
            }),
          )
        }
      }
    }
    return new Response("queued\n", { status: 202 })
  }

  if (event === "workflow_run") {
    return handleWorkflowRunEvent({ env, payload, owner, repo, installationId })
  }

  if (event === "pull_request_review_thread") {
    return handleReviewThreadAutoApproveWebhook({
      env,
      ctx,
      payload,
      owner,
      repo,
      installationId,
    })
  }

  // GitHub @-mention reply — top-level PR conversation thread.
  // `issue_comment` fires for both issues and PR conversation comments;
  // we only care when the issue is actually a PR (`issue.pull_request`
  // is present) and the body @-mentions Sigilix.
  if (event === "issue_comment") {
    if (payload.action !== "created") {
      return new Response("skip issue_comment action\n", { status: 200 })
    }
    if (!payload.issue?.pull_request) {
      return new Response("skip non-PR issue_comment\n", { status: 200 })
    }
    maybeScheduleAutoApproveFromIssueComment({ env, ctx, payload, owner, repo, installationId })
    const reviewMemoryComment = payload.comment
    const reviewMemoryPrNumber = payload.issue.number
    if (
      reviewMemoryComment &&
      typeof reviewMemoryComment.id === "number" &&
      typeof reviewMemoryComment.body === "string" &&
      typeof reviewMemoryComment.user?.login === "string" &&
      typeof reviewMemoryPrNumber === "number" &&
      hasExplicitTopLevelReviewFeedbackSignal(reviewMemoryComment.body)
    ) {
      const reviewMemoryRepoId =
        typeof payload.repository?.id === "number" &&
        Number.isInteger(payload.repository.id) &&
        payload.repository.id > 0
          ? payload.repository.id
          : undefined
      ctx.waitUntil(
        dispatchTopLevelReviewMemoryCapture({
          env,
          owner,
          repo,
          prNumber: reviewMemoryPrNumber,
          installationId,
          comment: {
            id: reviewMemoryComment.id,
            body: reviewMemoryComment.body,
            authorLogin: reviewMemoryComment.user.login,
          },
          ...(reviewMemoryRepoId !== undefined ? { repoId: reviewMemoryRepoId } : {}),
        }),
      )
    }
    return queueGithubMention({
      env,
      ctx,
      payload,
      owner,
      repo,
      installationId,
      surface: "issue",
      prNumber: payload.issue.number,
    })
  }

  // SIG-185: formal review dismissal. Treat as a stale precision signal only
  // when the dismissed Sigilix review is mappable to finding fingerprints and
  // was posted against an older commit than the current PR head.
  if (event === "pull_request_review") {
    if (payload.action !== "dismissed") {
      return new Response("skip pull_request_review action\n", { status: 200 })
    }
    const reviewMemoryReview = payload.review
    const reviewMemoryPrNumber = payload.pull_request?.number
    const headSha = payload.pull_request?.head?.sha
    if (
      !reviewMemoryReview ||
      typeof reviewMemoryReview.id !== "number" ||
      typeof reviewMemoryReview.body !== "string" ||
      typeof reviewMemoryPrNumber !== "number" ||
      !hasStaleDismissedReviewFeedbackSignal(reviewMemoryReview, headSha)
    ) {
      return new Response("skip review dismissal capture\n", { status: 200 })
    }
    const staleCommitId = reviewMemoryReview.commit_id
    const sigilixLogin = reviewMemoryReview.user?.login
    if (typeof headSha !== "string" || typeof staleCommitId !== "string" || typeof sigilixLogin !== "string") {
      return new Response("skip review dismissal capture\n", { status: 200 })
    }
    ctx.waitUntil(
      dispatchDismissedReviewMemoryCapture({
        env,
        owner,
        repo,
        prNumber: reviewMemoryPrNumber,
        installationId,
        review: {
          id: reviewMemoryReview.id,
          body: reviewMemoryReview.body,
          commit_id: staleCommitId,
          user: { login: sigilixLogin },
        },
        headSha,
      }),
    )
    return new Response("queued review dismissal capture\n", { status: 202 })
  }

  // GitHub @-mention reply — inline PR review comment thread.
  if (event === "pull_request_review_comment") {
    if (payload.action !== "created") {
      return new Response("skip review_comment action\n", { status: 200 })
    }
    maybeScheduleAutoApproveFromReviewComment({ env, ctx, payload, owner, repo, installationId })

    // ARC-189: cross-PR review-memory capture. Fires alongside (NOT in
    // place of) the existing mention-trigger pipeline. Runs in
    // ctx.waitUntil(...) so KV reads + GH API parent fetch never
    // block the webhook response. The capture pipeline does its own
    // gate-check (env CAPTURE on AND sigilix.json enabled||captureOnly)
    // and best-effort error swallowing — failure here cannot affect
    // the queueGithubMention path.
    const reviewMemoryComment = payload.comment
    const reviewMemoryPrNumber = payload.pull_request?.number
    if (
      reviewMemoryComment &&
      typeof reviewMemoryComment.id === "number" &&
      typeof reviewMemoryComment.body === "string" &&
      typeof reviewMemoryComment.path === "string" &&
      typeof reviewMemoryPrNumber === "number"
    ) {
      // SIG-247 Phase 1: capture the immutable repo ID from the webhook
      // payload so review-memory writes land at both the legacy and
      // repo-id keyspaces. Mirrors the push-indexer guard at
      // line 2827-2832 — strictly positive integers only; any spoofed
      // or malformed payload falls back to legacy-only via
      // `captureReviewFeedback`'s `getRepository` fallback.
      const reviewMemoryRepoId =
        typeof payload.repository?.id === "number" &&
        Number.isInteger(payload.repository.id) &&
        payload.repository.id > 0
          ? payload.repository.id
          : undefined
      ctx.waitUntil(
        dispatchReviewMemoryCapture({
          env,
          owner,
          repo,
          prNumber: reviewMemoryPrNumber,
          installationId,
          comment: {
            id: reviewMemoryComment.id,
            body: reviewMemoryComment.body,
            path: reviewMemoryComment.path,
            ...(typeof reviewMemoryComment.user?.login === "string"
              ? { authorLogin: reviewMemoryComment.user.login }
              : {}),
            ...(typeof reviewMemoryComment.in_reply_to_id === "number"
              ? { in_reply_to_id: reviewMemoryComment.in_reply_to_id }
              : {}),
          },
          ...(reviewMemoryRepoId !== undefined ? { repoId: reviewMemoryRepoId } : {}),
        }),
      )
    }

    return queueGithubMention({
      env,
      ctx,
      payload,
      owner,
      repo,
      installationId,
      surface: "review-comment",
      prNumber: payload.pull_request?.number,
    })
  }

  // ARC-237 / SIG-35: push-driven re-index. Fires on every push to a branch ref.
  // SIG-366: the sub-handler body lives in `handlePushEvent` (index-internals); the
  // entry router just dispatches to it.
  if (event === "push") {
    return handlePushEvent({ env, owner, repo, installationId, payload })
  }

  return new Response("skipped\n", { status: 200 })
}
