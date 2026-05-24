// SIG-131: chunking primitives extracted from indexer.ts so the AST chunker
// (ast-chunker.ts) and the indexer can both depend on them without a cycle.
// The line-window chunker is the fallback for non-JS/TS files + parse failures.

export const CHUNK_LINES = 30
export const CHUNK_OVERLAP = 10
// Token-safe cap (SIG-133). The embedder (bge-base-en-v1.5) is a BERT
// WordPiece model with a ~512-token context. Code averages ~3 chars/token,
// so 1400 chars ≈ ~470 tokens, leaving margin for [CLS]/[SEP] + dense
// lines that pack more tokens per char. No tokenizer is available offline
// to measure exactly, so 1400 is the conservative choice; SIG-131 may
// re-tune this with a real token measurement. The previous 1800-char cap
// silently dropped 2.2% of windows and left ~15% in the 1400-1800 band
// that likely overflowed the context and got truncated by the embedder.
export const MAX_CHUNK_CHARS = 1_400

export interface Chunk {
  path: string
  lineStart: number
  lineEnd: number
  content: string
  /**
   * SIG-133: set ONLY on hard-split fragments of a single over-cap line.
   * Disambiguates otherwise-identical slices (same path/lineStart/lineEnd/
   * content) so `chunkId` doesn't hash them to one id and let Vectorize
   * collapse them. Omitted on normal chunks — those stay purely content-
   * addressed so re-runs are idempotent.
   */
  fragmentIndex?: number
}

/**
 * Split the lines of a single over-cap window into consecutive
 * sub-chunks, each <= MAX_CHUNK_CHARS, with no content lost (SIG-133).
 *
 * `windowStartLine` is the 1-based absolute file line number of
 * `lines[0]`, so emitted sub-chunks carry true file line ranges.
 *
 * Splitting is on LINE boundaries: lines accumulate into a buffer; before
 * appending a line, if `buffer + "\n" + line` would exceed the cap the
 * buffer is flushed as a sub-chunk and a fresh buffer starts. A SINGLE
 * line that itself exceeds the cap is hard-split into <=cap character
 * slices, each emitted with `lineStart === lineEnd ===` that line's
 * absolute number. `path` is left empty here and set by the caller.
 */
export function splitOversizedWindow(
  lines: ReadonlyArray<string>,
  windowStartLine: number,
): Chunk[] {
  const chunks: Chunk[] = []
  let buf = ""
  let bufStartLine = windowStartLine
  // SIG-133 C1: track the buffer by LINE COUNT, not string length. A blank
  // line ("") is real content (a line that must be covered + counted) yet
  // contributes 0 to buf.length. Gating buffer-open state on buf.length
  // made flush() bail on a blank-only buffer and let the next iteration
  // overwrite bufStartLine — dropping blank lines at split boundaries and
  // shifting the first sub-chunk's lineStart forward. bufLineCount fixes it.
  let bufLineCount = 0

  const flush = (): void => {
    if (bufLineCount === 0) return
    // SIG-131: never emit a whitespace-only sub-chunk — embedTexts throws on
    // blank input. A buffer of only blank lines (e.g. trailing blanks in an
    // oversized window) is dropped here, mirroring chunkFile's blank-window skip.
    if (buf.trim().length === 0) {
      buf = ""
      bufLineCount = 0
      return
    }
    chunks.push({
      path: "",
      lineStart: bufStartLine,
      lineEnd: bufStartLine + bufLineCount - 1,
      content: buf,
    })
    buf = ""
    bufLineCount = 0
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    const absLine = windowStartLine + i

    // A single physical line longer than the cap: flush any pending
    // buffer, then hard-split this line into <=cap char slices, each
    // tagged with this line's absolute number (lineStart === lineEnd).
    // M3 (known rare limitation, SIG-133): two byte-identical hard-split
    // slices of one repeating >2*cap line collide on chunk ID; left as-is.
    if (line.length > MAX_CHUNK_CHARS) {
      flush()
      // SIG-133 (CodeRabbit Major): tag each fragment with its index. Two
      // byte-identical slices of one repeating line (e.g. a 3000-char run of
      // `=`) share path/lineStart/lineEnd/content, so without this they'd
      // hash to the same chunkId and Vectorize would collapse them —
      // reintroducing data loss on the very path that's meant to prevent it.
      let fragmentIndex = 0
      for (let off = 0; off < line.length; off += MAX_CHUNK_CHARS) {
        const frag = line.slice(off, off + MAX_CHUNK_CHARS)
        if (frag.trim().length === 0) continue // SIG-131: skip blank fragment (embedder throws)
        chunks.push({
          path: "",
          lineStart: absLine,
          lineEnd: absLine,
          content: frag,
          fragmentIndex,
        })
        fragmentIndex += 1
      }
      continue
    }

    // Would appending this line (with its joining newline if the buffer
    // already holds a line) overflow the cap? If so, flush and start fresh.
    const candidate = bufLineCount === 0 ? line.length : buf.length + 1 + line.length
    if (candidate > MAX_CHUNK_CHARS) {
      flush()
      buf = line
      bufStartLine = absLine
      bufLineCount = 1
      continue
    }

    if (bufLineCount === 0) {
      buf = line
      bufStartLine = absLine
      bufLineCount = 1
    } else {
      buf = `${buf}\n${line}`
      bufLineCount += 1
    }
  }

  flush()
  return chunks
}

/**
 * Split file content into overlapping line windows — 30-line windows
 * with 10-line overlap, skip empty windows, stop at end of file.
 *
 * SIG-133 (split-not-drop): a window whose char length exceeds
 * MAX_CHUNK_CHARS is no longer dropped (that silently lost 2.2% of
 * windows on our own repo, e.g. dense schema regions, and left ~15% in
 * the 1400-1800 char band that likely overflowed the embedder's ~512-
 * token context and got truncated). It is now SPLIT into consecutive
 * sub-chunks via splitOversizedWindow(), each <= MAX_CHUNK_CHARS, with
 * no content lost. The cap was also lowered to a token-safe 1400 chars.
 *
 * The Worker indexer is the canonical path; no off-Worker fallback should
 * write vectors directly to Vectorize.
 */
export function chunkFile(path: string, content: string): Chunk[] {
  const lines = content.split("\n")
  if (lines.length === 0) return []
  const chunks: Chunk[] = []
  const step = Math.max(1, CHUNK_LINES - CHUNK_OVERLAP)
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + CHUNK_LINES, lines.length)
    const windowLines = lines.slice(start, end)
    const slice = windowLines.join("\n")
    if (slice.trim().length === 0) {
      if (end === lines.length) break
      continue
    }
    if (slice.length > MAX_CHUNK_CHARS) {
      // Split-not-drop: emit consecutive sub-chunks instead of losing
      // the window. windowStartLine is 1-based (start is 0-based).
      for (const sub of splitOversizedWindow(windowLines, start + 1)) {
        chunks.push({ ...sub, path })
      }
      if (end === lines.length) break
      continue
    }
    chunks.push({
      path,
      lineStart: start + 1,
      lineEnd: end,
      content: slice,
    })
    if (end === lines.length) break
  }
  return chunks
}
