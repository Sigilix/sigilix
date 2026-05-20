// SIG-109: no-constant-binary-condition — flags a logical expression
// (`&&` / `||`) with a constant literal operand that fixes the result
// or makes the other operand dead: `a || true` (always truthy),
// `a && false` (always falsy), `true && x` / `false || x` (the literal
// is inert and the guard is pointless). These are nearly always a bug —
// a debugging override left in, or a typo (`||` for `&&`).
//
// Conservative (honor "prefer a miss"):
//   - Only literal operands whose truthiness is statically known:
//     boolean literals, `null`, numeric literals, and string literals.
//     An arbitrary expression operand (`a || foo()`) is NOT constant
//     and is never flagged.
//   - A `0`, `""`, `null`, `false` literal is falsy; everything else
//     (`1`, `"x"`, `true`) is truthy. The literal is flagged only when
//     its truthiness collapses the operator:
//       `||`: a TRUTHY literal anywhere → result always truthy
//             (`a || true`, `1 || a`). A FALSY literal is just a default
//             and is NOT flagged (`a || ""` is a legit fallback).
//       `&&`: a FALSY literal anywhere → result always falsy
//             (`a && false`, `0 && a`). A TRUTHY literal is a no-op
//             guard but common in real code (`true && cond` in macros),
//             so NOT flagged — keeps the rule tight.

import type { AstRule, AstRuleHit, RuleContext } from "../types"
import type { AstNode } from "../walker"

const SLICE_MAX = 200

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

/**
 * The static truthiness of a literal operand, or null when the operand
 * is not a statically-known literal. Only the four primitive literal
 * kinds whose truthiness is unambiguous are considered.
 */
function literalTruthiness(node: AstNode): boolean | null {
  if (!node || node.type !== "Literal") return null
  const v = node.value
  const t = typeof v
  if (t === "boolean" || t === "number" || t === "string" || v === null) {
    return Boolean(v)
  }
  // bigint / regex — skip (regex is always truthy but rarely written
  // as a logical operand by mistake; bigint truthiness is fine to skip).
  return null
}

export const noConstantBinaryCondition: AstRule = {
  id: "no-constant-binary-condition",
  severity: "warning",
  roleHint: "logic",
  shortDescription: "logical expression with a constant operand that fixes the result",
  language: "both",
  nodeTypes: ["LogicalExpression"],
  visit(node: AstNode, ctx: RuleContext): AstRuleHit | null {
    if (!node || node.type !== "LogicalExpression") return null
    if (node.operator !== "&&" && node.operator !== "||") return null
    const leftLit = literalTruthiness(node.left)
    const rightLit = literalTruthiness(node.right)
    if (leftLit === null && rightLit === null) return null

    let offending = false
    if (node.operator === "||") {
      // A truthy literal on either side fixes the result to truthy.
      offending = leftLit === true || rightLit === true
    } else {
      // `&&`: a falsy literal on either side fixes the result to falsy.
      offending = leftLit === false || rightLit === false
    }
    if (!offending) return null

    return {
      message: `Constant operand in a \`${node.operator}\` expression fixes the result regardless of the other side, so the condition is degenerate. Remove the constant or fix the operator.`,
      evidence: sliceEvidence(ctx.source, node),
      line: node.loc?.start?.line ?? 1,
      endLine: node.loc?.end?.line ?? node.loc?.start?.line ?? 1,
      column: node.loc?.start?.column ?? 0,
    }
  },
}
