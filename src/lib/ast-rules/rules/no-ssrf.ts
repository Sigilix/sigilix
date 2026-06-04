// no-ssrf — a DETERMINISTIC server-side request forgery floor (CWE-918). Flags a
// request-controlled value flowing into a server-side HTTP fetch sink whose
// AUTHORITY (scheme/host/port) the request can control, inside a function with
// NO visible host validation. `fetch(req.query.url)`, `axios.get(req.body.target)`,
// `http.get("http://localhost:" + req.query.port)` — an attacker points your
// server at the cloud metadata endpoint (169.254.169.254), localhost:6379, or a
// private-network host that trusts "internal" traffic (the Capital One breach).
//
// WHY this exists: the security specialist catches these by reasoning, but
// NONDETERMINISTICALLY. This is the run-INVARIANT floor: an obvious
// fetch-to-user-controlled-host is never silently missed.
//
// FP-SAFETY (a false positive on safe fetch code is the worst outcome — after the
// verdict change ANY security finding posts REQUEST_CHANGES — so we fail CLOSED on
// every doubt; mirrors no-open-redirect / no-unauthorized-object-lookup):
//   - severity `warning` → `clampAstEmitScores` caps it at score 3 (P2/P3); this
//     rule can NEVER post a P0/P1 alone.
//   - A function is SKIPPED the moment a host-validation signal appears in its
//     body (allow-list / `isAllowedHost` / `new URL(target).hostname` check, …).
//   - The fetch TARGET must be request-controlled AND the taint must reach the
//     AUTHORITY — a FIXED host with only a tainted path/query is NOT SSRF. We fold
//     the leading static prefix (literals + same-file `const` strings) and skip
//     when it proves a fixed `scheme://host/…` or a same-origin `/path`.
//   - Config-object sinks (`axios({url, data: req.body})`, `http.get({hostname,
//     path})`) are NOT analyzed (the request data is not the URL host) — skipped.
//   - Test / spec / config / migration / script files are skipped.

import type { AstRule, AstRuleHit, RuleContext } from "../types"
import type { AstNode } from "../walker"

const SLICE_MAX = 200
const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression",
])
const SKIP_PATH = /(\.test\.|\.spec\.|\.config\.|(^|\/)(__tests__|tests?|migrations?|scripts?)\/)/

// Request-controlled value (member access) — any request input can steer a fetch.
const TAINTED_MEMBER_RE = /\b(?:req|request|ctx|context)\.(?:params|query|body)\b/
// Call-based request input: Hono `c.req.param/query(...)`, Workers
// `new URL(request.url).searchParams.get(...)`. Same-line span only (`[^\n]`).
const TAINTED_CALL_RE =
  /(?:\b(?:c|ctx|context)\.req\.(?:param|query)\(|(?:req|request)\.url\b[^\n]{0,40}?\.searchParams\.get\()/
// Host-validation tokens — an in-body reference means "this handler checks the
// destination host", so we fail closed (skip). Matched against AST identifiers,
// member property names, and callee names.
const VALIDATION_TOKEN_RE =
  /^(?:allowlist|allowlisted|allowedhosts?|allowedorigins?|alloweddomains?|whitelist|whitelisted|isallowedurl|isallowedhost|issafeurl|issafehost|issafefetch|validateurl|validatehost|sanitizeurl|isinternalurl|ispublichost|ispublicurl|isprivateip|isprivatehost|ssrfsafe)$/
// Methods that issue an outbound request with a URL first arg.
const HTTP_CLIENT_METHODS: ReadonlySet<string> = new Set(["get", "post", "put", "patch", "delete", "request"])
// A leading static prefix that proves a FIXED authority (`https://host/…`) or a
// same-origin relative path (`/x`) — the tainted tail can't change WHERE the
// request goes, so it is not SSRF.
const FIXED_AUTHORITY_RE = /^https?:\/\/[^/?#]+[/?#]/
const SAME_ORIGIN_RE = /^\/[^/\\]/
const SCHEME_RE = /^https?:\/\//i
const STATIC_RESOLVE_DEPTH = 4

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

/** Locals whose initializer carries request taint (and the init node, so we can
 *  fold a fixed prefix through `const u = "https://api.x/" + req.query.id`). */
function collectTaintedLocals(root: AstNode, source: string): Map<string, AstNode> {
  const tainted = new Map<string, AstNode>()
  walkNoNested(root, (n) => {
    if (n.type !== "VariableDeclarator" || !n.init) return
    const local = idName(n.id as AstNode)
    if (local && sliceIsTainted(sliceOf(source, n.init as AstNode))) tainted.set(local, n.init as AstNode)
  })
  return tainted
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

/** Program-wide `const NAME = <init>` map (any scope) for static prefix folding.
 *  `const` only — `let`/`var` are mutable and imported bindings are unknowable. */
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

/** Fully resolve a node to a constant string, or null if any part is dynamic
 *  (a tainted value, a runtime call, a non-const identifier). Bounded depth. */
function staticString(node: AstNode | undefined, consts: Map<string, AstNode>, depth: number): string | null {
  if (!node || depth > STATIC_RESOLVE_DEPTH) return null
  if (node.type === "Literal") return typeof node.value === "string" ? node.value : null
  if (node.type === "TemplateLiteral") {
    if (((node.expressions ?? []) as AstNode[]).length > 0) return null
    const quasis = (node.quasis ?? []) as Array<AstNode & { value?: { cooked?: string; raw?: string } }>
    let out = ""
    for (const q of quasis) { const c = q.value?.cooked ?? q.value?.raw; if (typeof c !== "string") return null; out += c }
    return out
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const l = staticString(node.left as AstNode, consts, depth + 1)
    const r = staticString(node.right as AstNode, consts, depth + 1)
    return l !== null && r !== null ? l + r : null
  }
  if (node.type === "Identifier") {
    const init = consts.get(node.name as string)
    return init ? staticString(init, consts, depth + 1) : null
  }
  return null
}

/** Has the URL authority (scheme/host/port) been closed by a path separator in
 *  this accumulated prefix? Scheme-aware: the `//` in `https://` does NOT close
 *  it — only a `/`, `?`, or `#` AFTER the host does. A same-origin `/path` closes
 *  immediately; a bare `/` or `//` does not (the tainted tail can still escape). */
function authorityClosed(s: string): boolean {
  let rest = s
  if (SCHEME_RE.test(rest)) rest = rest.replace(SCHEME_RE, "")
  else if (rest.startsWith("//")) rest = rest.slice(2) // protocol-relative — host follows
  else if (SAME_ORIGIN_RE.test(rest)) return true // `/path` — same origin, closed
  else if (rest.startsWith("/")) return false // bare `/` or `/\` — could become `//evil`
  return /[/?#]/.test(rest)
}

type UrlPart = { kind: "static"; s: string } | { kind: "taint" } | { kind: "opaque" }

/** Classify the left-to-right operands of a URL expression (a `+` chain or a
 *  template literal). STATIC = a resolvable constant string (literal / same-file
 *  const). TAINT = request-controlled. OPAQUE = fixed but unresolved (an env var,
 *  imported const, runtime call) — NOT request-controlled, so it is fixed-host
 *  material, not taint. */
function urlParts(
  node: AstNode, consts: Map<string, AstNode>, taintedLocals: Map<string, AstNode>, source: string,
): UrlPart[] {
  const out: UrlPart[] = []
  const classify = (n: AstNode): void => {
    const s = staticString(n, consts, 0)
    if (s !== null) out.push({ kind: "static", s })
    else if (carriesTaint(n, taintedLocals, source)) out.push({ kind: "taint" })
    else out.push({ kind: "opaque" })
  }
  if (node.type === "TemplateLiteral") {
    const quasis = (node.quasis ?? []) as Array<AstNode & { value?: { cooked?: string; raw?: string } }>
    const exprs = (node.expressions ?? []) as AstNode[]
    for (let i = 0; i < quasis.length; i++) {
      out.push({ kind: "static", s: quasis[i]?.value?.cooked ?? quasis[i]?.value?.raw ?? "" })
      if (i < exprs.length) classify(exprs[i] as AstNode)
    }
    return out
  }
  const flat: AstNode[] = []
  ;(function flatten(n: AstNode): void {
    if (n.type === "BinaryExpression" && n.operator === "+") { flatten(n.left as AstNode); flatten(n.right as AstNode) }
    else flat.push(n)
  })(node)
  for (const p of flat) classify(p)
  return out
}

/** Is the authority FIXED before any request taint reaches it — so the taint can
 *  only land in the path/query, which is not SSRF? Reading operands left to right
 *  (opaque/env/import operands count as fixed host material), the authority must
 *  be closed by a path separator BEFORE the first tainted operand. */
function authorityFixed(
  target: AstNode, consts: Map<string, AstNode>, taintedLocals: Map<string, AstNode>, source: string,
): boolean {
  let node = target
  // A tainted local resolves to its initializer (`const u = base + req.q.x; fetch(u)`).
  if (node.type === "Identifier" && taintedLocals.has(node.name as string)) {
    node = taintedLocals.get(node.name as string) as AstNode
  }
  let acc = ""
  for (const p of urlParts(node, consts, taintedLocals, source)) {
    if (p.kind === "taint") return false // taint reaches the still-open authority → SSRF
    acc += p.kind === "static" ? p.s : "h" // opaque → a fixed host placeholder char
    if (authorityClosed(acc)) return true // authority pinned before any taint → safe
  }
  return false
}

type SinkResult = { target: AstNode } | "safe" | null

/** Classify a call as an SSRF fetch sink and return the URL argument to analyze,
 *  `"safe"` when the construction fixes the origin, or null when it's not a sink
 *  / not analyzable (config object). Cheap; no scope needed. */
function ssrfSink(call: AstNode, consts: Map<string, AstNode>): SinkResult {
  const callee = call.callee as AstNode
  if (!callee) return null
  const args = (call.arguments ?? []) as AstNode[]
  let isSink = false
  if (callee.type === "Identifier") {
    // `fetch(...)`, `axios(...)`, `got(...)`, `ky(...)`
    isSink = /^(?:fetch|axios|got|ky)$/.test(callee.name as string)
  } else if (callee.type === "MemberExpression" && !callee.computed) {
    const obj = idName(callee.object as AstNode)
    const method = (idName(callee.property as AstNode) ?? "").toLowerCase()
    // `axios.get/post/...(url)`, `got.get(url)`, `ky.get(url)`, `http.get/request(url)`
    if ((obj === "axios" || obj === "got" || obj === "ky") && HTTP_CLIENT_METHODS.has(method)) isSink = true
    else if ((obj === "http" || obj === "https") && (method === "get" || method === "request")) isSink = true
  }
  if (!isSink) return null
  return normalizeUrlArg(args[0], consts)
}

/** Reduce a sink's first argument to the URL node to taint-check, `"safe"` when
 *  the construction fixes the origin, or null when not analyzable. */
function normalizeUrlArg(arg: AstNode | undefined, consts: Map<string, AstNode>): SinkResult {
  if (!arg) return null
  // Config-object form (`axios({url, data: req.body})`) — the request data is not
  // the URL host; we don't field-analyze it, so skip (FP-safe).
  if (arg.type === "ObjectExpression") return null
  if (arg.type === "NewExpression") {
    const ctor = idName(arg.callee as AstNode)
    const ctorArgs = (arg.arguments ?? []) as AstNode[]
    if (ctor === "Request") return normalizeUrlArg(ctorArgs[0], consts) // inspect the URL arg only
    if (ctor === "URL") {
      // `new URL(x, base)` — a fixed absolute base pins the origin → safe.
      const base = ctorArgs[1]
      if (base && FIXED_AUTHORITY_RE.test((staticString(base, consts, 0) ?? "") + "/")) return "safe"
      return normalizeUrlArg(ctorArgs[0], consts)
    }
  }
  return { target: arg }
}

/** Does the function body contain a host-validation signal? */
function hasValidationSignal(body: AstNode, source: string): boolean {
  let found = false
  walkNoNested(body, (n) => {
    if (found) return
    if (n.type === "Identifier") {
      if (VALIDATION_TOKEN_RE.test((n.name as string).toLowerCase())) found = true
    } else if (n.type === "MemberExpression" && !n.computed) {
      const prop = idName(n.property as AstNode)
      // a `<url>.hostname`/`.host` parse-and-check is the canonical SSRF guard;
      // but a request-tainted member (`req.query.host`) is the INPUT, not a check.
      if (prop && (VALIDATION_TOKEN_RE.test(prop.toLowerCase()) || /^(?:hostname|host)$/.test(prop))) {
        if (!TAINTED_MEMBER_RE.test(sliceOf(source, n))) found = true
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

export const noSsrf: AstRule = {
  id: "no-ssrf",
  severity: "warning",
  roleHint: "security",
  shortDescription: "request-controlled value reaches a server-side fetch with no host validation",
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
    const validatedCache = new Map<AstNode, boolean>()
    const isValidated = (f: AstNode): boolean => {
      let v = validatedCache.get(f)
      if (v === undefined) { v = hasValidationSignal((f.body as AstNode) ?? f, ctx.source); validatedCache.set(f, v) }
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
        const sink = ssrfSink(n, consts)
        if (sink && sink !== "safe") {
          const callStart = typeof n.start === "number" ? n.start : -1
          let enclosing: AstNode | null = null
          for (const f of fns) {
            const [s, e] = fnRange(f)
            if (s <= callStart && callStart < e) {
              if (!enclosing || s >= fnRange(enclosing)[0]) enclosing = f
            }
          }
          const taintScope = enclosing ?? node
          const taintedLocals = taintLocalsOf(taintScope)
          // Fire only when the taint reaches the AUTHORITY (no fixed-host prefix)
          // and the enclosing function shows no host-validation signal.
          if (
            carriesTaint(sink.target, taintedLocals, ctx.source) &&
            !authorityFixed(sink.target, consts, taintedLocals, ctx.source) &&
            !(enclosing && isValidated(enclosing))
          ) {
            const start = typeof n.start === "number" ? n.start : -1
            if (start < 0 || !seen.has(start)) {
              if (start >= 0) seen.add(start)
              hits.push({
                message:
                  "A request-controlled value reaches a server-side fetch here, and it can control the destination host. An attacker can point the request at internal-only services — cloud metadata (169.254.169.254), localhost, or a private-network host that trusts internal traffic — to exfiltrate credentials or pivot (server-side request forgery, CWE-918). Validate the destination host against an allow-list (and reject private/loopback/link-local addresses) before fetching.",
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
