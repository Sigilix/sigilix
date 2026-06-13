// SIG-245 subtle-logic recall — pins the two logic-lens focus bullets the
// benchmark showed Sigilix was missing (non-atomic read-modify-write and
// cross-tier field-name drift), and that both are phrased FP-safe (grounded).

import { describe, expect, it } from "vitest"
import {
  SPECIALIST_PROMPTS,
  LOGIC_RECALL_SUFFIX,
  SECURITY_RECALL_SUFFIX,
  specialistSystemPrompt,
} from "@/src/prompts/pr-review-specialists"

describe("logic specialist lens — SIG-245 subtle-logic recall bullets", () => {
  const logic = SPECIALIST_PROMPTS.logic

  it("instructs flagging non-atomic read-modify-write of a shared counter", () => {
    expect(logic).toContain("non-atomic read-modify-write")
    // directs an action, not just mentions the term (CodeRabbit)
    expect(logic).toContain("Flag only when ALL hold")
    // grounded — require ALL of: shared/persistent, non-atomic, and not transaction/lock-serialized
    expect(logic).toContain("shared/persistent")
    expect(logic).toContain("not an in-place SET count = count + 1")
    expect(logic).toContain("transaction or row lock")
  })

  it("instructs detecting cross-tier field-name drift (camel/snake mismatch)", () => {
    expect(logic).toContain("cross-tier field-name drift")
    // directs detection + grounded gating, not just mentions the term (CodeRabbit)
    expect(logic).toContain("before flagging")
    expect(logic).toContain("camelCaseField")
    expect(logic).toContain("snake_case")
  })

  it("keeps both bullets FP-safe (confirm against the type/contract; mapping layers are fine)", () => {
    expect(logic).toContain("Confirm the mismatch against the type or contract")
    expect(logic).toContain("DTO/mapping layer that renames fields is correct")
  })

  it("clears same-delivery idempotency while preserving duplicate-operation recall", () => {
    expect(logic).toContain("IDEMPOTENCY GUARD MAKES A RETRYABLE SIDE EFFECT SAFE")
    expect(logic).toContain("do NOT also demand an order-status / paid-state guard for that SAME retry hypothesis")
    expect(logic).toContain("event/message DELIVERY id")
    expect(logic).toContain("Keep duplicate logical operations in scope")
    expect(logic).toContain("multiple distinct delivery ids can represent the SAME order / operation")
    expect(logic).toContain("crypto.randomUUID()")
    expect(logic).toContain("Stripe webhook handler")
    expect(logic).toContain("idempotencyKey: event.id")
  })

  it("states JS/TS return semantics before clearing tail-call reachability claims", () => {
    expect(logic).toContain("TRACE THE RETURNS BEFORE CLAIMING REACHABILITY")
    expect(logic).toContain("a `return` inside an `if` block exits the ENCLOSING function/callback")
    expect(logic).toContain("return res.status(403).end()")
    expect(logic).toContain("the following `next()` is NOT reached on the forbidden path")
    expect(logic).toContain("exits the enclosing function/callback, not just the block")
  })

  it("requires a visible contract before flagging substring search UX semantics", () => {
    expect(logic).toContain("SEARCH SEMANTICS NEED A VISIBLE CONTRACT")
    expect(logic).toContain("String.prototype.includes")
    expect(logic).toContain('includes("")')
    expect(logic).toContain("This carve-out is ONLY for substring search UX preferences")
    expect(logic).toContain("division by zero, null dereference, out-of-bounds")
    expect(logic).toContain("case-insensitive search")
    expect(logic).toContain("empty queries returning no rows")
    expect(logic).toContain("explicit contract, test, API comment, or requirement")
  })
})

describe("specialistSystemPrompt — SIG-392 per-role recall directive", () => {
  it("empty recall set returns the base prompt unchanged for every role", () => {
    for (const role of ["logic", "security", "performance", "tests"] as const) {
      expect(specialistSystemPrompt(role, new Set())).toBe(SPECIALIST_PROMPTS[role])
    }
  })

  it("logic in the set appends EXACTLY the logic recall directive", () => {
    const logic = specialistSystemPrompt("logic", new Set(["logic"]))
    // exact pin: base prompt + "\n" + the suffix, nothing more.
    expect(logic).toBe(`${SPECIALIST_PROMPTS.logic}\n${LOGIC_RECALL_SUFFIX}`)
    expect(logic).toContain("RECALL DIRECTIVE")
    expect(logic).toContain("do NOT self-censor or stop early")
  })

  it("security in the set appends EXACTLY the security recall directive", () => {
    const security = specialistSystemPrompt("security", new Set(["security"]))
    expect(security).toBe(`${SPECIALIST_PROMPTS.security}\n${SECURITY_RECALL_SUFFIX}`)
    expect(security).toContain("RECALL DIRECTIVE (security)")
    expect(security).toContain("collection-scope IDOR / missing ROW-LEVEL tenant scoping")
  })

  it("a role in the set is independent — enabling logic does NOT alter security and vice versa", () => {
    expect(specialistSystemPrompt("security", new Set(["logic"]))).toBe(SPECIALIST_PROMPTS.security)
    expect(specialistSystemPrompt("logic", new Set(["security"]))).toBe(SPECIALIST_PROMPTS.logic)
  })

  it("roles without a recall suffix (performance, tests) are unchanged even when in the set", () => {
    for (const role of ["performance", "tests"] as const) {
      expect(specialistSystemPrompt(role, new Set([role]))).toBe(SPECIALIST_PROMPTS[role])
      expect(specialistSystemPrompt(role, new Set([role]))).not.toContain("RECALL DIRECTIVE")
    }
  })
})
