// SIG-477 PR-0: no-redos — grounds a model-raised ReDoS finding with a
// deterministic AST hit on a clearly catastrophic-backtracking regex literal.
//
// CONSERVATIVE BY DESIGN. ReDoS detection is NOT FP-safe-by-construction, so
// this rule only ever GROUNDS a co-located model finding — `emitWhenUnmatched`
// is `false`, meaning it NEVER auto-emits a standalone finding. It detects the
// single classic catastrophic shape: a NESTED unbounded quantifier — a group
// `( ... )` immediately followed by an outer unbounded quantifier (`+`, `*`, or
// `{n,}`) whose body itself contains an inner unbounded quantifier (e.g.
// `(a+)+`, `(a*)*`, `(\w+\s?)+`, `(.*)*`). When the scan is unsure (unbalanced
// parens, ambiguous braces) it does NOT flag — the 0-FP credibility is sacred.

import type { AstRule, AstRuleHit, RuleContext } from "@/src/features/ast-rules/domain/types"
import type { AstNode } from "@/src/features/ast-rules/domain/walker"

const SLICE_MAX = 200

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

// Is the token at `i` an *unbounded* quantifier (`+`, `*`, or a `{n,}` brace
// with no upper bound)? Returns the index AFTER the quantifier token (lazy `?`
// consumed) or -1 when it is bounded / not a quantifier. `{n}` and `{n,m}` are
// bounded → -1; a `{` that is not a numeric quantifier is a literal → -1.
function unboundedQuantAt(pattern: string, i: number): number {
  const c = pattern[i]
  if (c === "+" || c === "*") {
    return i + 1 < pattern.length && pattern[i + 1] === "?" ? i + 2 : i + 1
  }
  if (c === "{") {
    const close = pattern.indexOf("}", i)
    if (close === -1) return -1
    const body = pattern.slice(i + 1, close)
    if (/^\d+,$/.test(body)) {
      let end = close + 1
      if (pattern[end] === "?") end++
      return end
    }
    return -1
  }
  return -1
}

// Skip a `[...]` character class starting at `i` (its parens and quantifiers
// are literal, not structural). Returns the index just past the closing `]`.
function skipCharClass(pattern: string, i: number, end: number): number {
  let j = i + 1
  if (pattern[j] === "^") j++
  if (pattern[j] === "]") j++ // a leading literal `]` is a class member
  while (j < end && pattern[j] !== "]") {
    if (pattern[j] === "\\") j++
    j++
  }
  return j + 1
}

// Does the group body in [bodyStart, bodyEnd) contain an unbounded quantifier
// applied to a sub-atom? Escapes (`\w`, `\(`) and char classes are skipped so
// only structural quantifiers count.
function bodyHasUnboundedQuant(pattern: string, bodyStart: number, bodyEnd: number): boolean {
  let i = bodyStart
  while (i < bodyEnd) {
    const c = pattern[i]
    if (c === "\\") {
      i += 2
      continue
    }
    if (c === "[") {
      i = skipCharClass(pattern, i, bodyEnd)
      continue
    }
    if (c === "+" || c === "*" || c === "{") {
      if (unboundedQuantAt(pattern, i) !== -1) return true
    }
    i++
  }
  return false
}

/**
 * Detect the classic nested-unbounded-quantifier catastrophic-backtracking
 * shape in a raw regex `pattern` (the body between the slashes, as acorn
 * exposes it on `node.regex.pattern`). Returns true ONLY for a group whose
 * matching `)` is immediately followed by an unbounded quantifier AND whose
 * body contains an inner unbounded quantifier. Escaped parens (`\(` `\)`) and
 * char classes (`[...]`) are not groups. On any structural ambiguity
 * (unbalanced parens) it returns false — fail toward no false positive.
 */
export function hasNestedUnboundedQuantifier(pattern: string): boolean {
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === "\\") {
      i += 2 // an escaped char — `\(` is a literal paren, never a group
      continue
    }
    if (c === "[") {
      i = skipCharClass(pattern, i, pattern.length)
      continue
    }
    if (c === "(") {
      // Find this group's matching `)`, tracking nested groups while skipping
      // escapes and char classes.
      let depth = 1
      let j = i + 1
      while (j < pattern.length && depth > 0) {
        const d = pattern[j]
        if (d === "\\") {
          j += 2
          continue
        }
        if (d === "[") {
          j = skipCharClass(pattern, j, pattern.length)
          continue
        }
        if (d === "(") depth++
        else if (d === ")") {
          depth--
          if (depth === 0) break
        }
        j++
      }
      if (depth !== 0) return false // unbalanced parens — bail conservatively
      const closeIdx = j
      if (unboundedQuantAt(pattern, closeIdx + 1) !== -1 && bodyHasUnboundedQuant(pattern, i + 1, closeIdx)) {
        return true
      }
      // Keep scanning from just inside this group so inner / sibling groups are
      // also examined.
      i = i + 1
      continue
    }
    i++
  }
  return false
}

export const noRedos: AstRule = {
  id: "no-redos",
  severity: "warning",
  roleHint: "security",
  shortDescription: "Catastrophic-backtracking regex (ReDoS)",
  language: "both",
  nodeTypes: ["Literal"],
  // CRITICAL: ReDoS detection is NOT FP-safe by construction. This rule must
  // only GROUND a model-raised finding, never auto-emit a standalone one.
  emitWhenUnmatched: false,
  visit(node: AstNode, ctx: RuleContext): AstRuleHit | null {
    if (!node || node.type !== "Literal") return null
    const regex = node.regex
    if (!regex || typeof regex.pattern !== "string") return null
    if (!hasNestedUnboundedQuantifier(regex.pattern)) return null
    return {
      message:
        "Regex with a nested unbounded quantifier — catastrophic backtracking (ReDoS): a quantified group is itself repeated unbounded, so a non-matching input can take exponential time. Rewrite the pattern to remove the nesting, use an atomic/possessive group, or bound the input length before matching.",
      evidence: sliceEvidence(ctx.source, node),
      line: node.loc?.start?.line ?? 1,
      column: node.loc?.start?.column ?? 0,
    }
  },
}
