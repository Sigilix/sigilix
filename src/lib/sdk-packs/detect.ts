// SIG-298 follow-on — SDK guidance pack detection.
//
// Cheap, pure regex work over the diff text the review already has in memory
// (`fullPrDiff`) — no extra fetches, no network. Detects two signals per pack:
//   1. a `package.json` dependency ADD matching one of the pack's `packages`
//   2. an added import/require line matching one of the pack's `importPatterns`
// A pack additionally matches if a changed file's path matches one of its
// optional `pathGlobs`.
//
// Relevance ranking: packs are sorted by the number of DISTINCT changed files
// that contributed a match (more files touching the SDK = more relevant),
// then by id for a stable tie-break. Capped at MAX_MATCHED_PACKS packs and
// MAX_TOTAL_RULES total rules across the returned packs (rules are taken in
// pack-declaration order once a pack is selected).

import type { MatchedSdkPack, SdkPack } from "./types"

export const MAX_MATCHED_PACKS = 3
export const MAX_TOTAL_RULES = 12

interface DiffFileBlock {
  path: string
  addedLines: string[]
}

/**
 * Minimal unified-diff walk: per new-side file, collect the `+` lines
 * (without the leading `+`). Mirrors the geometry of
 * `buildAddedLineTextByLine` (@/src/features/ast-rules) but returns a flat
 * array per file (detection doesn't need line numbers, just line text).
 */
function splitDiffIntoFileBlocks(diff: string): DiffFileBlock[] {
  const blocks: DiffFileBlock[] = []
  if (!diff || typeof diff !== "string") return blocks

  let current: DiffFileBlock | null = null
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      current = null
      continue
    }
    if (raw.startsWith("+++ ")) {
      const newPath = raw.slice(4).trim()
      if (newPath === "/dev/null") {
        current = null
      } else {
        const path = newPath.startsWith("b/") ? newPath.slice(2) : newPath
        current = { path, addedLines: [] }
        blocks.push(current)
      }
      continue
    }
    if (raw.startsWith("--- ")) continue
    if (current === null) continue
    // Hunk headers, context, and removed lines are irrelevant to detection —
    // we only care about what the PR ADDS.
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      current.addedLines.push(raw.slice(1))
    }
  }
  return blocks
}

const PACKAGE_JSON_DEP_LINE_RE = /^\s*"([^"]+)"\s*:\s*"/
const PACKAGE_JSON_PATH_RE = /(^|\/)package\.json$/

function isPackageJsonPath(path: string): boolean {
  return PACKAGE_JSON_PATH_RE.test(path)
}

/** Dependency names added in any `package.json` (or `package.json`-named) file in the diff. */
function collectAddedPackageDeps(blocks: readonly DiffFileBlock[]): Set<string> {
  const deps = new Set<string>()
  for (const block of blocks) {
    if (!isPackageJsonPath(block.path)) continue
    for (const line of block.addedLines) {
      const m = PACKAGE_JSON_DEP_LINE_RE.exec(line)
      if (m?.[1]) deps.add(m[1])
    }
  }
  return deps
}

/**
 * Simple `*`/`**` glob → RegExp. No brace expansion — matchers keep
 * pathGlobs simple. `**\/` matches zero-or-more leading path segments (so
 * `**\/app/**\/*.tsx` matches both `app/page.tsx` AND `web/app/x/page.tsx`),
 * a bare `**` matches anything, and `*` matches within one path segment.
 */
function globToRegExp(glob: string): RegExp {
  let out = ""
  let i = 0
  while (i < glob.length) {
    if (glob.startsWith("**/", i)) {
      out += "(?:.*/)?"
      i += 3
    } else if (glob.startsWith("**", i)) {
      out += ".*"
      i += 2
    } else if (glob[i] === "*") {
      out += "[^/]*"
      i += 1
    } else {
      out += glob[i]!.replace(/[.+^${}()|[\]\\]/g, "\\$&")
      i += 1
    }
  }
  return new RegExp(`^${out}$`)
}

function packMatchesFile(pack: SdkPack, block: DiffFileBlock, addedDeps: ReadonlySet<string>): boolean {
  // The package-add signal only attributes to the package.json block(s) that
  // actually carried it — NOT to every other changed file in the diff (code-
  // reviewer catch: `addedDeps` is diff-wide, so this must stay path-scoped
  // or a single dep add inflates `matchedPaths` to the whole PR).
  if (isPackageJsonPath(block.path) && pack.matchers.packages.some((name) => addedDeps.has(name))) return true
  if (pack.matchers.importPatterns.some((re) => block.addedLines.some((line) => re.test(line)))) return true
  const globs = pack.matchers.pathGlobs
  if (globs && globs.some((g) => globToRegExp(g).test(block.path))) return true
  return false
}

/**
 * Detect which SDK packs are relevant to a PR from its unified diff. Pure —
 * takes the full diff text and the registry of candidate packs, returns the
 * capped, relevance-sorted matches. Never throws (a malformed diff just
 * yields no matches for the affected files).
 */
export function detectSdkPacks(diff: string, packs: readonly SdkPack[]): MatchedSdkPack[] {
  const blocks = splitDiffIntoFileBlocks(diff)
  if (blocks.length === 0) return []
  const addedDeps = collectAddedPackageDeps(blocks)

  const candidates: MatchedSdkPack[] = []
  for (const pack of packs) {
    const matchedPaths = blocks.filter((b) => packMatchesFile(pack, b, addedDeps)).map((b) => b.path)
    if (matchedPaths.length > 0) candidates.push({ pack, matchedPaths })
  }

  // Relevance: the pack whose imports/deps appear in MORE changed files ranks
  // higher; ties break on id for a deterministic, testable order. The
  // ≤12-rules-total cap is enforced at render time (`renderSdkGuidanceForPrompt`),
  // not here — selection is purely "which ≤3 packs are most relevant."
  candidates.sort((a, b) => b.matchedPaths.length - a.matchedPaths.length || a.pack.id.localeCompare(b.pack.id))
  return candidates.slice(0, MAX_MATCHED_PACKS)
}
