// SIG-245 subtle-logic recall — pins the two logic-lens focus bullets the
// benchmark showed Sigilix was missing (non-atomic read-modify-write and
// cross-tier field-name drift), and that both are phrased FP-safe (grounded).

import { describe, expect, it } from "vitest"
import {
  SPECIALIST_PROMPTS,
  LOGIC_RECALL_SUFFIX,
  SECURITY_RECALL_SUFFIX,
  LOGIC_REASONING_SUFFIX,
  specialistSystemPrompt,
} from "@/src/prompts/pr-review-specialists"
import { parseEnsembleConfig } from "@/src/lib/ensemble/config"

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
  it("empty recall + reasoning sets returns the base prompt unchanged for every role", () => {
    for (const role of ["logic", "security", "performance", "tests"] as const) {
      expect(specialistSystemPrompt(role, new Set(), new Set())).toBe(SPECIALIST_PROMPTS[role])
    }
  })

  it("logic in the recall set appends EXACTLY the logic recall directive", () => {
    const logic = specialistSystemPrompt("logic", new Set(["logic"]), new Set())
    // exact pin: base prompt + "\n" + the suffix, nothing more.
    expect(logic).toBe(`${SPECIALIST_PROMPTS.logic}\n${LOGIC_RECALL_SUFFIX}`)
    expect(logic).toContain("RECALL DIRECTIVE")
    expect(logic).toContain("do NOT self-censor or stop early")
  })

  it("security in the recall set appends EXACTLY the security recall directive", () => {
    const security = specialistSystemPrompt("security", new Set(["security"]), new Set())
    expect(security).toBe(`${SPECIALIST_PROMPTS.security}\n${SECURITY_RECALL_SUFFIX}`)
    expect(security).toContain("RECALL DIRECTIVE (security)")
    expect(security).toContain("collection-scope IDOR / missing ROW-LEVEL tenant scoping")
  })

  it("a role in the recall set is independent — enabling logic does NOT alter security and vice versa", () => {
    expect(specialistSystemPrompt("security", new Set(["logic"]), new Set())).toBe(SPECIALIST_PROMPTS.security)
    expect(specialistSystemPrompt("logic", new Set(["security"]), new Set())).toBe(SPECIALIST_PROMPTS.logic)
  })

  it("roles without a recall suffix (performance, tests) are unchanged even when in the recall set", () => {
    for (const role of ["performance", "tests"] as const) {
      expect(specialistSystemPrompt(role, new Set([role]), new Set())).toBe(SPECIALIST_PROMPTS[role])
      expect(specialistSystemPrompt(role, new Set([role]), new Set())).not.toContain("RECALL DIRECTIVE")
    }
  })
})

describe("specialistSystemPrompt — SIG-399 per-role reasoning-process directive", () => {
  it("logic in the reasoning set appends EXACTLY the logic reasoning directive", () => {
    const logic = specialistSystemPrompt("logic", new Set(), new Set(["logic"]))
    expect(logic).toBe(`${SPECIALIST_PROMPTS.logic}\n${LOGIC_REASONING_SUFFIX}`)
    expect(logic).toContain("REASONING DIRECTIVE (logic)")
    expect(logic).toContain("Uncertainty maps to a LOW SCORE, never to silence")
  })

  it("recall + reasoning compose in order: base, then recall, then reasoning", () => {
    const logic = specialistSystemPrompt("logic", new Set(["logic"]), new Set(["logic"]))
    expect(logic).toBe(`${SPECIALIST_PROMPTS.logic}\n${LOGIC_RECALL_SUFFIX}\n${LOGIC_REASONING_SUFFIX}`)
    // the recall directive must precede the reasoning directive
    expect(logic.indexOf("RECALL DIRECTIVE")).toBeLessThan(logic.indexOf("REASONING DIRECTIVE (logic)"))
  })

  it("reasoning is independent of recall — reasoning on / recall off appends only the reasoning directive", () => {
    const logic = specialistSystemPrompt("logic", new Set(), new Set(["logic"]))
    expect(logic).toBe(`${SPECIALIST_PROMPTS.logic}\n${LOGIC_REASONING_SUFFIX}`)
    expect(logic).not.toContain("RECALL DIRECTIVE")
  })

  it("roles without a reasoning suffix (security, performance, tests) are unchanged even when in the reasoning set", () => {
    for (const role of ["security", "performance", "tests"] as const) {
      expect(specialistSystemPrompt(role, new Set(), new Set([role]))).toBe(SPECIALIST_PROMPTS[role])
      expect(specialistSystemPrompt(role, new Set(), new Set([role]))).not.toContain("REASONING DIRECTIVE")
    }
  })

  it("env flag → parseEnsembleConfig → prompt: the exact expression the prod fanout uses", () => {
    // Real flags object — the inputs the prod fan-out passes at specialists.ts.
    // (Reverting the call-site 3rd arg is itself a compile error: the param is
    // required.) This pins the runtime env→config→prompt composition.
    const on = parseEnsembleConfig({ OPENCLAW_LOGIC_REASONING_PROMPT_MODE: "on" }).flags
    expect(specialistSystemPrompt("logic", on.recallRoles, on.reasoningPromptRoles)).toContain(
      "REASONING DIRECTIVE (logic)",
    )
    const off = parseEnsembleConfig({}).flags
    expect(specialistSystemPrompt("logic", off.recallRoles, off.reasoningPromptRoles)).toBe(SPECIALIST_PROMPTS.logic)
  })
})
