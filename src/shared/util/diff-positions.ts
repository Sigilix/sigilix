// Parse a unified diff into the set of reviewable GitHub review-comment
// positions per file. The orchestrator (Phase 4 ensemble) uses this to
// validate that synthesizer findings point at real, reviewable lines
// before submitting to GitHub.
//
// GitHub review-comment semantics:
//   - Added lines (+):    side: RIGHT, line: new-file line number
//   - Deleted lines (-):  side: LEFT,  line: old-file line number
//   - Context lines ( ):  side: RIGHT, line: new-file line number (still
//                         reviewable; reviewers anchor comments on
//                         unchanged lines around their edits)
//
// Why `{path, line, side}` and not `Map<line, side>` (Codex catch on
// PR #34 / Phase 4 spec round 3):
//   When a modified hunk has both a deletion and an addition at the same
//   numeric line (e.g., line 42 deleted from old, line 42 added to new),
//   a single `Map<line, side>` is ambiguous about which side a reviewer
//   means. Storing every reviewable position explicitly removes the
//   ambiguity — the validator just checks "does any (line, side) match
//   what the model wrote?"

export interface ReviewablePosition {
  /** New-file line for RIGHT, old-file line for LEFT. */
  line: number
  side: "LEFT" | "RIGHT"
}

/**
 * Map from file path → list of reviewable positions in that file.
 * A file can have many positions; the validator uses
 * `positions.some(p => p.line === finding.line && p.side === finding.side)`.
 */
export type ReviewableMap = Map<string, ReviewablePosition[]>

/**
 * Parse a unified diff into the per-file reviewable position map.
 *
 * Tolerates the common formats GitHub returns:
 *   - `diff --git a/foo b/foo` headers
 *   - `--- a/foo` / `+++ b/foo` lines
 *   - `@@ -x,y +z,w @@` hunk headers
 *   - `\ No newline at end of file` markers (skipped)
 *
 * Skips binary diffs (`Binary files ... differ`) — they have no
 * reviewable line positions.
 */
export function parseDiffToReviewablePositions(diff: string): ReviewableMap {
  const out: ReviewableMap = new Map()
  if (!diff || typeof diff !== "string") return out

  const lines = diff.split("\n")
  let currentPath: string | null = null
  let oldLine = 0
  let newLine = 0
  let inHunk = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""

    // New file boundary.
    if (line.startsWith("diff --git ")) {
      currentPath = null
      inHunk = false
      continue
    }

    // The `+++ b/...` line carries the new path. We prefer this over
    // `--- a/...` because for added files `--- /dev/null` has no path.
    if (line.startsWith("+++ ")) {
      const newPath = line.slice(4).trim()
      if (newPath === "/dev/null") {
        // File deleted entirely — no new-side reviewable positions.
        // The `--- a/<path>` we already saw could still anchor LEFT
        // comments on the deleted lines, but most review tooling
        // doesn't comment on fully-deleted files. Skip for simplicity.
        currentPath = null
      } else {
        // Strip the leading "b/" GitHub adds. Defensive against repos
        // that don't use the b/ prefix.
        currentPath = newPath.startsWith("b/") ? newPath.slice(2) : newPath
        if (!out.has(currentPath)) out.set(currentPath, [])
      }
      inHunk = false
      continue
    }

    if (line.startsWith("--- ")) {
      // Old-file path — used only when newPath is /dev/null (file
      // deletions). Phase 4a doesn't anchor comments on deleted files,
      // so we don't track currentPath from this line.
      inHunk = false
      continue
    }

    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    if (line.startsWith("@@")) {
      const match = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/)
      if (!match) {
        inHunk = false
        continue
      }
      oldLine = Number(match[1])
      newLine = Number(match[3])
      inHunk = currentPath !== null
      continue
    }

    if (!inHunk || currentPath === null) continue

    // Inside a hunk. Each line tells us about ONE position on ONE side.
    const positions = out.get(currentPath)
    if (!positions) continue

    if (line.startsWith("+")) {
      // Added line → RIGHT side, new-file line number.
      positions.push({ line: newLine, side: "RIGHT" })
      newLine++
    } else if (line.startsWith("-")) {
      // Deleted line → LEFT side, old-file line number.
      positions.push({ line: oldLine, side: "LEFT" })
      oldLine++
    } else if (line.startsWith(" ")) {
      // Context line — reviewable on RIGHT (the new file). The same
      // physical line is also at oldLine on the old file, but
      // reviewing a context line means anchoring on the new file
      // contents, so RIGHT is the right answer.
      positions.push({ line: newLine, side: "RIGHT" })
      oldLine++
      newLine++
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" or similar — skip, no line counter
      // movement.
      continue
    } else if (line.length === 0) {
      // Blank line within a hunk = context line that happens to be
      // empty. Still reviewable on RIGHT.
      positions.push({ line: newLine, side: "RIGHT" })
      oldLine++
      newLine++
    } else {
      // Unknown leading char (e.g., "Binary files ... differ" or
      // sub-headers). Treat as end of current hunk.
      inHunk = false
    }
  }

  return out
}

/**
 * True iff the given (path, line, side) matches at least one parsed
 * reviewable position. Used by the post-synthesis validator.
 */
export function isPositionReviewable(
  reviewable: ReviewableMap,
  path: string,
  line: number,
  side: "LEFT" | "RIGHT",
): boolean {
  const positions = reviewable.get(path)
  if (!positions) return false
  return positions.some((p) => p.line === line && p.side === side)
}

/**
 * Given a finding's (path, line) without an explicit side, derive
 * the most likely side from the parsed diff. Returns RIGHT when a
 * RIGHT-side position exists at that line (preferred — most findings
 * comment on added/changed code), LEFT only when LEFT is the only
 * match, and null when no match exists at all.
 *
 * This is the orchestrator's "pick the side" step (Codex catch:
 * synthesizer should NOT decide side; orchestrator derives from diff).
 */
export function deriveSide(reviewable: ReviewableMap, path: string, line: number): "LEFT" | "RIGHT" | null {
  const positions = reviewable.get(path)
  if (!positions) return null
  const right = positions.find((p) => p.line === line && p.side === "RIGHT")
  if (right) return "RIGHT"
  const left = positions.find((p) => p.line === line && p.side === "LEFT")
  if (left) return "LEFT"
  return null
}

/**
 * Return true iff every line in `[startLine..line]` is RIGHT-reviewable
 * for `path`. A missing intermediate line means the range crosses a hunk
 * boundary. Pure. (Moved here from triage-pr-improve.ts, SIG-125, so both
 * the /improve and proactive-review paths share one anchoring primitive.)
 */
export function isContiguousRightRange(
  reviewable: ReviewableMap,
  path: string,
  startLine: number,
  line: number,
): boolean {
  if (startLine > line) return false
  for (let l = startLine; l <= line; l++) {
    if (!isPositionReviewable(reviewable, path, l, "RIGHT")) return false
  }
  return true
}
