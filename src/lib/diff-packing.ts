// ARC-192: hunk-level diff packing for large PRs.
//
// Sigilix sends the full diff to every specialist. For PRs with diffs
// >~12K tokens, this silently degrades: specialists either truncate
// context, refuse to respond, or hallucinate. This module splits the
// diff by file and packs files into batches under a per-call token
// cap so the orchestrator can run specialists multiple times when a
// PR is too large to fit in one call.
//
// v1 scope (deliberately minimal):
//   - Split diff at `diff --git` boundaries
//   - Estimate tokens via char/4 heuristic (no tokenizer dep — Workers
//     runtime can't easily ship one without bundle bloat; the heuristic
//     is conservative enough for the gross "fits or doesn't fit"
//     decision we need)
//   - Pack files greedily into batches under the cap
//   - DROP files that exceed the cap individually (no mid-file split
//     in v1; track them in telemetry so post-hoc analysis can flag if
//     the policy needs to change)
//   - Caller orchestrates the multi-batch fanout + verdict merge

// SIG-369(b) THROWAWAY PROBE — opens one PR so a real review runs the logic
// specialist through the shadow input-composition instrumentation. DO NOT MERGE;
// the branch is closed right after the telemetry is read.
export const SIG369B_PROBE = 1

/**
 * One file's worth of diff content extracted from a unified diff.
 * `path` is the new-file path (i.e. the right side); for pure
 * deletions where new path is /dev/null, `path` falls back to the
 * old path so we still group/track the block.
 */
export interface DiffFileBlock {
  path: string
  /** Full diff text for this file, starting at the `diff --git ...`
   *  line and ending at the line BEFORE the next `diff --git ...`
   *  (or end of input). */
  body: string
  /** body.length — cached so callers don't recompute. */
  charCount: number
}

/**
 * Default per-call cap. Sized for `deepseek-v4-pro:cloud` (32K context)
 * after subtracting system prompt (~3K), retrieval snapshot (~5K), and
 * output JSON budget (~4K). 12K leaves ~8K safety margin.
 *
 * Override via `OPENCLAW_MAX_DIFF_TOKENS_PER_CALL` env var if a
 * specific repo benefits from a different cap (large monorepos may
 * want lower; tiny services may want higher). Not yet wired.
 */
export const DEFAULT_MAX_DIFF_TOKENS_PER_CALL = 12_000

/** Conservative chars-per-token estimate for English+code. */
const CHARS_PER_TOKEN = 4

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Split a unified diff into per-file blocks.
 *
 * Each block runs from a `diff --git ...` line to the next
 * `diff --git ...` (or end of input). The block's `path` is taken
 * from the `+++ b/<path>` line; for pure deletions (`+++ /dev/null`)
 * we fall back to the `--- a/<path>` line so the block still has a
 * stable identifier.
 *
 * Tolerates input that doesn't start with `diff --git` (any leading
 * lines before the first marker are dropped — they don't belong to
 * any file). Empty input returns an empty array.
 */
export function splitDiffByFile(diff: string): DiffFileBlock[] {
  const blocks: DiffFileBlock[] = []
  if (!diff) return blocks

  const lines = diff.split("\n")
  let current: string[] = []
  let newPath: string | null = null
  let oldPath: string | null = null

  const flush = (): void => {
    if (current.length === 0) return
    const body = current.join("\n")
    const path = newPath ?? oldPath ?? "(unknown)"
    blocks.push({ path, body, charCount: body.length })
    current = []
    newPath = null
    oldPath = null
  }

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush()
      current.push(line)
      continue
    }
    // We're inside a file block (or before the first one — current is
    // empty so we drop these lines on flush).
    if (current.length === 0) continue
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim()
      if (p !== "/dev/null") {
        newPath = p.startsWith("b/") ? p.slice(2) : p
      }
    } else if (line.startsWith("--- ")) {
      const p = line.slice(4).trim()
      if (p !== "/dev/null") {
        oldPath = p.startsWith("a/") ? p.slice(2) : p
      }
    }
    current.push(line)
  }
  flush()
  return blocks
}

/**
 * Result of packing files into batches.
 *
 * `batches` is an ordered list of file groups; each group's combined
 * body fits under `maxTokensPerBatch`. Order across batches preserves
 * input order — caller can present them to the model "in repo
 * walk order" so any cross-file context the model picked up earlier
 * is still semantically near later batches.
 *
 * `droppedTooLarge` lists paths whose individual diff exceeds
 * maxTokensPerBatch. v1 drops these rather than splitting mid-file —
 * the orchestrator surfaces them via telemetry so post-hoc analysis
 * can decide whether splitting policy needs to change. A common cause
 * is a single huge generated file (lockfile, snapshot test) that
 * pathFilters should have excluded.
 */
export interface PackResult {
  batches: DiffFileBlock[][]
  droppedTooLarge: string[]
}

/**
 * Greedily pack files into batches under `maxTokensPerBatch`.
 *
 * Greedy is fine for v1 because the cap is much larger than typical
 * file diffs (12K tokens vs ~500-2K tokens for an average changed
 * file). True bin-packing would only matter when files were close to
 * the cap individually, which means we have a different problem
 * (oversized file → drop or split mid-file).
 */
export function packFilesIntoBatches(
  files: DiffFileBlock[],
  maxTokensPerBatch: number = DEFAULT_MAX_DIFF_TOKENS_PER_CALL,
): PackResult {
  const batches: DiffFileBlock[][] = []
  const droppedTooLarge: string[] = []
  let current: DiffFileBlock[] = []
  let currentTokens = 0

  for (const file of files) {
    const fileTokens = estimateTokens(file.body)
    if (fileTokens > maxTokensPerBatch) {
      droppedTooLarge.push(file.path)
      continue
    }
    // If adding this file would push the current batch over, start a
    // new batch. The single-file case (current empty) always packs
    // because we already filtered oversized files above.
    if (currentTokens + fileTokens > maxTokensPerBatch && current.length > 0) {
      batches.push(current)
      current = []
      currentTokens = 0
    }
    current.push(file)
    currentTokens += fileTokens
  }
  if (current.length > 0) batches.push(current)

  return { batches, droppedTooLarge }
}

/**
 * SIG-414: stable risk-ordering for review coverage. When a PR spans more than
 * one batch, only `batches[0]` is reviewed — so the riskiest files must land
 * first. Partitions `files` into (high-risk, rest), preserving original order
 * within each tier (deterministic). Returns the input UNCHANGED when all-or-none
 * are high-risk (nothing to promote), so callers stay byte-identical in the
 * common case. `isHighRisk` is injected so this leaf stays dependency-free (the
 * predicate lives in the ensemble domain).
 */
export function riskOrderFiles(files: DiffFileBlock[], isHighRisk: (path: string) => boolean): DiffFileBlock[] {
  const high = files.filter((f) => isHighRisk(f.path))
  if (high.length === 0 || high.length === files.length) return files
  return [...high, ...files.filter((f) => !isHighRisk(f.path))]
}

/**
 * Reassemble a batch into a single diff string. Preserves file order
 * within the batch.
 */
export function batchToDiff(batch: DiffFileBlock[]): string {
  return batch.map((f) => f.body).join("\n")
}
