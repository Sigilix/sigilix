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
// unrelated line and fabricating a divergence (the false-reproduce vector). And we only
// relocate when the near-twin is UNAMBIGUOUS: exactly ONE distinct source REGION matches.
// If two+ distinct regions are near-twins (two sibling functions, a coincidental clone),
// we can't tell which is the bug → skip (null). This is FP-safe by construction: we never
// RANK among distinct regions (neither similarity nor closeness — both were shown to pick
// the wrong sibling), we only act on a unique match. Recall cost is accepted — REPRODUCED
// is a minority signal, and a wrong inline badge is worse than a missed one.
const LOCATE_MIN_SIMILARITY = 0.8
const LOCATE_MAX_LINE_LEN = 400
// A fix often COLLAPSES a multi-line buggy region into fewer lines (e.g. a 2-line loop +
// body → one line). So match the fix against WINDOWS of up to this many consecutive
// source lines (joined), not just single lines — the joined window is the near-twin.
const LOCATE_MAX_WINDOW = 3

/**
 * SIG-479: locate the buggy REGION by matching the FIX against the source. Real findings
 * often anchor `finding.line` at the function header / an adjacent function, so the
 * enclosing-fn lookup grabs the wrong function. The fix is a near-twin of the lines it
 * replaces (a single line for an in-place edit, or a joined multi-line window for a
 * collapse). Returns the 1-based inclusive [start,end] of the UNIQUE near-twin region, or
 * null when there is none OR more than one distinct region (ambiguous → FP-safe skip).
 */
function locateNearTwinRange(source: string, fix: string): [number, number] | null {
  const target = normalizeLine(fix.replace(/\r?\n/g, " "))
  if (target.length === 0 || target.length > LOCATE_MAX_LINE_LEN * LOCATE_MAX_WINDOW) return null
  const lines = source.split(/\r?\n/)
  const cands: Array<{ start: number; end: number; sim: number }> = []
  for (let i = 0; i < lines.length; i++) {
    const parts: string[] = []
    for (let w = 0; w < LOCATE_MAX_WINDOW && i + w < lines.length; w++) {
      const ln = normalizeLine(lines[i + w] ?? "")
      if (w === 0 && ln.length === 0) break // don't start a window on a blank line
      parts.push(ln)
      const joined = parts.join(" ").trim()
      if (joined.length === 0 || joined.length > LOCATE_MAX_LINE_LEN * LOCATE_MAX_WINDOW) continue
      if (joined === target) continue // the fix is already present here — not the buggy region
      const sim = similarity(joined, target)
      if (sim >= LOCATE_MIN_SIMILARITY) cands.push({ start: i + 1, end: i + w + 1, sim })
    }
  }
  if (cands.length === 0) return null
  // Merge OVERLAPPING windows into distinct regions (same bug at different window sizes is
  // one region); keep each region's best-similarity window. Then require EXACTLY ONE region.
  cands.sort((a, b) => a.start - b.start || a.end - b.end)
  const regions: Array<{ end: number; best: { start: number; end: number; sim: number } }> = []
  for (const c of cands) {
    const last = regions[regions.length - 1]
    if (last && c.start <= last.end) {
      last.end = Math.max(last.end, c.end)
      if (c.sim > last.best.sim) last.best = c
    } else {
      regions.push({ end: c.end, best: c })
    }
  }
  if (regions.length !== 1) return null // none or ambiguous (2+ distinct regions) → skip
  const r = regions[0]?.best
  return r ? [r.start, r.end] : null
}

/** SIG-481: the reconstruction outcome WITH a stable machine-readable reason, so a
 *  `reconstructed:false` in prod telemetry stops being a black box. `reason` is `"ok"` on
 *  success; otherwise it names the gate that fired (see {@link reconstructPureLogicPairDiag}). */
export interface ReconstructDiag {
  pair: ReconstructedPair | null
  /** "ok" | "no-source" | "left-anchor" | "bad-line" | "no-fix" | "no-enclosing-fn" |
   *  "no-changed-fn" | "error" */
  reason: string
}

/** Splice `repl` into the FIRST of `ranges` that yields a parseable, CHANGED enclosing
 *  function (extracted at the splice start). The buggy side is the function enclosing
 *  `enclosingLine`. Returns the pair (reason `"ok"`), or null with the blocking reason:
 *  `"no-enclosing-fn"` (no function spans the anchor — a mis-anchor) or `"no-changed-fn"`
 *  (no range produced a parseable, changed function). */
function reconstructFromRanges(
  source: string,
  ranges: ReadonlyArray<[number, number]>,
  repl: string,
  enclosingLine: number,
  ext: SourceExt,
): ReconstructDiag {
  const buggy = enclosingFunctionText(source, enclosingLine, ext)
  if (buggy === null) return { pair: null, reason: "no-enclosing-fn" }
  for (const [s, e] of ranges) {
    if (s < 1 || s > e) continue
    const fixedSource = spliceLines(source, s, e, repl)
    if (fixedSource === null) continue
    const fixed = enclosingFunctionText(fixedSource, s, ext)
    if (fixed === null || buggy.trim() === fixed.trim()) continue // no change → no two-sided test
    return { pair: { buggy, fixed }, reason: "ok" }
  }
  return { pair: null, reason: "no-changed-fn" }
}

/**
 * Reconstruct the BUGGY + FIXED function for a pure-logic finding from the full-file
 * NEW-side `source`, returning the pair AND a stable reason (see {@link ReconstructDiag}).
 * NEVER throws. Reasons: `no-source` / `left-anchor` / `bad-line` / `no-fix` are the input
 * guards; `no-enclosing-fn` / `no-changed-fn` come from the splice attempt; `error` is the
 * fail-safe catch. This is the instrumented core — {@link reconstructPureLogicPair} is the
 * thin pair-only wrapper kept for existing callers.
 */
export function reconstructPureLogicPairDiag(source: string | undefined, finding: ReconstructInput): ReconstructDiag {
  try {
    if (typeof source !== "string" || source.length === 0) return { pair: null, reason: "no-source" }
    // A LEFT anchor's `line` is an OLD-side number; it won't resolve in the NEW-file AST.
    if (finding.anchorSide === "LEFT") return { pair: null, reason: "left-anchor" }
    const line = finding.line
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return { pair: null, reason: "bad-line" }
    const repl = finding.suggestedReplacement
    if (typeof repl !== "string" || repl.trim().length === 0) return { pair: null, reason: "no-fix" }

    const ext = extForPath(finding.path)
    const replLineCount = repl.replace(/\r?\n$/, "").split(/\r?\n/).length
    const startLine = typeof finding.startLine === "number" && finding.startLine >= 1 ? finding.startLine : line

    if (replLineCount === 1) {
      // SIG-479: locate the buggy REGION by NEAR-TWIN match to the fix (FP-guarded) so a
      // mis-anchored `finding.line` (header / adjacent fn) still reconstructs the RIGHT
      // function, and a fix that COLLAPSES a multi-line region matches its joined window.
      // The near-twin requirement means we never splice an unrelated line/region.
      const region = locateNearTwinRange(source, repl)
      if (region !== null) {
        const r = reconstructFromRanges(source, [region], repl, region[0], ext)
        if (r.pair !== null) return r
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
    return { pair: null, reason: "error" }
  }
}

/**
 * Reconstruct the BUGGY + FIXED function for a pure-logic finding from the full-file
 * NEW-side `source`. Returns null on any guard (see module header). NEVER throws. Thin
 * wrapper over {@link reconstructPureLogicPairDiag} for callers that don't need the reason.
 */
export function reconstructPureLogicPair(
  source: string | undefined,
  finding: ReconstructInput,
): ReconstructedPair | null {
  return reconstructPureLogicPairDiag(source, finding).pair
}
