// SIG-392 — balance/accounting-sign claim refuter (sibling of the logic-claim
// refutation gate; kept out of validate-logic-claim-refutation.ts for the
// 1000-line budget). Dispatched as the 7th claim shape.
//
// THE FP THIS REFUTES (probe e2e#38, score-4 logic, payments.ts):
//   code: `const outstandingCents = amountCents - paidCents + refundedCents`
//   finding (WRONG): "outstandingCents formula is wrong: refunds should reduce
//                     the balance, not increase it"
// The code is CORRECT — a refund returns money to the customer, so it RAISES
// what is still owed (outstanding). DeepSeek-v4-pro signed off the table below
// as TABLE-CORRECT.
//
// RECALL-SAFETY (the hard constraint): refute ONLY when the cited expression is
// an OUTSTANDING-DUE accumulator (Codex #1 — `balance`/`owed` alone are too
// broad; a customer-credit / escrow / refund-liability balance has the OPPOSITE
// sign convention and must NOT be judged by this table), the claim NAMES a
// classified term and asserts the OPPOSITE sign (Codex #2), the RHS is a clean
// additive chain of classified terms, AND the code's sign MATCHES the table.
// Every ambiguity → keep. A genuine sign bug (code disagrees with the table) is
// kept, never suppressed.

import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"

type Node = any

/** Generic ESTree walker (self-contained — avoids a circular import with the
 *  dispatching gate; mirrors that file's private `eachNode`). */
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

// --- claim-shape detection -------------------------------------------------

/** An OUTSTANDING-DUE noun. Deliberately NOT bare `balance`/`owed` (Codex #1):
 *  the sign table only holds for "customer owes merchant / amount still due".
 *  No trailing `\b` so the `outstanding` prefix also matches `outstandingCents`. */
const OUTSTANDING_DUE_NOUN_RE =
  /\b(?:outstanding|amount\s+due|balance\s+due|remaining\s+due|amount\s+owed|due\s+balance|amount\s+remaining)/i

/** A classified accounting term the claim must name (Codex #2). */
const CLASSIFIED_TERM_RE = /\b(?:refunds?|refunded|paid|payments?|amount|charge|invoice|total)\b/i

/** A direction assertion. */
const DIRECTION_RE =
  /\b(?:reduce|reduces|reducing|decrease|decreases|lower|lowers|subtract(?:ed|s)?|increase|increases|raises?|add(?:ed|s)?|wrong\s+sign|inverted(?:\s+sign)?|flipped\s+sign)\b/i

/**
 * Trigger: an inverted-sign claim about an outstanding-due accumulator that
 * NAMES a classified term AND asserts a direction. Necessary, not sufficient —
 * the AST refuter is the real gate and fails open. (Codex #1 + #2.)
 */
export function matchesBalanceSignClaim(text: string): boolean {
  return OUTSTANDING_DUE_NOUN_RE.test(text) && CLASSIFIED_TERM_RE.test(text) && DIRECTION_RE.test(text)
}

// --- accounting-sign invariant table (DeepSeek: TABLE-CORRECT) -------------

type TermRole = "amount" | "paid" | "refund"
type Sign = 1 | -1

/** Correct contribution of each role to an OUTSTANDING-DUE balance. */
const TABLE_SIGN: Record<TermRole, Sign> = {
  amount: 1, // you owe the invoice amount
  paid: -1, // a payment reduces what's owed
  refund: 1, // money handed back → owed again
}

function classifyIdentifier(name: string): TermRole | null {
  const n = name.toLowerCase()
  if (/refund/.test(n)) return "refund"
  if (/paid|payment/.test(n)) return "paid"
  if (/amount|charge|invoice|total|owed|due|gross|subtotal/.test(n)) return "amount"
  return null
}

/** The simple identifier name of an Identifier or MemberExpression leaf, or null
 *  for anything else (call, literal, computed member, …) → unclassifiable. */
function leafName(node: Node): string | null {
  if (!node || typeof node.type !== "string") return null
  if (node.type === "Identifier") return typeof node.name === "string" ? node.name : null
  if (node.type === "MemberExpression" && !node.computed && node.property?.type === "Identifier") {
    return typeof node.property.name === "string" ? node.property.name : null
  }
  return null
}

interface SignedTerm {
  role: TermRole
  sign: Sign
}

/** Fold an additive (+/-) chain into signed, classified terms. Returns null on
 *  ANY non-additive operator or unclassifiable leaf — fail open. */
function collectSignedTerms(node: Node, sign: Sign): SignedTerm[] | null {
  if (!node || typeof node.type !== "string") return null
  if (node.type === "BinaryExpression" && (node.operator === "+" || node.operator === "-")) {
    const left = collectSignedTerms(node.left, sign)
    if (left === null) return null
    const rightSign: Sign = node.operator === "-" ? ((sign * -1) as Sign) : sign
    const right = collectSignedTerms(node.right, rightSign)
    if (right === null) return null
    return [...left, ...right]
  }
  // a leaf: must be a classifiable identifier
  const name = leafName(node)
  if (name === null) return null
  const role = classifyIdentifier(name)
  if (role === null) return null
  return [{ role, sign }]
}

// --- claim direction extraction --------------------------------------------

const REDUCE_RE = /\b(?:reduce|reduces|reducing|decrease|decreases|lower|lowers|subtract(?:ed|s)?)\b/i
const INCREASE_RE = /\b(?:increase|increases|raises?|add(?:ed|s)?)\b/i

/**
 * The (role, claimedSign) the finding asserts the term SHOULD have, or null when
 * the demands are absent or CONFLICTING (fail open). We anchor on a "should …"
 * clause so a descriptive mention ("currently adds the refund") isn't read as a
 * demand. A finding often RESTATES the same demand ("refunds should reduce …; it
 * should subtract it"); those collapse to one distinct (role, sign) and are
 * used. Genuinely different demands (two roles, or opposite signs) → null.
 */
function extractClaimedRoleSign(text: string): { role: TermRole; claimedSign: Sign } | null {
  // find "should (be) <direction>" assertions and the SOLE preceding role.
  const shouldRe = /\bshould\b(?:\s+be)?\s+([^.;\n]{0,40})/gi
  const distinct = new Map<string, { role: TermRole; claimedSign: Sign }>()
  let m: RegExpExecArray | null
  while ((m = shouldRe.exec(text)) !== null) {
    const clause = m[1] ?? ""
    const claimedSign: Sign | null = REDUCE_RE.test(clause) ? -1 : INCREASE_RE.test(clause) ? 1 : null
    if (claimedSign === null) continue
    // the subject role = the SOLE classified term in this clause before `should`
    // (bounded to the current sentence/clause). If the subject phrase names more
    // than one role ("the paid amount …"), it is genuinely ambiguous → fail open,
    // so a real bug on EITHER named term is never dropped (code-reviewer BLOCKER).
    const clauseStart =
      Math.max(
        text.lastIndexOf(".", m.index - 1),
        text.lastIndexOf(";", m.index - 1),
        text.lastIndexOf("\n", m.index - 1),
      ) + 1
    const role = soleRoleIn(text.slice(clauseStart, m.index))
    if (role === null) continue
    distinct.set(`${role}:${claimedSign}`, { role, claimedSign })
  }
  if (distinct.size !== 1) return null
  return [...distinct.values()][0]!
}

/** The SOLE classified role named in `text`, or null when zero OR MORE THAN ONE
 *  distinct role appears (ambiguous → fail open). */
function soleRoleIn(text: string): TermRole | null {
  const roles = new Set<TermRole>()
  const families: Array<[RegExp, TermRole]> = [
    [/\brefunds?\b|\brefunded\b/i, "refund"],
    [/\bpaid\b|\bpayments?\b/i, "paid"],
    [/\bamount\b|\bcharge\b|\binvoice\b|\btotal\b/i, "amount"],
  ]
  for (const [re, role] of families) if (re.test(text)) roles.add(role)
  return roles.size === 1 ? [...roles][0]! : null
}

// --- the refuter -----------------------------------------------------------

/**
 * Refute an inverted-sign claim about an outstanding-due accumulator. TRUE only
 * when: the enclosing function has exactly ONE outstanding-due assignment bound
 * to the cited line, its RHS is a clean additive chain of classified terms, the
 * claim names exactly one role + asserts a direction, the code's sign for that
 * role MATCHES the invariant table, AND the claim asserts the OPPOSITE sign.
 * Anything else → false (keep).
 */
export function refutesBalanceSignClaim(fn: Node, line: number, finding: PrReviewFinding): boolean {
  const text = `${finding.headline} ${finding.body}`
  const claimed = extractClaimedRoleSign(text)
  if (claimed === null) return false

  // collect outstanding-due assignments (`outstanding… = <additive chain>`).
  const candidates: Array<{ node: Node; rhs: Node }> = []
  eachNode(fn, (n) => {
    let lhsName: string | null = null
    let rhs: Node = null
    if (n.type === "AssignmentExpression" && n.operator === "=") {
      lhsName = leafName(n.left)
      rhs = n.right
    } else if (n.type === "VariableDeclarator" && n.init) {
      lhsName = leafName(n.id)
      rhs = n.init
    }
    if (lhsName === null || rhs === null) return
    if (!isOutstandingDueIdent(lhsName)) return
    candidates.push({ node: n, rhs })
  })
  if (candidates.length === 0) return false

  // bind to the cited line when there is more than one (fail open on ambiguity).
  let chosen: { node: Node; rhs: Node } | null = null
  if (candidates.length === 1) {
    chosen = candidates[0]!
  } else {
    const near = candidates.filter((c) => spansNear(c.node, line))
    if (near.length !== 1) return false
    chosen = near[0]!
  }

  const terms = collectSignedTerms(chosen.rhs, 1)
  if (terms === null || terms.length === 0) return false

  // the code's sign for the claimed role — only if that role appears EXACTLY once
  // (so a chain mentioning refund twice is ambiguous → keep).
  const forRole = terms.filter((t) => t.role === claimed.role)
  if (forRole.length !== 1) return false
  const codeSign = forRole[0]!.sign

  const tableSign = TABLE_SIGN[claimed.role]
  // refute iff: code matches the correct table sign AND the claim demands the opposite.
  return codeSign === tableSign && claimed.claimedSign !== tableSign
}

/** camelCase outstanding-due identifiers the spaced-noun regex misses
 *  (`outstandingCents`, `amountDue`, `balanceDue`, `remainingDue`). */
function isOutstandingDueIdent(name: string): boolean {
  return /^(?:outstanding|amountdue|balancedue|remainingdue|amountowed|duebalance|amountremaining)/i.test(
    name.replace(/[_\s]/g, ""),
  )
}

function spansNear(node: Node, line: number): boolean {
  if (!node?.loc) return false
  const s = node.loc.start?.line
  const e = node.loc.end?.line
  if (typeof s !== "number" || typeof e !== "number") return false
  return s - 2 <= line && line <= e + 2
}
