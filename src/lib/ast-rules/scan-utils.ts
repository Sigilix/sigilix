// Shared primitives for the cross-function string-analysis injectors
// (analyze-helper-bypass = over-credit, analyze-toctou-race = check-then-act race).
// Pure, length-preserving string analysis — no real parser. Extracted from the
// over-credit injector so the TOCTOU one reuses the exact same lexing/extraction
// (identical blanking + brace-balanced function extraction) instead of forking it.

/** Escape a source-derived identifier before interpolating it into a RegExp
 *  (a `$` in a name would otherwise be an anchor — code-review H1). */
export const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Match-normalised SQL identifier: strip `_`, lowercase, last `.`-segment. For
 *  EQUALITY checks only (table/column identity), never for display. */
export const norm = (t: string): string => t.replace(/_/g, "").toLowerCase().split(".").pop()!

/** Display form of a SQL identifier: strip any table/alias qualifier but KEEP the
 *  original casing and underscores. `norm()` mangles `amount_cents` -> `amountcents`
 *  (fine for matching, wrong for the hint TEXT — the model should see the real name). */
export const display = (t: string): string => t.split(".").pop()!

/** Blank `//` and `/* *​/` comments to spaces (length-preserving). `alsoStrings`
 *  additionally blanks string/template bodies — used for the call-count / control-
 *  flow corpus so a name inside a SQL/doc string isn't read as code. Length is
 *  preserved so match indices line up across the strings-kept and strings-blanked
 *  views of the same source (the injectors compare positions across the two). */
export function blank(src: string, alsoStrings = false): string {
  const out = src.split("")
  const n = src.length
  let i = 0
  let inStr: string | null = null
  while (i < n) {
    const c = src[i]!
    if (inStr) {
      if (c === "\\") { if (alsoStrings) { out[i] = " "; if (i + 1 < n) out[i + 1] = " " } i += 2; continue }
      if (alsoStrings && c !== "\n") out[i] = " "
      if (c === inStr) inStr = null
      i++
      continue
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; if (alsoStrings) out[i] = " "; i++; continue }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") { out[i] = " "; i++ } continue }
    if (c === "/" && src[i + 1] === "*") {
      out[i] = " "; out[i + 1] = " "; i += 2
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] !== "\n") out[i] = " "; i++ }
      if (i < n) { out[i] = " "; out[i + 1] = " "; i += 2 }
      continue
    }
    i++
  }
  return out.join("")
}

/** A named `function NAME(...)` declaration (decl form — the helpers + mutators
 *  in practice are named declarations). Group 1 = name. */
export const FN_DECL_RE = /(?:^|[^.\w$])function\s+([A-Za-z_$][\w$]*)\s*\(/g

export interface FnInfo {
  name: string
  body: string
  /** Absolute index of the body's opening `{` in the (comment-blanked) source —
   *  lets a caller map a within-body match back to a file line (e.g. the TOCTOU
   *  injector's DurableObject-span check). Ignored by callers that don't need it. */
  start: number
}

/** Extract named functions + their brace-balanced bodies (with body start offset)
 *  from one comment-blanked source. */
export function extractFunctions(blanked: string): FnInfo[] {
  const fns: FnInfo[] = []
  for (const m of blanked.matchAll(FN_DECL_RE)) {
    let i = (m.index ?? 0) + m[0].length
    let paren = 1
    while (i < blanked.length && paren > 0) {
      if (blanked[i] === "(") paren++
      else if (blanked[i] === ")") paren--
      i++
    }
    while (i < blanked.length && blanked[i] !== "{" && blanked[i] !== ";") i++
    if (blanked[i] !== "{") continue
    let depth = 0
    const start = i
    for (; i < blanked.length; i++) {
      if (blanked[i] === "{") depth++
      else if (blanked[i] === "}") { depth--; if (depth === 0) break }
    }
    fns.push({ name: m[1]!, body: blanked.slice(start, i + 1), start })
  }
  return fns
}
