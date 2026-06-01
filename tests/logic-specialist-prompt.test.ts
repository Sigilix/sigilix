// SIG-245 subtle-logic recall — pins the two logic-lens focus bullets the
// benchmark showed Sigilix was missing (non-atomic read-modify-write and
// cross-tier field-name drift), and that both are phrased FP-safe (grounded).

import { describe, expect, it } from "vitest"
import { SPECIALIST_PROMPTS } from "../src/prompts/pr-review-specialists"

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
})
