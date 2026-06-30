// SIG-… — the SHARED pure-logic pair core: lift two snippets into callables, run them
// side-by-side over a type-aware battery in the sealed QuickJS sandbox, and report
// whether they DIVERGE (changed) or AGREE (preserved) — deterministically.
//
// This is the reuse surface extracted from harness-purelogic.ts (the finding-path
// harness). The reusable, finding-agnostic mechanics live HERE — the type-aware battery,
// the comparison-source builder, the TS-strip + lift, the agree/diverge tally, and the
// determinism re-run — so two callers can share them:
//
//   1. `runPureLogicHarness` (harness-purelogic.ts) — the review-path adapter: lifts the
//      buggy + fixed code from a finding's cited fields and maps the comparison to the
//      reproduced/inconclusive/skipped verdict vocabulary. Its behavior is UNCHANGED by
//      the extraction (e2e/reproduce-fp-eval.test.ts pins it: 100% recall / 0% over-fire).
//   2. `comparePairInSandbox` (this file) — the POST /v1/verify oracle: takes two raw
//      snippets (a function BEFORE and AFTER an edit) and reports changed / preserved /
//      skipped over the same battery + determinism guards.
//
// ── WHAT "changed" MEANS (and does NOT mean) ────────────────────────────────
// `changed` = "the sandbox OBSERVED behavioral divergence on ≥1 type-aware battery input,
// confirmed by a deterministic re-run." `preserved` = "every battery input produced equal
// output (deterministically) — no divergence observable." It is a BEHAVIORAL observation
// over a bounded input battery, NOT a correctness judgment: `changed` does NOT mean the
// AFTER snippet is a correct fix, and `preserved` does NOT prove the snippets are equal on
// EVERY possible input — only on the battery we exercised. Anything we could not run
// soundly (a guest throw/timeout/oom on either side, a flaky/non-deterministic tally,
// non-liftable / non-pure code, an ASYNC / Promise-returning function — its result is a
// Promise, and `canon` keys EVERY promise as `"{}"`, so two DIFFERENT async behaviors would
// FALSELY "agree" into a spurious `preserved`; async/thenable-returning fns are therefore
// rejected, detected BOTH from the `async` keyword (source) AND from a Promise/thenable
// runtime result — an arity mismatch, an empty/over-large battery, or a behavior-preserving
// array-constructor idiom rewrite that diverges only on an out-of-domain length) →
// `skipped`, never a false changed/preserved.
//
// ── THE BATTERY (type-aware) ────────────────────────────────────────────────
// Each parameter is swept over an IN-TYPE pool derived from its TS annotation (a `number`
// param gets only numbers, etc.), augmented with the function's own numeric literals ±1 so
// boundary comparisons (`age > 18` vs `>= 18`) are hit. This keeps a type-correct
// equivalent rewrite (`x*2` vs `x+x`, identical for numbers but not for strings) from
// FALSELY diverging via coercion; an untyped (`any`) param gets the full mixed pool, so a
// genuine coercion change is still exercised.

import { parseSource, type SourceExt, type AstNode } from "@/src/features/ast-rules"
import { runInSandbox, type SandboxCaps, type SandboxResult } from "./sandbox-runner"

/** The coarse runtime type of a parameter, derived from its TS annotation (or `any`
 *  when untyped/unknown). Drives a TYPE-AWARE battery so a numerically-equivalent
 *  rewrite (`x * 2` vs `x + x`) isn't falsely flagged as divergent by feeding a `string`
 *  to a `number` param — while an untyped (`any`) param still gets the full pool, so a
 *  genuine coercion change is still exercised. */
export type ParamType = "number" | "string" | "boolean" | "array" | "any"

/** A liftable function pulled from a cited snippet: an EXPRESSION text usable as a
 *  value (a declaration is wrapped so it yields the function), plus its param types.
 *  `isAsync` flags an `async` function (read from the AST `async` flag, robust to
 *  formatting) — an async fn returns a Promise that can't be soundly value-compared, so
 *  the kernel rejects it (see {@link compareLiftedPair}). */
export interface LiftedFunction {
  expr: string
  paramTypes: ParamType[]
  isAsync: boolean
}

/** Per-run sandbox caps. A pure-function battery is BYTECODE, so the opcode-cycle
 *  interrupt (maxInterrupts) is the real bound — a runaway buggy loop is cut by the
 *  counter even on Cloudflare's frozen clock. Battery + arity are kept small so a
 *  benign battery finishes well under the cap while a true infinite loop trips it. */
const HARNESS_DEADLINE_MS = 500
const HARNESS_MAX_INTERRUPTS = 100_000
export const PURELOGIC_PAIR_CAPS: SandboxCaps = {
  memoryBytes: 32 * 1024 * 1024,
  maxStackBytes: 256 * 1024,
  deadlineMs: HARNESS_DEADLINE_MS,
  maxInterrupts: HARNESS_MAX_INTERRUPTS,
}

/** Max function arity we form a battery for (>3 → combinatorial blow-up; off-by-one /
 *  fence-post bugs are overwhelmingly 1-2 arg functions). */
const MAX_ARITY = 3
/** Cap on battery size (bounds the in-guest loop → keeps opcode cost well under the
 *  cycle cap). The type-correct cartesian stays under this for typed params; an
 *  all-`any` arity-3 fn overflows and is evenly sampled to this many tuples. */
const MAX_BATTERY = 165

/** Boundary-biased input values: small ints around 0/±1, strings of increasing
 *  length, arrays of increasing length, booleans — exactly where off-by-one /
 *  fence-post / coercion bugs manifest. All JSON-serializable (passed via __INPUT__). */
const SCALAR_POOL: readonly unknown[] = [
  -1,
  0,
  1,
  2,
  3,
  5,
  10,
  "",
  "a",
  "ab",
  "abc",
  "abcde",
  [],
  [1],
  [1, 2],
  [1, 2, 3],
  [1, 2, 3, 4, 5],
  true,
  false,
]

/** The value pool swept for a parameter, BY its type. A typed param gets only in-type
 *  values (so a type-correct rewrite never diverges via coercion); an `any` param gets
 *  the full mixed pool (so genuine coercion bugs are still caught). */
const POOL_BY_TYPE: Record<ParamType, readonly unknown[]> = {
  number: [-1, 0, 1, 2, 3, 5, 10],
  string: ["", "a", "ab", "abc", "abcde"],
  boolean: [true, false],
  array: [[], [1], [1, 2], [1, 2, 3], [1, 2, 3, 4, 5]],
  any: SCALAR_POOL,
}

/** Numeric literals appearing in the function text, each expanded to {n-1, n, n+1}, so
 *  a boundary-comparison bug (`age > 18` vs `>= 18`) is exercised AT its boundary (18 is
 *  not in the default pool). Bounded; ignores huge magnitudes. */
export function numericLiteralsFrom(text: string): number[] {
  const out = new Set<number>()
  const re = /-?\b\d+\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[0])
    if (Number.isInteger(n) && Math.abs(n) <= 100_000) {
      out.add(n - 1)
      out.add(n)
      out.add(n + 1)
    }
  }
  return [...out].slice(0, 18)
}

/** Build the arg-tuple battery from the per-position TYPES: the FULL cartesian product
 *  of each position's IN-TYPE pool, EVENLY SAMPLED down to MAX_BATTERY when it overflows.
 *  Type-correct pools mean a numerically-equivalent rewrite is never fed a type-violating
 *  value (no coercion over-fire), and the cartesian covers cross-position combinations
 *  (so a bug needing two specific args is found). `extraNumbers` (the function's own
 *  literals ±1) augment the number/any pools so boundary comparisons are hit. The
 *  cartesian stays small for typed params; an all-`any` arity-3 fn hits the cap, where
 *  even-sampling still spreads each position across its pool. */
export function buildBattery(paramTypes: readonly ParamType[], extraNumbers: readonly number[] = []): unknown[][] {
  const numberPool =
    extraNumbers.length === 0 ? POOL_BY_TYPE.number : [...new Set([...extraNumbers, ...POOL_BY_TYPE.number])]
  const anyPool = extraNumbers.length === 0 ? POOL_BY_TYPE.any : [...new Set([...extraNumbers, ...POOL_BY_TYPE.any])]
  const poolFor = (t: ParamType): readonly unknown[] =>
    t === "number" ? numberPool : t === "any" ? anyPool : POOL_BY_TYPE[t]
  const pools = paramTypes.map((t) => poolFor(t ?? "any"))
  if (pools.length === 1) return [...(pools[0] ?? POOL_BY_TYPE.any)].map((v) => [v])
  const full: unknown[][] = []
  const rec = (depth: number, acc: unknown[]): void => {
    if (depth === pools.length) {
      full.push(acc.slice())
      return
    }
    for (const v of pools[depth] ?? []) {
      acc.push(v)
      rec(depth + 1, acc)
      acc.pop()
    }
  }
  rec(0, [])
  if (full.length <= MAX_BATTERY) return full
  const stride = full.length / MAX_BATTERY
  const sampled: unknown[][] = []
  for (let k = 0; k < MAX_BATTERY; k++) {
    const tuple = full[Math.floor(k * stride)]
    if (tuple !== undefined) sampled.push(tuple)
  }
  return sampled
}

/** The coarse {@link ParamType} of a function parameter from its TS annotation. */
function paramTypeOf(param: AstNode): ParamType {
  const id = param?.type === "AssignmentPattern" ? param.left : param?.type === "RestElement" ? param.argument : param
  const ann = id?.typeAnnotation?.typeAnnotation
  const t = typeof ann?.type === "string" ? ann.type : ""
  if (t === "TSNumberKeyword") return "number"
  if (t === "TSStringKeyword") return "string"
  if (t === "TSBooleanKeyword") return "boolean"
  if (t === "TSArrayType") return "array"
  if (t === "TSTypeReference") {
    const name = ann?.typeName?.name
    if (name === "Array" || name === "ReadonlyArray") return "array"
  }
  return "any"
}

/** Per-position {@link ParamType}s of a function-ish AST node. */
function paramTypesOf(node: AstNode): ParamType[] {
  const params = node?.params
  return Array.isArray(params) ? params.map((p: AstNode) => paramTypeOf(p)) : []
}

const FUNCTION_NODE_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"])

/** Pull a function node out of a single top-level statement (or its exported /
 *  declared inner). Handles `function f(){}`, `const f = () => {}`, a bare
 *  `(x) => ...` expression, and the `export` / `export default` wrappers. Returns the
 *  OUTERMOST function (never a nested helper). */
function functionFromStatement(stmt: AstNode): AstNode | null {
  if (stmt === null || typeof stmt !== "object") return null
  const t = stmt.type
  if (FUNCTION_NODE_TYPES.has(t)) return stmt
  if (t === "ExportNamedDeclaration" || t === "ExportDefaultDeclaration") return functionFromStatement(stmt.declaration)
  if (t === "ExpressionStatement") return functionFromStatement(stmt.expression)
  if (t === "VariableDeclaration") {
    const decls = Array.isArray(stmt.declarations) ? stmt.declarations : []
    for (const d of decls) {
      const init = d?.init
      if (init && FUNCTION_NODE_TYPES.has(init.type)) return init
    }
  }
  return null
}

/** The OUTERMOST (top-level) function in a parsed snippet, by scanning the module
 *  body in source order. NOT a walk — acorn-walk visits children first, so a walk
 *  would lift a nested helper/arrow instead of the cited function. */
function topLevelFunctionNode(ast: AstNode): AstNode | null {
  const body = Array.isArray(ast?.body) ? ast.body : []
  for (const stmt of body) {
    const fn = functionFromStatement(stmt)
    if (fn !== null) return fn
  }
  return null
}

/** Node types that are PURE TYPE syntax (no runtime form) — deleted whole. */
const PURE_TYPE_NODES = new Set([
  "TSTypeAnnotation",
  "TSTypeParameterDeclaration",
  "TSTypeParameterInstantiation",
  "TSTypeAliasDeclaration",
  "TSInterfaceDeclaration",
  "TSDeclareFunction",
  "TSIndexSignature",
])

/**
 * Collect [start,end) ranges of TS-only syntax anywhere in a function subtree, so the
 * sliced text can run as PLAIN JS in QuickJS (which has no TS support). A cited
 * function in this strict-TS repo carries param/return type annotations, type
 * parameters, `as`/`satisfies`/non-null assertions, and inner-var types — all of which
 * are a SyntaxError in the guest. A GENERIC recursion (not `walkAst`, whose base
 * visitor never descends into `.typeAnnotation`/`.returnType`/`.typeParameters`):
 *   - PURE type nodes → delete the whole node (+ a directly-preceding optional `?`);
 *   - `as` / `satisfies` / non-null → keep `.expression`, delete the trailing type;
 *   - `<T>expr` assertion → delete the leading `<T>`, keep `.expression`.
 * Ranges are in the snippet's coordinate system, non-overlapping by construction.
 */
function collectTypeRanges(node: AstNode, snippet: string, ranges: Array<[number, number]>): void {
  if (node === null || typeof node !== "object") return
  const type = node.type
  if (typeof type === "string") {
    if (PURE_TYPE_NODES.has(type)) {
      if (typeof node.start === "number" && typeof node.end === "number" && node.end > node.start) {
        // absorb a directly-preceding optional `?` (e.g. `i?: number`)
        const s = node.start > 0 && snippet[node.start - 1] === "?" ? node.start - 1 : node.start
        ranges.push([s, node.end])
      }
      return // a type subtree has no runtime form — don't recurse into it
    }
    if (type === "TSAsExpression" || type === "TSSatisfiesExpression" || type === "TSNonNullExpression") {
      const ex = node.expression
      if (ex && typeof ex.end === "number" && typeof node.end === "number" && node.end > ex.end) {
        ranges.push([ex.end, node.end])
      }
      collectTypeRanges(ex, snippet, ranges) // keep + recurse the runtime expression
      return
    }
    if (type === "TSTypeAssertion") {
      const ex = node.expression
      if (ex && typeof node.start === "number" && typeof ex.start === "number" && ex.start > node.start) {
        ranges.push([node.start, ex.start]) // the leading `<T>`
      }
      collectTypeRanges(ex, snippet, ranges)
      return
    }
  }
  for (const key in node) {
    if (key === "start" || key === "end" || key === "loc" || key === "range" || key === "parent") continue
    const child = (node as Record<string, unknown>)[key]
    if (Array.isArray(child)) {
      for (const c of child) collectTypeRanges(c as AstNode, snippet, ranges)
    } else if (child !== null && typeof child === "object") {
      collectTypeRanges(child as AstNode, snippet, ranges)
    }
  }
}

/** Slice the function text from the snippet with all TS-only syntax removed, yielding
 *  plain JS the guest can evaluate. Returns null on a malformed node range. */
function functionTextStripped(snippet: string, fnNode: AstNode): string | null {
  const start = fnNode?.start
  const end = fnNode?.end
  if (typeof start !== "number" || typeof end !== "number") return null
  if (start < 0 || end > snippet.length || end <= start) return null
  const ranges: Array<[number, number]> = []
  collectTypeRanges(fnNode, snippet, ranges)
  const within = ranges.filter(([s, e]) => s >= start && e <= end && e > s).sort((a, b) => b[0] - a[0]) // descending so each splice leaves earlier offsets valid
  let text = snippet.slice(start, end)
  for (const [s, e] of within) text = text.slice(0, s - start) + text.slice(e - start)
  return text
}

/**
 * Lift the OUTERMOST function from the candidate snippets into a callable EXPRESSION
 * (TS types stripped). A FunctionDeclaration is wrapped `(()=>{<decl>;return
 * <name>;})()` so it yields the function value (and same-name buggy/fixed pairs don't
 * collide); an arrow / function expression is parenthesised. Each candidate is parsed
 * INDEPENDENTLY; the first that parses AND yields a top-level function wins. The TS
 * parser is used (the cited code may be TS), but the lifted text is plain JS. Never
 * throws.
 */
export function liftFunction(candidates: readonly string[]): LiftedFunction | null {
  for (const code of candidates) {
    const trimmed = code.trim()
    if (trimmed.length === 0) continue
    const parsed = parseSource(trimmed, ".ts" as SourceExt)
    if (!parsed.ok) continue
    const fnNode = topLevelFunctionNode(parsed.ast)
    if (fnNode === null) continue
    const text = functionTextStripped(trimmed, fnNode)
    if (text === null) continue
    const name = fnNode.type === "FunctionDeclaration" ? fnNode?.id?.name : undefined
    const expr = typeof name === "string" && name.length > 0 ? `(()=>{${text};return ${name};})()` : `(${text})`
    // Param types read from the (un-stripped) AST node — drives the type-aware battery.
    // `isAsync` from the AST `async` flag — rejected by the kernel (a Promise result can't
    // be soundly value-compared); robust to formatting, unlike a literal-keyword scan.
    return { expr, paramTypes: paramTypesOf(fnNode), isAsync: fnNode?.async === true }
  }
  return null
}

// ── SIG-478: array-constructor-idiom rewrite detector ───────────────────────
// A behavior-preserving rewrite of the array-construction IDIOM
// (`new Array(n).fill(v)` ↔ `Array.from({length:n},()=>v)`, or bare `new Array(n)` ↔
// `Array.from({length:n})`) is equivalent for every VALID length but DIVERGES at an
// out-of-domain length (`new Array(-1)` throws RangeError; `Array.from({length:-1})`
// returns []) and — for an UNTYPED param — on coercion inputs (`new Array("a")` → `["a"]`
// vs `Array.from({length:"a"})` → []). That divergence is a constructor-domain artifact,
// NOT a substantive behavior change, yet it slips the all-agree floor. We detect it at the
// lifted-EXPRESSION level (param-type-independent, so it closes BOTH the typed RangeError
// and the untyped coercion vectors a runtime/error-message heuristic can't). The detector
// PRESERVES the length expression and the per-element value and only canonicalizes the
// new-vs-from idiom, so a real change INSIDE the construction (fill value 1-vs-0, length
// n-vs-n+1, an index-using mapper `(_,i)=>i`) keeps the skeletons distinct and still
// diverges.

const ARRBUILD_HOLE = "HOLE"

/** `Array` referenced as the global by NAME (a locally-shadowed `Array` is a known,
 *  contrived limitation — see the ticket residual-risks). */
function isArrayIdentifier(node: AstNode): boolean {
  return node?.type === "Identifier" && node?.name === "Array"
}

/** Does a mapper fn body reference any of its OWN params (an index/value-using mapper —
 *  a genuine behavior difference vs a constant `.fill`)? */
function mapperUsesParams(fn: AstNode): boolean {
  const names: string[] = (Array.isArray(fn?.params) ? fn.params : [])
    .map((p: AstNode) => (p?.type === "Identifier" ? p.name : null))
    .filter((n: unknown): n is string => typeof n === "string")
  if (names.length === 0) return false
  let used = false
  const walk = (n: AstNode): void => {
    if (used || n === null || typeof n !== "object") return
    if (n.type === "Identifier" && names.includes(n.name)) {
      used = true
      return
    }
    for (const key in n) {
      if (key === "start" || key === "end" || key === "loc" || key === "range" || key === "parent") continue
      const c = (n as Record<string, unknown>)[key]
      if (Array.isArray(c)) for (const x of c) walk(x as AstNode)
      else if (c !== null && typeof c === "object") walk(c as AstNode)
    }
  }
  walk(fn.body)
  return used
}

/** If `node` is a recognized array construction, return its {length node, element-skeleton
 *  fn}; else null. Recognizes `new Array(e)` / `Array(e)` (→ HOLE), `<ctor>.fill(v)` (→
 *  CONST(v)), `Array.from({length:e})` (→ HOLE), `Array.from({length:e}, mapper)` (→ CONST
 *  for a param-free constant arrow, else MAPPER). Returns null on any other shape (multi-arg
 *  `Array(a,b)`, `Array.from(iterable)`, computed access, `.map`/other chains) so genuine
 *  behavior differences are NOT collapsed. */
function arrayBuild(node: AstNode): { length: AstNode; element: () => string } | null {
  if (node === null || typeof node !== "object") return null
  if (
    (node.type === "NewExpression" || node.type === "CallExpression") &&
    isArrayIdentifier(node.callee) &&
    Array.isArray(node.arguments) &&
    node.arguments.length === 1
  ) {
    return { length: node.arguments[0], element: () => ARRBUILD_HOLE }
  }
  if (
    node.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    node.callee.computed !== true &&
    node.callee.property?.name === "fill"
  ) {
    const inner = arrayBuild(node.callee.object)
    if (inner !== null && Array.isArray(node.arguments) && node.arguments.length <= 1) {
      const v = node.arguments[0]
      return { length: inner.length, element: () => (v === undefined ? "CONST(undefined)" : `CONST(${skeleton(v)})`) }
    }
  }
  if (
    node.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    node.callee.computed !== true &&
    isArrayIdentifier(node.callee.object) &&
    node.callee.property?.name === "from" &&
    Array.isArray(node.arguments) &&
    node.arguments.length >= 1
  ) {
    const a0 = node.arguments[0]
    if (a0?.type === "ObjectExpression" && Array.isArray(a0.properties) && a0.properties.length === 1) {
      const p = a0.properties[0]
      const keyName = p?.key?.name ?? p?.key?.value
      if (p?.type === "Property" && p.computed !== true && keyName === "length") {
        const mapper = node.arguments[1]
        return {
          length: p.value,
          element: () => {
            if (mapper === undefined) return ARRBUILD_HOLE
            if (mapper.type === "ArrowFunctionExpression" || mapper.type === "FunctionExpression") {
              if (!mapperUsesParams(mapper) && mapper.body && mapper.body.type !== "BlockStatement") {
                return `CONST(${skeleton(mapper.body)})`
              }
              return `MAPPER(${skeleton(mapper)})`
            }
            return `MAPPER(${skeleton(mapper)})`
          },
        }
      }
    }
  }
  return null
}

/** Structural skeleton string of an AST subtree, with array-construction subtrees
 *  canonicalized to `ARRBUILD(<length-skeleton>;<element>)`. Ignores location + TS-only
 *  keys. Sets `state.saw` when any array construction was canonicalized. */
function skeleton(node: AstNode, state: { saw: boolean } = { saw: false }): string {
  if (node === null || typeof node !== "object") return JSON.stringify(node)
  const build = arrayBuild(node)
  if (build !== null) {
    state.saw = true
    return `ARRBUILD(${skeleton(build.length, state)};${build.element()})`
  }
  const parts: string[] = []
  for (const key of Object.keys(node).sort()) {
    if (key === "start" || key === "end" || key === "loc" || key === "range" || key === "parent") continue
    if (key === "typeAnnotation" || key === "returnType" || key === "typeParameters" || key === "typeArguments")
      continue
    const c = (node as Record<string, unknown>)[key]
    if (Array.isArray(c)) parts.push(`${key}=[${c.map((x) => skeleton(x as AstNode, state)).join(",")}]`)
    else if (c !== null && typeof c === "object") parts.push(`${key}=${skeleton(c as AstNode, state)}`)
    else parts.push(`${key}=${JSON.stringify(c)}`)
  }
  return `${node.type}{${parts.join(",")}}`
}

/** True iff the two lifted expressions differ ONLY in array-construction idiom: both parse,
 *  both contain an array construction, and their idiom-canonicalized skeletons are identical.
 *  Fail-safe to false (never throws). */
export function isArrayCtorOnlyRewrite(buggyExpr: string, fixedExpr: string): boolean {
  try {
    const pb = parseSource(buggyExpr, ".ts" as SourceExt)
    const pf = parseSource(fixedExpr, ".ts" as SourceExt)
    if (!pb.ok || !pf.ok) return false
    const sb = { saw: false }
    const sf = { saw: false }
    const kb = skeleton(pb.ast as AstNode, sb)
    const kf = skeleton(pf.ast as AstNode, sf)
    return sb.saw && sf.saw && kb === kf
  } catch {
    return false
  }
}

/**
 * Build the sandbox guest that defines the two lifted functions and runs the battery,
 * tallying agree/diverge. Each call gets a DEEP-CLONED copy of its args (so a function
 * that mutates an array argument can't poison the other side's call or a later tuple).
 * A return value is keyed `"V:"+canon(out)`; a throw is keyed `"E:"+name`, so
 * "both throw the same error" counts as AGREE (not a spurious divergence).
 *
 * ASYNC GUARD (runtime side): a Promise/thenable result has NO own enumerable keys, so
 * `canon` keys it `"{}"` on BOTH sides — two DIFFERENT async behaviors would FALSELY "agree"
 * into a spurious `preserved`. So each result is thenable-checked; the FIRST thenable sets
 * `thenable:true` and aborts the tally, and the host maps that to `skipped` (never a false
 * preserved/changed). This catches an ORDINARY function that RETURNS a promise (the
 * `async`-keyword case is also rejected source-side, before we ever run). The last
 * expression is the `{agree,diverge,sample,thenable}` object → `runInSandbox` dumps it.
 */
export function buildComparisonSource(buggyExpr: string, fixedExpr: string): string {
  // `canon` is an ORDER-INSENSITIVE-for-object-keys serializer: object keys are sorted
  // so a behavior-preserving key REORDER (`{x,y}` vs `{y,x}`) keys identically → AGREE,
  // not a false divergence (JSON.stringify is key-order-sensitive). ARRAY order is kept
  // significant — reordering an array IS a behavior change, correctly divergent.
  return (
    `function canon(v){if(v===null||typeof v!=="object")return JSON.stringify(v);` +
    `if(Array.isArray(v))return "["+v.map(canon).join(",")+"]";` +
    `var ks=Object.keys(v).sort();return "{"+ks.map(function(k){return JSON.stringify(k)+":"+canon(v[k]);}).join(",")+"}";}` +
    `function isThenable(v){return v!==null&&(typeof v==="object"||typeof v==="function")&&typeof v.then==="function";}` +
    `var thenable=false;` +
    `function keyOf(fn,args){try{var out=fn.apply(null,args);if(isThenable(out)){thenable=true;return "__ASYNC__";}return "V:"+canon(out);}catch(e){return "E:"+((e&&e.name)?e.name:"err");}}` +
    `const __B__=${buggyExpr};` +
    `const __F__=${fixedExpr};` +
    `const A=__INPUT__.battery;` +
    `let agree=0,diverge=0,sample=null;` +
    `for(let i=0;i<A.length;i++){` +
    `var bk=keyOf(__B__,JSON.parse(JSON.stringify(A[i])));` +
    `var fk=keyOf(__F__,JSON.parse(JSON.stringify(A[i])));` +
    `if(thenable){break;}` +
    `if(bk===fk){agree++;}else{diverge++;if(sample===null){sample={i:i,buggy:bk,fixed:fk};}}` +
    `}` +
    `({agree:agree,diverge:diverge,sample:sample,thenable:thenable})`
  )
}

/** The agree/diverge tally parsed from a sandbox run, or null when the guest didn't
 *  return a clean tally (timed-out / threw / oom / malformed). `thenable` is true when the
 *  guest observed a Promise/thenable result on ≥1 input (an async result that can't be
 *  soundly value-compared → the host maps it to `skipped`, see {@link compareLiftedPair}). */
export interface Tally {
  agree: number
  diverge: number
  sample: unknown
  thenable: boolean
}

export function parseTally(res: SandboxResult): Tally | null {
  if (res.status !== "ok") return null
  const v = res.value
  if (v === null || typeof v !== "object") return null
  const o = v as { agree?: unknown; diverge?: unknown; sample?: unknown; thenable?: unknown }
  if (typeof o.agree !== "number" || typeof o.diverge !== "number") return null
  return { agree: o.agree, diverge: o.diverge, sample: o.sample ?? null, thenable: o.thenable === true }
}

/** Stable string key for a divergence sample (for the determinism re-run compare). */
export function sampleKey(sample: unknown): string {
  try {
    return JSON.stringify(sample) ?? "null"
  } catch {
    return "unstringifiable"
  }
}

/**
 * The structured comparison outcome — the shared kernel BOTH callers map from. It records
 * exactly which branch fired so each caller can map to its own verdict vocabulary without
 * re-deriving the logic:
 *
 *   - `diverged`  — ≥1 battery input diverged AND the deterministic re-run agreed
 *                   (same tally + sample). Carries the agree/diverge counts + the first
 *                   divergence sample.
 *   - `agreed`    — every battery input produced equal output (diverge === 0). The fix is
 *                   a no-op on the (type-correct) battery.
 *   - `skipped`   — nothing soundly runnable (non-liftable, arity, empty/no-tally,
 *                   array-ctor idiom rewrite, flaky/non-deterministic, or an async /
 *                   Promise-returning fn whose result can't be value-compared). `detail`
 *                   is a stable machine-readable tag.
 */
export type PairComparison =
  | { kind: "diverged"; detail: string; agree: number; diverge: number; sample: Tally["sample"] }
  | { kind: "agreed"; detail: string; agree: number }
  | { kind: "skipped"; detail: string }

/** Inputs the shared comparison kernel needs: the two ALREADY-LIFTED callables. */
export interface LiftedPair {
  buggy: LiftedFunction
  fixed: LiftedFunction
}

/**
 * Run the agree/diverge comparison of an ALREADY-LIFTED buggy/fixed pair: arity check,
 * the array-ctor-idiom carve-out, the type-aware battery, the first sandbox run, and a
 * determinism re-run. Returns a {@link PairComparison} — the shared kernel both the
 * finding harness and the /v1/verify oracle map to their own vocabularies. NEVER throws.
 */
export async function compareLiftedPair(pair: LiftedPair, caps: SandboxCaps): Promise<PairComparison> {
  const { buggy, fixed } = pair
  const arity = buggy.paramTypes.length
  if (arity !== fixed.paramTypes.length) {
    return { kind: "skipped", detail: `arity-mismatch:${arity}!=${fixed.paramTypes.length}` }
  }
  if (arity < 1 || arity > MAX_ARITY) {
    return { kind: "skipped", detail: `arity-out-of-range:${arity}` }
  }
  // ASYNC GUARD (source side): an `async` function returns a Promise, whose `canon` is "{}"
  // on BOTH sides → a real async behavior change would FALSELY "preserve". An async edit
  // can't be soundly value-compared, so reject it HERE (before the battery + the two sandbox
  // runs). Read from the AST `async` flag (robust to formatting); the runtime thenable check
  // after the first run also catches an ORDINARY fn that RETURNS a promise (no `async` kw).
  if (buggy.isAsync || fixed.isAsync) {
    return { kind: "skipped", detail: "async-fn" }
  }
  // A behavior-preserving array-constructor IDIOM rewrite diverges only on an out-of-domain
  // length (or untyped coercion inputs) — a constructor-domain artifact, not a substantive
  // change. Detect it at the lifted-expression level and bail BEFORE the battery (also saves
  // the two sandbox runs). The detector preserves the length + per-element semantics, so a
  // real change inside the construction still diverges.
  if (isArrayCtorOnlyRewrite(buggy.expr, fixed.expr)) {
    return { kind: "skipped", detail: "array-ctor-rewrite" }
  }
  // Use the BUGGY param types (arity already matched) — they drive the in-type battery,
  // augmented with the function's own numeric literals so boundary comparisons are hit.
  const battery = buildBattery(buggy.paramTypes, numericLiteralsFrom(buggy.expr))
  if (battery.length === 0) {
    return { kind: "skipped", detail: "empty-battery" }
  }
  const source = buildComparisonSource(buggy.expr, fixed.expr)

  const first = parseTally(await runInSandbox(source, { battery }, caps))
  if (first === null) {
    // A guest throw/timeout/oom on EITHER side (or a malformed tally) means we couldn't
    // run the comparison soundly → skipped, never a false agreed/diverged.
    return { kind: "skipped", detail: "guest-no-tally" }
  }
  // ASYNC GUARD (runtime side): the guest observed a Promise/thenable result on ≥1 input —
  // its value can't be soundly compared (`canon` equates every promise as "{}"), so skip
  // rather than emit a spurious preserved/changed. Catches an ordinary fn returning a
  // promise (no `async` keyword for the source-side gate above to see).
  if (first.thenable) {
    return { kind: "skipped", detail: "async-result" }
  }
  if (first.diverge < 1) {
    // Every input produced equal output → behavior PRESERVED on this battery (the
    // FP-safety floor: a behavior-preserving change never "diverges").
    return { kind: "agreed", detail: "no-divergence-found", agree: first.agree }
  }
  // Determinism: re-run the full battery and require the SAME tally + sample. A flaky
  // tally means we can't soundly call it changed → skipped.
  const second = parseTally(await runInSandbox(source, { battery }, caps))
  if (
    second === null ||
    second.agree !== first.agree ||
    second.diverge !== first.diverge ||
    sampleKey(first.sample) !== sampleKey(second.sample)
  ) {
    return { kind: "skipped", detail: "flaky-divergence" }
  }
  return {
    kind: "diverged",
    detail: `logic-divergence:agree=${first.agree}:diverge=${first.diverge}`,
    agree: first.agree,
    diverge: first.diverge,
    sample: first.sample,
  }
}

/** Max chars of a single side's serialized output kept in a `changed` sample (the guest
 *  keys are `V:<canon-json>` / `E:<errorName>`; cap each so the API response stays small). */
const MAX_SAMPLE_CHARS = 200

/** Truncate a single sample side to {@link MAX_SAMPLE_CHARS}, with an ellipsis marker so a
 *  truncated value is unambiguous. `sample` is `{i,buggy,fixed}` from the guest tally. */
function truncateSampleSide(value: unknown): string {
  const s = typeof value === "string" ? value : sampleKey(value)
  return s.length <= MAX_SAMPLE_CHARS ? s : `${s.slice(0, MAX_SAMPLE_CHARS)}…`
}

/** Render the first-divergence sample into a small {input, beforeOut, afterOut} triple
 *  (each side capped) for the `changed` API response, or undefined when no usable sample. */
function renderSample(
  sample: Tally["sample"],
  battery: unknown[][],
): { input: string; beforeOut: string; afterOut: string } | undefined {
  if (sample === null || typeof sample !== "object") return undefined
  const s = sample as { i?: unknown; buggy?: unknown; fixed?: unknown }
  const idx = typeof s.i === "number" ? s.i : -1
  const inputTuple = idx >= 0 && idx < battery.length ? battery[idx] : undefined
  return {
    input: truncateSampleSide(inputTuple === undefined ? null : inputTuple),
    beforeOut: truncateSampleSide(s.buggy ?? null),
    afterOut: truncateSampleSide(s.fixed ?? null),
  }
}

/** The public oracle verdict. `changed` = behavioral divergence OBSERVED; `preserved` =
 *  every battery input agreed; `skipped` = couldn't be run soundly (see `detail`). */
export interface ComparePairResult {
  verdict: "changed" | "preserved" | "skipped"
  /** A stable machine-readable tag describing the branch (e.g. `no-buggy-fn`,
   *  `logic-divergence:agree=…:diverge=…`, `array-ctor-rewrite`, `arity-mismatch:…`). */
  detail: string
  /** Wall-clock time the comparison took, in ms. */
  elapsedMs: number
  /** Present ONLY on `changed`: the first divergence (input + both outputs, each capped). */
  sample?: { input: string; beforeOut: string; afterOut: string }
}

/** Options for {@link comparePairInSandbox}. */
export interface ComparePairOptions {
  /** Sandbox-cap override (defaults to {@link PURELOGIC_PAIR_CAPS}). */
  caps?: SandboxCaps
}

/**
 * THE /v1/verify ORACLE. Given a function's source BEFORE and AFTER an edit, lift both,
 * run them side-by-side over the type-aware battery in the sealed QuickJS sandbox, and
 * report whether the edit CHANGED behavior, PRESERVED it, or was SKIPPED — confirmed by a
 * deterministic re-run. See the file header: `changed` means "the sandbox OBSERVED
 * behavioral divergence over the battery", NOT "the AFTER is a correct fix". NEVER throws —
 * any unexpected failure resolves to `skipped`, never a false changed/preserved.
 *
 * @param before the function source BEFORE the edit (a single top-level pure function).
 * @param after the function source AFTER the edit (same arity).
 * @param opts optional sandbox-cap override.
 */
export async function comparePairInSandbox(
  before: string,
  after: string,
  opts: ComparePairOptions = {},
): Promise<ComparePairResult> {
  const caps = opts.caps ?? PURELOGIC_PAIR_CAPS
  const start = Date.now()
  const elapsed = (): number => Date.now() - start
  try {
    const buggy = liftFunction([before])
    const fixed = liftFunction([after])
    if (buggy === null || fixed === null) {
      return { verdict: "skipped", detail: buggy === null ? "no-buggy-fn" : "no-fixed-fn", elapsedMs: elapsed() }
    }
    const cmp = await compareLiftedPair({ buggy, fixed }, caps)
    if (cmp.kind === "agreed") return { verdict: "preserved", detail: cmp.detail, elapsedMs: elapsed() }
    if (cmp.kind === "skipped") return { verdict: "skipped", detail: cmp.detail, elapsedMs: elapsed() }
    // Re-derive the battery to map the sample index → its input tuple (the guest stored
    // only the index; the battery itself is deterministic for the same lifted expr).
    const battery = buildBattery(buggy.paramTypes, numericLiteralsFrom(buggy.expr))
    const sample = renderSample(cmp.sample, battery)
    return { verdict: "changed", detail: cmp.detail, elapsedMs: elapsed(), ...(sample !== undefined ? { sample } : {}) }
  } catch (err) {
    return { verdict: "skipped", detail: `error:${err instanceof Error ? err.name : "unknown"}`, elapsedMs: elapsed() }
  }
}
