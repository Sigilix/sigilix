// SIG-455 (PR B Task 2) — typed provider rate-limit error.
// TDD red written before the implementation file exists.

import { describe, expect, it } from "vitest"
import { ProviderRateLimitError, isProviderRateLimit } from "@/src/shared/adapters/model/provider-errors"

describe("ProviderRateLimitError", () => {
  it("is an instance of Error", () => {
    const e = new ProviderRateLimitError("OpenRouter HTTP 429: rate limited", 5000)
    expect(e).toBeInstanceOf(Error)
  })

  it("has name ProviderRateLimitError", () => {
    const e = new ProviderRateLimitError("msg", 1000)
    expect(e.name).toBe("ProviderRateLimitError")
  })

  it("preserves the message", () => {
    const e = new ProviderRateLimitError("OpenRouter HTTP 429: too many requests", 3000)
    expect(e.message).toBe("OpenRouter HTTP 429: too many requests")
  })

  it("stores retryAfterMs", () => {
    const e = new ProviderRateLimitError("msg", 20_000)
    expect(e.retryAfterMs).toBe(20_000)
  })

  it("stores optional provider when supplied", () => {
    const e = new ProviderRateLimitError("msg", 5000, "openrouter")
    expect(e.provider).toBe("openrouter")
  })

  it("omits provider field when not supplied", () => {
    const e = new ProviderRateLimitError("msg", 5000)
    expect(e.provider).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(e, "provider")).toBe(false)
  })

  it("can be thrown and caught", () => {
    const fn = (): void => {
      throw new ProviderRateLimitError("OpenRouter HTTP 503: unavailable", 10_000)
    }
    expect(fn).toThrow(ProviderRateLimitError)
    expect(fn).toThrow(/503/)
  })
})

describe("isProviderRateLimit", () => {
  it("returns true for a ProviderRateLimitError instance", () => {
    const e = new ProviderRateLimitError("msg", 5000)
    expect(isProviderRateLimit(e)).toBe(true)
  })

  it("returns false for a plain Error", () => {
    expect(isProviderRateLimit(new Error("plain"))).toBe(false)
  })

  it("returns false for null", () => {
    expect(isProviderRateLimit(null)).toBe(false)
  })

  it("returns false for a string", () => {
    expect(isProviderRateLimit("rate limited")).toBe(false)
  })

  it("returns false for undefined", () => {
    expect(isProviderRateLimit(undefined)).toBe(false)
  })

  it("returns false for a plain object with matching keys (no instanceof shortcut)", () => {
    expect(isProviderRateLimit({ retryAfterMs: 5000, name: "ProviderRateLimitError" })).toBe(false)
  })
})
