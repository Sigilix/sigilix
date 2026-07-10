// sig-cli-cost-report — unit tests for the correlation-id sanitizer that keys the
// coding_agent event so /v1/usage/report can late-bind cost onto it.

import { describe, it, expect } from "vitest"
import { sanitizeCorrelationId } from "@/src/lib/boreas-gateway/vertex-chat-route"

describe("sanitizeCorrelationId", () => {
  it("accepts a UUID and trims surrounding whitespace", () => {
    expect(sanitizeCorrelationId("b3f1c2a4-0d5e-4f6a-8b9c-0123456789ab")).toBe("b3f1c2a4-0d5e-4f6a-8b9c-0123456789ab")
    expect(sanitizeCorrelationId("  corr-123  ")).toBe("corr-123")
  })

  it("rejects missing / blank values → undefined (record an unkeyed row)", () => {
    expect(sanitizeCorrelationId(null)).toBeUndefined()
    expect(sanitizeCorrelationId(undefined)).toBeUndefined()
    expect(sanitizeCorrelationId("   ")).toBeUndefined()
  })

  it("rejects control / whitespace / non-ASCII chars (only a printable-ASCII token qualifies)", () => {
    expect(sanitizeCorrelationId("has space")).toBeUndefined()
    expect(sanitizeCorrelationId("line\nbreak")).toBeUndefined()
    expect(sanitizeCorrelationId("nul\x00byte")).toBeUndefined()
    expect(sanitizeCorrelationId("emoji😀")).toBeUndefined()
  })

  it("rejects an oversized id (bounds abuse)", () => {
    expect(sanitizeCorrelationId("a".repeat(129))).toBeUndefined()
    expect(sanitizeCorrelationId("a".repeat(128))).toBe("a".repeat(128))
  })
})
