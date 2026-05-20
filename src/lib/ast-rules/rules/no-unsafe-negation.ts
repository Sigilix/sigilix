// SIG-109: no-unsafe-negation — flags `!a in b` and `!a instanceof B`.
// JS parses these as `(!a) in b` / `(!a) instanceof B` because `!`
// binds tighter than `in`/`instanceof`. So `!a in b` first coerces `a`
// to a boolean, then asks whether `"true"`/`"false"` is a key of `b` —
// almost never what the author meant. The intended form is
// `!(a in b)`. A genuine, near-certain bug.
//
// Conservative: fires ONLY when the operator is `in` or `instanceof`
// AND the LEFT operand is a prefix `!` negation. `!(a in b)` (the
// correct form) parses with the `!` OUTSIDE the binary expression, so
// it never matches. A `!` on the RIGHT (`a in !b`) is legal and not
// flagged.

import type { AstRule, AstRuleHit, RuleContext } from "../types"
import type { AstNode } from "../walker"

const SLICE_MAX = 200

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

const UNSAFE_OPS = new Set(["in", "instanceof"])

export const noUnsafeNegation: AstRule = {
  id: "no-unsafe-negation",
  severity: "warning",
  roleHint: "logic",
  shortDescription: "negation of the left operand of in/instanceof",
  language: "both",
  nodeTypes: ["BinaryExpression"],
  visit(node: AstNode, ctx: RuleContext): AstRuleHit | null {
    if (!node || node.type !== "BinaryExpression") return null
    if (!UNSAFE_OPS.has(node.operator)) return null
    const left = node.left
    // Only a prefix `!` (logical not). A `~`/`-`/`typeof` unary on the
    // left is a different (often intentional) construct.
    if (!left || left.type !== "UnaryExpression" || left.operator !== "!" || !left.prefix) {
      return null
    }
    return {
      message: `\`!a ${node.operator} b\` negates the left operand BEFORE the \`${node.operator}\` check (\`!\` binds tighter), so it tests \`(!a) ${node.operator} b\` — almost certainly a bug. Use \`!(a ${node.operator} b)\`.`,
      evidence: sliceEvidence(ctx.source, node),
      line: node.loc?.start?.line ?? 1,
      endLine: node.loc?.end?.line ?? node.loc?.start?.line ?? 1,
      column: node.loc?.start?.column ?? 0,
    }
  },
}
