// SIG-328: logic-claim refutation gate (deterministic FP precision layer).
//
// The logic specialist (deepseek-v4-pro) is a strong reasoner but has a handful
// of stable priors that prompt-tuning did not fully dislodge. Each case below
// is dropped only when it is PROVABLY FALSE against the AST:
//   1. "next() runs unconditionally after the 403 / double-response" — but the
//      guard branch ends in `return res.status(403).end()`, so the tail is the
//      else-path, reached only when authorized.
//   2. "read-check-write race / TOCTOU" — but the code is SYNCHRONOUS: no
//      `await`/`yield`/callback between the check and the in-memory write, so
//      nothing can interleave in single-threaded JS.
//   3. "retry/redelivery double-charges despite a visible idempotency key" —
//      but the side-effect call carries a stable idempotency/dedup option, so
//      the same-delivery retry hypothesis is refuted. Distinct-event/domain
//      duplicates fail open.
//   4. "user input is compiled into a regex / ReDoS" — but the exact cited
//      statement only passes the quoted value through a literal string
//      substring API (`includes`/`startsWith`/`endsWith`/`indexOf`), and the
//      enclosing function contains no actual regex surface.
//
// Consensus filtering (PR2) cannot kill these — they are STABLE, not flickery.
// This gate fact-checks each high-severity logic finding against the cited
// source and DROPS it ONLY when it can POSITIVELY prove the claim false. It is
// recall-safe BY CONSTRUCTION: it fails OPEN (keeps the finding) on every
// ambiguity — missing source, parse error, no enclosing function, any async/
// closure/IO boundary it cannot rule out, or an unbound guard. A real bug's
// claim is TRUE (or unprovable), so the gate cannot suppress it.
//
// Codex sign-off (2026-06-05) shaped the first two rules: control-flow requires a
// same-block, unconditionally-terminating guard PLUS subject binding (the guard
// must reference an identifier the finding complains about — mirroring the
// SIG-327 window-blindness gate); sync-race requires a visible in-memory
// read-check-write pair with NO async/closure/timer/IO boundary, else fail open.
//
// SHADOW-FIRST: the drop is gated behind `OPENCLAW_LOGIC_CLAIM_REFUTATION_MODE`
// (off | shadow | enforce, default off in code / shadow in wrangler) at the
// call site. This module is pure and mode-agnostic.

import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import { parseSource, type SourceExt, type AstCache } from "@/src/features/ast-rules"
import { extractCitedIdentifiers } from "./validate-window-blindness"
import { matchesBalanceSignClaim, refutesBalanceSignClaim } from "./balance-sign-refuter"

export type LogicClaimRefutationMode = "off" | "shadow" | "enforce"

/** Parse `OPENCLAW_LOGIC_CLAIM_REFUTATION_MODE`. Unknown/missing → `off`. */
export function parseLogicClaimRefutationMode(raw: string | undefined): LogicClaimRefutationMode {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "shadow") return "shadow"
  if (v === "enforce") return "enforce"
  return "off"
}

/** Mirrors the SIG-109/308 sev>=4 bar — a high-sev logic blocker on safe code is the costly FP. */
export const LOGIC_CLAIM_REFUTATION_MIN_SEVERITY = 4

export type LogicClaimDropReason =
  | "control-flow-claim-refuted-by-guard"
  | "sync-race-claim-refuted-no-async-boundary"
  | "idempotency-claim-refuted-by-visible-key"
  | "regex-substring-claim-refuted-by-literal-string-filter"
  | "unused-claim-refuted-identifier-is-referenced"
  | "missing-return-type-claim-refuted-annotation-present"
  | "balance-sign-claim-refuted-by-correct-accounting-direction"

/** Runtime list of every drop reason — used to validate the enforce-reason allowlist. */
export const LOGIC_CLAIM_DROP_REASONS: readonly LogicClaimDropReason[] = [
  "control-flow-claim-refuted-by-guard",
  "sync-race-claim-refuted-no-async-boundary",
  "idempotency-claim-refuted-by-visible-key",
  "regex-substring-claim-refuted-by-literal-string-filter",
  "unused-claim-refuted-identifier-is-referenced",
  "missing-return-type-claim-refuted-annotation-present",
  "balance-sign-claim-refuted-by-correct-accounting-direction",
]

/**
 * Parse `OPENCLAW_LOGIC_CLAIM_REFUTATION_ENFORCE_REASONS` (comma list of drop
 * reasons). UNSET (`undefined`) → `undefined` = enforce EVERY reason (the
 * pre-SIG-392 behavior). SET (even empty) → a Set: in `enforce` mode ONLY the
 * listed reasons drop; unlisted reasons stay shadow. Unknown tokens are ignored.
 */
export function parseLogicClaimRefutationEnforceReasons(
  raw: string | undefined,
): ReadonlySet<LogicClaimDropReason> | undefined {
  if (raw === undefined) return undefined
  const valid = new Set<string>(LOGIC_CLAIM_DROP_REASONS)
  const out = new Set<LogicClaimDropReason>()
  for (const tok of raw.split(",")) {
    const t = tok.trim()
    if (valid.has(t)) out.add(t as LogicClaimDropReason)
  }
  return out
}

export type LogicClaimRefutationDecision = { keep: true } | { keep: false; reason: LogicClaimDropReason }

export interface LogicClaimRefutationContext {
  /** Full source of changed files (same map the AST floors use). */
  fullFileByPath: ReadonlyMap<string, string>
  /**
   * SIG-336: optional per-review parse-once cache. When provided, the cited file
   * is acorn-parsed at most ONCE per review across all findings (and the shared
   * 500KB large-file guard applies) instead of re-parsing per finding. Absent
   * (e.g. standalone unit tests) → parse directly. Either way the gate fails open
   * on a parse failure or large-file skip, so behavior is unchanged.
   */
  astCache?: AstCache
}

// --- claim-shape detection -------------------------------------------------

// A finding whose text asserts a control-flow reachability claim we can check
// against an early-return guard. The broad "bypasses the guard" shape Codex
// flagged as over-broad is deliberately EXCLUDED.
const CONTROL_FLOW_CLAIM_RE =
  /\b(?:unconditional(?:ly)?|unreachable|dead\s+code|double[-\s]?response|responds?\s+twice|sends?\s+(?:two|a\s+second)\s+response|runs?\s+(?:regardless|anyway)|never\s+reached|always\s+(?:runs|executes|called))\b/i

// A finding asserting a TOCTOU / read-check-write race.
const SYNC_RACE_CLAIM_RE =
  /\b(?:race\s+condition|toctou|time[-\s]?of[-\s]?check|read[-\s]?(?:modify|check)[-\s]?(?:write|act)|check[-\s]?then[-\s]?act|non[-\s]?atomic|lost\s+update|concurrent\s+(?:withdrawal|update|write|deduction|access))\b/i

// A finding asserting a retry/redelivery duplicate side effect that a visible
// stable idempotency / dedup key can refute. Tight to retry/redelivery wording:
// a different logical-operation duplicate still needs a domain-state guard.
const IDEMPOTENCY_RETRY_CLAIM_RE =
  /\b(?:retry|retried|redeliver(?:y|ed|s)?|replay(?:ed|s)?|webhook\s+replay|duplicate\s+(?:processing|delivery))\b/i

const DISTINCT_ID_CLAIM_RE =
  /\b(?:different|distinct|fresh|new)\s+(?:event|message|delivery|attempt)?\s*\.?\s*id\b|\b(?:event|message|delivery|attempt)\.id\b[^.\n]{0,80}\b(?:different|distinct|fresh|new)\b/i

const UNSTABLE_IDEMPOTENCY_VALUE_RE =
  /\b(?:crypto\.randomUUID|randomUUID|Math\.random|Date\.now|new\s+Date|timestamp|nonce)\b/i

const UNSTABLE_IDEMPOTENCY_CONTEXT_RE =
  /\b(?:(?:fresh|different|distinct|unique|new)\s+(?:event|message|delivery|attempt|webhook)s?\s*\.?\s*id|(?:event|message|delivery|attempt)\.id\b[\s\S]{0,240}\b(?:fresh|different|distinct|unique|new|varies|changes|unstable|not\s+stable)|\bid\s+(?:changes|varies)\s+(?:on|per|across)\s+(?:retry|redelivery|delivery|attempt)|different\s+webhook\s+events?[\s\S]{0,240}\bsame\s+(?:order|operation)|same\s+(?:order|operation)[\s\S]{0,240}\bdifferent\s+webhook\s+events?)\b/i

const STABLE_IDEMPOTENCY_VALUE_PATH_RE = /\b(?:event|msg|message|delivery)\.id\b/i
const FAIL_OPEN_IDEMPOTENCY_VALUE_PATH_RE = /\b(?:request|order)\.id\b/i

// A finding asserting an identifier is unused/never-referenced. Loose on purpose
// (just the TRIGGER); the AST refuter is the real guard and fails open. Tolerates
// a back-ticked symbol between the keyword and the noun ("unused `req` parameter").
const UNUSED_CLAIM_RE =
  /\b(?:unused|never\s+(?:used|referenced)|not\s+(?:used|referenced))\b[^.\n]{0,24}?\b(?:variable|parameter|argument|import|binding|field|property)\b|\b(?:variable|parameter|argument|import|binding|field|property)\b[^.\n]{0,24}?\bis\s+(?:never\s+(?:used|referenced)|unused|not\s+(?:used|referenced))\b/i

// A finding asserting a (return) type ANNOTATION is missing. Tightened
// (code-reviewer P2) to require the word "annotation"/"declaration" so a real
// bug like "missing the return type GUARD before the await" does NOT trigger.
const MISSING_RETURN_TYPE_CLAIM_RE =
  /\breturn[\s-]type\s+(?:annotation|declaration)\b[^.\n]{0,24}?\b(?:is\s+)?(?:missing|absent|not\s+(?:declared|specified|present|annotated))\b|\bmissing\s+(?:a\s+|an\s+|the\s+)?(?:explicit\s+)?return[\s-]type\s+(?:annotation|declaration)\b/i

// A finding asserting regex / RegExp / ReDoS risk. The refuter below is much
// tighter than this trigger: it only fires when the exact cited statement is a
// string-only substring operation on quoted claim identifiers, with no regex
// surface in the enclosing function.
const REGEX_SUBSTRING_CLAIM_RE =
  /\b(?:re-?dos|regex|regexp|regular\s+expression|dynamic\s+pattern|catastrophic\s+backtracking)\b/i

const REGEX_ELSEWHERE_CLAIM_RE =
  /\b(?:elsewhere|outside|later|another|separate|different)\b[^.\n]{0,48}\b(?:function|file|path|branch|call|helper|statement|line|block)\b|\b(?:function|file|path|branch|call|helper|statement|line|block)\b[^.\n]{0,48}\b(?:elsewhere|outside|later|another|separate|different)\b/i

function findingText(f: PrReviewFinding): string {
  return `${f.headline} ${f.body}`
}

// --- tiny ESTree helpers (acorn nodes; loc.start/end.line present) ---------

type Node = any

function spans(node: Node, line: number): boolean {
  return (
    node &&
    node.loc &&
    typeof node.loc.start?.line === "number" &&
    typeof node.loc.end?.line === "number" &&
    node.loc.start.line <= line &&
    line <= node.loc.end.line
  )
}

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"])

/** Recursively visit every node, calling cb(node). Arrays + nested nodes only. */
function eachNode(node: Node, cb: (n: Node) => void): void {
  if (!node || typeof node.type !== "string") return
  cb(node)
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "range") continue
    const child = node[key]
    if (Array.isArray(child)) {
      for (const c of child) if (c && typeof c.type === "string") eachNode(c, cb)
    } else if (child && typeof child.type === "string") {
      eachNode(child, cb)
    }
  }
}

/** The SMALLEST function node whose body spans `line`. */
function enclosingFunctions(ast: Node, line: number): Node[] {
  const matches: Node[] = []
  eachNode(ast, (n) => {
    if (!FUNCTION_TYPES.has(n.type)) return
    if (!spans(n, line)) return
    matches.push(n)
  })
  matches.sort((a, b) => a.loc.end.line - a.loc.start.line - (b.loc.end.line - b.loc.start.line))
  return matches
}

/** Is this statement an unconditional terminator at the top level of its branch? */
function terminatesUnconditionally(stmt: Node): boolean {
  if (!stmt) return false
  if (stmt.type === "ReturnStatement" || stmt.type === "ThrowStatement") return true
  // `if (c) { ...; return }` as the consequent — the consequent BlockStatement
  // terminates iff its LAST statement terminates (top-level, not nested in a fn).
  if (stmt.type === "BlockStatement") {
    const body = stmt.body
    return Array.isArray(body) && body.length > 0 && terminatesUnconditionally(body[body.length - 1])
  }
  return false
}

/** All statement-list bodies (Program/Block) reachable WITHOUT crossing into a nested function. */
function statementBlocks(fnBody: Node): Node[][] {
  const blocks: Node[][] = []
  const visit = (n: Node): void => {
    if (!n || typeof n.type !== "string") return
    if (Array.isArray(n.body) && (n.type === "BlockStatement" || n.type === "Program")) {
      blocks.push(n.body)
    }
    for (const key of Object.keys(n)) {
      if (key === "loc" || key === "start" || key === "end" || key === "range") continue
      const child = n[key]
      if (Array.isArray(child)) {
        for (const c of child) {
          if (c && typeof c.type === "string" && !FUNCTION_TYPES.has(c.type)) visit(c)
        }
      } else if (child && typeof child.type === "string" && !FUNCTION_TYPES.has(child.type)) {
        visit(child)
      }
    }
  }
  visit(fnBody)
  return blocks
}

function nodeSourceLines(node: Node, lines: string[]): string {
  if (!node?.loc) return ""
  const s = Math.max(1, node.loc.start.line)
  const e = Math.min(lines.length, node.loc.end.line)
  return lines.slice(s - 1, e).join(" ")
}

// --- the two refuters ------------------------------------------------------

/**
 * Refute a control-flow reachability claim. TRUE only when: the cited statement
 * has a PRECEDING SIBLING `if (cond) { ...return/throw }` (no `else`) in the
 * SAME block — so the cited statement is the guarded else-path, not
 * "unconditional"/"unreachable"/"double-response" — AND the guard is bound to
 * the finding's subject (an identifier the guard references also appears in the
 * finding text). Anything else → not proven → keep.
 */
function refutesControlFlow(fn: Node, line: number, finding: PrReviewFinding, lines: string[]): boolean {
  const findingIds = new Set(extractCitedIdentifiers(findingText(finding)))
  if (findingIds.size === 0) return false
  for (const block of statementBlocks(fn.body ?? fn)) {
    const citedIdx = block.findIndex((s) => spans(s, line))
    if (citedIdx <= 0) continue
    // Require the IMMEDIATELY-preceding sibling to be the terminating guard, so
    // it genuinely separates the cited tail (the auth `return res.status(403)`
    // case). An UNRELATED earlier guard with sends between it and the cited line
    // has a non-`if` statement directly before the cited line, so it's excluded.
    const prev = block[citedIdx - 1]
    if (!prev || prev.type !== "IfStatement") continue
    if (prev.alternate) continue // simple guard only (no else)
    if (!terminatesUnconditionally(prev.consequent)) continue
    // SIG-328 await-awareness: a guard whose condition relies on an UN-awaited
    // call is unprovable — a missing `await` (a Promise used as a boolean is
    // always truthy/falsy) makes the guard dead, which IS the bug we must not
    // refute (`if (!svc.isAdmin(req)) return 403` without await → auth bypass).
    // Fail open; an awaited call in the condition is effective and still refutes.
    if (guardTestHasUnawaitedCall(prev.test)) continue
    // subject binding: the finding must complain about an identifier in the
    // cited statement or the guard (so we don't refute via a coincidental guard).
    const citedStmt = block[citedIdx]
    const boundIds = [
      ...extractCitedIdentifiers(nodeSourceLines(citedStmt, lines)),
      ...extractCitedIdentifiers(nodeSourceLines(prev, lines)),
    ]
    if (!boundIds.some((id) => findingIds.has(id))) continue
    // PRIOR-ACTION CHECK (code-reviewer P1): the early-return guard only proves
    // the cited tail is the else-path — NOT that the flagged action hasn't
    // ALREADY happened. `res.json(a); if (x) return; res.json(b)` double-responds
    // on the !x path. Statements BEFORE the guard are on the same path as the
    // tail. The guard consequent is mutually exclusive with the tail, but if it
    // repeats the same cited tail action, fail open rather than suppress a
    // possible "called twice in this handler" claim.
    const priorScope: Node[] = block.slice(0, citedIdx - 1)
    if (priorScope.some((n) => containsConflictingCall(n, findingIds))) continue
    const citedActionIds = new Set(callCalleeIdentifiers(citedStmt).filter((id) => findingIds.has(id)))
    if (citedActionIds.size > 0 && containsConflictingCall(prev.consequent, citedActionIds)) continue
    return true
  }
  return false
}

function callCalleeIdentifiers(node: Node): string[] {
  const ids = new Set<string>()
  eachNode(node, (n) => {
    if (n.type !== "CallExpression") return
    let callee = n.callee
    while (callee) {
      if (callee.type === "Identifier") {
        ids.add(callee.name)
        return
      }
      if (callee.type === "MemberExpression") {
        if (callee.property?.type === "Identifier") ids.add(callee.property.name)
        callee = callee.object
      } else if (callee.type === "CallExpression") {
        callee = callee.callee
      } else {
        break
      }
    }
  })
  return [...ids]
}

/** Does `node` contain a CallExpression whose callee identifiers intersect `findingIds`? */
function containsConflictingCall(node: Node, findingIds: Set<string>): boolean {
  let hit = false
  eachNode(node, (n) => {
    if (hit || n.type !== "CallExpression") return
    let callee = n.callee
    // unwrap a member chain: res.status(403).end() → collect res/status/end.
    while (callee) {
      if (callee.type === "Identifier" && findingIds.has(callee.name)) {
        hit = true
        return
      }
      if (callee.type === "MemberExpression") {
        if (callee.property?.type === "Identifier" && findingIds.has(callee.property.name)) {
          hit = true
          return
        }
        callee = callee.object
      } else if (callee.type === "CallExpression") {
        callee = callee.callee
      } else {
        break
      }
    }
  })
  return hit
}

/**
 * SIG-328 await-awareness: TRUE when `test` (a guard condition) contains a
 * CallExpression that is NOT the argument of an `await`. The AST cannot prove a
 * callee is synchronous, and a Promise-returning call used un-awaited in a
 * boolean guard (`if (!svc.isAdmin(req)) return 403`) is always truthy/falsy —
 * the guard is dead and the missing `await` is the bug. So such a guard cannot
 * be trusted to refute a "runs unconditionally" claim; the caller fails open. An
 * awaited call (`await svc.isAdmin(req)`) is effective and does not trip this.
 */
function guardTestHasUnawaitedCall(test: Node): boolean {
  const awaitedCalls = new Set<Node>()
  eachNode(test, (n) => {
    if (n.type === "AwaitExpression" && n.argument?.type === "CallExpression") {
      awaitedCalls.add(n.argument)
    }
  })
  let found = false
  eachNode(test, (n) => {
    if (!found && n.type === "CallExpression" && !awaitedCalls.has(n)) found = true
  })
  return found
}

/**
 * Refute a sync-race claim. TRUE only when the enclosing function is FULLY
 * synchronous with NO interleaving boundary the gate cannot rule out: not
 * `async`, zero `await`/`yield`, zero nested functions/closures, zero
 * `.then/.catch/.finally`, zero timer/microtask scheduling, zero
 * Atomics/SharedArrayBuffer — AND the cited statement is an in-memory
 * member-assignment (`obj.prop -= x` / `obj.prop = ...`) guarded by a preceding
 * `if` testing the SAME member (the visible read-check-write pair). Any async/
 * closure/IO boundary, or an inability to see the in-memory pair → keep.
 */
function refutesSyncRace(fn: Node, line: number): boolean {
  if (fn.async) return false
  let blocked = false
  // Scan the WHOLE function (including nested) for any async/reentrant boundary.
  eachNode(fn.body ?? fn, (n) => {
    if (blocked) return
    if (n === fn) return
    if (n.type === "AwaitExpression" || n.type === "YieldExpression") blocked = true
    else if (FUNCTION_TYPES.has(n.type))
      blocked = true // a nested closure could defer the write
    else if (n.type === "CallExpression" && n.callee?.type === "MemberExpression") {
      const prop = n.callee.property?.name
      if (prop === "then" || prop === "catch" || prop === "finally") blocked = true
    } else if (n.type === "CallExpression" && n.callee?.type === "Identifier") {
      const name = n.callee.name
      if (name === "setTimeout" || name === "setInterval" || name === "setImmediate" || name === "queueMicrotask")
        blocked = true
    } else if (n.type === "Identifier" && (n.name === "Atomics" || n.name === "SharedArrayBuffer")) {
      blocked = true
    }
  })
  if (blocked) return false
  // Find the cited in-memory write: an assignment/update to a MemberExpression.
  let writeMember: Node | null = null
  for (const block of statementBlocks(fn.body ?? fn)) {
    const stmt = block.find((s) => spans(s, line))
    if (!stmt) continue
    eachNode(stmt, (n) => {
      if (writeMember) return
      if (n.type === "AssignmentExpression" && n.left?.type === "MemberExpression") writeMember = n.left
      else if (n.type === "UpdateExpression" && n.argument?.type === "MemberExpression") writeMember = n.argument
    })
    if (writeMember) break
  }
  if (!writeMember) return false
  const wm = writeMember as Node
  const objName = wm.object?.name
  const propName = wm.property?.name
  if (typeof objName !== "string" || typeof propName !== "string") return false
  // Require a preceding `if` that tests the same `obj.prop` (the check half).
  let sawCheck = false
  eachNode(fn.body ?? fn, (n) => {
    if (sawCheck) return
    if (n.type !== "IfStatement") return
    if (n.loc.start.line >= line) return // must precede the write
    eachNode(n.test, (t: Node) => {
      if (t.type === "MemberExpression" && t.object?.name === objName && t.property?.name === propName) {
        sawCheck = true
      }
    })
  })
  return sawCheck
}

function propertyName(prop: Node): string | null {
  if (!prop) return null
  if (prop.type === "Identifier") return prop.name
  if (prop.type === "Literal" && typeof prop.value === "string") return prop.value
  return null
}

function memberPath(node: Node): string | null {
  if (!node) return null
  if (node.type === "Identifier") return node.name
  if (node.type === "MemberExpression") {
    const left = memberPath(node.object)
    const right = propertyName(node.property)
    return left && right ? `${left}.${right}` : null
  }
  return null
}

function stableIdempotencyValue(node: Node, lines: string[]): boolean {
  const src = nodeSourceLines(node, lines)
  if (UNSTABLE_IDEMPOTENCY_VALUE_RE.test(src)) return false
  const path = memberPath(node)
  // Only direct delivery-token member paths refute retry claims. Domain keys
  // (`order.id`) and request-scoped keys (`request.id`) can hide distinct
  // operations or per-attempt IDs, so they deliberately fail open.
  if (path && FAIL_OPEN_IDEMPOTENCY_VALUE_PATH_RE.test(path)) return false
  if (path && STABLE_IDEMPOTENCY_VALUE_PATH_RE.test(path)) return true
  return false
}

function callNearLine(node: Node, line: number): boolean {
  if (!node?.loc) return false
  return node.loc.start.line <= line + 3 && node.loc.end.line >= line - 3
}

function candidateLines(line: number): number[] {
  return [line, line - 1, line + 1].filter((n) => n >= 1)
}

function eachNodeInCurrentFunction(node: Node, cb: (n: Node) => void): void {
  if (!node || typeof node.type !== "string") return
  cb(node)
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "range") continue
    const child = node[key]
    if (Array.isArray(child)) {
      for (const c of child) {
        if (c && typeof c.type === "string" && !FUNCTION_TYPES.has(c.type)) eachNodeInCurrentFunction(c, cb)
      }
    } else if (child && typeof child.type === "string" && !FUNCTION_TYPES.has(child.type)) {
      eachNodeInCurrentFunction(child, cb)
    }
  }
}

function callDistanceFromLine(node: Node, line: number): number {
  if (spans(node, line)) return 0
  if (node.loc.end.line < line) return line - node.loc.end.line
  return node.loc.start.line - line
}

function targetCallNearLine(fn: Node, line: number): Node | null {
  const body = fn.body ?? fn
  if (!body || typeof body.type !== "string") return null
  let best: Node | null = null
  let bestDistance = Infinity
  let ambiguous = false
  eachNodeInCurrentFunction(body, (n) => {
    if (n.type !== "CallExpression" || !callNearLine(n, line)) return
    const distance = callDistanceFromLine(n, line)
    if (!best) {
      best = n
      bestDistance = distance
      ambiguous = false
      return
    }
    if (distance < bestDistance) {
      best = n
      bestDistance = distance
      ambiguous = false
      return
    }
    if (distance === bestDistance) ambiguous = true
  })
  return ambiguous ? null : best
}

function callHasStableIdempotencyOption(call: Node, lines: string[]): boolean {
  for (const arg of call.arguments ?? []) {
    if (!arg || arg.type !== "ObjectExpression") continue
    for (const p of arg.properties ?? []) {
      if (!p || p.type !== "Property") continue
      const key = propertyName(p.key)
      if (!key || !/\b(?:idempotency|dedup)/i.test(key)) continue
      if (stableIdempotencyValue(p.value, lines)) return true
    }
  }
  return false
}

/**
 * Refute a retry/redelivery duplicate-side-effect claim. TRUE only when the
 * finding itself is a retry/redelivery claim (not a distinct-event/domain-state
 * claim), and the cited function has a nearby call with a stable idempotency /
 * dedup option such as `{ idempotencyKey: event.id }`. Fail open for unstable
 * keys (`randomUUID`, timestamps, nonce) and for visible text saying the id is
 * fresh/different per attempt.
 */
function refutesIdempotencyRetryClaim(fn: Node, line: number, finding: PrReviewFinding, lines: string[]): boolean {
  const text = findingText(finding)
  if (!IDEMPOTENCY_RETRY_CLAIM_RE.test(text)) return false
  if (DISTINCT_ID_CLAIM_RE.test(text)) return false
  const fnText = nodeSourceLines(fn, lines)
  if (UNSTABLE_IDEMPOTENCY_CONTEXT_RE.test(fnText)) return false

  const call = targetCallNearLine(fn, line)
  return call ? callHasStableIdempotencyOption(call, lines) : false
}

function statementsSpanningLine(fn: Node, line: number): Node[] {
  const seen = new Set<Node>()
  const statements: Node[] = []
  for (const block of statementBlocks(fn.body ?? fn)) {
    for (const stmt of block) {
      if (!spans(stmt, line) || seen.has(stmt)) continue
      seen.add(stmt)
      statements.push(stmt)
    }
  }
  return statements
}

function substringProofNodesSpanningLine(fn: Node, line: number): Node[] {
  const nodes = statementsSpanningLine(fn, line)
  const body = fn.body
  if (body && body.type !== "BlockStatement" && spans(body, line) && !nodes.includes(body)) {
    nodes.push(body)
  }
  return nodes
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function lineContainsAnyIdentifier(lines: readonly string[], line: number, ids: ReadonlySet<string>): boolean {
  const text = lines[line - 1] ?? ""
  return [...ids].some((id) => new RegExp(`\\b${escapeRegExp(id)}\\b`).test(text))
}

function candidateLinesWhenUnanchored(
  fn: Node,
  line: number,
  lines: readonly string[],
  finding: PrReviewFinding,
): number[] {
  const ids = new Set(extractCitedIdentifiers(findingText(finding)))
  const spanning = statementsSpanningLine(fn, line)
  if (spanning.some((stmt) => lineContainsAnyIdentifier(lines, stmt.loc.end.line, ids))) return [line]
  return candidateLines(line).filter(
    (candidate) => candidate === line || lineContainsAnyIdentifier(lines, candidate, ids),
  )
}

const BACKTICK_IDENT_RE = /[`'"]([A-Za-z_$][\w$]*)[`'"]/g
const STRING_ONLY_SUBSTRING_METHODS = new Set(["includes", "startsWith", "endsWith", "indexOf"])
const REGEX_SURFACE_METHODS = new Set(["test", "exec", "match", "matchAll", "search"])

/**
 * Refute an "unused identifier" claim. The finding names a symbol (back-tick /
 * quote quoted); if that symbol is REFERENCED inside the enclosing function
 * (appears more than once — declaration + >=1 use), the "unused" claim is FALSE.
 * Refute only when we can see the use; if the symbol appears 0-1 times (genuinely
 * unused, or not found) → keep.
 */
function refutesUnused(fn: Node, finding: PrReviewFinding): boolean {
  const named = new Set<string>()
  for (const m of findingText(finding).matchAll(BACKTICK_IDENT_RE)) named.add(m[1] as string)
  if (named.size === 0) return false
  // Count name-matching Identifiers WITHOUT descending into NESTED functions
  // (code-reviewer P1): a same-named binding in a nested closure must not inflate
  // the outer symbol's count and wrongly refute a genuinely-unused outer var. A
  // legitimate use inside a nested closure simply won't be counted → we keep
  // (fail open), never a false refute. Skip TS type-space nodes for the same
  // reason (a `type req = ...` annotation isn't a value use).
  const counts = new Map<string, number>()
  const visit = (n: Node, depth: number): void => {
    if (!n || typeof n.type !== "string") return
    if (depth > 0 && FUNCTION_TYPES.has(n.type)) return // don't descend into nested fns
    if (n.type.startsWith("TS")) return // skip the TS type space (annotations, type aliases)
    if (n.type === "Identifier" && typeof n.name === "string" && named.has(n.name)) {
      counts.set(n.name, (counts.get(n.name) ?? 0) + 1)
    }
    for (const key of Object.keys(n)) {
      if (key === "loc" || key === "start" || key === "end" || key === "range") continue
      const child = n[key]
      if (Array.isArray(child)) {
        for (const c of child) if (c && typeof c.type === "string") visit(c, depth + 1)
      } else if (child && typeof child.type === "string") {
        visit(child, depth + 1)
      }
    }
  }
  visit(fn, 0)
  // Any claimed-unused identifier that occurs >=2 times (declaration + >=1 use,
  // both in the enclosing fn's own scope) is provably referenced.
  for (const id of named) if ((counts.get(id) ?? 0) >= 2) return true
  return false
}

function quotedIdentifiers(text: string): Set<string> {
  const ids = new Set<string>()
  for (const m of text.matchAll(BACKTICK_IDENT_RE)) ids.add(m[1] as string)
  return ids
}

function textContainsIdentifier(text: string, id: string): boolean {
  return new RegExp(`\\b${escapeRegExp(id)}\\b`).test(text)
}

function nodeContainsStringOnlySubstringCall(node: Node): boolean {
  let hit = false
  eachNode(node, (n) => {
    if (hit || n.type !== "CallExpression") return
    const callee = n.callee
    if (callee?.type !== "MemberExpression") return
    const prop = propertyName(callee.property)
    if (prop && STRING_ONLY_SUBSTRING_METHODS.has(prop)) hit = true
  })
  return hit
}

function isStringOnlySubstringCall(node: Node): boolean {
  if (!node || node.type !== "CallExpression") return false
  const callee = node.callee
  if (callee?.type !== "MemberExpression") return false
  const prop = propertyName(callee.property)
  return prop ? STRING_ONLY_SUBSTRING_METHODS.has(prop) : false
}

function nodeContainsIdentifierOutsideNestedFunctions(node: Node, id: string): boolean {
  let hit = false
  const visit = (n: Node): void => {
    if (hit || !n || typeof n.type !== "string") return
    if (FUNCTION_TYPES.has(n.type)) return
    if (n.type === "Identifier" && n.name === id) {
      hit = true
      return
    }
    for (const key of Object.keys(n)) {
      if (key === "loc" || key === "start" || key === "end" || key === "range") continue
      const child = n[key]
      if (Array.isArray(child)) {
        for (const c of child) if (c && typeof c.type === "string") visit(c)
      } else if (child && typeof child.type === "string") {
        visit(child)
      }
    }
  }
  visit(node)
  return hit
}

function callPassesQuotedIdentifierToUnknownCallee(call: Node, quoted: ReadonlySet<string>): boolean {
  if (!call || (call.type !== "CallExpression" && call.type !== "NewExpression")) return false
  if (isStringOnlySubstringCall(call)) return false
  for (const arg of call.arguments ?? []) {
    if (!arg || FUNCTION_TYPES.has(arg.type)) continue
    for (const id of quoted) {
      if (nodeContainsIdentifierOutsideNestedFunctions(arg, id)) return true
    }
  }
  return false
}

function taggedTemplatePassesQuotedIdentifierToUnknownTag(node: Node, quoted: ReadonlySet<string>): boolean {
  if (!node || node.type !== "TaggedTemplateExpression") return false
  for (const expr of node.quasi?.expressions ?? []) {
    if (!expr || FUNCTION_TYPES.has(expr.type)) continue
    for (const id of quoted) {
      if (nodeContainsIdentifierOutsideNestedFunctions(expr, id)) return true
    }
  }
  return false
}

function functionPassesQuotedIdentifierToUnknownCall(fn: Node, quoted: ReadonlySet<string>): boolean {
  let hit = false
  // Intentionally descend through callbacks: the target FP shape is
  // `rows.filter((r) => r.name.includes(needle))`, and any sibling callback
  // that sends the same quoted value to a non-substring callee must fail open.
  eachNode(fn.body ?? fn, (n) => {
    if (
      !hit &&
      (callPassesQuotedIdentifierToUnknownCallee(n, quoted) ||
        taggedTemplatePassesQuotedIdentifierToUnknownTag(n, quoted))
    )
      hit = true
  })
  return hit
}

function functionContainsRegexSurface(fn: Node): boolean {
  let hit = false
  eachNodeInCurrentFunction(fn.body ?? fn, (n) => {
    if (hit) return
    if (n.type === "Literal" && n.regex) {
      hit = true
      return
    }
    if (n.type === "NewExpression" || n.type === "CallExpression") {
      const calleePath = memberPath(n.callee)
      if (
        (n.callee?.type === "Identifier" && n.callee.name === "RegExp") ||
        calleePath === "globalThis.RegExp" ||
        calleePath === "window.RegExp"
      ) {
        hit = true
        return
      }
    }
    if (n.type === "TaggedTemplateExpression") {
      const tagPath = memberPath(n.tag)
      if (tagPath && /\bregex\b/i.test(tagPath)) {
        hit = true
        return
      }
    }
    if (n.type === "CallExpression" && n.callee?.type === "MemberExpression") {
      const prop = propertyName(n.callee.property)
      if (prop && REGEX_SURFACE_METHODS.has(prop)) hit = true
    }
  })
  return hit
}

/**
 * Refute a regex/ReDoS hallucination ONLY when the exact cited statement proves
 * the model's named value is used as a literal string substring, not as a
 * regular expression. This intentionally descends into callback expressions
 * because `rows.filter((r) => r.name.includes(needle))` is the target FP shape;
 * the unknown-call guard also descends and fails open if that same quoted value
 * reaches any non-substring call/constructor. This is deliberately narrower
 * than "the function looks safe": no quoted expression, no exact statement
 * match, text claiming another location, or any actual regex surface in the
 * enclosing function all KEEP.
 */
function refutesRegexSubstringClaim(
  fnChain: readonly Node[],
  line: number,
  finding: PrReviewFinding,
  lines: string[],
): boolean {
  const text = findingText(finding)
  if (!REGEX_SUBSTRING_CLAIM_RE.test(text)) return false
  if (REGEX_ELSEWHERE_CLAIM_RE.test(text)) return false
  const quoted = quotedIdentifiers(text)
  if (quoted.size === 0) return false
  if (fnChain.some((fn) => functionContainsRegexSurface(fn))) return false
  if (fnChain.some((fn) => functionPassesQuotedIdentifierToUnknownCall(fn, quoted))) return false

  return fnChain.some((fn) => {
    return substringProofNodesSpanningLine(fn, line).some((stmt) => {
      if (!nodeContainsStringOnlySubstringCall(stmt)) return false
      const stmtText = nodeSourceLines(stmt, lines)
      return [...quoted].every((id) => textContainsIdentifier(stmtText, id))
    })
  })
}

/**
 * Refute a "missing return type annotation" claim. acorn-typescript sets
 * `returnType` on a function with an explicit return-type annotation. If the
 * enclosing function HAS one, the claim is FALSE. (A genuinely missing return
 * type is a style nit, never a correctness bug — but we only refute on positive
 * proof the annotation is present.)
 */
function refutesMissingReturnType(fn: Node): boolean {
  return fn?.returnType != null
}

const SOURCE_EXTS: Record<string, SourceExt> = {
  ts: ".ts",
  tsx: ".tsx",
  mts: ".mts",
  cts: ".cts",
  js: ".js",
  jsx: ".jsx",
  mjs: ".mjs",
  cjs: ".cjs",
}

function extOf(path: string): SourceExt | null {
  const m = path.toLowerCase().match(/\.([a-z]+)$/)
  const key = m?.[1]
  if (!key) return null
  return SOURCE_EXTS[key] ?? null
}

/**
 * Evaluate one logic-sourced finding. KEEP unless the gate can POSITIVELY prove
 * the cited claim false against the AST. Fail-open on every ambiguity.
 *
 * The call site scopes invocation to logic-sourced sev>=4 findings, but we
 * re-check both here so the pure function is safe to unit-test in isolation.
 */
export function evaluateLogicClaimRefutation(
  finding: PrReviewFinding,
  context: LogicClaimRefutationContext,
): LogicClaimRefutationDecision {
  // SIG-463 follow-up (mirrors SIG-466 + the window-blindness guard): a LEFT
  // (deleted-line) anchor's `finding.line` is an OLD-side number, but this gate
  // resolves the enclosing function in the NEW-file AST at `finding.line` and can
  // HARD-DROP in enforce — a coordinate mismatch that could delete a real
  // deletion finding. Refuse LEFT anchors. Recall-safe: only ever keeps.
  if (finding.anchorSide === "LEFT") return { keep: true }
  if (finding.category !== "logic") return { keep: true }
  if (finding.score < LOGIC_CLAIM_REFUTATION_MIN_SEVERITY) return { keep: true }

  const text = findingText(finding)
  const isControlFlow = CONTROL_FLOW_CLAIM_RE.test(text)
  const isSyncRace = SYNC_RACE_CLAIM_RE.test(text)
  const isIdempotencyRetry = IDEMPOTENCY_RETRY_CLAIM_RE.test(text)
  const isUnused = UNUSED_CLAIM_RE.test(text)
  const isMissingReturnType = MISSING_RETURN_TYPE_CLAIM_RE.test(text)
  const isRegexSubstring = REGEX_SUBSTRING_CLAIM_RE.test(text)
  const isBalanceSign = matchesBalanceSignClaim(text)
  if (
    !isControlFlow &&
    !isSyncRace &&
    !isIdempotencyRetry &&
    !isUnused &&
    !isMissingReturnType &&
    !isRegexSubstring &&
    !isBalanceSign
  )
    return { keep: true }

  const source = context.fullFileByPath.get(finding.path)
  if (typeof source !== "string" || source.length === 0) return { keep: true }
  const ext = extOf(finding.path)
  if (!ext) return { keep: true }
  // SIG-336: parse via the per-review cache when present (parse-once + size
  // guard); fall back to a direct parse when called without a cache.
  const parsed = context.astCache ? context.astCache.get(finding.path, source, ext) : parseSource(source, ext)
  if (!parsed.ok) return { keep: true }

  const line = finding.line
  if (typeof line !== "number" || line < 1) return { keep: true }
  const fnChain = enclosingFunctions(parsed.ast, line)
  const fn = fnChain[0] ?? null
  if (!fn) return { keep: true }
  const lines = source.split(/\r?\n/)

  const controlLinesToTry = candidateLinesWhenUnanchored(fn, line, lines, finding)

  if (isControlFlow && controlLinesToTry.some((l) => refutesControlFlow(fn, l, finding, lines))) {
    return { keep: false, reason: "control-flow-claim-refuted-by-guard" }
  }
  if (isSyncRace && refutesSyncRace(fn, line)) {
    return { keep: false, reason: "sync-race-claim-refuted-no-async-boundary" }
  }
  if (isIdempotencyRetry && refutesIdempotencyRetryClaim(fn, line, finding, lines)) {
    return { keep: false, reason: "idempotency-claim-refuted-by-visible-key" }
  }
  if (isRegexSubstring && refutesRegexSubstringClaim(fnChain, line, finding, lines)) {
    return { keep: false, reason: "regex-substring-claim-refuted-by-literal-string-filter" }
  }
  if (isUnused && refutesUnused(fn, finding)) {
    return { keep: false, reason: "unused-claim-refuted-identifier-is-referenced" }
  }
  if (isMissingReturnType && refutesMissingReturnType(fn)) {
    return { keep: false, reason: "missing-return-type-claim-refuted-annotation-present" }
  }
  if (isBalanceSign && refutesBalanceSignClaim(fn, line, finding)) {
    return { keep: false, reason: "balance-sign-claim-refuted-by-correct-accounting-direction" }
  }
  return { keep: true }
}
