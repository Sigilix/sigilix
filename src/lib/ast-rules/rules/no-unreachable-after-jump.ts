// SIG-109: no-unreachable-after-jump — flags a statement that directly
// follows a `return`, `throw`, `break`, or `continue` in the SAME block
// body. After an unconditional jump, the next sibling statement can
// never execute — it's dead code, usually a logic mistake (a misplaced
// `return`, or a statement the author thought ran).
//
// SAME-BLOCK ONLY (the brief's hard constraint): the rule inspects a
// single `BlockStatement.body` array and flags the FIRST statement
// after a jump within THAT array. It does NOT cross into nested blocks,
// function bodies, switch-case consequents, or class bodies — those are
// separate scopes whose reachability the AST alone can't always settle
// (e.g. switch fallthrough, hoisted function declarations). Restricting
// to one block body keeps the rule conservative.
//
// Function/class DECLARATIONS after a jump are NOT flagged: they are
// hoisted, so a `function foo(){}` after a `return` is still callable.
// Only executable statements count as unreachable.

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
  "ThrowStatement",
  "BreakStatement",
  "ContinueStatement",
])

/**
 * Statement types that are HOISTED and so remain reachable even after a
 * jump. A `FunctionDeclaration` is callable regardless of position;
 * empty statements are harmless. Excluding these avoids false positives
 * on legal post-jump declarations.
 */
const HOISTED_OR_INERT = new Set([
  "FunctionDeclaration",
  "EmptyStatement",
])

export const noUnreachableAfterJump: AstRule = {
  id: "no-unreachable-after-jump",
  severity: "warning",
  roleHint: "logic",
  shortDescription: "unreachable statement after a control-flow jump",
  language: "both",
  nodeTypes: ["BlockStatement"],
  visit(node: AstNode, ctx: RuleContext): AstRuleHit | null {
    if (!node || node.type !== "BlockStatement") return null
    const body = Array.isArray(node.body) ? node.body : []
    for (let i = 0; i < body.length - 1; i++) {
      const stmt = body[i]
      if (!stmt || !JUMP_TYPES.has(stmt.type)) continue
      // Find the next NON-hoisted, non-inert sibling. A trailing
      // function declaration / empty statement is reachable, so skip it.
      // Review (code-reviewer M2): also skip a `var` declaration — its
      // BINDING is hoisted (exists as `undefined`), so "this statement
      // can never run" overstates; only the assignment is dead. `let`/
      // `const` after a jump ARE genuinely unreachable (TDZ), so they are
      // still flagged.
      const skip = (s: AstNode): boolean =>
        HOISTED_OR_INERT.has(s.type) || (s.type === "VariableDeclaration" && s.kind === "var")
      let j = i + 1
      while (j < body.length && body[j] && skip(body[j])) j++
      if (j >= body.length) return null
      const dead = body[j]
      return {
        message: "Unreachable code: this statement follows an unconditional `return`/`throw`/`break`/`continue` in the same block and can never run. Remove it or fix the control flow.",
        evidence: sliceEvidence(ctx.source, dead),
        line: dead.loc?.start?.line ?? node.loc?.start?.line ?? 1,
        endLine: dead.loc?.end?.line ?? dead.loc?.start?.line ?? 1,
        column: dead.loc?.start?.column ?? 0,
      }
    }
    return null
  },
}
