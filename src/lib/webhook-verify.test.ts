// HMAC signature verification — Linear signs every webhook with HMAC-SHA256
// of the raw body using the per-app signing secret. We compute the same
// digest locally and compare in constant time. These tests use the same
// crypto.subtle API the Worker uses, so the production code path is exercised.

import { describe, expect, it } from "vitest"
import { verifyLinearWebhook } from "@/src/lib/webhook-verify"

const SECRET = "test-secret-do-not-use-in-prod"
const encoder = new TextEncoder()

async function sign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(body))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

describe("verifyLinearWebhook", () => {
  it("accepts a correctly signed body", async () => {
    const body = JSON.stringify({ action: "create", type: "Issue", data: { id: "abc" } })
    const sig = await sign(body, SECRET)
    expect(await verifyLinearWebhook(body, sig, SECRET)).toBe(true)
  })

  it("rejects when the body has been tampered with", async () => {
    const body = JSON.stringify({ action: "create", type: "Issue", data: { id: "abc" } })
    const sig = await sign(body, SECRET)
    const tampered = body.replace("abc", "xyz")
    expect(await verifyLinearWebhook(tampered, sig, SECRET)).toBe(false)
  })

  it("rejects when the secret differs", async () => {
    const body = "{}"
    const sig = await sign(body, "wrong-secret")
    expect(await verifyLinearWebhook(body, sig, SECRET)).toBe(false)
  })

  it("rejects empty signature", async () => {
    expect(await verifyLinearWebhook("body", "", SECRET)).toBe(false)
  })

  it("rejects empty secret", async () => {
    const sig = await sign("body", SECRET)
    expect(await verifyLinearWebhook("body", sig, "")).toBe(false)
  })

  it("is case-insensitive on the hex signature", async () => {
    const body = "{}"
    const sig = await sign(body, SECRET)
    expect(await verifyLinearWebhook(body, sig.toUpperCase(), SECRET)).toBe(true)
  })

  it("rejects signatures of wrong length", async () => {
    expect(await verifyLinearWebhook("body", "deadbeef", SECRET)).toBe(false)
  })
})
