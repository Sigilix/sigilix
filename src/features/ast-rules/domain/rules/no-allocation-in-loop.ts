// SIG-110: no-allocation-in-loop — flags a loop-INVARIANT expensive
// allocation built fresh on every iteration. Only the cases that are
// safe to detect syntactically AND safe to hoist without changing
// behavior are flagged (Codex + deepseek-v4-pro sign-off).
//
// Conservative scope (honor "prefer a miss"):
//   - `new RegExp("literal", <flags?>)` where the pattern is a string
//     literal and the flags (if present) are a literal NOT containing `g`
//     or `y`. A global/sticky RegExp carries mutable `lastIndex`, so
//     hoisting it changes behavior — those are NOT flagged.
//   - `new Intl.Collator | NumberFormat | DateTimeFormat(<literal args>)`
//     — constructing an Intl formatter is expensive and these are pure
//     given literal args.
//   - Explicitly NOT flagged: `JSON.parse("…")` (hoisting changes object
//     identity/mutability), object/array/Map/Set literals (a fresh
//     identity is often required each iteration), or any `new X(arg)`
//     whose args reference identifiers (might depend on the loop var).
//   - Loop scope resets at function boundaries.

import type { AstRule, AstRuleHit, RuleContext } from "@/features/ast-rules/domain/types"
import type { AstNode } from "@/features/ast-rules/domain/walker"

const SLICE_MAX = 200
const LOOP_TYPES: ReadonlySet<string> = new Set([
  "ForStatement", "ForInStatement", "ForOfStatement",
  "WhileStatement", "DoWhileStatement",
])
const FUNCTION_BOUNDARY_TYPES: ReadonlySet<string> = new Set([
  "FunctionDeclaration", "FunctionExpression",
  "ArrowFunctionExpression", "MethodDefinition",
])
const INTL_FORMATTERS: ReadonlySet<string> = new Set([
  "Collator", "NumberFormat", "DateTimeFormat", "RelativeTimeFormat", "ListFormat",
])

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

function isStringLiteral(n: AstNode | undefined): boolean {
  return !!n && n.type === "Literal" && typeof n.value === "string"
}

/** All args are literals (or there are none) → no dependence on loop state. */
function allArgsLiteral(args: AstNode[]): boolean {
  return args.every((a) => a && a.type === "Literal")
}

/** A `new RegExp("…" [, "flags"])` whose flags do NOT include g/y. */
function isHoistableRegExp(node: AstNode): boolean {
  const callee = node.callee as AstNode
  if (callee?.type !== "Identifier" || callee.name !== "RegExp") return false
  const args = (node.arguments ?? []) as AstNode[]
  if (!isStringLiteral(args[0])) return false
  if (args.length >= 2) {
    const flags = args[1]
    if (!isStringLiteral(flags)) return false // non-literal flags → skip
    const f = String(flags!.value)
    if (f.includes("g") || f.includes("y")) return false // stateful — hoisting changes behavior
  }
  return true
}

/** A `new Intl.<Formatter>(<literal args>)`. */
function isIntlFormatter(node: AstNode): boolean {
  const callee = node.callee as AstNode
  if (callee?.type !== "MemberExpression") return false
  const obj = callee.object as AstNode
  const prop = callee.property as AstNode
  if (obj?.type !== "Identifier" || obj.name !== "Intl") return false
  if (callee.computed || prop?.type !== "Identifier") return false
  if (!INTL_FORMATTERS.has(prop.name as string)) return false
  return allArgsLiteral((node.arguments ?? []) as AstNode[])
}

export const noAllocationInLoop: AstRule = {
  id: "no-allocation-in-loop",
  severity: "warning",
  roleHint: "performance",
  shortDescription: "loop-invariant allocation rebuilt every iteration",
  language: "both",
  nodeTypes: ["Program"],
  visit(node: AstNode, ctx: RuleContext): AstRuleHit[] | null {
    if (!node || node.type !== "Program") return null
    const hits: AstNode[] = []

    function walk(n: AstNode, loopDepth: number): void {
      if (!n || typeof n !== "object") return
      const t = n.type
      let nextDepth = loopDepth
      if (typeof t === "string" && FUNCTION_BOUNDARY_TYPES.has(t)) nextDepth = 0
      else if (typeof t === "string" && LOOP_TYPES.has(t)) nextDepth = loopDepth + 1
      if (nextDepth > 0 && t === "NewExpression" && (isHoistableRegExp(n) || isIntlFormatter(n))) {
        hits.push(n)
        return
      }
      for (const k of Object.keys(n)) {
        if (k === "type" || k === "loc" || k === "start" || k === "end") continue
        const v = (n as Record<string, unknown>)[k]
        if (Array.isArray(v)) {
          for (const item of v) if (item && typeof item === "object") walk(item as AstNode, nextDepth)
        } else if (v && typeof v === "object") {
          walk(v as AstNode, nextDepth)
        }
      }
    }
    walk(node, 0)
    if (hits.length === 0) return null
    return hits.map((h) => ({
      message: "This allocation does not depend on the loop and is rebuilt every iteration. Hoist it above the loop and reuse the single instance.",
      evidence: sliceEvidence(ctx.source, h),
      line: h.loc?.start?.line ?? 1,
      endLine: h.loc?.end?.line ?? h.loc?.start?.line ?? 1,
      column: h.loc?.start?.column ?? 0,
    }))
  },
}
