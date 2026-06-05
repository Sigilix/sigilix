// no-xxe — a DETERMINISTIC XML-external-entity floor (CWE-611). Flags an XML
// parse where external-entity / DTD resolution is EXPLICITLY enabled and the
// parsed input is request-controlled — `libxmljs.parseXml(req.body.xml, { noent:
// true })`, `parser.parseXmlString(req.query.data, { replaceEntities: true })`.
// With entities on, an attacker's `<!ENTITY xxe SYSTEM "file:///etc/passwd">`
// (or an `http://` SSRF entity) is expanded by the parser — file disclosure,
// SSRF, DoS (billion-laughs).
//
// WHY this exists: the security specialist catches these by reasoning, but
// non-deterministically. This is the run-invariant floor. In Node, XML parsers
// (libxmljs / xml2js / @xmldom) DON'T resolve external entities by default — the
// vuln requires an EXPLICIT entity-enabling option, which is exactly the
// unambiguous, low-FP signal this floor keys on.
//
// FP-SAFETY (a false positive on safe code is the worst outcome — after the
// verdict change ANY security finding posts REQUEST_CHANGES — so we fail CLOSED
// on every doubt; severity `warning` → `clampAstEmitScores` caps it at P2, never
// a P0/P1 alone):
//   - Fires ONLY when BOTH hold: an entity-enabling option (`noent`/
//     `replaceEntities`/`resolveExternalEntities`/`expandEntities`/`dtdload`/
//     `dtdvalid`) is set to a NON-falsy value, AND the parsed input is
//     request-tainted. The default-safe parse (no option) does NOT fire.
//   - `noent: false` / `replaceEntities: false` (entities explicitly DISABLED) is
//     the safe config — does NOT fire.
//   - A constant / non-request input (`parseXml("<r/>", { noent: true })`) does
//     NOT fire — only untrusted XML does.
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
const REQUEST_ROOT_RE = /^(?:c|req|request|ctx|context)$/

// Options that ENABLE external-entity / DTD resolution (the XXE switch). NOTE:
// `nonet` is deliberately EXCLUDED — `nonet: true` DISABLES network access (a
// safety flag, the opposite of an enabler).
const XXE_OPTION_RE =
  /^(?:noent|replaceentities|resolveexternalentities|expandentities|externalentities|loadexternaldtd|dtdload|dtdvalid)$/

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

/** Tainted locals → init node, to a FIXED POINT. A name declared more than once is
 *  ambiguous → never tainted; fail closed (mirrors #356). */
function collectTaintedLocals(root: AstNode, source: string): Map<string, AstNode> {
  const decls: Array<{ name: string; init: AstNode }> = []
  const counts = new Map<string, number>()
  const bump = (name: string | null): void => { if (name) counts.set(name, (counts.get(name) ?? 0) + 1) }
  walkNoNested(root, (n) => {
    if (n.type === "VariableDeclarator") {
      const name = idName(n.id as AstNode)
      bump(name)
      if (name && n.init) decls.push({ name, init: n.init as AstNode })
    } else if (n.type === "CatchClause" && n.param) {
      bump(idName(n.param as AstNode))
    }
  })
  const tainted = new Map<string, AstNode>()
  for (let pass = 0; pass < 8; pass++) {
    let changed = false
    for (const { name, init } of decls) {
      if (tainted.has(name) || (counts.get(name) ?? 0) > 1) continue
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

/** Is `v` a NON-falsy option value (so `{ noent: true }` / `{ noent: opts.x }`
 *  count, but `{ noent: false }` / `0` / `null` do NOT)? */
function isEnabled(v: AstNode | undefined): boolean {
  if (!v) return false
  if (v.type === "Literal") return v.value !== false && v.value !== 0 && v.value !== null && v.value !== ""
  if (v.type === "Identifier") return v.name !== "undefined"
  if (v.type === "UnaryExpression" && v.operator === "!") return false // `!x` — treat as disabling
  return true
}

/** Does the call carry an options object with an entity-enabling switch turned on? */
function hasEnabledEntityOption(call: AstNode): boolean {
  let found = false
  for (const arg of (call.arguments ?? []) as AstNode[]) {
    if (!arg || arg.type !== "ObjectExpression") continue
    for (const prop of (arg.properties ?? []) as AstNode[]) {
      if (found || prop.type !== "Property" || prop.computed) continue
      const key = prop.key as AstNode
      const name = key.type === "Identifier" ? (key.name as string)
        : key.type === "Literal" && typeof key.value === "string" ? key.value : null
      if (name && XXE_OPTION_RE.test(name.toLowerCase()) && isEnabled(prop.value as AstNode)) found = true
    }
  }
  return found
}

export const noXxe: AstRule = {
  id: "no-xxe",
  severity: "warning",
  roleHint: "security",
  shortDescription: "XML parsed with external entities enabled on request-controlled input",
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
      if (n.type === "CallExpression" && hasEnabledEntityOption(n)) {
        const start = typeof n.start === "number" ? n.start : -1
        let enclosing: AstNode | null = null
        for (const f of fns) {
          const [s, e] = fnRange(f)
          if (s <= start && start < e) { if (!enclosing || s >= fnRange(enclosing)[0]) enclosing = f }
        }
        const scope = enclosing ?? node
        const tainted = taintLocalsOf(scope)
        // The PARSED input is a non-options argument that carries taint.
        const args = (n.arguments ?? []) as AstNode[]
        const inputTainted = args.some((a) => a.type !== "ObjectExpression" && carriesTaint(a, tainted, ctx.source))
        if (inputTainted) {
          if (start < 0 || !seen.has(start)) {
            if (start >= 0) seen.add(start)
            hits.push({
              message:
                "Request-controlled XML is parsed with external-entity / DTD resolution explicitly ENABLED here. An attacker can embed `<!ENTITY xxe SYSTEM \"file:///etc/passwd\">` (or an `http(s)://` entity) and the parser will expand it — disclosing local files, performing SSRF, or DoS (billion-laughs) — XML External Entity injection (CWE-611). Remove the entity-enabling option (parse with entities/DTDs OFF, the safe default), or don't parse untrusted XML with external entities.",
              evidence: sliceEvidence(ctx.source, n),
              line: n.loc?.start?.line ?? 1,
              endLine: n.loc?.end?.line ?? n.loc?.start?.line ?? 1,
              column: n.loc?.start?.column ?? 0,
            })
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
