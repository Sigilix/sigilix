// SIG-109: no-self-assignment — flags `x = x` or `this.x = this.x`
// (an assignment whose left and right sides are the identical simple
// reference). A self-assignment is a no-op; it usually means the author
// meant to assign something else (a typo'd source, a forgotten
// transform).
//
// Conservative scope (honor "prefer a miss"):
//   - Only the plain `=` operator. Compound operators (`+=`, `??=`, …)
//     are NOT self-assignments — `x += x` doubles `x`.
//   - Both sides must be a SIMPLE reference: a bare Identifier, or a
//     non-computed member path rooted at an identifier / `this`
//     (`a.b.c`, `this.x`). A computed member (`a[i]`) is skipped — `i`
//     could change between reads, and matching source text would
//     over-flag (`a[f()] = a[f()]` is not a guaranteed no-op).
//   - The two sides match when their normalized member paths are
//     identical.

import type { AstRule, AstRuleHit, RuleContext } from "../types"
import type { AstNode } from "../walker"

const SLICE_MAX = 200

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

/**
 * Build a normalized dotted path for a simple reference, or null when
 * the node is not a simple (non-computed) reference. `this` roots as
 * the sentinel `"this"`. A computed member access returns null so we
 * never compare two potentially-side-effecting subscripts.
 */
function simplePath(node: AstNode): string | null {
  if (!node) return null
  if (node.type === "Identifier") return node.name as string
  if (node.type === "ThisExpression") return "this"
  if (node.type === "MemberExpression") {
    if (node.computed) return null // a[i] — bail (i may not be stable)
    if (node.property?.type !== "Identifier") return null
    const base = simplePath(node.object)
    if (base === null) return null
    return `${base}.${node.property.name}`
  }
  return null
}

export const noSelfAssignment: AstRule = {
  id: "no-self-assignment",
  severity: "warning",
  roleHint: "logic",
  shortDescription: "assignment of a variable to itself",
  language: "both",
  nodeTypes: ["AssignmentExpression"],
  visit(node: AstNode, ctx: RuleContext): AstRuleHit | null {
    if (!node || node.type !== "AssignmentExpression") return null
    if (node.operator !== "=") return null
    const left = simplePath(node.left)
    if (left === null) return null
    const right = simplePath(node.right)
    if (right === null) return null
    if (left !== right) return null
    return {
      message: "Self-assignment is a no-op — the left and right sides reference the same thing. Remove it, or assign the value you actually intended.",
      evidence: sliceEvidence(ctx.source, node),
      line: node.loc?.start?.line ?? 1,
      endLine: node.loc?.end?.line ?? node.loc?.start?.line ?? 1,
      column: node.loc?.start?.column ?? 0,
    }
  },
}
