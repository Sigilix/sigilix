// no-prototype-pollution — a DETERMINISTIC prototype-pollution floor (CWE-1321).
// Flags a request-controlled object RECURSIVELY MERGED into a target —
// `_.merge(target, req.body)`, `deepmerge(opts, req.query)`,
// `_.defaultsDeep(settings, req.body.prefs)`. A recursive merge walks INTO a
// `__proto__` key in the untrusted input and mutates `Object.prototype` itself
// (the classic CVE shape, e.g. lodash CVE-2019-10744): every object in the
// process inherits the injected property — auth/logic bypass, DoS, sometimes RCE.
//
// WHY this exists: the security specialist catches these by reasoning, but
// non-deterministically. This is the run-invariant floor: an obvious deep-merge
// of an untrusted object is never silently missed. Sibling of the other taint
// floors; reuses the same taint machinery.
//
// FP-SAFETY (a false positive on safe code is the worst outcome — after the
// verdict change ANY security finding posts REQUEST_CHANGES — so we fail CLOSED
// on every doubt; severity `warning` → `clampAstEmitScores` caps it at P2, never
// a P0/P1 alone):
//   - ONLY a RECURSIVE merge fires — the distinctive deep-merge names
//     (`defaultsDeep`/`mergeWith`/`deepmerge`/`mergeDeep`) or `merge` on a lodash
//     receiver (`_`/`lodash`). `Object.assign` is SHALLOW (copies `__proto__` as a
//     plain own property, not a sink) → excluded. A bare `merge` on a non-lodash
//     receiver (RxJS, a custom helper) → excluded.
//   - The merged SOURCE must be a WHOLE request object (`req.body`, an alias) —
//     not a fixed object with tainted scalar fields.
//   - A dynamic property write keyed by user input (`obj[req.body.key] = v`) is
//     DELIBERATELY NOT flagged: a user-keyed plain-object write is statically
//     indistinguishable from an idiomatic dictionary/cache/accumulator write, so
//     it can't be told from a sink without a positive signal — that vector is the
//     security specialist's (model) job, not a deterministic floor's.
//   - A `__proto__` sanitization guard in the function (`delete x.__proto__`, a
//     `__proto__` mention, `Object.create(null)`) means the dev is defending → SKIP.
//   - Test / spec / config / migration / script files are skipped.

import type { AstRule, AstRuleHit, RuleContext } from "@/src/features/ast-rules/domain/types"
import type { AstNode } from "@/src/features/ast-rules/domain/walker"

const SLICE_MAX = 200
const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
])
const SKIP_PATH = /(\.test\.|\.spec\.|\.config\.|(^|\/)(__tests__|tests?|migrations?|scripts?)\/)/

const TAINTED_MEMBER_RE = /\b(?:req|request|ctx|context)\.(?:params|query|body)\b/
const TAINTED_CALL_RE =
  /(?:\b(?:c|ctx|context)\.req\.(?:param|query)\(|(?:req|request)\.url\b[^\n]{0,40}?\.searchParams\.get\()/
const REQUEST_ROOT_RE = /^(?:c|req|request|ctx|context)$/

// Recursive-merge methods — name-sufficient (distinctive; they recurse into nested
// keys, which is what walks into `__proto__`). `merge` alone is too collision-prone
// (Array/RxJS/Map), so it fires only on a lodash receiver.
const DEEP_MERGE_DISTINCTIVE: ReadonlySet<string> = new Set(["defaultsdeep", "mergewith", "deepmerge", "mergedeep"])
const LODASH_RECEIVER_RE = /^(?:_|lodash)$/
// In-body `__proto__` sanitization → the dev is defending → fail closed (skip).
const PROTO_GUARD_RE = /__proto__|Object\.create\(\s*null\s*\)/

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
      if (Array.isArray(v)) {
        for (const item of v) if (item && typeof item === "object") walk(item as AstNode)
      } else if (v && typeof v === "object") walk(v as AstNode)
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

/** Is `arg` a WHOLE request-controlled reference (a request member, accessor call,
 *  or tainted-local alias)? An object literal is NOT. */
function isWholeTaintedRef(arg: AstNode | undefined, taintedLocals: Map<string, AstNode>, source: string): boolean {
  if (!arg) return false
  if (arg.type === "MemberExpression") return TAINTED_MEMBER_RE.test(sliceOf(source, arg))
  if (arg.type === "CallExpression") return TAINTED_CALL_RE.test(sliceOf(source, arg))
  if (arg.type === "Identifier") return taintedLocals.has(arg.name as string)
  return false
}

/** Tainted locals → init node, to a FIXED POINT. A name declared more than once is
 *  ambiguous (no lexical scope here) → never tainted; fail closed (mirrors #356). */
function collectTaintedLocals(root: AstNode, source: string): Map<string, AstNode> {
  const decls: Array<{ name: string; init: AstNode }> = []
  const counts = new Map<string, number>()
  const bump = (name: string | null): void => {
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
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
      if (aliasesRoot || carriesTaint(init, tainted, source)) {
        tainted.set(name, init)
        changed = true
      }
    }
    if (!changed) break
  }
  return tainted
}

/** Does the function body contain a `__proto__` sanitization guard? */
function hasProtoGuard(body: AstNode, source: string): boolean {
  return PROTO_GUARD_RE.test(sliceOf(source, body))
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
      if (Array.isArray(v)) {
        for (const item of v) if (item && typeof item === "object") walk(item as AstNode)
      } else if (v && typeof v === "object") walk(v as AstNode)
    }
  }
  walk(program)
  return fns
}

/** A recursive-merge sink with a request-tainted source object. */
function taintedDeepMerge(n: AstNode, tainted: Map<string, AstNode>, source: string): boolean {
  if (n.type !== "CallExpression") return false
  const callee = n.callee as AstNode
  let distinctive = false
  if (callee.type === "Identifier") {
    distinctive = DEEP_MERGE_DISTINCTIVE.has((callee.name as string).toLowerCase())
  } else if (callee.type === "MemberExpression" && !callee.computed) {
    const method = (idName(callee.property as AstNode) ?? "").toLowerCase()
    const recv = idName(callee.object as AstNode)
    distinctive = DEEP_MERGE_DISTINCTIVE.has(method) || (method === "merge" && !!recv && LODASH_RECEIVER_RE.test(recv))
  }
  if (!distinctive) return false
  // The merge SOURCES are args 1+ (arg 0 is the target). A whole tainted object
  // source is the pollution vector.
  const args = (n.arguments ?? []) as AstNode[]
  return args.slice(1).some((a) => isWholeTaintedRef(a, tainted, source))
}

export const noPrototypePollution: AstRule = {
  id: "no-prototype-pollution",
  severity: "warning",
  roleHint: "security",
  shortDescription: "request-controlled object recursively merged into a target (prototype pollution)",
  language: "both",
  nodeTypes: ["Program"],
  emitWhenUnmatched: true,
  visit(node: AstNode, ctx: RuleContext): AstRuleHit[] | null {
    if (!node || node.type !== "Program") return null
    if (SKIP_PATH.test(ctx.path)) return null

    const fns = collectFunctions(node)
    const fnRange = (f: AstNode): [number, number] => [
      typeof f.start === "number" ? f.start : -1,
      typeof f.end === "number" ? f.end : -1,
    ]
    const guardCache = new Map<AstNode, boolean>()
    const isGuarded = (f: AstNode): boolean => {
      let v = guardCache.get(f)
      if (v === undefined) {
        v = hasProtoGuard((f.body as AstNode) ?? f, ctx.source)
        guardCache.set(f, v)
      }
      return v
    }
    const taintCache = new Map<AstNode, Map<string, AstNode>>()
    const taintLocalsOf = (scope: AstNode): Map<string, AstNode> => {
      let t = taintCache.get(scope)
      if (!t) {
        t = collectTaintedLocals(scope, ctx.source)
        taintCache.set(scope, t)
      }
      return t
    }

    const hits: AstRuleHit[] = []
    const seen = new Set<number>()

    function walk(n: AstNode): void {
      if (!n || typeof n !== "object") return
      if (n.type === "CallExpression") {
        const start = typeof n.start === "number" ? n.start : -1
        let enclosing: AstNode | null = null
        for (const f of fns) {
          const [s, e] = fnRange(f)
          if (s <= start && start < e) {
            if (!enclosing || s >= fnRange(enclosing)[0]) enclosing = f
          }
        }
        const scope = enclosing ?? node
        if (taintedDeepMerge(n, taintLocalsOf(scope), ctx.source) && !(enclosing && isGuarded(enclosing))) {
          if (start < 0 || !seen.has(start)) {
            if (start >= 0) seen.add(start)
            hits.push({
              message:
                "A request-controlled object is recursively merged into a target here. A deep merge walks INTO a `__proto__` key in the untrusted input and mutates `Object.prototype` itself — every object in the process then inherits the injected property (prototype pollution, CWE-1321: auth/logic bypass, denial of service, sometimes RCE). Validate the input shape, strip `__proto__`/`constructor` before merging, use a hardened/patched merge, or merge into `Object.create(null)`.",
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
        if (Array.isArray(v)) {
          for (const item of v) if (item && typeof item === "object") walk(item as AstNode)
        } else if (v && typeof v === "object") walk(v as AstNode)
      }
    }
    walk(node)

    return hits.length > 0 ? hits : null
  },
}
