// SIG-110: no-sync-io-in-request-path — flags a SYNCHRONOUS I/O call
// (`fs.readFileSync`, `execSync`, …) directly inside a request handler.
// Sync I/O blocks the event loop, so on a hot request path it serializes
// every concurrent request behind the disk/subprocess call.
//
// Conservative scope (honor "prefer a miss", per Codex + deepseek-v4-pro
// sign-off):
//   - The sync API must be resolved through an IMPORT we can see: an
//     `fs` / `node:fs` namespace alias or named import, or a
//     `child_process` / `node:child_process` alias / named import. A bare
//     `readFileSync(…)` with no matching import is NOT flagged (could be a
//     local function of the same name).
//   - "Request path" means a recognizable handler: an Express-style route
//     registration (`app|router|*.get/post/…(…, handler)`) whose argument
//     is a function, or a Next-style exported `GET`/`POST`/… function.
//     We require a FUNCTION argument so `someMap.get(key)` is never
//     mistaken for a route.
//   - The sync call must sit in the handler body WITHOUT crossing a nested
//     function boundary — a sync call inside `setInterval(() => …)` within
//     the handler is not on the synchronous request path.
//   - Test / spec / migration / script files are skipped (not request paths).

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
// Conventional router-object identifiers. A `.get`/`.use` call is only
// treated as a route registration when its object is one of these OR its
// first argument is a string path starting with "/" — otherwise
// `cache.get("k", cb)` / `emitter.use(...)` would be mistaken for routes
// (Codex P2 false-positive fix).
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
const SYNC_FS_METHODS: ReadonlySet<string> = new Set([
  "readFileSync",
  "writeFileSync",
  "appendFileSync",
  "readdirSync",
  "statSync",
  "lstatSync",
  "existsSync",
  "mkdirSync",
  "rmSync",
  "rmdirSync",
  "unlinkSync",
  "renameSync",
  "copyFileSync",
  "accessSync",
  "realpathSync",
  "readlinkSync",
  "openSync",
  "closeSync",
  "truncateSync",
  "chmodSync",
  "chownSync",
])
const CP_SYNC_FNS: ReadonlySet<string> = new Set(["execSync", "execFileSync", "spawnSync"])
const FS_SPECIFIERS: ReadonlySet<string> = new Set(["fs", "node:fs"])
const CP_SPECIFIERS: ReadonlySet<string> = new Set(["child_process", "node:child_process"])
// Skip files that aren't request paths. Directory names match at a path
// boundary (start-of-string or after a slash) so a top-level `scripts/` or
// `tests/` is skipped, not only nested ones.
const SKIP_PATH = /(\.test\.|\.spec\.|\.config\.|(^|\/)(__tests__|tests?|migrations?|scripts?)\/)/

function sliceEvidence(source: string, node: AstNode): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return ""
  const slice = source.slice(node.start, node.end)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

function idName(n: AstNode | undefined): string | null {
  return n && n.type === "Identifier" ? (n.name as string) : null
}

interface ImportAliases {
  fsNamespaces: Set<string> // `import fs from "fs"` / `* as fs` / `const fs = require("fs")`
  fsNamed: Set<string> // `import { readFileSync } from "fs"` / destructured require
  cpNamespaces: Set<string>
  cpNamed: Set<string>
}

/** Pre-pass: collect fs / child_process import + require aliases so we only
 *  flag sync calls that resolve to a real node:fs / child_process import. */
function collectImports(program: AstNode): ImportAliases {
  const a: ImportAliases = {
    fsNamespaces: new Set(),
    fsNamed: new Set(),
    cpNamespaces: new Set(),
    cpNamed: new Set(),
  }
  const body = (program.body ?? []) as AstNode[]
  for (const stmt of body) {
    if (!stmt) continue
    // ESM: import …
    if (stmt.type === "ImportDeclaration") {
      const src = (stmt.source as AstNode)?.value
      const isFs = typeof src === "string" && FS_SPECIFIERS.has(src)
      const isCp = typeof src === "string" && CP_SPECIFIERS.has(src)
      if (!isFs && !isCp) continue
      for (const spec of (stmt.specifiers ?? []) as AstNode[]) {
        const local = idName(spec.local as AstNode)
        if (!local) continue
        if (spec.type === "ImportDefaultSpecifier" || spec.type === "ImportNamespaceSpecifier") {
          ;(isFs ? a.fsNamespaces : a.cpNamespaces).add(local)
        } else if (spec.type === "ImportSpecifier") {
          // Only track imports whose IMPORTED (canonical) name is a sync
          // method; store the LOCAL name so an alias
          // (`import { readFileSync as read }`) still matches at the call
          // site. Fixes the aliased-import miss (Codex P3).
          const imported = idName(spec.imported as AstNode) ?? local
          const syncSet = isFs ? SYNC_FS_METHODS : CP_SYNC_FNS
          if (syncSet.has(imported)) (isFs ? a.fsNamed : a.cpNamed).add(local)
        }
      }
      continue
    }
    // CJS: const fs = require("fs") / const { readFileSync } = require("child_process")
    if (stmt.type === "VariableDeclaration") {
      for (const d of (stmt.declarations ?? []) as AstNode[]) {
        const init = d.init as AstNode
        if (init?.type !== "CallExpression" || idName(init.callee as AstNode) !== "require") continue
        const arg = (init.arguments ?? [])[0] as AstNode
        const src = arg?.type === "Literal" ? arg.value : undefined
        const isFs = typeof src === "string" && FS_SPECIFIERS.has(src)
        const isCp = typeof src === "string" && CP_SPECIFIERS.has(src)
        if (!isFs && !isCp) continue
        const tgt = d.id as AstNode
        if (tgt?.type === "Identifier") {
          ;(isFs ? a.fsNamespaces : a.cpNamespaces).add(tgt.name as string)
        } else if (tgt?.type === "ObjectPattern") {
          // `const { readFileSync: read } = require("fs")` — key is the
          // imported name, value the local alias. Track only sync methods,
          // keyed by the local name.
          const syncSet = isFs ? SYNC_FS_METHODS : CP_SYNC_FNS
          for (const p of (tgt.properties ?? []) as AstNode[]) {
            const imported = idName(p.key as AstNode)
            const localName = idName(p.value as AstNode) ?? imported
            if (imported && localName && syncSet.has(imported)) (isFs ? a.fsNamed : a.cpNamed).add(localName)
          }
        }
      }
    }
  }
  return a
}

/** Is this CallExpression a synchronous fs/child_process call we can resolve? */
function isSyncIoCall(call: AstNode, a: ImportAliases): boolean {
  const callee = call.callee as AstNode
  if (!callee) return false
  // Member: `<nsAlias>.<syncMethod>(…)`
  if (callee.type === "MemberExpression" && !callee.computed) {
    const obj = idName(callee.object as AstNode)
    const prop = idName(callee.property as AstNode)
    if (!obj || !prop) return false
    if (a.fsNamespaces.has(obj) && SYNC_FS_METHODS.has(prop)) return true
    if (a.cpNamespaces.has(obj) && CP_SYNC_FNS.has(prop)) return true
    return false
  }
  // Bare: `readFileSync(…)` / `execSync(…)` from a named import. `fsNamed` /
  // `cpNamed` already hold ONLY sync-method local names (filtered at import
  // collection), so membership alone is sufficient — and works for aliases.
  const fn = idName(callee)
  if (!fn) return false
  if (a.fsNamed.has(fn)) return true
  if (a.cpNamed.has(fn)) return true
  return false
}

/** Search a handler body for sync I/O calls, WITHOUT descending
 *  into nested functions (those don't run synchronously on the request). */
function findSyncIoInBody(body: AstNode, a: ImportAliases): AstNode[] {
  const found: AstNode[] = []
  function walk(n: AstNode): void {
    if (!n || typeof n !== "object") return
    if (typeof n.type === "string" && FUNCTION_TYPES.has(n.type)) return // nested fn boundary
    if (n.type === "CallExpression" && isSyncIoCall(n, a)) {
      found.push(n)
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
  walk(body)
  return found
}

/** Is this `<obj>.<method>(…)` call route-shaped? True when the object is a
 *  conventional router identifier OR the first argument is a string literal
 *  route path (starting with "/"). Walks the object's left spine so
 *  `app.route("/x").get(handler)` still resolves to the `app` root. */
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

/** Collect request-handler function nodes: Express route callbacks +
 *  Next-style exported HTTP functions. */
function collectHandlers(program: AstNode): AstNode[] {
  const handlers: AstNode[] = []
  function walk(n: AstNode): void {
    if (!n || typeof n !== "object") return
    // Express: `<x>.get(…, handlerFn)` — property is a route method AND at
    // least one argument is a function.
    if (
      n.type === "CallExpression" &&
      (n.callee as AstNode)?.type === "MemberExpression" &&
      !(n.callee as AstNode).computed
    ) {
      const prop = idName((n.callee as AstNode).property as AstNode)
      if (prop && ROUTE_METHODS.has(prop) && isRouteShaped(n)) {
        for (const arg of (n.arguments ?? []) as AstNode[]) {
          if (arg && FUNCTION_TYPES.has(arg.type as string)) handlers.push(arg)
        }
      }
    }
    // Next-style: `export function GET(){…}` / `export const POST = () => {…}`.
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

export const noSyncIoInRequestPath: AstRule = {
  id: "no-sync-io-in-request-path",
  severity: "warning",
  roleHint: "performance",
  shortDescription: "synchronous I/O inside a request handler",
  language: "both",
  nodeTypes: ["Program"],
  visit(node: AstNode, ctx: RuleContext): AstRuleHit[] | null {
    if (!node || node.type !== "Program") return null
    if (SKIP_PATH.test(ctx.path)) return null
    const aliases = collectImports(node)
    // No fs / child_process import in scope → nothing to resolve, bail fast.
    if (
      aliases.fsNamespaces.size === 0 &&
      aliases.fsNamed.size === 0 &&
      aliases.cpNamespaces.size === 0 &&
      aliases.cpNamed.size === 0
    )
      return null

    const hits: AstNode[] = []
    for (const handler of collectHandlers(node)) {
      const body = handler.body as AstNode
      if (!body) continue
      hits.push(...findSyncIoInBody(body, aliases))
    }
    if (hits.length === 0) return null
    return hits.map((hit) => ({
      message:
        "Synchronous I/O on a request path blocks the event loop and serializes concurrent requests. Use the async API (e.g. `fs.promises.readFile`, `await execFile`) instead.",
      evidence: sliceEvidence(ctx.source, hit),
      line: hit.loc?.start?.line ?? 1,
      endLine: hit.loc?.end?.line ?? hit.loc?.start?.line ?? 1,
      column: hit.loc?.start?.column ?? 0,
    }))
  },
}
