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

    // BUGGY: the smallest function enclosing the finding line in the original file.
    const buggy = enclosingFunctionText(source, line, ext)
    if (buggy === null) return null

    // FIXED: splice `repl` into the source and re-extract the enclosing function.
    // The range `repl` actually replaces is ambiguous — `startLine` is often the wider
    // ENCLOSING-BLOCK start (e.g. the function header), not the literal replaced span,
    // so splicing [startLine, line] with a one-line fix can delete the header and make
    // the file unparseable. So try candidate ranges (narrowest-meaningful first) and
    // take the FIRST that yields a parseable, CHANGED enclosing function:
    //   - a SINGLE-line fix replaces just the anchor line [line, line];
    //   - a K-line fix replaces the documented [startLine ?? line, line], then the
    //     K lines ending at the anchor [line-K+1, line], then the anchor line alone.
    const replLineCount = repl.replace(/\r?\n$/, "").split(/\r?\n/).length
    const startLine = typeof finding.startLine === "number" && finding.startLine >= 1 ? finding.startLine : line
    const candidateRanges: Array<[number, number]> =
      replLineCount === 1
        ? [
            [line, line],
            [startLine, line],
          ]
        : [
            [startLine, line],
            [line - replLineCount + 1, line],
            [line, line],
          ]
    for (const [s, e] of candidateRanges) {
      if (s < 1 || s > e) continue
      const fixedSource = spliceLines(source, s, e, repl)
      if (fixedSource === null) continue
      const fixed = enclosingFunctionText(fixedSource, s, ext)
      if (fixed === null) continue
      // A fix that doesn't change the function gives no two-sided test → try the next.
      if (buggy.trim() === fixed.trim()) continue
      return { buggy, fixed }
    }
    return null
  } catch {
    return null
  }
}
