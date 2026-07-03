// auth-totp: RFC 6238 roundtrip at a fixed clock, skew window, and rejection
// of malformed / wrong codes. (Phase-1 crypto core — verified even though MFA
// is not yet enforced.)

import { describe, it, expect } from "vitest"
import { buildOtpAuthUri, generateTotpSecret, verifyTotp } from "@/src/lib/auth-totp"

// A known RFC 6238 SHA-1 test vector: secret "12345678901234567890" base32-encoded.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

describe("auth-totp", () => {
  it("generates a base32 secret and a scannable otpauth URI", () => {
    const secret = generateTotpSecret()
    expect(secret).toMatch(/^[A-Z2-7]+$/)
    const uri = buildOtpAuthUri({ secret, account: "user@example.com" })
    expect(uri.startsWith("otpauth://totp/")).toBe(true)
    expect(uri).toContain(`secret=${secret}`)
    expect(uri).toContain("issuer=Sigilix")
  })

  it("verifies a self-issued code at a fixed instant and rejects a wrong one", async () => {
    // Derive the current code by trying the whole space is overkill; instead
    // generate a secret, compute a code via a known instant, and verify it.
    const atMs = 59_000 // RFC 6238 test time T=59s
    // Brute a valid 6-digit code for RFC_SECRET at atMs by scanning is unnecessary:
    // verifyTotp accepts the code it would itself emit. We assert the known vector.
    // RFC 6238 SHA-1 code at T=59 for this secret is 94287082.
    const valid = await verifyTotp(RFC_SECRET, "287082", { atMs })
    expect(valid).toBe(true)
    expect(await verifyTotp(RFC_SECRET, "000000", { atMs })).toBe(false)
  })

  it("rejects malformed input without throwing", async () => {
    expect(await verifyTotp(RFC_SECRET, "abc", { atMs: 59_000 })).toBe(false)
    expect(await verifyTotp(RFC_SECRET, "", { atMs: 59_000 })).toBe(false)
    expect(await verifyTotp("!!!not-base32!!!", "123456", { atMs: 59_000 })).toBe(false)
  })

  it("accepts a code from the adjacent step (±1 skew window)", async () => {
    const atMs = 59_000
    // The code valid at the previous step should still pass at atMs with window=1.
    const prevStepCode = await verifyTotp(RFC_SECRET, "287082", { atMs: atMs + 30_000, window: 1 })
    expect(prevStepCode).toBe(true)
  })
})
