// SIG-317 Part 4a: deterministic detector for FRACTIONAL-CENTS money math — a
// `*Cents`/`*_cents` integer value multiplied by a NON-integer operand (a rate,
// fraction, or `(1 - x)` expression) and used as money WITHOUT rounding, so the
// result carries fractional cents. The recurring miss our specialists drop on
// hard billing PRs (pr/10 `applyDiscount` → `amountCents * (1 - rate)`, pr/11
// `prorate` → `amountCents * fraction`); CodeRabbit catches it. Deterministic net.
//
// A line-scan (sibling of the enum-drift / cents-as-dollars scans), comments +
// strings masked. FP-safe by construction (north-star = ZERO P0/P1 false
// positives): it flags ONLY a `*Cents` value `*`-multiplied by an operand that
// is NOT an integer literal, and SKIPS when —
//   * the multiplier is an integer literal (`cents * 2`, `cents * 100`) → the
//     result is still integer cents;
//   * the statement rounds (`Math.round` / `Math.floor` / `Math.ceil` /
//     `Math.trunc` / `| 0` / `~~`) → already an integer;
//   * the `$` … wait — this is arithmetic, not display (the cents-as-dollars
//     scan owns the `$`/`/100` display bug; this owns the `* rate` value bug).
// Because a VARIABLE multiplier (`* fraction`) could be integer (a quantity) or
// fractional (a rate), this SURFACES at P2 — the logic specialist is the trust
// judge that decides whether the operand is really fractional; `clampAstEmitScores`
// enforces the P2 ceiling, so no recall is lost on a real bug.

import type { AstRuleHit } from "./types"

export const FLOAT_CENTS_RULE_ID = "no-fractional-cents-math"

/** Blank `//` and `/* *​/` comments + string/template literals to spaces
 *  (length-preserving, string-aware), so a `*Cents * x` inside a comment/string
 *  isn't matched and line math stays exact. */
function blank(src: string): string {
  const out = src.split("")
  const n = src.length
  let i = 0
  let inStr: string | null = null
  while (i < n) {
    const c = src[i]!
    if (inStr) {
      if (c === "\\") { out[i] = " "; if (i + 1 < n) out[i + 1] = " "; i += 2; continue }
      if (c !== "\n") out[i] = " " // blank the body, preserve newlines for line math
      if (c === inStr) inStr = null
      i++
      continue
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; out[i] = " "; i++; continue }
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

/** Rounding / integer-coercion tokens that make the result an integer. */
const ROUND_RE = /\bMath\s*\.\s*(?:round|floor|ceil|trunc)\b|~~|\|\s*0\b/
/** A `*Cents` identifier (camelCase boundary or `_cents`), member-chain ok. */
const CENTS_TOK = "[A-Za-z_$][\\w$]*(?:Cents|_cents)\\b"
/** `<*Cents> * <operand>` or `<operand> * <*Cents>` — capture the multiplier. The
 *  `\*(?![*=])` excludes `**` (exponent) and `*=` (compound assignment, which
 *  also defeated the integer-literal guard — code-review #306). */
const MUL_LEFT = new RegExp(`(${CENTS_TOK})\\s*\\*(?![*=])\\s*([^*;,)\\]}\\n]+)`, "g")
const MUL_RIGHT = new RegExp(`([A-Za-z_$][\\w$.?]*|\\([^()\\n]*\\)|\\d*\\.\\d+)\\s*\\*(?![*=])\\s*(${CENTS_TOK})`, "g")
/** An integer-valued literal multiplier (`2`, `100`, `1_000`, `1.0`) → integer
 *  result, skip (DeepSeek: `* 1.0` is integer-preserving). */
const INT_LITERAL_RE = /^\s*\d[\d_]*(?:\.0+)?\s*$/
/** A function call in the multiplier — could be an integer coercion (`parseInt`,
 *  `Number`, `Math.round`, …) — so skip (FN over FP, like the sibling scans). */
const CALL_RE = /[\w$]\s*\(/

function clip(s: string, max = 50): string {
  const v = s.trim().replace(/\s+/g, " ")
  return v.length > max ? `${v.slice(0, max)}…` : v
}

function message(cents: string, mult: string): string {
  // Hedged / advisory (P2): a scan can't prove the multiplier is fractional (it
  // could be an integer quantity). It surfaces the likely fractional-cents bug;
  // the logic specialist judges + escalates.
  return (
    `Likely fractional-cents money bug: \`${clip(cents)}\` (an integer cents value) is multiplied by ` +
    `\`${clip(mult)}\`, which is not an integer literal, and no rounding is visible on this statement. If the ` +
    `multiplier is a rate/fraction the result carries fractional cents — verify it is rounded before being ` +
    `stored/returned as cents (\`Math.round(...)\`, or compute in higher precision and round once).`
  )
}

function lineOf(source: string, idx: number): { line: number; column: number } {
  const lineStartIdx = source.lastIndexOf("\n", idx - 1) + 1
  return { line: source.slice(0, idx).split("\n").length, column: Math.max(0, idx - lineStartIdx) }
}

/** The statement window around `idx` (between the previous and next `;`/`{`/`}`
 *  or newline), to check for a rounding call. */
function statementHasRound(blanked: string, idx: number): boolean {
  let start = idx
  while (start > 0 && !/[;{}\n]/.test(blanked[start - 1]!)) start--
  let end = idx
  while (end < blanked.length && !/[;{}\n]/.test(blanked[end]!)) end++
  return ROUND_RE.test(blanked.slice(start, end))
}

/**
 * Scan a file's source for an integer-cents value multiplied by a non-integer
 * operand without rounding. Pure; returns raw hits (the runner filters by
 * changed-lines and wraps them as a `warning`/`logic`/`emitWhenUnmatched`
 * advisory). The guard ORDER is the FP-safety contract.
 */
export function scanFractionalCentsMath(source: string): AstRuleHit[] {
  const hits: AstRuleHit[] = []
  if (!source.includes("*")) return hits
  const blanked = blank(source)
  const seen = new Set<number>()
  const consider = (idx: number, cents: string, mult: string): void => {
    if (INT_LITERAL_RE.test(mult)) return // integer multiplier → integer result
    if (CALL_RE.test(mult)) return // call could integer-coerce (parseInt/Number/…)
    if (statementHasRound(blanked, idx)) return // rounded on this statement → integer
    if (seen.has(idx)) return
    seen.add(idx)
    const { line, column } = lineOf(source, idx)
    hits.push({ message: message(cents, mult), evidence: clip(`${cents} * ${mult}`, 120), line, column })
  }
  for (const m of blanked.matchAll(MUL_LEFT)) consider(m.index ?? 0, m[1]!, m[2]!)
  for (const m of blanked.matchAll(MUL_RIGHT)) {
    // Skip when the left operand is itself a *Cents token (already covered by MUL_LEFT).
    if (new RegExp(`${CENTS_TOK}$`).test(m[1]!.trim())) continue
    consider(m.index ?? 0, m[2]!, m[1]!)
  }
  return hits
}
