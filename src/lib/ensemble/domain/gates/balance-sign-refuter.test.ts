// SIG-392: the balance/accounting-sign claim refuter — the 7th logic-claim
// shape. Drops a score-4 logic finding ONLY when it asserts an inverted sign on
// an OUTSTANDING-DUE accumulator whose code is provably CORRECT (DeepSeek-v4-pro
// signed the sign table TABLE-CORRECT). Fails OPEN on every ambiguity, so it
// cannot suppress a real bug. Pins the refutation AND the recall-safety cases
// (Codex sign-off: tightened LHS, named-term requirement, out-of-scope keep).

import { describe, expect, it } from "vitest"
import { evaluateLogicClaimRefutation } from "@/src/lib/ensemble/domain/gates/validate-logic-claim-refutation"
import { matchesBalanceSignClaim } from "@/src/lib/ensemble/domain/gates/balance-sign-refuter"
import { finding, ctx } from "@/src/lib/ensemble/domain/gates/validate-logic-claim-refutation.test-helpers"

const PATH = "server/payments.ts"
// The exact probe e2e#38 shape: correct outstanding-due formula.
const CORRECT = `export function balance(amountCents, paidCents, refundedCents) {
  const outstandingCents = amountCents - paidCents + refundedCents
  return outstandingCents
}`
const FP_HEADLINE = "outstandingCents formula is wrong: refunds should reduce the balance, not increase it"

describe("matchesBalanceSignClaim (trigger — needs outstanding-due noun + classified term + direction)", () => {
  it("matches the FP shape", () => {
    expect(matchesBalanceSignClaim(FP_HEADLINE)).toBe(true)
  })
  it("does NOT match 'formula is wrong' with no classified term or direction", () => {
    expect(matchesBalanceSignClaim("the outstanding formula is wrong")).toBe(false)
  })
  it("does NOT match a bare `balance`/`owed` noun (Codex #1 — table only holds for outstanding-due)", () => {
    expect(matchesBalanceSignClaim("the refund should reduce the balance")).toBe(false)
  })
})

describe("refutesBalanceSignClaim (via evaluateLogicClaimRefutation)", () => {
  it("REFUTES the FP: correct outstanding = amount - paid + refunded vs 'refunds should reduce'", () => {
    const f = finding({ path: PATH, line: 2, headline: FP_HEADLINE })
    expect(evaluateLogicClaimRefutation(f, ctx(PATH, CORRECT))).toEqual({
      keep: false,
      reason: "balance-sign-claim-refuted-by-correct-accounting-direction",
    })
  })

  it("RECALL-SAFE: KEEPS a REAL inverted-sign bug (code disagrees with the table)", () => {
    const BUGGY = `export function balance(amountCents, paidCents, refundedCents) {
  const outstandingCents = amountCents - paidCents - refundedCents
  return outstandingCents
}`
    // code has refund as '-' (wrong); the claim "refunds should reduce" is now
    // CORRECT, so the gate must KEEP (never suppress a true positive).
    const f = finding({ path: PATH, line: 2, headline: FP_HEADLINE })
    expect(evaluateLogicClaimRefutation(f, ctx(PATH, BUGGY)).keep).toBe(true)
  })

  it("RECALL-SAFE: KEEPS a real paid-sign bug whose claim names TWO roles ('paid amount')", () => {
    // code wrongly ADDS paid (should subtract); the reviewer is CORRECT. The
    // subject 'the paid amount' names paid AND amount → ambiguous → fail open.
    // (code-reviewer BLOCKER: positionally-last role mis-attribution dropped this.)
    const PAID_BUG = `export function balance(amountCents, paidCents, refundedCents) {
  const outstandingCents = amountCents + paidCents + refundedCents
  return outstandingCents
}`
    const f = finding({
      path: PATH,
      line: 2,
      headline: "the paid amount should reduce the outstanding balance, not add to it",
    })
    expect(evaluateLogicClaimRefutation(f, ctx(PATH, PAID_BUG)).keep).toBe(true)
  })

  it("RECALL-SAFE: KEEPS an out-of-table-scope accumulator (Codex #1 — not outstanding-due)", () => {
    // a customer-credit balance legitimately treats refunds the other way; the
    // table does not apply, so even an inverted-sign claim must be kept.
    const CREDIT = `export function credit(amountCents, paidCents, refundedCents) {
  const customerCredit = paidCents - amountCents + refundedCents
  return customerCredit
}`
    const f = finding({
      path: PATH,
      line: 2,
      headline: "outstanding is wrong: refunds should reduce the customer's outstanding amount due",
    })
    expect(evaluateLogicClaimRefutation(f, ctx(PATH, CREDIT)).keep).toBe(true)
  })

  it("RECALL-SAFE: KEEPS when the RHS is not a clean additive chain of classified terms", () => {
    const OPAQUE = `export function balance(a, b, c) {
  const outstandingCents = a - b + c
  return outstandingCents
}`
    const f = finding({ path: PATH, line: 2, headline: FP_HEADLINE })
    expect(evaluateLogicClaimRefutation(f, ctx(PATH, OPAQUE)).keep).toBe(true)
  })

  it("RECALL-SAFE: KEEPS a refund units bug (b6-style) — not a sign claim", () => {
    const f = finding({
      path: PATH,
      line: 2,
      headline: "refund amount is treated as dollars and multiplied by 100 against the cents contract",
    })
    expect(evaluateLogicClaimRefutation(f, ctx(PATH, CORRECT)).keep).toBe(true)
  })

  it("INTENDED: refutes a claim whose NAMED term is provably correct, even if another term is buggy", () => {
    // code has a real paid bug (+paid), but THIS finding names only `amount`
    // ("the amount should be subtracted") — and amount is correctly +. The
    // literal claim is false, so refuting it is correct; a separate, correctly-
    // worded finding on `paid` is unaffected. Pinned so it isn't read later as
    // an accidental drop (code-reviewer note).
    const PAID_BUG = `export function balance(amountCents, paidCents, refundedCents) {
  const outstandingCents = amountCents + paidCents + refundedCents
  return outstandingCents
}`
    const f = finding({
      path: PATH,
      line: 2,
      headline: "the amount should be subtracted from the outstanding amount due",
    })
    expect(evaluateLogicClaimRefutation(f, ctx(PATH, PAID_BUG)).keep).toBe(false)
  })

  it("KEEPS when the claim agrees with the table (names refund + 'should increase', code already +)", () => {
    const f = finding({
      path: PATH,
      line: 2,
      headline: "the outstanding amount due should increase when a refund is issued",
    })
    expect(evaluateLogicClaimRefutation(f, ctx(PATH, CORRECT)).keep).toBe(true)
  })

  it("KEEPS a sub-severity (score < 4) finding even on the FP shape", () => {
    const f = finding({ path: PATH, line: 2, score: 3, headline: FP_HEADLINE })
    expect(evaluateLogicClaimRefutation(f, ctx(PATH, CORRECT)).keep).toBe(true)
  })
})
