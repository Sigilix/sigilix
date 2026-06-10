// SIG-318 (PR 12h) — the residual ORCHESTRATOR of the PR-review ensemble (app
// layer). This is the thin coordinator `handlePrReviewEnsemble` that PRs 12a–12g
// carved the phase seams out of: it owns the run setup (config resolve, abort
// timer, telemetry skeleton, the shadow-bakeoff holder), the orchestral gates that
// stayed god-file-side (the two stale-head guards, the pre-fanout / pre-submit
// merged-on-approve short-circuits, the label gate, the router-empty skip), the
// `bailWithSkipNotice` closure, the seam calls into the carved phases
// (fetch-and-pack → gather-evidence → gather-graph → assemble-prompts → specialists
// → adjudicate → render-prep → verify-and-build → publish), and the catch / finally.
//
// Carved verbatim from `src/lib/triage-pr-review-ensemble.ts` (which is now a pure
// re-export shim preserving the module path for the 72 external importers + the
// `vi.mock("../src/lib/triage-pr-review-ensemble", …)` interception in the
// dispatch-job tests). The coordinator body, `EnsembleHandlerArgs`,
// `resolveEnsembleConfig`, `checkQuorum`, the `validateForSubmission` public
// wrapper, the `EnsembleTelemetry` run-record interface, and the `EnsembleResult`
// binding all moved here byte-identical; only the import paths change (each
// dependency now imports from its canonical NON-shim home, never back into the old
// god-file — the dependency rule holds, app → domain/leaf/adapter, the orchestrator
// is the single app-layer composition root). ZERO behavior change.
//
// THE EnsembleTelemetry HOME (reported): the ~310-line run-record `interface` is
// orchestrator-private (never exported, never imported outside the old god-file —
// the persistence port / SLO leaf consume the decoupled `EnsembleTelemetrySummary`
// slice, not this type). It transitively names many lib leaves (`RouterDecision`,
// `DeterministicCheckHit`, the diff-packing/secret-scan/dep-vuln/sarif/review-memory
// blobs); its only consumers are the `telemetry` skeleton built in the handler and
// the `EnsembleResult` binding below. It is relocated to a sibling leaf
// `./orchestrator-types` (alongside the public `EnsembleHandlerArgs`, so THIS file
// stays under the 1k-line cap) and import-typed here — kept out of `app/session.ts`,
// which stays generic over the telemetry type (its whole reason for the `Tel` param).

import type { CheckRunAnnotation } from "@/shared/types/github"
import { postReviewSkipNotice, type SkipNoticeReason } from "../../review-comment-fallback"
import {
  type SpecialistRole,
} from "../../ensemble-router"
import {
  createRetrievalCache,
} from "../../retrieval-cache"
import {
  passesLabelGate,
} from "../../sigilix-config"
import { createAstCache, type AstCache } from "@/features/ast-rules"
import { handleStaleHead } from "../../stale-head"
import { checkIsPrMerged, submitMergedOnApprove } from "../../merge-guard"
import {
  type EnsembleRunCtx,
} from "../../ensemble-perf-telemetry"
import {
  type TokenUsageByModel,
  makeTokenRecorder,
} from "../../ensemble-slo-telemetry"
import {
  type ShadowRunResult,
} from "../../shadow-bakeoff-runner"
import {
  ORCHESTRATOR_TIMEOUT_MS,
  SHADOW_FINALIZE_GRACE_MS,
} from "../domain/budget"
import { parseEnsembleConfig } from "../config"
import type { EnsembleConfig } from "../domain/config"
import {
  validateForSubmission as validateForSubmissionDomain,
  type ValidateForSubmissionArgs,
  type ValidatedOutput,
} from "../domain/validation"
import { adjudicateFindings } from "./adjudicate"
import {
  settleShadowBakeoff,
  type ShadowBakeoffState,
  type ProdSpecialistSnapshot,
} from "./shadow-settle"
import { runSpecialistsAndSynthesize } from "./specialists"
import { fetchDiffAndConfig, packAndRoute } from "./context/fetch-and-pack"
import { gatherRetrievalEvidence } from "./context/gather-evidence"
import { gatherGraphEvidence } from "./context/gather-graph"
import { assembleSpecialistPrompts } from "./context/assemble-prompts"
import { prepareRender } from "./render-prep"
import { verifyAndBuildSubmission } from "./verify-and-build"
import { publishReviewSubmission } from "./publish"
import {
  finalize,
  type ReviewMeta,
} from "./session"
import type { EnsembleHandlerArgs, EnsembleTelemetry, EnsembleResult } from "./orchestrator-types"
import {
  buildClient,
  verifyReviewPersisted,
} from "../adapters/review-sink"

// ─── tunables (defaults — env-overridable) ─────────────────────────────

// SIG-216 fix-up: inline-overview budgeting.
//
// The inline pr-overview call inside `handlePrReviewEnsemble` (added in
// SIG-216) runs an additional Ollama generate ON TOP of the ensemble's
// 895s orchestrator budget. The full review handler must finish inside
// the 900s `CF_QUEUE_CONSUMER_CEILING_MS` queue-consumer wall — a stalled
// overview can otherwise push the consumer past the platform ceiling,
// leaving the queue message in the in_progress state and triggering a
// re-delivery + duplicate review.
//
// Floor: when the remaining review budget drops below this, skip the
// inline overview entirely. The overview will fire on the next push or
// can be re-attempted via warmup. 30s reserves enough room for the
// post-overview stale-head re-check + submitReview round-trip + the
// finally cleanup paths.
export const INLINE_OVERVIEW_MIN_BUDGET_MS = 30_000

// Ceiling: even on a generous budget surplus, cap the inline overview
// wall-time at 90s so a single slow overview can never starve the rest
// of the submit pipeline. Matches the same order-of-magnitude as a
// SPECIALIST_TIMEOUT_MS attempt.
export const INLINE_OVERVIEW_MAX_BUDGET_MS = 90_000

// SIG-318 (PR 12f): the private `INLINE_OVERVIEW_SUBMIT_RESERVE_MS` (the reserved
// tail subtracted from the inline-overview budget for the submit + stale-head
// re-check) moved with the publish phase to ensemble/app/publish, which is now the
// only place the inline-overview budget math runs. The two EXPORTED thresholds
// above stay here to preserve the module's public surface.

// ─── public types ──────────────────────────────────────────────────────

// SIG-318 (PR 12h): `EnsembleHandlerArgs` (the public handler-args contract) lives
// in `./orchestrator-types` alongside the private `EnsembleTelemetry` (split out so
// this file stays under the 1k-line cap). Imported above for the handler signature;
// re-exported here — and through the shim — so the public surface is byte-identical.
export type { EnsembleHandlerArgs }

// ─── orchestrator ──────────────────────────────────────────────────────

/**
 * SIG-318 (PR 5a): resolve the typed ensemble config. The Worker edge
 * (src/index.ts) parses it once via `parseEnsembleConfig(env)` and injects it as
 * `args.ensembleConfig`; callers that omit it (tests / non-edge paths) fall back to
 * parsing `env` here. The fallback is transitional and is removed when the
 * orchestrator is thinned (PR 12). Exported so the inject-vs-parse contract is
 * unit-tested directly.
 */
export function resolveEnsembleConfig(
  args: Pick<EnsembleHandlerArgs, "env" | "ensembleConfig">,
): EnsembleConfig {
  return args.ensembleConfig ?? parseEnsembleConfig(args.env)
}

export async function handlePrReviewEnsemble(
  args: EnsembleHandlerArgs,
): Promise<EnsembleResult> {
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

  // SIG-184: runner-evidence trust state for the check-run badge, set once the
  // receipt is consulted (the SARIF-evidence section, below) and read by every
  // POSTED finalize() so the summary can render the VERIFIED/PENDING pill.
  // Function-scoped (like `cache`) so it crosses the inner try-block boundaries.
  // `undefined` = `runner-absent` = no badge (the default, flag-off path).
  let runnerEvidenceBadge: "verified" | "evidence-pending" | undefined = undefined
  let deterministicCheckAnnotations: CheckRunAnnotation[] | undefined
  const deterministicCheckAnnotationMeta = () =>
    deterministicCheckAnnotations !== undefined && deterministicCheckAnnotations.length > 0
      ? { deterministicCheckAnnotations: [...deterministicCheckAnnotations] }
      : {}
  const deterministicErroredReviewMeta = (): ReviewMeta | undefined =>
    deterministicCheckAnnotations !== undefined && deterministicCheckAnnotations.length > 0
      ? {
          // Generic `errored` check-run rendering ignores `event` and
          // `findingsCount`; ReviewMeta requires them only for success titles.
          // These placeholders carry Lane A annotations through post-SARIF
          // failure paths without pretending a model review was posted.
          event: "REQUEST_CHANGES",
          findingsCount: 0,
          deterministicCheckAnnotations: [...deterministicCheckAnnotations],
        }
      : undefined

  // ARC-258: the in-progress check run is owned by `dispatchJob`,
  // not by this orchestrator. Reason: when ensemble-post fails
  // non-stale-head and the dispatcher falls back to Phase 3, the
  // ensemble can't know whether to complete the check (a `failure`
  // here would contradict a successful Phase 3 review). Lifecycle
  // owned at the dispatcher level → single source of truth for the
  // final outcome.

  // ARC-283 Phase B1b — shadow-mode bake-off state. Lifted out of
  // the try block so the `finally` cleanup can settle every shadow
  // promise + emit comparison telemetry regardless of which return
  // path the prod orchestrator took (success, bail-with-skip-notice,
  // outer-catch). When `SHADOW_BAKEOFF_ROLES` is unset/empty the
  // maps stay empty, the synth promise stays null, and the finally
  // block runs a zero-cost no-op.
  //
  // Snapshots are written as soon as the corresponding prod outcome
  // settles — by the time `finally` runs, each entry is either:
  //   - present (prod settled → shadow comparison can fire)
  //   - absent (prod errored before settle → shadow still emits with
  //     a synthetic "prod did not run" prod outcome)
  // The shadow promise itself never throws — `runShadowSpecialist` /
  // `runShadowSynth` catch + return structured failure on every path.
  //
  // SIG-318 (PR 12b): the four loose containers (`specialistPromises`,
  // `prodSnapshots`, `abortControllers`, `synthPromise`) are bundled into one
  // `ShadowBakeoffState` holder threaded by reference into `settleShadowBakeoff`.
  // `abortControllers` (ARC-283 Phase B1b CR-2): per-shadow AbortController so the
  // finally block can `.abort(reason)` any shadow request that didn't settle
  // before the grace deadline / orch tear-down (pre-CR-2 we emitted
  // `shadow-cut-short` but left the in-flight HTTP request alive, silently
  // doubling provider rate-limit pressure past the cut). Keyed by the role the
  // controller belongs to; `"synth"` is the single shadow synth controller. Map
  // cleared as each entry settles so the finally loop only sees still-pending
  // shadows.
  const shadowState: ShadowBakeoffState = {
    specialistPromises: new Map<SpecialistRole, Promise<ShadowRunResult>>(),
    prodSnapshots: new Map<SpecialistRole, ProdSpecialistSnapshot>(),
    abortControllers: new Map<SpecialistRole | "synth", AbortController>(),
    synthPromise: null,
  }

  // Telemetry skeleton — populated as we go so we can write a record
  // even on early failure paths.
  const telemetry: EnsembleTelemetry = {
    schemaVersion: 3,
    owner,
    repo,
    prNumber,
    headSha,
    mode,
    fellBackToPhase3: false,
    routerDecision: null,
    specialistVerdicts: [],
    synthesizer: null,
    postValidation: { droppedForInvalidLine: 0, remappedInvalidLineToInline: 0, droppedForHallucination: 0, demotedScore1: 0, droppedForVaguePrefix: 0, droppedForUncitedTestingEvidence: 0, droppedForFailedValidation: 0, droppedForFailedTestValidation: 0, droppedForFailedLogicValidation: 0, droppedForFailedLogicRefutation: 0, droppedForFailedLogicClaimRefutation: 0, droppedForFailedRefutationSurvival: 0, droppedForFailedPerfValidation: 0, droppedForFailedInlineGroundingValidation: 0, droppedForFailedAbsenceGroundingValidation: 0, droppedForFailedWindowBlindnessValidation: 0, droppedForFailedSecurityGroundingValidation: 0, droppedForFailedSecurityUsageValidation: 0 },
    retrievalCacheStats: null,
    tokenUsageByModel,
    startMs,
    totalMs: 0,
  }

  try {
    const client = await buildClient(env, installationId)

    // ARC-280 follow-up: bail with a customer-visible skip-notice
    // comment + an `errored` result. Used by the silent-skip paths
    // that used to fall through to Phase 3 (router_no_specialists,
    // specialists_all_failed, synth retry exhausted). The
    // dispatcher already maps `errored` to a `failure` Check Run;
    // the reviewMeta.surface signal flips the title to "Couldn't
    // review — see PR comment."
    //
    // CR Major / Sigilix Logic catch on PR #92: gate the
    // `surface: "skip-notice"` reviewMeta on the post actually
    // succeeding. If `postReviewSkipNotice` returned !ok (or
    // dedupe-hit'd with no comment), we have no comment to point
    // the user at — the Check Run should render the generic
    // "Review failed" title instead of the misleading
    // "Couldn't review — see PR comment" one.
    const bailWithSkipNotice = async (
      reason: SkipNoticeReason,
      opts?: { dispatchedRoles?: readonly string[] },
    ): Promise<EnsembleResult> => {
      const out = await postReviewSkipNotice({
        env, client, owner, repo, prNumber, headSha, reason,
        ...(opts?.dispatchedRoles !== undefined ? { dispatchedRoles: opts.dispatchedRoles } : {}),
      })
      // `ok && reason === "posted"` → a fresh comment is on the PR.
      // `ok && reason === "dedupe-hit"` → a prior run already
      //   posted one for this head; safe to claim "see PR comment".
      // `!ok` → no comment; don't lie to the customer.
      if (out.ok) {
        return finalize(telemetry, env, "errored", cache, {
          event: "REQUEST_CHANGES",
          findingsCount: 0,
          surface: "skip-notice",
          ...deterministicCheckAnnotationMeta(),
        })
      }
      return finalize(telemetry, env, "errored", cache, deterministicErroredReviewMeta())
    }

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
        env, owner, repo, prNumber, installationId,
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
        client, owner, repo, prNumber, headSha,
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
          client, owner, repo, prNumber, out.reviewId,
          "merged-on-approve-pre-fanout", out.state,
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

    // SIG-318 (PR 12g-1): the diff + open-PRs fetch, the SIG-10 incremental-
    // select marker read, the per-repo sigilix.json load, the AI-instruction-
    // ingest decision flag, and `resolveCostControlsConfig` (the label-gate INPUT)
    // moved to ensemble/app/context/fetch-and-pack. The label-gate DECISION below
    // stays orchestral. It mutates `telemetry.incrementalReview` by reference.
    // `sigilixConfig` is a `let` — `packAndRoute` reassigns it on the AI-ingest path.
    const fetched = await fetchDiffAndConfig({
      env, client, owner, repo, prNumber, headSha, ensembleConfig, telemetry,
    })
    const { fullPrDiff, openPrsForStack, fullDiff, shouldLoadAiInstructions, costControls } = fetched
    let sigilixConfig = fetched.sigilixConfig

    // ARC-273: label gate. When the operator configures
    // `costControls.runOnLabels`, pr-review only fires on PRs
    // carrying at least one of those labels. Empty config = no
    // gating (current behavior). Returns `skipped` so the
    // dispatcher-owned Check Run completes as `neutral` rather
    // than misclassifying as a failed review.
    if (costControls.runOnLabels.length > 0) {
      const labelNames = (meta.labels ?? [])
        .map((l) => l.name)
        .filter((n): n is string => typeof n === "string")
      if (!passesLabelGate(labelNames, costControls.runOnLabels)) {
        console.log(JSON.stringify({
          event: "pr-review-skipped",
          reason: "label-gate",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          pr_labels: labelNames,
          run_on_labels: [...costControls.runOnLabels],
        }))
        telemetry.fellBackReason = "label_gate_skip"
        // SIG-224 Phase 0 follow-along: thread `reviewMeta` so the
        // Check Run renders "Approved — no issues found · Sigilix
        // approved · [View PR]" instead of falling through to the
        // legacy "Review posted · [View review]" title that links to
        // a nonexistent review. Same shape as the empty-router branch
        // below — both are "we successfully reviewed and chose not to
        // run specialists." The customer-visible effect: green check,
        // honest "View PR" link, no broken review URL.
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
      env, client, owner, repo, prNumber, headSha, ensembleConfig, orchCtrl, meta,
      fullDiff, sigilixConfig, shouldLoadAiInstructions, costControls, telemetry,
    })
    sigilixConfig = packed.sigilixConfig
    const {
      splitFiles,
      filesAfterFilter,
      reviewedFiles,
      filesNotReviewed,
      droppedTooLarge,
      matchedPathInstructions,
      scopedRulesBlock,
      wasTruncated,
      diff,
      reviewable,
      filePaths,
      deterministicHits,
      secretHits,
      router,
    } = packed

    if (router.specialists.length === 0) {
      // Router said "no specialists apply to this PR" — e.g. docs-only
      // with no executable fenced code blocks (see ensemble-router.ts
      // `decideSpecialists` for the rule taxonomy).
      //
      // SIG-224 Phase 0: this used to call `bailWithSkipNotice` →
      // "Couldn't review — see PR comment" + a yellow check, which is
      // wrong semantics. "No specialists apply" is a successful review,
      // not a failure. Thread `event: "APPROVE" + findingsCount: 0` so
      // the Check Run renders the existing `"Approved — no issues found"`
      // title (`pr-review-check-run.ts:382-387`) instead of falling
      // through to the legacy "Review posted · View review" title that
      // links to a nonexistent review. The dispatcher maps `"skipped"
      // → "success"` via `src/index.ts:1297`.
      //
      // "APPROVE" is a slight semantic stretch (we didn't run a review;
      // we determined no review was needed), but the customer-visible
      // effect is correct: green check, "Sigilix approved", link points
      // at the PR conversation tab, no broken review URL.
      //
      // Pre-req for SIG-225 (Phase 1 shadow dispatcher) — once the
      // dynamic dispatcher starts skipping legitimately-not-applicable
      // specialists more often, this path will fire more often, and the
      // wrong "couldn't review" surface would be customer-visible noise.
      telemetry.fellBackToPhase3 = false  // ARC-280: Phase 3 deleted; this flag is now always false on every path
      telemetry.fellBackReason = "router_no_specialists"
      return finalize(telemetry, env, "skipped", cache, {
        event: "APPROVE",
        findingsCount: 0,
      })
    }

    // ─── SIG-318 (PR 12g-2): the GATHER-EVIDENCE seam ─────────
    // The pre-flight + perf + multi-corpus retrieval, the dep-vuln scan, the AST-
    // source fetch + shared parse-once cache, the branch-vector build + per-pass
    // `branchAwareMerge` closure, and the symbol retrieval moved to ensemble/app/
    // context/gather-evidence. It mutates `telemetry` (dep-vuln) by reference and
    // returns the retrieval cache so the orchestrator's `let cache` (the finally-
    // cleanup reads its stats) is reassigned — the 12a pre-try-let pattern.
    const evidence = await gatherRetrievalEvidence({
      env, client, owner, repo, prNumber, headSha, ensembleConfig, perfCtx, orchCtrl,
      meta, sigilixConfig, router, diff, filePaths, telemetry,
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
    // are reassigned. The graph-context-format + ast-scan-gate pure helpers
    // relocated to the domain (re-exported below to preserve the public surface).
    const graphEvidence = await gatherGraphEvidence({
      env, client, owner, repo, prNumber, headSha,
      ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
      ensembleConfig, meta, sigilixConfig, diff, fullDiff, wasTruncated, reviewable,
      filePaths, splitFiles, sharedChunksForOverlap, astFilesByPath, astCache,
      astRulesConfig, orchCtrl,
      ...(args.graphMetricsSink !== undefined ? { graphMetricsSink: args.graphMetricsSink } : {}),
      ...(args.graphExpansionMetricsSink !== undefined ? { graphExpansionMetricsSink: args.graphExpansionMetricsSink } : {}),
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
    // The prompt fact-blocks + `buildSecurityFactManifest` + the SIG-317 asymmetry/
    // toctou hint blocks + `factsByRole` + the `maybePostAstAutoInline` deferred-
    // poster closure + stack detection + the testing-evidence pack (incl. the bounded
    // cross-file fetch + repo-tree fallback) + the dynamic evidence block + the
    // `messageForRole` closure moved to ensemble/app/context/assemble-prompts. The
    // two closures are RETURNED (they hide their captures); every other value the
    // downstream phases consume flows out unchanged.
    const prompts = await assembleSpecialistPrompts({
      env, client, owner, repo, prNumber, headSha, mode, orchCtrlSignal: orchCtrl.signal,
      meta, sigilixConfig, diff, fullDiff, fullPrDiff, filePaths, splitFiles,
      filesAfterFilter, reviewedFiles, matchedPathInstructions, scopedRulesBlock,
      openPrsForStack, deterministicHits, secretHits, depVulnFindings, depVulnBlock,
      retrievalSnapshot, perfRetrievalSnapshot, logicSymbolSnapshot, sharedChunksForOverlap,
      astFilesByPath, astCache, astRulesConfig, asymmetryMode, toctouMode, namespace,
      astResult, sarifFindings, sarifBlock, docsCoverageHit, perfBudgetsHit, coverageResult,
      graphCtxForPrompt, graphContextNodesForEvidence, graphBlastCallerPaths,
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

    // ─── SIG-318 (PR 12c): the SPECIALISTS+SYNTH seam ─────────
    // The shadow + prod specialist fan-out, the SIG-235 quorum collector,
    // collectSpecialistVerdicts, the dismissal/cleared telemetry + prod
    // snapshots + fanout summary, the ARC-277 coverage gate, the synth-bypass /
    // synthesizer path (+ retry ladder + telemetry + summary), and the recall
    // floors all moved verbatim to ensemble/app/specialists (which delegates the
    // synth phase to ensemble/app/synthesize + the floors to ensemble/app/recall-
    // floors). The phase mutates `telemetry` + `shadowState` by reference; its
    // skip-notice bails return the `exit` arm, forwarded here.
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
    } = specialistsPhase

    // ─── Post-synthesis validation ─────────────────────────────
    // SIG-318 (PR 12a): the adjudicate phase — validateForSubmission, the
    // AST-emit + performance severity clamps, and the consensus re-ranking —
    // moved verbatim to ensemble/app/adjudicate. The phase mutates `telemetry`
    // (synthesizer re-point + postValidation) and `validated` (in-place clamps)
    // by reference; the consensus outputs flow downstream unchanged.
    const { trustLedgerMode, showEvidence, validated, consensusVerdict, consensusProvenance, consensusByIndex } = adjudicateFindings({
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
        env, owner, repo, prNumber, installationId,
        queuedHeadSha: headSha,
        currentHeadSha: meta2.head.sha,
        baseSha: meta2.base?.sha ?? null,
        depth: staleHeadRequeueDepth,
        source: "ensemble-after-review",
        ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
      })
      return finalize(telemetry, env, "stale_head", cache)
    }

    // ─── SIG-216: overview-then-submit ordering ────────────────
    //
    // Pre-SIG-216 the overview ran as its own queue job kicked off
    // by the push webhook and a "Reviewing…" stub was synchronously
    // posted at webhook time so the review-side wait gate could line
    // it up ahead of `submitReview`. Founder direction 2026-05-25:
    // drop the stub-first pattern; the overview comment now lands
    // immediately BEFORE the review comment in this same handler
    // invocation, CodeRabbit-style. See `runInlineOverview` below
    // (called once the submission verdict is final, just before the
    // pre-submit dismiss + `submitReview`).

    // ─── Submit ────────────────────────────────────────────────
    // SIG-318 (PR 12d): the render-prep phase — review-memory soften + the
    // SIG-280 warm veto + the renderable-set assembly (fingerprints, consensus
    // annotation, withdrawal filtering, repeat-FP metrics, precision profile, the
    // `keepIndex` parallel-array bookkeeping, approval-readiness, the review-event
    // resolution, `submissionVerdict`), the cross-push delta-badge snapshot, the
    // coverage roster, and the verification/marker pre-compute (delegated to
    // ensemble/app/verification-prep) — moved to ensemble/app/render-prep. It
    // imports each dependency from its canonical home (app → domain/leaf, never
    // back into this orchestrator) and mutates `submissionVerdict`'s findings by
    // reference only on the default-off re-anchor path; every value it returns
    // flows downstream unchanged. The fragile parallel arrays (keepIndex, the
    // filtered-consensus triple, markers) moved byte-identical with no reordering.
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
      filesDroppedFromReview,
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
        client, owner, repo, prNumber, headSha,
        stage: "pre-submit",
        mergedAtMs: mergeGuard.mergedAtMs,
        startMs,
      })
      if (out.ok) {
        // CR PR #104 Major catch: same post-submit verification as the
        // pre-fanout branch above. See that block for the rationale.
        await verifyReviewPersisted(
          client, owner, repo, prNumber, out.reviewId,
          "merged-on-approve-pre-submit", out.state,
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

    // SIG-318 (PR 12e): the VERIFY-AND-BUILD phase — the detached gate-shadow
    // telemetry IIFE (fire-and-forget), the SIG-285 verification + refuted-demote
    // (the only enforce-path mutation) + the v2 receipt-join + the Trust Ledger v0
    // baseline annotation + the evidence/scope telemetry, then the submission build
    // (affordance preparation, buildReviewSubmissionWithMetadata with its
    // captureGolden(render) seam, and the output-surface strip) — moved verbatim to
    // ensemble/app/verify-and-build. It imports each dependency from its canonical
    // home (app → domain/leaf/render-leaf laterals, never back into this
    // orchestrator) and mutates `submissionVerdict.findings`,
    // `renderableUnanchoredForSubmission`, and `findingMarkers` in lockstep on the
    // refuted-demote path; the first two are mutated by reference, the reassigned
    // `findingMarkers` is returned explicitly and re-bound here.
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
      filesDroppedFromReview,
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
    // SIG-318 (PR 12f): the PUBLISH phase — the inline PR-overview render + its
    // post-overview stale-head guard (#3), the pre-submit dismiss, the submit +
    // 4-level fallback ladder (inline → comment-fallback / 422 → anchorless →
    // comment-fallback, the inner try/catch/finally + its `emitPhaseCompleted`
    // intact), and the per-path post-submit persistence — moved verbatim to
    // ensemble/app/publish. Every terminal path returns `finalize(...)`, so the
    // phase returns the `EnsembleResult` directly. The two submit-ladder rethrows
    // (`throw submitErr` / `throw fallbackSubmitErr`) propagate OUT of
    // `publishReviewSubmission` to this outer catch — publish adds no catch of its
    // own. The orchestrator threads in the ambient identity, the verify-and-build
    // outputs, the mutable telemetry + cache, and the deterministic-annotation /
    // ast-auto-inline closures.
    return await publishReviewSubmission({
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
      filesDroppedFromReview,
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
    })
  } catch (e) {
    telemetry.fellBackToPhase3 = false  // ARC-280: Phase 3 deleted; this flag is now always false on every path
    telemetry.fellBackReason = "internal_error"
    telemetry.internalError = e instanceof Error ? e.message : String(e)
    // ARC-280 follow-up: the internal_error path doesn't post a
    // skip-notice because the catch may have fired BEFORE the
    // client/auth was built (so the `bailWithSkipNotice` closure
    // isn't reachable from here). The dispatcher's `errored` →
    // `failure` Check Run mapping renders a generic "Review
    // failed" title, which is accurate for this case — the on-
    // call team needs to look at telemetry to know what failed.
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
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

// SIG-318 (PR 12h): `checkQuorum` (the SIG-235 fan-out quorum decision) is a PURE
// policy helper — relocated to `../domain/policy` (its natural home alongside the
// other fan-out decisions) and re-exported through the shim. The orchestrator no
// longer references it directly (the specialists phase owns the quorum gate).

// SIG-360: thin public wrapper preserving the original `validateForSubmission`
// signature (astCache OPTIONAL). The believability core moved to
// ./ensemble/domain/validation, where `astCache` is REQUIRED (no features-barrel
// VALUE default in a domain default — the one permitted body delta). Here we
// supply the default so the orchestrator's `satisfies Parameters<typeof
// validateForSubmission>[0]` call site is unchanged. Sync, like the domain fn.
export function validateForSubmission(
  args: Omit<ValidateForSubmissionArgs, "astCache"> & { astCache?: AstCache },
): ValidatedOutput {
  return validateForSubmissionDomain({ ...args, astCache: args.astCache ?? createAstCache() })
}

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
