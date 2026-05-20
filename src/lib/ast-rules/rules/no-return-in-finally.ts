// SIG-109: no-return-in-finally — flags a `return`, `break`,
// `continue`, or `throw` whose nearest enclosing block is a `finally`
// clause. A control-flow jump inside `finally` SWALLOWS whatever the
// `try`/`catch` was doing: a pending return value is discarded, and —
// worse — a `return`/`throw` in `finally` silently eats an exception
// that was propagating out of the try/catch. Almost always a bug.
//
// Conservative: a jump nested inside a FUNCTION declared within the
// finally block belongs to that inner function, not the finally — so
// the walk stops at a function-scope boundary (it would `return` from
// the callback, not the finally). Only a jump whose own function scope
// IS the finally's scope is flagged.

import type { AstRule, AstRuleHit, RuleContext } from "../types"
import type { AstNode } from "../walker"

const SLICE_MAX = 200

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

const JUMP_TYPES = new Set([
  "ReturnStatement",
  "BreakStatement",
  "ContinueStatement",
  "ThrowStatement",
])

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
])

/**
 * Walk the `finalizer` block's body looking for a top-of-this-scope
 * control-flow jump. Recurses through nested statements/blocks BUT
 * stops at any function boundary — a jump there belongs to the nested
 * function. Returns the first offending node or null.
 */
function findJumpInScope(node: AstNode): AstNode | null {
  if (!node || typeof node !== "object") return null
  if (FUNCTION_TYPES.has(node.type)) return null // nested scope — not ours
  if (JUMP_TYPES.has(node.type)) return node
  for (const k of Object.keys(node)) {
    if (k === "type" || k === "loc" || k === "start" || k === "end") continue
    const v = (node as Record<string, unknown>)[k]
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === "object") {
          const hit = findJumpInScope(item as AstNode)
          if (hit) return hit
        }
      }
    } else if (v && typeof v === "object") {
      const hit = findJumpInScope(v as AstNode)
      if (hit) return hit
    }
  }
  return null
}

export const noReturnInFinally: AstRule = {
  id: "no-return-in-finally",
  severity: "warning",
  roleHint: "logic",
  shortDescription: "control-flow jump inside a finally block",
  language: "both",
  nodeTypes: ["TryStatement"],
  visit(node: AstNode, ctx: RuleContext): AstRuleHit | null {
    if (!node || node.type !== "TryStatement") return null
    const finalizer = node.finalizer
    if (!finalizer || finalizer.type !== "BlockStatement") return null
    const jump = findJumpInScope(finalizer)
    if (!jump) return null
    return {
      message: "Control-flow jump inside `finally` swallows the try/catch outcome — a pending return value is discarded and any in-flight exception is silently eaten. Move this out of `finally`.",
      evidence: sliceEvidence(ctx.source, jump),
      line: jump.loc?.start?.line ?? finalizer.loc?.start?.line ?? 1,
      endLine: jump.loc?.end?.line ?? jump.loc?.start?.line ?? 1,
      column: jump.loc?.start?.column ?? 0,
    }
  },
}
