import { describe, expect, it } from "vitest"
import {
  isWithinTolerance,
  parseStripeSignatureHeader,
  stripeSignedPayload,
  timingSafeEqualHex,
} from "@/src/features/billing/domain/stripe-signature"

describe("parseStripeSignatureHeader", () => {
  it("parses t + a single v1", () => {
    expect(parseStripeSignatureHeader("t=1700000000,v1=abc123")).toEqual({ timestamp: 1700000000, v1: ["abc123"] })
  })

  it("collects multiple v1 digests (rotation window) and lowercases them", () => {
    const parsed = parseStripeSignatureHeader("t=42,v1=AAAA,v1=BBBB")
    expect(parsed).toEqual({ timestamp: 42, v1: ["aaaa", "bbbb"] })
  })

  it("ignores unknown scheme keys like v0", () => {
    expect(parseStripeSignatureHeader("t=42,v0=xxxx,v1=abcd")).toEqual({ timestamp: 42, v1: ["abcd"] })
  })

  it("returns null for a missing header", () => {
    expect(parseStripeSignatureHeader(null)).toBeNull()
    expect(parseStripeSignatureHeader(undefined)).toBeNull()
    expect(parseStripeSignatureHeader("")).toBeNull()
  })

  it("returns null when there is no v1", () => {
    expect(parseStripeSignatureHeader("t=42")).toBeNull()
  })

  it("returns null when t is missing or non-integer", () => {
    expect(parseStripeSignatureHeader("v1=abcd")).toBeNull()
    expect(parseStripeSignatureHeader("t=12x,v1=abcd")).toBeNull()
  })
})

describe("stripeSignedPayload", () => {
  it("joins timestamp and body with a dot", () => {
    expect(stripeSignedPayload(123, '{"a":1}')).toBe('123.{"a":1}')
  })
})

describe("timingSafeEqualHex", () => {
  it("true on equal, false on differing content or length", () => {
    expect(timingSafeEqualHex("deadbeef", "deadbeef")).toBe(true)
    expect(timingSafeEqualHex("deadbeef", "deadbeee")).toBe(false)
    expect(timingSafeEqualHex("dead", "deadbeef")).toBe(false)
  })
})

describe("isWithinTolerance", () => {
  it("accepts within window either direction, rejects outside", () => {
    expect(isWithinTolerance(1000, 1200, 300)).toBe(true) // 200s old
    expect(isWithinTolerance(1500, 1200, 300)).toBe(true) // 300s future (skew)
    expect(isWithinTolerance(1000, 1400, 300)).toBe(false) // 400s old → replay
  })
})
