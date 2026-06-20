// SIG-477 PR-4 — the SECOND execution harness: pure-function logic divergence.
//
// The reproduce wedge for the pure/IO-free slice (off-by-one / fence-post / boundary
// / coercion bugs) whose failure is a WRONG RETURN VALUE — re-runnable as a
// deterministic two-sided test. It lifts BOTH the finding's BUGGY function and the
// model's SUGGESTED FIX, runs them side-by-side over a battery of boundary inputs in
// the QuickJS sandbox (PR-2's `runInSandbox`), and observes whether they DIVERGE — so
// a `reproduced` verdict means "we ran both and the buggy code returns a different
// value at a boundary input", never a model judgment.
//
// ── WHY THIS WEDGE, NOT ReDoS ───────────────────────────────────────────────
// The ReDoS harness (the design's "cleanest" wedge) does NOT reproduce in QuickJS:
// its regex engine (libregexp) ≠ V8's, so a V8-catastrophic regex isn't necessarily
// catastrophic in QuickJS, and a regex match is a single C call the cycle-interrupt
// can't subdivide (live probes returned `inconclusive` on textbook catastrophic
// regexes, twice). Pure-function logic is strictly more robust: the output of a pure
// function is ENGINE-INDEPENDENT (identical in QuickJS and V8), the signal is a
// DETERMINISTIC OUTPUT COMPARISON (no timeout/flakiness), and a runaway buggy loop is
// BYTECODE — exactly what the opcode-cycle interrupt CAN bound.
//
// ── THE HONEST DECISION (a deterministic TWO-SIDED test) ────────────────────
// A finding is "reproduced" ONLY when the buggy and fixed functions:
//   (1) AGREE on at least one battery input — they're the SAME function bar a
//       targeted defect (not two unrelated functions / a wholesale rewrite); AND
//   (2) DIVERGE on at least one battery input — the buggy code demonstrably returns
//       a different value somewhere (the off-by-one / fence-post signature: same
//       behavior except at a boundary); AND
//   (3) the tally REPRODUCES on a re-run (determinism — pure code is deterministic by
//       construction since the eligibility gate refused Date/random, but a re-run
//       catches anything that slipped).
// all-AGREE → INCONCLUSIVE (the fix is a no-op on our battery — can't demonstrate the
// bug); all-DIVERGE → INCONCLUSIVE (a wholesale rewrite or a mismatched function
// pair, not a targeted bug — FP-safe). The harness NEVER refutes and NEVER throws.

import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import { parseSource, type SourceExt, type AstNode } from "@/src/features/ast-rules"
import { runInSandbox, type SandboxCaps, type SandboxResult } from "./sandbox-runner"

/** The cited-code fields the harness reads. All optional — a finding may carry any
 *  subset (the eligibility gate ensured at least one holds liftable code). Buggy code
 *  is lifted from the BUGGY-biased fields (failureExample / astEvidence / body
 *  fences); the corrected function is lifted from the FIX fields (suggestedReplacement
 *  / fixExample) — the harness needs BOTH to form the two-sided test. */
export interface PureLogicHarnessInput {
  failureExample?: PrReviewFinding["failureExample"]
  astEvidence?: PrReviewFinding["astEvidence"]
  suggestedReplacement?: PrReviewFinding["suggestedReplacement"]
  fixExample?: PrReviewFinding["fixExample"]
  body?: PrReviewFinding["body"]
}

/** The harness outcome. `reproduced` = the two-sided test fired (agree + diverge,
 *  deterministically); `inconclusive` = we could NOT demonstrate a targeted
 *  divergence (no-divergence / wholesale / flaky / guest-error — NEVER a refutation);
 *  `skipped` = nothing to run (no liftable buggy+fixed pair, arity mismatch) or a
 *  fail-safe on any unexpected error. `detail` is a stable machine-readable tag. */
export interface PureLogicHarnessResult {
  status: "reproduced" | "inconclusive" | "skipped"
  detail: string
  elapsedMs: number
}

/** A liftable function pulled from a cited snippet: an EXPRESSION text usable as a
 *  value (a declaration is wrapped so it yields the function), plus its param arity. */
interface LiftedFunction {
  expr: string
  arity: number
}

/** Per-run sandbox caps. A pure-function battery is BYTECODE, so the opcode-cycle
 *  interrupt (maxInterrupts) is the real bound — a runaway buggy loop is cut by the
 *  counter even on Cloudflare's frozen clock. Battery + arity are kept small so a
 *  benign battery finishes well under the cap while a true infinite loop trips it. */
const HARNESS_DEADLINE_MS = 500
const HARNESS_MAX_INTERRUPTS = 100_000
const HARNESS_CAPS: SandboxCaps = {
  memoryBytes: 32 * 1024 * 1024,
  maxStackBytes: 256 * 1024,
  deadlineMs: HARNESS_DEADLINE_MS,
  maxInterrupts: HARNESS_MAX_INTERRUPTS,
}

/** HARD wall-clock cap on a SINGLE harness invocation (two full-battery sandbox runs,
 *  each bounded by the caps above). The per-run figure the caller's per-PR budget
 *  reserves, so the aggregate ceiling is HONEST. */
export const PURELOGIC_HARNESS_MAX_TOTAL_MS = 2_000

/** Max function arity we form a battery for (>3 → combinatorial blow-up; off-by-one /
 *  fence-post bugs are overwhelmingly 1-2 arg functions). */
const MAX_ARITY = 3
/** Cap on battery size (bounds the in-guest loop → keeps opcode cost under the cycle
 *  cap; ~165 small calls is far under HARNESS_MAX_INTERRUPTS). Sized to admit the FULL
 *  per-arg anchor sweep for arity ≤ 3 (arity 3 = 3 positions × 3 anchors × 19 pool ≈
 *  165 before dedup). */
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

/** Representative "other-arg" values held fixed while one position sweeps the pool:
 *  a small number, a non-trivial string, and a non-trivial array. Sweeping each
 *  position against each anchor guarantees a single-arg off-by-one is exercised with
 *  meaningful partners (a length-defined string/array and a small index/count). */
const ANCHORS: readonly unknown[] = [1, "ab", [1, 2, 3]]

/** Build the arg-tuple battery for a given arity. Arity 1 → one tuple per pool value.
 *  Higher arity → a PER-ARG ANCHOR SWEEP: for each position, vary it over the full
 *  pool while holding the other positions at each anchor. This guarantees EVERY arg
 *  position spans the pool against meaningful partners — a cartesian (even sampled)
 *  can starve a position and miss a bug that only manifests on, say, the 3rd arg.
 *  The loops are ordered anchor → value → POSITION (position innermost) so that, if the
 *  MAX_BATTERY cap trims the tail, every position still gets the full-pool sweep against
 *  the earlier anchors — a position-OUTERMOST order would starve the last position. */
function buildBattery(arity: number): unknown[][] {
  if (arity === 1) return SCALAR_POOL.map((v) => [v])
  const battery: unknown[][] = []
  const seen = new Set<string>()
  const add = (tuple: unknown[]): boolean => {
    const key = JSON.stringify(tuple)
    if (seen.has(key)) return true
    seen.add(key)
    battery.push(tuple)
    return battery.length < MAX_BATTERY
  }
  for (const anchor of ANCHORS) {
    for (const v of SCALAR_POOL) {
      for (let p = 0; p < arity; p++) {
        const tuple = new Array(arity).fill(anchor)
        tuple[p] = v
        if (!add(tuple)) return battery
      }
    }
  }
  return battery
}

/** Param arity of a function-ish AST node. */
function paramArity(node: AstNode): number {
  const params = node?.params
  return Array.isArray(params) ? params.length : 0
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
function liftFunction(candidates: readonly string[]): LiftedFunction | null {
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
    return { expr, arity: paramArity(fnNode) }
  }
  return null
}

/** BUGGY-code candidates (the failing function), in preference order: the structured
 *  buggy fields, then the body's code fences, then the raw body. Excludes the FIX
 *  fields (those are the corrected function). */
function buggyCandidates(finding: PureLogicHarnessInput): string[] {
  const parts: string[] = []
  for (const v of [finding.failureExample, finding.astEvidence]) {
    if (typeof v === "string" && v.trim().length > 0) parts.push(v)
  }
  const body = typeof finding.body === "string" ? finding.body : ""
  const fence = /```[a-z]*\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = fence.exec(body)) !== null) {
    if (m[1] && m[1].trim().length > 0) parts.push(m[1])
  }
  if (body.trim().length > 0) parts.push(body)
  return parts
}

/** FIXED-code candidates (the corrected function): the structured fix fields only.
 *  The committable `suggestedReplacement` is the canonical corrected variant. */
function fixedCandidates(finding: PureLogicHarnessInput): string[] {
  const parts: string[] = []
  for (const v of [finding.suggestedReplacement, finding.fixExample]) {
    if (typeof v === "string" && v.trim().length > 0) parts.push(v)
  }
  return parts
}

/**
 * Build the sandbox guest that defines the two lifted functions and runs the battery,
 * tallying agree/diverge. Each call gets a DEEP-CLONED copy of its args (so a function
 * that mutates an array argument can't poison the other side's call or a later tuple).
 * A return value is keyed `"V:"+JSON.stringify(out)`; a throw is keyed `"E:"+name`, so
 * "both throw the same error" counts as AGREE (not a spurious divergence). The last
 * expression is the `{agree,diverge,sample}` object → `runInSandbox` dumps it.
 */
function buildHarnessSource(buggyExpr: string, fixedExpr: string): string {
  return (
    `const __B__=${buggyExpr};` +
    `const __F__=${fixedExpr};` +
    `const A=__INPUT__.battery;` +
    `let agree=0,diverge=0,sample=null;` +
    `for(let i=0;i<A.length;i++){` +
    `var bk,fk;` +
    `try{bk="V:"+JSON.stringify(__B__.apply(null,JSON.parse(JSON.stringify(A[i]))));}catch(e){bk="E:"+((e&&e.name)?e.name:"err");}` +
    `try{fk="V:"+JSON.stringify(__F__.apply(null,JSON.parse(JSON.stringify(A[i]))));}catch(e){fk="E:"+((e&&e.name)?e.name:"err");}` +
    `if(bk===fk){agree++;}else{diverge++;if(sample===null){sample={i:i,buggy:bk,fixed:fk};}}` +
    `}` +
    `({agree:agree,diverge:diverge,sample:sample})`
  )
}

/** The agree/diverge tally parsed from a sandbox run, or null when the guest didn't
 *  return a clean tally (timed-out / threw / oom / malformed). */
interface Tally {
  agree: number
  diverge: number
  sample: unknown
}

function parseTally(res: SandboxResult): Tally | null {
  if (res.status !== "ok") return null
  const v = res.value
  if (v === null || typeof v !== "object") return null
  const o = v as { agree?: unknown; diverge?: unknown; sample?: unknown }
  if (typeof o.agree !== "number" || typeof o.diverge !== "number") return null
  return { agree: o.agree, diverge: o.diverge, sample: o.sample ?? null }
}

/** Stable string key for a divergence sample (for the determinism re-run compare). */
function sampleKey(sample: unknown): string {
  try {
    return JSON.stringify(sample) ?? "null"
  } catch {
    return "unstringifiable"
  }
}

/**
 * Run the pure-function-logic harness on ONE finding. NEVER throws; returns a
 * structured {@link PureLogicHarnessResult}. See the module header for the two-sided
 * decision and the never-reproduced-without-agreement guard.
 *
 * @param finding the submitted finding (its buggy + fix code is lifted).
 * @param caps optional sandbox-cap override (defaults to the harness caps).
 */
export async function runPureLogicHarness(
  finding: PureLogicHarnessInput,
  caps: SandboxCaps = HARNESS_CAPS,
): Promise<PureLogicHarnessResult> {
  const start = Date.now()
  const elapsed = (): number => Date.now() - start
  try {
    const buggy = liftFunction(buggyCandidates(finding))
    const fixed = liftFunction(fixedCandidates(finding))
    if (buggy === null || fixed === null) {
      return { status: "skipped", detail: buggy === null ? "no-buggy-fn" : "no-fixed-fn", elapsedMs: elapsed() }
    }
    if (buggy.arity !== fixed.arity) {
      return { status: "skipped", detail: `arity-mismatch:${buggy.arity}!=${fixed.arity}`, elapsedMs: elapsed() }
    }
    if (buggy.arity < 1 || buggy.arity > MAX_ARITY) {
      return { status: "skipped", detail: `arity-out-of-range:${buggy.arity}`, elapsedMs: elapsed() }
    }
    const battery = buildBattery(buggy.arity)
    if (battery.length === 0) {
      return { status: "skipped", detail: "empty-battery", elapsedMs: elapsed() }
    }
    const source = buildHarnessSource(buggy.expr, fixed.expr)

    const first = parseTally(await runInSandbox(source, { battery }, caps))
    if (first === null) {
      return { status: "inconclusive", detail: "guest-no-tally", elapsedMs: elapsed() }
    }
    // Two-sided: AGREE on ≥1 AND DIVERGE on ≥1 = a targeted behavioral difference.
    // all-agree → can't demonstrate (no-divergence-found); all-diverge → wholesale
    // rewrite / mismatched pair → inconclusive (FP-safe; the harness NEVER refutes).
    if (first.agree < 1 || first.diverge < 1) {
      return {
        status: "inconclusive",
        detail: first.diverge < 1 ? "no-divergence-found" : "wholesale-divergence",
        elapsedMs: elapsed(),
      }
    }
    // Determinism: re-run the full battery and require the SAME tally + sample.
    const second = parseTally(await runInSandbox(source, { battery }, caps))
    if (
      second === null ||
      second.agree !== first.agree ||
      second.diverge !== first.diverge ||
      sampleKey(first.sample) !== sampleKey(second.sample)
    ) {
      return { status: "inconclusive", detail: "flaky-divergence", elapsedMs: elapsed() }
    }
    return {
      status: "reproduced",
      detail: `logic-divergence:agree=${first.agree}:diverge=${first.diverge}`,
      elapsedMs: elapsed(),
    }
  } catch (err) {
    return { status: "skipped", detail: `error:${err instanceof Error ? err.name : "unknown"}`, elapsedMs: elapsed() }
  }
}
