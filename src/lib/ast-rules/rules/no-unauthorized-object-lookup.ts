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

import type { AstRule, AstRuleHit, RuleContext } from "../types"
import type { AstNode } from "../walker"

const SLICE_MAX = 200
const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression",
])
const ROUTE_METHODS: ReadonlySet<string> = new Set([
  "get", "post", "put", "patch", "delete", "all", "head", "options", "use",
])
// Conventional router-object identifiers (mirrors no-sync-io-in-request-path):
// a `.get`/`.use` call is a route registration only when its object is one of
// these OR its first argument is a "/"-prefixed string literal — so
// `cache.get("k", cb)` is never mistaken for a route.
const ROUTE_OBJECT_NAMES: ReadonlySet<string> = new Set([
  "app", "router", "server", "route", "api", "apirouter", "approuter", "express",
])
const NEXT_HTTP_EXPORTS: ReadonlySet<string> = new Set([
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
])
const SKIP_PATH = /(\.test\.|\.spec\.|\.config\.|(^|\/)(__tests__|tests?|migrations?|scripts?)\/)/

// Names that read like an OBJECT HANDLE (an id / tenant key), NOT a
// pagination/search param. Shared by the request-member regex, the taint-local
// pre-pass, and the Next route-param binding.
const OBJECT_HANDLE_RE =
  /^(?:id|uuid|guid|pk|[A-Za-z]+[_]?[Ii]d|workspace|org|tenant|account|project|group)$/i
// A request-controlled OBJECT HANDLE: req|request|ctx|context.(params|query|
// body)[?.]<handle>. `context`/`ctx` cover Next `context.params.id`. The
// optional `?.` covers `req.body?.workspace`.
const TAINTED_MEMBER_RE =
  /\b(?:req|request|ctx|context)\.(?:params|query|body)\??\.(?:id|uuid|guid|pk|[A-Za-z]+[_]?[Ii]d|workspace|org|tenant|account|project|group)\b/
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
  "query", "findbyid", "findbypk", "findone", "findunique", "findfirst",
  "getbyid", "getbypk", "select", "upsert", "retrieve", "lookup", "raw",
])

function idName(n: AstNode | undefined): string | null {
  return n && n.type === "Identifier" ? (n.name as string) : null
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
  return !!first && first.type === "Literal" && typeof first.value === "string"
    && (first.value as string).startsWith("/")
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
      if (Array.isArray(v)) { for (const item of v) if (item && typeof item === "object") walk(item as AstNode) }
      else if (v && typeof v === "object") walk(v as AstNode)
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
      else if (prop && AUTHZ_TOKEN_RE.test(prop.toLowerCase())) found = true
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
    if (n.type === "CallExpression" && (n.callee as AstNode)?.type === "MemberExpression"
      && !(n.callee as AstNode).computed) {
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
    if (local && TAINTED_MEMBER_RE.test(sliceOf(source, init))) tainted.add(local)
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
  // member `db.findUnique(…)` / `repo.findById(…)`
  if (callee.type === "MemberExpression" && !callee.computed) {
    const prop = idName(callee.property as AstNode)
    if (prop && DATA_ACCESS_NAMES.has(prop.toLowerCase())) return true
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
