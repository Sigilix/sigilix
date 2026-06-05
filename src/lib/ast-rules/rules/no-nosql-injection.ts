// no-nosql-injection — a DETERMINISTIC NoSQL-injection floor (CWE-943). Flags a
// request-controlled OBJECT handed DIRECTLY to a MongoDB query sink as the filter
// — `db.collection("u").findOne(req.body)`, `Order.deleteMany(req.body.filter)`,
// `Account.updateMany(f, …)` where `f = req.body` — or a `$where`/`$function`
// operator whose value is tainted. A raw request object reaches the query, so the
// attacker injects query operators (`{"age": {"$gt": ""}}` to bypass a filter,
// `{"$ne": null}` to bypass auth) or runs server-side JS via `$where`.
//
// WHY this exists: the security specialist catches these by reasoning, but
// non-deterministically. This is the run-invariant floor. Sibling of
// no-sql-injection; reuses the same taint machinery.
//
// FP-SAFETY (a false positive on safe query code is the worst outcome — after the
// verdict change ANY security finding posts REQUEST_CHANGES — so we fail CLOSED on
// every doubt; mirrors no-sql-injection's `nameSufficient` split):
//   - severity `warning` → `clampAstEmitScores` caps it at score 3 (P2/P3); this
//     rule can NEVER post a P0/P1 alone.
//   - The danger is the WHOLE request object reaching the filter. A fixed-shape
//     object literal with a tainted SCALAR field (`findOne({ _id: req.params.id })`)
//     is the idiomatic-safe pattern and does NOT fire — only a DIRECT tainted
//     reference as the filter (`findOne(req.body)` / a whole-object alias) does.
//   - `find`/`update`/`count`/`remove`/`distinct`/`aggregate`/`findOne` COLLIDE
//     with knex (`knex().update(req.body)` is the safe parameterized idiom),
//     Sequelize/TypeORM (`Model.count(req.query)`, `repo.find(req.query)`), arrays,
//     and lodash. These AMBIGUOUS names fire ONLY with a POSITIVE Mongo signal: a
//     `.collection("…")` native-driver receiver, a Mongoose query chain
//     (`.lean()`/`.exec()`/`.populate()`), or a tainted `$where`. The
//     Mongo-DISTINCTIVE driver names (`updateOne`/`deleteMany`/`findOneAndUpdate`/
//     `countDocuments`/…) are name-sufficient. A bare `Model.find(req.query)` with
//     no Mongo signal is a deliberate FN (a `Model` is statically indistinguishable
//     from a TypeORM/Sequelize repo) — we fail closed.
//   - lodash/underscore receivers are excluded outright; a function that sanitizes
//     (`mongoSanitize`, `sanitizeFilter`) is skipped; test/spec/config/migration/
//     script files are skipped.

import type { AstRule, AstRuleHit, RuleContext } from "../types"
import type { AstNode } from "../walker"

const SLICE_MAX = 200
const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression",
])
const SKIP_PATH = /(\.test\.|\.spec\.|\.config\.|(^|\/)(__tests__|tests?|migrations?|scripts?)\/)/

const TAINTED_MEMBER_RE = /\b(?:req|request|ctx|context)\.(?:params|query|body)\b/
const TAINTED_CALL_RE =
  /(?:\b(?:c|ctx|context)\.req\.(?:param|query)\(|(?:req|request)\.url\b[^\n]{0,40}?\.searchParams\.get\()/
const REQUEST_ROOT_RE = /^(?:c|req|request|ctx|context)$/

// Mongo-DISTINCTIVE driver methods — the name alone is a sufficient sink signal
// (these don't collide with the common safe ORM/builder/array/lodash APIs).
const MONGO_DISTINCTIVE: ReadonlySet<string> = new Set([
  "findoneandupdate", "findoneanddelete", "findoneandreplace",
  "updateone", "updatemany", "replaceone", "deleteone", "deletemany",
  "countdocuments", "estimateddocumentcount", "insertmany",
])
// AMBIGUOUS query methods — collide with knex/Sequelize/TypeORM/arrays/lodash, so
// they fire ONLY with a positive Mongo signal (`.collection(`, a Mongoose chain,
// or a tainted `$where`).
const MONGO_AMBIGUOUS: ReadonlySet<string> = new Set([
  "find", "findone", "update", "count", "remove", "distinct", "aggregate",
])
// In-memory predicate libraries — never a DB query. Excluded outright.
const NON_DB_RECEIVER_RE = /^(?:_|lodash|underscore)$/
// Native-driver collection accessor in the receiver chain — `db.collection("u")`.
const COLLECTION_CALL_RE = /\.collection\s*\(/
// Mongoose query-builder terminals (low-collision: knex/Sequelize/TypeORM use
// `.then`/`.execute`/`.getMany`, not these) — proof the chained call is Mongoose.
const MONGOOSE_TERMINAL_RE = /^(?:lean|exec|populate|cursor|orfail)$/
// Server-side-JS / expression operators — a tainted value here is the string-eval
// injection case (`{ $where: req.body.fn }`); `$where` is itself a Mongo signal.
const WHERE_OP_RE = /^\$(?:where|function|accumulator)$/
const SANITIZE_TOKEN_RE = /^(?:mongosanitize|sanitizefilter|sanitizequery|mongoescape)$/

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
function carriesTaint(node: AstNode | undefined, taintedLocals: Map<string, AstNode>, source: string): boolean {
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

/** Is `arg` the WHOLE filter being a request-controlled reference — a request
 *  member (`req.query`, `req.body.filter`), a request accessor call
 *  (`c.req.query()`), or a tainted-local alias of one? An object LITERAL is NOT
 *  (its tainted scalar fields are the safe fixed-shape path). */
function isWholeTaintedRef(arg: AstNode | undefined, taintedLocals: Map<string, AstNode>, source: string): boolean {
  if (!arg) return false
  if (arg.type === "MemberExpression") return TAINTED_MEMBER_RE.test(sliceOf(source, arg))
  if (arg.type === "CallExpression") return TAINTED_CALL_RE.test(sliceOf(source, arg))
  if (arg.type === "Identifier") return taintedLocals.has(arg.name as string)
  return false
}

/** Does `arg` (a filter) contain a `$where`/`$function`/`$accumulator` operator
 *  whose value is request-tainted (server-side-JS injection)? */
function hasTaintedWhereOp(arg: AstNode | undefined, taintedLocals: Map<string, AstNode>, source: string): boolean {
  if (!arg) return false
  let found = false
  walkNoNested(arg, (n) => {
    if (found || n.type !== "Property" || n.computed) return
    const key = n.key as AstNode
    const name = key.type === "Identifier" ? (key.name as string)
      : key.type === "Literal" && typeof key.value === "string" ? key.value : null
    if (name && WHERE_OP_RE.test(name) && carriesTaint(n.value as AstNode, taintedLocals, source)) found = true
  })
  return found
}

/** Tainted locals → their init node, iterated to a FIXED POINT (alias chains).
 *  A name declared MORE THAN ONCE in the scope is AMBIGUOUS (we have no lexical
 *  scope here, so we can't tell which binding reaches the sink) — it is never
 *  tainted, so a shadowed/redeclared binding can't merge taint across bindings
 *  (CodeRabbit #356; mirrors collectConstInits' ambiguity guard). Fail closed. */
function collectTaintedLocals(root: AstNode, source: string): Map<string, AstNode> {
  const decls: Array<{ name: string; init: AstNode }> = []
  const counts = new Map<string, number>()
  walkNoNested(root, (n) => {
    if (n.type !== "VariableDeclarator" || !n.init) return
    const name = idName(n.id as AstNode)
    if (name) { decls.push({ name, init: n.init as AstNode }); counts.set(name, (counts.get(name) ?? 0) + 1) }
  })
  const tainted = new Map<string, AstNode>()
  for (let pass = 0; pass < 8; pass++) {
    let changed = false
    for (const { name, init } of decls) {
      if (tainted.has(name) || (counts.get(name) ?? 0) > 1) continue // ambiguous shadow → skip
      const aliasesRoot = init.type === "Identifier" && REQUEST_ROOT_RE.test(init.name as string)
      if (aliasesRoot || carriesTaint(init, tainted, source)) { tainted.set(name, init); changed = true }
    }
    if (!changed) break
  }
  return tainted
}

/** Does the function body contain a NoSQL sanitization signal? */
function hasSanitizeSignal(body: AstNode): boolean {
  let found = false
  walkNoNested(body, (n) => {
    if (found) return
    if (n.type === "Identifier" && SANITIZE_TOKEN_RE.test((n.name as string).toLowerCase())) found = true
  })
  return found
}

/** Collect every function node in the program (for innermost-enclosing lookup). */
function collectFunctions(program: AstNode): AstNode[] {
  const fns: AstNode[] = []
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

/** `.start` of every `find`/`findOne` CallExpression that is the base of a
 *  Mongoose query chain (its result has `.lean()`/`.exec()`/`.populate()`/… called
 *  on it, through any intermediate builder methods). That terminal is a positive
 *  Mongoose signal, so the otherwise-ambiguous `find`/`findOne` may fire. */
function collectMongooseChainBases(program: AstNode): Set<number> {
  const bases = new Set<number>()
  function walk(n: AstNode): void {
    if (!n || typeof n !== "object") return
    if (n.type === "CallExpression") {
      const callee = n.callee as AstNode
      if (callee && callee.type === "MemberExpression" && !callee.computed) {
        const m = (idName(callee.property as AstNode) ?? "").toLowerCase()
        if (MONGOOSE_TERMINAL_RE.test(m)) {
          // Descend the receiver chain looking for the base find/findOne call.
          let node: AstNode | undefined = callee.object as AstNode
          for (let i = 0; node && i < 12; i++) {
            if (node.type === "CallExpression") {
              const c = node.callee as AstNode
              const cm = c && c.type === "MemberExpression" && !c.computed
                ? (idName(c.property as AstNode) ?? "").toLowerCase() : ""
              if ((cm === "find" || cm === "findone") && typeof node.start === "number") {
                bases.add(node.start); break
              }
              node = c && c.type === "MemberExpression" ? (c.object as AstNode) : undefined
            } else if (node.type === "MemberExpression") {
              node = node.object as AstNode
            } else break
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
  walk(program)
  return bases
}

type MongoSink = { filter: AstNode; nameSufficient: boolean }

/** Classify a call as a Mongo query sink. `nameSufficient` = a Mongo-distinctive
 *  method name (fires on a tainted ref alone). An ambiguous name additionally
 *  needs a positive Mongo signal (`.collection(` receiver — checked here — or a
 *  Mongoose chain / tainted `$where`, checked at the call site). */
function mongoSink(call: AstNode, source: string): MongoSink | null {
  const callee = call.callee as AstNode
  if (!callee || callee.type !== "MemberExpression" || callee.computed) return null
  const method = (idName(callee.property as AstNode) ?? "").toLowerCase()
  const distinctive = MONGO_DISTINCTIVE.has(method)
  if (!distinctive && !MONGO_AMBIGUOUS.has(method)) return null
  const recv = idName(callee.object as AstNode)
  if (recv && NON_DB_RECEIVER_RE.test(recv)) return null // in-memory lib, not a DB
  const filter = ((call.arguments ?? []) as AstNode[])[0]
  if (!filter) return null
  // `.collection("…")` anywhere in the receiver chain = the native-driver shape.
  const nameSufficient = distinctive || COLLECTION_CALL_RE.test(sliceOf(source, callee.object as AstNode))
  return { filter, nameSufficient }
}

export const noNosqlInjection: AstRule = {
  id: "no-nosql-injection",
  severity: "warning",
  roleHint: "security",
  shortDescription: "request-controlled object handed directly to a NoSQL query as the filter",
  language: "both",
  nodeTypes: ["Program"],
  emitWhenUnmatched: true,
  visit(node: AstNode, ctx: RuleContext): AstRuleHit[] | null {
    if (!node || node.type !== "Program") return null
    if (SKIP_PATH.test(ctx.path)) return null

    const fns = collectFunctions(node)
    const chainBases = collectMongooseChainBases(node)
    const fnRange = (f: AstNode): [number, number] =>
      [typeof f.start === "number" ? f.start : -1, typeof f.end === "number" ? f.end : -1]
    const sanitizeCache = new Map<AstNode, boolean>()
    const isSanitized = (f: AstNode): boolean => {
      let v = sanitizeCache.get(f)
      if (v === undefined) { v = hasSanitizeSignal((f.body as AstNode) ?? f); sanitizeCache.set(f, v) }
      return v
    }
    const taintCache = new Map<AstNode, Map<string, AstNode>>()
    const taintLocalsOf = (scope: AstNode): Map<string, AstNode> => {
      let t = taintCache.get(scope)
      if (!t) { t = collectTaintedLocals(scope, ctx.source); taintCache.set(scope, t) }
      return t
    }

    const hits: AstRuleHit[] = []
    const seen = new Set<number>()

    function walk(n: AstNode): void {
      if (!n || typeof n !== "object") return
      if (n.type === "CallExpression") {
        const sink = mongoSink(n, ctx.source)
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
          const tainted = taintLocalsOf(taintScope)
          const whereTaint = hasTaintedWhereOp(sink.filter, tainted, ctx.source)
          // A distinctive name, a `.collection(` receiver, or a Mongoose chain are
          // positive Mongo signals; a tainted `$where` is itself one.
          const positiveMongo = sink.nameSufficient || (callStart >= 0 && chainBases.has(callStart))
          if (
            (whereTaint || (positiveMongo && isWholeTaintedRef(sink.filter, tainted, ctx.source))) &&
            !(enclosing && isSanitized(enclosing))
          ) {
            const start = callStart
            if (start < 0 || !seen.has(start)) {
              if (start >= 0) seen.add(start)
              hits.push({
                message:
                  "A request-controlled object is passed directly to a NoSQL query as the filter here. Because the raw request object reaches the query, an attacker can inject query operators (e.g. `{\"$ne\": null}` to bypass an auth check, `{\"$gt\": \"\"}` to defeat a filter) or run server-side JavaScript via `$where` — NoSQL injection (CWE-943). Validate/cast the input to the expected scalar shape, or pull named fields explicitly instead of passing the whole request object.",
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
