import { describe, expect, it } from "vitest"
import { extractFleetPattern, canonicalSubType } from "@/src/shared/domain/fleet-pattern"

describe("canonicalSubType", () => {
  it("maps known bug/vuln classes to the closed vocabulary", () => {
    expect(canonicalSubType("SQL injection in the webhook handler")).toBe("sql-injection")
    expect(canonicalSubType("Missing authorization check on the admin route")).toBe("missing-authz")
    expect(canonicalSubType("Possible race condition / TOCTOU on the balance update")).toBe("race-condition")
    expect(canonicalSubType("forgot to await the async write")).toBe("missing-await")
    expect(canonicalSubType("API key written to the log line")).toBe("secret-exposure")
    expect(canonicalSubType("logs the user's password on error")).toBe("secret-exposure") // reverse order
    expect(canonicalSubType("missing null check before deref")).toBe("null-deref")
    expect(canonicalSubType("module ships without tests")).toBe("missing-tests")
  })

  it("returns null for an unrecognized headline (→ category-only signature)", () => {
    expect(canonicalSubType("this variable name could be clearer")).toBeNull()
    expect(canonicalSubType(undefined)).toBeNull()
    expect(canonicalSubType("")).toBeNull()
  })
})

describe("extractFleetPattern", () => {
  it("PRIVACY INVARIANT — never emits identifiers, paths, literals, or secrets from the headline", () => {
    const p = extractFleetPattern({
      category: "security",
      headline:
        "SQL injection in chargeUserAccount() at src/billing/charge.ts leaking sk_live_AbC123XyZ for tenant acme-corp",
      score: 5,
      reproduced: true,
      verified: false,
    })!
    const serialized = JSON.stringify(p)
    for (const leak of ["chargeUserAccount", "src/billing", "charge.ts", "sk_live_AbC123XyZ", "acme-corp"]) {
      expect(serialized).not.toContain(leak)
    }
    // Only the controlled vocabulary survives.
    expect(p).toEqual({
      category: "security",
      subType: "sql-injection",
      severity: 5,
      reproduced: true,
      verified: false,
      signature: "security:sql-injection",
    })
  })

  it("produces a category-only signature when the headline matches no known sub-type", () => {
    const p = extractFleetPattern({
      category: "complexity",
      headline: "deeply nested ternary in renderFooWidget",
      score: 2,
    })!
    expect(p.subType).toBeNull()
    expect(p.signature).toBe("complexity:other")
    expect(JSON.stringify(p)).not.toContain("renderFooWidget") // still no identifier leak
  })

  it("returns null for an unrecognized category (nothing enters the fleet)", () => {
    expect(extractFleetPattern({ category: "vibes", headline: "x" })).toBeNull()
    expect(extractFleetPattern({ category: "", headline: "x" })).toBeNull()
  })

  it("carries proof flags and clamps severity to 1–5", () => {
    expect(
      extractFleetPattern({ category: "logic", headline: "off-by-one in loop", score: 9, reproduced: true })!.severity,
    ).toBe(5)
    expect(extractFleetPattern({ category: "logic", headline: "x", score: 0 })!.severity).toBe(1)
    expect(extractFleetPattern({ category: "logic", headline: "x" })!.severity).toBe(1) // missing → 1
    expect(extractFleetPattern({ category: "logic", headline: "x", score: NaN })!.severity).toBe(1) // NaN → 1
    expect(extractFleetPattern({ category: "logic", headline: "x", score: 2.6 })!.severity).toBe(3) // rounds
    const p = extractFleetPattern({
      category: "logic",
      headline: "off-by-one error",
      score: 4,
      reproduced: true,
      verified: true,
    })!
    expect(p).toMatchObject({ subType: "off-by-one", reproduced: true, verified: true, signature: "logic:off-by-one" })
  })
})
