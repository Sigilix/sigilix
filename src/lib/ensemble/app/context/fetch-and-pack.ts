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
  loadSigilixConfig,
  resolvePathInstructionsForChangedPaths,
  resolveCostControlsConfig,
  type SigilixConfig,
} from "@/src/lib/sigilix-config"
import {
  buildAiInstructionGuidance,
  filterAiInstructionsForChangedPaths,
  loadAiInstructions,
  shouldIngestAiInstructions,
} from "@/src/lib/ai-instructions"
import { renderScopedRulesForPrompt, resolveScopedRulesForChangedPaths } from "@/src/lib/scoped-rules"
import { loadCompiledScopedRulesManifest } from "@/src/lib/scoped-rules-kv"
import { splitDiffByFile, packFilesIntoBatches, batchToDiff, estimateTokens } from "@/src/lib/diff-packing"
import { classifyDiffFiles } from "@/src/lib/diff-file-classify"
import { shouldReview } from "@/src/shared/util/path-glob"
import { runDeterministicChecks, type DeterministicCheckHit } from "@/src/shared/domain/deterministic-checks"
import { runSecretScan, type SecretHit } from "@/src/lib/secret-scan"
import { readLastReviewedSha, selectDiff } from "@/src/lib/incremental-review"
import { decideSpecialists, type RouterDecision } from "@/src/lib/ensemble-router"
import { decideSpecialistsDynamic } from "@/src/lib/dynamic-dispatcher"
import type { EnsembleConfig } from "@/src/lib/ensemble/domain/config"
import { parseDiffToReviewablePositions } from "@/src/shared/util/diff-positions"
import { countLines } from "@/src/lib/ensemble/domain/diff-stats"
import { buildDispatcherSavingsSummary, emitDispatcherSavingsSummary } from "@/src/lib/ensemble-perf-telemetry"

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

  // ARC-174: per-repo `sigilix.json` config. Read at the PR head SHA
  // so the guidance reflects whatever the PR author committed (lets
  // them iterate on the rules in the same PR). Always resolves —
  // missing or malformed config falls back to EMPTY_CONFIG. Loaded
  // BEFORE the diff split so ARC-176 pathFilters can drop files
  // before packing decides what to send to specialists.
  const sigilixConfig = await loadSigilixConfig(client, owner, repo, headSha)
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
}

export interface PackAndRouteArgs {
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  headSha: string
  ensembleConfig: EnsembleConfig
  orchCtrl: AbortController
  meta: PullRequestMeta
  fullDiff: string
  /** The config resolved by `fetchDiffAndConfig`; reassigned here on the AI-ingest path. */
  sigilixConfig: SigilixConfig
  shouldLoadAiInstructions: boolean
  costControls: CostControlsConfig
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
  droppedTooLarge: string[]
  matchedPathInstructions: MatchedPathInstructions
  scopedRulesBlock: string
  wasTruncated: boolean
  diff: string
  reviewable: ReviewableMap
  filePaths: string[]
  deterministicHits: DeterministicCheckHit[]
  secretHits: SecretHit[]
  router: RouterDecision
}

export async function packAndRoute(a: PackAndRouteArgs): Promise<PackAndRouteResult> {
  const {
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
    shouldLoadAiInstructions,
    costControls,
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
  const { batches, droppedTooLarge } = packFilesIntoBatches(filesAfterFilter)
  const reviewedFiles = batches[0] ?? []
  const filesNotReviewed: string[] = batches.slice(1).flatMap((b) => b.map((f) => f.path))
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
  }
}
