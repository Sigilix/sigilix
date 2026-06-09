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

import type { ReviewableMap } from "@/shared/util/diff-positions"

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
 * SIG-127: per-file map of new-side `+`-line NUMBER → the line's TEXT
 * (the content WITHOUT the leading `+`). Same diff-walk geometry as
 * `buildChangedLines` — only the per-`+`-line payload differs (text
 * instead of membership). Used by `buildReviewSubmission` to decide
 * whether a finding's anchored added line is substantive code or a
 * structural line (a bare `}`, blank line, etc.) that should route to
 * the review summary body instead of an inline comment.
 */
export function buildAddedLineTextByLine(diff: string): Map<string, Map<number, string>> {
  const out = new Map<string, Map<number, string>>()
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
        if (!out.has(currentPath)) out.set(currentPath, new Map())
      }
      inHunk = false
      continue
    }

    if (raw.startsWith("--- ")) {
      // Old-side path; ignored — the `+++` line is authoritative.
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

    // Leading-char check matches `buildChangedLines` — inside a hunk the
    // `+++`/`---` header branches already cleared `inHunk`, so a single
    // leading `+` is unambiguously an added content line.
    if (raw[0] === "+") {
      const map = out.get(currentPath)
      // Strip ONLY the leading diff marker (`+`); the rest is verbatim
      // line content (preserves indentation so callers can classify a
      // `  }` line as structural).
      if (map) map.set(newLine, raw.slice(1))
      newLine++
      continue
    }
    if (raw[0] === "-") {
      // Old-side line — does not advance the new-side counter.
      continue
    }
    if (raw.startsWith(" ")) {
      // Context line — advances the new-side counter, not captured.
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
 * Per-file map of old-side `-`-line NUMBER → deleted line TEXT
 * (content WITHOUT the leading `-`). Used by tests-specialist evidence
 * to make deleted regression assertions salient without treating them
 * as new-side reviewable source lines.
 */
export function buildDeletedLineTextByLine(diff: string): Map<string, Map<number, string>> {
  const out = new Map<string, Map<number, string>>()
  if (!diff || typeof diff !== "string") return out

  const lines = diff.split("\n")
  let currentPath: string | null = null
  let oldLine = 0
  let inHunk = false

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ""

    if (raw.startsWith("diff --git ")) {
      currentPath = null
      inHunk = false
      continue
    }

    if (raw.startsWith("--- ")) {
      const oldPath = raw.slice(4).trim()
      if (oldPath === "/dev/null") {
        currentPath = null
      } else {
        currentPath = oldPath.startsWith("a/") ? oldPath.slice(2) : oldPath
        if (!out.has(currentPath)) out.set(currentPath, new Map())
      }
      inHunk = false
      continue
    }

    if (raw.startsWith("+++ ")) {
      inHunk = false
      continue
    }

    const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/.exec(raw)
    if (hunk) {
      oldLine = Number(hunk[1])
      inHunk = true
      continue
    }

    if (!inHunk || currentPath === null) continue

    if (raw[0] === "-") {
      const map = out.get(currentPath)
      if (map) map.set(oldLine, raw.slice(1))
      oldLine++
      continue
    }
    if (raw[0] === "+") {
      continue
    }
    if (raw.startsWith(" ")) {
      oldLine++
      continue
    }
    if (raw.startsWith("\\")) {
      continue
    }
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
