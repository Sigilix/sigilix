// SIG-328: logic-claim refutation gate (deterministic FP precision layer).
//
// The logic specialist (deepseek-v4-pro) is a strong reasoner but has TWO
// stable priors that prompt-tuning could not dislodge (they fire ~10/12 even
// after refutation few-shots), BOTH of which are PROVABLY FALSE against the AST:
//   1. "next() runs unconditionally after the 403 / double-response" — but the
//      guard branch ends in `return res.status(403).end()`, so the tail is the
//      else-path, reached only when authorized.
//   2. "read-check-write race / TOCTOU" — but the code is SYNCHRONOUS: no
//      `await`/`yield`/callback between the check and the in-memory write, so
//      nothing can interleave in single-threaded JS.
//
// Consensus filtering (PR2) cannot kill these — they are STABLE, not flickery.
// This gate fact-checks each high-severity logic finding against the cited
// source and DROPS it ONLY when it can POSITIVELY prove the claim false. It is
// recall-safe BY CONSTRUCTION: it fails OPEN (keeps the finding) on every
// ambiguity — missing source, parse error, no enclosing function, any async/
// closure/IO boundary it cannot rule out, or an unbound guard. A real bug's
// claim is TRUE (or unprovable), so the gate cannot suppress it.
//
// Codex sign-off (2026-06-05) shaped the two rules: control-flow requires a
// same-block, unconditionally-terminating guard PLUS subject binding (the guard
// must reference an identifier the finding complains about — mirroring the
// SIG-327 window-blindness gate); sync-race requires a visible in-memory
// read-check-write pair with NO async/closure/timer/IO boundary, else fail open.
//
// SHADOW-FIRST: the drop is gated behind `OPENCLAW_LOGIC_CLAIM_REFUTATION_MODE`
// (off | shadow | enforce, default off in code / shadow in wrangler) at the
// call site. This module is pure and mode-agnostic.

import type { PrReviewFinding } from "./triage-pr-review"
import { parseSource, type SourceExt } from "./ast-rules/parser"
import { extractCitedIdentifiers } from "./validate-window-blindness"

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

export type LogicClaimRefutationDecision =
  | { keep: true }
  | { keep: false; reason: LogicClaimDropReason }

export interface LogicClaimRefutationContext {
  /** Full source of changed files (same map the AST floors use). */
  fullFileByPath: ReadonlyMap<string, string>
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

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
])

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
function enclosingFunction(ast: Node, line: number): Node | null {
  let best: Node | null = null
  let bestSize = Infinity
  eachNode(ast, (n) => {
    if (!FUNCTION_TYPES.has(n.type)) return
    if (!spans(n, line)) return
    const size = n.loc.end.line - n.loc.start.line
    if (size < bestSize) {
      best = n
      bestSize = size
    }
  })
  return best
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
    // on the !x path. If any statement BEFORE the guard (or the guard's own
    // consequent) contains a call whose callee identifiers the finding complains
    // about, the cited tail may be a genuine SECOND occurrence → fail open.
    const priorScope: Node[] = [...block.slice(0, citedIdx - 1), prev.consequent]
    if (priorScope.some((n) => containsConflictingCall(n, findingIds))) continue
    return true
  }
  return false
}

/** Does `node` contain a CallExpression whose callee identifiers intersect `findingIds`? */
function containsConflictingCall(node: Node, findingIds: Set<string>): boolean {
  let hit = false
  eachNode(node, (n) => {
    if (hit || n.type !== "CallExpression") return
    let callee = n.callee
    // unwrap a member chain: res.status(403).end() → collect res/status/end.
    while (callee) {
      if (callee.type === "Identifier" && findingIds.has(callee.name)) { hit = true; return }
      if (callee.type === "MemberExpression") {
        if (callee.property?.type === "Identifier" && findingIds.has(callee.property.name)) { hit = true; return }
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
    else if (FUNCTION_TYPES.has(n.type)) blocked = true // a nested closure could defer the write
    else if (n.type === "CallExpression" && n.callee?.type === "MemberExpression") {
      const prop = n.callee.property?.name
      if (prop === "then" || prop === "catch" || prop === "finally") blocked = true
    } else if (n.type === "CallExpression" && n.callee?.type === "Identifier") {
      const name = n.callee.name
      if (name === "setTimeout" || name === "setInterval" || name === "setImmediate" || name === "queueMicrotask") blocked = true
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
      if (
        t.type === "MemberExpression" &&
        t.object?.name === objName &&
        t.property?.name === propName
      ) {
        sawCheck = true
      }
    })
  })
  return sawCheck
}

const SOURCE_EXTS: Record<string, SourceExt> = {
  ts: ".ts", tsx: ".tsx", mts: ".mts", cts: ".cts",
  js: ".js", jsx: ".jsx", mjs: ".mjs", cjs: ".cjs",
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
  if (finding.category !== "logic") return { keep: true }
  if (finding.score < LOGIC_CLAIM_REFUTATION_MIN_SEVERITY) return { keep: true }

  const text = findingText(finding)
  const isControlFlow = CONTROL_FLOW_CLAIM_RE.test(text)
  const isSyncRace = SYNC_RACE_CLAIM_RE.test(text)
  if (!isControlFlow && !isSyncRace) return { keep: true }

  const source = context.fullFileByPath.get(finding.path)
  if (typeof source !== "string" || source.length === 0) return { keep: true }
  const ext = extOf(finding.path)
  if (!ext) return { keep: true }
  const parsed = parseSource(source, ext)
  if (!parsed.ok) return { keep: true }

  const line = finding.line
  if (typeof line !== "number" || line < 1) return { keep: true }
  const fn = enclosingFunction(parsed.ast, line)
  if (!fn) return { keep: true }
  const lines = source.split(/\r?\n/)

  if (isControlFlow && refutesControlFlow(fn, line, finding, lines)) {
    return { keep: false, reason: "control-flow-claim-refuted-by-guard" }
  }
  if (isSyncRace && refutesSyncRace(fn, line)) {
    return { keep: false, reason: "sync-race-claim-refuted-no-async-boundary" }
  }
  return { keep: true }
}
