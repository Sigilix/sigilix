// SIG-110: no-n-plus-one-call-in-loop — flags an AWAITED data-access call
// inside a loop body (the classic N+1 query/request anti-pattern).
//
// Conservative scope (honor "prefer a miss", per Codex + deepseek-v4-pro
// sign-off):
//   - Only AWAITED calls (`await db.query(…)` inside a loop). A non-awaited
//     call returning a promise is usually collected for `Promise.all(…)`
//     (i.e. already batched) — requiring `await` removes that whole FP
//     class at the cost of missing the rare un-awaited sequential case.
//   - Callee must match a KNOWN data-access shape (allowlist below).
//     Generic `.get` / `.find` / `.query` on an unknown root are NOT
//     flagged — they are too often in-memory helpers.
//   - Loop scope resets at function boundaries; an awaited call inside a
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

// Known DB-client roots whose `.query(…)` is a database round-trip.
const QUERY_ROOTS: ReadonlySet<string> = new Set(["db", "pool", "client", "connection"])
// axios HTTP verbs.
const AXIOS_METHODS: ReadonlySet<string> = new Set(["get", "post", "put", "delete", "patch", "options", "head", "request"])
// Prisma data-access methods (a model method that is NOT one of these is
// likely a user helper, so we don't flag it).
const PRISMA_METHODS: ReadonlySet<string> = new Set([
  "findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany",
  "create", "createMany", "update", "updateMany", "upsert",
  "delete", "deleteMany", "count", "aggregate", "groupBy",
  "$queryRaw", "$executeRaw", "$queryRawUnsafe", "$executeRawUnsafe", "$transaction",
])
// Supabase query-builder terminal/initiator methods.
const SUPABASE_METHODS: ReadonlySet<string> = new Set(["select", "insert", "update", "delete", "upsert", "rpc"])

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

function idName(n: AstNode | undefined): string | null {
  return n && n.type === "Identifier" ? (n.name as string) : null
}

/** Non-computed `<obj>.<prop>` → return [objName|null via recursion marker, prop]. */
function memberProp(callee: AstNode): string | null {
  if (callee?.type !== "MemberExpression" || callee.computed) return null
  const prop = callee.property as AstNode
  return prop?.type === "Identifier" ? (prop.name as string) : null
}

/** Does the call's callee match a known data-access pattern? */
function isDataAccessCallee(callee: AstNode): boolean {
  if (!callee) return false

  // fetch(…)
  if (idName(callee) === "fetch") return true

  if (callee.type !== "MemberExpression" || callee.computed) return false
  const prop = memberProp(callee)
  if (prop === null) return false
  const obj = callee.object as AstNode
  const objId = idName(obj)

  // axios.get(…) etc.
  if (objId === "axios" && AXIOS_METHODS.has(prop)) return true
  // db.query(…) / pool.query(…) / client.query(…) / connection.query(…)
  if (objId !== null && QUERY_ROOTS.has(objId) && prop === "query") return true
  // knex(…) handled below as a bare call; knex query builders vary too much.

  // prisma.<model>.<method>(…) — obj is `prisma.<model>` (a MemberExpression
  // off the `prisma` identifier), method on the allowlist.
  if (PRISMA_METHODS.has(prop) && obj?.type === "MemberExpression" && !obj.computed) {
    if (idName(obj.object as AstNode) === "prisma") return true
  }

  // supabase chain: `supabase.from(…).select(…)` / `.insert(…)` / `.rpc(…)`.
  // The terminal method's object is a CallExpression rooted at supabase.
  if (SUPABASE_METHODS.has(prop) && obj?.type === "CallExpression") {
    if (callRootIsSupabase(obj)) return true
  }
  return false
}

/** Walk a member/call chain's left spine to see if it is rooted at the
 *  `supabase` identifier (e.g. `supabase.from("t")`). */
function callRootIsSupabase(node: AstNode): boolean {
  let cur: AstNode | undefined = node
  let guard = 0
  while (cur && guard++ < 12) {
    if (idName(cur) === "supabase") return true
    if (cur.type === "CallExpression") cur = cur.callee as AstNode
    else if (cur.type === "MemberExpression") cur = cur.object as AstNode
    else return false
  }
  return false
}

export const noNPlusOneCallInLoop: AstRule = {
  id: "no-n-plus-one-call-in-loop",
  severity: "warning",
  roleHint: "performance",
  shortDescription: "awaited data-access call inside a loop (N+1)",
  language: "both",
  nodeTypes: ["Program"],
  visit(node: AstNode, ctx: RuleContext): AstRuleHit | null {
    if (!node || node.type !== "Program") return null
    let hit: AstNode | null = null

    function walk(n: AstNode, loopDepth: number): void {
      if (hit || !n || typeof n !== "object") return
      const t = n.type
      let nextDepth = loopDepth
      if (typeof t === "string" && FUNCTION_BOUNDARY_TYPES.has(t)) nextDepth = 0
      else if (typeof t === "string" && LOOP_TYPES.has(t)) nextDepth = loopDepth + 1
      if (nextDepth > 0 && t === "AwaitExpression") {
        const arg = n.argument as AstNode
        if (arg?.type === "CallExpression" && isDataAccessCallee(arg.callee as AstNode)) {
          hit = arg
          return
        }
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
    if (!hit) return null
    const h = hit as AstNode
    return {
      message: "Awaiting a data-access call inside a loop runs one round-trip per iteration (N+1). Batch the work into a single query/request, or collect the promises and `await Promise.all(…)`.",
      evidence: sliceEvidence(ctx.source, h),
      line: h.loc?.start?.line ?? 1,
      endLine: h.loc?.end?.line ?? h.loc?.start?.line ?? 1,
      column: h.loc?.start?.column ?? 0,
    }
  },
}
