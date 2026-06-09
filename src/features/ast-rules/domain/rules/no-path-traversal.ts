// no-path-traversal — a DETERMINISTIC path-traversal floor (CWE-22). Flags a
// request-controlled value flowing into a filesystem path operation inside a
// function with NO visible path sanitization. `fs.readFile(req.query.file)`,
// `fs.readFileSync("./uploads/" + req.params.name)`, `res.sendFile(req.query.p)`,
// `fs.readFile(path.join(BASE, req.query.name))` — an attacker supplies `../../`
// (or an absolute path) to escape the intended directory and read/write/delete
// arbitrary files.
//
// WHY this exists: the security specialist catches these by reasoning, but
// NONDETERMINISTICALLY. This is the run-INVARIANT floor: an obvious
// fs-op-on-user-input is never silently missed.
//
// FP-SAFETY (a false positive on safe fs code is the worst outcome — after the
// verdict change ANY security finding posts REQUEST_CHANGES — so we fail CLOSED on
// every doubt; mirrors no-ssrf / no-open-redirect):
//   - severity `warning` → `clampAstEmitScores` caps it at score 3 (P2/P3); this
//     rule can NEVER post a P0/P1 alone.
//   - A function is SKIPPED the moment a path-sanitization signal appears in its
//     body — `path.basename(...)` (the canonical defense), a within-root check
//     (`resolved.startsWith(base)`), a `..` rejection, or a named validator.
//   - The path argument must be request-controlled (taint flows transparently
//     through `path.join`/`path.resolve` — the sink is the fs op). UNLIKE SSRF
//     there is NO fixed-prefix exemption: `"./uploads/" + req.query.x` is still
//     vulnerable because the tainted tail can be `../../etc/passwd`.
//   - `res.sendFile`/`res.download` with a `{ root }` option are skipped (Express
//     confines the path to root and rejects escaping `..`).
//   - Test / spec / config / migration / script files are skipped.

import type { AstRule, AstRuleHit, RuleContext } from "@/features/ast-rules/domain/types"
import type { AstNode } from "@/features/ast-rules/domain/walker"

const SLICE_MAX = 200
const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression",
])
const SKIP_PATH = /(\.test\.|\.spec\.|\.config\.|(^|\/)(__tests__|tests?|migrations?|scripts?)\/)/

// Request-controlled value — any request input can carry a `../` payload.
const TAINTED_MEMBER_RE = /\b(?:req|request|ctx|context)\.(?:params|query|body)\b/
const TAINTED_CALL_RE =
  /(?:\b(?:c|ctx|context)\.req\.(?:param|query)\(|(?:req|request)\.url\b[^\n]{0,40}?\.searchParams\.get\()/

// Node `fs` / `fs.promises` path operations whose FIRST argument is a path.
const FS_PATH_METHODS: ReadonlySet<string> = new Set([
  "readfile", "readfilesync", "writefile", "writefilesync", "appendfile", "appendfilesync",
  "readdir", "readdirsync", "unlink", "unlinksync", "createreadstream", "createwritestream",
  "open", "opensync", "stat", "statsync", "lstat", "lstatsync", "access", "accesssync",
  "rm", "rmsync", "rmdir", "rmdirsync", "copyfile", "copyfilesync", "truncate", "truncatesync",
  "realpath", "realpathsync", "readlink", "readlinksync",
])
// Deno filesystem reads/writes (first arg is a path).
const DENO_PATH_METHODS: ReadonlySet<string> = new Set([
  "readfile", "readtextfile", "writefile", "writetextfile", "open", "create",
  "readdir", "stat", "lstat", "remove", "truncate",
])
// Express response file senders (first arg is a path).
const EXPRESS_SEND_METHODS: ReadonlySet<string> = new Set(["sendfile", "download"])
// Module specifiers that resolve to the node `fs` module.
const FS_SPECIFIERS: ReadonlySet<string> = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"])
// An Express handler's request parameter — corroborates that `res.sendFile`/
// `res.download` is an Express Response, not an arbitrary object named `res`.
const REQUEST_PARAM_RE = /^(?:req|request|ctx|context)$/
// Path-sanitization tokens — an in-body reference means "this handler sanitizes
// the path", so we fail closed (skip).
const PATH_VALIDATION_TOKEN_RE =
  /^(?:basename|issafepath|safepath|sanitizepath|sanitizefilename|sanitizefilepath|iswithinroot|withinroot|withinbase|ispathinside|pathisinside|isinsidedir|issafefilename|isallowedpath|allowedpath|validatepath|resolvewithin|safejoin|securejoin|saferesolve|assertinside|preventtraversal|nopathtraversal)$/

function idName(n: AstNode | undefined): string | null {
  return n && n.type === "Identifier" ? (n.name as string) : null
}

function sliceOf(source: string, node: AstNode | undefined): string {
  if (!node || typeof node.start !== "number" || typeof node.end !== "number") return ""
  return source.slice(node.start, node.end)
}

/** The node's source text, truncated to `SLICE_MAX` for the finding evidence. */
function sliceEvidence(source: string, node: AstNode): string {
  const slice = sliceOf(source, node)
  return slice.length > SLICE_MAX ? slice.slice(0, SLICE_MAX) + "…" : slice
}

/** Walk a subtree WITHOUT descending into nested functions, invoking `fn`. */
function walkNoNested(root: AstNode, fn: (n: AstNode) => void): void {
  function walk(n: AstNode): void {
    if (!n || typeof n !== "object") return
    if (typeof n.type === "string" && FUNCTION_TYPES.has(n.type) && n !== root) return
    fn(n)
    for (const k of Object.keys(n)) {
      if (k === "type" || k === "loc" || k === "start" || k === "end") continue
      const v = (n as Record<string, unknown>)[k]
      if (Array.isArray(v)) { for (const item of v) if (item && typeof item === "object") walk(item as AstNode) }
      else if (v && typeof v === "object") walk(v as AstNode)
    }
  }
  walk(root)
}

/** Does this node's subtree carry taint — a request member/call or a tainted
 *  local — without crossing into a nested function? */
function carriesTaint(node: AstNode | undefined, taintedLocals: Set<string>, source: string): boolean {
  if (!node) return false
  let found = false
  walkNoNested(node, (n) => {
    if (found) return
    if (n.type === "MemberExpression" && TAINTED_MEMBER_RE.test(sliceOf(source, n))) found = true
    else if (n.type === "CallExpression" && TAINTED_CALL_RE.test(sliceOf(source, n))) found = true
    else if (n.type === "Identifier" && taintedLocals.has(n.name as string)) found = true
  })
  return found
}

/** Tainted locals, iterated to a FIXED POINT so a shallow alias of a tainted
 *  local is also tracked (`const a = req.query.x; const b = a; fs.readFile(b)`). */
function collectTaintedLocals(root: AstNode, source: string): Set<string> {
  const decls: Array<{ name: string; init: AstNode }> = []
  walkNoNested(root, (n) => {
    if (n.type !== "VariableDeclarator" || !n.init) return
    const name = idName(n.id as AstNode)
    if (name) decls.push({ name, init: n.init as AstNode })
  })
  const tainted = new Set<string>()
  for (let pass = 0; pass < 8; pass++) {
    let changed = false
    for (const { name, init } of decls) {
      if (tainted.has(name)) continue
      if (carriesTaint(init, tainted, source)) { tainted.add(name); changed = true }
    }
    if (!changed) break
  }
  return tainted
}

type FsImports = { namespaces: Set<string>; named: Set<string> }

/** Is `name` a node fs path-operation method (case-insensitive)? */
function isFsPathMethodName(name: string): boolean {
  return FS_PATH_METHODS.has(name.toLowerCase())
}

/** Resolve the file's `fs` imports so a sink fires ONLY on a binding that
 *  actually came from node `fs` — not an identically-named export from another
 *  library (`import { createReadStream } from "fast-csv"`) or a user variable
 *  named `fs`. `namespaces` = locals bound to the module / its `.promises`;
 *  `named` = locals bound to an fs PATH method by name. (Mirrors
 *  no-sync-io-in-request-path's import resolution.) */
function collectFsImports(program: AstNode): FsImports {
  const namespaces = new Set<string>()
  const named = new Set<string>()
  const addNamed = (imported: string, local: string): void => {
    if (imported.toLowerCase() === "promises") namespaces.add(local)
    else if (isFsPathMethodName(imported)) named.add(local)
  }
  for (const stmt of (program.body ?? []) as AstNode[]) {
    if (!stmt) continue
    if (stmt.type === "ImportDeclaration") {
      const src = (stmt.source as AstNode)?.value
      if (typeof src !== "string" || !FS_SPECIFIERS.has(src)) continue
      for (const spec of (stmt.specifiers ?? []) as AstNode[]) {
        const local = idName(spec.local as AstNode)
        if (!local) continue
        if (spec.type === "ImportDefaultSpecifier" || spec.type === "ImportNamespaceSpecifier") namespaces.add(local)
        else if (spec.type === "ImportSpecifier") addNamed(idName(spec.imported as AstNode) ?? local, local)
      }
    } else if (stmt.type === "VariableDeclaration") {
      for (const d of (stmt.declarations ?? []) as AstNode[]) {
        const init = d.init as AstNode
        if (init?.type !== "CallExpression" || idName(init.callee as AstNode) !== "require") continue
        const arg = ((init.arguments ?? []) as AstNode[])[0]
        const src = arg?.type === "Literal" ? arg.value : undefined
        if (typeof src !== "string" || !FS_SPECIFIERS.has(src)) continue
        const tgt = d.id as AstNode
        if (tgt?.type === "Identifier") namespaces.add(tgt.name as string)
        else if (tgt?.type === "ObjectPattern") {
          for (const p of (tgt.properties ?? []) as AstNode[]) {
            const imported = idName(p.key as AstNode)
            const localName = idName(p.value as AstNode) ?? imported
            if (imported && localName) addNamed(imported, localName)
          }
        }
      }
    }
  }
  return { namespaces, named }
}

/** Is the callee object an fs-module binding — a namespace local, or its
 *  `.promises` member (`fs.promises.readFile`)? */
function objIsFs(obj: AstNode | undefined, namespaces: Set<string>): boolean {
  if (!obj) return false
  if (obj.type === "Identifier") return namespaces.has(obj.name as string)
  if (obj.type === "MemberExpression" && !obj.computed) {
    const base = idName(obj.object as AstNode)
    return (idName(obj.property as AstNode) ?? "").toLowerCase() === "promises" && base !== null && namespaces.has(base)
  }
  return false
}

/** Does this function have an Express request parameter (`req`/`request`/`ctx`)? */
function hasRequestParam(fn: AstNode): boolean {
  for (const p of (fn.params ?? []) as AstNode[]) {
    if (p && p.type === "Identifier" && REQUEST_PARAM_RE.test(p.name as string)) return true
  }
  return false
}

/** The `root` value node of an Express `sendFile`/`download` options object, or
 *  undefined. `res.sendFile(p, { root: BASE })` confines within `root` — but only
 *  when `root` itself is NOT attacker-controlled (CodeRabbit #350), so the caller
 *  must verify the value is untainted. */
function rootOptionValue(arg: AstNode | undefined): AstNode | undefined {
  if (!arg || arg.type !== "ObjectExpression") return undefined
  for (const prop of (arg.properties ?? []) as AstNode[]) {
    if (prop.type === "Property" && !prop.computed && (idName(prop.key as AstNode) ?? "").toLowerCase() === "root") {
      return prop.value as AstNode
    }
  }
  return undefined
}

/** Classify a call as a filesystem path sink and return the path argument, or
 *  null when it's not a sink / is confined to a root. `requiresHandlerShape` =
 *  the caller must additionally confirm an Express handler (for `res.sendFile`). */
function pathSink(call: AstNode, fsImports: FsImports, source: string): { target: AstNode; requiresHandlerShape: boolean } | null {
  const callee = call.callee as AstNode
  if (!callee) return null
  const args = (call.arguments ?? []) as AstNode[]
  let isSink = false
  let sendFile = false
  if (callee.type === "Identifier") {
    // Bare callee fires only if the name was imported FROM fs (import-resolved).
    if (fsImports.named.has(callee.name as string)) isSink = true
  } else if (callee.type === "MemberExpression" && !callee.computed) {
    const method = (idName(callee.property as AstNode) ?? "").toLowerCase()
    const obj = callee.object as AstNode
    const objId = idName(obj)
    if (objIsFs(obj, fsImports.namespaces) && FS_PATH_METHODS.has(method)) isSink = true
    else if (objId === "Deno" && DENO_PATH_METHODS.has(method)) isSink = true
    else if ((objId ?? "").toLowerCase() === "res" && EXPRESS_SEND_METHODS.has(method)) { isSink = true; sendFile = true }
  }
  if (!isSink) return null
  // `res.sendFile(p, { root })` confines to root — but ONLY when `root` is not
  // itself request-controlled (an attacker-chosen root is no boundary).
  if (sendFile) {
    const root = rootOptionValue(args[1]) ?? rootOptionValue(args[2])
    if (root && !(TAINTED_MEMBER_RE.test(sliceOf(source, root)) || TAINTED_CALL_RE.test(sliceOf(source, root)))) return null
  }
  const target = args[0]
  return target ? { target, requiresHandlerShape: sendFile } : null
}

/** Does any argument target a `..` traversal marker — covering a string literal
 *  (`".."`) and a regex (`/\.\./g`)? Backslashes are stripped first so the
 *  escaped regex form `\.\.` is recognized as `..`. */
function argsTargetDotDot(args: readonly AstNode[], source: string): boolean {
  return args.some((a) => sliceOf(source, a).replace(/\\/g, "").includes(".."))
}

/** Does the function body show a path-sanitization signal? */
function hasSanitization(body: AstNode, source: string): boolean {
  let found = false
  walkNoNested(body, (n) => {
    if (found) return
    if (n.type === "Identifier") {
      // `path.basename(x)`, `sanitizePath(x)`, … — basename is the canonical defense.
      if (PATH_VALIDATION_TOKEN_RE.test((n.name as string).toLowerCase())) found = true
    } else if (n.type === "CallExpression") {
      const callee = n.callee as AstNode
      if (callee?.type === "MemberExpression" && !callee.computed) {
        const m = (idName(callee.property as AstNode) ?? "").toLowerCase()
        const args = (n.arguments ?? []) as AstNode[]
        // `resolved.startsWith(baseDir)` is the canonical within-root boundary check.
        if (m === "startswith") found = true
        // `p.includes("..")` / `p.indexOf("..")` / `p.replace(/\.\./g, "")` — an
        // explicit traversal rejection or stripper.
        else if ((m === "includes" || m === "indexof" || m === "replace") && argsTargetDotDot(args, source)) found = true
      }
    }
  })
  return found
}

/** Collect every function node in the program (for innermost-enclosing lookup). */
function collectFunctions(program: AstNode): AstNode[] {
  const fns: AstNode[] = []
  /** Recurse into `n`, pushing any function node onto `fns`. */
  function walk(n: AstNode): void {
    if (!n || typeof n !== "object") return
    if (typeof n.type === "string" && FUNCTION_TYPES.has(n.type)) fns.push(n)
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

export const noPathTraversal: AstRule = {
  id: "no-path-traversal",
  severity: "warning",
  roleHint: "security",
  shortDescription: "request-controlled value reaches a filesystem path op with no path sanitization",
  language: "both",
  nodeTypes: ["Program"],
  emitWhenUnmatched: true,
  visit(node: AstNode, ctx: RuleContext): AstRuleHit[] | null {
    if (!node || node.type !== "Program") return null
    if (SKIP_PATH.test(ctx.path)) return null

    const fns = collectFunctions(node)
    const fsImports = collectFsImports(node)
    const fnRange = (f: AstNode): [number, number] =>
      [typeof f.start === "number" ? f.start : -1, typeof f.end === "number" ? f.end : -1]
    const sanitizedCache = new Map<AstNode, boolean>()
    const isSanitized = (f: AstNode): boolean => {
      let v = sanitizedCache.get(f)
      if (v === undefined) { v = hasSanitization((f.body as AstNode) ?? f, ctx.source); sanitizedCache.set(f, v) }
      return v
    }
    const taintCache = new Map<AstNode, Set<string>>()
    const taintLocalsOf = (scope: AstNode): Set<string> => {
      let t = taintCache.get(scope)
      if (!t) { t = collectTaintedLocals(scope, ctx.source); taintCache.set(scope, t) }
      return t
    }

    const hits: AstRuleHit[] = []
    const seen = new Set<number>()

    function walk(n: AstNode): void {
      if (!n || typeof n !== "object") return
      if (n.type === "CallExpression") {
        const sink = pathSink(n, fsImports, ctx.source)
        if (sink) {
          const callStart = typeof n.start === "number" ? n.start : -1
          let enclosing: AstNode | null = null
          for (const f of fns) {
            const [s, e] = fnRange(f)
            if (s <= callStart && callStart < e) {
              if (!enclosing || s >= fnRange(enclosing)[0]) enclosing = f
            }
          }
          const taintScope = enclosing ?? node
          // `res.sendFile`/`res.download` only count inside an Express handler
          // (a req-shaped param) — `res` is otherwise too generic a name.
          const handlerOk = !sink.requiresHandlerShape || (enclosing !== null && hasRequestParam(enclosing))
          // Fire when the path is request-tainted and the function shows no
          // sanitization signal. No fixed-prefix exemption — `../` escapes a base.
          if (
            handlerOk &&
            carriesTaint(sink.target, taintLocalsOf(taintScope), ctx.source) &&
            !(enclosing && isSanitized(enclosing))
          ) {
            const start = typeof n.start === "number" ? n.start : -1
            if (start < 0 || !seen.has(start)) {
              if (start >= 0) seen.add(start)
              hits.push({
                message:
                  "A request-controlled value reaches a filesystem path here with no visible sanitization. An attacker can supply `../../` (or an absolute path) to escape the intended directory and read, overwrite, or delete arbitrary files (path traversal, CWE-22). Reduce the input to a single path segment with `path.basename(...)`, or resolve it and verify the result stays within the intended base directory before the filesystem call.",
                evidence: sliceEvidence(ctx.source, n),
                line: n.loc?.start?.line ?? 1,
                endLine: n.loc?.end?.line ?? n.loc?.start?.line ?? 1,
                column: n.loc?.start?.column ?? 0,
              })
            }
          }
        }
      }
      for (const k of Object.keys(n)) {
        if (k === "type" || k === "loc" || k === "start" || k === "end") continue
        const v = (n as Record<string, unknown>)[k]
        if (Array.isArray(v)) { for (const item of v) if (item && typeof item === "object") walk(item as AstNode) }
        else if (v && typeof v === "object") walk(v as AstNode)
      }
    }
    walk(node)

    return hits.length > 0 ? hits : null
  },
}
