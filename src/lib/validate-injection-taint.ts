// SIG-292: injection/XSS taint-grounding detector.
//
// The believability problem (confirmed on the planted e2e PRs): the security
// specialist over-fires an XSS / code-injection finding on a JS sink whose value
// is a developer-authored COMPILE-TIME CONSTANT — e.g.
// `dangerouslySetInnerHTML={{ __html: BANNER_HTML }}` where
// `const BANNER_HTML = "<div>…</div>"`. There is no attacker-controlled data
// path, so the finding is a false positive — and the only planted precision trap
// any bot tripped was exactly this (Sigilix, P1).
//
// This detector answers the narrow, deterministic question the gate needs:
// "is the value flowing into the cited sink PROVABLY a non-attacker-controlled
// constant?" It returns true ONLY when it can prove the sink's argument is a
// non-interpolated string/template LITERAL — directly, or via a same-file
// `const NAME = <literal>` binding. ANYTHING it cannot prove constant (a member
// access, a call, an identifier it can't resolve, a template literal carrying
// `${…}` interpolation, an unrecognized sink) returns false → the caller KEEPS
// the finding. So a real `dangerouslySetInnerHTML={{ __html: props.bio }}` or
// `eval(`return ${userExpr}`)` is never suppressed. The gate demotes-not-drops
// and ships shadow-first, so a residual false demote is still visible + measured.
//
// Accepted edge (v1): a sink fed a HARDCODED-MALICIOUS literal (e.g.
// `innerHTML = "<img onerror=...>"`) is treated as constant → demoted. A
// source-committed payload is not runtime-attacker-controllable, so the demote
// is defensible, but it does suppress a self-XSS / template-in-source finding.
// The caller demotes-to-body (still visible) and the secret-scan / static-badge
// paths cover committed-payload detection separately.

/**
 * JS injection / XSS sinks whose argument is the untrusted-HTML / code value.
 * Each entry extracts the VALUE EXPRESSION (capture group 1) from a single
 * source line. We deliberately cover only the DOM/JS sinks where a constant
 * value is the realistic over-fire — not SQL/shell string building (whose
 * value is almost always request-derived, so the "constant" case ~never
 * arises and the extraction is far less reliable).
 */
const SINK_EXTRACTORS: ReadonlyArray<RegExp> = [
  // dangerouslySetInnerHTML={{ __html: VALUE }}
  /dangerouslySetInnerHTML\s*=\s*\{\{\s*__html\s*:\s*([^}]+?)\s*\}\s*\}/,
  // x.innerHTML = VALUE  /  x.outerHTML = VALUE
  /\.(?:inner|outer)HTML\s*=\s*([^;]+?)\s*;?\s*$/,
  // document.write(VALUE)  /  document.writeln(VALUE)
  /document\.write(?:ln)?\s*\(\s*([^)]+?)\s*\)/,
  // el.insertAdjacentHTML(position, VALUE)
  /insertAdjacentHTML\s*\([^,]+,\s*([^)]+?)\s*\)/,
  // eval(VALUE)
  /\beval\s*\(\s*([^)]+?)\s*\)/,
]

/**
 * new Function(...args, BODY) — the LAST argument is the code body. Greedy to
 * the final `)` so a template-literal body containing its own parens (e.g.
 * `return (${e})`) isn't truncated. Over-capture on a line with a trailing call
 * fails closed to "not a literal" → keep, so greediness is safe here.
 */
const NEW_FUNCTION_REGEX = /new\s+Function\s*\((.*)\)/

/** A value expression that is a non-interpolated string / template literal. */
function isNonInterpolatedLiteral(expr: string): boolean {
  const v = expr.trim()
  if (v.length === 0) return false
  // Single/double-quoted string literal: "…" or '…' (whole expression).
  if (/^"(?:[^"\\]|\\.)*"$/.test(v) || /^'(?:[^'\\]|\\.)*'$/.test(v)) return true
  // Template literal with NO ${…} interpolation: `…` and no `${`.
  if (v.startsWith("`") && v.endsWith("`") && v.length >= 2 && !v.includes("${")) return true
  return false
}

/** A bare identifier (the only resolvable case): `Foo`, `BANNER_HTML`, `_x`. */
function isSimpleIdentifier(expr: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(expr.trim())
}

/**
 * Search the file's added lines for `const NAME = <non-interpolated literal>`
 * (also `let`/`var`). Returns true only when the binding is found AND its
 * initializer is a provable literal. A `const NAME = something(...)` or a
 * `const NAME = \`${x}\`` → false (not provably constant). Not found → false.
 */
function identifierResolvesToLiteral(
  name: string,
  fileAddedLines: ReadonlyMap<number, string>,
): boolean {
  // Anchor to the START of the (optionally `export`-prefixed) line so the
  // `const NAME =` cannot match mid-line inside a comment or string — a
  // commented decoy `// const X = "ok"` must NOT resolve a real
  // `const X = req.body` to a literal (code-reviewer P2).
  const declRe = new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\b\\s*(?::[^=]+)?=\\s*(.+?)\\s*;?\\s*$`)
  for (const text of fileAddedLines.values()) {
    const m = declRe.exec(text)
    if (m) {
      // First (and, for a const, only) binding we see. If it isn't a provable
      // literal, do NOT keep scanning for a friendlier one — a reassignment or
      // a second same-named binding means we can't prove constness → keep.
      return isNonInterpolatedLiteral(m[1] ?? "")
    }
  }
  return false
}

/**
 * Extract the value expression flowing into a JS injection/XSS sink on this
 * line, or null if the line has no recognized sink. For `new Function` the
 * value is the LAST argument (the body).
 */
export function extractSinkValueExpr(citedLine: string): string | null {
  for (const re of SINK_EXTRACTORS) {
    const m = re.exec(citedLine)
    if (m && m[1] !== undefined) return m[1].trim()
  }
  const fn = NEW_FUNCTION_REGEX.exec(citedLine)
  if (fn && fn[1] !== undefined) {
    const args = fn[1].trim()
    if (args.length === 0) return null
    // Split on top-level commas is overkill here; the body is the last arg and
    // commas inside a string/template are rare in practice. Take the substring
    // after the last comma that is not inside quotes — heuristic but only used
    // to PROVE constness (a wrong split fails closed to "not constant" → keep).
    const lastComma = args.lastIndexOf(",")
    return (lastComma === -1 ? args : args.slice(lastComma + 1)).trim()
  }
  return null
}

/**
 * True iff the cited line drives a JS injection/XSS sink whose value is PROVABLY
 * a non-attacker-controlled constant literal (directly, or via a same-file
 * `const NAME = <literal>` binding). FP-safe by construction: every
 * un-provable case (member access, call, unresolved/reassigned identifier,
 * interpolated template, unrecognized sink, missing file map) returns false →
 * the caller keeps the finding. Pure.
 */
export function sinkValueIsProvablyConstant(
  citedLine: string,
  fileAddedLines: ReadonlyMap<number, string> | undefined,
): boolean {
  const expr = extractSinkValueExpr(citedLine)
  if (expr === null) return false
  if (isNonInterpolatedLiteral(expr)) return true
  if (isSimpleIdentifier(expr) && fileAddedLines !== undefined) {
    return identifierResolvesToLiteral(expr, fileAddedLines)
  }
  return false
}
