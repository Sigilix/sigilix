// no-open-redirect — a DETERMINISTIC open-redirect floor (CWE-601). Flags a
// request-controlled value flowing into a redirect / `Location`-header sink
// inside a function that contains NO visible redirect-target validation.
// `res.redirect(req.query.url)`, `Response.redirect(new URL(request.url)
// .searchParams.get("next"))`, `c.redirect(c.req.query("returnTo"))` — an
// attacker picks the destination and phishes through your domain's trust.
//
// WHY this exists: the security specialist catches these by reasoning, but
// NONDETERMINISTICALLY. This is the run-INVARIANT floor: an obvious
// redirect-to-user-input is never silently missed.
//
// FP-SAFETY (a P0/P1 false positive on safe redirect code is the worst outcome,
// so we fail CLOSED on every doubt; mirrors no-unauthorized-object-lookup):
//   - severity `warning` → the deterministic-emit synth path caps it at score 3
//     (P2/P3) via `clampAstEmitScores`; this rule can NEVER post a P0/P1 alone.
//   - A function is SKIPPED the moment ANY redirect-validation signal appears in
//     its body (`startsWith`, an allow/white-list, `isSafeRedirect`,
//     `validateRedirect`, a `new URL(...).origin`/`.host` host check, …) — the
//     in-body validation reference is our proxy for "this redirect is checked".
//   - The redirect TARGET must be request-controlled — the sink's argument
//     carries `req|request|ctx.params/query/body`, a Hono `c.req.param/query()`,
//     or a Workers `searchParams.get()`. A constant/literal target never fires.
//   - The sink set is curated to the unambiguous redirect verb (`redirect`) plus
//     `Location`-header writes. `.setHeader`/`.header("Location", …)` fire on any
//     receiver; the generic `.set`/`.append("location", …)` fire ONLY on a
//     headers-like receiver (so `map.set`/`cache.append`/`searchParams.set` don't
//     trip it). A non-`Location` key never fires.
//   - Test / spec / migration / script files are skipped (not request paths).

import type { AstRule, AstRuleHit, RuleContext } from "../types"
import type { AstNode } from "../walker"

const SLICE_MAX = 200
const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression",
])
const SKIP_PATH = /(\.test\.|\.spec\.|\.config\.|(^|\/)(__tests__|tests?|migrations?|scripts?)\/)/

// A request-controlled value (member access) — ANY request input is a dangerous
// redirect target (unlike IDOR, the param need not read like an object handle).
const TAINTED_MEMBER_RE = /\b(?:req|request|ctx|context)\.(?:params|query|body)\b/
// Call-based request input: Hono `c.req.param/query(...)`, Workers
// `new URL(request.url).searchParams.get(...)` (anchored to a request URL).
const TAINTED_CALL_RE =
  /(?:\b(?:c|ctx|context)\.req\.(?:param|query)\(|(?:req|request)\.url\b[\s\S]{0,40}?\.searchParams\.get\()/
// Redirect-target validation tokens — an in-body reference means "this handler
// checks the destination", so we fail closed (skip). Matched against AST
// identifiers, member property names, and call callee names (not raw source).
const VALIDATION_TOKEN_RE =
  /^(?:startswith|allowlist|allowlisted|allowedhosts?|allowedorigins?|whitelist|whitelisted|issaferedirect|saferedirect|isvalidredirect|validateredirect|sanitizeredirect|isallowedredirect|isinternalurl|islocalurl|isrelativeurl|sameorigin)$/
// Redirect sinks (the verb form). `<obj>.redirect(...)`, `Response.redirect(...)`,
// `c.redirect(...)`. NOTE: `location` is deliberately excluded — `res.location()`
// only sets a header (no redirect on its own) and `map.location()` etc. would FP.
const REDIRECT_VERBS: ReadonlySet<string> = new Set(["redirect"])
// `Location`-header writers usable on ANY receiver (unambiguous header API). The
// SECOND arg carries the target when the first is the literal "location".
const HEADER_WRITER_METHODS: ReadonlySet<string> = new Set(["setheader", "header"])
// `.set`/`.append("location", …)` ALSO write a Location header — but only on a
// real Headers object. On a Map / URLSearchParams / cache they're unrelated, so
// these fire ONLY when the receiver is a member ending in `.headers`
// (`res.headers.set`) or a local DECLARED `new Headers()` — never a bare
// identifier that merely happens to be named `headers` (could be a Map).
const HEADERS_RECEIVER_METHODS: ReadonlySet<string> = new Set(["set", "append"])
// A literal redirect target that begins with `/<non-slash, non-backslash>` can
// only resolve same-origin (`/dashboard/…`), so a request value concatenated
// AFTER such a prefix is NOT an open redirect. A bare `/`, `//`, or `/\` is
// excluded — those let the tainted tail become protocol-relative (`//evil.com`).
const SAFE_ORIGIN_PREFIX_RE = /^\/[^/\\]/

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

/** Does a slice carry a request-controlled value (member OR call source)? */
function sliceIsTainted(slice: string): boolean {
  return TAINTED_MEMBER_RE.test(slice) || TAINTED_CALL_RE.test(slice)
}

/** Locals whose initializer carries request taint, so it flows through
 *  `const next = req.query.next` / `const url = c.req.query("returnTo")`. */
function collectTaintedLocals(root: AstNode, source: string): Set<string> {
  const tainted = new Set<string>()
  walkNoNested(root, (n) => {
    if (n.type !== "VariableDeclarator" || !n.init) return
    const local = idName(n.id as AstNode)
    if (local && sliceIsTainted(sliceOf(source, n.init as AstNode))) tainted.add(local)
  })
  return tainted
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

/** Locals DECLARED `const h = new Headers(...)` in scope — the only bare
 *  identifiers we trust as a Headers instance (a Map/object named `headers` is
 *  NOT a Headers, so `map.set("location", x)` must not be read as a header write). */
function collectHeadersLocals(root: AstNode): Set<string> {
  const headers = new Set<string>()
  walkNoNested(root, (n) => {
    if (n.type !== "VariableDeclarator" || !n.init) return
    const init = n.init as AstNode
    if (init.type === "NewExpression" && idName(init.callee as AstNode) === "Headers") {
      const local = idName(n.id as AstNode)
      if (local) headers.add(local)
    }
  })
  return headers
}

/** Is `obj` a Headers instance? A member ending in `.headers` (`res.headers`,
 *  `response.headers`), or a local declared `new Headers()` (`headersLocals`). */
function isHeadersReceiver(obj: AstNode | undefined, headersLocals: Set<string>): boolean {
  if (!obj) return false
  if (obj.type === "Identifier") return headersLocals.has(obj.name as string)
  if (obj.type === "MemberExpression" && !obj.computed) {
    const prop = idName(obj.property as AstNode)
    return prop !== null && prop.toLowerCase() === "headers"
  }
  return false
}

type SinkInfo = { target: AstNode; receiver: AstNode | null; needsHeadersReceiver: boolean }

/** Classify a call as a redirect/Location sink (cheap, no scope). For the
 *  `.set`/`.append` form the receiver still needs a Headers-instance check by
 *  the caller (`needsHeadersReceiver`), which requires the enclosing scope. */
function redirectSink(call: AstNode): SinkInfo | null {
  const callee = call.callee as AstNode
  if (!callee || callee.type !== "MemberExpression" || callee.computed) return null
  const method = idName(callee.property as AstNode)
  if (!method) return null
  const lower = method.toLowerCase()
  const args = (call.arguments ?? []) as AstNode[]
  // `<obj>.redirect(target)` — `res.redirect([status,] url)` may pass a numeric
  // status first, so the URL is the LAST argument (`res.redirect(301, url)`).
  if (REDIRECT_VERBS.has(lower)) {
    const target = args.length > 0 ? args[args.length - 1] : undefined
    return target ? { target, receiver: null, needsHeadersReceiver: false } : null
  }
  // Location-header write: arg 0 must be the literal "location" (case-insensitive);
  // the target is the SECOND arg. `setHeader`/`header` fire on any receiver;
  // `set`/`append` defer the Headers-instance check to the caller.
  const headerWriter = HEADER_WRITER_METHODS.has(lower)
  const headersReceiverMethod = HEADERS_RECEIVER_METHODS.has(lower)
  if (headerWriter || headersReceiverMethod) {
    const key = args[0]
    if (key && key.type === "Literal" && typeof key.value === "string" && key.value.toLowerCase() === "location") {
      const target = args[1]
      if (target) return { target, receiver: callee.object as AstNode, needsHeadersReceiver: !headerWriter }
    }
  }
  return null
}

/** A literal target that begins with a same-origin path prefix (`/dashboard/…`,
 *  `` `/u/${id}` ``) can only resolve to this origin, so a request value
 *  concatenated after it is NOT an open redirect. Conservative: a bare `/`, `//`,
 *  `/\`, or a non-`/` prefix (`https://`) does NOT qualify. */
function hasSafeOriginPrefix(target: AstNode): boolean {
  let n: AstNode | undefined = target
  // Leftmost operand of a `+` chain (left-associative): `"/a/" + x + y`.
  while (n && n.type === "BinaryExpression" && n.operator === "+") n = n.left as AstNode
  if (n && n.type === "Literal" && typeof n.value === "string") return SAFE_ORIGIN_PREFIX_RE.test(n.value)
  if (target.type === "TemplateLiteral") {
    const quasis = (target.quasis ?? []) as AstNode[]
    const head = quasis[0] as (AstNode & { value?: { cooked?: string; raw?: string } }) | undefined
    const cooked = head?.value?.cooked ?? head?.value?.raw
    return typeof cooked === "string" && SAFE_ORIGIN_PREFIX_RE.test(cooked)
  }
  return false
}

/** Does the function body contain a redirect-target validation signal? */
function hasValidationSignal(body: AstNode): boolean {
  let found = false
  walkNoNested(body, (n) => {
    if (found) return
    if (n.type === "Identifier") {
      if (VALIDATION_TOKEN_RE.test((n.name as string).toLowerCase())) found = true
    } else if (n.type === "MemberExpression" && !n.computed) {
      const prop = idName(n.property as AstNode)
      // `.startsWith(...)`, `<url>.origin`/`.host`/`.hostname` (a parsed-URL host
      // check is the canonical safe-redirect guard).
      if (prop && (VALIDATION_TOKEN_RE.test(prop.toLowerCase()) || /^(?:origin|host|hostname)$/.test(prop))) {
        found = true
      }
    }
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

export const noOpenRedirect: AstRule = {
  id: "no-open-redirect",
  severity: "warning",
  roleHint: "security",
  shortDescription: "request-controlled value reaches a redirect / Location sink with no destination validation",
  language: "both",
  nodeTypes: ["Program"],
  emitWhenUnmatched: true,
  visit(node: AstNode, ctx: RuleContext): AstRuleHit[] | null {
    if (!node || node.type !== "Program") return null
    if (SKIP_PATH.test(ctx.path)) return null

    // Functions sorted widest-first; the innermost enclosing one is the LAST
    // whose range contains the sink. Cache each function's validation flag.
    const fns = collectFunctions(node)
    const fnRange = (f: AstNode): [number, number] =>
      [typeof f.start === "number" ? f.start : -1, typeof f.end === "number" ? f.end : -1]
    const validatedCache = new Map<AstNode, boolean>()
    const isValidated = (f: AstNode): boolean => {
      let v = validatedCache.get(f)
      if (v === undefined) { v = hasValidationSignal((f.body as AstNode) ?? f); validatedCache.set(f, v) }
      return v
    }

    const hits: AstRuleHit[] = []
    const seen = new Set<number>()

    // Full walk (descending into functions) for redirect sinks.
    function walk(n: AstNode): void {
      if (!n || typeof n !== "object") return
      if (n.type === "CallExpression") {
        const sink = redirectSink(n)
        if (sink) {
          // taint is evaluated against the innermost enclosing function's locals.
          const callStart = typeof n.start === "number" ? n.start : -1
          let enclosing: AstNode | null = null
          for (const f of fns) {
            const [s, e] = fnRange(f)
            if (s <= callStart && callStart < e) {
              if (!enclosing || s >= fnRange(enclosing)[0]) enclosing = f
            }
          }
          const taintScope = enclosing ?? node
          // `.set`/`.append` are header writes only on a real Headers receiver.
          const headersOk =
            !sink.needsHeadersReceiver ||
            isHeadersReceiver(sink.receiver ?? undefined, collectHeadersLocals(taintScope))
          const taintedLocals = collectTaintedLocals(taintScope, ctx.source)
          // Skip a same-origin path prefix (`"/dashboard/" + req.query.tab`): the
          // request value can't escape the origin, so it is not an open redirect.
          if (headersOk && carriesTaint(sink.target, taintedLocals, ctx.source) && !hasSafeOriginPrefix(sink.target)) {
            // Fail closed: the enclosing function validates the destination → skip.
            if (!(enclosing && isValidated(enclosing))) {
              const start = typeof n.start === "number" ? n.start : -1
              if (start < 0 || !seen.has(start)) {
                if (start >= 0) seen.add(start)
                hits.push({
                  message:
                    "A request-controlled value reaches a redirect / `Location` here with no visible destination check. An attacker can set the target to an external site and phish through your domain's trust (open redirect, CWE-601). Validate the destination against an allow-list of paths/hosts (or only permit same-origin relative paths) before redirecting.",
                  evidence: sliceEvidence(ctx.source, n),
                  line: n.loc?.start?.line ?? 1,
                  endLine: n.loc?.end?.line ?? n.loc?.start?.line ?? 1,
                  column: n.loc?.start?.column ?? 0,
                })
              }
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
