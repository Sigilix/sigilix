// ARC-181: no-throw-literal — flags `throw "string"` or `throw 42`
// (literal-only throws). Always prefer `throw new Error(message)` or
// a typed Error class so consumers get a stack trace.

import type { AstRule, AstRuleHit, RuleContext } from "@/src/features/ast-rules/domain/types"
import type { AstNode } from "@/src/features/ast-rules/domain/walker"

const SLICE_MAX = 200

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

export const noThrowLiteral: AstRule = {
  id: "no-throw-literal",
  severity: "warning",
  roleHint: "logic",
  shortDescription: "throw of a literal value",
  language: "both",
  nodeTypes: ["ThrowStatement"],
  visit(node: AstNode, ctx: RuleContext): AstRuleHit | null {
    if (!node || node.type !== "ThrowStatement") return null
    const arg = node.argument
    if (!arg) return null
    const isLit = arg.type === "Literal"
    const isPlainTemplate = arg.type === "TemplateLiteral"
      && Array.isArray(arg.expressions)
      && arg.expressions.length === 0
    if (!isLit && !isPlainTemplate) return null
    return {
      message: "Throwing a literal loses the stack trace. Use `throw new Error(message)` or a typed Error class.",
      evidence: sliceEvidence(ctx.source, node),
      line: node.loc?.start?.line ?? 1,
      column: node.loc?.start?.column ?? 0,
    }
  },
}
