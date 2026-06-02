// SIG-317 Part 3: deterministic detector for a `*Cents` / `*_cents` value
// rendered as a DOLLAR amount in JSX without dividing by 100 — the recurring
// cents/dollars unit bug our model specialists intermittently miss (pr/10
// `Balance: ${wallet.balanceCents}`, pr/11 `${sub.monthlyCents}/mo` → "$4900"
// for $49.00). CodeRabbit + Greptile catch it; this is the deterministic net.
//
// Why a line-scan with a template-aware lexer (sibling of the SIG-312 dynamic-
// HTML scan + the enum-drift scan): the value lives in a JSX expression the
// walker never descends into. The core FP TRAP (dual-design by DeepSeek-v4-pro +
// Kimi): a currency `$` (`${x}` in JSX text = a literal `$` + a `{x}` expression)
// looks identical in raw source to a template-literal interpolation marker
// (`` `${x}` `` = just interpolation, NOT a dollar sign). A naive regex would
// false-flag the interpolation. The lexer resolves it: it tracks backtick
// template regions, so —
//   * `${ … *Cents … }` in JSX/code context → currency → FLAG;
//   * `$${ … *Cents … }` inside a template (literal `$` + interpolation) → FLAG;
//   * a bare `${ … }` interpolation inside a template → the `$` is the marker,
//     not currency → SKIP.
//
// FP-safe by construction (north-star = ZERO P0/P1 false positives). SKIP on any
// uncertainty: the `$` is inside a string/comment; the expression contains a
// CALL (any call could be a cents→dollars formatter — `formatUsd`, `toFixed`
// after a divide, etc. — FN over FP); the expression divides by 100 (`/100`,
// `*0.01`); the identifier doesn't end in `Cents`/`_cents` (the case-sensitive
// boundary deliberately avoids English words like "accents"/"innocents"). And it
// SURFACES at P2 (a hedged "verify" advisory): `*Cents` is a naming convention,
// not a type guarantee, and a line-scan can't see an upstream divide — so the
// logic specialist stays the trust judge. `clampAstEmitScores` enforces the P2
// ceiling.

import type { AstRuleHit } from "./types"

export const CENTS_AS_DOLLARS_RULE_ID = "no-cents-rendered-as-dollars"

/** An identifier ending in `Cents` (camelCase boundary) or `_cents` (snake).
 *  Case-sensitive on purpose: a lowercase "cents" (accents, innocents, recents)
 *  is NOT a money field, so it must not match. */
const CENTS_RE = /(?:Cents|_cents)\b/
/** ANY arithmetic scaling by a numeric literal (`/ 100`, `/ 1000`, `* 0.01`,
 *  `* 2`) → the value is being rescaled, so we can't claim it's raw cents shown
 *  as dollars. Broad on purpose (code-review HIGH): skipping any `/N` or `*N`
 *  trades a few FNs (a real `/1000` bug) for FP-safety, per the zero-FP doctrine.
 *  Plain arithmetic with no numeric literal (`+ tax`) still flags. */
const SCALE_RE = /[/*]\s*\.?\d/
/** Any function call: `f(`, `a.b(`, `x)(`. The value flows through a call we
 *  can't see into — could be a cents→dollars formatter — so skip (FN over FP). */
const CALL_RE = /[\w$)\]]\s*\(/

/** Keywords after which a `/` begins a REGEX literal, not a division. */
const REGEX_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "do", "else", "yield", "await", "case",
])

/** Heuristic: is the `/` at `slashIdx` the start of a regex literal (vs a
 *  division operator)? A `/` is regex when the previous significant token is NOT
 *  a value — i.e. after an operator/punctuation, at start of input, or after a
 *  regex-permitting keyword. Conservative toward "regex" so a regex body gets
 *  masked (FN over FP). */
function isRegexStart(src: string, slashIdx: number): boolean {
  let j = slashIdx - 1
  while (j >= 0 && /\s/.test(src[j]!)) j--
  if (j < 0) return true
  const prev = src[j]!
  if (/[)\]}]/.test(prev)) return false // value/group end → division
  if (/['"`]/.test(prev)) return false // string end → division
  if (/[\w$]/.test(prev)) {
    let k = j
    while (k >= 0 && /[\w$]/.test(src[k]!)) k--
    return REGEX_KEYWORDS.has(src.slice(k + 1, j + 1)) // keyword → regex; ident/number → division
  }
  return true // operator / punctuation / `(` `[` `,` `=` … → regex
}

/** Brace-balanced `{ … }` starting at `openIdx` (which must be `{`), counting
 *  ONLY braces that are real code — `ignore[i]` skips a `{`/`}` inside a string,
 *  comment, regex, or template text (DeepSeek FP vector: a `}` inside `{"a}"}`
 *  must not close the brace early). Returns the inner expression as a CODE-ONLY
 *  view (those same ignored chars blanked to spaces, so `"Cents"` inside a
 *  string never matches `CENTS_RE`) + the closing-`}` index, or null. */
function extractBraceExpr(
  src: string,
  openIdx: number,
  ignore: boolean[],
): { rawExpr: string; codeExpr: string; endIdx: number } | null {
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    if (ignore[i]) continue
    const c = src[i]
    if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) {
        const chars: string[] = []
        for (let j = openIdx + 1; j < i; j++) chars.push(ignore[j] ? " " : src[j]!)
        return { rawExpr: src.slice(openIdx + 1, i), codeExpr: chars.join(""), endIdx: i }
      }
    }
  }
  return null
}

/**
 * Lex the source, returning two per-index boolean arrays:
 *   `inTmplText[i]` — `i` sits in a backtick template's TEXT (not an
 *      interpolation expression), so a `$` there is the interpolation marker;
 *   `masked[i]` — `i` is inside a string literal or a comment, so a `$` there is
 *      not a real currency character.
 * Templates + their `${ … }` interpolations nest correctly (a stack). Pure.
 */
function lex(src: string): { inTmplText: boolean[]; masked: boolean[] } {
  const n = src.length
  const inTmplText = new Array<boolean>(n).fill(false)
  const masked = new Array<boolean>(n).fill(false)
  // Stack frames: "tmpl" = inside template text; "interp" = inside `${ … }`
  // (with a brace counter so the matching `}` pops back to the template).
  const stack: Array<{ k: "tmpl" } | { k: "interp"; brace: number }> = []
  let i = 0
  while (i < n) {
    const top = stack[stack.length - 1]
    const c = src[i]
    if (top?.k === "tmpl") {
      if (c === "\\") { inTmplText[i] = true; if (i + 1 < n) inTmplText[i + 1] = true; i += 2; continue }
      if (c === "`") { stack.pop(); i++; continue }
      if (c === "$" && src[i + 1] === "{") {
        inTmplText[i] = true // the `$` is the interpolation marker (template text)
        stack.push({ k: "interp", brace: 1 })
        i += 2
        continue
      }
      inTmplText[i] = true
      i++
      continue
    }
    // code / JSX / interpolation-expression context
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") { masked[i] = true; i++ }; continue }
    if (c === "/" && src[i + 1] === "*") {
      masked[i] = true; masked[i + 1] = true; i += 2
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { masked[i] = true; i++ }
      if (i < n) { masked[i] = true; masked[i + 1] = true; i += 2 }
      continue
    }
    if (c === "/" && isRegexStart(src, i)) {
      // Regex literal: mask its body so a `${ … }` inside it isn't read as
      // currency (code-review + DeepSeek FP vector). Handle `\` escapes and a
      // `[…]` char class (where `/` is literal). Bail at a newline (a regex
      // can't span lines unescaped).
      masked[i] = true; i++
      let inClass = false
      while (i < n) {
        const d = src[i]
        if (d === "\n") break
        masked[i] = true
        if (d === "\\") { if (i + 1 < n) masked[i + 1] = true; i += 2; continue }
        if (d === "[") inClass = true
        else if (d === "]") inClass = false
        else if (d === "/" && !inClass) { i++; break }
        i++
      }
      continue
    }
    if (c === "'" || c === '"') {
      const q = c; masked[i] = true; i++
      while (i < n && src[i] !== q) {
        if (src[i] === "\\") { masked[i] = true; if (i + 1 < n) masked[i + 1] = true; i += 2 }
        else { masked[i] = true; i++ }
      }
      if (i < n) { masked[i] = true; i++ }
      continue
    }
    if (c === "`") { stack.push({ k: "tmpl" }); i++; continue }
    if (top?.k === "interp") {
      if (c === "{") { top.brace++; i++; continue }
      if (c === "}") { top.brace--; if (top.brace === 0) stack.pop(); i++; continue }
    }
    i++
  }
  return { inTmplText, masked }
}

function clip(s: string, max = 70): string {
  const v = s.trim().replace(/\s+/g, " ")
  return v.length > max ? `${v.slice(0, max)}…` : v
}

function message(expr: string): string {
  // Deliberately HEDGED / advisory (P2): a deterministic scan can't prove the
  // value wasn't divided upstream, and `*Cents` is a naming convention. It
  // surfaces the likely unit bug; the logic specialist judges + escalates.
  return (
    `Likely cents/dollars unit bug: \`${clip(expr)}\` is rendered with a \`$\` prefix but the value is named ` +
    `in cents and is not divided by 100 (no \`/ 100\` and no formatter). It will display the raw cents as ` +
    `dollars — e.g. "$4900" for a $49.00 amount. Verify: divide by 100 (\`(x / 100).toFixed(2)\`) or use a ` +
    `currency formatter before rendering.`
  )
}

/**
 * Scan a file's source for a `*Cents` value rendered as a dollar amount in JSX
 * (a `$`-prefixed expression) without a divide-by-100 or formatter. Pure;
 * returns raw hits (the runner filters by changed-lines and wraps them as a
 * `warning`/`logic`/`emitWhenUnmatched` advisory). The guard ORDER is the
 * FP-safety contract.
 */
export function scanCentsRenderedAsDollars(source: string): AstRuleHit[] {
  const hits: AstRuleHit[] = []
  if (!source.includes("$")) return hits
  const { inTmplText, masked } = lex(source)
  // A char to IGNORE for brace-balancing + the code-only expr view: inside a
  // string/comment/regex (masked) or inside template text (inTmplText).
  const ignore = masked.map((m, idx) => m || inTmplText[idx]!)
  const seen = new Set<number>()
  for (let i = 0; i + 1 < source.length; i++) {
    if (source[i] !== "$" || source[i + 1] !== "{") continue
    if (masked[i]) continue // inside a string/comment/regex — not a currency `$`
    if (inTmplText[i]) {
      // The `$` is a template interpolation marker. Currency ONLY when a literal
      // `$` precedes it (`$${ … }`); a bare `${ … }` is interpolation → skip.
      if (!(i > 0 && source[i - 1] === "$" && inTmplText[i - 1] && !masked[i - 1])) continue
    }
    // else: JSX/code context — `${ … }` is a literal `$` + a JSX expression.
    const extracted = extractBraceExpr(source, i + 1, ignore)
    if (!extracted) continue
    const { rawExpr, codeExpr } = extracted
    if (!CENTS_RE.test(codeExpr)) continue // not a cents-named value (strings blanked)
    if (CALL_RE.test(codeExpr) || SCALE_RE.test(codeExpr)) continue // formatted / scaled → safe
    if (seen.has(i)) continue
    seen.add(i)
    const lineStartIdx = source.lastIndexOf("\n", i - 1) + 1
    hits.push({
      message: message(rawExpr),
      evidence: `$\{${clip(rawExpr, 120)}}`,
      line: source.slice(0, i).split("\n").length,
      column: Math.max(0, i - lineStartIdx),
    })
  }
  return hits
}
