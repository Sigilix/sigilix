// SIG-318 (PR 12g-2) — the GATHER-GRAPH seam of the PR-review orchestrator (app
// layer, context-build phase). Carved verbatim from `handlePrReviewEnsemble`,
// between the symbol-retrieval bake-off log and the "Fan out specialists" prompt
// assembly: the SIG-138 Phase 2 graph-expansion retrieval + blast radius + the
// graph-context prompt block, the SIG-286 graph-context body expansion + the
// CONTROL-vs-TREATMENT A/B inject, `runAstRules` + the 10 deterministic AST
// scan-gate stanzas, the ARC-188 SARIF evidence channel + the SIG-184 runner-
// evidence consumption + the SIG-285 v2 receipt-join HEAD-scan index, and the
// ARC-272 docs-coverage / SIG-110 perf-budgets / SIG-118 coverage-diff checks.
//
// The retrieval/graph split (gather-evidence ↔ gather-graph) keeps each file under
// 1k lines. It returns `runnerEvidenceBadge` + `deterministicCheckAnnotations` so
// the orchestrator's two pre-try `let`s (read by the posted finalize() badge
// rendering) are reassigned. The moved statements are byte-identical apart from the
// plumbing (`args.X` → params, declarations → returns). ZERO behavior change.
//
// Dependency rule: every dependency imports from its canonical NON-god-file home
// (incl. the relocated graph-context-format + ast-scan-gate domains). It never
// imports the orchestrator god-file.

import type { Env } from "@/shared/types/env"
import { GitHubClient } from "@/shared/adapters/github"
import type { CheckRunAnnotation } from "@/shared/types/github"
import type { RetrievedChunk } from "../../../retrieval"
import { extractChangedSymbols } from "../../../symbol-retrieval"
import { buildChangedLines } from "@/features/ast-rules"
import { withComposedTimeout } from "../../../agent-loop"
import {
  resolveAstRulesConfig,
  resolveDocsReviewConfig,
  resolveCoverageConfig,
  resolvePerfBudgetsConfig,
  resolveSarifEvidenceConfig,
  type SigilixConfig,
} from "../../../sigilix-config"
import { runAstRules, type AstCache } from "@/features/ast-rules"
import {
  runDocsCoverageCheck,
  type DocsCoverageHit,
} from "../../../docs-coverage-check"
import {
  runPerfBudgetsCheck,
  type PerfBudgetsHit,
} from "@/shared/domain/perf-budgets"
import { ingestCoverage } from "../../../coverage-ingest"
import {
  runSarifEvidence,
  type SarifFinding,
  parseSarif,
  normalizeSarifPath,
  renderSarifFindingsForPrompt,
  buildSarifCheckAnnotations,
} from "@/features/sarif-evidence"
import { lookupRunnerEvidence, readRunnerEvidenceMode, type RunnerEvidenceState } from "../../../runner-evidence/lookup"
import { recordRunnerEvidenceMetric } from "../../../runner-evidence-metrics-client"
import {
  buildReceiptIndex,
  extractReceiptScanResults,
  type ReceiptScanResult,
} from "../../../verification/verify-finding-receipt"
import { graphContextFor, blastRadiusByNamesFor } from "../../../repo-graph-client"
import { contextExpansionForChangedSymbolsFor } from "../../../repo-graph-client"
import {
  buildGraphContextExpansion,
  renderGraphExpansionForPrompt,
  netNewCrossFileBodies,
} from "../../../graph-context-expansion"
import type { GraphRetrievalSample } from "@/do/graph-metrics"
import type { GraphExpansionSample } from "@/do/graph-expansion-metrics"
import { graphExpansionMode, injectArm } from "../../../graph-expansion-mode"
import type { GraphContextNode } from "@/do/repo-graph"
import { edgeWeight, hopDecay } from "../../../graph-scoring"
import { withTimeout } from "@/shared/util/with-timeout"
import { GRAPH_EXPANSION_TIMEOUT_MS } from "../../domain/budget"
import type { EnsembleConfig } from "../../domain/config"
import {
  GRAPH_BLAST_PROMPT_CAP,
  graphRetrievalEnabled,
  graphRetrievalMode,
  formatGraphContext,
  formatGraphBlastContext,
  graphOverlapStats,
} from "../../domain/graph-context-format"
import { applyAstScanGate } from "../../domain/ast-scan-gate"

type AstResult = Awaited<ReturnType<typeof runAstRules>>
type AstRulesConfig = ReturnType<typeof resolveAstRulesConfig>
type SarifResult = Awaited<ReturnType<typeof runSarifEvidence>>
type CoverageResult = Awaited<ReturnType<typeof ingestCoverage>>
type ReviewableMap = Parameters<typeof runAstRules>[0]["reviewable"]
type SplitFile = { path: string }

/**
 * The telemetry slice `gatherGraphEvidence` writes by reference: the SIG-286
 * graph-expansion A/B arm, the AST-rules rollup, and the SARIF-evidence rollup.
 * The orchestrator's telemetry object satisfies it.
 */
export interface GatherGraphTelemetry {
  graphExpansionAb?: { arm: "treatment" | "control" }
  astRules?:
    | {
        scanned: true
        filesScanned: number
        filesSkippedLarge: number
        filesParseFailed: number
        findingsCount: number
        durationMs: number
      }
    | { scanned: false; skipReason?: string; findingsCount: number }
  sarifEvidence?:
    | { skipped: true; reason: import("@/features/sarif-evidence").ScanSkipReason; findingsCount: number }
    | { skipped: false; findingsCount: number; truncatedCount: number; durationMs: number }
}

export interface GatherGraphArgs {
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  headSha: string
  /** SIG-184 PR 3 / SIG-285 v2 PR1: the immutable repo.id keying the receipt lookup. */
  repoId?: number
  ensembleConfig: EnsembleConfig
  meta: { merge_commit_sha?: string | null }
  sigilixConfig: SigilixConfig
  diff: string
  fullDiff: string
  wasTruncated: boolean
  reviewable: ReviewableMap
  filePaths: string[]
  splitFiles: SplitFile[]
  /** From gather-evidence: the merged shared hit set seeding the graph BFS. */
  sharedChunksForOverlap: RetrievedChunk[]
  astFilesByPath: Map<string, string>
  astCache: AstCache
  astRulesConfig: AstRulesConfig
  orchCtrl: AbortController
  /** SIG-152: the dispatcher's single-sample graph-retrieval sink. */
  graphMetricsSink?: GraphRetrievalSample[]
  /** SIG-286 PR2.5: the dispatcher's single-sample graph-expansion sink. */
  graphExpansionMetricsSink?: GraphExpansionSample[]
  /** Mutated by reference: graphExpansionAb / astRules / sarifEvidence writes. */
  telemetry: GatherGraphTelemetry
}

export interface GatherGraphResult {
  graphContextNodesForEvidence: GraphContextNode[]
  graphBlastCallerPaths: string[]
  graphBlastDependentPaths: string[]
  graphCtxForPrompt: string
  astResult: AstResult
  sarifFindings: readonly SarifFinding[]
  sarifResult: SarifResult
  sarifBlock: string
  /** The orchestrator's pre-try `runnerEvidenceBadge` let is reassigned to this. */
  runnerEvidenceBadge: "verified" | "evidence-pending" | undefined
  /** The orchestrator's pre-try `deterministicCheckAnnotations` let is reassigned to this. */
  deterministicCheckAnnotations: CheckRunAnnotation[] | undefined
  receiptScanIndex: Map<string, ReceiptScanResult[]> | null
  docsCoverageHit: DocsCoverageHit | null
  perfBudgetsHit: PerfBudgetsHit | null
  coverageResult: CoverageResult
  coverageGapSet: Set<string>
  /** The SIG-285 v2 receipt-join mode the orchestral verify-and-build call still reads. */
  receiptJoinMode: EnsembleConfig["flags"]["receiptJoinMode"]
}

export async function gatherGraphEvidence(a: GatherGraphArgs): Promise<GatherGraphResult> {
  const {
    env,
    client,
    owner,
    repo,
    prNumber,
    headSha,
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
    telemetry,
  } = a
  // Pre-try let the SARIF/runner block assigns conditionally (mirrors the
  // orchestrator's function-scoped `runnerEvidenceBadge`). The Lane-A
  // `deterministicCheckAnnotations` is built unconditionally below from the SARIF
  // findings, so it lands as a plain `const` at its assignment site (the
  // orchestrator's pre-try `let` is reassigned from this module's return).
  let runnerEvidenceBadge: "verified" | "evidence-pending" | undefined = undefined
    // ─── SIG-138 Phase 2: graph-expansion retrieval ────────────────────
    //
    // Gated by OPENCLAW_GRAPH_RETRIEVAL=shadow|post. Off ⇒ no DO calls,
    // no behavior change. Any error in this block is caught and logged;
    // the review always proceeds unaffected (graph is additive context).
    //
    // shadow: compute everything for telemetry; do NOT attach graphContext
    //   to posted prompts.
    // post:   attach graphContext to logic + tests specialists + synth.
    //
    // SIG-143: blast radius is driven by the PR's changed symbol NAMES
    // (extractChangedSymbols), which the DO resolves to symbol_ids in the
    // active graph version (blastRadiusByNames). Names are extracted here
    // independently of the symbol-retrieval block above (that block is gated
    // on a separate budget flag and may not run). Both helpers are pure.
    let graphContextString = ""
    let graphNodePaths: string[] = []
    let graphContextNodesForEvidence: GraphContextNode[] = []
    // M2: keep caller + import-dependent counts separate for telemetry;
    // graph-context injection can use a combined set.
    let graphBlastCallerPaths: string[] = []
    let graphBlastDependentPaths: string[] = []
    // SIG-143: blast paths folded into the prompt graph-context block (post mode).
    let graphBlastContextString = ""
    if (graphRetrievalEnabled(env)) {
      const graphRpcBudgetMs = ensembleConfig.tunables.graphRpcTimeoutMs
      try {
        // Seed from deduplicated chunk paths of the merged hit set.
        const seedPaths = [...new Set(sharedChunksForOverlap.map((c) => c.path))]
        // Wrap in withTimeout so a slow DO RPC cannot consume orchestrator wall
        // time.  AbortSignal is unused by the DO stub but required by the helper
        // signature.  On timeout the helper aborts and rejects; the outer catch
        // below handles it and skips graph context gracefully.
        const { nodes } = await withTimeout(
          (_signal) => graphContextFor(env, owner, repo, {
            seedPaths,
            maxFiles: 8,
            maxSymbolsPerHit: 12,
            maxEdgesPerSymbol: 6,
          }),
          graphRpcBudgetMs,
        )
        // Cap graph-only additions to ≤4 nodes per spec.
        // Sort: hop asc, then edge weight desc (higher weight = stronger edge).
        const cappedNodes = nodes
          .slice()
          .sort((a, b) => {
            const hopDiff = a.hop - b.hop
            if (hopDiff !== 0) return hopDiff
            return edgeWeight(b.edgeKind) * hopDecay(b.hop) -
                   edgeWeight(a.edgeKind) * hopDecay(a.hop)
          })
          .slice(0, 4)
        graphContextString = formatGraphContext(cappedNodes)
        graphNodePaths = cappedNodes.map((n) => n.path)
        graphContextNodesForEvidence = cappedNodes

        // Blast radius (SIG-143): resolve the PR's changed symbol names in the
        // active graph version → caller + import-dependent files. Names come
        // from the diff via the same pure helpers the symbol-retrieval block
        // uses; resolution is scoped to the changed JS/TS files (astFilesByPath
        // keys) as a name-collision guard. Empty input fast-paths inside the DO.
        const changedGraphNames = extractChangedSymbols(astFilesByPath, buildChangedLines(diff))
        const changedGraphPaths = [...astFilesByPath.keys()]
        // Isolated try: a blast RPC timeout/error must NOT discard the graph
        // context already built above from graphContextFor (the outer catch
        // clears it). Blast radius is additive on top of the BFS neighbors.
        try {
          const blast = await withTimeout(
            (_signal) => blastRadiusByNamesFor(env, owner, repo, {
              changedNames: changedGraphNames,
              changedPaths: changedGraphPaths,
            }),
            graphRpcBudgetMs,
          )
          // M2: preserve caller vs import-dependent distinction for telemetry.
          graphBlastCallerPaths = [...new Set(blast.callerPaths)]
          graphBlastDependentPaths = [...new Set(blast.importDependents)]
          // SIG-143: fold blast paths into the graph context that reaches the
          // specialists (AC), excluding paths already covered by vector-hit
          // seeds or BFS neighbors. Capped for prompt size.
          graphBlastContextString = formatGraphBlastContext({
            callerPaths: graphBlastCallerPaths,
            dependentPaths: graphBlastDependentPaths,
            exclude: new Set([...seedPaths, ...graphNodePaths]),
            cap: GRAPH_BLAST_PROMPT_CAP,
          })
        } catch (blastErr) {
          console.log(JSON.stringify({
            event: "pr-review-graph-blast-error",
            owner, repo, prNumber, headSha: headSha.slice(0, 7),
            error: blastErr instanceof Error ? blastErr.message : String(blastErr),
          }))
          graphBlastCallerPaths = []
          graphBlastDependentPaths = []
          graphBlastContextString = ""
        }

        // Bake-off telemetry: emit in both shadow and post so the SIG-86
        // analysis always has coverage data. Failure is non-fatal.
        const vectorSeedPaths = seedPaths
        const { jaccard, addedCount } = graphOverlapStats({
          vectorPaths: vectorSeedPaths,
          graphPaths: graphNodePaths,
        })
        // hop_distribution: count capped nodes per hop level.
        const hopDist: Record<string, number> = {}
        for (const n of cappedNodes) {
          const key = String(n.hop)
          hopDist[key] = (hopDist[key] ?? 0) + 1
        }
        // edge_type_distribution: count capped nodes per edgeKind.
        const edgeTypeDist: Record<string, number> = {}
        for (const n of cappedNodes) {
          edgeTypeDist[n.edgeKind] = (edgeTypeDist[n.edgeKind] ?? 0) + 1
        }
        console.log(JSON.stringify({
          event: "pr-review-graph-retrieval",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          mode: graphRetrievalMode(env),
          jaccard,
          added_count: addedCount,
          node_count: nodes.length,
          capped_node_count: cappedNodes.length,
          blast_caller_count: graphBlastCallerPaths.length,
          blast_dependent_count: graphBlastDependentPaths.length,
          hop_distribution: hopDist,
          edge_type_distribution: edgeTypeDist,
        }))
        // SIG-152: push the same sample to the dispatcher's sink so it lands in
        // GraphMetricsDO (curl-able via /metrics/graph). Telemetry-only — fires
        // in both shadow and post, matching the log event above.
        a.graphMetricsSink?.push({
          mode: graphRetrievalMode(env),
          jaccard,
          addedCount,
          nodeCount: nodes.length,
          cappedNodeCount: cappedNodes.length,
          blastCallerCount: graphBlastCallerPaths.length,
          blastDependentCount: graphBlastDependentPaths.length,
        })
      } catch (err) {
        // Non-fatal: graph expansion is additive. Log for observability.
        console.log(JSON.stringify({
          event: "pr-review-graph-retrieval-error",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          error: err instanceof Error ? err.message : String(err),
        }))
        graphContextString = ""
        graphNodePaths = []
        graphContextNodesForEvidence = []
        graphBlastCallerPaths = []
        graphBlastDependentPaths = []
        graphBlastContextString = ""
      }
    }
    // In post mode, inject graph context into logic+tests specialists
    // and synthesizer: BFS neighbors (graphContextString) plus the folded
    // blast-radius paths (graphBlastContextString). In shadow mode, the
    // variables are computed but not attached to prompts (bake-off telemetry
    // fires in both modes).
    // `let`: SIG-286 may APPEND a targeted cross-file expansion block below (in
    // OPENCLAW_GRAPH_EXPANSION=post mode) once `enriched` is computed.
    let graphCtxForPrompt = graphRetrievalMode(env) === "post"
      ? [graphContextString, graphBlastContextString].filter((s) => s.length > 0).join("\n")
      : ""
    // ──────────────────────────────────────────────────────────────────

    // ─── SIG-286: graph-context body expansion ─────────────────────────
    //
    // Gated by OPENCLAW_GRAPH_EXPANSION=shadow|post. Off ⇒ no DO call, no
    // telemetry, zero behavior change. Both modes COMPUTE the enriched
    // changed-symbol context (definition / caller / import-dependent bodies)
    // and emit the `graph-expansion-shadow` event. In `post` (PR1 targeted
    // inject) the net-new cross-file bodies are ALSO appended to
    // graphCtxForPrompt below; in `shadow` the result is measured-not-injected,
    // so graphCtxForPrompt stays the SIG-138-only graph block.
    //
    // Soft-fail: bounded by withComposedTimeout(orchCtrl.signal) + a catch that
    // emits `graph-expansion-shadow-error` and continues. It must NEVER block,
    // slow, or break the review.
    const graphExpMode = graphExpansionMode(env)
    if (graphExpMode !== "off") {
      try {
        // CodeRabbit: measure the WHOLE PR, not the prompt batch. astFilesByPath
        // is the full changed JS/TS set, but `diff` is truncated to maxPatchLength
        // — detect changed lines from `fullDiff` so we don't skip symbols past the
        // truncation (which would bias the shadow data low on large PRs).
        const changedExpNames = extractChangedSymbols(astFilesByPath, buildChangedLines(fullDiff))
        const changedExpPaths = [...astFilesByPath.keys()]
        const enriched = await withComposedTimeout(
          async (signal) => {
            const expansion = await contextExpansionForChangedSymbolsFor(env, owner, repo, {
              changedNames: changedExpNames,
              changedPaths: changedExpPaths,
            })
            return buildGraphContextExpansion({
              expansion,
              filesByPath: astFilesByPath,
              // SIG-286 PR2: bounded cross-file fetcher (≤6 distinct files,
              // concurrency 4, ALL inside the 3s soft-fail GRAPH_EXPANSION cap).
              // Reuses the in-scope GitHub client; getFileContent returns null on
              // 404/dir/>1MB and the pre-fetch wraps each call soft-fail so a
              // fetch error never blocks or breaks the (shadow, non-injected)
              // measurement. Turns the PR1 `missing` rows into real `github`
              // bodies → the CONTROL-vs-TREATMENT numbers that decide PR3.
              // Threads the composed-timeout `signal` so an in-flight cross-file
              // fetch CANCELS the moment the 3s expansion cap (or the
              // orchestrator) aborts — the batch is abort-aware mid-wave, not
              // just between waves (Sigilix + CodeRabbit).
              fetchFileContent: (path) => client.getFileContent(owner, repo, path, headSha, { signal }),
              signal,
            })
          },
          GRAPH_EXPANSION_TIMEOUT_MS,
          orchCtrl.signal,
        )
        console.log(JSON.stringify({
          event: "graph-expansion-shadow",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          mode: graphExpMode,
          // Surface diff truncation so analysis can exclude PRs where the changed
          // set may still be partial (large PRs) for a clean opportunity measurement.
          diffTruncated: wasTruncated,
          graphAvailable: enriched.graphAvailable,
          callerBodies: enriched.callerBodies.length,
          dependentBodies: enriched.dependentBodies.length,
          defBodies: enriched.definitionBodies.length,
          totalTokens: enriched.totalTokens,
          cappedAt: enriched.cappedAt,
          elapsedMs: enriched.elapsedMs,
          bodiesSource: enriched.bodiesSource,
          dropped: enriched.dropped,
          // SIG-286 PR2: CONTROL (no-fetch) vs TREATMENT (with cross-file fetch).
          // controlTokens = filesByPath-only; totalTokens above = treatment;
          // netNewTokens = the cross-file context gain the PR3 inject decision
          // keys off (GO ≈ median ≥ 800 + cross-file callers on >40% of reviews;
          // KILL < 500 or no cross-file caller context). `fetch` is the cost.
          controlTokens: enriched.control.tokens,
          netNewTokens: enriched.netNewTokens,
          fetch: enriched.fetch,
        }))
        // SIG-286 PR2.5: push the same sample to the dispatcher's sink so it
        // lands in GraphExpansionMetricsDO (curl-able via /metrics/graph-expansion,
        // the readable netNewTokens median the PR3 GO/KILL decision keys off).
        // Telemetry-only — fires in shadow and post, matching the log event.
        a.graphExpansionMetricsSink?.push({
          mode: graphExpMode,
          graphAvailable: enriched.graphAvailable,
          netNewTokens: enriched.netNewTokens,
          controlTokens: enriched.control.tokens,
          totalTokens: enriched.totalTokens,
          fetchEnabled: enriched.fetch.enabled,
          fetchFiles: enriched.fetch.files,
          fetchBytes: enriched.fetch.bytes,
          fetchElapsedMs: enriched.fetch.elapsedMs,
          budgetExhausted: enriched.fetch.budgetExhausted,
        })
        // SIG-286 PR1: in `post` mode, APPEND the targeted inject — net-new
        // cross-file definition/caller bodies — to the graph block reaching
        // logic+tests+synth. The render is "" for the ~73% of reviews with no
        // net-new cross-file context (the blanket-inject KILL set), so they
        // append nothing. `shadow` skips this ⇒ measured-but-not-injected, the
        // current prod behavior; only `post` injects.
        if (graphExpMode === "post") {
          const expansionBlock = renderGraphExpansionForPrompt(enriched)
          // SIG-286 PR2: A/B among reviews that WOULD inject. TREATMENT gets the
          // cross-file inject; CONTROL computes the identical context but does
          // NOT inject. Both arms record `graphExpansionAb` on the telemetry (it
          // rides into ensemble-review-telemetry alongside `synthesizer.verdict`),
          // so a per-arm finding-rate comparison (group by arm, count
          // `synthesizer.verdict.findings`) can read whether the inject catches
          // MORE real findings — the only honest FN measure, since the inject's
          // findings land on the diff (informed by cross-file context), not on
          // the snippets. Non-inject reviews (empty render) sit out the experiment.
          if (expansionBlock.length > 0) {
            const arm = injectArm(headSha)
            telemetry.graphExpansionAb = { arm }
            if (arm === "treatment") {
              graphCtxForPrompt = [graphCtxForPrompt, expansionBlock]
                .filter((s) => s.length > 0)
                .join("\n\n")
              // Observable so the inject is verifiable. Counts are the ACTUALLY-
              // injected net-new bodies (same selector as the render), not the
              // enriched totals (CodeRabbit #277).
              console.log(JSON.stringify({
                event: "graph-expansion-injected",
                owner, repo, prNumber, headSha: headSha.slice(0, 7),
                bytes: expansionBlock.length,
                bodiesInjected: netNewCrossFileBodies(enriched).length,
                netNewTokens: enriched.netNewTokens,
              }))
            }
          }
        }
      } catch (err) {
        // Genuine orchestrator cancellation propagates; any other failure is
        // soft — log and continue, never block the review.
        if (orchCtrl.signal.aborted) throw err
        console.log(JSON.stringify({
          event: "graph-expansion-shadow-error",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          mode: graphExpMode,
          error: err instanceof Error ? err.message : String(err),
        }))
      }
    }
    // ──────────────────────────────────────────────────────────────────

    const astResult = await runAstRules({
      diff,
      filesByPath: astFilesByPath,
      reviewable,
      config: astRulesConfig,
      ctx: { owner, repo, prNumber },
      astCache,
    })

    // SIG-314: shadow-first gating for the deterministic IDOR/BOLA floor
    // (no-unauthorized-object-lookup). The rule lives in ALL_RULES so it always
    // RUNS (the runner logs `ast-rules-finding` per hit for FP measurement), but
    // its emits reach the synth — and post — ONLY in `post` mode. `off` (the
    // default) strips them silently; `shadow` strips-but-logs a rollup so we can
    // read the firing + false-positive rate on dogfood + the e2e fixtures before
    // promoting. The rule is structurally P2-capped (clampAstEmitScores), so the
    // residual risk we're measuring is middleware-only-authz false positives,
    // never a P0/P1.
    // SIG-318 (PR 5a): env-derived settings come from the typed EnsembleConfig
    // resolved once at the top of the handler (parsed at the Worker edge and
    // injected via args; see resolveEnsembleConfig). The scanner gates below read
    // ensembleConfig.astScanModes.* — no inline env.OPENCLAW_* reads.
    const authzIdorMode = ensembleConfig.astScanModes.authzIdor
    if (authzIdorMode !== "post") {
      const authzEmits = astResult.findings.filter((f) => f.ruleId === "no-unauthorized-object-lookup")
      if (authzEmits.length > 0) {
        astResult.findings = astResult.findings.filter((f) => f.ruleId !== "no-unauthorized-object-lookup")
        // CodeRabbit #302: keep perFinding aligned — the auto-inline poster reads
        // it by astFindingId, so a stale entry would mis-anchor another comment.
        for (const f of authzEmits) astResult.perFinding.delete(f.astFindingId)
        if (authzIdorMode === "shadow") {
          console.log(JSON.stringify({
            event: "authz-idor-shadow",
            owner, repo, prNumber, headSha: headSha.slice(0, 7),
            count: authzEmits.length,
            anchors: authzEmits.map((f) => `${f.path}:${f.line}`),
          }))
        }
      }
    }
    // Shadow-first gating for the deterministic weak-randomness floor
    // (no-insecure-random-token, CWE-338) — same off/shadow/post contract as the
    // IDOR floor above. The rule always RUNS (logged per hit for FP measurement);
    // its emits reach synth/post ONLY in `post`. `off` (default) strips silently;
    // `shadow` strips-but-logs a rollup so we can read the firing + FP rate on
    // dogfood before promoting. Structurally P2-capped (clampAstEmitScores).
    const weakRandomMode = ensembleConfig.astScanModes.weakRandom
    if (weakRandomMode !== "post") {
      const weakRandomEmits = astResult.findings.filter((f) => f.ruleId === "no-insecure-random-token")
      if (weakRandomEmits.length > 0) {
        astResult.findings = astResult.findings.filter((f) => f.ruleId !== "no-insecure-random-token")
        // Keep perFinding aligned (the auto-inline poster reads it by astFindingId).
        for (const f of weakRandomEmits) astResult.perFinding.delete(f.astFindingId)
        if (weakRandomMode === "shadow") {
          console.log(JSON.stringify({
            event: "weak-random-token-shadow",
            owner, repo, prNumber, headSha: headSha.slice(0, 7),
            count: weakRandomEmits.length,
            anchors: weakRandomEmits.map((f) => `${f.path}:${f.line}`),
          }))
        }
      }
    }
    // Shadow-first gating for the deterministic open-redirect floor
    // (no-open-redirect, CWE-601) — same off/shadow/post contract. Default off;
    // shadow strips-but-logs the firing + FP rate on dogfood before promoting.
    const openRedirectMode = ensembleConfig.astScanModes.openRedirect
    if (openRedirectMode !== "post") {
      const openRedirectEmits = astResult.findings.filter((f) => f.ruleId === "no-open-redirect")
      if (openRedirectEmits.length > 0) {
        astResult.findings = astResult.findings.filter((f) => f.ruleId !== "no-open-redirect")
        for (const f of openRedirectEmits) astResult.perFinding.delete(f.astFindingId)
        if (openRedirectMode === "shadow") {
          console.log(JSON.stringify({
            event: "open-redirect-shadow",
            owner, repo, prNumber, headSha: headSha.slice(0, 7),
            count: openRedirectEmits.length,
            anchors: openRedirectEmits.map((f) => `${f.path}:${f.line}`),
          }))
        }
      }
    }
    // Shadow-first gating for the deterministic SSRF floor (no-ssrf, CWE-918) —
    // same off/shadow/post contract. Default off; shadow strips-but-logs the
    // firing + FP rate on dogfood before promoting.
    const ssrfMode = ensembleConfig.astScanModes.ssrf
    if (ssrfMode !== "post") {
      const ssrfEmits = astResult.findings.filter((f) => f.ruleId === "no-ssrf")
      if (ssrfEmits.length > 0) {
        astResult.findings = astResult.findings.filter((f) => f.ruleId !== "no-ssrf")
        for (const f of ssrfEmits) astResult.perFinding.delete(f.astFindingId)
        if (ssrfMode === "shadow") {
          console.log(JSON.stringify({
            event: "ssrf-shadow",
            owner, repo, prNumber, headSha: headSha.slice(0, 7),
            count: ssrfEmits.length,
            anchors: ssrfEmits.map((f) => `${f.path}:${f.line}`),
          }))
        }
      }
    }
    // Shadow-first gating for the deterministic path-traversal floor
    // (no-path-traversal, CWE-22) — same off/shadow/post contract.
    const pathTraversalMode = ensembleConfig.astScanModes.pathTraversal
    const pathTraversalStripped = applyAstScanGate(astResult, "no-path-traversal", pathTraversalMode)
    if (pathTraversalMode === "shadow" && pathTraversalStripped.length > 0) {
      console.log(JSON.stringify({
        event: "path-traversal-shadow",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        count: pathTraversalStripped.length,
        anchors: pathTraversalStripped.map((a) => `${a.path}:${a.line}`),
      }))
    }
    // Shadow-first gating for the deterministic SQL-injection floor
    // (no-sql-injection, CWE-89) — same off/shadow/post contract.
    const sqlInjectionMode = ensembleConfig.astScanModes.sqlInjection
    const sqlInjectionStripped = applyAstScanGate(astResult, "no-sql-injection", sqlInjectionMode)
    if (sqlInjectionMode === "shadow" && sqlInjectionStripped.length > 0) {
      console.log(JSON.stringify({
        event: "sql-injection-shadow",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        count: sqlInjectionStripped.length,
        anchors: sqlInjectionStripped.map((a) => `${a.path}:${a.line}`),
      }))
    }
    // Shadow-first gating for the deterministic SSTI floor (no-ssti, CWE-1336).
    const sstiMode = ensembleConfig.astScanModes.ssti
    const sstiStripped = applyAstScanGate(astResult, "no-ssti", sstiMode)
    if (sstiMode === "shadow" && sstiStripped.length > 0) {
      console.log(JSON.stringify({
        event: "ssti-shadow",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        count: sstiStripped.length,
        anchors: sstiStripped.map((a) => `${a.path}:${a.line}`),
      }))
    }
    // Shadow-first gating for the deterministic NoSQL-injection floor
    // (no-nosql-injection, CWE-943) — same off/shadow/post contract.
    const nosqlInjectionMode = ensembleConfig.astScanModes.nosqlInjection
    const nosqlInjectionStripped = applyAstScanGate(astResult, "no-nosql-injection", nosqlInjectionMode)
    if (nosqlInjectionMode === "shadow" && nosqlInjectionStripped.length > 0) {
      console.log(JSON.stringify({
        event: "nosql-injection-shadow",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        count: nosqlInjectionStripped.length,
        anchors: nosqlInjectionStripped.map((a) => `${a.path}:${a.line}`),
      }))
    }
    // Shadow-first gating for the deterministic prototype-pollution floor
    // (no-prototype-pollution, CWE-1321) — same off/shadow/post contract.
    const protoPollutionMode = ensembleConfig.astScanModes.protoPollution
    const protoPollutionStripped = applyAstScanGate(astResult, "no-prototype-pollution", protoPollutionMode)
    if (protoPollutionMode === "shadow" && protoPollutionStripped.length > 0) {
      console.log(JSON.stringify({
        event: "proto-pollution-shadow",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        count: protoPollutionStripped.length,
        anchors: protoPollutionStripped.map((a) => `${a.path}:${a.line}`),
      }))
    }
    // Shadow-first gating for the deterministic XXE floor
    // (no-xxe, CWE-611) — same off/shadow/post contract.
    const xxeMode = ensembleConfig.astScanModes.xxe
    const xxeStripped = applyAstScanGate(astResult, "no-xxe", xxeMode)
    if (xxeMode === "shadow" && xxeStripped.length > 0) {
      console.log(JSON.stringify({
        event: "xxe-shadow",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        count: xxeStripped.length,
        anchors: xxeStripped.map((a) => `${a.path}:${a.line}`),
      }))
    }

    // SIG-108: AST findings are split by roleHint inside buildFactsByRole
    // (below) so each block reaches only its own specialist.
    telemetry.astRules = astResult.telemetry.scanned
      ? {
          scanned: true,
          filesScanned: astResult.telemetry.filesScanned,
          filesSkippedLarge: astResult.telemetry.filesSkippedLarge,
          filesParseFailed: astResult.telemetry.filesParseFailed,
          findingsCount: astResult.findings.length,
          durationMs: astResult.telemetry.durationMs,
        }
      : {
          scanned: false,
          ...(astResult.telemetry.skipReason ? { skipReason: astResult.telemetry.skipReason } : {}),
          findingsCount: 0,
        }

    // ─── ARC-188: SARIF evidence channel ──────────────────────
    // Reads `.sigilix/trivy.sarif.json` (or configured path) at PR
    // head; emits Trivy / Kubescape / generic SARIF v2.1.0 findings
    // as authoritative facts alongside the other deterministic
    // blocks. SBOM (when present) goes to the synth prompt only.
    const sarifConfig = resolveSarifEvidenceConfig(sigilixConfig)

    // SIG-184 PR 3: runner-evidence consumption (flag-gated; off by default →
    // fully inert). In shadow/post we look up the VERIFIED receipt by the SIGNED
    // join `(repoId, prNumber)` and BIND it to the PR's current merge commit
    // (`meta.merge_commit_sha` == the OIDC-signed sha) — the forge-proof key. In
    // `post` we feed the receipt's SARIF to the SAME pipeline via `rawOverride`.
    const runnerMode = readRunnerEvidenceMode(env)
    // SIG-285 v2 PR1: receipt-join shares the SAME verified-receipt lookup as
    // runner-evidence, so the lookup must fire when EITHER feature is on —
    // otherwise enabling OPENCLAW_RECEIPTJOIN_MODE alone (with runner-evidence
    // off) would silently no-op (CodeRabbit). The runner-evidence-specific
    // outputs (the trust-pill badge + the adoption metric) stay gated on
    // `runnerMode` below; only the shared lookup is decoupled.
    const receiptJoinMode = ensembleConfig.flags.receiptJoinMode
    let runnerEvidence: RunnerEvidenceState = { state: "runner-absent" }
    // SIG-285 v2 PR1: the verified receipt's UN-FILTERED HEAD-scan index, built
    // below + joined to findings after submission (receipt-join verification).
    // null = no receipt-join (mode off, or no verified receipt for this commit).
    let receiptScanIndex: Map<string, ReceiptScanResult[]> | null = null
    if ((runnerMode !== "off" || receiptJoinMode !== "off") && a.repoId !== undefined) {
      const mergeSha = meta.merge_commit_sha
      runnerEvidence = mergeSha
        ? await lookupRunnerEvidence(env, String(a.repoId), prNumber, mergeSha)
        : { state: "evidence-pending", reason: "merge-sha-unavailable" } // GitHub still computing the merge
      console.log(JSON.stringify({
        event: "runner-evidence-consume",
        owner, repo, prNumber,
        mode: runnerMode,
        receiptJoinMode,
        state: runnerEvidence.state,
        ...(runnerEvidence.state === "evidence-pending" ? { reason: runnerEvidence.reason } : {}),
      }))
    } else if (receiptJoinMode !== "off" && a.repoId === undefined) {
      // Receipt-join is on but this entry path has no repoId, so the receipt
      // lookup was skipped → telemeter so these reviews are distinguishable from
      // "feature off" / "no verified receipt" in the rollout denominator (CodeRabbit).
      console.warn(JSON.stringify({ event: "receiptjoin-skipped-no-repoid", owner, repo, prNumber }))
    }
    // SIG-184: record the trust state for the check-run badge. Only in `post`
    // mode — that's when the receipt actually backs the review (verified →
    // receipt SARIF via rawOverride below; pending → runner configured but not
    // verified for this commit). In `shadow` the review uses the repo-pull SARIF
    // regardless, so a "verified" pill would overclaim; render no badge there.
    if (runnerMode === "post") {
      runnerEvidenceBadge =
        runnerEvidence.state === "verified" ? "verified"
        : runnerEvidence.state === "evidence-pending" ? "evidence-pending"
        : undefined
    }
    // SIG-184 PR 5b: presence telemetry — one increment per review in shadow/
    // post (a repoId-less review records `runner-absent`, so it still lands in
    // the adoption denominator). Best-effort: a failure must NEVER break the
    // review, and the DO RPC is bounded by a race-timeout (queue-consumer
    // ctx.waitUntil doesn't extend lifetime, and a signal-less RPC won't honor
    // an AbortSignal, so race is the correct bound). Read via GET
    // /metrics/runner-evidence.
    if (runnerMode !== "off") {
      let metricTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          recordRunnerEvidenceMetric(env, {
            owner, repo, prNumber,
            state: runnerEvidence.state,
            ...(runnerEvidence.state === "evidence-pending" ? { reason: runnerEvidence.reason } : {}),
          }),
          new Promise<never>((_, reject) => {
            metricTimer = setTimeout(() => reject(new Error("metric-record-timeout")), 1_500)
          }),
        ])
      } catch (err) {
        console.warn(JSON.stringify({ event: "runner-evidence-metric-record-failed", owner, repo, prNumber, error: String(err) }))
      } finally {
        if (metricTimer !== undefined) clearTimeout(metricTimer)
      }
    }
    const sarifResult = await runSarifEvidence({
      env, client, owner, repo, prNumber, headSha,
      diff, config: sarifConfig,
      // `post` + verified → scan the receipt's SARIF; else the repo-pull path.
      ...(runnerMode === "post" && runnerEvidence.state === "verified" ? { rawOverride: runnerEvidence.sarif } : {}),
    })
    const sarifFindings = sarifResult.skipped ? [] : sarifResult.findings
    const deterministicCheckAnnotations = buildSarifCheckAnnotations(sarifFindings)
    // SIG-285 v2 PR1 (receipt-join, no-perm, shadow): when a VERIFIED receipt
    // exists, build the HEAD-scan index from the receipt's UN-FILTERED parseSarif
    // results — deliberately NOT `sarifResult.findings`, which runSarifEvidence
    // already diff/severity-filtered (a filtered-out result would read as a false
    // absence). Best-effort + bounded: any parse error leaves the index null
    // (→ the join no-ops) and never breaks the review.
    if (receiptJoinMode !== "off" && runnerEvidence.state === "verified") {
      try {
        const parsed = parseSarif(runnerEvidence.sarif)
        if (!parsed.ok) {
          // parseSarif reports malformed/unsupported receipts via {ok:false}
          // (it does NOT throw); telemeter so a bad receipt is distinguishable
          // from "no verified receipt" / "empty index" during rollout (CodeRabbit).
          console.warn(JSON.stringify({ event: "receiptjoin-index-build-skipped", owner, repo, prNumber, reason: parsed.reason }))
        } else {
          // Pure, unit-tested extraction (mirrors runner.ts path resolution).
          receiptScanIndex = buildReceiptIndex(
            extractReceiptScanResults(parsed.report.runs, normalizeSarifPath),
          )
        }
      } catch (err) {
        console.warn(JSON.stringify({ event: "receiptjoin-index-build-failed", owner, repo, prNumber, error: String(err) }))
      }
    }
    const sarifBlock = renderSarifFindingsForPrompt(sarifFindings)
    telemetry.sarifEvidence = sarifResult.skipped
      ? { skipped: true, reason: sarifResult.reason, findingsCount: 0 }
      : {
          skipped: false,
          findingsCount: sarifResult.findings.length,
          truncatedCount: sarifResult.telemetry.truncatedCount,
          durationMs: sarifResult.telemetry.durationMs,
        }

    // ARC-272: docs-coverage check. Zero-LLM, pure: takes the
    // PR's changed-file list + operator config and returns a hit
    // when architecture-impacting paths were touched without a
    // matching docs update. Runs BEFORE the prompt is built so the
    // hit becomes part of the authoritative-fact block fed to the
    // specialists + synth.
    //
    // `splitFiles` is the pre-`pathFilters` changed-file set — we
    // want every file the PR touched, not the post-filter subset
    // (the filter drops noise like lockfiles, but docs-coverage
    // wants to see architectural changes regardless of whether
    // they're reviewed).
    const docsReviewConfig = resolveDocsReviewConfig(sigilixConfig)
    const docsCoverageHit: DocsCoverageHit | null = runDocsCoverageCheck(
      splitFiles.map((f) => f.path),
      docsReviewConfig,
    )
    if (docsCoverageHit !== null) {
      console.log(JSON.stringify({
        event: "pr-review-docs-coverage-hit",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        architecture_files: docsCoverageHit.architectureFiles,
        doc_paths: [...docsCoverageHit.docPaths],
      }))
    }

    // ─── SIG-110: perf-budgets hot-path check ──────────────────
    // Opt-in (no-op until the operator declares `perfBudgets.hotPaths`).
    // Matched against the REVIEWABLE file set (post path-filter) so the
    // resulting `performance`-scoped fact only ever names files that are
    // actually in this review — a hot-path fact for a file absent from
    // the prompt diff would invite an inline finding that later fails
    // line validation. The hit primes the perf specialist; it does NOT
    // add a verdict finding here.
    const perfBudgetsConfig = resolvePerfBudgetsConfig(sigilixConfig)
    const perfBudgetsHit: PerfBudgetsHit | null = runPerfBudgetsCheck(
      filePaths,
      perfBudgetsConfig,
    )
    if (perfBudgetsHit !== null) {
      console.log(JSON.stringify({
        event: "pr-review-perf-budgets-hit",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        hot_path_files: perfBudgetsHit.hotPathFiles,
        matched_hot_paths: perfBudgetsHit.matchedHotPaths,
      }))
    }

    // ─── SIG-118: coverage-diff ingestion ──────────────────────
    // GATED OFF by default (`coverage.source: "off"`) — production is
    // unaffected until an operator opts in. When enabled, fetch the LCOV
    // coverage artifact from the head SHA's CI run, parse uncovered
    // lines, intersect with the PR's added lines, and feed the resulting
    // coverage-gap facts to the tests specialist. Best-effort + non-
    // fatal: `ingestCoverage` returns null on ANY failure (never throws),
    // so a coverage failure can never break a review. AWAITED here (not
    // in the allSettled block) because the tests fact block depends on
    // the result. Uses `diff` (the post-truncation prompt diff) for the
    // added-line set so a gap is only reported on a line the specialist
    // can actually see.
    const coverageConfig = resolveCoverageConfig(sigilixConfig)
    const coverageResult = coverageConfig.source !== "off"
      ? await ingestCoverage({ client, owner, repo, headSha, diff, config: coverageConfig })
      : null
    // Real coverage-gap set keyed `"<path>:<line>"` for the citation
    // gates. Empty when ingestion is off / yielded no gaps.
    const coverageGapSet = new Set<string>()
    for (const gap of coverageResult?.coverageGaps ?? []) {
      for (const ln of gap.lines) coverageGapSet.add(`${gap.path}:${ln}`)
    }
    {
      const gapsCount = coverageResult?.coverageGaps.reduce((n, g) => n + g.lines.length, 0) ?? 0
      console.log(JSON.stringify({
        event: "coverage-ingest",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        source: coverageConfig.source,
        runId: coverageResult?.meta.runId ?? null,
        artifactName: coverageConfig.source !== "off" ? coverageConfig.artifactName : null,
        gaps_count: gapsCount,
        skipped_reason: coverageConfig.source === "off"
          ? "disabled-config"
          : coverageResult === null
            ? "no-coverage"
            : null,
      }))
    }

  return {
    graphContextNodesForEvidence,
    graphBlastCallerPaths,
    graphBlastDependentPaths,
    graphCtxForPrompt,
    astResult,
    sarifFindings,
    sarifResult,
    sarifBlock,
    runnerEvidenceBadge,
    deterministicCheckAnnotations,
    receiptScanIndex,
    docsCoverageHit,
    perfBudgetsHit,
    coverageResult,
    coverageGapSet,
    receiptJoinMode,
  }
}
