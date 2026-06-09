// no-ssti — a DETERMINISTIC server-side template-injection floor (CWE-1336). Flags
// a request-controlled value used as the TEMPLATE SOURCE of a template engine —
// `handlebars.compile(req.query.tpl)`, `ejs.render(req.body.t, data)`,
// `nunjucks.renderString(req.params.x)`, `_.template(req.query.t)`. An attacker
// supplies template syntax (`{{constructor.constructor("…")()}}`, `<%= … %>`) and
// the engine EXECUTES it server-side → RCE / data exfiltration.
//
// WHY this exists: the security specialist catches these by reasoning, but
// NONDETERMINISTICALLY. This is the run-INVARIANT floor: an obvious
// user-controlled-template is never silently missed.
//
// FP-SAFETY (a false positive on safe templating is the worst outcome — after the
// verdict change ANY security finding posts REQUEST_CHANGES — so we fail CLOSED on
// every doubt; mirrors no-sql-injection):
//   - severity `warning` → `clampAstEmitScores` caps it at score 3 (P2/P3); this
//     rule can NEVER post a P0/P1 alone.
//   - The taint must be in the TEMPLATE argument (arg 0). The intended, SAFE use is
//     a CONSTANT template + request data passed SEPARATELY (`render(tpl, {name:
//     req.query.name})`), so the taint is in arg 1+ and this rule does NOT fire —
//     the safe path is excluded automatically.
//   - The sink receiver must be a known template ENGINE (`handlebars`/`ejs`/`pug`/
//     `nunjucks`/…) or `_`/`lodash` — `res.render(viewName, data)` (an Express view
//     NAME, not a template string) is NOT a sink. `renderString` is name-sufficient.
//   - Test / spec / config / migration / script files are skipped.

import type { AstRule, AstRuleHit, RuleContext } from "@/features/ast-rules/domain/types"
import type { AstNode } from "@/features/ast-rules/domain/walker"

const SLICE_MAX = 200
const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression",
])
const SKIP_PATH = /(\.test\.|\.spec\.|\.config\.|(^|\/)(__tests__|tests?|migrations?|scripts?)\/)/

const TAINTED_MEMBER_RE = /\b(?:req|request|ctx|context)\.(?:params|query|body)\b/
const TAINTED_CALL_RE =
  /(?:\b(?:c|ctx|context)\.req\.(?:param|query)\(|(?:req|request)\.url\b[^\n]{0,40}?\.searchParams\.get\()/
// Bare request-object aliases (`const r = req`). `c` is deliberately EXCLUDED —
// it's too generic a name to seed as a tainted root without the structural
// `c.req.query(` confirmation (which TAINTED_CALL_RE already handles). (CodeRabbit)
const REQUEST_ROOT_RE = /^(?:req|request|ctx|context)$/

// Template-engine receivers UNAMBIGUOUS enough that `.compile`/`.render` on them
// is a template-source sink. Deliberately EXCLUDES short collision-prone names
// (`eta`, `dot`, `art`, `liquid`, `swig`, `twig`) that double as ordinary
// variables — those are reached only via their name-sufficient methods below
// (FP-safety over recall; internal review).
const TEMPLATE_ENGINE_RE =
  /^(?:handlebars|hbs|ejs|pug|jade|nunjucks|mustache|liquidjs|arttemplate|hogan)$/i
// `.compile`/`.render` take a TEMPLATE SOURCE string as arg 0 (engine receiver only).
const TEMPLATE_COMPILE_METHODS: ReadonlySet<string> = new Set(["compile", "render"])
// Methods that are template-specific by NAME (fire on any receiver).
const TEMPLATE_RAW_METHODS: ReadonlySet<string> = new Set(["renderstring", "compilestring", "parseandrender"])
// Lodash/Underscore expose ONLY `.template` (no `.render`/`.compile`).
const LODASH_RE = /^(?:_|lodash|underscore)$/

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

/** Tainted locals → their init node, iterated to a FIXED POINT (alias chains,
 *  incl. a bare request-root alias `const r = req`). */
function collectTaintedLocals(root: AstNode, source: string): Map<string, AstNode> {
  const decls: Array<{ name: string; init: AstNode }> = []
  walkNoNested(root, (n) => {
    if (n.type !== "VariableDeclarator" || !n.init) return
    const init = n.init as AstNode
    const id = n.id as AstNode
    const name = idName(id)
    if (name) { decls.push({ name, init }); return }
    // Destructured binding (`const { tpl } = req.query`): each local inherits the
    // initializer's taint (CodeRabbit). `carriesTaint(init)` decides below.
    if (id.type === "ObjectPattern") {
      for (const p of (id.properties ?? []) as AstNode[]) {
        const local = idName(p.value as AstNode) ?? idName(p.key as AstNode)
        if (local) decls.push({ name: local, init })
      }
    }
  })
  const tainted = new Map<string, AstNode>()
  for (let pass = 0; pass < 8; pass++) {
    let changed = false
    for (const { name, init } of decls) {
      if (tainted.has(name)) continue
      const aliasesRoot = init.type === "Identifier" && REQUEST_ROOT_RE.test(init.name as string)
      if (aliasesRoot || carriesTaint(init, tainted, source)) { tainted.set(name, init); changed = true }
    }
    if (!changed) break
  }
  return tainted
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

/** Classify a call as a template-engine sink and return the TEMPLATE-source arg. */
function templateSink(call: AstNode): { target: AstNode } | null {
  const callee = call.callee as AstNode
  if (!callee || callee.type !== "MemberExpression" || callee.computed) return null
  const method = (idName(callee.property as AstNode) ?? "").toLowerCase()
  if (!method) return null
  const obj = idName(callee.object as AstNode)
  const isLodashTemplate = method === "template" && obj !== null && LODASH_RE.test(obj)
  const isSink =
    TEMPLATE_RAW_METHODS.has(method) ||
    isLodashTemplate ||
    (TEMPLATE_COMPILE_METHODS.has(method) && obj !== null && TEMPLATE_ENGINE_RE.test(obj))
  if (!isSink) return null
  const target = ((call.arguments ?? []) as AstNode[])[0]
  return target ? { target } : null
}

export const noSsti: AstRule = {
  id: "no-ssti",
  severity: "warning",
  roleHint: "security",
  shortDescription: "request-controlled value used as a template-engine source (template injection)",
  language: "both",
  nodeTypes: ["Program"],
  emitWhenUnmatched: true,
  visit(node: AstNode, ctx: RuleContext): AstRuleHit[] | null {
    if (!node || node.type !== "Program") return null
    if (SKIP_PATH.test(ctx.path)) return null

    const fns = collectFunctions(node)
    const fnRange = (f: AstNode): [number, number] =>
      [typeof f.start === "number" ? f.start : -1, typeof f.end === "number" ? f.end : -1]
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
        const sink = templateSink(n)
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
          // Fire when the TEMPLATE source (arg 0) is request-tainted. Template DATA
          // (arg 1+) being tainted is the safe, intended use and never fires.
          if (carriesTaint(sink.target, taintLocalsOf(taintScope), ctx.source)) {
            const start = typeof n.start === "number" ? n.start : -1
            if (start < 0 || !seen.has(start)) {
              if (start >= 0) seen.add(start)
              hits.push({
                message:
                  "A request-controlled value is used as the TEMPLATE source here. A template engine executes the template, so an attacker can inject template syntax (e.g. `{{constructor.constructor('…')()}}`) to run arbitrary code on the server (server-side template injection, CWE-1336). Keep the template a fixed string and pass user input as DATA to the engine instead of building or selecting the template from request input.",
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
