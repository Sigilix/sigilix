// ARC-181: no-await-in-loop — flags `await` inside any loop body.
// Pure syntactic perf hint per spec §4.2 (renamed from
// `no-await-in-loop-iter-independent` after Codex MAJOR #5 + Kimi
// MAJOR #3 — iteration-independence requires dataflow analysis
// acorn can't provide). Sometimes intentional; reviewers can
// suppress via `astRules.disabledRules`.
//
// Implementation: walks `AwaitExpression` nodes. Uses a depth-tracked
// closure to know whether we're inside a loop without crossing a
// function boundary. Since acorn-walk's simple traversal is
// post-order without ancestor info, the rule does its own targeted
// pre-pass over the file's AST.

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

interface AwaitInLoopHit {
  node: AstNode
  insideLoop: boolean
}

function findAwaitsInLoops(ast: AstNode): AwaitInLoopHit[] {
  const out: AwaitInLoopHit[] = []
  function walk(node: AstNode, loopDepth: number, fnDepth: number): void {
    if (!node || typeof node !== "object") return
    const t = node.type
    let nextLoop = loopDepth
    let nextFn = fnDepth
    if (typeof t === "string" && LOOP_TYPES.has(t)) nextLoop = loopDepth + 1
    if (typeof t === "string" && FUNCTION_BOUNDARY_TYPES.has(t)) {
      // Resetting loopDepth: a nested function inside a loop has its
      // own loop scope. `await` inside the nested function is NOT
      // "in the loop" for our purposes.
      nextFn = fnDepth + 1
      nextLoop = 0
    }
    if (t === "AwaitExpression" && nextLoop > 0) {
      out.push({ node, insideLoop: true })
    }
    for (const k of Object.keys(node)) {
      if (k === "type" || k === "loc" || k === "start" || k === "end") continue
      const v = (node as Record<string, unknown>)[k]
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item && typeof item === "object") walk(item as AstNode, nextLoop, nextFn)
        }
      } else if (v && typeof v === "object") {
        walk(v as AstNode, nextLoop, nextFn)
      }
    }
  }
  walk(ast, 0, 0)
  return out
}

export const noAwaitInLoop: AstRule = {
  id: "no-await-in-loop",
  severity: "warning",
  roleHint: "performance",
  shortDescription: "await inside a loop body",
  language: "both",
  // Visit Program once; the rule does a depth-tracked walk itself.
  nodeTypes: ["Program"],
  visit(node: AstNode, ctx: RuleContext): AstRuleHit | null {
    if (!node || node.type !== "Program") return null
    const hits = findAwaitsInLoops(node)
    if (hits.length === 0) return null
    // Emit at the FIRST hit's location. The runner emits one
    // finding per visit() call; if a file has multiple await-in-loop
    // sites, only the first is flagged in v1. Multiple-emit support
    // is a v2 enhancement.
    const first = hits[0]!
    return {
      message: "`await` inside a loop body executes iterations sequentially. If iterations are independent, use `Promise.all(arr.map(...))` for parallelism.",
      evidence: sliceEvidence(ctx.source, first.node),
      line: first.node.loc?.start?.line ?? 1,
      column: first.node.loc?.start?.column ?? 0,
    }
  },
}
