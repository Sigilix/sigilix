// SIG-318 (PR 12g-3) — the ASSEMBLE-PROMPTS seam of the PR-review orchestrator
// (app layer, context-build phase). Carved verbatim from `handlePrReviewEnsemble`,
// between the coverage-ingest gather and the specialists call site: the prompt
// fact-blocks (deterministic / secret / docs / perf-budget / coverage-gap), the
// SIG-108 `buildSecurityFactManifest`, the SIG-317 asymmetry/toctou hint blocks,
// the role-scoped `factsByRole`, the ARC-181 `maybePostAstAutoInline` deferred-
// poster closure (RETURNED, not exploded), the ARC-182 stack detection, the SIG-113
// testing-evidence pack (incl. the bounded cross-file fetch + repo-tree fallback),
// the dynamic review-evidence block, and the SIG-108 per-role `messageForRole`
// closure (RETURNED — it hides ~16 captures so the call site stays a thin map).
//
// The moved statements are byte-identical apart from the plumbing (`args.X` →
// params, declarations → returns). The two returned closures capture only consts /
// by-value params (no orchestrator state leaks). ZERO behavior change.
//
// Dependency rule: every dependency imports from its canonical NON-god-file home
// (incl. the relocated dynamic-evidence-block domain). It never imports the
// orchestrator god-file.

import type { Env } from "@/src/shared/types/env"
import { GitHubClient } from "@/src/shared/adapters/github"
import type { PullRequestMeta, ListOpenPullsItem } from "@/src/shared/types/github"
import type { SpecialistRole } from "@/src/shared/domain/specialist-role"
import type { RetrievedChunk } from "@/src/lib/retrieval"
import { selectRetrievalSnapshotForRole } from "@/src/lib/perf-retrieval"
import { mergeLogicSnapshot } from "@/src/lib/symbol-retrieval"
import { buildChangedLines, buildAddedLineTextByLine, buildDeletedLineTextByLine } from "@/src/features/ast-rules"
import {
  renderPathInstructionsForPrompt,
  resolvePathInstructionsForChangedPaths,
  resolveAstRulesConfig,
  type SigilixConfig,
} from "@/src/lib/sigilix-config"
import { renderHitsForPrompt, type DeterministicCheckHit } from "@/src/shared/domain/deterministic-checks"
import { renderSecretHitsForPrompt, type SecretHit } from "@/src/lib/secret-scan"
import { renderDocsCoverageForPrompt, type DocsCoverageHit } from "@/src/lib/docs-coverage-check"
import { renderPerfBudgetsForPrompt, type PerfBudgetsHit } from "@/src/shared/domain/perf-budgets"
import { renderCoverageGapBlock, type ingestCoverage } from "@/src/lib/coverage-ingest"
import { buildSecurityFactManifest } from "@/src/lib/security-evidence-manifest"
import { buildChangedLineTextByPath } from "@/src/lib/ensemble/domain/gates/validate-logic-finding"
import { buildFactsByRole } from "@/src/lib/role-scoped-facts"
import {
  analyzeHelperBypass,
  renderAsymmetryHints,
  analyzeToctouRace,
  renderToctouHints,
  renderAstFindingsAsJsonForSynth,
  postAstInlineFindings,
  runAstRules,
  type AstCache,
} from "@/src/features/ast-rules"
import { runDepVulnScan } from "@/src/features/dep-vulns"
import { sarifFindingHasRole, type SarifFinding } from "@/src/features/sarif-evidence"
import { detectStack, computeFileOverlap, type FileOverlap, type StackContext } from "@/src/lib/pr-stack"
import { renderStackPromptBlock } from "@/src/prompts/pr-stack-prompt"
import { classifyDiffFiles, renderDiffFileClassificationBlock } from "@/src/lib/diff-file-classify"
import {
  buildTestingEvidencePack,
  fetchTestFileContentsWithBudget,
  filterTestingEvidenceForSuppressedMissingCoverage,
  mergeInspectedTestFileContents,
  mergeHelperCoverage,
  mergeTestingFocusHints,
  renderTestingEvidenceBlock,
  type TestingEvidencePack,
  type InspectedTestFileFetchResult,
} from "@/src/lib/testing-evidence-pack"
import { detectHelperCoverage } from "@/src/lib/helper-coverage"
import { buildSpecialistInitialMessage } from "@/src/prompts/pr-review-specialists"
import { resolveDynamicEvidencePromptBlock } from "@/src/lib/ensemble/domain/dynamic-evidence-block"
import { buildMultiBatchPrSummary } from "@/src/lib/ensemble/domain/multibatch-pr-summary"
import type { GraphContextNode } from "@/src/do/repo-graph"

type SecurityManifest = Awaited<ReturnType<typeof buildSecurityFactManifest>>
type AstResult = Awaited<ReturnType<typeof runAstRules>>
type AstRulesConfig = ReturnType<typeof resolveAstRulesConfig>
type DepVulnFindings = Exclude<Awaited<ReturnType<typeof runDepVulnScan>>, { skipped: true }>["findings"]
type CoverageResult = Awaited<ReturnType<typeof ingestCoverage>>
type MatchedPathInstructions = ReturnType<typeof resolvePathInstructionsForChangedPaths>
type SplitFile = { path: string }

export interface AssemblePromptsArgs {
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  headSha: string
  /** Pinned to "post" by the handler — gates the auto-inline poster. */
  mode: "post"
  /** The orchestrator's abort signal — the SIG-113 repo-tree fallback fetch honors it. */
  orchCtrlSignal: AbortSignal
  meta: PullRequestMeta
  sigilixConfig: SigilixConfig
  diff: string
  fullDiff: string
  fullPrDiff: string
  filePaths: string[]
  filesNotReviewed: string[]
  splitFiles: SplitFile[]
  filesAfterFilter: SplitFile[]
  reviewedFiles: SplitFile[]
  matchedPathInstructions: MatchedPathInstructions
  scopedRulesBlock: string
  openPrsForStack: ListOpenPullsItem[]
  // ── evidence (gather-evidence) ──
  deterministicHits: DeterministicCheckHit[]
  secretHits: SecretHit[]
  depVulnFindings: DepVulnFindings
  depVulnBlock: string
  retrievalSnapshot: string
  perfRetrievalSnapshot: string
  logicSymbolSnapshot: string
  sharedChunksForOverlap: RetrievedChunk[]
  astFilesByPath: Map<string, string>
  astCache: AstCache
  astRulesConfig: AstRulesConfig
  asymmetryMode: string
  toctouMode: string
  namespace: string
  // ── evidence (gather-graph) ──
  astResult: AstResult
  sarifFindings: readonly SarifFinding[]
  sarifBlock: string
  docsCoverageHit: DocsCoverageHit | null
  perfBudgetsHit: PerfBudgetsHit | null
  coverageResult: CoverageResult
  graphCtxForPrompt: string
  graphContextNodesForEvidence: GraphContextNode[]
  graphBlastCallerPaths: string[]
  graphBlastDependentPaths: string[]
}

export interface AssemblePromptsResult {
  securityManifest: SecurityManifest
  /** RETURNED closure (hides the AST auto-inline poster's captures). */
  maybePostAstAutoInline: () => Promise<void>
  stack: StackContext
  stackBlock: string
  changedLineTextByPath: ReturnType<typeof buildChangedLineTextByPath>
  testingEvidencePackWithCoverage: TestingEvidencePack
  dynamicEvidenceBlockForPrompt: string
  /** RETURNED closure (hides ~16 captures so the specialists call stays a thin map). */
  messageForRole: (role: SpecialistRole) => string
  /** RETURNED closure for SIG-418 enforce/shadow spillover batch messages. */
  messageForBatchRole: (role: SpecialistRole, batchDiff: string, batchFactsBlock: string) => string
}

export async function assembleSpecialistPrompts(a: AssemblePromptsArgs): Promise<AssemblePromptsResult> {
  const {
    env,
    client,
    owner,
    repo,
    prNumber,
    headSha,
    mode,
    meta,
    sigilixConfig,
    diff,
    fullDiff,
    fullPrDiff,
    filePaths,
    filesNotReviewed,
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
    docsCoverageHit,
    perfBudgetsHit,
    coverageResult,
    graphCtxForPrompt,
    graphContextNodesForEvidence,
    graphBlastCallerPaths,
    graphBlastDependentPaths,
  } = a
  // ─── Fan out specialists ────────────────────────────────────
  const deterministicBlock = renderHitsForPrompt(deterministicHits)
  const secretScanBlock = renderSecretHitsForPrompt(secretHits)
  const docsCoverageBlock = renderDocsCoverageForPrompt(docsCoverageHit)
  const perfBudgetBlock = renderPerfBudgetsForPrompt(perfBudgetsHit)
  const coverageGapBlock = renderCoverageGapBlock(coverageResult?.coverageGaps ?? [])
  // SIG-108: security fact manifest — assigns each deterministic
  // security fact a hard-to-fabricate `evidenceId` (`tool:rule-id:
  // hash:line`). The render() block is folded into the security role's
  // facts (below) so the security specialist sees the citable ids; the
  // manifest Map is threaded to validateForSubmission so the citation
  // gate can cross-check each cited id against the real fact's path/line.
  const securityManifest = await buildSecurityFactManifest({
    secretHits,
    depVulnFindings,
    sarifFindings: sarifFindings.filter((f) => sarifFindingHasRole(f, "security")),
    astSecurityFindings: astResult.findings.filter((f) => f.roleHint === "security"),
  })
  // SIG-108: route deterministic facts to their owning specialist — no
  // cross-domain leak. Pure + unit-tested in role-scoped-facts.test.ts.
  // The SIG-91 diff-classification + ARC-182 stack blocks stay shared.
  // SIG-317 Part 4b: cross-function asymmetry hints for the LOGIC specialist —
  // a deterministic FACT (a mutator of table T that bypasses the aggregation
  // helper over T used elsewhere = a likely over-credit/over-refund) surfaced
  // for the model to judge, NOT a posted finding. Gated `off` (shadow) by
  // default: unlike a pure detector this NUDGES the specialist, so it carries
  // an induced-FP risk and ships shadow-first → measure → flip. `on` injects.
  // `asymmetryMode` is read above (it also gates the changed-files corpus load).
  let asymmetryBlock = ""
  if (asymmetryMode !== "off") {
    const asymmetryHints = analyzeHelperBypass(astFilesByPath)
    if (asymmetryHints.length > 0) {
      console.log(
        JSON.stringify({
          event: "pr-review-asymmetry-hints",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          mode: asymmetryMode,
          count: asymmetryHints.length,
          hints: asymmetryHints.map((h) => ({ fn: h.fn, helper: h.helper })),
        }),
      )
      if (asymmetryMode === "on") asymmetryBlock = renderAsymmetryHints(asymmetryHints)
    }
  }
  // SIG-317 Part 4b-v2: TOCTOU / check-then-act race hints for the LOGIC
  // specialist — a deterministic FACT (a SELECT-of-C-then-separate-relative-
  // UPDATE-of-C with no atomic guard = a likely race) surfaced for the model to
  // judge, NOT a posted finding. Same shadow-first ladder as the asymmetry
  // injector: `shadow` logs the count, `on` injects.
  let toctouBlock = ""
  if (toctouMode !== "off") {
    const toctouHints = analyzeToctouRace(astFilesByPath)
    if (toctouHints.length > 0) {
      console.log(
        JSON.stringify({
          event: "pr-review-toctou-hints",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          mode: toctouMode,
          count: toctouHints.length,
          hints: toctouHints.map((h) => ({ fn: h.fn, table: h.table, column: h.column })),
        }),
      )
      if (toctouMode === "on") toctouBlock = renderToctouHints(toctouHints)
    }
  }
  const factsByRole = buildFactsByRole({
    secretScanBlock,
    depVulnBlock,
    sarifFindings,
    deterministicBlock,
    docsCoverageBlock,
    coverageGapBlock,
    securityManifestBlock: securityManifest.render(),
    perfBudgetBlock,
    astFindings: astResult.findings,
    asymmetryBlock,
    toctouBlock,
  })
  void renderAstFindingsAsJsonForSynth // referenced by Task 8 synth wiring

  // ARC-181 Task 9: auto-inline poster — gated behind
  // `astRules.autoInline === true` AND mode === "post". Default-
  // false v1 cautious rollout; flips after 2 weeks of FP telemetry
  // shows < 5% rate.
  //
  // Posting is DEFERRED until the ensemble's own review submits
  // successfully (CR catch on PR #67) so an aborted run — stale
  // head SHA, synth_timeout, specialist failure-cascade — doesn't
  // leave orphan AST comments on a PR whose ensemble review never
  // landed. The closure captures everything we need; the two
  // submission-success paths below invoke it.
  const maybePostAstAutoInline = async (): Promise<void> => {
    if (mode !== "post") return
    if (!astRulesConfig.autoInline) return
    if (astResult.findings.length === 0) return
    try {
      await postAstInlineFindings({
        client,
        owner,
        repo,
        prNumber,
        headSha,
        findings: astResult.findings,
        perFindingPositions: astResult.perFinding,
      })
    } catch {
      // Swallowed — the poster's own try/catch already does this;
      // belt-and-suspenders so a poster bug never blocks the
      // ensemble's finalize.
    }
  }
  // ARC-182: compute stack context just before specialist fanout.
  // Stack detection is pure + cheap; the only async work is the
  // optional parent-files fetch when isStacked && parent. Render
  // a single stackBlock string and pass to BOTH specialist and
  // synth messages so they see the same context.
  const repoFullName = `${owner}/${repo}`
  const stack: StackContext = detectStack({
    currentPr: {
      number: prNumber,
      title: meta.title ?? "",
      headRef: meta.head?.ref ?? "",
      baseRef: meta.base?.ref ?? "",
      headRepo: repoFullName,
      baseRepo: repoFullName,
      author: meta.user?.login ?? null,
    },
    openPrs: openPrsForStack,
  })
  let stackOverlap: FileOverlap | undefined
  if (stack.isStacked && stack.parent) {
    const [currentFilesList, parentFilesList] = await Promise.all([
      // Reuse the diff-derived file list for the current PR — it's
      // already in memory (splitFiles) and the parent files fetch
      // is the only extra request.
      Promise.resolve(splitFiles.map((f) => ({ filename: f.path }))),
      client.listPullRequestFiles(owner, repo, stack.parent.number, { maxFiles: 100 }).catch(() => []),
    ])
    stackOverlap = computeFileOverlap({
      currentFiles: currentFilesList.map((f) => f.filename),
      parentFiles: parentFilesList.map((f) => f.filename),
    })
  }
  const stackBlock = stack.isStacked ? renderStackPromptBlock(stack, stackOverlap) : ""

  console.log(
    JSON.stringify({
      event: "pr-stack-context",
      owner,
      repo,
      prNumber,
      mode,
      isStacked: stack.isStacked,
      position: stack.position,
      depth: stack.depth,
      parentPrNumber: stack.parent?.number ?? null,
      childCount: stack.children.length,
      openPrCount: openPrsForStack.length,
      openPrsTruncated: openPrsForStack.length >= 200,
      cycleDetected: stack.cycleDetected,
      stackWalkCapped: stack.stackWalkCapped,
      hasUpstackFork: stack.hasUpstackFork,
      overlapShared: stackOverlap?.sharedCount ?? null,
      overlapCurrentOnly: stackOverlap?.currentOnlyCount ?? null,
    }),
  )

  // SIG-91: classify the diff's file list (source / test / docs /
  // config / other) and resolve source ↔ test sibling pairs. The
  // tests specialist was firing false-positive "module ships without
  // tests" findings on PRs that DO add sibling tests (PRs #98, #100,
  // #104) because the prompt biased it to look for "no test files
  // changed" without grounding it on what's actually in the diff.
  // We render the classification as an authoritative block injected
  // before the diff so the model can't miss the pairing.
  //
  // Source list = the files that survived path filtering + batch
  // packing — i.e., the exact set the specialists actually see in
  // [DIFF]. Reporting classification on files dropped from [DIFF]
  // would mislead the model about what's available.
  const classifiedDiffFiles = classifyDiffFiles(reviewedFiles.map((f) => f.path))
  const diffFileClassificationBlock = renderDiffFileClassificationBlock(classifiedDiffFiles)

  // SIG-113: build the testing-evidence pack from the FULL diff
  // inventory (splitFiles, not reviewedFiles). Pre-SIG-113, the
  // classification block above used `reviewedFiles` only — the
  // first packed-diff batch — which produced 8 testing-completeness
  // false positives across PR #110 + PR #111 when test files lived
  // in later batches or were modified-not-added. The new pack uses
  // `splitFiles`, embeds the FULL CONTENT of added/modified test
  // files (subject to caps), and feeds the validator the
  // `inspectedTestFiles` list so the post-LLM citation gate can
  // drop unevidenced findings.
  //
  // Three-step build:
  //   1. Pure pack (deterministic, no I/O)
  //   2. Async fetch of test-file content via client.getFileContent
  //      (mirrors the AST source fetch pattern at line ~1227)
  //   3. Cap-application + merge → final pack with inspectedTestFiles
  // code-reviewer M1 catch (pre-PR): build from `filesAfterFilter`
  // (post-pathFilter, pre-batch) — NOT `splitFiles` (pre-filter).
  // Using `splitFiles` would re-surface operator-excluded files
  // (generated/, vendor/, etc.) in the evidence pack, inviting
  // missing-tests findings on paths the operator chose not to
  // review + wasting getFileContent fetches on them. The pack's
  // JSDoc contract says "post-filter, pre-batch" — this aligns the
  // call site with it. `filesAfterFilter` ⊇ `reviewedFiles` (the
  // batcher subsets it), so `testFilesNotInPromptDiff` still
  // correctly captures batch-dropped (not filter-dropped) tests.
  const testingEvidencePackInitial: TestingEvidencePack = buildTestingEvidencePack({
    splitFilePaths: filesAfterFilter.map((f) => f.path),
    reviewedFilePaths: reviewedFiles.map((f) => f.path),
  })
  const changedLineTextByPath = buildChangedLineTextByPath(fullPrDiff)
  const missingSiblingSources = testingEvidencePackInitial.siblingMappings
    .filter((m) => m.test === null)
    .map((m) => m.source)
  let repoPathsForTestingEvidence: string[] | undefined
  if (missingSiblingSources.length > 0) {
    let repoTreeStatus:
      | "ok"
      | "unavailable"
      | "missing-head-ref"
      | "branch-missing"
      | "head-ref-mismatch"
      | "tree-missing"
      | "tree-truncated"
      | "fetch-failed" = "unavailable"
    let repoTreePathsCount = 0
    const treeCapableClient = client as GitHubClient & {
      getBranch?: GitHubClient["getBranch"]
      getRepoTree?: GitHubClient["getRepoTree"]
    }
    const headRef = meta.head?.ref ?? ""
    if (typeof treeCapableClient.getBranch === "function" && typeof treeCapableClient.getRepoTree === "function") {
      if (headRef.length === 0) {
        repoTreeStatus = "missing-head-ref"
      } else {
        try {
          const branch = await treeCapableClient.getBranch(owner, repo, headRef, {
            signal: a.orchCtrlSignal,
          })
          if (branch === null) {
            repoTreeStatus = "branch-missing"
          } else if (branch.headSha !== headSha) {
            repoTreeStatus = "head-ref-mismatch"
          } else {
            const tree = await treeCapableClient.getRepoTree(owner, repo, branch.treeSha, {
              signal: a.orchCtrlSignal,
            })
            if (tree === null) {
              repoTreeStatus = "tree-missing"
            } else if (tree.truncated) {
              repoTreeStatus = "tree-truncated"
            } else {
              repoPathsForTestingEvidence = tree.tree.flatMap((entry) =>
                entry.type === "blob" && typeof entry.path === "string" && entry.path.length > 0 ? [entry.path] : [],
              )
              repoTreePathsCount = repoPathsForTestingEvidence.length
              repoTreeStatus = "ok"
            }
          }
        } catch (err) {
          if (a.orchCtrlSignal.aborted) {
            console.warn(
              JSON.stringify({
                event: "tests-evidence-repo-tree-aborted",
                owner,
                repo,
                prNumber,
                headSha: headSha.slice(0, 7),
                error: err instanceof Error ? err.message : String(err),
              }),
            )
            throw err
          }
          repoTreeStatus = "fetch-failed"
          console.warn(
            JSON.stringify({
              event: "tests-evidence-repo-tree-fetch-failed",
              owner,
              repo,
              prNumber,
              headSha: headSha.slice(0, 7),
              error: err instanceof Error ? err.message : String(err),
            }),
          )
        }
      }
    }
    console.log(
      JSON.stringify({
        event: "tests-evidence-repo-tree-status",
        owner,
        repo,
        prNumber,
        headSha: headSha.slice(0, 7),
        status: repoTreeStatus,
        missingSiblingSources_count: missingSiblingSources.length,
        repoTreePaths_count: repoTreePathsCount,
      }),
    )
  }
  const testingEvidenceSuppression = filterTestingEvidenceForSuppressedMissingCoverage(testingEvidencePackInitial, {
    changedLineTextByPath,
    ...(repoPathsForTestingEvidence !== undefined ? { repoPaths: repoPathsForTestingEvidence } : {}),
  })
  for (const suppression of testingEvidenceSuppression.suppressions) {
    if (suppression.reason === "repo-sibling-exists") {
      console.log(
        JSON.stringify({
          event: "tests-finding-suppressed-repo-sibling-exists",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          source: suppression.source,
          test: suppression.test ?? null,
        }),
      )
    } else {
      console.log(
        JSON.stringify({
          event: "tests-finding-suppressed-comment-only-source",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          source: suppression.source,
        }),
      )
    }
  }
  const testingEvidencePackFiltered = testingEvidenceSuppression.pack
  let testingEvidenceFetchResult: InspectedTestFileFetchResult = {
    contentByPath: {},
    failedPaths: [],
    budgetOmittedPaths: [],
    truncatedPaths: [],
    totalChars: 0,
  }
  let testingEvidenceFetchedCount = 0
  let testingEvidenceSkippedForBudgetCount = 0
  if (testingEvidencePackFiltered.testFilesChanged.length > 0) {
    const fetched = await fetchTestFileContentsWithBudget({
      paths: testingEvidencePackFiltered.testFilesChanged,
      fetchContent: async (p) => {
        const src = await client.getFileContent(owner, repo, p, headSha)
        if (typeof src !== "string") throw new Error("content unavailable")
        return src
      },
      concurrency: 5,
    })
    testingEvidenceFetchResult = fetched
    testingEvidenceFetchedCount = fetched.fetchedCount
    testingEvidenceSkippedForBudgetCount = fetched.skippedForBudgetCount
  }
  const testingEvidencePack = mergeInspectedTestFileContents(testingEvidencePackFiltered, testingEvidenceFetchResult)
  const testingEvidencePackWithFocus = mergeTestingFocusHints(
    testingEvidencePack,
    buildAddedLineTextByLine(fullPrDiff),
    buildDeletedLineTextByLine(fullPrDiff),
  )
  // SIG-128: credit orchestrator glue whose changed logic delegates to
  // same-PR tested helpers. Uses `fullDiff` (the COMPLETE per-file patch)
  // for added-line text — NOT the truncated/first-batch `diff` — and the
  // already-fetched changed JS/TS head content (`astFilesByPath`). A source
  // missing from either input fails closed to "none" (never suppresses).
  // SIG-128 observability: when `astFilesByPath` is empty (e.g. all retrieval
  // flags off so no head content was fetched), every source fails closed to
  // "none" and this credits nothing — a future flag change must not silently
  // disable this path.
  const helperCoverage = detectHelperCoverage({
    filesByPath: astFilesByPath,
    addedLineTextByPath: buildAddedLineTextByLine(fullDiff),
    siblingMappings: testingEvidencePackFiltered.siblingMappings,
    testContentByPath: testingEvidenceFetchResult.contentByPath,
    astCache,
  })
  const testingEvidencePackWithCoverage = mergeHelperCoverage(
    testingEvidencePackWithFocus,
    helperCoverage.coverageBySource,
  )
  const testingEvidenceBlock = renderTestingEvidenceBlock(testingEvidencePackWithCoverage, testingEvidenceFetchResult)

  // SIG-91 + SIG-113 telemetry — lets us verify post-deploy that
  // sibling pairs + the new evidence pack are being built from the
  // full diff inventory (not just the first batch).
  {
    const sourceFilesInDiff: string[] = []
    const testFilesInDiff: string[] = []
    const siblingMappingsDetected: Array<{ source: string; test: string }> = []
    for (const c of classifiedDiffFiles) {
      if (c.kind === "source") sourceFilesInDiff.push(c.path)
      if (c.kind === "test") testFilesInDiff.push(c.path)
      if (c.kind === "source" && c.testsSibling) {
        siblingMappingsDetected.push({ source: c.path, test: c.testsSibling })
      }
    }
    console.log(
      JSON.stringify({
        event: "tests-specialist-input-files",
        owner,
        repo,
        prNumber,
        headSha: headSha.slice(0, 7),
        sourceFilesInDiff,
        testFilesInDiff,
        siblingMappingsDetected,
      }),
    )
    // SIG-113: separate event for the new evidence pack so we can
    // monitor coverage of the full-inventory inspection independent
    // of the SIG-91 first-batch classification.
    console.log(
      JSON.stringify({
        event: "pr-review-testing-evidence-built",
        owner,
        repo,
        prNumber,
        headSha: headSha.slice(0, 7),
        sourceFilesChanged_count: testingEvidencePackWithCoverage.sourceFilesChanged.length,
        testFilesChanged_count: testingEvidencePackWithCoverage.testFilesChanged.length,
        testFilesInPromptDiff_count: testingEvidencePackWithCoverage.testFilesInPromptDiff.length,
        testFilesNotInPromptDiff_count: testingEvidencePackWithCoverage.testFilesNotInPromptDiff.length,
        inspectedTestFiles_count: testingEvidencePackWithCoverage.inspectedTestFiles.length,
        testingFocusHints_count: testingEvidencePackWithCoverage.testingFocusHints?.length ?? 0,
        contentTotalChars: testingEvidenceFetchResult.totalChars,
        truncatedPaths_count: testingEvidenceFetchResult.truncatedPaths.length,
        failedFetchPaths_count: testingEvidenceFetchResult.failedPaths.length,
        fetchedPaths_count: testingEvidenceFetchedCount,
        skippedForBudgetPaths_count: testingEvidenceSkippedForBudgetCount,
      }),
    )
  }

  // Dynamic review evidence (Greptile-style grounding): small cards around
  // changed symbols/regions that bundle local code, graph/retrieval
  // neighbors, and test context. Shadow mode computes coverage telemetry
  // only; post mode injects the cards into specialist + synth prompts.
  const dynamicEvidence = resolveDynamicEvidencePromptBlock({
    env,
    filesByPath: astFilesByPath,
    astCache,
    changedLines: buildChangedLines(diff),
    reviewablePaths: filePaths,
    retrievalChunks: sharedChunksForOverlap,
    graphNodes: graphContextNodesForEvidence,
    blastCallerPaths: graphBlastCallerPaths,
    blastDependentPaths: graphBlastDependentPaths,
    testingEvidence: testingEvidencePackWithCoverage,
  })
  const dynamicEvidenceBlockForPrompt = dynamicEvidence.promptBlock
  if (dynamicEvidence.pack !== null) {
    const dynamicEvidencePack = dynamicEvidence.pack
    const cardsWithGraph = dynamicEvidencePack.cards.filter((c) => c.graphRelations.length > 0).length
    const cardsWithRetrieval = dynamicEvidencePack.cards.filter((c) => c.retrievalRefs.length > 0).length
    const cardsWithTesting = dynamicEvidencePack.cards.filter(
      (c) =>
        c.testingContext.siblingRefs.length > 0 ||
        c.testingContext.inspectedTestFiles.length > 0 ||
        c.testingContext.helperCoverageRefs.length > 0,
    ).length
    console.log(
      JSON.stringify({
        event: "pr-review-dynamic-evidence",
        owner,
        repo,
        prNumber,
        headSha: headSha.slice(0, 7),
        mode: dynamicEvidence.mode,
        files_scanned: dynamicEvidencePack.filesScanned,
        changed_files_with_sources: dynamicEvidencePack.changedFilesWithSources,
        cards: dynamicEvidencePack.cards.length,
        cards_with_graph: cardsWithGraph,
        cards_with_retrieval: cardsWithRetrieval,
        cards_with_testing: cardsWithTesting,
        rendered_chars: dynamicEvidence.rendered.length,
      }),
    )
  }

  // SIG-108: build one message per role, injecting only that role's
  // scoped facts block (no cross-domain leak). The tests specialist
  // additionally gets the SIG-113 testing-evidence block (which
  // REPLACES the shared classification block); every other role gets
  // the shared SIG-91 classification block. guidance/profile/stack
  // remain shared. Messages are cached per role since each fan-out
  // path may request the same role's message more than once.
  const specialistMessageCache = new Map<SpecialistRole, string>()
  const prGlobalSummary = buildMultiBatchPrSummary({
    changedFiles: [...filePaths, ...filesNotReviewed],
    callerPaths: graphBlastCallerPaths,
    dependentPaths: graphBlastDependentPaths,
  })
  const messageForRole = (role: SpecialistRole): string => {
    const cached = specialistMessageCache.get(role)
    if (cached !== undefined) return cached
    const roleFacts = factsByRole[role]
    const message = buildSpecialistInitialMessage({
      prNumber,
      title: meta.title,
      body: meta.body ?? "",
      diff,
      // SIG-110: the performance role gets the perf-biased snapshot.
      // SIG-121: the logic role AUGMENTS the shared snapshot with the
      // symbol-derived block (empty when the flag is off, in which case
      // mergeLogicSnapshot returns the shared snapshot unchanged). Every
      // other role gets the shared preflight snapshot.
      retrievalSnapshot:
        role === "performance"
          ? selectRetrievalSnapshotForRole(role, perfRetrievalSnapshot, retrievalSnapshot)
          : role === "logic"
            ? mergeLogicSnapshot(retrievalSnapshot, logicSymbolSnapshot)
            : retrievalSnapshot,
      namespace,
      ...(sigilixConfig.guidance ? { guidance: sigilixConfig.guidance } : {}),
      ...(matchedPathInstructions.length > 0
        ? { pathInstructionsBlock: renderPathInstructionsForPrompt(matchedPathInstructions, role) }
        : {}),
      // SIG-172: directory-scoped + glob-scoped rules. Same block
      // for every role (no per-role splitting in v1) — the rules
      // are written by the repo owner with all four lenses in mind.
      ...(scopedRulesBlock.length > 0 ? { scopedRulesBlock } : {}),
      ...(sigilixConfig.profile ? { profile: sigilixConfig.profile } : {}),
      ...(roleFacts.length > 0 ? { deterministicChecksBlock: roleFacts } : {}),
      ...(stackBlock.length > 0 ? { stackBlock } : {}),
      ...(role === "tests" && testingEvidenceBlock.length > 0
        ? { testingEvidenceBlock }
        : diffFileClassificationBlock.length > 0
          ? { diffFileClassificationBlock }
          : {}),
      // SIG-138 Phase 2: logic + tests specialists see graph neighbors
      // (post mode only; empty string when off or shadow).
      ...(graphCtxForPrompt.length > 0 && (role === "logic" || role === "tests")
        ? { graphContext: graphCtxForPrompt }
        : {}),
      ...(dynamicEvidenceBlockForPrompt.length > 0 ? { dynamicEvidenceBlock: dynamicEvidenceBlockForPrompt } : {}),
    })
    specialistMessageCache.set(role, message)
    return message
  }
  const messageForBatchRole = (role: SpecialistRole, batchDiff: string, batchFactsBlock: string): string =>
    buildSpecialistInitialMessage({
      prNumber,
      title: meta.title,
      body: meta.body ?? "",
      diff: batchDiff,
      retrievalSnapshot: "",
      namespace,
      guidance: sigilixConfig.guidance ? `${sigilixConfig.guidance}\n\n${prGlobalSummary}` : prGlobalSummary,
      ...(batchFactsBlock.length > 0 ? { deterministicChecksBlock: batchFactsBlock } : {}),
      ...(stackBlock.length > 0 ? { stackBlock } : {}),
      ...(graphCtxForPrompt.length > 0 && (role === "logic" || role === "tests")
        ? { graphContext: graphCtxForPrompt }
        : {}),
    })

  return {
    securityManifest,
    maybePostAstAutoInline,
    stack,
    stackBlock,
    changedLineTextByPath,
    testingEvidencePackWithCoverage,
    dynamicEvidenceBlockForPrompt,
    messageForRole,
    messageForBatchRole,
  }
}
