// SIG-318 / SIG-366: the gather-graph seam's type contracts — the local type
// aliases + the `GatherGraphTelemetry` slice + the `GatherGraphArgs` /
// `GatherGraphResult` interfaces — split into a sibling leaf so
// `context/gather-graph.ts` stays under the 1k-line cap (the SIG-318 file-size
// invariant) after Prettier's canonical wrapping pushed it just over. Moved VERBATIM
// from gather-graph (only the import-path prefixes change). ZERO behavior change.
//
// The three interfaces are part of the gather-graph public surface (the orchestrator
// + tests reference them), so gather-graph re-exports each one so the surface is
// byte-identical.
//
// Dependency rule: a pure type leaf — every name imports from its canonical home
// (the github/env/retrieval leaves, the ast-rules / sigilix-config / docs-coverage /
// perf-budgets / sarif / runner-evidence / receipt / coverage features + leaves, the
// graph DO types, the budget/config domains). It never imports gather-graph.

import type { Env } from "@/src/shared/types/env"
import type { GitHubClient } from "@/src/shared/adapters/github"
import type { CheckRunAnnotation } from "@/src/shared/types/github"
import type { RetrievedChunk } from "@/src/lib/retrieval"
import type { resolveAstRulesConfig, SigilixConfig } from "@/src/lib/sigilix-config"
import type { runAstRules, AstCache } from "@/src/features/ast-rules"
import type { DocsCoverageHit } from "@/src/lib/docs-coverage-check"
import type { PerfBudgetsHit } from "@/src/shared/domain/perf-budgets"
import type { ingestCoverage } from "@/src/lib/coverage-ingest"
import type { runSarifEvidence, SarifFinding } from "@/src/features/sarif-evidence"
import type { ReceiptScanResult } from "@/src/lib/verification/verify-finding-receipt"
import type { GraphRetrievalSample } from "@/src/do/graph-metrics"
import type { GraphExpansionSample } from "@/src/do/graph-expansion-metrics"
import type { GraphContextNode } from "@/src/do/repo-graph"
import type { EnsembleConfig } from "@/src/lib/ensemble/domain/config"

export type AstResult = Awaited<ReturnType<typeof runAstRules>>
export type AstRulesConfig = ReturnType<typeof resolveAstRulesConfig>
export type SarifResult = Awaited<ReturnType<typeof runSarifEvidence>>
export type CoverageResult = Awaited<ReturnType<typeof ingestCoverage>>
export type ReviewableMap = Parameters<typeof runAstRules>[0]["reviewable"]
export type SplitFile = { path: string }

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
    | {
        skipped: true
        reason: import("@/src/features/sarif-evidence").ScanSkipReason
        findingsCount: number
      }
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
