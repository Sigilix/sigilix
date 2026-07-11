// SIG-318 (PR 12g-1) — the FETCH-AND-PACK seam of the PR-review orchestrator
// (app layer, context-build phase). Carved verbatim from `handlePrReviewEnsemble`,
// between the merged-on-approve short-circuit and the pre-flight retrieval snapshot.
//
// Two functions split AROUND the orchestral label gate (the cost-controls exit
// stays god-file-side):
//   - `fetchDiffAndConfig`  — the diff + open-PRs fetch, the incremental-select
//     marker read, the per-repo sigilix.json load, the AI-instruction-ingest
//     decision flag, and `resolveCostControlsConfig` (the label-gate INPUT). The
//     gate DECISION (its `finalize(... "skipped")` exit) stays in the orchestrator.
//   - `packAndRoute`        — the AI-instruction ingest (mutates the returned
//     `sigilixConfig`), the hunk-level split/filter/pack + char-level truncation,
//     the path-instructions + scoped-rules resolution, the `reviewable` map, the
//     deterministic-checks + secret-scan, the legacy router (`decideSpecialists`),
//     and the SIG-226/SIG-224 dynamic-dispatcher block (its own try/catch moved
//     whole; it MUTATES `router`, so the function returns the final router). The
//     router-empty skip (the `finalize(... "skipped")` exit) stays orchestral.
//
// The moved statements are byte-identical apart from the plumbing — the `args.X`
// captures became explicit params, the in-place declarations became returns, and
// the god-file-private `countLines` (whose only caller was the router-decision
// line, here) relocated with it. ZERO behavior change.
//
// Dependency rule: every dependency imports from its canonical NON-god-file home.
// It never imports the orchestrator god-file.

import type { Env } from "@/src/shared/types/env"
import { GitHubClient } from "@/src/shared/adapters/github"
import type { PullRequestMeta, ListOpenPullsItem } from "@/src/shared/types/github"
import {
  resolvePathInstructionsForChangedPaths,
  resolveCostControlsConfig,
  type SigilixConfig,
} from "@/src/lib/sigilix-config"
import { resolveEffectiveSigilixConfig } from "@/src/lib/ensemble/app/context/resolve-effective-config"
import {
  buildAiInstructionGuidance,
  filterAiInstructionsForChangedPaths,
  loadAiInstructions,
  shouldIngestAiInstructions,
} from "@/src/lib/ai-instructions"
import { renderScopedRulesForPrompt, resolveScopedRulesForChangedPaths } from "@/src/lib/scoped-rules"
import { loadCompiledScopedRulesManifest } from "@/src/lib/scoped-rules-kv"
import {
  splitDiffByFile,
  packFilesIntoBatches,
  batchToDiff,
  estimateTokens,
  riskOrderFiles,
  type DiffFileBlock,
} from "@/src/lib/diff-packing"
import { isHighRiskPath } from "@/src/lib/ensemble/domain/resweep"
import {
  projectReviewCostUsd,
  applyCostGovernorTrim,
  type CostProjectionLineup,
} from "@/src/lib/ensemble/domain/cost-projection"
import { classifyDiffFiles } from "@/src/lib/diff-file-classify"
import { shouldReview } from "@/src/shared/util/path-glob"
import {
  runDeterministicChecks,
  type DeterministicCheck,
  type DeterministicCheckHit,
} from "@/src/shared/domain/deterministic-checks"
import { runSecretScan, type SecretHit } from "@/src/lib/secret-scan"
import { readLastReviewedSha, selectDiff } from "@/src/lib/incremental-review"
import { decideSpecialists, type RouterDecision } from "@/src/lib/ensemble-router"
import { decideSpecialistsDynamic } from "@/src/lib/dynamic-dispatcher"
import type { EnsembleConfig, CostGovernorConfig } from "@/src/lib/ensemble/domain/config"
import {
  buildChangedPathSet,
  selectIncrementalReviewPaths,
  summarizeIncrementalCoverage,
  type IncrementalReviewCoverageSummary,
  type IncrementalReviewPathSelection,
  type IncrementalReviewFile,
} from "@/src/lib/ensemble/domain/incremental-coverage"
import {
  readIncrementalReviewCoverage,
  type IncrementalReviewCoverageWriteEntry,
} from "@/src/lib/ensemble/adapters/incremental-coverage"
import { parseDiffToReviewablePositions } from "@/src/shared/util/diff-positions"
import { countLines } from "@/src/lib/ensemble/domain/diff-stats"
import { buildDispatcherSavingsSummary, emitDispatcherSavingsSummary } from "@/src/lib/ensemble-perf-telemetry"
export { startPrReviewConnectedAppEvidence } from "./connected-app-evidence"
type ReviewableMap = ReturnType<typeof parseDiffToReviewablePositions>
type MatchedPathInstructions = ReturnType<typeof resolvePathInstructionsForChangedPaths>
type CostControlsConfig = ReturnType<typeof resolveCostControlsConfig>
type SplitFile = ReturnType<typeof splitDiffByFile>[number]

/**
 * The telemetry slice `fetchDiffAndConfig` writes by reference: just the
 * SIG-10 incremental-review mode read. The orchestrator's telemetry satisfies it.
 */
export interface FetchDiffTelemetry {
  incrementalReview?: {
    mode: ReturnType<typeof selectDiff>["mode"]
    previousSha?: string
    reason?: string
  }
}

export interface FetchDiffAndConfigArgs {
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  headSha: string
  ensembleConfig: EnsembleConfig
  /** Mutated by reference: the SIG-10 incremental-review telemetry write. */
  telemetry: FetchDiffTelemetry
  /** sig-dashboard-review-config: installation id → org/repo dashboard config merged UNDER the committed file. */
  installationId?: number
}

export interface FetchDiffAndConfigResult {
  fullPrDiff: string
  openPrsForStack: ListOpenPullsItem[]
  fullDiff: string
  sigilixConfig: SigilixConfig
  shouldLoadAiInstructions: boolean
  costControls: CostControlsConfig
}

export async function fetchDiffAndConfig(a: FetchDiffAndConfigArgs): Promise<FetchDiffAndConfigResult> {
  const { env, client, owner, repo, prNumber, headSha, ensembleConfig, telemetry } = a
  // ARC-182: fetch open PRs in parallel with the full PR diff. Stack
  // detection needs the open-PR list to find downstack/upstack peers;
  // running the fetch here (after the stale-head guard, in parallel
  // with the diff) avoids an extra serial round-trip. Best-effort
  // with `.catch` → empty list = no-stack review (degraded but
  // correct).
  const [fullPrDiff, openPrsForStack] = await Promise.all([
    client.getPullRequestDiff(owner, repo, prNumber),
    client.listOpenPullRequests(owner, repo).catch((err) => {
      console.warn(
        JSON.stringify({
          event: "pr-stack-open-prs-fetch-failed",
          owner,
          repo,
          prNumber,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      return [] as ListOpenPullsItem[]
    }),
  ])

  // ARC-194 / SIG-10: read prior-review marker for telemetry only.
  // The diff fed to specialists + synth is always the cumulative
  // full PR diff (PR.base.sha..headSha) — SIG-10 removed the
  // incremental compare-diff path because on multi-commit PRs the
  // push-delta diff produced false-positive "undefined export"-class
  // findings against symbols introduced in an earlier commit. See
  // `selectDiff` in incremental-review.ts for the full rationale.
  // The compareDiff fetch is gone too: its result is no longer
  // consumed, so spending the round-trip would be pure waste.
  const lastReviewed = await readLastReviewedSha(env, owner, repo, prNumber)
  const diffSelection = selectDiff({
    fullDiff: fullPrDiff,
    compareDiff: null,
    previousSha: lastReviewed?.reviewedSha ?? null,
    currentHeadSha: headSha,
  })
  telemetry.incrementalReview = {
    mode: diffSelection.mode,
    ...(diffSelection.previousSha ? { previousSha: diffSelection.previousSha } : {}),
    ...(diffSelection.reason ? { reason: diffSelection.reason } : {}),
  }
  const fullDiff = diffSelection.diff

  // ARC-174 + sig-dashboard-review-config: EFFECTIVE per-repo config at head SHA —
  // committed `sigilix.json` (SIG-107 visible parse-error; EMPTY_CONFIG fallback)
  // merged committed-wins + recall-safe with the portal dashboard config (see
  // resolve-effective-config.ts). Loaded BEFORE the diff split (ARC-176 pathFilters).
  const sigilixConfig = await resolveEffectiveSigilixConfig(a)
  const shouldLoadAiInstructions = shouldIngestAiInstructions(
    sigilixConfig.guidance,
    ensembleConfig.flags.ingestAiInstructions,
  )

  // ARC-273: label gate. When the operator configures
  // `costControls.runOnLabels`, pr-review only fires on PRs
  // carrying at least one of those labels. Empty config = no
  // gating (current behavior). Returns `skipped` so the
  // dispatcher-owned Check Run completes as `neutral` rather
  // than misclassifying as a failed review.
  const costControls = resolveCostControlsConfig(sigilixConfig)
  return {
    fullPrDiff,
    openPrsForStack,
    fullDiff,
    sigilixConfig,
    shouldLoadAiInstructions,
    costControls,
  }
}

/**
 * The telemetry slice `packAndRoute` writes by reference: the diff-packing
 * summary, the deterministic-checks rollup, the secret-scan rollup, and the
 * router decision (incl. the dispatcher's legacy-router preservation +
 * routerDecision swap). The orchestrator's telemetry object satisfies it.
 */
export interface PackAndRouteTelemetry {
  diffPacking?: {
    diffTokensEstimated: number
    totalFiles: number
    batchCount: number
    filesReviewed: string[]
    filesDroppedTooLarge: string[]
    filesNotReviewed: string[]
    filesDroppedByFilter?: string[]
    diffTruncatedToChars?: number
  }
  deterministicChecks?: {
    hits: DeterministicCheckHit[]
    compiledRegexFailures: ReturnType<typeof runDeterministicChecks>["compiledRegexFailures"]
  }
  secretScan?: {
    hitCount: number
    fingerprints: string[]
  }
  routerDecision: RouterDecision | null
  legacyRouterDecision?: RouterDecision
  dispatcherDecision?: import("@/src/lib/dynamic-dispatcher").DispatcherDecision
  /** SIG-417: the pre-flight cost projection (observe-only) + the dark
   *  governor's trim outcome. `governorTrimmed` is true ONLY when the
   *  default-off governor actually removed files — the orchestrator reads it to
   *  force a notice/disclosure path instead of the router-empty silent skip. */
  costProjection?: {
    projectedUsd: number
    perCallInputTokens: number
    /** Whether the governor was enabled this run (telemetry vs enforcing). */
    governorEnabled: boolean
    /** True iff the governor actually trimmed ≥1 file (drives force-notice). */
    governorTrimmed: boolean
    /** Paths the governor trimmed (lowest-risk; never high-risk/scanner-hit). */
    trimmedPaths: string[]
    /** True when a floor stopped the trim before the ceiling (still over budget). */
    ceilingUnmet: boolean
  }
  incrementalCoverage?: {
    mode: "shadow" | "on"
    pathsToReview: string[]
    changedPaths: string[]
    neverReviewedPaths: string[]
    skippedUnchangedPaths: string[]
    reviewedCount: number
    totalCount: number
    unreviewedPaths: string[]
  }
}

export interface PackAndRouteArgs {
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  headSha: string
  repoId?: number
  ensembleConfig: EnsembleConfig
  orchCtrl: AbortController
  meta: PullRequestMeta
  fullDiff: string
  /** The config resolved by `fetchDiffAndConfig`; reassigned here on the AI-ingest path. */
  sigilixConfig: SigilixConfig
  shouldLoadAiInstructions: boolean
  costControls: CostControlsConfig
  /** SIG-417: the model lineup the cost projection prices, passed IN as typed data
   *  so the packing layer never imports model-provider state (orchestrator builds it
   *  from `SPECIALIST_CONFIGS`/`SYNTHESIZER_CONFIG`). Optional (non-edge/tests skip it). */
  costProjectionLineup?: CostProjectionLineup
  forceFullCoverage?: boolean // VERIFIED unlock Phase 2: force NON-INCREMENTAL — see EnsembleHandlerArgs.forceFullCoverage
  /** Mutated by reference: diffPacking / deterministicChecks / secretScan / router writes. */
  telemetry: PackAndRouteTelemetry
}

export interface PackAndRouteResult {
  /** Reassigned when AI-instructions are ingested; the final config the rest of the run reads. */
  sigilixConfig: SigilixConfig
  splitFiles: SplitFile[]
  filesAfterFilter: SplitFile[]
  reviewedFiles: SplitFile[]
  filesNotReviewed: string[]
  /** SIG-418 Phase 2 (Design B′): the EFFECTIVE spillover batches — the files the
   *  posted single-batch path deferred (everything not in `reviewedFiles`), packed
   *  into the same ≤12K-token batches, derived AFTER the cost-governor seam so the
   *  boundary matches what the posted path actually reviewed. Empty for a fully
   *  single-batch PR. Consumed ONLY by the dark `multiBatchMode` shadow loop (PR 2);
   *  the single-batch posted path ignores it, so this is purely additive. `droppedTooLarge`
   *  files are excluded (they exceed one batch and stay in the SIG-414 disclosure). */
  spilloverBatches: DiffFileBlock[][]
  droppedTooLarge: string[]
  /** SIG-414: paths excluded by `pathFilters` BEFORE packing (lockfiles /
   *  generated / vendored / minified / binary). Previously this was only ever
   *  written to telemetry and died there; the render path now consumes it to
   *  render the calm "policy skipped" disclosure note (distinct from the
   *  oversized + spillover coverage gaps, and NOT a downgrade trigger). */
  filesDroppedByFilter: string[]
  matchedPathInstructions: MatchedPathInstructions
  scopedRulesBlock: string
  wasTruncated: boolean
  diff: string
  reviewable: ReviewableMap
  filePaths: string[]
  deterministicHits: DeterministicCheckHit[]
  secretHits: SecretHit[]
  router: RouterDecision
  /** SIG-417: paths the dark cost governor trimmed (default-off → empty). The
   *  orchestrator feeds these to `buildReviewDisclosure({ costTrimmed })` so a
   *  trimmed file is disclosed with its own copy (never the spillover wording),
   *  and uses non-empty as the "force a notice, not a silent skip" signal. */
  costTrimmedPaths: string[]
  incrementalCoverage?: {
    mode: "shadow" | "on"
    selection: IncrementalReviewPathSelection
    summary: IncrementalReviewCoverageSummary
    coverageEntries: IncrementalReviewCoverageWriteEntry[]
  }
}

export async function packAndRoute(a: PackAndRouteArgs): Promise<PackAndRouteResult> {
  const {
    env,
    client,
    owner,
    repo,
    prNumber,
    headSha,
    repoId,
    ensembleConfig,
    orchCtrl,
    meta,
    fullDiff,
    shouldLoadAiInstructions,
    costControls,
    costProjectionLineup,
    forceFullCoverage,
    telemetry,
  } = a
  let sigilixConfig = a.sigilixConfig
  // ARC-192 + ARC-176: hunk-level diff packing with config-aware
  // filtering. Split the diff by file, drop files matched by
  // `sigilixConfig.pathFilters` (lockfiles, generated content, etc.
  // that shouldn't burn token budget), pack the remainder greedily
  // into batches under the per-call token cap. v1 reviews only the
  // FIRST batch; files in subsequent batches are recorded in
  // telemetry as `filesNotReviewed`. Files larger than the cap
  // individually are dropped via `filesDroppedTooLarge`. Multi-batch
  // with parallel specialist calls + verdict merge is the v2
  // enhancement; v1 ships the bound + telemetry.
  const splitFiles = splitDiffByFile(fullDiff)
  // Lane D: when the repo configured NO explicit sigilix.json guidance, fall
  // back to its own AI-instruction files as ADVISORY review guidance — parity
  // with CodeRabbit/Greptile-style context ingestion, without requiring a
  // sigilix.json. sigilix.json always takes precedence
  // (`shouldLoadAiInstructions`). GitHub `.github/instructions/**` files may
  // carry `applyTo:` path scopes, so binding happens against the full selected
  // diff's changed-file set (not the post-packing reviewed batch) for stable
  // per-PR semantics.
  if (shouldLoadAiInstructions) {
    const aiInstructions = await loadAiInstructions(client, owner, repo, headSha)
    const applicableAiInstructions = aiInstructions
      ? filterAiInstructionsForChangedPaths(
          aiInstructions,
          splitFiles.map((f) => f.path),
        )
      : null
    if (applicableAiInstructions) {
      sigilixConfig = {
        ...sigilixConfig,
        guidance: buildAiInstructionGuidance(applicableAiInstructions),
      }
      console.log(
        JSON.stringify({
          event: "pr-review-ai-instructions-ingested",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          source_count: applicableAiInstructions.chunks.length,
          sources: applicableAiInstructions.chunks.map((chunk) => chunk.source),
          scoped_source_count: applicableAiInstructions.chunks.filter(
            (chunk) => chunk.applyTo !== undefined && chunk.applyTo.length > 0,
          ).length,
        }),
      )
    }
  }
  const filterPatterns = sigilixConfig.pathFilters ?? []
  const filesAfterFilter =
    filterPatterns.length === 0 ? splitFiles : splitFiles.filter((f) => shouldReview(f.path, filterPatterns))
  const filesDroppedByFilter =
    filterPatterns.length === 0
      ? []
      : splitFiles.filter((f) => !shouldReview(f.path, filterPatterns)).map((f) => f.path)
  const incrementalCoveragePlan = await buildIncrementalCoveragePlan({
    env,
    client,
    owner,
    repo,
    prNumber,
    ...(repoId !== undefined ? { repoId } : {}),
    meta,
    // VERIFIED unlock Phase 2: forceFullCoverage → "off" (non-incremental) so the
    // receipt re-review re-fires findings + the join runs. See EnsembleHandlerArgs doc.
    mode: forceFullCoverage ? "off" : ensembleConfig.flags.incrementalReviewMode,
    filesAfterFilter,
    signal: orchCtrl.signal,
  })
  const coverageFilteredFiles =
    incrementalCoveragePlan !== null && incrementalCoveragePlan.mode === "on"
      ? filesAfterFilter.filter((f) => incrementalCoveragePlan.pathsToReview.has(f.path))
      : filesAfterFilter

  // SIG-414: risk-order so the reviewed batch[0] holds the highest-risk files
  // (auth/secret/session/token/… per `isHighRiskPath` — the same paths that
  // trigger a re-sweep), not an arbitrary diff-order slice. Stable + a no-op
  // when all-or-none are high-risk; a single-batch no-filter PR's diff stays
  // `fullDiff` below, so the common case is byte-identical.
  const riskOrderedFiles = riskOrderFiles(coverageFilteredFiles, isHighRiskPath)
  const { batches, droppedTooLarge } = packFilesIntoBatches(riskOrderedFiles)
  // SIG-417: the reviewed batch is `let` because the dark cost governor (when
  // explicitly enabled — default OFF) may trim its lowest-risk TAIL right here,
  // BEFORE `diff`/`reviewable`/scans/routing derive (the correct mutation
  // boundary — Codex sign-off). Default-off → these are byte-identical to the
  // SIG-414 1.1 outputs and `costTrimmedPaths` stays empty.
  let reviewedFiles = batches[0] ?? []
  let filesNotReviewed: string[] = batches.slice(1).flatMap((b) => b.map((f) => f.path))
  // SIG-417: projection telemetry (ALWAYS) + the dark governor trim (default-off,
  // recall-guarded). Mutates `reviewedFiles` only when the governor is enabled
  // AND a ceiling is set AND the projection exceeds it. Returns the trimmed
  // paths for the disclosure + the force-notice signal.
  const costTrimmedPaths = applyCostGovernorSeam({
    owner,
    repo,
    prNumber,
    headSha,
    costGovernor: ensembleConfig.tunables.costGovernor,
    ...(costProjectionLineup !== undefined ? { lineup: costProjectionLineup } : {}),
    deterministicChecks: sigilixConfig.deterministicChecks ?? [],
    telemetry,
    reviewedFiles,
    setReviewedFiles: (next) => {
      reviewedFiles = next
    },
    appendNotReviewed: (paths) => {
      filesNotReviewed = [...filesNotReviewed, ...paths]
    },
  })
  // SIG-418 Phase 2 (Design B′): the EFFECTIVE spillover batches the posted
  // single-batch path deferred. Derived HERE — after the cost-governor seam has
  // finalized `filesNotReviewed` — so the boundary matches what the posted path
  // actually reviewed (never the raw pre-governor `batches`). The post-filter,
  // risk-ordered blocks restricted to the deferred set, re-packed into the same
  // ≤12K-token batches. The cost-governor-trimmed files are SUBTRACTED: the
  // governor dropped them intentionally for cost (they get their own SIG-414
  // disclosure), so the dark shadow pass must NOT spend model calls re-reviewing
  // them — recall/cost-safe. Default-off governor → `costTrimmedPaths` is empty,
  // so this is exactly the genuine `batches.slice(1)` spillover. Consumed only by
  // the dark `multiBatchMode` shadow loop (PR 2); zero effect on the posted path.
  const trimmedSet = new Set(costTrimmedPaths)
  const spilloverSet = new Set(filesNotReviewed.filter((p) => !trimmedSet.has(p)))
  const { batches: spilloverBatches } = packFilesIntoBatches(riskOrderedFiles.filter((f) => spilloverSet.has(f.path)))
  const baseDiff =
    reviewedFiles.length === splitFiles.length && droppedTooLarge.length === 0 ? fullDiff : batchToDiff(reviewedFiles)
  const matchedPathInstructions = resolvePathInstructionsForChangedPaths(
    sigilixConfig,
    reviewedFiles.map((f) => f.path),
  )
  if (matchedPathInstructions.length > 0) {
    console.log(
      JSON.stringify({
        event: "pr-review-path-instructions-matched",
        owner,
        repo,
        prNumber,
        headSha: headSha.slice(0, 7),
        instruction_count: matchedPathInstructions.length,
        matched_file_count: new Set(matchedPathInstructions.flatMap((i) => i.matchedPaths)).size,
      }),
    )
  }
  // SIG-172: load the per-repo scoped-rules manifest (SIGILIX.md +
  // .sigilix/rules/*.md, persisted at index time) and pick the
  // rules that apply to this PR's changed files. Closest-ancestor
  // walk + glob matching. Cached compiled matchers are reused
  // across roles in this run (one matcher build per PR, not per
  // changed file).
  const scopedRulesManifest = await loadCompiledScopedRulesManifest(env, owner, repo)
  const scopedRuleSelection = resolveScopedRulesForChangedPaths(
    scopedRulesManifest,
    reviewedFiles.map((f) => f.path),
  )
  const scopedRulesBlock = renderScopedRulesForPrompt(scopedRuleSelection)
  if (scopedRulesBlock.length > 0) {
    console.log(
      JSON.stringify({
        event: "pr-review-scoped-rules-matched",
        owner,
        repo,
        prNumber,
        headSha: headSha.slice(0, 7),
        per_directory_rules: scopedRuleSelection.perDirectoryRules.length,
        glob_rules: scopedRuleSelection.globRules.length,
      }),
    )
  }
  // ARC-273: hard cap on the diff string passed to specialists.
  // `packFilesIntoBatches` already bounds total-file budget; this
  // is a belt-and-suspenders char-level cap for pathological cases
  // (one enormous file, or operator-narrowed budget). Truncates
  // from the END so the diff header + leading hunks survive. A
  // trailing sentinel notes the truncation so the model knows it
  // didn't see everything.
  //
  // code-reviewer M1 catch: `slice(0, negative)` would silently
  // produce an empty string if the operator set `maxPatchLength`
  // below the sentinel length. `MAX_PATCH_LENGTH_MIN = 1_000`
  // makes that impossible today, but the relationship is implicit
  // — `Math.max(0, …)` codifies the invariant defensively.
  const PATCH_TRUNCATION_NOTE = "\n\n[…diff truncated to costControls.maxPatchLength…]"
  const wasTruncated = baseDiff.length > costControls.maxPatchLength
  const diff = wasTruncated
    ? baseDiff.slice(0, Math.max(0, costControls.maxPatchLength - PATCH_TRUNCATION_NOTE.length)) + PATCH_TRUNCATION_NOTE
    : baseDiff
  if (wasTruncated) {
    console.log(
      JSON.stringify({
        event: "pr-review-diff-truncated",
        owner,
        repo,
        prNumber,
        headSha: headSha.slice(0, 7),
        original_chars: baseDiff.length,
        max_patch_length: costControls.maxPatchLength,
        final_chars: diff.length,
      }),
    )
  }
  const incrementalCoverage =
    incrementalCoveragePlan !== null
      ? finalizeIncrementalCoveragePlan({
          plan: incrementalCoveragePlan,
          reviewedFiles,
          wasTruncated,
        })
      : undefined
  if (incrementalCoverage !== undefined) {
    telemetry.incrementalCoverage = {
      mode: incrementalCoverage.mode,
      pathsToReview: incrementalCoverage.selection.pathsToReview,
      changedPaths: incrementalCoverage.selection.changedPaths,
      neverReviewedPaths: incrementalCoverage.selection.neverReviewedPaths,
      skippedUnchangedPaths: incrementalCoverage.selection.skippedUnchangedPaths,
      reviewedCount: incrementalCoverage.summary.reviewedCount,
      totalCount: incrementalCoverage.summary.totalCount,
      unreviewedPaths: incrementalCoverage.summary.unreviewedPaths,
    }
  }

  telemetry.diffPacking = {
    diffTokensEstimated: estimateTokens(fullDiff),
    totalFiles: splitFiles.length,
    batchCount: batches.length,
    filesReviewed: reviewedFiles.map((f) => f.path),
    filesDroppedTooLarge: droppedTooLarge,
    filesNotReviewed,
    ...(filesDroppedByFilter.length > 0 ? { filesDroppedByFilter } : {}),
    // ARC-273 (code-reviewer M2 catch): when the char-level cap
    // truncated the post-packing diff, surface the post-truncation
    // size so operators can correlate "diff packing said X files
    // reviewed" with "model actually saw Y chars."
    ...(wasTruncated ? { diffTruncatedToChars: diff.length } : {}),
  }

  const reviewable = parseDiffToReviewablePositions(diff)
  const filePaths = [...reviewable.keys()]

  // ARC-193: deterministic regex checks run BEFORE specialist fanout.
  // Hits become structured findings prepended to specialist prompts
  // as authoritative facts (LLM still weighs context). Cheap +
  // deterministic — closes the well-known LLM miss-rate gap on flat
  // patterns (TODO markers, console.log, hardcoded API-key shapes).
  const deterministicRunResult = runDeterministicChecks(diff, sigilixConfig.deterministicChecks ?? [])
  const deterministicHits: DeterministicCheckHit[] = deterministicRunResult.hits
  if (deterministicHits.length > 0 || deterministicRunResult.compiledRegexFailures.length > 0) {
    telemetry.deterministicChecks = {
      hits: deterministicHits,
      compiledRegexFailures: deterministicRunResult.compiledRegexFailures,
    }
  }

  // ARC-187: secret scan. Built-in baseline rule set (AWS, GitHub,
  // Slack, Stripe, OpenAI, Anthropic keys + private-key PEM headers
  // + a generic high-entropy safety net). Hits are redacted before
  // anything reaches logs / prompts / telemetry — raw secrets never
  // leave the runner. Always-on; no config knob in v1 because secret
  // detection is baseline behavior, not opt-in.
  const secretHits: SecretHit[] = runSecretScan(diff)
  if (secretHits.length > 0) {
    telemetry.secretScan = {
      hitCount: secretHits.length,
      // Telemetry stores fingerprints (path:line:redacted) — never
      // the raw values. Lets post-hoc analysis dedupe across runs
      // without exposing the secret to KV reads.
      fingerprints: secretHits.map((h) => h.fingerprint),
    }
  }

  // ─── Router decision ───────────────────────────────────────
  const totalLinesChanged = countLines(diff)
  // CR PR #35 catch: pass diffText so the router can content-aware
  // check markdown fenced code blocks before taking the docs-only
  // shortcut.
  let router = decideSpecialists({ paths: filePaths, totalLinesChanged, diffText: diff }, env)
  telemetry.routerDecision = router

  // ─── SIG-226 / SIG-224 Phase 1 — dispatcher (shadow + enforce_rules) ─
  // Default mode = "off" → the whole block is a no-op (single env
  // string compare).
  //
  // Modes:
  //   "shadow"        — dispatcher computes picks + LLM call, but the
  //                     legacy router still drives fan-out. Pure data
  //                     collection for SIG-227b / SIG-228 graduation.
  //   "enforce_rules" — SIG-227a. Dispatcher runs the RULE LAYER only
  //                     (no LLM call, 0s overhead) and its picks
  //                     REPLACE `router.specialists` for fan-out.
  //                     Activates the new safe-skip rules
  //                     (lockfile-only, .d.ts-only, test-files-only)
  //                     that the legacy router doesn't have.
  //   "enforce"       — Phase 2/3 (SIG-227b / SIG-228). Dispatcher
  //                     runs rules + LLM and the picks drive fan-out.
  //                     Logged but not yet honored in Phase 1 / 227a.
  //
  // Dispatcher is wrapped in try/catch so a defense-in-depth throw
  // can't poison the legacy review pipeline (CR M3 fix from PR #183).
  const dispatcherMode = ensembleConfig.flags.dynamicDispatcherMode
  if (dispatcherMode === "shadow" || dispatcherMode === "enforce" || dispatcherMode === "enforce_rules") {
    try {
      const dispatcherClassified = classifyDiffFiles(filePaths)
      const dispatcherCommitMessage = `${meta.title}\n\n${meta.body ?? ""}`
      const dispatcherDecision = await decideSpecialistsDynamic({
        signals: { paths: filePaths, totalLinesChanged, diffText: diff },
        classified: dispatcherClassified,
        commitMessage: dispatcherCommitMessage,
        // SIG-230: thread separated title/body through so the LLM
        // prompt sees them inside the `<pr_metadata>` envelope. The
        // sanitizer + envelope are the two-layer defense against
        // prompt-injection in PR titles/bodies.
        prTitle: meta.title,
        prBody: meta.body ?? "",
        repoConfig: sigilixConfig,
        env,
        signal: orchCtrl.signal,
      })
      telemetry.dispatcherDecision = dispatcherDecision
      emitDispatcherSavingsSummary(
        { owner, repo, prNumber, headSha },
        buildDispatcherSavingsSummary({
          ctx: { owner, repo, prNumber, headSha },
          mode: dispatcherMode,
          baselineSpecialists: router.specialists,
          dispatcherSpecialists: dispatcherDecision.specialists,
          perRole: dispatcherDecision.perRole,
          layerVotes: dispatcherDecision.layerVotes,
        }),
      )
      console.log(
        JSON.stringify({
          event: "dispatcher-shadow-decision",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          mode: dispatcherMode,
          routerSpecialists: router.specialists,
          dispatcherSpecialists: dispatcherDecision.specialists,
          perRole: dispatcherDecision.perRole,
          layerVotes: dispatcherDecision.layerVotes,
          reasoning: dispatcherDecision.reasoning,
          elapsedMs: dispatcherDecision.elapsedMs,
        }),
      )
      if (dispatcherMode === "enforce_rules") {
        // SIG-227a: rules-only enforcement. Replace the legacy
        // router's picks with the dispatcher's.
        //
        // Safe-skip COVERAGE is a strict superset: the dispatcher
        // adds lockfile-only, .d.ts-only, and test-files-only on
        // top of the legacy router's docs-only-no-fences and CSS-
        // only. So for PRs that hit a safe-skip case, the dispatcher
        // matches OR shrinks the fan-out vs the legacy router.
        //
        // END-TO-END behavior on shape+force collisions differs.
        // Example: a docs-only PR that ALSO touches an auth path
        // (e.g. `auth-spec.md`). Legacy router: `forced.size > 0`
        // → docs shortcut is SKIPPED → all 4 specialists run.
        // Dispatcher: docs safe-skip fires → security force adds
        // security back → fan-out = `{security}` only. This is
        // intentionally more aggressive — a markdown change to an
        // auth spec doesn't need logic/perf/tests review — but it
        // IS a behavior change reviewers will see in shadow
        // telemetry.
        //
        // CodeRabbit M1 fix: preserve the legacy router decision
        // on `telemetry.legacyRouterDecision` so `/metrics/validation`
        // can compute the "would-have-fanned-out vs actually-fanned-
        // out" delta. The console.log captures both sides too.
        telemetry.legacyRouterDecision = router
        router = {
          specialists: dispatcherDecision.specialists,
          reason: `dispatcher_enforce_rules:${dispatcherDecision.reasoning.slice(0, 200)}`,
          routerEnabled: true,
        }
        telemetry.routerDecision = router
      }
      if (dispatcherMode === "enforce") {
        // SIG-227b: NON-PROTECTED enforcement. Apply the dispatcher's full
        // decision (rule layer + LLM-decided ambiguous middle) for fan-out.
        // reconcile() PROTECTS security + logic — an ambiguous protected role
        // ALWAYS runs; only ambiguous `tests`/`performance` are LLM-skippable
        // — and a disabled/errored/aborted LLM fails CLOSED to "run all
        // ambiguous" (makeDisabledDecision returns ALL_SPECIALISTS). So this
        // can only ever SHRINK the fan-out for the two low-stakes roles,
        // never drop security/logic. (Protected-role LLM-skipping needs a
        // confidence floor + high-trust = SIG-228, deliberately NOT here.)
        // Mirrors the enforce_rules swap above; the difference is upstream —
        // mode=enforce ran the LLM classifier, so the decision is narrower.
        telemetry.legacyRouterDecision = router
        router = {
          specialists: dispatcherDecision.specialists,
          // Defensive `?? ""` so a malformed decision can never throw the
          // `.slice` into the outer catch (Kimi sign-off, SIG-227b).
          reason: `dispatcher_enforce:${(dispatcherDecision.reasoning ?? "").slice(0, 200)}`,
          routerEnabled: true,
        }
        telemetry.routerDecision = router
        console.log(
          JSON.stringify({
            event: "dispatcher-enforce-applied",
            owner,
            repo,
            prNumber,
            headSha: headSha.slice(0, 7),
            legacySpecialists: telemetry.legacyRouterDecision.specialists,
            enforcedSpecialists: router.specialists,
          }),
        )
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "dispatcher-shadow-error",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          err: err instanceof Error ? err.message : String(err),
          note: "dispatcher threw unexpectedly; legacy router still drives fan-out",
        }),
      )
    }
  }

  return {
    sigilixConfig,
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
    ...(incrementalCoverage !== undefined ? { incrementalCoverage } : {}),
  }
}

interface IncrementalCoveragePlan {
  mode: "shadow" | "on"
  currentFiles: IncrementalReviewFile[]
  priorCoverage: Awaited<ReturnType<typeof readIncrementalReviewCoverage>>
  pathsToReview: ReadonlySet<string>
  selection: IncrementalReviewPathSelection
}

async function buildIncrementalCoveragePlan(args: {
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  repoId?: number
  meta: PullRequestMeta
  mode: EnsembleConfig["flags"]["incrementalReviewMode"]
  filesAfterFilter: readonly SplitFile[]
  signal: AbortSignal
}): Promise<IncrementalCoveragePlan | null> {
  if (args.mode === "off" || args.filesAfterFilter.length === 0) return null
  try {
    const maxFiles = Math.max(args.filesAfterFilter.length, args.meta.changed_files ?? 0, 50)
    const prFiles = await args.client.listPullRequestFiles(args.owner, args.repo, args.prNumber, {
      maxFiles,
      signal: args.signal,
    })
    const blobShaByPath = new Map(prFiles.map((file) => [file.filename, file.sha ?? null]))
    const currentFiles = args.filesAfterFilter.map((file) => ({
      path: file.path,
      blobSha: blobShaByPath.get(file.path) ?? null,
    }))
    const priorCoverage = await readIncrementalReviewCoverage(
      args.env,
      args.owner,
      args.repo,
      args.prNumber,
      args.repoId,
    )
    const changedPaths = buildChangedPathSet(priorCoverage, currentFiles)
    const selection = selectIncrementalReviewPaths({
      priorCoverage,
      currentFiles,
      changedPaths,
    })
    return {
      mode: args.mode,
      currentFiles,
      priorCoverage,
      pathsToReview: new Set(selection.pathsToReview),
      selection,
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "incremental-review-coverage-plan-failed",
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    return null
  }
}

function finalizeIncrementalCoveragePlan(args: {
  plan: IncrementalCoveragePlan
  reviewedFiles: readonly SplitFile[]
  wasTruncated: boolean
}): NonNullable<PackAndRouteResult["incrementalCoverage"]> {
  const reviewedThisPassPaths = new Set(args.wasTruncated ? [] : args.reviewedFiles.map((file) => file.path))
  const summary = summarizeIncrementalCoverage({
    priorCoverage: args.plan.priorCoverage,
    currentFiles: args.plan.currentFiles,
    reviewedThisPassPaths,
  })
  const blobShaByPath = new Map(args.plan.currentFiles.map((file) => [file.path, file.blobSha]))
  return {
    mode: args.plan.mode,
    selection: args.plan.selection,
    summary,
    coverageEntries: args.wasTruncated
      ? []
      : args.reviewedFiles.map((file) => ({
          path: file.path,
          blobSha: blobShaByPath.get(file.path) ?? null,
        })),
  }
}

/**
 * SIG-417 — cost-projection telemetry + dark-governor seam.
 *   2. WHEN the governor is explicitly ENABLED with a ceiling (default OFF):
 *      trim the lowest-risk TAIL of `reviewedFiles` until the projection is
 *      at/under the ceiling, with HARD recall floors — never below
 *      `minReviewedFiles`, never a high-risk file, and never a file with a
 *      deterministic/secret hit on the PRE-trim batch (those scans run on the
 *      packed diff, so trimming a hit-bearing file would drop a real P0 from the
 *      cheap detector too — Codex sign-off #3). Trimmed paths flow to
 *      `filesNotReviewed` + are returned for the distinct cost-trim disclosure.
 *
 * Returns the trimmed paths (empty unless the governor actually trimmed). The
 * default-off path returns `[]` and leaves `reviewedFiles` byte-identical.
 */
function applyCostGovernorSeam(args: {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  costGovernor: CostGovernorConfig
  lineup?: CostProjectionLineup
  deterministicChecks: DeterministicCheck[]
  telemetry: PackAndRouteTelemetry
  reviewedFiles: SplitFile[]
  setReviewedFiles: (next: SplitFile[]) => void
  appendNotReviewed: (paths: string[]) => void
}): string[] {
  const { owner, repo, prNumber, headSha, costGovernor, lineup, telemetry } = args
  // No lineup → can't price a projection (non-edge/test path). Nothing to do.
  if (!lineup) return []

  const overheadTokens = costGovernor.perCallOverheadTokensEst
  // Re-projects the cost for a candidate kept-set: each model reads the kept
  // diff once (+ the fixed overhead). Closes over the lineup + overhead so the
  // pure projection/trim functions never import model-provider state.
  const projectUsdForFiles = (kept: readonly SplitFile[]): number =>
    projectReviewCostUsd({
      specialistModels: lineup.specialistModels,
      synthModel: lineup.synthModel,
      reviewedDiffTokens: estimateTokens(batchToDiff([...kept])),
      perCallOverheadTokensEst: overheadTokens,
    }).projectedUsd

  const initialProjection = projectReviewCostUsd({
    specialistModels: lineup.specialistModels,
    synthModel: lineup.synthModel,
    reviewedDiffTokens: estimateTokens(batchToDiff(args.reviewedFiles)),
    perCallOverheadTokensEst: overheadTokens,
  })

  // The dark governor only acts when explicitly enabled AND a ceiling is set
  // AND the projection exceeds it. Otherwise this is observe-only telemetry.
  const willTrim =
    costGovernor.enabled &&
    costGovernor.ceilingUsd !== undefined &&
    initialProjection.projectedUsd > costGovernor.ceilingUsd

  let trimmedPaths: string[] = []
  let finalProjectedUsd = initialProjection.projectedUsd
  let ceilingUnmet = false

  if (willTrim) {
    // Codex sign-off #3: pre-scan the PRE-trim reviewed batch so any file with a
    // deterministic-check or secret hit is UNTRIMMABLE — trimming it would drop
    // it from the cheap P0/P1 detectors (which run on the packed diff), not just
    // the LLM. This is what makes an enabled trim recall-bounded.
    const preTrimDiff = batchToDiff(args.reviewedFiles)
    const protectedPaths = new Set<string>()
    for (const hit of runDeterministicChecks(preTrimDiff, args.deterministicChecks).hits) protectedPaths.add(hit.path)
    for (const hit of runSecretScan(preTrimDiff)) protectedPaths.add(hit.path)

    const trim = applyCostGovernorTrim<SplitFile>({
      reviewedFiles: args.reviewedFiles,
      projectUsdForFiles,
      ceilingUsd: costGovernor.ceilingUsd!,
      minReviewedFiles: costGovernor.minReviewedFiles,
      isHighRisk: isHighRiskPath,
      protectedPaths,
    })
    if (trim.trimmed.length > 0) {
      args.setReviewedFiles(trim.kept)
      trimmedPaths = trim.trimmed.map((f) => f.path)
      args.appendNotReviewed(trimmedPaths)
    }
    finalProjectedUsd = trim.projectedUsd
    ceilingUnmet = trim.ceilingUnmet
  }

  telemetry.costProjection = {
    projectedUsd: finalProjectedUsd,
    perCallInputTokens: initialProjection.perCallInputTokens,
    governorEnabled: costGovernor.enabled,
    governorTrimmed: trimmedPaths.length > 0,
    trimmedPaths,
    ceilingUnmet,
  }
  console.log(
    JSON.stringify({
      event: "cost-projection",
      owner,
      repo,
      prNumber,
      headSha: headSha.slice(0, 7),
      projectedUsd: finalProjectedUsd,
      preTrimProjectedUsd: initialProjection.projectedUsd,
      perCallInputTokens: initialProjection.perCallInputTokens,
      models: [...lineup.specialistModels, lineup.synthModel],
      ...(costGovernor.ceilingUsd !== undefined ? { ceilingUsd: costGovernor.ceilingUsd } : {}),
      governorEnabled: costGovernor.enabled,
      governorTrimmed: trimmedPaths.length > 0,
      trimmedCount: trimmedPaths.length,
      ceilingUnmet,
    }),
  )

  return trimmedPaths
}
