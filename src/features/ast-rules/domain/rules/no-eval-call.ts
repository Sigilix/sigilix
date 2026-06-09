// ARC-181: no-eval-call — flags direct `eval(<arg>)` calls.
//
// `eval()` is one of the highest-confidence security flags an AST
// scanner can produce: the only way the call is benign is if `eval`
// has been shadowed in scope, which is an obscure pattern. v1 emits
// `error`-severity for any direct CallExpression whose callee is
// the bare Identifier `eval`. Member-access calls like `obj.eval(x)`
// or string-literal occurrences in code are NOT flagged.

import type { AstRule, AstRuleHit, RuleContext } from "@/features/ast-rules/domain/types"
import type { AstNode } from "@/features/ast-rules/domain/walker"

const SLICE_MAX = 200

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

export const noEvalCall: AstRule = {
  id: "no-eval-call",
  severity: "error",
  roleHint: "security",
  shortDescription: "Direct eval() call",
  language: "both",
  nodeTypes: ["CallExpression"],
  visit(node: AstNode, ctx: RuleContext): AstRuleHit | null {
    if (!node || node.type !== "CallExpression") return null
    const callee = node.callee
    if (!callee || callee.type !== "Identifier" || callee.name !== "eval") return null
    return {
      message: "Direct eval() call — runtime code execution from a value is dangerous. Refactor to use a safe alternative or an explicit allowlist.",
      evidence: sliceEvidence(ctx.source, node),
      line: node.loc?.start?.line ?? 1,
      column: node.loc?.start?.column ?? 0,
    }
  },
}
