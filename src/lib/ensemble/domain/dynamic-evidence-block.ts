// SIG-318 (PR 12g-3): the dynamic-review-evidence prompt-block resolver (Greptile-
// style grounding cards). Pure given its inputs (builds the evidence pack from the
// changed-symbol context + retrieval/graph neighbors + test context, then renders
// the prompt block in `post` mode). It was exported (and unit-tested via
// tests/triage-pr-review-ensemble.test.ts) from `triage-pr-review-ensemble.ts`; with
// its only non-test caller (the prompt-assembly block) moving to ensemble/app/
// context/assemble-prompts, it relocates to the domain (the inward dependency
// direction) and is re-exported from the god-file to preserve the public surface.
// Never imports the orchestrator.

import type { RetrievedChunk } from "../../retrieval"
import {
  buildDynamicReviewEvidencePack,
  dynamicReviewEvidenceMode,
  renderDynamicReviewEvidenceBlock,
  type DynamicReviewEvidenceEnv,
  type DynamicReviewEvidenceMode,
  type DynamicReviewEvidencePack,
} from "../../review-evidence-pack"
import { type ChangedLines } from "@/features/ast-rules"
import { type AstCache } from "@/features/ast-rules"
import type { TestingEvidencePack } from "../../testing-evidence-pack"
import type { GraphContextNode } from "@/do/repo-graph"

export interface ResolveDynamicEvidencePromptBlockArgs {
  env: DynamicReviewEvidenceEnv
  filesByPath: ReadonlyMap<string, string>
  changedLines: ChangedLines
  reviewablePaths: readonly string[]
  retrievalChunks: readonly RetrievedChunk[]
  graphNodes: readonly GraphContextNode[]
  blastCallerPaths: readonly string[]
  blastDependentPaths: readonly string[]
  testingEvidence: TestingEvidencePack | undefined
  /** SIG-336: shared per-review parse-once cache (the evidence pack parses each
   *  changed file via extractFileGraph — reuse the runner's AST). */
  astCache?: AstCache
}

export interface ResolvedDynamicEvidencePromptBlock {
  mode: DynamicReviewEvidenceMode
  pack: DynamicReviewEvidencePack | null
  rendered: string
  promptBlock: string
}

export function resolveDynamicEvidencePromptBlock(
  args: ResolveDynamicEvidencePromptBlockArgs,
): ResolvedDynamicEvidencePromptBlock {
  const mode = dynamicReviewEvidenceMode(args.env)
  if (mode === "off") {
    return { mode, pack: null, rendered: "", promptBlock: "" }
  }

  const pack = buildDynamicReviewEvidencePack({
    filesByPath: args.filesByPath,
    changedLines: args.changedLines,
    reviewablePaths: args.reviewablePaths,
    retrievalChunks: args.retrievalChunks,
    graphNodes: args.graphNodes,
    blastCallerPaths: args.blastCallerPaths,
    blastDependentPaths: args.blastDependentPaths,
    ...(args.testingEvidence !== undefined ? { testingEvidence: args.testingEvidence } : {}),
    ...(args.astCache !== undefined ? { astCache: args.astCache } : {}),
  })
  const rendered = renderDynamicReviewEvidenceBlock(pack)

  return {
    mode,
    pack,
    rendered,
    promptBlock: mode === "post" ? rendered : "",
  }
}
