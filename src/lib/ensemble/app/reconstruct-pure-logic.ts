// SIG-477 PR-4b — source reconstruction for the pure-function-logic reproduce wedge.
//
// A real Sigilix finding cites code at the LINE level: the "current" block is a
// single line, and `suggestedReplacement` is the changed hunk (often one line), NOT a
// whole function. The pure-logic harness needs a BUGGY function + a FIXED function to
// run side-by-side, so we RECONSTRUCT them from the full NEW-side file source:
//   1. find the SMALLEST function enclosing `finding.line` in the file AST → BUGGY fn,
//   2. splice `suggestedReplacement` into the finding's anchored range
//      [startLine ?? line, line], re-extract the enclosing function → FIXED fn.
// The harness then lifts both as full functions (it strips TS types itself).
//
// Fail-OPEN to null (→ the pass falls back to lifting the finding's cited fragments,
// which usually records `not-liftable-closure`): a LEFT anchor (the line is an OLD-
// side number that won't resolve in the NEW-file AST), missing / unparseable source,
// no enclosing function (e.g. a mis-anchored finding pointing at the wrong function),
// no usable fix, or a fix that doesn't change the function. NEVER throws.

import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import { parseSource, type SourceExt } from "@/src/features/ast-rules"
import { enclosingFunctions } from "@/src/lib/ensemble/domain/gates/validate-logic-claim-refutation"

/** The reconstructed buggy + fixed function source (full functions, TS types intact —
 *  the harness strips them on lift). */
export interface ReconstructedPair {
  buggy: string
  fixed: string
}

/** The finding fields reconstruction reads. */
export type ReconstructInput = Pick<
  PrReviewFinding,
  "path" | "line" | "startLine" | "anchorSide" | "suggestedReplacement"
>

/** Map a path to the SourceExt the parser should use (defaults to .ts). */
function extForPath(path: string): SourceExt {
  const p = path.toLowerCase()
  if (p.endsWith(".tsx")) return ".tsx" as SourceExt
  if (p.endsWith(".jsx")) return ".jsx" as SourceExt
  if (p.endsWith(".mts")) return ".mts" as SourceExt
  if (p.endsWith(".cts")) return ".cts" as SourceExt
  if (p.endsWith(".mjs")) return ".mjs" as SourceExt
  if (p.endsWith(".cjs")) return ".cjs" as SourceExt
  if (p.endsWith(".js")) return ".js" as SourceExt
  return ".ts" as SourceExt
}

/** Verbatim text of the SMALLEST function enclosing `line` in `source`, or null when
 *  the source doesn't parse, no function spans the line, or the node range is bad. */
function enclosingFunctionText(source: string, line: number, ext: SourceExt): string | null {
  const parsed = parseSource(source, ext)
  if (!parsed.ok) return null
  const fns = enclosingFunctions(parsed.ast, line)
  if (fns.length === 0) return null
  const fn = fns[0] as { start?: unknown; end?: unknown }
  const start = fn?.start
  const end = fn?.end
  if (typeof start !== "number" || typeof end !== "number") return null
  if (start < 0 || end > source.length || end <= start) return null
  // Normalize CRLF → LF so the buggy (verbatim-sliced) and fixed (re-joined by
  // spliceLines with "\n") texts are comparable — else the unchanged-fn guard is
  // silently defeated on CRLF repos. LF is fine for the guest + the parser.
  return source.slice(start, end).replace(/\r\n/g, "\n")
}

/** Replace source lines [startLine, endLine] (1-based, inclusive) with `replacement`.
 *  Returns null on an out-of-range span. */
function spliceLines(source: string, startLine: number, endLine: number, replacement: string): string | null {
  const lines = source.split(/\r?\n/)
  if (startLine < 1 || endLine > lines.length || startLine > endLine) return null
  const before = lines.slice(0, startLine - 1)
  const after = lines.slice(endLine)
  const replLines = replacement.replace(/\r?\n$/, "").split(/\r?\n/)
  return [...before, ...replLines, ...after].join("\n")
}

/** Normalize a line for similarity matching: trim + collapse internal whitespace. */
function normalizeLine(s: string): string {
  return s.trim().replace(/\s+/g, " ")
}

/** Levenshtein distance, bounded (caller caps input length). */
function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  let curr = new Array<number>(n + 1)
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n] ?? Math.max(m, n)
}

/** Char-level similarity in [0,1] (1 = identical). */
function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length)
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max
}

// SIG-479 tolerant-locate tuning (FP-safety hardened per DeepSeek): the line a fix
// REPLACES is its NEAR-TWIN (an off-by-one differs by ~1 char). We NEVER splice a line
// that isn't a near-twin (≥ MIN_SIMILARITY) — that prevents splicing the fix into an
// unrelated line and fabricating a divergence (the false-reproduce vector). When several
// lines are near-twins we PREFER one within ±PROXIMITY of the finding's anchor (mis-
// anchoring is usually local — a header just above the bug); only go GLOBAL when no local
// near-twin exists, and then require a clear MARGIN over the runner-up so a coincidental
// near-clone elsewhere can't win (it safely skips instead → never a false reproduce).
const LOCATE_MIN_SIMILARITY = 0.8
const LOCATE_MIN_MARGIN = 0.1
const LOCATE_PROXIMITY = 12
const LOCATE_MAX_LINE_LEN = 400

/**
 * SIG-479: locate the buggy line by matching the (single-line) FIX against the source.
 * Real findings often anchor `finding.line` to the function header / an adjacent
 * function, so the enclosing-fn lookup grabs the wrong function. The fix is a near-twin
 * of the line it replaces. Returns a 1-based line (a confident near-twin) or null.
 *   - PROXIMITY: among near-twins within ±LOCATE_PROXIMITY of `anchorLine`, take the most
 *     similar (ties → closest) — a LOCAL mis-anchor, no margin needed.
 *   - GLOBAL: else the single best near-twin, but ONLY if it beats the runner-up by
 *     ≥ MARGIN (a tie among far near-clones → null, the FP-safe skip).
 */
function locateNearTwinLine(source: string, fixLine: string, anchorLine: number): number | null {
  const target = normalizeLine(fixLine)
  if (target.length === 0 || target.length > LOCATE_MAX_LINE_LEN) return null
  const lines = source.split(/\r?\n/)
  const candidates: Array<{ line: number; sim: number }> = []
  for (let i = 0; i < lines.length; i++) {
    const norm = normalizeLine(lines[i] ?? "")
    if (norm.length === 0 || norm.length > LOCATE_MAX_LINE_LEN) continue
    if (norm === target) continue // the fix is already present here — not the buggy line
    const sim = similarity(norm, target)
    if (sim >= LOCATE_MIN_SIMILARITY) candidates.push({ line: i + 1, sim })
  }
  if (candidates.length === 0) return null
  // PROXIMITY: prefer a local near-twin — BUT require the same clear MARGIN as the global
  // path. Without it, two sibling functions with an identical line (finding mis-anchored
  // at the second's header) would coin-flip to the closest = a false reproduce on a
  // non-bug. Near-equal local clones → null (the FP-safe skip), never closest-wins.
  const local = candidates.filter((c) => Math.abs(c.line - anchorLine) <= LOCATE_PROXIMITY)
  if (local.length > 0) {
    local.sort((a, b) => b.sim - a.sim || Math.abs(a.line - anchorLine) - Math.abs(b.line - anchorLine))
    const top = local[0]
    const runnerUp = local[1]?.sim ?? 0
    return top && top.sim - runnerUp >= LOCATE_MIN_MARGIN ? top.line : null
  }
  // GLOBAL: a single confident winner with a clear margin only.
  candidates.sort((a, b) => b.sim - a.sim)
  const best = candidates[0]
  const second = candidates[1]?.sim ?? 0
  if (best && best.sim - second >= LOCATE_MIN_MARGIN) return best.line
  return null
}

/** Splice `repl` into the FIRST of `ranges` that yields a parseable, CHANGED enclosing
 *  function (extracted at the splice start). The buggy side is the function enclosing
 *  `enclosingLine`. Returns the pair or null. */
function reconstructFromRanges(
  source: string,
  ranges: ReadonlyArray<[number, number]>,
  repl: string,
  enclosingLine: number,
  ext: SourceExt,
): ReconstructedPair | null {
  const buggy = enclosingFunctionText(source, enclosingLine, ext)
  if (buggy === null) return null
  for (const [s, e] of ranges) {
    if (s < 1 || s > e) continue
    const fixedSource = spliceLines(source, s, e, repl)
    if (fixedSource === null) continue
    const fixed = enclosingFunctionText(fixedSource, s, ext)
    if (fixed === null || buggy.trim() === fixed.trim()) continue // no change → no two-sided test
    return { buggy, fixed }
  }
  return null
}

/**
 * Reconstruct the BUGGY + FIXED function for a pure-logic finding from the full-file
 * NEW-side `source`. Returns null on any guard (see module header). NEVER throws.
 */
export function reconstructPureLogicPair(
  source: string | undefined,
  finding: ReconstructInput,
): ReconstructedPair | null {
  try {
    if (typeof source !== "string" || source.length === 0) return null
    // A LEFT anchor's `line` is an OLD-side number; it won't resolve in the NEW-file AST.
    if (finding.anchorSide === "LEFT") return null
    const line = finding.line
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return null
    const repl = finding.suggestedReplacement
    if (typeof repl !== "string" || repl.trim().length === 0) return null

    const ext = extForPath(finding.path)
    const replLineCount = repl.replace(/\r?\n$/, "").split(/\r?\n/).length
    const startLine = typeof finding.startLine === "number" && finding.startLine >= 1 ? finding.startLine : line

    if (replLineCount === 1) {
      // SIG-479: locate the buggy line by NEAR-TWIN match to the fix (FP-guarded) so a
      // mis-anchored `finding.line` (header / adjacent fn) still reconstructs the RIGHT
      // function — the near-twin requirement means we never splice an unrelated line.
      const anchor = locateNearTwinLine(source, repl, line)
      if (anchor !== null) {
        const r = reconstructFromRanges(source, [[anchor, anchor]], repl, anchor, ext)
        if (r !== null) return r
      }
      // Fallback (pre-SIG-479 behavior): documented ranges at the finding's anchor —
      // covers a single-line fix that COLLAPSES a multi-line block (no near-twin), and
      // the correctly-anchored case. [line,line] first (a 1-line fix usually replaces
      // just the anchor), then the wider [startLine,line].
      return reconstructFromRanges(
        source,
        [
          [line, line],
          [startLine, line],
        ],
        repl,
        line,
        ext,
      )
    }

    // Multi-line fix: documented ranges at the finding's anchor (no tolerant relocation
    // in v1 — single-line is the dominant + the observed mis-anchored case).
    return reconstructFromRanges(
      source,
      [
        [startLine, line],
        [line - replLineCount + 1, line],
        [line, line],
      ],
      repl,
      line,
      ext,
    )
  } catch {
    return null
  }
}
