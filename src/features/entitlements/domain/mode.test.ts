import { describe, it, expect } from "vitest"
import { resolveEntitlementsMode } from "@/src/features/entitlements/domain/mode"

describe("resolveEntitlementsMode", () => {
  it("defaults to off when unset", () => {
    expect(resolveEntitlementsMode({})).toBe("off")
  })
  it("resolves shadow and enforce case-insensitively with trimming", () => {
    expect(resolveEntitlementsMode({ OPENCLAW_ENTITLEMENTS_MODE: "shadow" })).toBe("shadow")
    expect(resolveEntitlementsMode({ OPENCLAW_ENTITLEMENTS_MODE: "  ENFORCE " })).toBe("enforce")
    expect(resolveEntitlementsMode({ OPENCLAW_ENTITLEMENTS_MODE: "Shadow" })).toBe("shadow")
  })
  it("fails safe to off for unknown/typo/on/true values", () => {
    for (const v of ["on", "true", "1", "gated", "block", ""]) {
      expect(resolveEntitlementsMode({ OPENCLAW_ENTITLEMENTS_MODE: v })).toBe("off")
    }
  })
})
