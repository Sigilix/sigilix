import { describe, expect, it } from "vitest"
import { computeWouldExceed, resolveQuotaMode } from "./quota"

// ─── resolveQuotaMode ────────────────────────────────────────────────────────

describe("resolveQuotaMode", () => {
  it('returns "shadow" when SIGILIX_TENANT_QUOTA_MODE is unset', () => {
    expect(resolveQuotaMode({} as never)).toBe("shadow")
  })

  it('returns "shadow" when SIGILIX_TENANT_QUOTA_MODE is empty string', () => {
    expect(resolveQuotaMode({ SIGILIX_TENANT_QUOTA_MODE: "" })).toBe("shadow")
  })

  it('returns "shadow" when SIGILIX_TENANT_QUOTA_MODE is an unrecognized value', () => {
    expect(resolveQuotaMode({ SIGILIX_TENANT_QUOTA_MODE: "garbage" })).toBe("shadow")
  })

  it('returns "shadow" when SIGILIX_TENANT_QUOTA_MODE is "shadow"', () => {
    expect(resolveQuotaMode({ SIGILIX_TENANT_QUOTA_MODE: "shadow" })).toBe("shadow")
  })

  it('returns "off" when SIGILIX_TENANT_QUOTA_MODE is "off"', () => {
    expect(resolveQuotaMode({ SIGILIX_TENANT_QUOTA_MODE: "off" })).toBe("off")
  })

  it('returns "enforce" when SIGILIX_TENANT_QUOTA_MODE is "enforce"', () => {
    expect(resolveQuotaMode({ SIGILIX_TENANT_QUOTA_MODE: "enforce" })).toBe("enforce")
  })
})

// ─── computeWouldExceed ──────────────────────────────────────────────────────

describe("computeWouldExceed", () => {
  // positive cases
  it("returns true when used > budget and budget > 0", () => {
    expect(computeWouldExceed(11, 10)).toBe(true)
  })

  it("returns true when used is fractionally above budget", () => {
    expect(computeWouldExceed(10.1, 10)).toBe(true)
  })

  // boundary: used === budget is not exceeded
  it("returns false when used equals budget", () => {
    expect(computeWouldExceed(10, 10)).toBe(false)
  })

  it("returns false when used < budget", () => {
    expect(computeWouldExceed(5, 10)).toBe(false)
  })

  it("returns false when used is 0 and budget > 0", () => {
    expect(computeWouldExceed(0, 10)).toBe(false)
  })

  // null / undefined budget — treat as unlimited
  it("returns false when budget is null", () => {
    expect(computeWouldExceed(100, null)).toBe(false)
  })

  it("returns false when budget is undefined", () => {
    expect(computeWouldExceed(100, undefined)).toBe(false)
  })

  // zero / negative budget — treat as no-limit configured
  it("returns false when budget is 0", () => {
    expect(computeWouldExceed(1, 0)).toBe(false)
  })

  it("returns false when budget is negative", () => {
    expect(computeWouldExceed(1, -5)).toBe(false)
  })

  // non-finite used — safety guard
  it("returns false when used is NaN", () => {
    expect(computeWouldExceed(NaN, 10)).toBe(false)
  })

  it("returns false when used is Infinity", () => {
    expect(computeWouldExceed(Infinity, 10)).toBe(false)
  })

  // non-finite budget
  it("returns false when budget is Infinity", () => {
    expect(computeWouldExceed(100, Infinity)).toBe(false)
  })
})
