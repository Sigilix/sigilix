// no-sql-injection — a DETERMINISTIC SQL-injection floor (CWE-89). Flags a
// request-controlled value concatenated/interpolated INTO a raw SQL string that
// is handed to a query executor — `db.query("SELECT * FROM u WHERE id = " +
// req.query.id)`, `` conn.query(`… ${req.params.name}`) ``,
// `prisma.$queryRawUnsafe("… " + req.body.q)`. The attacker breaks out of the
// query and runs their own SQL (dump tables, auth bypass, RCE via stacked stmts).
//
// WHY this exists: the security specialist catches these by reasoning, but
// NONDETERMINISTICALLY. This is the run-INVARIANT floor: an obvious
// tainted-string-into-query is never silently missed.
//
// FP-SAFETY (a false positive on safe query code is the worst outcome — after the
// verdict change ANY security finding posts REQUEST_CHANGES — so we fail CLOSED on
// every doubt; mirrors no-ssrf / no-path-traversal):
//   - severity `warning` → `clampAstEmitScores` caps it at score 3 (P2/P3); this
//     rule can NEVER post a P0/P1 alone.
//   - The taint must be in the SQL STRING (arg 0). A PARAMETERIZED query keeps the
//     SQL string a constant and passes the value separately
//     (`query("… WHERE id = $1", [req.query.id])`), so the taint is in arg 1+ and
//     this rule does NOT fire — the safe path is excluded automatically.
//   - A tagged-template query (`` sql`… ${id}` ``, Prisma `` $queryRaw`…` ``) is a
//     TaggedTemplateExpression, not a CallExpression, so it is never a sink — only
//     the UNSAFE string-call forms (`$queryRawUnsafe(...)`) are.
//   - A generic sink method (`query`/`run`/`execute`) fires only when the static
//     text reads like SQL (`SELECT … FROM`, `INSERT INTO`, …); a non-SQL `.run`/
//     `.query` (a DOM query, a task runner) never fires. Raw-SQL-named methods
//     (`$queryRawUnsafe`, `whereRaw`, …) are sufficient on their own.
//   - A function that escapes/sanitizes (`conn.escape(...)`, `escapeId`,
//     `sanitizeSql`) is skipped.
//   - Test / spec / config / migration / script files are skipped.

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

// Generic executor methods — fire ONLY when the static text reads like SQL.
// Deliberately NARROW: `query`/`execute`/`exec`/`prepare` are the real raw-SQL
// entry points (node-postgres, mysql2, better-sqlite3). `run`/`all`/`get`/`each`
// are EXCLUDED — they're job-runner / cache / sqlite-bind-param methods that take
// values, not SQL, and were the dominant prose-false-positive surface.
const SQL_GENERIC_METHODS: ReadonlySet<string> = new Set([
  "query", "execute", "exec", "prepare", "raw",
])
// Raw-SQL-named methods — the name alone is sufficient (Prisma unsafe, knex raw).
const SQL_RAW_METHODS: ReadonlySet<string> = new Set([
  "queryrawunsafe", "executerawunsafe", "whereraw", "havingraw", "orderbyraw", "joinraw", "groupbyraw",
])
// Does the static text read like an actual SQL STATEMENT (not prose that merely
// contains SQL keywords)? Anchored to statement start, with real structure: a
// table identifier after FROM/INTO, and `UPDATE <t> SET <c> =`. This rejects
// "Please UPDATE your profile and SET …" / "SELECT a plan FROM the menu".
const SQL_SHAPE_RE =
  /^\s*(?:SELECT\b[\s\S]{0,400}?\bFROM\s+["'`\[(]?\w|(?:INSERT|REPLACE)\s+INTO\s+["'`\[]?\w|UPDATE\s+\S+\s+SET\s+\S+\s*=|DELETE\s+FROM\s+["'`\[]?\w|(?:DROP|ALTER|TRUNCATE|CREATE)\s+(?:TABLE|DATABASE|INDEX|VIEW)\b)/i
// SQL escaping / sanitization signals — an in-body reference fails closed (skip).
const SQL_ESCAPE_TOKEN_RE = /^(?:escape|escapeid|escapeliteral|quoteident|quote|sanitizesql|escapesql|mysqlescape)$/
const STATIC_RESOLVE_DEPTH = 4

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

/** Tainted locals → their init node, iterated to a FIXED POINT (alias chains). */
function collectTaintedLocals(root: AstNode, source: string): Map<string, AstNode> {
  const decls: Array<{ name: string; init: AstNode }> = []
  walkNoNested(root, (n) => {
    if (n.type !== "VariableDeclarator" || !n.init) return
    const name = idName(n.id as AstNode)
    if (name) decls.push({ name, init: n.init as AstNode })
  })
  const tainted = new Map<string, AstNode>()
  for (let pass = 0; pass < 8; pass++) {
    let changed = false
    for (const { name, init } of decls) {
      if (tainted.has(name)) continue
      if (carriesTaint(init, tainted, source)) { tainted.set(name, init); changed = true }
    }
    if (!changed) break
  }
  return tainted
}

/** Program-wide `const NAME = <init>` map for static text resolution. */
function collectConstInits(program: AstNode): Map<string, AstNode> {
  const consts = new Map<string, AstNode>()
  function walk(n: AstNode): void {
    if (!n || typeof n !== "object") return
    if (n.type === "VariableDeclaration" && n.kind === "const") {
      for (const d of (n.declarations ?? []) as AstNode[]) {
        const name = idName(d.id as AstNode)
        if (name && d.init && !consts.has(name)) consts.set(name, d.init as AstNode)
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
  return consts
}

/** The concatenated STATIC text of a SQL expression — every literal / resolvable
 *  identifier part, ignoring the dynamic (tainted) parts. `"SELECT … " + id`
 *  yields `"SELECT … "`; `` `… ${x}` `` yields the quasis. */
function staticText(node: AstNode | undefined, defs: Map<string, AstNode>, depth: number): string {
  if (!node || depth > STATIC_RESOLVE_DEPTH) return ""
  if (node.type === "Literal") return typeof node.value === "string" ? node.value : ""
  if (node.type === "TemplateLiteral") {
    const quasis = (node.quasis ?? []) as Array<AstNode & { value?: { cooked?: string; raw?: string } }>
    return quasis.map((q) => q.value?.cooked ?? q.value?.raw ?? "").join(" ")
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return staticText(node.left as AstNode, defs, depth + 1) + staticText(node.right as AstNode, defs, depth + 1)
  }
  if (node.type === "Identifier") {
    const init = defs.get(node.name as string)
    return init ? staticText(init, defs, depth + 1) : ""
  }
  return ""
}

/** Does the function body contain a SQL escaping / sanitization signal? */
function hasEscapeSignal(body: AstNode): boolean {
  let found = false
  walkNoNested(body, (n) => {
    if (found) return
    if (n.type === "Identifier" && SQL_ESCAPE_TOKEN_RE.test((n.name as string).toLowerCase())) found = true
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

type SqlSink = { target: AstNode; nameSufficient: boolean }

/** Classify a call as a SQL query sink and return the query-string argument. */
function sqlSink(call: AstNode): SqlSink | null {
  const callee = call.callee as AstNode
  if (!callee || callee.type !== "MemberExpression" || callee.computed) return null
  // Strip a leading `$` so Prisma's `$queryRawUnsafe`/`$executeRawUnsafe` match.
  const method = (idName(callee.property as AstNode) ?? "").toLowerCase().replace(/^\$/, "")
  if (!method) return null
  const nameSufficient = SQL_RAW_METHODS.has(method)
  if (!nameSufficient && !SQL_GENERIC_METHODS.has(method)) return null
  const target = ((call.arguments ?? []) as AstNode[])[0]
  return target ? { target, nameSufficient } : null
}

export const noSqlInjection: AstRule = {
  id: "no-sql-injection",
  severity: "warning",
  roleHint: "security",
  shortDescription: "request-controlled value concatenated into a raw SQL query string",
  language: "both",
  nodeTypes: ["Program"],
  emitWhenUnmatched: true,
  visit(node: AstNode, ctx: RuleContext): AstRuleHit[] | null {
    if (!node || node.type !== "Program") return null
    if (SKIP_PATH.test(ctx.path)) return null

    const fns = collectFunctions(node)
    const consts = collectConstInits(node)
    const fnRange = (f: AstNode): [number, number] =>
      [typeof f.start === "number" ? f.start : -1, typeof f.end === "number" ? f.end : -1]
    const escapeCache = new Map<AstNode, boolean>()
    const isEscaped = (f: AstNode): boolean => {
      let v = escapeCache.get(f)
      if (v === undefined) { v = hasEscapeSignal((f.body as AstNode) ?? f); escapeCache.set(f, v) }
      return v
    }
    // Per-scope tainted locals + a combined def map (consts ∪ tainted-local inits)
    // for resolving the static SQL text through a local.
    const taintCache = new Map<AstNode, Map<string, AstNode>>()
    const defsCache = new Map<AstNode, Map<string, AstNode>>()
    const taintLocalsOf = (scope: AstNode): Map<string, AstNode> => {
      let t = taintCache.get(scope)
      if (!t) { t = collectTaintedLocals(scope, ctx.source); taintCache.set(scope, t) }
      return t
    }
    const defsOf = (scope: AstNode): Map<string, AstNode> => {
      let d = defsCache.get(scope)
      if (!d) { d = new Map(consts); for (const [k, v] of taintLocalsOf(scope)) d.set(k, v); defsCache.set(scope, d) }
      return d
    }

    const hits: AstRuleHit[] = []
    const seen = new Set<number>()

    function walk(n: AstNode): void {
      if (!n || typeof n !== "object") return
      if (n.type === "CallExpression") {
        const sink = sqlSink(n)
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
          // Fire when the SQL string (arg 0) is request-tainted, the call reads as
          // SQL (or is a raw-SQL-named sink), and the function does not escape.
          if (
            carriesTaint(sink.target, taintLocalsOf(taintScope), ctx.source) &&
            (sink.nameSufficient || SQL_SHAPE_RE.test(staticText(sink.target, defsOf(taintScope), 0))) &&
            !(enclosing && isEscaped(enclosing))
          ) {
            const start = typeof n.start === "number" ? n.start : -1
            if (start < 0 || !seen.has(start)) {
              if (start >= 0) seen.add(start)
              hits.push({
                message:
                  "A request-controlled value is concatenated into a raw SQL string here. An attacker can break out of the intended query and execute their own SQL — dumping or modifying data, bypassing authentication, or worse (SQL injection, CWE-89). Use a parameterized query (bind placeholders like `$1`/`?` with the value passed separately) instead of building the SQL by string concatenation.",
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
