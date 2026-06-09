// SIG-109: no-invalid-typeof-compare — flags a `typeof x` compared
// (`===` / `!==` / `==` / `!=`) against a string literal that is NOT a
// value `typeof` can ever return. `typeof x === "strnig"` is a
// guaranteed-false comparison (a typo); `typeof x === "array"` /
// `"null"` reflect a misunderstanding of `typeof`. Always a bug — the
// branch can never be taken.
//
// Conservative: only fires when the LEFT side of the comparison is a
// `typeof` unary AND the RIGHT side is a string LITERAL not in the
// valid set. A non-literal right operand (`typeof x === expected`) is
// dynamic and never flagged. The valid set is the seven strings the
// spec guarantees `typeof` returns.

import type { AstRule, AstRuleHit, RuleContext } from "@/features/ast-rules/domain/types"
import type { AstNode } from "@/features/ast-rules/domain/walker"

const SLICE_MAX = 200

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

// The complete set of strings `typeof` can return (incl. `bigint`).
const VALID_TYPEOF_RESULTS = new Set([
  "undefined",
  "object",
  "boolean",
  "number",
  "bigint",
  "string",
  "symbol",
  "function",
])

const TYPEOF_COMPARE_OPS = new Set(["===", "!==", "==", "!="])

function isTypeofUnary(node: AstNode): boolean {
  return !!node && node.type === "UnaryExpression" && node.operator === "typeof"
}

function stringLiteralValue(node: AstNode): string | null {
  if (!node || node.type !== "Literal") return null
  return typeof node.value === "string" ? node.value : null
}

export const noInvalidTypeofCompare: AstRule = {
  id: "no-invalid-typeof-compare",
  severity: "warning",
  roleHint: "logic",
  shortDescription: "typeof compared to an impossible string",
  language: "both",
  nodeTypes: ["BinaryExpression"],
  visit(node: AstNode, ctx: RuleContext): AstRuleHit | null {
    if (!node || node.type !== "BinaryExpression") return null
    if (!TYPEOF_COMPARE_OPS.has(node.operator)) return null

    // Accept `typeof x === "..."` and the mirrored `"..." === typeof x`.
    let str: string | null = null
    if (isTypeofUnary(node.left)) {
      str = stringLiteralValue(node.right)
    } else if (isTypeofUnary(node.right)) {
      str = stringLiteralValue(node.left)
    }
    if (str === null) return null
    if (VALID_TYPEOF_RESULTS.has(str)) return null

    return {
      message: `\`typeof\` can never equal "${str}" — this comparison is always ${node.operator === "===" || node.operator === "==" ? "false" : "true"}. Compare against one of: undefined, object, boolean, number, bigint, string, symbol, function.`,
      evidence: sliceEvidence(ctx.source, node),
      line: node.loc?.start?.line ?? 1,
      endLine: node.loc?.end?.line ?? node.loc?.start?.line ?? 1,
      column: node.loc?.start?.column ?? 0,
    }
  },
}
