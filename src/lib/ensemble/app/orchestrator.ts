// SIG-318 (PR 12h) — the residual ORCHESTRATOR of the PR-review ensemble (app
// layer): the thin coordinator `handlePrReviewEnsemble` that PRs 12a–12g carved the
// phase seams out of. It owns the run setup (config resolve, abort timer, telemetry
// skeleton, the shadow-bakeoff holder), the orchestral gates that stayed god-file-
// side (the two stale-head guards, the pre-fanout / pre-submit merged-on-approve
// short-circuits, the label gate, the router-empty skip), the `bailWithSkipNotice`
// closure, the seam calls into the carved phases (fetch-and-pack → gather-evidence →
// gather-graph → assemble-prompts → specialists → adjudicate → render-prep →
// verify-and-build → publish), and the catch / finally. ZERO behavior change.
//
// Re-exported through the `triage-pr-review-ensemble` shim (the module path the 72
// external importers + the dispatch-job `vi.mock` still use). The public type
// contracts (`EnsembleHandlerArgs`, `EnsembleResult`) + the private
// `EnsembleTelemetry` run-record live in the `./orchestrator-types` leaf; the pure
// tunables + `resolveEnsembleConfig` / `validateForSubmission` / the telemetry-
// skeleton factory live in the `./orchestrator-helpers` leaf (both splits keep this
// file under the 1k-line cap). Dependency rule: app → domain/leaf/adapter, never
// back into the shim.

import type { CheckRunAnnotation } from "@/src/shared/types/github"
import { type SkipNoticeReason } from "@/src/lib/review-comment-fallback"
import { type SpecialistRole } from "@/src/lib/ensemble-router"
import { createRetrievalCache } from "@/src/lib/retrieval-cache"
import { passesLabelGate } from "@/src/lib/sigilix-config"
import { handleStaleHead } from "@/src/lib/stale-head"
import { checkIsPrMerged, submitMergedOnApprove } from "@/src/lib/merge-guard"
import { type EnsembleRunCtx, emitPhaseCompleted, emitGithubFileFetchSummary } from "@/src/lib/ensemble-perf-telemetry"
import { type TokenUsageByModel, makeTokenRecorder } from "@/src/lib/ensemble-slo-telemetry"
import { type ShadowRunResult } from "@/src/lib/shadow-bakeoff-runner"
import { ORCHESTRATOR_TIMEOUT_MS, SHADOW_FINALIZE_GRACE_MS } from "@/src/lib/ensemble/domain/budget"
import {
  resolveEnsembleConfig,
  createEnsembleTelemetrySkeleton,
  buildDeterministicCheckAnnotationMeta,
  buildDeterministicErroredReviewMeta,
  runBailWithSkipNotice,
} from "./orchestrator-helpers"
import { adjudicateFindings } from "./adjudicate"
import { settleShadowBakeoff, type ShadowBakeoffState, type ProdSpecialistSnapshot } from "./shadow-settle"
import { runSpecialistsAndSynthesize } from "./specialists"
import { maybeScheduleMultiBatchShadow } from "./multibatch-shadow-scheduler"
import { buildCostProjectionLineup } from "@/src/lib/ensemble/adapters/model-provider"
import { fetchDiffAndConfig, packAndRoute } from "./context/fetch-and-pack"
import { gatherRetrievalEvidence } from "./context/gather-evidence"
import { gatherGraphEvidence } from "./context/gather-graph"
import { assembleSpecialistPrompts } from "./context/assemble-prompts"
import { prepareRender } from "./render-prep"
import { verifyAndBuildSubmission } from "./verify-and-build"
import { publishReviewSubmission } from "./publish"
import { buildReviewDisclosure } from "@/src/lib/ensemble/render/review-body"
import { attachInvariantLensAmendmentWork } from "./invariant-lens-amendment"
import {
  retrievalStatusUpdate,
  skippedStatusUpdate,
  specialistsStatusUpdate,
  synthStatusUpdate,
} from "@/src/lib/pr-review-status-phases"
import { finalize, type ReviewMeta } from "./session"
import type { EnsembleHandlerArgs, EnsembleTelemetry, EnsembleResult } from "./orchestrator-types"
import { buildClient, verifyReviewPersisted } from "@/src/lib/ensemble/adapters/review-sink"
import type { GitHubClient } from "@/src/shared/adapters/github"

// ─── tunables (defaults — env-overridable) ─────────────────────────────

// SIG-318 / SIG-366: the two EXPORTED inline-overview budget thresholds
// (SIG-216) + the pure `resolveEnsembleConfig` / `validateForSubmission` wrappers
// moved to the `./orchestrator-helpers` leaf (so this file stays under the 1k cap
// after Prettier). `resolveEnsembleConfig` is imported above for the handler's own
// config resolution; the consts + `validateForSubmission` are re-exported here —
// and through the shim — so the public surface is byte-identical.
export {
  INLINE_OVERVIEW_MIN_BUDGET_MS,
  INLINE_OVERVIEW_MAX_BUDGET_MS,
  resolveEnsembleConfig,
  validateForSubmission,
} from "./orchestrator-helpers"

// ─── public types ──────────────────────────────────────────────────────

// SIG-318 (PR 12h): `EnsembleHandlerArgs` (the public handler-args contract) lives
// in `./orchestrator-types` alongside the private `EnsembleTelemetry` (split out so
// this file stays under the 1k-line cap). Imported above for the handler signature;
// re-exported here — and through the shim — so the public surface is byte-identical.
export type { EnsembleHandlerArgs }

// ─── orchestrator ──────────────────────────────────────────────────────

export async function handlePrReviewEnsemble(args: EnsembleHandlerArgs): Promise<EnsembleResult> {
  // ARC-280: `mode` parameter removed. The pre-ARC-275 dual-mode
  // routing (shadow vs post) is gone; this handler is the only
  // production review path. The `EnsembleTelemetry.mode` field is
  // pinned to `"post"` for back-compat with downstream analytics
  // queries that may filter on it.
  const mode = "post" as const
  const { owner, repo, prNumber, headSha, installationId, env } = args
  // SIG-318 (PR 5a): typed config parsed once at the Worker edge and injected via
  // args (fallback parses env for non-edge callers — transitional, see PR 12).
  const ensembleConfig = resolveEnsembleConfig(args)
  const staleHeadRequeueDepth = args.staleHeadRequeueDepth ?? 0
  const startMs = Date.now()
  const orchCtrl = new AbortController()
  const orchTimer = setTimeout(() => orchCtrl.abort(), ORCHESTRATOR_TIMEOUT_MS)
  // ARC-284: correlation fields for the perf-telemetry events emitted
  // throughout this handler. headSha is truncated at log time inside
  // the helper. Stamped here once so every emit gets the same shape.
  const perfCtx: EnsembleRunCtx = { owner, repo, prNumber, headSha }
  // SIG-149: per-review token accumulator. Shared by reference with
  // `telemetry.tokenUsageByModel` below — the recorder mutates this
  // object in place from every settled model attempt, so by the time
  // `finalize()` reads `telemetry.tokenUsageByModel` it holds the full
  // review's spend without any further plumbing.
  const tokenUsageByModel: TokenUsageByModel = {}
  perfCtx.recordTokens = makeTokenRecorder(tokenUsageByModel)

  // Lifted out of the try block so the finally cleanup can read cache
  // stats into telemetry on every exit path (success, failure, throw).
  let cache: ReturnType<typeof createRetrievalCache> | null = null

  // SIG-374: lifted like `cache` so the finally can emit the per-review
  // GitHub fetch-overlap summary (sizes SIG-371/372) on every exit path.
  let clientForFetchSummary: GitHubClient | null = null

  // SIG-184: runner-evidence trust state for the check-run badge, set once the
  // receipt is consulted (the SARIF-evidence section, below) and read by every
  // POSTED finalize() so the summary can render the VERIFIED/PENDING pill.
  // Function-scoped (like `cache`) so it crosses the inner try-block boundaries.
  // `undefined` = `runner-absent` = no badge (the default, flag-off path).
  let runnerEvidenceBadge: "verified" | "evidence-pending" | undefined = undefined
  // SIG-366: the two builders moved (pure) to `./orchestrator-helpers`; these thin
  // zero-arg closures over the mutable `deterministicCheckAnnotations` preserve the
  // callback shape the publish phase + the bail paths consume.
  let deterministicCheckAnnotations: CheckRunAnnotation[] | undefined
  const deterministicCheckAnnotationMeta = () => buildDeterministicCheckAnnotationMeta(deterministicCheckAnnotations)
  const deterministicErroredReviewMeta = (): ReviewMeta | undefined =>
    buildDeterministicErroredReviewMeta(deterministicCheckAnnotations)

  // ARC-258: the in-progress check run is owned by `dispatchJob`,
  // not by this orchestrator. Reason: when ensemble-post fails
  // non-stale-head and the dispatcher falls back to Phase 3, the
  // ensemble can't know whether to complete the check (a `failure`
  // here would contradict a successful Phase 3 review). Lifecycle
  // owned at the dispatcher level → single source of truth for the
  // final outcome.

  // ARC-283 Phase B1b — shadow-mode bake-off state, lifted out of the try block so
  // the `finally` settles every shadow promise + emits comparison telemetry on EVERY
  // return path; empty `SHADOW_BAKEOFF_ROLES` → a zero-cost no-op. SIG-318 (PR 12b)
  // bundled the four containers into one `ShadowBakeoffState` (rationale: `shadow-settle.ts`).
  const shadowState: ShadowBakeoffState = {
    specialistPromises: new Map<SpecialistRole, Promise<ShadowRunResult>>(),
    prodSnapshots: new Map<SpecialistRole, ProdSpecialistSnapshot>(),
    abortControllers: new Map<SpecialistRole | "synth", AbortController>(),
    synthPromise: null,
  }

  // Telemetry skeleton — populated as we go so we can write a record
  // even on early failure paths. SIG-366: built by the pure
  // `createEnsembleTelemetrySkeleton` factory in `./orchestrator-helpers`
  // (`tokenUsageByModel` shared by reference, as before).
  const telemetry: EnsembleTelemetry = createEnsembleTelemetrySkeleton({
    mode,
    owner,
    repo,
    prNumber,
    headSha,
    tokenUsageByModel,
    startMs,
  })

  try {
    const client = await buildClient(env, installationId)
    clientForFetchSummary = client

    // SIG-366: the ARC-280 skip-notice bail moved (verbatim) to
    // `runBailWithSkipNotice` in `./orchestrator-helpers`; this thin closure threads
    // the live identity + the mutable `cache` / `deterministicCheckAnnotations` at
    // call time (the specialists phase consumes it).
    const bailWithSkipNotice = (
      reason: SkipNoticeReason,
      opts?: { dispatchedRoles?: readonly string[] },
    ): Promise<EnsembleResult> =>
      runBailWithSkipNotice({
        reason,
        opts,
        env,
        client,
        owner,
        repo,
        prNumber,
        headSha,
        telemetry,
        cache,
        deterministicCheckAnnotations,
      })

    // ─── Stale-head guard #1 ───────────────────────────────────
    const meta = await client.getPullRequest(owner, repo, prNumber)
    if (meta.head?.sha && meta.head.sha !== headSha) {
      // CodeRabbit catch (phase-end): do NOT set `fellBackToPhase3` —
      // the dispatcher short-circuits Phase 3 on `stale_head`, so this
      // path doesn't actually fall back. Leaving it true would
      // overcount Phase 3 saves and blur stale-head telemetry.
      telemetry.fellBackReason = "stale_head_before_fanout"
      // ARC-250: hand off to the helper for structured telemetry + a
      // user-visible sticky comment. ARC-251: helper auto-requeues
      // against the live SHA when depth < cap; falls through to the
      // sticky on exhaustion. Either way we return `stale_head` so
      // the dispatcher does NOT fall through to Phase 3 (which would
      // also stale-head and post a duplicate sticky / second requeue).
      await handleStaleHead({
        env,
        owner,
        repo,
        prNumber,
        installationId,
        queuedHeadSha: headSha,
        currentHeadSha: meta.head.sha,
        baseSha: meta.base?.sha ?? null,
        depth: staleHeadRequeueDepth,
        source: "ensemble-before-fanout",
        ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
      })
      return finalize(telemetry, env, "stale_head", cache)
    }

    // ─── SIG-88: pre-fanout merged-on-approve short-circuit ────
    //
    // When the PR is already merged at fan-out time (e.g. the webhook
    // was queued after a long delay and the human merged in the
    // meantime), short-circuit to a marker-only APPROVE. CodeRabbit's
    // behavior: GitHub's native "approved these changes" one-liner
    // stands in for a review on already-merged code instead of running
    // the full ensemble + posting REQUEST_CHANGES on a merged PR.
    //
    // We reuse the `meta.merged_at` value we already fetched for the
    // stale-head guard above — no extra GET round-trip. The pre-submit
    // guard further down (post-synth) still calls `checkIsPrMerged`
    // because by then the cached `meta` is ~30-60s old and the merge
    // may have happened during fan-out.
    if (meta.merged_at !== null && meta.merged_at !== undefined) {
      const mergedAtMs = new Date(meta.merged_at).getTime()
      telemetry.fellBackReason = "merged_before_fanout"
      const out = await submitMergedOnApprove({
        client,
        owner,
        repo,
        prNumber,
        headSha,
        stage: "pre-fanout",
        mergedAtMs,
        startMs,
      })
      if (out.ok) {
        // CR PR #104 Major catch: mirror the standard ensemble flow's
        // post-submit verification so a silently-rejected merged-on-
        // approve POST gets the same diagnostic surface (`pr-review-
        // verify-missing` / `-pending` / `-error` telemetry) as the
        // primary path. The verify is best-effort — on inconclusive
        // results we still claim `posted` (matches the standard
        // path's semantics on capped/error returns).
        await verifyReviewPersisted(
          client,
          owner,
          repo,
          prNumber,
          out.reviewId,
          "merged-on-approve-pre-fanout",
          out.state,
        )
        return finalize(telemetry, env, "posted", cache, {
          event: "APPROVE",
          findingsCount: 0,
          ...deterministicCheckAnnotationMeta(),
        })
      }
      // Submit failed — fall through to `errored` without a surface
      // (we have no comment to point the customer at, and the PR is
      // already merged so a skip-notice is pointless).
      return finalize(telemetry, env, "errored", cache, deterministicErroredReviewMeta())
      // SIG-89 note: this merged-on-approve short-circuit intentionally
      // does NOT write a noop-merge diff hash. `fullPrDiff` isn't
      // fetched on this path (the diff fetch lives below at the start
      // of the normal pipeline), and the PR is already merged — no
      // future `synchronize` webhook is expected, so there's nothing
      // a noop-merge skip would help with anyway.
    }

    args.statusReporter?.report(retrievalStatusUpdate())
    // SIG-318 (PR 12g-1): the diff + open-PRs fetch, the incremental-select marker
    // read, the per-repo sigilix.json load, the AI-instruction-ingest flag, and the
    // label-gate INPUT live in ensemble/app/context/fetch-and-pack (the label-gate
    // DECISION below stays orchestral). It mutates `telemetry.incrementalReview` by
    // reference; `sigilixConfig` is a `let` (`packAndRoute` reassigns on AI-ingest).
    const fetched = await fetchDiffAndConfig({
      env,
      client,
      owner,
      repo,
      prNumber,
      headSha,
      ensembleConfig,
      telemetry,
    })
    const { fullPrDiff, openPrsForStack, fullDiff, shouldLoadAiInstructions, costControls } = fetched
    let sigilixConfig = fetched.sigilixConfig

    // ARC-273: configured label gate; non-matching PRs are clean skips.
    if (costControls.runOnLabels.length > 0) {
      const labelNames = (meta.labels ?? []).map((l) => l.name).filter((n): n is string => typeof n === "string")
      if (!passesLabelGate(labelNames, costControls.runOnLabels)) {
        console.log(
          JSON.stringify({
            event: "pr-review-skipped",
            reason: "label-gate",
            owner,
            repo,
            prNumber,
            headSha: headSha.slice(0, 7),
            pr_labels: labelNames,
            run_on_labels: [...costControls.runOnLabels],
          }),
        )
        telemetry.fellBackReason = "label_gate_skip"
        args.statusReporter?.report(skippedStatusUpdate({ findingsCount: 0 }))
        return finalize(telemetry, env, "skipped", cache, {
          event: "APPROVE",
          findingsCount: 0,
        })
      }
    }

    // SIG-318 (PR 12g-1): the hunk-level split/filter/pack + char-level
    // truncation, the AI-instructions ingest (which reassigns `sigilixConfig`),
    // the path-instructions + scoped-rules resolution, the `reviewable` map, the
    // deterministic-checks + secret-scan, the legacy router, and the SIG-226/
    // SIG-224 dynamic-dispatcher block (which mutates `router`) moved to
    // ensemble/app/context/fetch-and-pack. It mutates `telemetry` (diffPacking /
    // deterministicChecks / secretScan / router writes) by reference; the final
    // (post-dispatcher) router flows out for the orchestral router-empty gate below.
    const packed = await packAndRoute({
      env,
      client,
      owner,
      repo,
      prNumber,
      headSha,
      ensembleConfig,
      orchCtrl,
      meta,
      fullDiff,
      sigilixConfig,
      shouldLoadAiInstructions,
      costControls,
      costProjectionLineup: buildCostProjectionLineup(), // SIG-417 (see PackAndRouteArgs doc)
      telemetry,
    })
    sigilixConfig = packed.sigilixConfig
    const {
      splitFiles,
      filesAfterFilter,
      reviewedFiles,
      filesNotReviewed,
      spilloverBatches,
      droppedTooLarge,
      filesDroppedByFilter,
      matchedPathInstructions,
      scopedRulesBlock,
      wasTruncated,
      diff,
      reviewable,
      filePaths,
      deterministicHits,
      secretHits,
      router,
      costTrimmedPaths,
    } = packed

    // SIG-414 Phase 1.2: the honest 3-way un-reviewed disclosure (policy /
    // oversized / spillover), built once from the packer outputs and threaded to
    // every render path (primary + both fallbacks). `reviewedFiles.length` is the
    // honest `n`. Pure factory; `null` when nothing was dropped.
    const disclosure = buildReviewDisclosure({
      policySkipped: filesDroppedByFilter,
      oversized: droppedTooLarge,
      spillover: filesNotReviewed,
      reviewedCount: reviewedFiles.length,
      costTrimmed: costTrimmedPaths, // SIG-417: default-off → empty
    })

    if (router.specialists.length === 0) {
      // Router found no applicable specialists.
      telemetry.fellBackToPhase3 = false // ARC-280: Phase 3 deleted; this flag is now always false on every path
      telemetry.fellBackReason = "router_no_specialists"
      // SIG-417 (Codex #5): a dark-governor trim that empties routing posts a
      // skip-notice COMMENT (never the silent skip) so trimmed files aren't hidden.
      if (costTrimmedPaths.length > 0) {
        return bailWithSkipNotice("cost_governor_trimmed_all_routable")
      }
      args.statusReporter?.report(skippedStatusUpdate({ findingsCount: 0 }))
      return finalize(telemetry, env, "skipped", cache, {
        event: "APPROVE",
        findingsCount: 0,
      })
    }

    // ─── SIG-318 (PR 12g-2): the GATHER-EVIDENCE seam ─────────
    // The multi-corpus retrieval, dep-vuln scan, AST-source fetch + parse-once cache,
    // branch-vector build, and symbol retrieval live in ensemble/app/context/gather-
    // evidence. It mutates `telemetry` (dep-vuln) by reference and returns the
    // retrieval cache so the orchestrator's `let cache` is reassigned (12a pre-try-let).
    const evidence = await gatherRetrievalEvidence({
      env,
      client,
      owner,
      repo,
      prNumber,
      headSha,
      ensembleConfig,
      perfCtx,
      orchCtrl,
      meta,
      sigilixConfig,
      router,
      diff,
      filePaths,
      telemetry,
    })
    cache = evidence.cache
    const {
      retrievalSnapshot,
      perfRetrievalSnapshot,
      logicSymbolSnapshot,
      sharedChunksForOverlap,
      astFilesByPath,
      astCache,
      astRulesConfig,
      depVulnFindings,
      depVulnBlock,
      namespace,
      asymmetryMode,
      toctouMode,
    } = evidence

    // ─── SIG-318 (PR 12g-2): the GATHER-GRAPH seam ────────────
    // It mutates `telemetry` (graphExpansionAb / astRules / sarifEvidence) by
    // reference and returns `runnerEvidenceBadge` + `deterministicCheckAnnotations`
    // so the orchestrator's two pre-try `let`s (read by the posted finalize meta)
    // are reassigned.
    const graphEvidence = await gatherGraphEvidence({
      env,
      client,
      owner,
      repo,
      prNumber,
      headSha,
      ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
      ensembleConfig,
      meta,
      sigilixConfig,
      diff,
      fullDiff,
      wasTruncated,
      reviewable,
      filePaths,
      splitFiles,
      sharedChunksForOverlap,
      astFilesByPath,
      astCache,
      astRulesConfig,
      orchCtrl,
      ...(args.graphMetricsSink !== undefined ? { graphMetricsSink: args.graphMetricsSink } : {}),
      ...(args.graphExpansionMetricsSink !== undefined
        ? { graphExpansionMetricsSink: args.graphExpansionMetricsSink }
        : {}),
      telemetry,
    })
    runnerEvidenceBadge = graphEvidence.runnerEvidenceBadge
    deterministicCheckAnnotations = graphEvidence.deterministicCheckAnnotations
    const {
      graphContextNodesForEvidence,
      graphBlastCallerPaths,
      graphBlastDependentPaths,
      graphCtxForPrompt,
      astResult,
      sarifFindings,
      sarifResult,
      sarifBlock,
      receiptScanIndex,
      docsCoverageHit,
      perfBudgetsHit,
      coverageResult,
      coverageGapSet,
      receiptJoinMode,
    } = graphEvidence

    // ─── SIG-318 (PR 12g-3): the ASSEMBLE-PROMPTS seam ────────
    // The prompt fact-blocks, security manifest, asymmetry/toctou hints, `factsByRole`,
    // the `maybePostAstAutoInline` + `messageForRole` closures, stack detection, the
    // testing-evidence pack, and the dynamic evidence block live in ensemble/app/
    // context/assemble-prompts. The two closures are RETURNED (they hide their
    // captures); every other value the downstream phases consume flows out unchanged.
    const prompts = await assembleSpecialistPrompts({
      env,
      client,
      owner,
      repo,
      prNumber,
      headSha,
      mode,
      orchCtrlSignal: orchCtrl.signal,
      meta,
      sigilixConfig,
      diff,
      fullDiff,
      fullPrDiff,
      filePaths,
      splitFiles,
      filesAfterFilter,
      reviewedFiles,
      matchedPathInstructions,
      scopedRulesBlock,
      openPrsForStack,
      deterministicHits,
      secretHits,
      depVulnFindings,
      depVulnBlock,
      retrievalSnapshot,
      perfRetrievalSnapshot,
      logicSymbolSnapshot,
      sharedChunksForOverlap,
      astFilesByPath,
      astCache,
      astRulesConfig,
      asymmetryMode,
      toctouMode,
      namespace,
      astResult,
      sarifFindings,
      sarifBlock,
      docsCoverageHit,
      perfBudgetsHit,
      coverageResult,
      graphCtxForPrompt,
      graphContextNodesForEvidence,
      graphBlastCallerPaths,
      graphBlastDependentPaths,
    })
    const {
      securityManifest,
      maybePostAstAutoInline,
      stack,
      stackBlock,
      changedLineTextByPath,
      testingEvidencePackWithCoverage,
      dynamicEvidenceBlockForPrompt,
      messageForRole,
    } = prompts

    args.statusReporter?.report(
      specialistsStatusUpdate({
        dispatched: router.specialists,
        droppedFiles: droppedTooLarge,
        graphNodes: graphContextNodesForEvidence,
        totalFiles: filePaths.length,
        graphMode: graphCtxForPrompt.length > 0 ? "available" : "none",
      }),
    )

    // ─── SIG-318 (PR 12c): the SPECIALISTS+SYNTH seam ─────────
    // The shadow + prod specialist fan-out, quorum collector, verdict collection,
    // fanout telemetry, the ARC-277 coverage gate, the synth-bypass / synthesizer
    // path (+ retry ladder), and the recall floors live in ensemble/app/specialists
    // (which delegates synth to ensemble/app/synthesize + the floors to recall-
    // floors). It mutates `telemetry` + `shadowState` by reference; its skip-notice
    // bails return the `exit` arm, forwarded here.
    const specialistsPhase = await runSpecialistsAndSynthesize({
      env,
      owner,
      repo,
      prNumber,
      headSha,
      ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
      ensembleConfig,
      telemetry,
      perfCtx,
      orchCtrl,
      shadowState,
      bailWithSkipNotice,
      sigilixConfig,
      router,
      messageForRole,
      securityManifest,
      diff,
      matchedPathInstructions,
      stackBlock,
      graphCtxForPrompt,
      dynamicEvidenceBlockForPrompt,
      astResult,
      astRulesConfig,
      sarifFindings,
      sarifResult,
      filePaths,
      ...(args.backgroundWaitUntil !== undefined ? { backgroundWaitUntil: args.backgroundWaitUntil } : {}),
    })
    if (specialistsPhase.kind === "exit") return specialistsPhase.result
    const {
      succeeded,
      degradedCoverage,
      synthInputVerdicts,
      synthOutput,
      shadowMemoriesForPhase3,
      effectiveSynthVerdict,
      effectiveSynthProvenance,
      invariantLensAmendmentWork,
    } = specialistsPhase
    args.statusReporter?.report(
      synthStatusUpdate({
        dispatched: router.specialists,
        succeeded: succeeded.map((v) => v.role),
        missing: degradedCoverage?.rolesMissing ?? [],
        droppedFiles: droppedTooLarge,
        graphNodes: graphContextNodesForEvidence,
        totalFiles: filePaths.length,
        graphMode: graphCtxForPrompt.length > 0 ? "available" : "none",
      }),
    )

    // ─── Post-synthesis validation ─────────────────────────────
    // SIG-318 (PR 12a): validation, severity clamps, and consensus ranking live in ./adjudicate.
    const { trustLedgerMode, showEvidence, validated, consensusVerdict, consensusProvenance, consensusByIndex } =
      adjudicateFindings({
        env,
        owner,
        repo,
        prNumber,
        headSha,
        ensembleConfig,
        telemetry,
        validationSink: args.validationSink,
        sigilixConfig,
        fullPrDiff,
        wasTruncated,
        droppedTooLarge,
        reviewable,
        astFilesByPath,
        astCache,
        astResult,
        coverageGapSet,
        securityManifest,
        changedLineTextByPath,
        testingEvidencePackWithCoverage,
        synthInputVerdicts,
        effectiveSynthVerdict,
        effectiveSynthProvenance,
      })

    // ARC-280: shadow-mode branch deleted. The dual-mode routing
    // (shadow vs post) is gone — post is the only mode. The
    // shadow-only `telemetry.shadowVerdict` field stays in the
    // interface for back-compat with stored telemetry rows but is
    // never written from this handler again.

    // ─── Stale-head guard #2 ───────────────────────────────────
    //
    // ARC-250 (Codex MAJOR on the design review): this guard MUST run
    // before `writeLastReviewedSha`. Previously the write happened
    // first, so if the head moved we still marked `headSha` as
    // last-reviewed even though no GitHub review was posted. The next
    // ARC-251 requeue then read that marker and used a `compareDiff`
    // of `oldSha..newSha` instead of the full PR diff — missing every
    // finding from before the head move. The fix is twofold: check
    // staleness here, and move `writeLastReviewedSha` to the two
    // posted-return sites below so it only runs after a successful
    // GitHub submit.
    const meta2 = await client.getPullRequest(owner, repo, prNumber)
    if (meta2.head?.sha && meta2.head.sha !== headSha) {
      // CodeRabbit catch (phase-end): do NOT set `fellBackToPhase3`
      // — same reasoning as guard #1.
      telemetry.fellBackReason = "stale_head_after_review"
      await handleStaleHead({
        env,
        owner,
        repo,
        prNumber,
        installationId,
        queuedHeadSha: headSha,
        currentHeadSha: meta2.head.sha,
        baseSha: meta2.base?.sha ?? null,
        depth: staleHeadRequeueDepth,
        source: "ensemble-after-review",
        ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
      })
      return finalize(telemetry, env, "stale_head", cache)
    }

    // SIG-418 Phase 2 (Design B′): DARK multi-batch SHADOW — after guard #2, detached, output-unchanged (helper header).
    maybeScheduleMultiBatchShadow({
      mode: ensembleConfig.flags.multiBatchMode,
      identity: args,
      perfCtx,
      orchCtrl,
      startMs,
      spilloverBatches,
      roles: router.specialists,
      synthInputVerdicts,
      filePaths,
      filesNotReviewed,
      graphBlastCallerPaths,
      graphBlastDependentPaths,
      meta,
      namespace,
      ...(sigilixConfig.guidance !== undefined ? { guidance: sigilixConfig.guidance } : {}),
      stackBlock,
      graphCtxForPrompt,
    })

    // ─── Submit ────────────────────────────────────────────────
    // SIG-318 (PR 12d): the render-prep phase — review-memory soften, the SIG-280 warm
    // veto, the renderable-set assembly (fingerprints, consensus annotation, withdrawal
    // filtering, repeat-FP metrics, precision profile, the `keepIndex` parallel arrays,
    // approval-readiness, review-event resolution, `submissionVerdict`), the cross-push
    // delta-badge snapshot, the coverage roster, and the verification/marker pre-compute
    // — lives in ensemble/app/render-prep. It mutates `submissionVerdict`'s findings by
    // reference only on the default-off re-anchor path; every returned value flows
    // downstream unchanged (the fragile parallel arrays moved byte-identical).
    const {
      submissionVerdict,
      renderableUnanchoredForSubmission,
      filteredConsensusByIndex,
      filteredConsensusProvenance,
      intendedEvent,
      approvalReadiness,
      effectiveEvent,
      synthConfidence,
      reviewIncomplete,
      reviewEventOverride,
      deltaCounts,
      currentFindingsForManifest,
      coverage,
      verificationMode,
      addedLineTextByLine,
      findingMarkers: findingMarkersFromPrep,
    } = await prepareRender({
      env,
      owner,
      repo,
      prNumber,
      headSha,
      ensembleConfig,
      sigilixConfig,
      orchCtrl,
      validationSink: args.validationSink,
      router,
      fullPrDiff,
      reviewable,
      filesNotReviewed,
      droppedTooLarge,
      succeeded,
      degradedCoverage,
      synthInputVerdicts,
      synthOutput,
      shadowMemoriesForPhase3,
      validated,
      consensusVerdict,
      consensusProvenance,
      consensusByIndex,
    })
    // `let` (was const): SIG-285 PR 4 filters this in lockstep with
    // submissionVerdict.findings when a refuted finding is demoted, to keep the
    // marker<->finding index alignment the builder relies on (SIG-127).
    let findingMarkers: Array<string | null> = findingMarkersFromPrep

    // ARC-286 / SIG-88 — merge-guard runs BEFORE we bump the
    // SIG-101 counter or render the body so a PR that merged mid-
    // review takes the marker-only APPROVE path without ghost-
    // advancing the per-PR review counter. CodeRabbit catch on
    // PR #110: pre-fix the bump ran before the guard, so a
    // `merged-during-review` short-circuit incremented the counter
    // even though nothing user-visible rendered. The reorder
    // doesn't change any other behavior — `checkIsPrMerged` is a
    // pure read against the GitHub API and only needs (client,
    // owner, repo, prNumber, headSha), all available here.
    //
    // SIG-88 (2026-05-18): on the merged branch, we now submit a
    // marker-only APPROVE instead of bailing to a skip-notice. Posting
    // REQUEST_CHANGES on already-merged code is noise (and was the
    // pre-ARC-286 behavior that ARC-286 fixed by bailing); CodeRabbit
    // posts a lightweight APPROVE here so the GitHub Checks UI shows
    // a clean "passed" state instead of an empty skip. The ensemble
    // verdict we just computed is discarded — submitting it as
    // REQUEST_CHANGES would compete with the merge.
    const mergeGuard = await checkIsPrMerged({ client, owner, repo, prNumber, headSha })
    if (mergeGuard.shouldSkip) {
      telemetry.fellBackReason = "merged_during_review"
      const out = await submitMergedOnApprove({
        client,
        owner,
        repo,
        prNumber,
        headSha,
        stage: "pre-submit",
        mergedAtMs: mergeGuard.mergedAtMs,
        startMs,
      })
      if (out.ok) {
        // CR PR #104 Major catch: same post-submit verification as the
        // pre-fanout branch above. See that block for the rationale.
        await verifyReviewPersisted(
          client,
          owner,
          repo,
          prNumber,
          out.reviewId,
          "merged-on-approve-pre-submit",
          out.state,
        )
        return finalize(telemetry, env, "posted", cache, {
          event: "APPROVE",
          findingsCount: 0,
          ...(runnerEvidenceBadge ? { runnerEvidence: runnerEvidenceBadge } : {}),
          ...deterministicCheckAnnotationMeta(),
        })
      }
      return finalize(telemetry, env, "errored", cache, deterministicErroredReviewMeta())
    }

    // SIG-318 (PR 12e): the VERIFY-AND-BUILD phase (gate-shadow telemetry, SIG-285
    // verification + refuted-demote, v2 receipt-join, Trust Ledger v0 baseline, then
    // the submission build) lives in ensemble/app/verify-and-build. It mutates
    // `submissionVerdict.findings` + `renderableUnanchoredForSubmission` by reference
    // on the refuted-demote path; the reassigned `findingMarkers` is re-bound here.
    // SIG-374: `post_validation` was in the phase enum but never emitted —
    // this span (gate shadow + verification + receipt-join + trust ledger +
    // submission build) is part of the dark middle being decomposed.
    const postValidationStartedAtMs = Date.now()
    const {
      primaryEvent,
      primaryAffordance,
      prepareFallbackAffordance,
      submissionBuild,
      submission,
      bodyOnlyAnnotations,
      allFindingAnnotations,
      checkAnnotationMeta,
      reviewOutputSurface,
      findingMarkers: findingMarkersAfterBuild,
    } = await verifyAndBuildSubmission({
      env,
      owner,
      repo,
      prNumber,
      headSha,
      ensembleConfig,
      validationSink: args.validationSink,
      meta,
      reviewable,
      addedLineTextByLine,
      stack,
      coverage,
      deltaCounts,
      disclosure,
      approvalReadiness,
      effectiveEvent,
      intendedEvent,
      reviewEventOverride,
      verificationMode,
      receiptScanIndex,
      receiptJoinMode,
      trustLedgerMode,
      showEvidence,
      filteredConsensusByIndex,
      filteredConsensusProvenance,
      degradedCoverage,
      reviewIncomplete,
      synthConfidence,
      tokenUsageByModel,
      submissionVerdict,
      renderableUnanchoredForSubmission,
      findingMarkers,
    })
    findingMarkers = findingMarkersAfterBuild
    emitPhaseCompleted(perfCtx, "post_validation", postValidationStartedAtMs)
    // SIG-318 (PR 12f): publish owns overview, stale-head guard #3, submit, and persistence.
    return attachInvariantLensAmendmentWork(
      await publishReviewSubmission({
        env,
        owner,
        repo,
        prNumber,
        headSha,
        installationId,
        staleHeadRequeueDepth,
        repoId: args.repoId,
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
        disclosure,
        currentFindingsForManifest,
        reviewManifestEnabled: ensembleConfig.flags.reviewManifestEnabled,
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
      }),
      {
        env,
        client,
        owner,
        repo,
        prNumber,
        headSha,
        lensWork: invariantLensAmendmentWork,
        reviewable,
        addedLineTextByLine,
      },
    )
  } catch (e) {
    telemetry.fellBackToPhase3 = false // ARC-280: Phase 3 deleted; this flag is now always false on every path
    telemetry.fellBackReason = "internal_error"
    telemetry.internalError = e instanceof Error ? e.message : String(e)
    // ARC-280 follow-up: internal_error may fire before client/auth exists, so no skip-notice here.
    return finalize(telemetry, env, "errored", cache, deterministicErroredReviewMeta())
  } finally {
    clearTimeout(orchTimer)
    // SIG-318 (PR 12b): the ARC-283 shadow-comparison emit (the entire finally
    // body after `clearTimeout`) moved verbatim to ensemble/app/shadow-settle.
    // It runs on EVERY return path (success, skip-notice bail, outer-catch);
    // when shadow is disabled the holder's maps are empty + `synthPromise` is
    // null and it is a zero-cost no-op. Awaited exactly as the original finally
    // body was, so the shadow tail still gates the function's settle.
    await settleShadowBakeoff({
      shadowState,
      telemetry,
      perfCtx,
      orchCtrl,
      shadowFinalizeGraceMs: SHADOW_FINALIZE_GRACE_MS,
      owner,
      repo,
      prNumber,
      headSha,
    })
    // SIG-374: per-review GitHub fetch-overlap rollup — the adapter only
    // counts; the app layer owns the emit (dependency rule). Every exit
    // path, so failed reviews report their fetch profile too. Duck-typed:
    // test doubles of `buildClient` don't implement the counter and skip
    // the summary instead of throwing in the finally.
    if (clientForFetchSummary !== null && typeof clientForFetchSummary.fetchOverlapSummary === "function") {
      emitGithubFileFetchSummary(perfCtx, clientForFetchSummary.fetchOverlapSummary())
    }
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

// SIG-318 (PR 12h): `checkQuorum` (the SIG-235 fan-out quorum decision) is a PURE
// policy helper — relocated to `../domain/policy` (its natural home alongside the
// other fan-out decisions) and re-exported through the shim. The orchestrator no
// longer references it directly (the specialists phase owns the quorum gate).

// SIG-360 / SIG-366: the thin public `validateForSubmission` wrapper (astCache
// OPTIONAL — it supplies the `createAstCache()` default the domain core requires)
// moved to the `./orchestrator-helpers` leaf; re-exported above so the public
// surface is byte-identical.

// ─── telemetry / result binding ──────────────────────────────────────────

// SIG-318 (PR 12h): the orchestrator-private `EnsembleTelemetry` run-record interface
// lives in `./orchestrator-types` (split out for the 1k cap). It is never exported from
// the shim — the persistence port / SLO leaf consume the decoupled
// `EnsembleTelemetrySummary` slice; its only consumers are the `telemetry` skeleton the
// handler builds and the `EnsembleResult` binding. The generic `EnsembleResult`,
// `EnsembleResultStatus`, `ReviewMeta`, and the `finalize` choke point live in
// ensemble/app/session (generic over the telemetry type so session never names the
// concrete `EnsembleTelemetry`). SIG-386 (PR1): the concrete
// `EnsembleResult = EnsembleResultBase<EnsembleTelemetry>` binding moved to
// `./orchestrator-types` (co-located with `EnsembleTelemetry`) to land this file at
// <=1k lines; re-exported here so the public type is byte-identical.
export type { EnsembleResult }
