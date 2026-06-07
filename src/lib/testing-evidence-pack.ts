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
  findExistingTestSiblingForSource,
  type ClassifiedDiffFile,
} from "./diff-file-classify"
import { normalizeConcurrencyLimit } from "./bounded-concurrency"
import { isSubstantiveAddedLine } from "./helper-coverage"
import type { HelperCoverage } from "./helper-coverage"

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

export const DEFAULT_TEST_FILE_FETCH_CONCURRENCY = 5

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
  /** SIG-128: per-source helper-coverage status, keyed by source path.
   *  Only `->NONE` sources are present. Default {} (populated by
   *  `mergeHelperCoverage` at orchestrator level). */
  helperCoverageBySource: Record<string, HelperCoverage>
}

export type TestingEvidenceSuppressionReason =
  | "repo-sibling-exists"
  | "no-substantive-change"

export interface TestingEvidenceSuppression {
  source: string
  reason: TestingEvidenceSuppressionReason
  test?: string
}

export interface FilterTestingEvidenceResult {
  pack: TestingEvidencePack
  suppressions: TestingEvidenceSuppression[]
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
    helperCoverageBySource: {}, // populated by mergeHelperCoverage
  }
}

function changedLinesAreNonSubstantive(lines: readonly string[] | undefined): boolean {
  if (lines === undefined || lines.length === 0) return false
  // Caller passes added + deleted diff text; one substantive deletion keeps the row.
  return lines.every((line) => !isSubstantiveAddedLine(stripRawDiffLinePrefix(line)))
}

function stripRawDiffLinePrefix(line: string): string {
  return /^[+-]/.test(line) ? line.slice(1) : line
}

/**
 * Remove missing-sibling evidence rows that deterministic context proves
 * should not become tests-specialist "no sibling test" findings.
 *
 * This only filters `siblingMapping:<source>->NONE` rows. UNKNOWN repo state
 * fails open by passing no `repoPaths`, and ambiguous repo-wide sibling
 * matches also fail open inside `findExistingTestSiblingForSource`.
 */
export function filterTestingEvidenceForSuppressedMissingCoverage(
  pack: TestingEvidencePack,
  args: {
    changedLineTextByPath: ReadonlyMap<string, readonly string[]>
    repoPaths?: readonly string[]
  },
): FilterTestingEvidenceResult {
  const suppressions: TestingEvidenceSuppression[] = []
  const suppressedSources = new Set<string>()

  for (const mapping of pack.siblingMappings) {
    if (mapping.test !== null) continue

    const existingTest = args.repoPaths !== undefined
      ? findExistingTestSiblingForSource(mapping.source, args.repoPaths)
      : null
    if (existingTest !== null) {
      suppressions.push({
        source: mapping.source,
        reason: "repo-sibling-exists",
        test: existingTest,
      })
      suppressedSources.add(mapping.source)
      continue
    }

    if (changedLinesAreNonSubstantive(args.changedLineTextByPath.get(mapping.source))) {
      suppressions.push({
        source: mapping.source,
        reason: "no-substantive-change",
      })
      suppressedSources.add(mapping.source)
    }
  }

  if (suppressions.length === 0) {
    return { pack, suppressions }
  }

  const helperCoverageBySource = Object.fromEntries(
    Object.entries(pack.helperCoverageBySource).filter(([source]) => !suppressedSources.has(source)),
  )

  return {
    pack: {
      ...pack,
      sourceFilesChanged: pack.sourceFilesChanged.filter((source) => !suppressedSources.has(source)),
      siblingMappings: pack.siblingMappings.filter((mapping) => !suppressedSources.has(mapping.source)),
      helperCoverageBySource,
    },
    suppressions,
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
  /** Paths intentionally omitted because the total evidence budget was full. */
  budgetOmittedPaths?: string[]
  /** Per-file truncation applied? (path was over `TEST_FILE_CONTENT_CHAR_CAP`). */
  truncatedPaths: string[]
  /** Total chars across all included files after truncation. */
  totalChars: number
}

export interface BudgetedTestFileFetchResult extends InspectedTestFileFetchResult {
  /** Number of `fetchContent` calls started. */
  fetchedCount: number
  /** Number of paths skipped or omitted because the total budget was full. */
  skippedForBudgetCount: number
}

function capTestFileContent(path: string, body: string): {
  path: string
  body: string
  truncated: boolean
} {
  if (body.length <= TEST_FILE_CONTENT_CHAR_CAP) {
    return { path, body, truncated: false }
  }
  return {
    path,
    body: body.slice(0, TEST_FILE_CONTENT_CHAR_CAP) +
      `\n[…truncated at ${TEST_FILE_CONTENT_CHAR_CAP} chars per the testing-evidence per-file cap…]`,
    truncated: true,
  }
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
  const budgetOmittedPaths: string[] = []
  const truncatedPaths: string[] = []
  let totalChars = 0
  // Walk the path-order hint so the cap-fill is deterministic when
  // multiple test files arrive — `pathOrderHint` should reflect the
  // diff's natural order (e.g. alphabetical or original Codex order).
  for (let i = 0; i < pathOrderHint.length; i++) {
    const path = pathOrderHint[i]!
    if (!(path in rawContentByPath)) continue
    const capped = capTestFileContent(path, rawContentByPath[path] ?? "")
    if (capped.truncated) truncatedPaths.push(path)
    const body = capped.body
    if (totalChars + body.length > TEST_FILE_CONTENT_TOTAL_CHAR_CAP) {
      // Cap-spillover: stop including further files; the specialist
      // sees what fits in the budget. Don't try to slice a partial
      // file in — keeps the included files atomic.
      budgetOmittedPaths.push(path)
      for (const remainingPath of pathOrderHint.slice(i + 1)) {
        if (remainingPath in rawContentByPath) budgetOmittedPaths.push(remainingPath)
      }
      break
    }
    contentByPath[path] = body
    totalChars += body.length
  }
  return {
    contentByPath,
    failedPaths: [],
    budgetOmittedPaths,
    truncatedPaths,
    totalChars,
  }
}

export async function fetchTestFileContentsWithBudget(args: {
  paths: readonly string[]
  fetchContent: (path: string) => Promise<string>
  concurrency?: number
}): Promise<BudgetedTestFileFetchResult> {
  const concurrency = normalizeConcurrencyLimit(
    args.concurrency,
    Math.max(1, args.paths.length),
    DEFAULT_TEST_FILE_FETCH_CONCURRENCY,
  )
  const contentByPath: Record<string, string> = {}
  const failedPaths: string[] = []
  const budgetOmittedPaths: string[] = []
  const truncatedPaths: string[] = []
  let totalChars = 0
  let fetchedCount = 0

  for (let i = 0; i < args.paths.length; i += concurrency) {
    if (totalChars >= TEST_FILE_CONTENT_TOTAL_CHAR_CAP) {
      budgetOmittedPaths.push(...args.paths.slice(i))
      break
    }
    const batch = args.paths.slice(i, i + concurrency)
    fetchedCount += batch.length
    const fetchResults = await Promise.allSettled(
      batch.map(async (path) => ({ path, body: await args.fetchContent(path) })),
    )

    let budgetFull = false
    for (let j = 0; j < batch.length; j++) {
      const path = batch[j]!
      const result = fetchResults[j]
      if (budgetFull) {
        budgetOmittedPaths.push(path)
        continue
      }
      if (!result || result.status === "rejected" || typeof result.value.body !== "string") {
        failedPaths.push(path)
        continue
      }
      const capped = capTestFileContent(path, result.value.body)
      if (totalChars + capped.body.length > TEST_FILE_CONTENT_TOTAL_CHAR_CAP) {
        budgetOmittedPaths.push(path)
        budgetFull = true
        continue
      }
      contentByPath[path] = capped.body
      totalChars += capped.body.length
      if (capped.truncated) truncatedPaths.push(path)
    }

    if (budgetFull) {
      budgetOmittedPaths.push(...args.paths.slice(i + concurrency))
      break
    }
    if (totalChars >= TEST_FILE_CONTENT_TOTAL_CHAR_CAP) {
      budgetOmittedPaths.push(...args.paths.slice(i + concurrency))
      break
    }
  }

  return {
    contentByPath,
    failedPaths,
    budgetOmittedPaths,
    truncatedPaths,
    totalChars,
    fetchedCount,
    skippedForBudgetCount: budgetOmittedPaths.length,
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
 * SIG-128: merge detected helper-coverage into the pack. Returns a new
 * pack (immutable). Populated at orchestrator level because detection
 * needs file content + diff the pure builder doesn't receive.
 */
export function mergeHelperCoverage(
  pack: TestingEvidencePack,
  coverageBySource: Record<string, HelperCoverage>,
): TestingEvidencePack {
  return { ...pack, helperCoverageBySource: { ...coverageBySource } }
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
      const cov = pack.helperCoverageBySource[p]
      let siblingHint: string
      if (m && m.test !== null) {
        siblingHint = `  ← covered by test in this PR: \`${m.test}\``
      } else if (cov?.status === "all") {
        const list = cov.helpers.map((h) => `\`${h}\``).join(", ")
        siblingHint = `  ← no sibling test file in this PR, but ALL changed logic here delegates to helpers unit-tested in this PR: ${list}`
      } else if (cov?.status === "partial") {
        const list = cov.helpers.map((h) => `\`${h}\``).join(", ")
        siblingHint = `  ← no sibling test file in this PR; SOME changed lines call tested helpers (${list}), others add inline logic — judge accordingly`
      } else {
        siblingHint = `  ← no sibling test file in this PR`
      }
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
      } else if (inspectedContent.failedPaths.includes(p)) {
        // CodeRabbit catch on PR #112: distinguish a genuine fetch
        // failure from cap-spillover. Only paths in `failedPaths`
        // actually errored; a path absent from contentByPath for any
        // OTHER reason (total-budget spillover) is a capacity drop,
        // not a fetch error — misstating it biases the specialist.
        annotations.push("content NOT available (fetch failed)")
      } else {
        annotations.push("content NOT available (omitted to fit the evidence-block size budget)")
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
    "- When firing a `category: \"testing\"` finding claiming a source file lacks test coverage, anchor the finding to that source file (its `path`) and set `evidenceRefs` to the EXACT mapping string for THAT source from \"Source→test mapping refs\" below. The cited mapping's source must equal the finding's `path` — citing a mapping for a different file is rejected.",
  )
  lines.push(
    "- When the finding instead claims the existing tests are insufficient (vs. absent), set `inspectedTestFiles` to one or more of the EXACT test-file paths listed under \"Inspected test files\" below — files whose full content is embedded in this block. A path not in that list is rejected.",
  )
  lines.push(
    "- When the finding claims the PR REMOVED or RENAMED test coverage (a deleted test file), set `evidenceRefs: [\"testFileChanged:<path>\"]` naming a path from \"Test files changed in this PR\" above. Use this form when the test was deleted (so its content can't be embedded).",
  )
  lines.push(
    "- Findings without a citation that resolves against this block are dropped silently and never reach the customer review.",
  )
  lines.push("")

  // SIG-113 (CodeRabbit PR #112 catch): emit the EXACT citation
  // strings the validator accepts, so the model copies them verbatim
  // instead of inventing a near-miss the cross-check rejects.
  if (pack.siblingMappings.length > 0) {
    lines.push("Source→test mapping refs (copy verbatim into `evidenceRefs`):")
    for (const m of pack.siblingMappings) {
      lines.push(`- \`siblingMapping:${m.source}->${m.test ?? "NONE"}\``)
    }
    lines.push("")
  }
  if (pack.inspectedTestFiles.length > 0) {
    lines.push("Inspected test files (copy verbatim into `inspectedTestFiles`):")
    for (const p of pack.inspectedTestFiles) {
      lines.push(`- \`${p}\``)
    }
    lines.push("")
  }

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
