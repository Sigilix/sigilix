// ARC-181: no-process-env-mutation — flags `process.env.X = ...` and
// `process.env["X"] = ...` assignments. Almost always a test-leak
// bug or a hot-patch in production code that should be a config
// flag instead.

import type { AstRule, AstRuleHit, RuleContext } from "@/src/features/ast-rules/domain/types"
import type { AstNode } from "@/src/features/ast-rules/domain/walker"

const SLICE_MAX = 200

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

export const noProcessEnvMutation: AstRule = {
  id: "no-process-env-mutation",
  severity: "warning",
  roleHint: "logic",
  shortDescription: "process.env mutation",
  language: "both",
  nodeTypes: ["AssignmentExpression"],
  visit(node: AstNode, ctx: RuleContext): AstRuleHit | null {
    if (!node || node.type !== "AssignmentExpression") return null
    const left = node.left
    if (left?.type !== "MemberExpression") return null
    // Pattern: <object>.<property> = <value>
    // We want the object itself to be `process.env` (also a
    // MemberExpression).
    const obj = left.object
    if (obj?.type !== "MemberExpression") return null
    const objObj = obj.object
    const objProp = obj.property
    if (objObj?.type !== "Identifier" || objObj.name !== "process") return null
    if (objProp?.type !== "Identifier" || objProp.name !== "env") return null
    return {
      message:
        "Mutating `process.env` at runtime — almost always a test-leak bug. Use a config object that flows through the call chain.",
      evidence: sliceEvidence(ctx.source, node),
      line: node.loc?.start?.line ?? 1,
      column: node.loc?.start?.column ?? 0,
    }
  },
}
