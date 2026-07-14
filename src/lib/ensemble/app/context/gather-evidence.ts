// SIG-318 (PR 12g-2) — the GATHER-EVIDENCE seam of the PR-review orchestrator
// (app layer, context-build phase). Carved verbatim from `handlePrReviewEnsemble`,
// between the router-empty skip and the SIG-138 graph-expansion block: the
// pre-flight retrieval snapshot + the SIG-110 perf-keyword retrieval + the SIG-44
// multi-corpus retrieval (all kicked off concurrently), the ARC-186 dep-vuln scan,
// the ARC-181/SIG-121 AST-source fetch + the shared parse-once `createAstCache`,
// the SIG-129 branch-vector build + the per-pass `branchAwareMerge` closure
// (internal), and the SIG-121 symbol retrieval.
//
// The retrieval cache is created HERE (the `cache = createRetrievalCache(...)`
// pre-try `let` in the orchestrator) and RETURNED so the orchestrator's `let cache`
// is reassigned — the 12a-established pattern for pre-try lets the finally cleanup
// reads. The moved statements are byte-identical apart from the plumbing
// (`args.X` → params, declarations → returns). ZERO behavior change.
//
// Dependency rule: every dependency imports from its canonical NON-god-file home.
// It never imports the orchestrator god-file.

import type { Env } from "@/src/shared/types/env"
import { GitHubClient } from "@/src/shared/adapters/github"
import { retrieveChunks, formatChunksForPrompt, type RetrievedChunk } from "@/src/lib/retrieval"
import { resolveReviewCrossRepoNamespaces } from "@/src/lib/cross-repo-context"
import {
  multiCorpusEnabled,
  retrieveMultiCorpus,
  formatMultiCorpusForPrompt,
  type MultiCorpusResult,
} from "@/src/lib/multi-corpus"
import { indexNamespace } from "@/src/lib/repo-index-manifest"
import {
  buildPerfRetrievalQuery,
  extractChangedFunctionNames,
  shouldRunPerfRetrieval,
  resolvePerfSnapshot,
} from "@/src/lib/perf-retrieval"
import {
  extractChangedSymbols,
  buildSymbolRetrievalQuery,
  computeChunkOverlap,
  shouldRunSymbolRetrieval,
} from "@/src/lib/symbol-retrieval"
import {
  shouldRunBranchAwareRetrieval,
  prepareBranchSet,
  retrieveBranchChunks,
  mergeBranchAware,
  buildBranchRetrievalEvent,
  type BranchVector,
} from "@/src/lib/branch-retrieval"
import { dynamicReviewEvidenceEnabled } from "@/src/lib/review-evidence-pack"
import { embedText } from "@/src/shared/adapters/model"
import { buildChangedLines } from "@/src/features/ast-rules"
import { mapWithConcurrency } from "@/src/shared/util/bounded-concurrency"
import { withComposedTimeout } from "@/src/lib/agent-loop"
import { resolveAstRulesConfig, type SigilixConfig } from "@/src/lib/sigilix-config"
import { runDepVulnScan } from "@/src/features/dep-vulns"
import { createAstCache, type AstCache } from "@/src/features/ast-rules"
import { renderDepVulnFindingsForPrompt } from "@/src/features/dep-vulns"
import { createRetrievalCache } from "@/src/lib/retrieval-cache"
import { type RouterDecision } from "@/src/lib/ensemble-router"
import type { EnsembleConfig } from "@/src/lib/ensemble/domain/config"
import { RETRIEVAL_PREFLIGHT_TIMEOUT_MS } from "@/src/lib/ensemble/domain/budget"
import { type EnsembleRunCtx, emitPhaseCompleted, emitSubphaseCompleted } from "@/src/lib/ensemble-perf-telemetry"
import { TOP_K_BRANCH } from "@/src/lib/ensemble/domain/retrieval-constants"
import type { ScmProviderKind } from "@/src/lib/ensemble/ports"

type AstRulesConfig = ReturnType<typeof resolveAstRulesConfig>
type DepVulnFindings = Exclude<Awaited<ReturnType<typeof runDepVulnScan>>, { skipped: true }>["findings"]
type RetrievalCache = ReturnType<typeof createRetrievalCache>

/**
 * The telemetry slice `gatherRetrievalEvidence` writes by reference: the ARC-186
 * dep-vuln scan rollup. The orchestrator's telemetry object satisfies it.
 */
export interface GatherEvidenceTelemetry {
  depVulnScan?:
    | {
        skipped: true
        reason: import("@/src/features/dep-vulns").ScanSkipReason
        findingsCount: number
      }
    | {
        skipped: false
        findingsCount: number
        depsScanned: number
        manifestsScanned: number
      }
}

export interface GatherEvidenceArgs {
  scmProvider: ScmProviderKind
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  /** SIG cross-repo context: the GitHub App installation, used to resolve the
   * Linear team's EXPLICITLY configured repo set for the review's namespace fan-out. */
  installationId: number
  prNumber: number
  headSha: string
  ensembleConfig: EnsembleConfig
  perfCtx: EnsembleRunCtx
  orchCtrl: AbortController
  meta: { title?: string | null; body?: string | null; base?: { sha?: string } | null }
  sigilixConfig: SigilixConfig
  router: RouterDecision
  diff: string
  filePaths: string[]
  /** Mutated by reference: the dep-vuln scan telemetry write. */
  telemetry: GatherEvidenceTelemetry
}

export interface GatherEvidenceResult {
  /** The pre-try retrieval cache — the orchestrator's `let cache` is reassigned to this. */
  cache: RetrievalCache
  retrievalSnapshot: string
  perfRetrievalSnapshot: string
  logicSymbolSnapshot: string
  sharedChunksForOverlap: RetrievedChunk[]
  astFilesByPath: Map<string, string>
  astCache: AstCache
  astRulesConfig: AstRulesConfig
  depVulnFindings: DepVulnFindings
  depVulnBlock: string
  /** The retrieval namespace + the SIG-317 asymmetry/toctou modes the (12g-3)
   *  prompt-assembly phase still reads inline in the orchestrator until it carves. */
  namespace: string
  asymmetryMode: string
  toctouMode: string
}

export async function gatherRetrievalEvidence(a: GatherEvidenceArgs): Promise<GatherEvidenceResult> {
  const {
    scmProvider,
    env,
    client,
    owner,
    repo,
    installationId,
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
  } = a
  // ─── Pre-flight retrieval snapshot ─────────────────────────
  const cache = createRetrievalCache({
    maxCalls: ensembleConfig.tunables.maxRetrieveCallsPerPr,
  })
  const githubContext = scmProvider === "github"
  const namespace = indexNamespace(owner, repo)
  // Cross-repo context. Resolved ONCE here as the UNION of (a) flag-gated
  // automatic siblings whose owner-scoped index manifests are intersected with
  // this exact installation's D1 repo set and (b) the Linear team's EXPLICITLY
  // configured repo set for this repo (always honored — explicit config is the
  // admin's opt-in, not gated behind auto-discovery). `[]` means unchanged
  // single-repo retrieval; the resolver bounds and logs only aggregate counts.
  const crossRepoNamespaces = githubContext
    ? await resolveReviewCrossRepoNamespaces(env, installationId, owner, repo)
    : []
  const preflightQuery = `${meta.title}\n\n${meta.body ?? ""}`
  // Phase 4a.1: cap the pre-flight Vectorize round-trip so a slow
  // retrieval can't silently consume the synth budget. Failure here
  // is non-fatal (per v3.1 §8) — specialists fall back to empty
  // snapshot and may still use their role-specific context blocks.
  // Capture cache locally so the lambda below sees a non-null narrowing.
  const preflightCache = cache
  let preflightChunks: Awaited<ReturnType<typeof preflightCache.cachedRetrieve>>["chunks"] = null
  // SIG-110: perf-keyword retrieval. Kicked off HERE so it runs
  // CONCURRENTLY with the preflight below — both share the ≤15s cap +
  // orchCtrl.signal, so the perf query adds no critical-path wall-clock
  // (the orchestrator has only ~10s of static slack). Fires only when
  // the performance specialist is in the lineup AND the retrieve budget
  // has room for preflight + perf plus shared retrieval headroom
  // (`budgetRemaining() > 2` reads full budget here since the
  // cache consumes only after its internal cacheKey await — so this
  // means maxCalls >= 3, the default). The query seeds perf anti-pattern
  // vocabulary + changed function names so Vectorize lands on
  // perf-relevant code (single namespace → bias is via query terms, not
  // a separate index). Best-effort: never rejects, falls back to the
  // shared snapshot.
  const wantPerfRetrieval =
    githubContext && shouldRunPerfRetrieval(router.specialists, preflightCache.budgetRemaining())
  let perfQuery = ""
  let perfChunks: RetrievedChunk[] | null = null
  let perfRetrievalPromise: Promise<RetrievedChunk[] | null> | null = null
  if (wantPerfRetrieval) {
    perfQuery = buildPerfRetrievalQuery(preflightQuery, extractChangedFunctionNames(diff))
    perfRetrievalPromise = withComposedTimeout(
      () =>
        preflightCache.cachedRetrieve({
          caller: "specialist:performance",
          query: perfQuery,
          namespace,
          fetcher: () => retrieveChunks({ text: perfQuery, teamKey: namespace, env, crossRepoNamespaces }),
        }),
      RETRIEVAL_PREFLIGHT_TIMEOUT_MS,
      orchCtrl.signal,
    )
      .then((r) => r.chunks)
      .catch(() => null)
  }
  // SIG-44: multi-corpus retrieval (prior merged PRs + Linear issues).
  // Kicked off HERE so its embed+query runs CONCURRENTLY with the
  // preflight/perf retrieval above. Best-effort: never rejects (the
  // function soft-fails per leg, and we add a defensive .catch). Flag-gated
  // (default off); the result is appended to the shared snapshot AFTER the
  // branch-aware merge block below so the merge can't clobber it.
  const wantMultiCorpus = githubContext && multiCorpusEnabled(env)
  const multiCorpusPromise: Promise<MultiCorpusResult> | null = wantMultiCorpus
    ? retrieveMultiCorpus(env, owner, repo, preflightQuery, { prNumber, headSha }).catch(() => ({
        pr: [],
        issue: [],
      }))
    : null
  // ARC-284: phase-completed event always emits (even on the catch
  // path) so a 15s pre-flight cap-hit shows up in the trace.
  const preflightStartMs = Date.now()
  try {
    if (githubContext) {
      const preflight = await withComposedTimeout(
        () =>
          preflightCache.cachedRetrieve({
            caller: "preflight",
            query: preflightQuery,
            namespace,
            fetcher: () => retrieveChunks({ text: preflightQuery, teamKey: namespace, env, crossRepoNamespaces }),
          }),
        RETRIEVAL_PREFLIGHT_TIMEOUT_MS,
        orchCtrl.signal,
      )
      preflightChunks = preflight.chunks
    }
  } catch (err) {
    // If the orchestrator's outer signal aborted, propagate — that's a
    // genuine internal_error, not a pre-flight timeout.
    if (orchCtrl.signal.aborted) throw err
    // Pre-flight-only timeout / error. The cache itself wraps the
    // fetcher in its own try/catch so its log will eventually capture
    // the fetcher's outcome (success/error) once the background call
    // settles — we just stop awaiting it and proceed with an empty
    // snapshot. Total wall-clock vs. the cache log's elapsedMs lets
    // post-hoc analysis distinguish "we gave up at 15s" from "fetcher
    // threw a hard error".
    preflightChunks = null
  } finally {
    emitPhaseCompleted(perfCtx, "preflight_retrieval", preflightStartMs)
  }
  let retrievalSnapshot = preflightChunks ? (formatChunksForPrompt(preflightChunks) ?? "") : ""
  // SIG-110: resolve the perf-specific snapshot. Awaited AFTER the
  // preflight (both already ran concurrently), so this adds no extra
  // wall-clock. The inner promise never rejects (`.catch(() => null)`
  // above); empty / skipped perf retrieval falls back to the shared
  // snapshot so the performance specialist is never worse off than the
  // other roles. NOTE: this is the one intentional exception to the
  // "all specialists see the same retrieval snapshot" invariant — only
  // the performance role gets a perf-biased view.
  // (On the orchCtrl-abort path the preflight `await` above re-throws
  // before we reach here, so `perfRetrievalPromise` is intentionally
  // abandoned — it carries `.catch(() => null)` and shares
  // orchCtrl.signal, so it aborts cleanly with no unhandled rejection.)
  let perfRetrievalSnapshot = retrievalSnapshot
  if (perfRetrievalPromise) {
    perfChunks = await perfRetrievalPromise
    const formattedPerf = perfChunks ? (formatChunksForPrompt(perfChunks) ?? "") : ""
    const perfRetrievalUsed = formattedPerf.length > 0
    perfRetrievalSnapshot = resolvePerfSnapshot(formattedPerf, retrievalSnapshot)
    // Bake-off signal: did the perf-biased snapshot actually differ
    // from the shared one, or did we fall back? (SIG-110 → SIG-86.)
    console.log(
      JSON.stringify({
        event: "pr-review-perf-retrieval",
        owner,
        repo,
        prNumber,
        headSha: headSha.slice(0, 7),
        used: perfRetrievalUsed,
      }),
    )
  }

  // ─── ARC-186: dependency-vulnerability scan ────────────────
  // Runs after secret-scan + deterministic-checks but BEFORE the
  // specialist fanout. Findings are pre-LLM facts injected alongside
  // the other deterministic blocks.
  const depVulnEnabled = sigilixConfig.depVulnScan?.enabled !== false
  const baseShaForDepVuln = meta.base?.sha ?? ""
  const depVulnStartedAtMs = Date.now()
  const depVulnResult = await runDepVulnScan({
    env,
    client,
    owner,
    repo,
    prNumber,
    headSha,
    baseSha: baseShaForDepVuln,
    enabled: depVulnEnabled,
  })
  const depVulnFindings = depVulnResult.skipped ? [] : depVulnResult.findings
  const depVulnBlock = renderDepVulnFindingsForPrompt(depVulnFindings)
  telemetry.depVulnScan = depVulnResult.skipped
    ? { skipped: true, reason: depVulnResult.reason, findingsCount: 0 }
    : {
        skipped: false,
        findingsCount: depVulnResult.findings.length,
        depsScanned: depVulnResult.depsScanned,
        manifestsScanned: depVulnResult.manifestsScanned,
      }
  // SIG-374: sub-span timing inside the context-gather lump (sizes SIG-373).
  emitSubphaseCompleted(perfCtx, "dep_vuln_scan", depVulnStartedAtMs, {
    skipped: depVulnResult.skipped,
    findingsCount: depVulnFindings.length,
    ...(depVulnResult.skipped ? {} : { manifestsScanned: depVulnResult.manifestsScanned }),
  })

  // ─── ARC-181: AST rule-pack scan ────────────────────────────
  // Pre-LLM AST scan over pathFiltered JS/TS files.
  const astRulesConfig = resolveAstRulesConfig(sigilixConfig)
  const jsTsPaths = filePaths.filter((p) => /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i.test(p))
  // SIG-121: decide symbol retrieval up front — it also needs JS/TS sources
  // for AST symbol extraction, so the fetch below must run when EITHER AST
  // rules or symbol retrieval may run. Otherwise disabling `astRules` in
  // sigilix.json would silently starve symbol retrieval even with
  // OPENCLAW_SYMBOL_RETRIEVAL=on. Budget is read here, before the fetch; no
  // retrieval consumes between here and the block below, so the value is
  // identical to reading it at the block.
  const wantSymbolRetrieval =
    githubContext &&
    shouldRunSymbolRetrieval(ensembleConfig.flags.symbolRetrieval, router.specialists, preflightCache.budgetRemaining())
  const wantBranchAware =
    githubContext && (ensembleConfig.flags.branchAwareRetrieval ?? "").trim().toLowerCase() === "on"
  // Provider-neutral: cards are derived from the current diff + current-file
  // reads through the injected SCM client. GitHub-backed retrieval/graph inputs
  // are already empty for non-GitHub reviews, so GitLab keeps local MR evidence.
  const wantDynamicReviewEvidence = dynamicReviewEvidenceEnabled(env)
  // SIG-317 Part 4b: the asymmetry injector needs the changed-files corpus too
  // (CodeRabbit #308 — else `on`/`shadow` silently no-ops when astRules is off).
  const asymmetryMode = ensembleConfig.flags.asymmetryHints
  const toctouMode = ensembleConfig.flags.toctouHints
  // Cross-cutting over-fire Option B: the window-blindness gate reads the full
  // file from `astFilesByPath` to find a guard the model never saw. It must
  // trigger the fetch itself (CodeRabbit #329) — else, if every OTHER
  // AST/symbol feature is off, the map stays empty and the gate silently
  // fail-opens (keeps) on every finding, i.e. becomes a no-op.
  const wantWindowBlindness = ensembleConfig.validatorModes.windowBlindnessValidatorMode !== "off"
  // SIG-328: the logic-claim refutation gate also needs the full-file source
  // map for its AST proof — trigger the fetch so it can't silently no-op (and
  // mis-read as "0 would-drops") if the other AST features are ever flipped off.
  const wantLogicClaimRefutation = ensembleConfig.validatorModes.logicClaimRefutationMode !== "off"
  // SIG-477 PR-4b: the reproduce pass reconstructs the buggy + fixed FUNCTION from
  // the full-file source (findings cite only line-level fragments), so it needs this
  // map populated whenever reproduce is on — else it can't lift a function pair and
  // every pure-logic finding records `not-liftable-closure`.
  const wantReproduce = ensembleConfig.flags.reproduceMode !== "off"
  const astFilesByPath = new Map<string, string>()
  if (
    (astRulesConfig.enabled ||
      wantSymbolRetrieval ||
      wantBranchAware ||
      wantDynamicReviewEvidence ||
      asymmetryMode !== "off" ||
      toctouMode !== "off" ||
      wantWindowBlindness ||
      wantLogicClaimRefutation ||
      wantReproduce) &&
    jsTsPaths.length > 0
  ) {
    const astFetchStartedAtMs = Date.now()
    const fetchResults = await mapWithConcurrency(jsTsPaths, 5, async (p) => {
      const src = await client.getFileContent(owner, repo, p, headSha)
      return { p, src }
    })
    let astBytesFetched = 0
    for (const r of fetchResults) {
      if (r.status === "fulfilled" && typeof r.value.src === "string") {
        astFilesByPath.set(r.value.p, r.value.src)
        astBytesFetched += r.value.src.length
      }
    }
    // SIG-374: source fetch only — parsing is lazy in the AST consumers
    // (covered by deterministic_scans), hence "ast_source_fetch".
    emitSubphaseCompleted(perfCtx, "ast_source_fetch", astFetchStartedAtMs, {
      filesCount: astFilesByPath.size,
      bytesFetched: astBytesFetched,
    })
  }

  // SIG-336: one parse-once AST cache for the whole review. Every acorn
  // consumer below (runAstRules, durableObjectClassSpans, detectHelperCoverage,
  // the graph expansion, and the logic-claim refutation gate) shares it, so a
  // given file is parsed at most once per review instead of once per subsystem
  // (and once per finding). The shared 500KB guard rides along.
  const astCache = createAstCache()

  // SIG-129: build the branch retrieval set ONCE (best-effort), reused
  // across the preflight / perf / symbol merges. Empty set ⇒ every merge
  // is a no-op ⇒ identical to today's main-only behavior.
  let branchVectors: BranchVector[] = []
  let branchSetElapsedMs = 0
  if (shouldRunBranchAwareRetrieval(ensembleConfig.flags.branchAwareRetrieval, astFilesByPath)) {
    const startMs = Date.now()
    try {
      branchVectors = await withComposedTimeout(
        () => prepareBranchSet(env.AI, astFilesByPath),
        RETRIEVAL_PREFLIGHT_TIMEOUT_MS,
        orchCtrl.signal,
      )
    } catch (err) {
      // Genuine orchestrator cancellation propagates; a slow/stuck embed
      // degrades to main-only retrieval (empty branch set).
      if (orchCtrl.signal.aborted) throw err
      branchVectors = []
    }
    branchSetElapsedMs = Date.now() - startMs
  }
  // SIG-129 tombstone set: every changed JS/TS file is stale on `main`, so
  // its main-index chunks must be dropped from each merge regardless of
  // whether a branch chunk for it surfaced in the retrieved top-K.
  const changedPaths: ReadonlySet<string> = new Set(jsTsPaths)

  // Branch-aware merge for one pass: embed the pass's query (single text,
  // best-effort) and overlay branch chunks on the main chunks. Returns the
  // main chunks unchanged when branch-aware is off / the set is empty / the
  // query embed fails. Records the per-pass head-override count (stale main
  // chunks removed by the changed-path tombstone) for shadow telemetry.
  const branchMergeStats = { preflight: 0, perf: 0, symbol: 0 }
  const branchAwareMerge = async (
    mainChunks: RetrievedChunk[] | null,
    queryText: string,
    pass: keyof typeof branchMergeStats,
  ): Promise<RetrievedChunk[] | null> => {
    if (branchVectors.length === 0 || !mainChunks) return mainChunks
    let qVec: number[]
    // Cap the query embed input (chars) so a pathological query can't blow
    // the embedder's context — mirrors retrieval.ts's 4k query slice.
    try {
      qVec = await withComposedTimeout(
        () => embedText(env.AI, queryText.slice(0, 4_000)),
        RETRIEVAL_PREFLIGHT_TIMEOUT_MS,
        orchCtrl.signal,
      )
    } catch (err) {
      // Genuine orchestrator cancellation must propagate (matches the
      // preflight/symbol passes); any other embed failure/timeout degrades
      // to main-only retrieval.
      if (orchCtrl.signal.aborted) throw err
      return mainChunks
    }
    const branchChunks = retrieveBranchChunks(qVec, branchVectors, TOP_K_BRANCH)
    // Cross-repo sibling chunks are exempt from the changed-path tombstone
    // (see mergeBranchAware), so don't count them as head-overrides either.
    branchMergeStats[pass] = mainChunks.filter((c) => c.repo === undefined && changedPaths.has(c.path)).length
    return mergeBranchAware(mainChunks, branchChunks, changedPaths)
  }

  // Re-merge the SHARED preflight snapshot (seen by every specialist) and
  // the perf snapshot now that branchVectors exists. No-op when the set is
  // empty. The symbol pass merges itself in its own block below.
  let sharedChunksForOverlap: RetrievedChunk[] = preflightChunks ?? []
  if (branchVectors.length > 0) {
    const preflightMerged = await branchAwareMerge(preflightChunks, preflightQuery, "preflight")
    sharedChunksForOverlap = preflightMerged ?? []
    retrievalSnapshot = preflightMerged ? (formatChunksForPrompt(preflightMerged) ?? "") : ""

    if (perfChunks) {
      const perfMerged = await branchAwareMerge(perfChunks, perfQuery, "perf")
      const formattedPerf = perfMerged ? (formatChunksForPrompt(perfMerged) ?? "") : ""
      perfRetrievalSnapshot = resolvePerfSnapshot(formattedPerf, retrievalSnapshot)
    } else {
      perfRetrievalSnapshot = retrievalSnapshot
    }
  }

  // SIG-44: append the multi-corpus (prior PRs + Linear issues) section to
  // the shared + perf snapshots. Done HERE — after the branch-aware merge's
  // reassignments — so it can't be overwritten. Awaited now; it ran
  // concurrently with preflight so this adds no critical-path wall-clock.
  // The logic role inherits this via its shared snapshot; the SIG-236 logic
  // prompt budget still trims if needed (formatMultiCorpusForPrompt is
  // already bounded to ~6K chars).
  if (multiCorpusPromise) {
    const mc = await multiCorpusPromise
    const block = formatMultiCorpusForPrompt(mc) ?? ""
    if (block.length > 0) {
      const section = `[PRIOR PRS & ISSUES]\n${block}`
      retrievalSnapshot = retrievalSnapshot ? `${retrievalSnapshot}\n\n${section}` : section
      perfRetrievalSnapshot = perfRetrievalSnapshot ? `${perfRetrievalSnapshot}\n\n${section}` : section
    }
  }

  // SIG-121: symbol-based retrieval for the LOGIC specialist (flag-gated,
  // best-effort). Fires HERE — after astFilesByPath is built (it needs the
  // file SOURCES for AST symbol extraction) and before the specialist
  // fanout. Unlike SIG-110's perf retrieval (concurrent with preflight),
  // this can't run at preflight time because the sources don't exist yet.
  // Budget-aware, ≤15s cap, non-fatal (empty snapshot on failure; rethrow
  // only on orchCtrl abort). AUGMENTS — never replaces — the logic role's
  // shared snapshot via mergeLogicSnapshot below.
  //
  // BUDGET NOTE: the gate (shouldRunSymbolRetrieval) requires
  // budgetRemaining() > 1 — checked HERE, after preflight (and perf, if
  // any) have already consumed. At the default maxCalls=3: a logic-only PR
  // leaves budgetRemaining()=2 → symbol fires (1 reserved for synth); a PR
  // that ALSO ran a perf pass leaves 1 → symbol defers (perf + symbol are
  // mutually exclusive at the default budget). Raise
  // OPENCLAW_ENSEMBLE_MAX_RETRIEVE_CALLS_PER_PR (≥4) to run both — relevant
  // when enabling this flag for the SIG-86 bake-off.
  let logicSymbolSnapshot = ""
  let symbolOverlap: ReturnType<typeof computeChunkOverlap> | null = null
  let symbolRetrievalElapsedMs = 0
  let symbolQueryCount = 0
  let symbolInjected = false
  if (wantSymbolRetrieval) {
    const changedLines = buildChangedLines(diff)
    const symbols = extractChangedSymbols(astFilesByPath, changedLines)
    symbolQueryCount = symbols.length
    const symbolQuery = buildSymbolRetrievalQuery(symbols)
    if (symbolQuery.length > 0) {
      const startMs = Date.now()
      let symbolChunks: RetrievedChunk[] | null = null
      try {
        const r = await withComposedTimeout(
          () =>
            preflightCache.cachedRetrieve({
              caller: "specialist:logic-symbol",
              query: symbolQuery,
              namespace,
              fetcher: () => retrieveChunks({ text: symbolQuery, teamKey: namespace, env }),
            }),
          RETRIEVAL_PREFLIGHT_TIMEOUT_MS,
          orchCtrl.signal,
        )
        symbolChunks = await branchAwareMerge(r.chunks, symbolQuery, "symbol")
      } catch (err) {
        if (orchCtrl.signal.aborted) throw err
        symbolChunks = null
      }
      symbolRetrievalElapsedMs = Date.now() - startMs
      const formatted = symbolChunks ? (formatChunksForPrompt(symbolChunks) ?? "") : ""
      if (formatted.length > 0) {
        logicSymbolSnapshot = formatted
        symbolInjected = true
      }
      symbolOverlap = computeChunkOverlap(sharedChunksForOverlap, symbolChunks ?? [])
    }
    // Bake-off signal (SIG-121 → SIG-86): how different is the
    // symbol-derived snapshot from the shared one?
    console.log(
      JSON.stringify({
        event: "pr-review-symbol-retrieval",
        owner,
        repo,
        prNumber,
        headSha: headSha.slice(0, 7),
        query_symbol_count: symbolQueryCount,
        injected: symbolInjected,
        elapsed_ms: symbolRetrievalElapsedMs,
        budget_remaining: preflightCache.budgetRemaining(),
        shared_chunks: symbolOverlap?.sharedCount ?? 0,
        symbol_chunks: symbolOverlap?.symbolCount ?? 0,
        intersection: symbolOverlap?.intersectionCount ?? 0,
        jaccard: symbolOverlap?.jaccard ?? 0,
      }),
    )
  }

  // SIG-129 → SIG-86 bake-off signal. Flag-off ⇒ branchVectors empty ⇒
  // logs zeros and nothing changed in the snapshots.
  if (wantBranchAware) {
    console.log(
      JSON.stringify(
        buildBranchRetrievalEvent({
          owner,
          repo,
          prNumber,
          headSha,
          branchChunkCount: branchVectors.length,
          embedElapsedMs: branchSetElapsedMs,
          headOverride: branchMergeStats,
        }),
      ),
    )
  }

  return {
    cache,
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
  }
}
