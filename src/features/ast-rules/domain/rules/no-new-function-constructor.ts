// ARC-181: no-new-function-constructor — flags `new Function(...)`.
// Equivalent danger to eval — the body string is parsed and run at
// runtime. Refactor to a literal function or an explicit allowlist.

import type { AstRule, AstRuleHit, RuleContext } from "@/src/features/ast-rules/domain/types"
import type { AstNode } from "@/src/features/ast-rules/domain/walker"

const SLICE_MAX = 200

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

export const noNewFunctionConstructor: AstRule = {
  id: "no-new-function-constructor",
  severity: "error",
  roleHint: "security",
  shortDescription: "new Function(...) constructor",
  language: "both",
  nodeTypes: ["NewExpression"],
  visit(node: AstNode, ctx: RuleContext): AstRuleHit | null {
    if (!node || node.type !== "NewExpression") return null
    const callee = node.callee
    if (!callee || callee.type !== "Identifier" || callee.name !== "Function") return null
    return {
      message: "`new Function()` is equivalent to eval — the argument is parsed and executed at runtime. Use a literal function expression instead.",
      evidence: sliceEvidence(ctx.source, node),
      line: node.loc?.start?.line ?? 1,
      column: node.loc?.start?.column ?? 0,
    }
  },
}
