// SIG-318 (PR 12f) — the PUBLISH phase of the PR-review orchestrator (app layer):
// the highest-care exit topology of the ensemble. Carved verbatim from
// `handlePrReviewEnsemble`, from AFTER the verify-and-build call site through the
// submit `finally`:
//   - the inline PR-overview render (SIG-216) — budget math + the single-retry
//     `runInlineOverviewWithRetry` helper (god-file-private, moved in verbatim;
//     it laterally calls `handlePrOverview` from `../../triage-pr-overview`);
//   - the post-overview stale-head guard (#3) — re-check HEAD before the submit;
//   - the pre-submit `dismissPriorSigilixReviews` (its own best-effort try/catch);
//   - the submit + 4-level fallback ladder (the inner try/catch/finally moved
//     WHOLE — the `emitPhaseCompleted("submit")` in its inner finally intact; the
//     inline-anchored → comment-fallback / 422 → anchorless → comment-fallback
//     control flow byte-identical). The TWO rethrows (`throw submitErr` /
//     `throw fallbackSubmitErr`) propagate OUT of `publish()` to the
//     orchestrator's outer catch — publish adds NO catch of its own;
//   - the post-submit persistence (`writeReviewManifestForEnsemble` via the
//     adapter, `writeLastReviewedSha`, `recordReviewedDiffHash`,
//     `maybePostAstAutoInline`), per submit path.
//
// Every terminal path ends in `finalize(...)`, so `publish()` returns the
// orchestrator's `EnsembleResult` directly (no exit-union). It is generic over the
// telemetry type `Tel` (the session-module precedent) so the returned
// `EnsembleResult<Tel>` is the concrete public shape at the call site, without
// this module naming the ~310-line god-file-private `EnsembleTelemetry`.
//
// The moved statements are byte-identical (only `args.repoId` is destructured to
// `repoId`); the wrapper + the explicit arg/result plumbing is new. ZERO behavior
// change. The two count helpers (`countBySeverity` / `countByCategory`, both
// god-file-private, used only by the inline-overview reviewContext) move in too.
//
// Dependency rule: every dependency imports from its canonical NON-god-file home —
// the github leaf (`GitHubClient`/`GitHubHttpError`, `CheckRunAnnotation`, `Env`),
// the render leaf (`buildFallbackSubmission`/`previewFallbackSubmissionEvent`,
// `selectPrimarySubmitAnnotations`), the verdict domain (`ReviewEvent`,
// `severityTier`), the persistence + review-sink adapters, the affordances app
// module, the session app module (`finalize` + the result contract), and the lib
// leaves (overview / stale-head / dismiss / fallback / counter / noop-merge / SLO
// + perf telemetry). It never imports the orchestrator god-file.

import type { Env } from "@/src/shared/types/env"
import type { CheckRunAnnotation } from "@/src/shared/types/github"
import type { PullRequestMeta } from "@/src/shared/types/github"
import { GitHubClient, GitHubHttpError } from "@/src/shared/adapters/github"
import type { PrReviewVerdict, PrReviewFinding, CoverageRoles } from "@/src/shared/domain/pr-review-finding"
import type { ReviewManifestFinding } from "@/src/lib/review-manifest"
import { type ReviewEvent, type ReviewEventOverride } from "@/src/lib/ensemble/domain/verdict"
import type { EnsembleConfig } from "@/src/lib/ensemble/domain/config"
import type { StackContext } from "@/src/lib/pr-stack"
import { isPrOverviewEnabled, type SigilixConfig } from "@/src/lib/sigilix-config"
import { type PrOverviewReviewContext } from "@/src/lib/triage-pr-overview"
import { handleStaleHead } from "@/src/lib/stale-head"
import { dismissPriorSigilixReviews } from "@/src/lib/dismiss-prior-reviews"
import { postReviewCommentFallback } from "@/src/lib/review-comment-fallback"
import { buildFallbackSubmission } from "@/src/lib/ensemble/render/fallback"
import { previewFallbackSubmissionEvent } from "@/src/lib/ensemble/render/submission"
import type { DeltaBadgeCounts } from "@/src/lib/ensemble/render/review-body"
import { selectPrimarySubmitAnnotations } from "@/src/lib/pr-review-check-run"
import { writeLastReviewedSha } from "@/src/lib/incremental-review"
import { recordReviewedDiffHash } from "@/src/lib/noop-merge-detect"
import type { createRetrievalCache } from "@/src/lib/retrieval-cache"
import { writeReviewManifestForEnsemble } from "@/src/lib/ensemble/adapters/persistence"
import { verifyReviewPersisted } from "@/src/lib/ensemble/adapters/review-sink"
import { ORCHESTRATOR_TIMEOUT_MS } from "@/src/lib/ensemble/domain/budget"
import { emitPhaseCompleted, type EnsembleRunCtx } from "@/src/lib/ensemble-perf-telemetry"
import { withSubmissionAffordance, buildSuggestionEmissionLogEvents, type SubmissionAffordance } from "./affordances"
import { finalize, type EnsembleResult, type FinalizeTelemetry, type ReviewMeta } from "./session"
import { runInlineOverviewWithRetry, countBySeverity, countByCategory } from "./publish-helpers"

// SIG-216: the inline-overview budget thresholds — the min remaining budget to
// attempt the inline render, the max budget to spend on it, and the reserve held
// back for the submitReview roundtrip + the post-overview stale-head re-check.
export const INLINE_OVERVIEW_MIN_BUDGET_MS = 30_000
export const INLINE_OVERVIEW_MAX_BUDGET_MS = 90_000
const INLINE_OVERVIEW_SUBMIT_RESERVE_MS = 30_000

/**
 * The telemetry slice the publish phase reads + WRITES (by reference on the
 * orchestrator's object): the `finalize` inputs plus the submit-path fields
 * (`fellBackReason`, `submitted`, the 422-fallback signals). The orchestrator's
 * full `EnsembleTelemetry` satisfies this, so `Tel` infers to it at the call site.
 */
export interface PublishTelemetry extends FinalizeTelemetry {
  fellBackReason?: string
  fellBackToPhase3: boolean
  submitted?: boolean
  submitFallback?: boolean
  submitFallbackReason?: string
}

export interface PublishArgs<Tel extends PublishTelemetry> {
  env: Env
  owner: string
  repo: string
  prNumber: number
  headSha: string
  installationId: number
  /** ARC-251: prior stale-head requeue depth, forwarded to the post-overview guard. */
  staleHeadRequeueDepth: number
  /** SIG-184: bound to the runner-receipt `(repoId, prNumber)` join when present. */
  repoId: number | undefined
  client: GitHubClient
  sigilixConfig: SigilixConfig
  meta: PullRequestMeta
  /** ARC-284 correlation context for the submit phase event. */
  perfCtx: EnsembleRunCtx
  /** Mutated by reference: the submit-path telemetry writes land on this object. */
  telemetry: Tel
  /** Handler entry timestamp — the inline-overview budget + the SLO time-to-first-overview anchor. */
  startMs: number
  cache: ReturnType<typeof createRetrievalCache> | null
  /** The full PR diff — hashed for the noop-merge skip on the next synchronize. */
  fullPrDiff: string
  stack: StackContext
  coverage: CoverageRoles
  deltaCounts: DeltaBadgeCounts | null
  filesDroppedFromReview: string[]
  currentFindingsForManifest: ReviewManifestFinding[]
  /** SIG-375: the parsed `OPENCLAW_REVIEW_MANIFEST_ENABLED !== "off"` kill-switch,
   *  threaded from `EnsembleConfig.flags` so the manifest write no longer reads env. */
  reviewManifestEnabled: EnsembleConfig["flags"]["reviewManifestEnabled"]
  reviewEventOverride: ReviewEventOverride | undefined
  trustLedgerMode: EnsembleConfig["flags"]["trustLedgerMode"]
  showEvidence: boolean
  runnerEvidenceBadge: "verified" | "evidence-pending" | undefined
  // ─── verify-and-build outputs ───
  submissionVerdict: PrReviewVerdict
  renderableUnanchoredForSubmission: PrReviewFinding[]
  primaryEvent: ReviewEvent
  primaryAffordance: SubmissionAffordance
  prepareFallbackAffordance: (event: ReviewEvent) => Promise<SubmissionAffordance>
  submissionBuild: { suggestionEmissions: Parameters<typeof buildSuggestionEmissionLogEvents>[1] }
  submission: Parameters<GitHubClient["submitReview"]>[3]
  bodyOnlyAnnotations: CheckRunAnnotation[]
  allFindingAnnotations: CheckRunAnnotation[]
  checkAnnotationMeta: (
    annotations: CheckRunAnnotation[],
  ) => { checkAnnotations: CheckRunAnnotation[] } | Record<string, never>
  reviewOutputSurface: EnsembleConfig["flags"]["reviewOutputSurface"]
  // ─── orchestrator closures (threaded) ───
  maybePostAstAutoInline: () => Promise<void>
  deterministicCheckAnnotationMeta: () =>
    | { deterministicCheckAnnotations: CheckRunAnnotation[] }
    | Record<string, never>
  deterministicErroredReviewMeta: () => ReviewMeta | undefined
}

export async function publishReviewSubmission<Tel extends PublishTelemetry>(
  a: PublishArgs<Tel>,
): Promise<EnsembleResult<Tel>> {
  const {
    env,
    owner,
    repo,
    prNumber,
    headSha,
    installationId,
    staleHeadRequeueDepth,
    repoId,
    client,
    sigilixConfig,
    meta,
    perfCtx,
    telemetry,
    startMs,
    cache,
    fullPrDiff,
    stack,
    coverage,
    deltaCounts,
    filesDroppedFromReview,
    currentFindingsForManifest,
    reviewManifestEnabled,
    reviewEventOverride,
    trustLedgerMode,
    showEvidence,
    runnerEvidenceBadge,
    submissionVerdict,
    renderableUnanchoredForSubmission,
    primaryEvent,
    primaryAffordance,
    prepareFallbackAffordance,
    submissionBuild,
    submission,
    bodyOnlyAnnotations,
    allFindingAnnotations,
    checkAnnotationMeta,
    reviewOutputSurface,
    maybePostAstAutoInline,
    deterministicCheckAnnotationMeta,
    deterministicErroredReviewMeta,
  } = a
  // ─── SIG-216: post the overview comment IMMEDIATELY before the
  // review submit so the two GitHub timeline entries land in the
  // same time window (CodeRabbit-style Walkthrough-then-Review).
  // The overview is informed by the review's verdict — we pass
  // findingsCount + severity + category breakdown + the chosen
  // event so the model can summarize "what reviewer concluded"
  // instead of running blind. Gated on `overview.enabled` per the
  // same `sigilixConfig` the ensemble loaded earlier; opted-out
  // customers skip the inline render.
  //
  // Awaited (not `ctx.waitUntil`) so the overview comment is
  // GUARANTEED on the PR timeline before `submitReview` fires.
  // `skipDedupe: true` bypasses the per-(PR, headSha) KV dedupe
  // lock inside `handlePrOverview` so a sibling queued run (legacy
  // warmup refresh, etc.) on this SHA can't block us — but does
  // NOT bypass the in-handler stale-head guards (those still fire
  // on this path, catching head moves that landed during the
  // review's own Ollama window). SIG-216 fix-up swap from
  // `force: true` (which historically bypassed both).
  //
  // Budgeting (SIG-216 fix-up): the overview runs against the
  // REMAINING review budget so a stalled overview can't push the
  // handler past ORCHESTRATOR_TIMEOUT_MS (the wall the orchestrator
  // itself aborts on). Capped at INLINE_OVERVIEW_MAX_BUDGET_MS even
  // on a budget surplus so the overview never eats more than its
  // fair share. When remaining budget falls under
  // INLINE_OVERVIEW_MIN_BUDGET_MS we skip the inline render entirely
  // — the overview can fire on the next push.
  //
  // Retry policy (SIG-216 fix-up): single retry on transient
  // failures (timeouts / 502 / 503 / 504 / fetch-failed /
  // budget-exceeded). Pre-SIG-216 the queue consumer gave
  // MAX_RETRIES=3 on Ollama transients; the inline path had zero.
  // One retry only — bounded by the same Promise.race budget so
  // we can't blow the wall-clock even on a double attempt.
  //
  // Best-effort: even after the single retry, a failure here
  // NEVER blocks the review submit. The customer still gets the
  // review even if the overview comment fails to land.
  if (isPrOverviewEnabled(sigilixConfig)) {
    const overviewStartMs = Date.now()
    const overviewReviewContext: PrOverviewReviewContext = {
      findingsCount: submissionVerdict.findings.length + renderableUnanchoredForSubmission.length,
      severityBreakdown: countBySeverity([...submissionVerdict.findings, ...renderableUnanchoredForSubmission]),
      categoryBreakdown: countByCategory([...submissionVerdict.findings, ...renderableUnanchoredForSubmission]),
      verdict: primaryEvent,
    }
    // Reserve INLINE_OVERVIEW_SUBMIT_RESERVE_MS for the submitReview
    // GitHub roundtrip + the post-overview stale-head re-check that
    // follows; the overview itself gets whatever's left up to
    // INLINE_OVERVIEW_MAX_BUDGET_MS.
    //
    // SIG-216 fix-up (CR catch): budget against ORCHESTRATOR_TIMEOUT_MS,
    // not CF_QUEUE_CONSUMER_CEILING_MS. The orchestrator's own
    // wall-clock is the actual bound on this handler — the platform
    // ceiling is wider (CF_QUEUE_CONSUMER_CEILING_MS - ORCHESTRATOR_TIMEOUT_MS
    // is the grace pad reserved for finalize/cleanup). Using the
    // wider ceiling could push the overview past the orchestrator's
    // own abort and burn the grace pad too.
    const elapsedMs = Date.now() - startMs
    const remainingBudgetMs = Math.max(0, ORCHESTRATOR_TIMEOUT_MS - elapsedMs - INLINE_OVERVIEW_SUBMIT_RESERVE_MS)
    const overviewBudgetMs = Math.min(remainingBudgetMs, INLINE_OVERVIEW_MAX_BUDGET_MS)
    if (overviewBudgetMs < INLINE_OVERVIEW_MIN_BUDGET_MS) {
      console.log(
        JSON.stringify({
          event: "pr-review-inline-overview-skipped-budget",
          owner,
          repo,
          prNumber,
          head_sha: headSha.slice(0, 7),
          remaining_budget_ms: remainingBudgetMs,
          threshold_ms: INLINE_OVERVIEW_MIN_BUDGET_MS,
        }),
      )
    } else {
      try {
        await runInlineOverviewWithRetry(
          {
            owner,
            repo,
            prNumber,
            headSha,
            installationId,
            env,
            skipDedupe: true,
            reviewContext: overviewReviewContext,
          },
          overviewBudgetMs,
        )
        // SIG-149: time-to-first-overview = handler entry → overview
        // posted (first customer-visible content). Measured from
        // `startMs`, NOT `overviewStartMs` (that's the overview's own
        // generation time, already logged as `elapsed_ms`). Set only on
        // the success path so `finalize()` reports it as "no data" when
        // the overview was skipped/failed rather than a misleading 0.
        telemetry.timeToFirstOverviewMs = Date.now() - startMs
        console.log(
          JSON.stringify({
            event: "pr-review-inline-overview-posted",
            owner,
            repo,
            prNumber,
            head_sha: headSha.slice(0, 7),
            elapsed_ms: Date.now() - overviewStartMs,
            budget_ms: overviewBudgetMs,
            findings_count: overviewReviewContext.findingsCount,
            verdict: overviewReviewContext.verdict,
          }),
        )
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "pr-review-inline-overview-failed",
            owner,
            repo,
            prNumber,
            head_sha: headSha.slice(0, 7),
            elapsed_ms: Date.now() - overviewStartMs,
            budget_ms: overviewBudgetMs,
            err: err instanceof Error ? err.message : String(err),
          }),
        )
      }
    }

    // SIG-216 fix-up: re-check the PR head AFTER the inline overview.
    // Belt-and-braces with the in-overview guards: the overview's own
    // pre-Ollama + pre-write guards (which now fire on the inline
    // path since we use `skipDedupe`, not `force`) catch head moves
    // BEFORE / DURING the overview's Ollama call; this re-check
    // catches moves landing AFTER the overview returns, before the
    // review submit. Both layers are intentional — different windows.
    // Fail-closed on lookup error — matches the existing guard pattern.
    try {
      const metaPostOverview = await client.getPullRequest(owner, repo, prNumber)
      if (metaPostOverview.head?.sha && metaPostOverview.head.sha !== headSha) {
        telemetry.fellBackReason = "stale_head_after_inline_overview"
        console.log(
          JSON.stringify({
            event: "pr-review-stale-head-after-inline-overview",
            owner,
            repo,
            prNumber,
            queued_head_sha: headSha.slice(0, 7),
            current_head_sha: metaPostOverview.head.sha.slice(0, 7),
          }),
        )
        await handleStaleHead({
          env,
          owner,
          repo,
          prNumber,
          installationId,
          queuedHeadSha: headSha,
          currentHeadSha: metaPostOverview.head.sha,
          baseSha: metaPostOverview.base?.sha ?? null,
          depth: staleHeadRequeueDepth,
          source: "ensemble-after-inline-overview",
          ...(repoId !== undefined ? { repoId } : {}),
        })
        return finalize(telemetry, env, "stale_head", cache)
      }
    } catch (err) {
      // Fail-closed: uncertain head state → abort the submit rather
      // than risk shipping a stale review. Matches Codex's pattern in
      // `triage-pr-overview.ts`.
      console.warn(
        JSON.stringify({
          event: "pr-review-stale-recheck-failed-aborted",
          owner,
          repo,
          prNumber,
          head_sha: headSha.slice(0, 7),
          err: err instanceof Error ? err.message : String(err),
        }),
      )
      telemetry.fellBackReason = "stale_head_recheck_failed"
      return finalize(telemetry, env, "errored", cache, deterministicErroredReviewMeta())
    }
  }

  // ARC-287 (pre-SIG-85): dismiss prior Sigilix reviews BEFORE
  // posting the new one, so the GitHub timeline renders cleanup-
  // above-current-review (oldest-at-top). Pre-ARC-287 the dismiss
  // fired AFTER the submit, producing a footgun where the dismissal
  // banner showed BELOW the new review chronologically (PR #95's
  // `8ad306a` review demonstrated this — see ARC-287).
  //
  // SIG-85 (2026-05-18): `dismissPriorSigilixReviews` no longer
  // dismisses — it emits `pr-review-stale-detected` telemetry per
  // matching prior. Customers enable GitHub's repo-level "Dismiss
  // stale pull request approvals when new commits are pushed"
  // branch-protection setting; GitHub then handles the dismissal
  // natively and attributes it to the commit pusher. See
  // docs/setup/customer-onboarding.md. The call stays here for the
  // telemetry signal; arguments unchanged so callers don't need
  // updating.
  //
  // Best-effort try/catch — the helper never throws in practice,
  // but defense in depth keeps a hypothetical bug from breaking the
  // submit path.
  try {
    await dismissPriorSigilixReviews({
      client,
      owner,
      repo,
      prNumber,
      currentReviewId: null,
      headSha,
    })
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "pr-review-dismiss-prior-failed",
        owner,
        repo,
        prNumber,
        submit_path: "pre-submit",
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }

  // ARC-284: wrap the submit so a slow GitHub roundtrip shows up in
  // the trace. Covers BOTH the success path and the 422-fallback
  // path that the catch block dispatches to.
  const submitStartMs = Date.now()
  try {
    const submitted = await client.submitReview(owner, repo, prNumber, submission)
    // ARC-258 follow-up (PR #84 anomaly catch, refined PR #86):
    // GitHub's `POST /pulls/{n}/reviews` occasionally returns 2xx
    // with a valid-looking `{id, state}` payload but the review
    // doesn't become publicly visible — either it never persists
    // (PR #84) or it persists in `PENDING` (draft) state (PR #86).
    // Both are caught by verifying against `listPullRequestReviews`
    // (the public list excludes PENDING). If verify can't confirm,
    // mark the run as `errored` so the Check Run reflects reality
    // (failure ≠ silent success) and the customer sees a signal
    // that a real submit didn't happen.
    const verified = await verifyReviewPersisted(
      client,
      owner,
      repo,
      prNumber,
      submitted.id,
      "inline-anchored",
      submitted.state,
    )
    if (!verified) {
      console.error(
        JSON.stringify({
          event: "pr-review-submit-not-persisted",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          claimed_review_id: submitted.id,
          submit_path: "inline-anchored",
        }),
      )
      telemetry.fellBackReason = "submit_not_persisted"
      telemetry.fellBackToPhase3 = false
      // ARC-279: GitHub silently dropped the formal review. Post
      // the synth body as a regular PR comment so the review
      // signal isn't lost. Dispatcher sees `posted` + surface=
      // "comment" → maps the Check Run to `failure` with a "see
      // PR comment" title so the customer knows the normal
      // review pipeline didn't run.
      //
      // CodeRabbit catch on PR #91: on the inline-anchored path,
      // `submission.body` is ONLY the formal review body — the
      // actual findings live separately in `submission.comments`
      // because they're meant to anchor as inline review comments.
      // Posting `submission.body` as a top-level comment would
      // drop every finding. Re-render via `buildFallbackSubmission`
      // (the anchorless body-only renderer) so findings move into
      // the body and survive the channel switch.
      const fallbackCommentEvent = previewFallbackSubmissionEvent({
        verdict: submissionVerdict,
        unanchored: renderableUnanchoredForSubmission,
        ...(reviewEventOverride !== undefined ? { eventOverride: reviewEventOverride } : {}),
      })
      const fallbackCommentAffordance = await prepareFallbackAffordance(fallbackCommentEvent)
      const fallbackCommentSubmission = buildFallbackSubmission(
        withSubmissionAffordance(
          {
            trustLedger: trustLedgerMode === "on",
            showEvidence,
            notReviewedFiles: filesDroppedFromReview,
            verdict: submissionVerdict,
            unanchored: renderableUnanchoredForSubmission,
            prAuthor: meta.user?.login ?? null,
            headSha,
            ...(reviewEventOverride !== undefined ? { eventOverride: reviewEventOverride } : {}),
            ...(stack.isStacked ? { stack } : {}),
            // ARC-281: keep coverage + delta consistent between the
            // primary submit and the comment-fallback body — otherwise
            // a customer who only sees the comment-fallback loses the
            // coverage signal that ARC-277 surfaces on the main path.
            coverage,
            delta: deltaCounts,
          },
          fallbackCommentAffordance,
        ),
      )
      const fallback = await postReviewCommentFallback({
        env,
        client,
        owner,
        repo,
        prNumber,
        headSha,
        body: fallbackCommentSubmission.body ?? "<!-- sigilix:pr-review -->\n(no body)",
        submitPath: "inline-anchored",
      })
      if (fallback.ok) {
        const findingsCount = submissionVerdict.findings.length + renderableUnanchoredForSubmission.length
        // SIG-89 note: comment-fallback paths intentionally do NOT
        // write a noop-merge diff hash. The surface is degraded
        // already (we couldn't post a formal review), and the next
        // push should re-attempt the formal review rather than skip
        // dispatch. Same rationale at all four `surface: "comment"`
        // return sites below.
        await fallbackCommentAffordance.persistReviewCounter()
        return finalize(telemetry, env, "posted", cache, {
          event: fallbackCommentSubmission.event,
          findingsCount,
          surface: "comment",
          // No runner pill on `surface: "comment"`: the dispatcher maps these
          // to a `failure` conclusion whose summary is error prose, and the
          // pill is a success-summary-only signal (Kimi spec). Threading it
          // here would be dead data the renderer never shows.
          ...deterministicCheckAnnotationMeta(),
          ...checkAnnotationMeta(allFindingAnnotations),
        })
      }
      // Comment fallback ALSO failed — `errored` is the truth.
      return finalize(telemetry, env, "errored", cache, deterministicErroredReviewMeta())
    }
    await primaryAffordance.persistReviewCounter()
    telemetry.submitted = true
    const suggestionEmissionEvents = buildSuggestionEmissionLogEvents(
      {
        owner,
        repo,
        prNumber,
        headSha,
        commentsSubmitted: (submission.comments?.length ?? 0) > 0,
      },
      submissionBuild.suggestionEmissions,
    )
    for (const event of suggestionEmissionEvents) {
      console.log(JSON.stringify(event))
    }
    // ARC-258 follow-up: dismiss any stale Sigilix reviews from
    // earlier commits on this PR so the Reviews tab reflects only
    // the current head. Without this, customers see "Sigilix
    // approved a while ago" pointing at an outdated commit even
    // after Sigilix has re-reviewed the new head. Body-marker
    // match ensures we only ever dismiss our own reviews — never
    // touch another reviewer's.
    //
    // ARC-287: post-submit dismissPriorSigilixReviews call removed.
    // Dismissal now fires BEFORE submitReview (see the pre-submit
    // block above) so the GitHub timeline renders dismissal-above-
    // current-review chronologically. ARC-279's comment-fallback
    // covers the "dismiss succeeded + submit failed" failure mode.

    // ARC-184: write review-provenance manifest. Best-effort.
    // ARC-271: also persist the per-finding snapshot so the next
    // push's review can compute a new/still-open/likely-fixed
    // delta against this run.
    await writeReviewManifestForEnsemble({
      env,
      client,
      enabled: reviewManifestEnabled,
      owner,
      repo,
      prNumber,
      headSha,
      baseSha: meta.base?.sha ?? "",
      modelId: "ensemble-synth",
      reviewId: submitted.id,
      findings: currentFindingsForManifest,
    })
    // ARC-194 (moved here in ARC-250): record `lastReviewedSha`
    // only after a confirmed GitHub submit. Previously this fired
    // before guard #2 — a stale-head skip still marked the SHA
    // reviewed, corrupting the next push's compare-diff.
    //
    // CodeRabbit PR #75 catch: a KV failure here MUST NOT bubble
    // out as `errored`. The customer-facing review has already
    // been submitted; an outer-catch `errored` would make
    // `dispatchJob` fall back to Phase 3 and post a SECOND review
    // on the same head. Best-effort: swallow + log instead.
    try {
      await writeLastReviewedSha(env, owner, repo, prNumber, headSha)
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "pr-review-last-reviewed-sha-write-failed",
          owner,
          repo,
          prNumber,
          headSha,
          err: err instanceof Error ? err.message : String(err),
        }),
      )
    }
    // SIG-89: stash the diff hash so the next synchronize push can
    // detect no-op merges (Update-branch button, rebase-no-op force
    // push, empty commit) and skip dispatch. Same best-effort
    // semantics as writeLastReviewedSha — the customer-facing
    // review already shipped; KV failure only means the next push
    // falls back to dispatch instead of skipping. The helper
    // swallows internally.
    await recordReviewedDiffHash(env, owner, repo, prNumber, fullPrDiff, headSha)
    // SIG-216: post-submit `pr-overview` refresh enqueue removed.
    // The overview is now rendered INLINE earlier in this handler
    // (right before `dismissPriorSigilixReviews`), informed by the
    // same submissionVerdict the review is built from — so there's
    // no stale-warmup-callout to clear and nothing for a separate
    // queue job to add. ARC-258's post-review refresh use case is
    // subsumed by the inline render.
    await maybePostAstAutoInline()
    // ARC-276: signal the customer-visible verdict back to the
    // dispatcher so the Sigilix Check Run title can render
    // "Approved — no issues found" vs "N findings posted".
    const inlineFindings = submissionVerdict.findings.length + renderableUnanchoredForSubmission.length
    return finalize(telemetry, env, "posted", cache, {
      event: submission.event,
      findingsCount: inlineFindings,
      ...(runnerEvidenceBadge ? { runnerEvidence: runnerEvidenceBadge } : {}),
      ...deterministicCheckAnnotationMeta(),
      // SIG-144 (PR #339 review fix): in annotations-only mode inline
      // comments are suppressed, so the annotations payload must carry
      // ALL findings — not just the body-only leftovers — or anchored
      // findings get dropped from every surface.
      ...checkAnnotationMeta(
        selectPrimarySubmitAnnotations(reviewOutputSurface, bodyOnlyAnnotations, allFindingAnnotations),
      ),
    })
  } catch (submitErr) {
    // Narrow the anchorless-retry fallback to GitHub HTTP 422 — that's
    // the specific status GitHub returns when an inline anchor is
    // invalid. CR PR #38 round-2 catch: the original catch-all retry
    // was unsafe because `POST /pulls/{n}/reviews` is non-idempotent.
    // A timeout / network error after GitHub accepted the first
    // submission would have produced a duplicate review on retry.
    // So: 422 → re-render anchorless + retry submitReview;
    //     non-422 → don't retry submit, but DO post the comment
    //     fallback (CR PR #97 catch — see below).
    const is422 = submitErr instanceof GitHubHttpError && submitErr.status === 422
    if (!is422) {
      // CR PR #97 catch (Major): pre-ARC-287, a non-422 submit
      // failure rethrew and the prior review stayed intact — the
      // customer saw a stale-but-existing signal. Post-ARC-287,
      // the prior is ALREADY DISMISSED (the pre-submit dismiss
      // fired before submit), so rethrowing here would leave the
      // customer with NO Sigilix signal at all.
      //
      // Restore the "customer always sees Sigilix" guarantee by
      // posting the comment fallback (ARC-279's helper, normally
      // used on verify-fail) on every non-422 submit error too.
      // The synth verdict still hits the PR — just as a regular
      // comment instead of a formal review.
      console.warn(
        JSON.stringify({
          event: "pr-review-submit-non-422-error",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          err: submitErr instanceof Error ? submitErr.message : String(submitErr),
        }),
      )
      const fallbackBodyOnlyEvent = previewFallbackSubmissionEvent({
        verdict: submissionVerdict,
        unanchored: renderableUnanchoredForSubmission,
        ...(reviewEventOverride !== undefined ? { eventOverride: reviewEventOverride } : {}),
      })
      const fallbackBodyOnlyAffordance = await prepareFallbackAffordance(fallbackBodyOnlyEvent)
      const fallbackBodyOnly = buildFallbackSubmission(
        withSubmissionAffordance(
          {
            trustLedger: trustLedgerMode === "on",
            showEvidence,
            notReviewedFiles: filesDroppedFromReview,
            verdict: submissionVerdict,
            unanchored: renderableUnanchoredForSubmission,
            prAuthor: meta.user?.login ?? null,
            headSha,
            ...(reviewEventOverride !== undefined ? { eventOverride: reviewEventOverride } : {}),
            ...(stack.isStacked ? { stack } : {}),
            coverage,
            delta: deltaCounts,
          },
          fallbackBodyOnlyAffordance,
        ),
      )
      const commentFallback = await postReviewCommentFallback({
        env,
        client,
        owner,
        repo,
        prNumber,
        headSha,
        body: fallbackBodyOnly.body ?? "<!-- sigilix:pr-review -->\n(no body)",
        submitPath: "inline-anchored-error",
      })
      if (commentFallback.ok) {
        const findingsCount = submissionVerdict.findings.length + renderableUnanchoredForSubmission.length
        await fallbackBodyOnlyAffordance.persistReviewCounter()
        return finalize(telemetry, env, "posted", cache, {
          event: fallbackBodyOnly.event,
          findingsCount,
          surface: "comment",
          // No runner pill on `surface: "comment"` — see the note at the
          // fallbackCommentSubmission site above (failure conclusion, pill is
          // success-summary-only).
          ...deterministicCheckAnnotationMeta(),
          ...checkAnnotationMeta(allFindingAnnotations),
        })
      }
      // Both inline submit AND comment fallback failed — rethrow
      // so the outer catch records `internal_error` and the
      // Check Run reflects the failure.
      throw submitErr
    }
    const fallbackReason = `HTTP 422 ${submitErr.message}`
    // Set telemetry BEFORE the fallback submit. If the fallback
    // ALSO fails, the outer catch overwrites `internalError` but
    // these two fields stay set — preserves the "we attempted a
    // fallback" signal that Phase 4b shadow-mode monitoring needs.
    // CR PR #38 round-2 catch.
    telemetry.submitFallback = true
    telemetry.submitFallbackReason = fallbackReason
    console.warn("[ensemble] inline submit rejected (HTTP 422); falling back to anchorless review", {
      owner,
      repo,
      prNumber,
      reason: fallbackReason,
    })
    const fallbackEvent = previewFallbackSubmissionEvent({
      verdict: submissionVerdict,
      unanchored: renderableUnanchoredForSubmission,
      ...(reviewEventOverride !== undefined ? { eventOverride: reviewEventOverride } : {}),
    })
    const fallbackAffordance = await prepareFallbackAffordance(fallbackEvent)
    const fallback = buildFallbackSubmission(
      withSubmissionAffordance(
        {
          trustLedger: trustLedgerMode === "on",
          showEvidence,
          notReviewedFiles: filesDroppedFromReview,
          // ARC-189: fallback path also receives the soften-applied
          // verdict. Markers are NOT emitted on the fallback (it's a
          // body-only review with no inline anchors) — see Task 2.5.
          verdict: submissionVerdict,
          unanchored: renderableUnanchoredForSubmission,
          prAuthor: meta.user?.login ?? null,
          headSha,
          ...(reviewEventOverride !== undefined ? { eventOverride: reviewEventOverride } : {}),
          // ARC-182 (code-review C1): thread stack to the anchorless
          // fallback as well — the stack parenthetical belongs in the
          // body regardless of whether inline anchoring succeeded.
          ...(stack.isStacked ? { stack } : {}),
          // ARC-281: coverage + delta survive the anchorless-fallback
          // too, so a 422-driven body-only review reads the same way
          // as the inline-anchored primary.
          coverage,
          delta: deltaCounts,
        },
        fallbackAffordance,
      ),
    )
    // CR PR #97 round-4 catch: the anchorless-fallback submit
    // can also throw (merge race after the guard, transient
    // GitHub 5xx, connection drop). With ARC-287's pre-submit
    // dismiss already done, an un-caught throw here would leave
    // the customer with NO Sigilix signal (prior dismissed, no
    // review posted, no comment). Symmetric to the inline-anchored
    // catch above — post the synth body as a regular PR comment
    // tagged `anchorless-fallback-error` so on-call can correlate.
    let submittedFallback: Awaited<ReturnType<typeof client.submitReview>>
    try {
      submittedFallback = await client.submitReview(owner, repo, prNumber, fallback)
    } catch (fallbackSubmitErr) {
      console.warn(
        JSON.stringify({
          event: "pr-review-fallback-submit-error",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          err: fallbackSubmitErr instanceof Error ? fallbackSubmitErr.message : String(fallbackSubmitErr),
        }),
      )
      const commentFallback = await postReviewCommentFallback({
        env,
        client,
        owner,
        repo,
        prNumber,
        headSha,
        body: fallback.body ?? "<!-- sigilix:pr-review -->\n(no body)",
        submitPath: "anchorless-fallback-error",
      })
      if (commentFallback.ok) {
        const findingsCount = submissionVerdict.findings.length + renderableUnanchoredForSubmission.length
        await fallbackAffordance.persistReviewCounter()
        return finalize(telemetry, env, "posted", cache, {
          event: fallback.event,
          findingsCount,
          surface: "comment",
          // No runner pill on `surface: "comment"` — failure conclusion; the
          // pill is success-summary-only (see fallbackCommentSubmission note).
          ...deterministicCheckAnnotationMeta(),
          ...checkAnnotationMeta(allFindingAnnotations),
        })
      }
      // Both anchorless submit AND comment fallback failed — rethrow
      // so the outer catch records `internal_error` and the
      // Check Run reflects the failure.
      throw fallbackSubmitErr
    }
    // ARC-258 follow-up (PR #84 anomaly catch, refined PR #86):
    // same post-submit verification as the primary path — catches
    // both the 404-on-id and the PENDING-state silent-success
    // cases for the anchorless fallback.
    const verifiedFallback = await verifyReviewPersisted(
      client,
      owner,
      repo,
      prNumber,
      submittedFallback.id,
      "anchorless-fallback",
      submittedFallback.state,
    )
    if (!verifiedFallback) {
      console.error(
        JSON.stringify({
          event: "pr-review-submit-not-persisted",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          claimed_review_id: submittedFallback.id,
          submit_path: "anchorless-fallback",
        }),
      )
      telemetry.fellBackReason = "submit_not_persisted"
      telemetry.fellBackToPhase3 = false
      // ARC-279: same comment-fallback as the inline-anchored
      // verify-fail path. By this point we've tried inline,
      // 422'd, anchorless, and silent-rejected. The synth body
      // is real signal the reviewer would benefit from — post
      // it as a regular comment instead of dropping it.
      const commentFallback = await postReviewCommentFallback({
        env,
        client,
        owner,
        repo,
        prNumber,
        headSha,
        // Same defensive default as the inline-anchored path:
        // `fallback.body` is typed optional but the anchorless
        // path always emits it (buildFallbackBody + the marker).
        body: fallback.body ?? "<!-- sigilix:pr-review -->\n(no body)",
        submitPath: "anchorless-fallback",
      })
      if (commentFallback.ok) {
        const findingsCount = submissionVerdict.findings.length + renderableUnanchoredForSubmission.length
        await fallbackAffordance.persistReviewCounter()
        return finalize(telemetry, env, "posted", cache, {
          event: fallback.event,
          findingsCount,
          surface: "comment",
          // No runner pill on `surface: "comment"` — failure conclusion; the
          // pill is success-summary-only (see fallbackCommentSubmission note).
          ...deterministicCheckAnnotationMeta(),
          ...checkAnnotationMeta(allFindingAnnotations),
        })
      }
      return finalize(telemetry, env, "errored", cache, deterministicErroredReviewMeta())
    }
    await fallbackAffordance.persistReviewCounter()
    telemetry.submitted = true
    // ARC-287: post-submit dismissPriorSigilixReviews call removed
    // (was the anchorless-fallback's parallel of the inline-anchored
    // helper). Both submit paths now rely on the single pre-submit
    // dismissal at the top of this submit block.

    // ARC-184: write manifest for the fallback path too. Same target
    // shape (kind: "review") because the fallback is still a GitHub
    // review (just anchorless body). ARC-271: same per-finding
    // snapshot as the primary path.
    await writeReviewManifestForEnsemble({
      env,
      client,
      enabled: reviewManifestEnabled,
      owner,
      repo,
      prNumber,
      headSha,
      baseSha: meta.base?.sha ?? "",
      modelId: "ensemble-synth",
      reviewId: submittedFallback.id,
      findings: currentFindingsForManifest,
    })
    // ARC-194 (moved here in ARC-250): mirror the primary submit
    // path — only mark `lastReviewedSha` after a confirmed GitHub
    // submit. CR PR #75 catch: same try/catch as the primary path
    // so a KV write failure doesn't bubble out as `errored` and
    // trigger a duplicate Phase 3 fallback review.
    try {
      await writeLastReviewedSha(env, owner, repo, prNumber, headSha)
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "pr-review-last-reviewed-sha-write-failed",
          owner,
          repo,
          prNumber,
          headSha,
          err: err instanceof Error ? err.message : String(err),
        }),
      )
    }
    // SIG-89: mirror the primary path — stash the diff hash for
    // noop-merge skip on the next synchronize. Same best-effort
    // semantics as the lastReviewedSha write above.
    await recordReviewedDiffHash(env, owner, repo, prNumber, fullPrDiff, headSha)
    // SIG-216: post-submit `pr-overview` refresh enqueue removed
    // here too — same rationale as the primary inline-anchored
    // submit path above. The overview already ran inline at the
    // top of the submit block, before the 422 fallback was even
    // considered, so the comment is already on the timeline.
    await maybePostAstAutoInline()
    // ARC-276: same reviewMeta plumbing as the inline-anchored
    // path — the anchorless fallback is still a posted review.
    const fallbackFindings = submissionVerdict.findings.length + renderableUnanchoredForSubmission.length
    return finalize(telemetry, env, "posted", cache, {
      event: fallback.event,
      findingsCount: fallbackFindings,
      ...(runnerEvidenceBadge ? { runnerEvidence: runnerEvidenceBadge } : {}),
      ...deterministicCheckAnnotationMeta(),
      ...checkAnnotationMeta(allFindingAnnotations),
    })
  } finally {
    // ARC-284: fire the submit phase event on every exit path —
    // inline-anchored success, inline-anchored verify-fail (comment
    // fallback), 422 → anchorless fallback success, 422 → fallback
    // verify-fail. Catches the GitHub roundtrip + verify time
    // independently of the synth latency above.
    emitPhaseCompleted(perfCtx, "submit", submitStartMs)
  }
}

// SIG-318 / SIG-366: the publish-phase private helpers (`runInlineOverviewWithRetry`,
// `countBySeverity`, `countByCategory`) moved verbatim to `./publish-helpers` so this
// file stays under the 1k cap. They stay module-private (imported above, not re-exported).
