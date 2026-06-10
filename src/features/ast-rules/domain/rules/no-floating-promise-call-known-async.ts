// ARC-181: no-floating-promise-call-known-async — flags
// `someAsync()` as a top-level expression statement when
// `someAsync` is a same-file `async function` declaration. Narrowed
// from the original "any Promise-returning call" framing per Codex
// MAJOR #4 since AST alone can't determine return types.
//
// Pre-pass is rule-internal (Kimi MINOR #4): the rule walks the
// file's AST once, building a set of identifier names declared as
// async functions, then walks ExpressionStatement nodes.

import type { AstRule, AstRuleHit, RuleContext } from "@/src/features/ast-rules/domain/types"
import type { AstNode } from "@/src/features/ast-rules/domain/walker"

const SLICE_MAX = 200

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

function collectAsyncFnNames(ast: AstNode): Set<string> {
  const names = new Set<string>()
  function walk(node: AstNode): void {
    if (!node || typeof node !== "object") return
    if (node.type === "FunctionDeclaration" && node.async && node.id?.name) {
      names.add(node.id.name as string)
    }
    if (node.type === "VariableDeclaration") {
      for (const d of node.declarations ?? []) {
        const init = d?.init
        if (
          (init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression") &&
          init.async &&
          d.id?.type === "Identifier"
        ) {
          names.add(d.id.name as string)
        }
      }
    }
    for (const k of Object.keys(node)) {
      if (k === "type" || k === "loc" || k === "start" || k === "end") continue
      const v = (node as Record<string, unknown>)[k]
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item && typeof item === "object") walk(item as AstNode)
        }
      } else if (v && typeof v === "object") {
        walk(v as AstNode)
      }
    }
  }
  walk(ast)
  return names
}

const fileAsyncFnCache = new WeakMap<object, Set<string>>()

export const noFloatingPromiseCallKnownAsync: AstRule = {
  id: "no-floating-promise-call-known-async",
  severity: "warning",
  roleHint: "logic",
  shortDescription: "floating promise from a same-file async function",
  language: "both",
  nodeTypes: ["ExpressionStatement"],
  visit(node: AstNode, ctx: RuleContext): AstRuleHit | null {
    if (!node || node.type !== "ExpressionStatement") return null
    const expr = node.expression
    if (!expr || expr.type !== "CallExpression") return null
    const callee = expr.callee
    if (callee?.type !== "Identifier") return null

    let asyncNames = fileAsyncFnCache.get(ctx.ast as object)
    if (!asyncNames) {
      asyncNames = collectAsyncFnNames(ctx.ast)
      fileAsyncFnCache.set(ctx.ast as object, asyncNames)
    }
    if (!asyncNames.has(callee.name)) return null
    return {
      message: `Floating promise: \`${callee.name}()\` returns a Promise but it's neither awaited nor assigned. Add \`await\`, return it, or assign to a variable to silence.`,
      evidence: sliceEvidence(ctx.source, node),
      line: node.loc?.start?.line ?? 1,
      column: node.loc?.start?.column ?? 0,
    }
  },
}
