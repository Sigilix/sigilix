// SIG-113: testing-specialist evidence pack.
//
// Why this exists:
//   The pre-SIG-113 testing specialist received a `[DIFF FILE
//   CLASSIFICATION]` block computed from `reviewedFiles.map(f => f.path)` —
//   the first packed-diff batch after filtering. On PRs where the test
//   files lived in a later batch (or were modified-not-added so the
//   sibling-prefix matcher needed full content) the block was incomplete,
//   and the specialist hallucinated "module ships without tests" findings.
//   Eight P0/P2 false positives on PR #110 + PR #111 alone.
//
//   Root cause confirmed by the SIG-115 3-lens research (Codex /
//   `deepseek-v4-pro:cloud` / `glm-5.1:cloud` — all three converged):
//   incomplete pre-LLM evidence + a schema that forces a verdict + no
//   post-LLM citation gate. This module is the evidence-pack half; the
//   schema + parser changes shipped in the prior commit; the validator
//   ships in the next.
//
// Contract:
//   1. Operate on the FULL `splitFiles` inventory (every file in the
//      PR's selected diff), NOT `reviewedFiles` (first batch only).
//   2. Surface which test files are in the prompt diff vs which got
//      dropped by the batcher — the specialist needs to know its
//      input is incomplete when that happens.
//   3. Include the FULL CONTENT of added/modified test files (within
//      a per-file char cap so the prompt stays sane). The specialist
//      can then cite which files it inspected via `inspectedTestFiles`
//      on each finding; the validator drops "missing tests" findings
//      where `inspectedTestFiles.length === 0`.
//
// Out of scope (deferred):
//   - Same evidence-pack pattern for security / logic / performance
//     specialists → SIG-108 / SIG-109 / SIG-110 (this module's shape
//     is the template).
//   - Two-stage tests specialist (deterministic existence check + LLM
//     sufficiency review) → SIG-111 follow-up.

import {
  classifyDiffFiles,
  type ClassifiedDiffFile,
} from "./diff-file-classify"

/**
 * Per-file cap on test-file content embedded in the prompt. A typical
 * Sigilix test file is 100-500 lines / 5-20KB; the cap stops a single
 * pathologically-large fixture from blowing the specialist's token
 * budget. Truncation is signaled in the rendered block so the
 * specialist knows the file is partial.
 */
export const TEST_FILE_CONTENT_CHAR_CAP = 20_000

/**
 * Overall cap on total test-file content (sum across all included
 * files). Per-file cap + total cap together bound the prompt growth
 * even when many test files are added at once.
 */
export const TEST_FILE_CONTENT_TOTAL_CHAR_CAP = 60_000

/**
 * A single source/test sibling mapping derived from the full diff
 * inventory. `test === null` means the source file has no sibling
 * test in this PR — the specialist may legitimately fire a "missing
 * tests" finding citing this mapping via
 * `evidenceRefs: ["siblingMapping:<source>->NONE"]`.
 */
export interface TestingSiblingMapping {
  source: string
  test: string | null
}

export interface TestingEvidencePack {
  /** Non-test source files in the PR's full diff (post-filter,
   *  pre-batch). Includes files that fell out of the first batch. */
  sourceFilesChanged: string[]
  /** Test files in the PR's full diff (added OR modified). */
  testFilesChanged: string[]
  /** Subset of `testFilesChanged` whose patch survived batch packing
   *  and is therefore in the specialist's `[DIFF]` block. */
  testFilesInPromptDiff: string[]
  /** Subset of `testFilesChanged` that the batcher dropped from the
   *  prompt diff. The specialist still gets these files' content via
   *  `inspectedTestFiles` when fetched, but flagging the gap helps it
   *  reason about input completeness. */
  testFilesNotInPromptDiff: string[]
  /** Source → test pairings (or `test: null` when no sibling in this
   *  PR). Derived from `classifyDiffFiles` on the FULL diff list. */
  siblingMappings: TestingSiblingMapping[]
  /** Paths of test files whose full content is available in
   *  `inspectedTestFileContents` (populated separately by an async
   *  fetch step in the orchestrator). */
  inspectedTestFiles: string[]
}

/**
 * Build the testing evidence pack from the PR's full diff inventory.
 *
 * Pure function — no I/O. The orchestrator runs the async test-file
 * content fetch separately and merges results in via
 * `mergeInspectedTestFileContents`. Splitting build (pure) from fetch
 * (async + I/O-bound) lets the build step stay deterministic + unit-
 * testable + cheap.
 *
 * Args:
 *   splitFilePaths   — every path in the PR's selected diff (post-
 *                       filter, pre-batch). Pass `splitFiles.map(f => f.path)`.
 *   reviewedFilePaths — paths that survived batch packing into the
 *                       first batch (= the files in the specialist's
 *                       `[DIFF]` block). Pass `reviewedFiles.map(f => f.path)`.
 */
export function buildTestingEvidencePack(args: {
  splitFilePaths: readonly string[]
  reviewedFilePaths: readonly string[]
}): TestingEvidencePack {
  const reviewedSet = new Set(args.reviewedFilePaths)
  // Classify against the FULL diff inventory — the SIG-113 fix vs the
  // pre-fix call site which only classified `reviewedFiles`.
  const classified: ClassifiedDiffFile[] = classifyDiffFiles(args.splitFilePaths)

  const sourceFilesChanged: string[] = []
  const testFilesChanged: string[] = []
  const testFilesInPromptDiff: string[] = []
  const testFilesNotInPromptDiff: string[] = []
  const siblingMappings: TestingSiblingMapping[] = []

  for (const c of classified) {
    if (c.kind === "source") {
      sourceFilesChanged.push(c.path)
      siblingMappings.push({ source: c.path, test: c.testsSibling })
    } else if (c.kind === "test") {
      testFilesChanged.push(c.path)
      if (reviewedSet.has(c.path)) {
        testFilesInPromptDiff.push(c.path)
      } else {
        testFilesNotInPromptDiff.push(c.path)
      }
    }
  }

  return {
    sourceFilesChanged,
    testFilesChanged,
    testFilesInPromptDiff,
    testFilesNotInPromptDiff,
    siblingMappings,
    inspectedTestFiles: [], // populated by mergeInspectedTestFileContents
  }
}

/**
 * Result of an async test-file content fetch. Both arrays + the map
 * are keyed by the path the orchestrator asked for; the map only
 * contains paths whose fetch succeeded.
 */
export interface InspectedTestFileFetchResult {
  /** Map of `<path> -> file content (possibly truncated)`. */
  contentByPath: Record<string, string>
  /** Paths whose fetch failed (404, network error, etc.). */
  failedPaths: string[]
  /** Per-file truncation applied? (path was over `TEST_FILE_CONTENT_CHAR_CAP`). */
  truncatedPaths: string[]
  /** Total chars across all included files after truncation. */
  totalChars: number
}

/**
 * Apply the per-file + total caps to a raw fetch result. The
 * orchestrator builds `rawContentByPath` via `client.getFileContent`
 * (mirroring the AST fetch pattern at
 * `src/lib/triage-pr-review-ensemble.ts:1227`) and hands it here for
 * cap-application + truncation accounting. Pure.
 */
export function applyTestFileContentCaps(
  rawContentByPath: Record<string, string>,
  pathOrderHint: readonly string[],
): InspectedTestFileFetchResult {
  const contentByPath: Record<string, string> = {}
  const truncatedPaths: string[] = []
  let totalChars = 0
  // Walk the path-order hint so the cap-fill is deterministic when
  // multiple test files arrive — `pathOrderHint` should reflect the
  // diff's natural order (e.g. alphabetical or original Codex order).
  for (const path of pathOrderHint) {
    if (!(path in rawContentByPath)) continue
    let body = rawContentByPath[path] ?? ""
    if (body.length > TEST_FILE_CONTENT_CHAR_CAP) {
      body = body.slice(0, TEST_FILE_CONTENT_CHAR_CAP) +
        `\n[…truncated at ${TEST_FILE_CONTENT_CHAR_CAP} chars per the testing-evidence per-file cap…]`
      truncatedPaths.push(path)
    }
    if (totalChars + body.length > TEST_FILE_CONTENT_TOTAL_CHAR_CAP) {
      // Cap-spillover: stop including further files; the specialist
      // sees what fits in the budget. Don't try to slice a partial
      // file in — keeps the included files atomic.
      break
    }
    contentByPath[path] = body
    totalChars += body.length
  }
  return {
    contentByPath,
    failedPaths: [],
    truncatedPaths,
    totalChars,
  }
}

/**
 * Merge fetched test-file content into the evidence pack so the
 * pack's `inspectedTestFiles` field reflects what's actually
 * embedded in the rendered block. Returns a new pack (immutable).
 */
export function mergeInspectedTestFileContents(
  pack: TestingEvidencePack,
  fetchResult: InspectedTestFileFetchResult,
): TestingEvidencePack {
  return {
    ...pack,
    inspectedTestFiles: Object.keys(fetchResult.contentByPath),
  }
}

/**
 * Render the `[TESTING EVIDENCE]` block injected at the top of the
 * testing specialist's user message. The block:
 *   1. Lists every source file changed in the PR (NOT just first-batch)
 *   2. Lists every test file changed in the PR + flags which are
 *      missing from the prompt's `[DIFF]` block
 *   3. Documents source → test sibling pairings (or "NONE")
 *   4. Embeds full content of inspected test files (subject to caps)
 *   5. Instructs the specialist HOW to cite via `inspectedTestFiles` +
 *      `evidenceRefs` schema fields
 *
 * Returns "" when the diff has zero source AND zero test files (e.g.
 * pure docs PR) — keeps the prompt lean when there's no signal.
 */
export function renderTestingEvidenceBlock(
  pack: TestingEvidencePack,
  inspectedContent: InspectedTestFileFetchResult,
): string {
  if (pack.sourceFilesChanged.length === 0 && pack.testFilesChanged.length === 0) {
    return ""
  }

  const lines: string[] = [
    "[TESTING EVIDENCE — authoritative; computed from the full diff before specialist dispatch]",
    "",
  ]

  if (pack.sourceFilesChanged.length > 0) {
    lines.push(`Source files changed in this PR (${pack.sourceFilesChanged.length}):`)
    for (const p of pack.sourceFilesChanged) {
      const m = pack.siblingMappings.find((s) => s.source === p)
      const siblingHint = m && m.test !== null
        ? `  ← covered by test in this PR: \`${m.test}\``
        : `  ← no sibling test file in this PR`
      lines.push(`- \`${p}\`${siblingHint}`)
    }
    lines.push("")
  }

  if (pack.testFilesChanged.length > 0) {
    lines.push(`Test files changed in this PR (${pack.testFilesChanged.length}):`)
    for (const p of pack.testFilesChanged) {
      const inPromptDiff = pack.testFilesInPromptDiff.includes(p)
      const contentAvailable = p in inspectedContent.contentByPath
      const truncated = inspectedContent.truncatedPaths.includes(p)
      const annotations: string[] = []
      if (inPromptDiff) {
        annotations.push("in [DIFF] block")
      } else {
        annotations.push("NOT in [DIFF] block (batcher dropped — see content below if available)")
      }
      if (contentAvailable) {
        annotations.push(truncated ? "content included below (truncated)" : "content included below")
      } else {
        annotations.push("content NOT available (fetch failed)")
      }
      lines.push(`- \`${p}\` — ${annotations.join("; ")}`)
    }
    lines.push("")
  }

  // SIG-113: explicit instructions on citing evidence. The validator
  // gates on these fields downstream.
  lines.push(
    "Citation requirements (the orchestrator's `evaluateTestingFindingCitation` gate drops findings that don't cite):",
  )
  lines.push(
    "- When firing a `category: \"testing\"` finding claiming a source file lacks test coverage, you MUST set `evidenceRefs: [\"siblingMapping:<source>-><NONE|tests/...>\"]` referencing one of the source→test mappings above.",
  )
  lines.push(
    "- When the finding instead claims the existing tests are insufficient (vs. absent), set `inspectedTestFiles: [\"<test-file-path>\"]` listing the test files you actually read to form the judgment.",
  )
  lines.push(
    "- Findings without either citation are dropped silently and never reach the customer review.",
  )
  lines.push("")

  // Embed the test-file content. Walk `testFilesChanged` order so the
  // rendering is deterministic and matches the inventory list above.
  if (pack.testFilesChanged.length > 0 && Object.keys(inspectedContent.contentByPath).length > 0) {
    for (const p of pack.testFilesChanged) {
      const body = inspectedContent.contentByPath[p]
      if (!body) continue
      lines.push(`[TEST FILE CONTENT — \`${p}\`]`)
      // code-reviewer M2 catch (pre-PR): test files in this very repo
      // contain triple-backticks (markdown-rendering assertions,
      // prompt-string fixtures). A bare ``` fence would be closed
      // early by an embedded ``` in the body, corrupting the block
      // structure the specialist parses. Use a fence longer than any
      // backtick run in the body (CommonMark's info-string rule).
      const fence = pickFence(body)
      lines.push(fence)
      lines.push(body)
      lines.push(fence)
      lines.push(`[END \`${p}\`]`)
      lines.push("")
    }
  }

  return lines.join("\n").trimEnd()
}

/**
 * SIG-113: choose a backtick fence longer than the longest run of
 * backticks in `body`, so embedding `body` in a fenced block can't be
 * terminated early by a triple-backtick inside it. Minimum 3 (the
 * standard fence); grows to maxRun+1 when the body has a longer run.
 *
 * Pure — exported for tests.
 */
export function pickFence(body: string): string {
  let maxRun = 0
  let current = 0
  for (const ch of body) {
    if (ch === "`") {
      current += 1
      if (current > maxRun) maxRun = current
    } else {
      current = 0
    }
  }
  return "`".repeat(Math.max(3, maxRun + 1))
}
