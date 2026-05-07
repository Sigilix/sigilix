// ARC-181: diff-line filter + reviewable-position resolver.
//
// Two distinct concerns wrapped together:
//
// 1. `buildChangedLines(diff)` — extracts the set of new-side `+`
//    lines per file. **`-` lines are NOT counted** (Codex MAJOR #6
//    on plan review: replacement hunks contribute only the new-side
//    `+` line; pure-deletion hunks contribute nothing). The returned
//    set is used by the runner to filter findings down to lines the
//    PR actually touched, so pre-existing code in untouched regions
//    of changed files is not re-flagged.
//
// 2. `findReviewPosition(reviewable, path, line)` — wraps the
//    existing `parseDiffToReviewablePositions` output (ARC-184/Phase
//    4 infrastructure) so AST findings that may auto-post resolve
//    to a `{ line, side: "RIGHT" }` GitHub review position. Returns
//    null when the line isn't reviewable (e.g., line is in a
//    deleted file's old side).

import type { ReviewableMap } from "../diff-positions"

export type ChangedLines = Map<string, Set<number>>

/**
 * Build the per-file `+`-line set from a unified diff. Mirrors the
 * geometry used by `parseDiffToReviewablePositions` but emits ONLY
 * new-side line numbers (the existing helper emits both sides plus
 * context). Used as the changed-lines filter for AST findings.
 */
export function buildChangedLines(diff: string): ChangedLines {
  const out: ChangedLines = new Map()
  if (!diff || typeof diff !== "string") return out

  const lines = diff.split("\n")
  let currentPath: string | null = null
  let newLine = 0
  let inHunk = false

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ""

    if (raw.startsWith("diff --git ")) {
      currentPath = null
      inHunk = false
      continue
    }

    if (raw.startsWith("+++ ")) {
      const newPath = raw.slice(4).trim()
      if (newPath === "/dev/null") {
        // File deleted — no new-side lines.
        currentPath = null
      } else {
        currentPath = newPath.startsWith("b/") ? newPath.slice(2) : newPath
        if (!out.has(currentPath)) out.set(currentPath, new Set())
      }
      inHunk = false
      continue
    }

    if (raw.startsWith("--- ")) {
      // Old-side path; we ignore it for the changed-lines map. The
      // `+++` line is authoritative for the new-side path.
      inHunk = false
      continue
    }

    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunk = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(raw)
    if (hunk) {
      newLine = Number(hunk[1])
      inHunk = true
      continue
    }

    if (!inHunk || currentPath === null) continue

    // Inside a hunk, `+++ b/path` / `--- a/path` headers don't
    // appear — those branches already set `inHunk = false`. So
    // checking the leading char is safe AND avoids false-skipping
    // content lines whose CONTENT starts with `++` or `--` (which
    // render as `+++` / `---` in the diff). CR catch on PR #67.
    if (raw[0] === "+") {
      const set = out.get(currentPath)
      if (set) set.add(newLine)
      newLine++
      continue
    }
    if (raw[0] === "-") {
      // Old-side line — does NOT advance the new-side counter and is
      // NOT added to the new-side changed set.
      continue
    }
    if (raw.startsWith(" ")) {
      // Context line — present on both sides; advances new-side
      // counter but is not "changed".
      newLine++
      continue
    }
    if (raw.startsWith("\\")) {
      // "\ No newline at end of file" marker; skip.
      continue
    }
    // Other line shapes (binary marker, etc.): ignore.
  }
  return out
}

/**
 * Returns true when `[startLine, endLine]` (inclusive, 1-based)
 * intersects the changed-lines set for the given path.
 */
export function nodeOverlapsChanged(
  changed: ChangedLines,
  path: string,
  startLine: number,
  endLine: number,
): boolean {
  const set = changed.get(path)
  if (!set || set.size === 0) return false
  for (let l = startLine; l <= endLine; l++) {
    if (set.has(l)) return true
  }
  return false
}

/**
 * Resolve a finding's `(path, line)` to a GitHub review-comment
 * position via the existing `parseDiffToReviewablePositions` map.
 * Returns null when no reviewable position exists (rare — file
 * deletions, edge cases) so the runner can emit
 * `ast-rules-finding-no-review-position` telemetry and fall back
 * to prompt-block-only injection.
 */
export function findReviewPosition(
  reviewable: ReviewableMap,
  path: string,
  line: number,
): { line: number; side: "RIGHT" } | null {
  const positions = reviewable.get(path)
  if (!positions) return null
  const match = positions.find((p) => p.side === "RIGHT" && p.line === line)
  if (!match) return null
  return { line: match.line, side: "RIGHT" }
}
