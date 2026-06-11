// ARC-181: no-async-without-await — flags `async` function/arrow
// declarations that have no `AwaitExpression` in their body. The
// `async` keyword wraps the return value in a Promise + adds a
// microtask boundary; if there's no await, the wrapping is unneeded
// overhead. Sometimes intentional (e.g. for API parity); reviewers
// can suppress via `astRules.disabledRules`.

import type { AstRule, AstRuleHit, RuleContext } from "@/src/features/ast-rules/domain/types"
import type { AstNode } from "@/src/features/ast-rules/domain/walker"

const SLICE_MAX = 200

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

function bodyHasAwait(body: AstNode): boolean {
  if (!body || typeof body !== "object") return false
  if (body.type === "AwaitExpression") return true
  // Crossing a function-scope boundary — `await` inside a nested
  // FunctionDeclaration / FunctionExpression / ArrowFunctionExpression
  // belongs to that nested function's scope, not ours. Bail
  // unconditionally. The caller invokes us only with the outer async
  // function's `body` field (a BlockStatement, or for concise-body
  // arrows the body expression), so a Function* node here is always a
  // nested scope. (Sigilix-bot caught this on PR #67: the previous
  // `body !== arguments[0]` guard was always false because in every
  // call frame `arguments[0]` is the same as `body`.)
  if (
    body.type === "FunctionDeclaration" ||
    body.type === "FunctionExpression" ||
    body.type === "ArrowFunctionExpression"
  ) {
    return false
  }
  for (const k of Object.keys(body)) {
    if (k === "type" || k === "loc" || k === "start" || k === "end") continue
    const v = (body as Record<string, unknown>)[k]
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === "object" && bodyHasAwait(item as AstNode)) return true
      }
    } else if (v && typeof v === "object" && bodyHasAwait(v as AstNode)) {
      return true
    }
  }
  return false
}

export const noAsyncWithoutAwait: AstRule = {
  id: "no-async-without-await",
  severity: "warning",
  roleHint: "logic",
  shortDescription: "async function with no await",
  language: "both",
  nodeTypes: ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"],
  visit(node: AstNode, ctx: RuleContext): AstRuleHit | null {
    if (!node || !node.async) return null
    if (!node.body) return null
    if (bodyHasAwait(node.body)) return null
    return {
      message:
        "`async` function with no `await` — the wrapping is unnecessary microtask overhead. Drop `async` or add the missing `await`.",
      evidence: sliceEvidence(ctx.source, node),
      line: node.loc?.start?.line ?? 1,
      // Pass the full function body span so the runner's diff-line
      // filter sees edits later in the body even when the function
      // declaration line itself is unchanged.
      endLine: node.loc?.end?.line ?? node.loc?.start?.line ?? 1,
      column: node.loc?.start?.column ?? 0,
    }
  },
}
