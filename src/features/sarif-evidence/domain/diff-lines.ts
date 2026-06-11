// ARC-188: minimal diff-line filter — extracted from the same logic
// shipped in ARC-181's `src/lib/ast-rules/diff-filter.ts`. Inlined
// here so this branch doesn't depend on ARC-181 being merged first.
//
// Post-merge follow-up: DRY up by promoting both implementations to
// a shared `src/lib/diff-changed-lines.ts` module. Both branches
// share the contract; only the import path differs.
//
// Returns the per-file `+` (new-side) line set so SARIF findings on
// untouched code in changed files don't get re-flagged.

export type ChangedLines = Map<string, Set<number>>

export function buildChangedLines(diff: string): ChangedLines {
  const out: ChangedLines = new Map()
  if (!diff || typeof diff !== "string") return out

  const lines = diff.split("\n")
  let currentPath: string | null = null
  let newLine = 0
  let inHunk = false

  for (const raw of lines) {
    if (raw.startsWith("diff --git ")) {
      currentPath = null
      inHunk = false
      continue
    }
    if (raw.startsWith("+++ ")) {
      const newPath = raw.slice(4).trim()
      if (newPath === "/dev/null") {
        currentPath = null
      } else {
        currentPath = newPath.startsWith("b/") ? newPath.slice(2) : newPath
        if (!out.has(currentPath)) out.set(currentPath, new Set())
      }
      inHunk = false
      continue
    }
    if (raw.startsWith("--- ")) {
      inHunk = false
      continue
    }
    const hunk = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(raw)
    if (hunk) {
      newLine = Number(hunk[1])
      inHunk = true
      continue
    }
    if (!inHunk || currentPath === null) continue
    if (raw[0] === "+") {
      const set = out.get(currentPath)
      if (set) set.add(newLine)
      newLine++
      continue
    }
    if (raw[0] === "-") continue
    if (raw.startsWith(" ")) {
      newLine++
      continue
    }
  }
  return out
}

export function nodeOverlapsChanged(changed: ChangedLines, path: string, startLine: number, endLine: number): boolean {
  const set = changed.get(path)
  if (!set || set.size === 0) return false
  for (let l = startLine; l <= endLine; l++) {
    if (set.has(l)) return true
  }
  return false
}
