import { describe, expect, it } from "vitest"
import { verifyStripeSignature } from "@/src/features/billing/adapters/verify-stripe-signature"
import { signStripeBody } from "@/src/features/billing/adapters/stripe-sign.test-helpers"

const SECRET = "whsec_test_secret"
const NOW = 1_700_000_000

describe("verifyStripeSignature", () => {
  it("accepts a correctly signed body within tolerance", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" })
    const header = await signStripeBody(body, SECRET, NOW)
    expect(
      await verifyStripeSignature({ rawBody: body, signatureHeader: header, secret: SECRET, nowSeconds: NOW }),
    ).toBe(true)
  })

  it("rejects a tampered body", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" })
    const header = await signStripeBody(body, SECRET, NOW)
    const tampered = body.replace("invoice.paid", "invoice.voided")
    expect(
      await verifyStripeSignature({ rawBody: tampered, signatureHeader: header, secret: SECRET, nowSeconds: NOW }),
    ).toBe(false)
  })

  it("rejects a wrong secret", async () => {
    const body = "{}"
    const header = await signStripeBody(body, "whsec_other", NOW)
    expect(
      await verifyStripeSignature({ rawBody: body, signatureHeader: header, secret: SECRET, nowSeconds: NOW }),
    ).toBe(false)
  })

  it("rejects an out-of-tolerance (replayed) timestamp", async () => {
    const body = "{}"
    const header = await signStripeBody(body, SECRET, NOW)
    // 10 minutes later, default 5-minute tolerance.
    expect(
      await verifyStripeSignature({ rawBody: body, signatureHeader: header, secret: SECRET, nowSeconds: NOW + 600 }),
    ).toBe(false)
  })

  it("returns false for a missing header or empty secret", async () => {
    expect(await verifyStripeSignature({ rawBody: "{}", signatureHeader: null, secret: SECRET, nowSeconds: NOW })).toBe(
      false,
    )
    const header = await signStripeBody("{}", SECRET, NOW)
    expect(await verifyStripeSignature({ rawBody: "{}", signatureHeader: header, secret: "", nowSeconds: NOW })).toBe(
      false,
    )
  })

  it("accepts when ANY v1 in a rotation-window header matches", async () => {
    const body = "{}"
    const good = await signStripeBody(body, SECRET, NOW) // t=..,v1=<good>
    const hex = good.split("v1=")[1]!
    const header = `t=${NOW},v1=deadbeef,v1=${hex}`
    expect(
      await verifyStripeSignature({ rawBody: body, signatureHeader: header, secret: SECRET, nowSeconds: NOW }),
    ).toBe(true)
  })
})
