// SIG-314: no-unauthorized-object-lookup — a DETERMINISTIC IDOR/BOLA floor.
// Flags a request-controlled object identifier (`req.params.id`,
// `req.query.workspace`, `req.body.workspace`, or a local derived from one)
// flowing into a record lookup (`query(…)`, `findById`, `findOne`, …) inside a
// route handler that contains NO object-level authorization check.
//
// WHY this exists: the security specialist catches these by reasoning, but
// NONDETERMINISTICALLY — on a terse run it walks one route and misses a sibling
// (pr/08: caught the keys.ts cluster, dropped the workspaces BOLA). This rule is
// the run-INVARIANT floor: the obvious in-diff IDOR is never fully missed again.
//
// FP-SAFETY (the whole design — a P0/P1 false positive on safe handler code is
// the worst possible outcome for the product, so we fail CLOSED on every doubt):
//   - severity `warning` → the deterministic-emit synth path pins it to P2 and
//     `clampAstEmitScores` HARD-caps it; this rule can NEVER post a P0/P1 on its
//     own. When the model's security specialist independently judges the same
//     line a real P0/P1, THAT finding stands (provenance-aware exemption) — so
//     no recall is lost on a confirmed IDOR; we only add a deterministic floor.
//   - A handler is SKIPPED the moment ANY authorization/principal signal appears
//     in its body (`req.subject`/`req.user`/`req.auth`, `authorize`, `isMember`,
//     `requireRole`, `403`, …) — a line-scan can't see middleware authz, so the
//     in-body principal reference is our proxy for "this handler is authz-aware".
//   - The tainted key must read like an OBJECT HANDLE (`id`/`*Id`/`*_id`/`uuid`/
//     `workspace`/`org`/`tenant`/…); pagination/search params (`since`, `q`,
//     `page`, `limit`) are NOT object handles and never fire.
//   - The data-access verb set is curated to unambiguous DB reads/writes
//     (`query`, `findById`, `findUnique`, …), never array methods (`find`,
//     `map`) — `items.find(…)` is not a lookup.
//   - Test / spec / migration / script files are skipped (not request paths).
//
// Conservative scope (prefer a miss): a custom data-access wrapper
// (`revokeKey(id)`) whose name isn't a known verb is NOT flagged; middleware-only
// authz with no in-body principal reference is the known residual FP source,
// which is why SIG-314 ships shadow-first and is P2-capped.

import type { AstRule, AstRuleHit, RuleContext } from "@/src/features/ast-rules/domain/types"
import type { AstNode } from "@/src/features/ast-rules/domain/walker"

const SLICE_MAX = 200
const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
])
const ROUTE_METHODS: ReadonlySet<string> = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "all",
  "head",
  "options",
  "use",
])
// Conventional router-object identifiers (mirrors no-sync-io-in-request-path):
// a `.get`/`.use` call is a route registration only when its object is one of
// these OR its first argument is a "/"-prefixed string literal — so
// `cache.get("k", cb)` is never mistaken for a route.
const ROUTE_OBJECT_NAMES: ReadonlySet<string> = new Set([
  "app",
  "router",
  "server",
  "route",
  "api",
  "apirouter",
  "approuter",
  "express",
])
const NEXT_HTTP_EXPORTS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
const SKIP_PATH = /(\.test\.|\.spec\.|\.config\.|(^|\/)(__tests__|tests?|migrations?|scripts?)\/)/

// Names that read like an OBJECT HANDLE (an id / tenant key), NOT a
// pagination/search param. Shared by the request-member regex, the taint-local
// pre-pass, and the Next route-param binding.
const OBJECT_HANDLE_RE = /^(?:id|uuid|guid|pk|[A-Za-z]+[_]?[Ii]d|workspace|org|tenant|account|project|group)$/i
// A request-controlled OBJECT HANDLE: req|request|ctx|context.(params|query|
// body)[?.]<handle>. `context`/`ctx` cover Next `context.params.id`. The
// optional `?.` covers `req.body?.workspace`.
const TAINTED_MEMBER_RE =
  /\b(?:req|request|ctx|context)\.(?:params|query|body)\??\.(?:id|uuid|guid|pk|[A-Za-z]+[_]?[Ii]d|workspace|org|tenant|account|project|group)\b/
// SIG-313: CALL-based request handles (Hono + Cloudflare Workers), the
// complement to TAINTED_MEMBER_RE's member access. Slice-based (like the member
// regex) so taint flows through `String(c.req.param("id") ?? "")` wrappers:
//   - Hono:    c.req.param("id") / c.req.query("workspace")  (ctx in c|ctx|context)
//   - Workers: new URL(request.url).searchParams.get("id")
// The Workers arm is ANCHORED to a request-derived URL (`req|request.url` must
// precede `.searchParams.get`) so a static `new URLSearchParams("a=1").get(...)`
// can't false-positive (Sigilix #344 — the rule's zero-FP-on-safe-code goal).
// The split form `const u = new URL(request.url); u.searchParams.get("id")` is
// intentionally NOT matched — a safe miss, per the rule's prefer-a-miss design.
// The string-literal arg must be an OBJECT HANDLE, so `c.req.query("page")`
// (pagination) and `searchParams.get("q")` (search) never taint.
const HANDLE_ARG = String.raw`["'\`](?:id|uuid|guid|pk|[A-Za-z]+[_]?[Ii]d|workspace|org|tenant|account|project|group)["'\`]`
const TAINTED_CALL_RE = new RegExp(
  String.raw`(?:\b(?:c|ctx|context)\.req\.(?:param|query)\(|(?:req|request)\.url\b[\s\S]{0,40}?\.searchParams\.get\()\s*` +
    HANDLE_ARG,
)
/** A request-controlled OBJECT HANDLE in `slice` — member access OR a call source. */
function sliceIsTainted(slice: string): boolean {
  return TAINTED_MEMBER_RE.test(slice) || TAINTED_CALL_RE.test(slice)
}
// SIG-313: Hono/Workers principal reads that mark a handler authz-aware (fail
// closed). `c.get("user")` and the `c.var.<principal>` namespace are Hono's
// idiomatic principal accessors; scoped to those shapes so a data field named
// `user` can't mute the floor (the `403` literal already covers most safe handlers).
const CTX_PRINCIPAL_RE = /^(?:user|session|auth|subject|principal|currentuser|jwtpayload|jwt|identity)$/
// The principal/authorization signals. If a handler body references ANY of
// these, it is authz-aware and we fail closed (skip). Deliberately principal-
// focused (`subject`/`req.user`/authorize/…) and NOT keyed on bare `member`/
// `owner`/`tenant` — those name DATA (`member_id`), and skipping on them would
// hide real IDORs on member/owner/tenant resources (false negative).
// Principal/authorization token names. Matched against AST IDENTIFIERS, member
// PROPERTY names, and call CALLEE names — NOT raw source (CodeRabbit #302: a
// comment `// TODO requireRole` or a string `Error("forbidden")` must not mute
// the floor). Deliberately principal-focused (`subject`/`req.user`/authorize/…)
// and NOT bare `member`/`owner`/`tenant` — those name DATA (`member_id`), and
// skipping on them would hide real IDORs on member/owner/tenant resources.
const AUTHZ_TOKEN_RE =
  /^(?:subject|currentuser|session|getserversession|gettoken|authoriz[a-z]*|ismember|hasaccess|haspermission|assert(?:member|owner|access)|require(?:member|role|owner|admin|auth)|forbidden|unauthorized)$/
// Unambiguous DB read/write verbs. Curated (no bare `find`/`get`/`read`) so an
// array method (`arr.find`, `rows.map`) is never mistaken for a record lookup.
const DATA_ACCESS_NAMES: ReadonlySet<string> = new Set([
  "query",
  "findbyid",
  "findbypk",
  "findone",
  "findunique",
  "findfirst",
  "getbyid",
  "getbypk",
  "select",
  "upsert",
  "retrieve",
  "lookup",
  "raw",
])

function idName(n: AstNode | undefined): string | null {
  return n && n.type === "Identifier" ? (n.name as string) : null
}

/** Is `node` the Hono `<ctx>.var` principal namespace (`c.var`/`ctx.var`)? */
function isCtxVar(node: AstNode | undefined): boolean {
  if (!node || node.type !== "MemberExpression" || node.computed) return false
  if (idName(node.property as AstNode) !== "var") return false
  const root = idName(node.object as AstNode)
  return !!root && /^(?:c|ctx|context)$/i.test(root)
}

function sliceOf(source: string, node: AstNode | undefined): string {
  if (!node || typeof node.start !== "number" || typeof node.end !== "number") return ""
  return source.slice(node.start, node.end)
}

function sliceEvidence(source: string, node: AstNode): string {
  const slice = sliceOf(source, node)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

/** Walk a subtree WITHOUT descending into nested functions, invoking `fn` on
 *  every node. Used for handler-body scans (a nested callback is not on the
 *  synchronous handler path). */
function walkNoNested(root: AstNode, fn: (n: AstNode) => void): void {
  function walk(n: AstNode): void {
    if (!n || typeof n !== "object") return
    if (typeof n.type === "string" && FUNCTION_TYPES.has(n.type) && n !== root) return
    fn(n)
    for (const k of Object.keys(n)) {
      if (k === "type" || k === "loc" || k === "start" || k === "end") continue
      const v = (n as Record<string, unknown>)[k]
      if (Array.isArray(v)) {
        for (const item of v) if (item && typeof item === "object") walk(item as AstNode)
      } else if (v && typeof v === "object") {
        walk(v as AstNode)
      }
    }
  }
  walk(root)
}

/** Is this `<obj>.<method>(…)` route-shaped? (mirrors no-sync-io-in-request-path) */
function isRouteShaped(call: AstNode): boolean {
  const callee = call.callee as AstNode
  let cur: AstNode | undefined = callee?.object as AstNode
  let guard = 0
  while (cur && guard++ < 8) {
    const nm = idName(cur)
    if (nm && ROUTE_OBJECT_NAMES.has(nm.toLowerCase())) return true
    if (cur.type === "CallExpression") cur = cur.callee as AstNode
    else if (cur.type === "MemberExpression") cur = cur.object as AstNode
    else break
  }
  const first = (call.arguments ?? [])[0] as AstNode | undefined
  return (
    !!first && first.type === "Literal" && typeof first.value === "string" && (first.value as string).startsWith("/")
  )
}

/** Same-file named functions: `function f(){}` and `const f = () => {}`, so a
 *  route registered with a named handler (`router.get("/x", showWorkspace)`) can
 *  be resolved + scanned (CodeRabbit #302). */
function collectNamedFunctions(program: AstNode): Map<string, AstNode> {
  const fns = new Map<string, AstNode>()
  function walk(n: AstNode): void {
    if (!n || typeof n !== "object") return
    if (n.type === "FunctionDeclaration") {
      const nm = idName(n.id as AstNode)
      if (nm) fns.set(nm, n)
    } else if (n.type === "VariableDeclarator") {
      const nm = idName(n.id as AstNode)
      const init = n.init as AstNode
      if (nm && init && FUNCTION_TYPES.has(init.type as string)) fns.set(nm, init)
    }
    for (const k of Object.keys(n)) {
      if (k === "type" || k === "loc" || k === "start" || k === "end") continue
      const v = (n as Record<string, unknown>)[k]
      if (Array.isArray(v)) {
        for (const item of v) if (item && typeof item === "object") walk(item as AstNode)
      } else if (v && typeof v === "object") walk(v as AstNode)
    }
  }
  walk(program)
  return fns
}

/** Does the handler body contain a real (code-level, not comment/string) authz
 *  signal — a principal reference, an authz call, or a `403`? (CodeRabbit #302:
 *  AST-based so comments/strings can't mute the floor.) */
function handlerHasAuthzSignal(body: AstNode): boolean {
  let found = false
  walkNoNested(body, (n) => {
    if (found) return
    if (n.type === "Identifier") {
      if (AUTHZ_TOKEN_RE.test((n.name as string).toLowerCase())) found = true
    } else if (n.type === "MemberExpression" && !n.computed) {
      const obj = idName(n.object as AstNode)
      const prop = idName(n.property as AstNode)
      // req.user / req.auth / req.session
      if (obj && /^(?:req|request)$/.test(obj) && prop && /^(?:user|auth|session)$/.test(prop)) found = true
      // SIG-313: Hono `c.var.<principal>` (the .var principal namespace).
      else if (prop && CTX_PRINCIPAL_RE.test(prop.toLowerCase()) && isCtxVar(n.object as AstNode)) found = true
      else if (prop && AUTHZ_TOKEN_RE.test(prop.toLowerCase())) found = true
    } else if (
      n.type === "CallExpression" &&
      (n.callee as AstNode)?.type === "MemberExpression" &&
      !(n.callee as AstNode).computed
    ) {
      // SIG-313: Hono `c.get("user")` principal read.
      const callee = n.callee as AstNode
      const root = idName(callee.object as AstNode)
      const a0 = (n.arguments ?? [])[0] as AstNode | undefined
      if (
        idName(callee.property as AstNode) === "get" &&
        root &&
        /^(?:c|ctx|context)$/i.test(root) &&
        a0?.type === "Literal" &&
        typeof a0.value === "string" &&
        CTX_PRINCIPAL_RE.test((a0.value as string).toLowerCase())
      )
        found = true
    } else if (n.type === "Literal" && n.value === 403) {
      found = true
    }
  })
  return found
}

/** Collect request-handler function nodes: Express route callbacks (inline OR
 *  named/middleware identifiers resolved same-file) + Next-style exported HTTP
 *  functions. (mirrors no-sync-io-in-request-path) */
function collectHandlers(program: AstNode): AstNode[] {
  const handlers: AstNode[] = []
  const named = collectNamedFunctions(program)
  function walk(n: AstNode): void {
    if (!n || typeof n !== "object") return
    if (
      n.type === "CallExpression" &&
      (n.callee as AstNode)?.type === "MemberExpression" &&
      !(n.callee as AstNode).computed
    ) {
      const prop = idName((n.callee as AstNode).property as AstNode)
      if (prop && ROUTE_METHODS.has(prop) && isRouteShaped(n)) {
        for (const arg of (n.arguments ?? []) as AstNode[]) {
          if (!arg) continue
          if (FUNCTION_TYPES.has(arg.type as string)) handlers.push(arg)
          // Named handler / middleware: `router.get("/x", requireAuth, show)`.
          else if (arg.type === "Identifier") {
            const resolved = named.get(arg.name as string)
            if (resolved) handlers.push(resolved)
          }
        }
      }
    }
    // SIG-313: Cloudflare Workers-native `export default { async fetch(request,
    // env) {} }` (and `fetch: (request, env) => {}`). The single fetch mega-
    // handler is the Workers request path.
    if (n.type === "ExportDefaultDeclaration" && (n.declaration as AstNode)?.type === "ObjectExpression") {
      for (const p of ((n.declaration as AstNode).properties ?? []) as AstNode[]) {
        if (!p || p.type !== "Property" || idName(p.key as AstNode) !== "fetch") continue
        // Both `async fetch(request, env) {}` (method shorthand) and
        // `fetch: (request, env) => {}` land here as Property.value = a function.
        const fn = p.value as AstNode
        if (fn && FUNCTION_TYPES.has(fn.type as string)) handlers.push(fn)
      }
    }
    if (n.type === "ExportNamedDeclaration" && n.declaration) {
      const decl = n.declaration as AstNode
      if (decl.type === "FunctionDeclaration" && NEXT_HTTP_EXPORTS.has(idName(decl.id as AstNode) ?? "")) {
        handlers.push(decl)
      } else if (decl.type === "VariableDeclaration") {
        for (const d of (decl.declarations ?? []) as AstNode[]) {
          const nm = idName(d.id as AstNode)
          const init = d.init as AstNode
          if (nm && NEXT_HTTP_EXPORTS.has(nm) && init && FUNCTION_TYPES.has(init.type as string)) {
            handlers.push(init)
          }
        }
      }
    }
    for (const k of Object.keys(n)) {
      if (k === "type" || k === "loc" || k === "start" || k === "end") continue
      const v = (n as Record<string, unknown>)[k]
      if (Array.isArray(v)) {
        for (const item of v) if (item && typeof item === "object") walk(item as AstNode)
      } else if (v && typeof v === "object") {
        walk(v as AstNode)
      }
    }
  }
  walk(program)
  return handlers
}

/** Locals whose initializer carries a tainted request handle, so taint flows
 *  through `const wsId = String(req.body?.workspace ?? "")` and the destructure
 *  `const { id } = req.params`. */
function collectTaintedLocals(body: AstNode, source: string): Set<string> {
  const tainted = new Set<string>()
  walkNoNested(body, (n) => {
    if (n.type !== "VariableDeclarator" || !n.init) return
    const init = n.init as AstNode
    const target = n.id as AstNode
    // `const { id } = req.params` — init is the bare member, the property name
    // carries the handle.
    if (target?.type === "ObjectPattern") {
      const initSlice = sliceOf(source, init)
      if (/\b(?:req|request|ctx)\.(?:params|query|body)\b/.test(initSlice)) {
        for (const p of (target.properties ?? []) as AstNode[]) {
          const key = idName(p.key as AstNode)
          const local = idName(p.value as AstNode) ?? key
          if (key && local && OBJECT_HANDLE_RE.test(key)) tainted.add(local)
        }
      }
      return
    }
    const local = idName(target)
    if (local && sliceIsTainted(sliceOf(source, init))) tainted.add(local)
  })
  return tainted
}

/** Next-style route params arrive via the handler's 2nd argument, NOT `req.*`:
 *  `GET(request, { params })` → the local `params` (so `params.id` is tainted),
 *  and `GET(request, { params: { id } })` → the inner handle names. (Express
 *  handlers have `res` as the 2nd arg → ObjectPattern check returns nothing.) */
function collectNextRouteParamLocals(handler: AstNode): string[] {
  const second = ((handler.params ?? []) as AstNode[])[1]
  if (!second || second.type !== "ObjectPattern") return []
  const out: string[] = []
  for (const p of (second.properties ?? []) as AstNode[]) {
    if (idName(p.key as AstNode) !== "params") continue
    const val = p.value as AstNode
    if (val?.type === "Identifier") {
      out.push(val.name as string)
    } else if (val?.type === "ObjectPattern") {
      for (const sp of (val.properties ?? []) as AstNode[]) {
        const key = idName(sp.key as AstNode)
        const local = idName(sp.value as AstNode) ?? key
        if (key && local && OBJECT_HANDLE_RE.test(key)) out.push(local)
      }
    }
  }
  return out
}

/** Does this call's argument subtree carry taint — a request handle member or a
 *  tainted local — without crossing into a nested callback? */
function argsCarryTaint(call: AstNode, taintedLocals: Set<string>, source: string): boolean {
  for (const arg of (call.arguments ?? []) as AstNode[]) {
    if (!arg || typeof arg !== "object") continue
    let found = false
    walkNoNested(arg as AstNode, (n) => {
      if (found) return
      if (n.type === "MemberExpression" && TAINTED_MEMBER_RE.test(sliceOf(source, n))) found = true
      // SIG-313: a call-based request handle directly in the sink's args
      // (`query(c.req.param("id"))`, `...bind(url.searchParams.get("id"))`).
      else if (n.type === "CallExpression" && TAINTED_CALL_RE.test(sliceOf(source, n))) found = true
      else if (n.type === "Identifier" && taintedLocals.has(n.name as string)) found = true
    })
    if (found) return true
  }
  return false
}

function isDataAccessCall(call: AstNode): boolean {
  const callee = call.callee as AstNode
  if (!callee) return false
  // bare `query(…)`
  const bare = idName(callee)
  if (bare && DATA_ACCESS_NAMES.has(bare.toLowerCase())) return true
  // member `db.findUnique(…)` / `repo.findById(…)` / Workers `env.DB.query(…)`
  if (callee.type === "MemberExpression" && !callee.computed) {
    const prop = idName(callee.property as AstNode)
    if (prop && DATA_ACCESS_NAMES.has(prop.toLowerCase())) return true
    // SIG-313: Cloudflare D1 prepared statement `<…>.prepare(sql).bind(id)`.
    // `bind` is a sink ONLY when its callee chain includes a `.prepare(…)` call,
    // so `fn.bind(this)` (Function.prototype.bind) never fires.
    if (prop === "bind" && calleeChainHasPrepare(callee.object as AstNode)) return true
  }
  return false
}

/** Walk a member/call callee chain for a `.prepare(…)` call (D1 sink scoping). */
function calleeChainHasPrepare(node: AstNode | undefined): boolean {
  let cur: AstNode | undefined = node
  let guard = 0
  while (cur && guard++ < 8) {
    if (cur.type === "CallExpression") {
      const c = cur.callee as AstNode
      if (c?.type === "MemberExpression" && !c.computed && idName(c.property as AstNode) === "prepare") return true
      cur = c?.object as AstNode
    } else if (cur.type === "MemberExpression") {
      cur = cur.object as AstNode
    } else break
  }
  return false
}

export const noUnauthorizedObjectLookup: AstRule = {
  id: "no-unauthorized-object-lookup",
  severity: "warning",
  roleHint: "security",
  shortDescription: "request-controlled identifier reaches a record lookup with no object-level authorization check",
  language: "both",
  nodeTypes: ["Program"],
  emitWhenUnmatched: true,
  visit(node: AstNode, ctx: RuleContext): AstRuleHit[] | null {
    if (!node || node.type !== "Program") return null
    if (SKIP_PATH.test(ctx.path)) return null

    const hits: AstRuleHit[] = []
    for (const handler of collectHandlers(node)) {
      const body = handler.body as AstNode
      if (!body) continue
      // Fail closed: any in-body principal/authz signal → this handler is
      // authz-aware (or middleware-protected and principal-scoped); skip it.
      if (handlerHasAuthzSignal(body)) continue

      const taintedLocals = collectTaintedLocals(body, ctx.source)
      for (const local of collectNextRouteParamLocals(handler)) taintedLocals.add(local)
      // Emit on the FIRST tainted record-lookup in the handler (one finding per
      // handler — the authz gap is the handler's, not each query's).
      let emitted = false
      walkNoNested(body, (n) => {
        if (emitted) return
        if (n.type !== "CallExpression") return
        if (!isDataAccessCall(n)) return
        if (!argsCarryTaint(n, taintedLocals, ctx.source)) return
        emitted = true
        hits.push({
          message:
            "A request-controlled identifier reaches a record lookup here, and no object-level authorization (ownership / membership) check is visible in this handler. Verify the caller is authorized to access this object — an attacker can substitute another object's id to read or modify it (IDOR / broken object-level authorization, CWE-639).",
          evidence: sliceEvidence(ctx.source, n),
          line: n.loc?.start?.line ?? 1,
          endLine: n.loc?.end?.line ?? n.loc?.start?.line ?? 1,
          column: n.loc?.start?.column ?? 0,
        })
      })
    }
    return hits.length > 0 ? hits : null
  },
}
