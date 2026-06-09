// SIG-131: AST-aware chunking for JS/TS. Produces chunks via a coalesced
// line-interval partition of the file — every NON-blank line lands in exactly
// one chunk, no overlaps, top-level declarations kept whole (signature+body).
// Pure + never throws: any failure returns null so the indexer falls back to
// the line-window chunker. Per-method class decomposition is deferred (SIG-131
// follow-up); an oversized declaration line-splits via splitOversizedWindow.

import { type Chunk, MAX_CHUNK_CHARS, splitOversizedWindow } from "./chunk-core"
import { parseSource, type SourceExt } from "@/features/ast-rules"

const JS_TS_EXTS: ReadonlySet<string> = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx",
])

/** The JS/TS SourceExt for a path, or null (non-JS/TS → line-window fallback). */
export function jsTsExtOf(path: string): SourceExt | null {
  const dot = path.lastIndexOf(".")
  if (dot < 0) return null
  const e = path.slice(dot).toLowerCase()
  return JS_TS_EXTS.has(e) ? (e as SourceExt) : null
}

/**
 * Chunk `content` at AST boundaries. Returns null on parse failure / any
 * internal error (caller falls back to line-window). Never throws.
 */
export function chunkFileAst(path: string, content: string, ext: SourceExt): Chunk[] | null {
  try {
    const parsed = parseSource(content, ext)
    if (!parsed.ok) return null

    const lines = content.split("\n")
    const lineCount = lines.length

    const body = (parsed.ast as { body?: unknown }).body
    if (!Array.isArray(body)) return null

    const intervals: Array<[number, number]> = []
    for (const node of body as Array<{ loc?: { start?: { line?: unknown }; end?: { line?: unknown } } }>) {
      const s = node?.loc?.start?.line
      const e = node?.loc?.end?.line
      if (typeof s !== "number" || typeof e !== "number") continue
      if (s < 1 || e < s) continue
      intervals.push([s, Math.min(e, lineCount)])
    }

    // Coalesce: sort by start, merge overlapping OR adjacent ranges.
    intervals.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
    const merged: Array<[number, number]> = []
    for (const [s, e] of intervals) {
      const last = merged[merged.length - 1]
      if (last && s <= last[1] + 1) {
        if (e > last[1]) last[1] = e
      } else {
        merged.push([s, e])
      }
    }

    // Gap-fill from a cursor → cover [1..lineCount]; skip whitespace-only slices
    // (embedder throws on blank; chunkFile skips blank windows too).
    const out: Chunk[] = []
    const emit = (startLine: number, endLine: number): void => {
      if (endLine < startLine) return
      const slice = lines.slice(startLine - 1, endLine)
      const text = slice.join("\n")
      if (text.trim().length === 0) return
      if (text.length > MAX_CHUNK_CHARS) {
        for (const sub of splitOversizedWindow(slice, startLine)) out.push({ ...sub, path })
      } else {
        out.push({ path, lineStart: startLine, lineEnd: endLine, content: text })
      }
    }

    let cursor = 1
    for (const [s, e] of merged) {
      if (s > cursor) emit(cursor, s - 1)
      emit(s, e)
      cursor = e + 1
    }
    if (cursor <= lineCount) emit(cursor, lineCount)
    return out
  } catch {
    return null
  }
}
