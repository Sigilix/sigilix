// SIG-452: adversarial-framing hardening — the prompt-assembly seam that turns
// the "removed guarding test for a CHANGED symbol" signal (benchmark #29) into
// the two enforce-gated prompt blocks. Extracted from `assemble-prompts.ts` to
// keep that file within the COMPLIANCE size budget and to localize the one IO
// call (the GitHub file-metadata fetch for rename exclusion).
//
// off  → not called (the caller skips it) → byte-identical.
// shadow → computes the signal + logs counts ONLY; returns EMPTY blocks → the
//          caller injects nothing → output byte-identical.
// enforce → also returns the symbol-grade logic + synth blocks for injection.
//
// The metadata fetch + symbol derivation run in BOTH shadow and enforce so shadow
// telemetry PREDICTS enforce (Codex sign-off #2); they touch no prompt, so shadow
// stays byte-identical. Defensive: a throw degrades to empty blocks (no signal),
// never sinks the review — the signal is additive.

import { GitHubClient } from "@/src/shared/adapters/github"
import { buildChangedLines, buildDeletedLineTextByLine, type AstCache } from "@/src/features/ast-rules"
import {
  buildRemovedGuardingTests,
  deriveChangedExportedSymbols,
  symbolGradeRemovedGuardingTests,
  type AdversarialFramingMode,
  type ChangedFileMeta,
  type RemovedGuardingTest,
} from "@/src/lib/removed-guarding-tests"
import {
  ADVERSARIAL_FRAMING_PROMPT_VERSION,
  renderAdversarialFramingLogicBlock,
  renderAdversarialFramingSynthBlock,
} from "@/src/prompts/adversarial-framing"

export interface AdversarialFramingBlocks {
  /** The LOGIC-locus block for the logic specialist's user message. "" unless
   *  enforce + a symbol-grade signal exists. */
  logicBlock: string
  /** The SYNTH-locus keep-rule block for the synth's user message. "" unless
   *  enforce + a symbol-grade signal exists. */
  synthBlock: string
}

export interface ComputeAdversarialFramingBlocksArgs {
  mode: AdversarialFramingMode
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  headSha: string
  fullPrDiff: string
  /** The full-diff source inventory + sibling mappings (the testing-evidence pack). */
  sourceFilesChanged: readonly string[]
  siblingMappings: readonly { source: string; test: string | null }[]
  /** Head content for the changed JS/TS files (first-batch fetch — see the
   *  PLUMBING NOTE below). */
  headContentByPath: ReadonlyMap<string, string>
  astCache: AstCache
}

const EMPTY: AdversarialFramingBlocks = { logicBlock: "", synthBlock: "" }

/**
 * Compute the adversarial-framing prompt blocks for this PR. Returns EMPTY in
 * shadow (after logging the signal) and on any error. Only `enforce` with a
 * symbol-grade signal returns non-empty blocks.
 */
export async function computeAdversarialFramingBlocks(
  args: ComputeAdversarialFramingBlocksArgs,
): Promise<AdversarialFramingBlocks> {
  const { mode, client, owner, repo, prNumber, headSha } = args
  if (mode === "off") return EMPTY
  try {
    const fileMetaByPath = await fetchFileMetadata(client, owner, repo, prNumber, headSha)
    const deletedLineTextByPath = buildDeletedLineTextByLine(args.fullPrDiff)
    // PLUMBING NOTE (known limitation, NOT faked): the symbol derivation reads
    // head content from `headContentByPath` (= `astFilesByPath`), which the
    // retrieval-context step fetches for the FIRST-batch reviewed files only. So a
    // removed guard whose covered SOURCE lives ONLY in a SIG-418 multibatch
    // spillover batch has no head content here → it fails CLOSED (no symbol-grade
    // signal) rather than producing an ungrounded one. The benchmark-#29 A2/A4
    // case + the common PR are single-batch, so this is covered; the
    // `messageForBatchRole` injection still fires for any covered source that DOES
    // have head content. A spillover-source head fetch is a follow-up if multibatch
    // enforce needs it.
    const { changedBySource, deletedBySource } = deriveChangedExportedSymbols({
      sourcePaths: args.sourceFilesChanged,
      headContentByPath: args.headContentByPath,
      changedLines: buildChangedLines(args.fullPrDiff),
      deletedLineTextByPath,
      astCache: args.astCache,
    })
    const removedGuardingTests: RemovedGuardingTest[] = buildRemovedGuardingTests({
      deletedLineTextByPath,
      siblingMappings: args.siblingMappings,
      changedExportedSymbolsBySource: changedBySource,
      deletedExportedSymbolsBySource: deletedBySource,
      fileMetaByPath,
    })
    const symbolGrade = symbolGradeRemovedGuardingTests(removedGuardingTests)
    console.log(
      JSON.stringify({
        event: "adversarial-framing-signal",
        owner,
        repo,
        prNumber,
        headSha: headSha.slice(0, 7),
        mode,
        promptVersion: ADVERSARIAL_FRAMING_PROMPT_VERSION,
        total: removedGuardingTests.length,
        symbolGrade: symbolGrade.length,
        stemGrade: removedGuardingTests.length - symbolGrade.length,
        // Grounded, low-cardinality breakdown for the shadow→enforce decision.
        signals: removedGuardingTests.map((s) => ({
          testPath: s.testPath,
          coveredSource: s.coveredSource,
          coveredSymbol: s.coveredSymbol,
          correlationStrength: s.correlationStrength,
        })),
      }),
    )
    // enforce ONLY: build the two prompt blocks from the SYMBOL-grade subset
    // (stem-grade is counted but never injected — Codex #1).
    if (mode === "enforce" && symbolGrade.length > 0) {
      return {
        logicBlock: renderAdversarialFramingLogicBlock(symbolGrade),
        synthBlock: renderAdversarialFramingSynthBlock(symbolGrade),
      }
    }
    return EMPTY
  } catch (err) {
    // Defense-in-depth: the signal is additive — a throw must never sink the
    // review. Fall back to no signal (off-equivalent for this run).
    console.warn(
      JSON.stringify({
        event: "adversarial-framing-error",
        owner,
        repo,
        prNumber,
        headSha: headSha.slice(0, 7),
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    return EMPTY
  }
}

/**
 * Fetch GitHub file metadata (status / previous_filename) — the ONLY source that
 * distinguishes a rename from a deletion (Codex #4). Keyed by BOTH the current
 * filename AND previous_filename, because the deleted-line map keys a renamed file
 * by its OLD path. Best-effort: on failure returns an empty map, and the detector
 * fails CLOSED downstream (any old≠new deleted-line key is treated as a rename).
 */
async function fetchFileMetadata(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
): Promise<Map<string, ChangedFileMeta>> {
  const fileMetaByPath = new Map<string, ChangedFileMeta>()
  try {
    const manifest = await client.listPullFilesForManifest(owner, repo, prNumber)
    for (const entry of manifest.entries) {
      const meta: ChangedFileMeta = { status: entry.status, previousFilename: entry.previous_filename }
      if (entry.filename.length > 0) fileMetaByPath.set(entry.filename, meta)
      if (entry.previous_filename !== null && entry.previous_filename.length > 0) {
        fileMetaByPath.set(entry.previous_filename, meta)
      }
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "adversarial-framing-file-meta-failed",
        owner,
        repo,
        prNumber,
        headSha: headSha.slice(0, 7),
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }
  return fileMetaByPath
}
