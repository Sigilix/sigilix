// SIG-110: no-spread-accumulator-in-loop — flags quadratic accumulation
// like `acc = [...acc, x]` or `acc = {...acc, k: v}` inside a loop body.
// Rebuilding the whole container each iteration is O(n^2) over the loop.
//
// Conservative scope (honor "prefer a miss", per Codex + deepseek-v4-pro
// sign-off):
//   - Only the plain `=` operator. `acc += [...acc]` is not this pattern.
//   - LHS must be a BARE Identifier `N`; RHS must be an ArrayExpression or
//     ObjectExpression that SPREADS a bare Identifier of the SAME name `N`.
//     Member targets (`this.acc = [...this.acc]`) are skipped — object
//     identity is ambiguous without dataflow.
//   - SHADOWING GUARD (deepseek-v4-pro): acorn gives no scope binding, so
//     name equality alone is unsafe — a `catch (acc)` or an inner
//     `for (const acc of …)` introduces a different `acc`. If the name `N`
//     is declared ANYWHERE inside the enclosing loop body (a let/const/var,
//     a catch param, or an inner loop variable), we skip the match: the
//     assignment may target a shadowing binding, not the outer accumulator.
//   - Loop scope resets at every function boundary — an assignment inside a
//     nested function is not "in the loop".

import type { AstRule, AstRuleHit, RuleContext } from "../types"
import type { AstNode } from "../walker"

const SLICE_MAX = 200
const LOOP_TYPES: ReadonlySet<string> = new Set([
  "ForStatement", "ForInStatement", "ForOfStatement",
  "WhileStatement", "DoWhileStatement",
])
const FUNCTION_BOUNDARY_TYPES: ReadonlySet<string> = new Set([
  "FunctionDeclaration", "FunctionExpression",
  "ArrowFunctionExpression", "MethodDefinition",
])

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

/** Collect every identifier bound by a binding target — a plain Identifier
 *  or a destructuring pattern (`{a, b: c}`, `[x, ...rest]`, defaults). This
 *  is what makes the shadowing guard sound for destructured `let/const` and
 *  catch bindings (CodeRabbit): `for (…) { const { acc } = x; acc = [...acc] }`
 *  must NOT flag. */
function collectPatternNames(node: AstNode | undefined, names: Set<string>): void {
  if (!node || typeof node !== "object") return
  switch (node.type) {
    case "Identifier":
      names.add(node.name as string)
      return
    case "ObjectPattern":
      for (const p of (node.properties ?? []) as AstNode[]) {
        if (p?.type === "RestElement") collectPatternNames(p.argument as AstNode, names)
        else collectPatternNames(p?.value as AstNode, names) // Property.value is the binding target
      }
      return
    case "ArrayPattern":
      for (const el of (node.elements ?? []) as AstNode[]) collectPatternNames(el, names)
      return
    case "RestElement":
      collectPatternNames(node.argument as AstNode, names)
      return
    case "AssignmentPattern": // `{ a = 1 }` / `[x = 0]`
      collectPatternNames(node.left as AstNode, names)
      return
  }
}

/** Names bound by a declaration node, added into `names`. Does NOT recurse
 *  into function bodies (those are a different scope handled by the reset). */
function collectDeclaredNames(node: AstNode, names: Set<string>): void {
  if (!node || typeof node !== "object") return
  const t = node.type
  if (typeof t === "string" && FUNCTION_BOUNDARY_TYPES.has(t)) return
  if (t === "VariableDeclarator") {
    collectPatternNames(node.id as AstNode, names)
  }
  if (t === "CatchClause" && node.param) {
    collectPatternNames(node.param as AstNode, names)
  }
  // Inner loop variables: `for (const x of …)` / `for (let i = …)`.
  if ((t === "ForOfStatement" || t === "ForInStatement" || t === "ForStatement")) {
    const left = (node.left ?? node.init) as AstNode | undefined
    if (left?.type === "VariableDeclaration") collectDeclaredNames(left, names)
  }
  for (const k of Object.keys(node)) {
    if (k === "type" || k === "loc" || k === "start" || k === "end") continue
    const v = (node as Record<string, unknown>)[k]
    if (Array.isArray(v)) {
      for (const item of v) if (item && typeof item === "object") collectDeclaredNames(item as AstNode, names)
    } else if (v && typeof v === "object") {
      collectDeclaredNames(v as AstNode, names)
    }
  }
}

/** Is `node` an `=` assignment of the shape `N = [...N, …]` / `N = {...N}`
 *  for a bare identifier `N`? Returns the name `N` or null. */
function spreadSelfAssignName(node: AstNode): string | null {
  if (!node || node.type !== "AssignmentExpression" || node.operator !== "=") return null
  const left = node.left as AstNode
  if (left?.type !== "Identifier") return null
  const name = left.name as string
  const right = node.right as AstNode
  if (right?.type !== "ArrayExpression" && right?.type !== "ObjectExpression") return null
  const elements = (right.elements ?? right.properties ?? []) as AstNode[]
  for (const el of elements) {
    if (!el) continue
    // ObjectExpression spreads are `SpreadElement` in acorn (`...obj`).
    if (el.type === "SpreadElement" && (el.argument as AstNode)?.type === "Identifier"
      && (el.argument as AstNode).name === name) {
      return name
    }
  }
  return null
}

export const noSpreadAccumulatorInLoop: AstRule = {
  id: "no-spread-accumulator-in-loop",
  severity: "warning",
  roleHint: "performance",
  shortDescription: "spread-rebuild of an accumulator inside a loop (O(n²))",
  language: "both",
  nodeTypes: ["Program"],
  visit(node: AstNode, ctx: RuleContext): AstRuleHit | null {
    if (!node || node.type !== "Program") return null
    let hit: AstNode | null = null

    // declaredInLoop: names bound inside the current outermost active loop.
    // Empty when not in a loop. Reset at function boundaries.
    function walk(n: AstNode, loopDepth: number, declaredInLoop: Set<string>): void {
      if (hit || !n || typeof n !== "object") return
      const t = n.type
      let nextDepth = loopDepth
      let nextDeclared = declaredInLoop
      if (typeof t === "string" && FUNCTION_BOUNDARY_TYPES.has(t)) {
        // New function scope: not in any loop here.
        nextDepth = 0
        nextDeclared = new Set()
      } else if (typeof t === "string" && LOOP_TYPES.has(t)) {
        nextDepth = loopDepth + 1
        if (loopDepth === 0) {
          // Entering the OUTERMOST loop — collect every name declared in
          // its subtree so a shadowing binding suppresses the match.
          nextDeclared = new Set()
          collectDeclaredNames(n, nextDeclared)
        }
      }
      if (nextDepth > 0) {
        const name = spreadSelfAssignName(n)
        if (name !== null && !nextDeclared.has(name)) {
          hit = n
          return
        }
      }
      for (const k of Object.keys(n)) {
        if (k === "type" || k === "loc" || k === "start" || k === "end") continue
        const v = (n as Record<string, unknown>)[k]
        if (Array.isArray(v)) {
          for (const item of v) if (item && typeof item === "object") walk(item as AstNode, nextDepth, nextDeclared)
        } else if (v && typeof v === "object") {
          walk(v as AstNode, nextDepth, nextDeclared)
        }
      }
    }
    walk(node, 0, new Set())
    if (!hit) return null
    const h = hit as AstNode
    return {
      message: "Rebuilding a collection with a spread (`acc = [...acc, …]`) on each iteration is O(n²) over the loop. Mutate in place (`acc.push(…)`) or build once after the loop.",
      evidence: sliceEvidence(ctx.source, h),
      line: h.loc?.start?.line ?? 1,
      endLine: h.loc?.end?.line ?? h.loc?.start?.line ?? 1,
      column: h.loc?.start?.column ?? 0,
    }
  },
}
