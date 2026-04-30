// GitHub webhook signature verification — GitHub signs each delivery
// with HMAC-SHA256 of the raw body using the App's webhook secret, and
// sends `sha256=<hex>` in the X-Hub-Signature-256 header. We round-trip
// the same crypto.subtle path the Worker uses so the production code is
// exercised.

import { describe, expect, it } from "vitest"
import { verifyGitHubWebhook } from "../src/lib/github-webhook-verify"

const SECRET = "github-test-secret"
const encoder = new TextEncoder()

async function signWithPrefix(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(body))
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  return `sha256=${hex}`
}

describe("verifyGitHubWebhook", () => {
  it("accepts a correctly signed body", async () => {
    const body = JSON.stringify({ action: "opened", number: 42 })
    const sig = await signWithPrefix(body, SECRET)
    expect(await verifyGitHubWebhook(body, sig, SECRET)).toBe(true)
  })

  it("rejects a tampered body", async () => {
    const body = JSON.stringify({ action: "opened", number: 42 })
    const sig = await signWithPrefix(body, SECRET)
    expect(await verifyGitHubWebhook(body.replace("opened", "closed"), sig, SECRET)).toBe(false)
  })

  it("rejects a signature without the sha256= prefix", async () => {
    const body = "{}"
    const sig = await signWithPrefix(body, SECRET)
    const stripped = sig.replace(/^sha256=/, "")
    expect(await verifyGitHubWebhook(body, stripped, SECRET)).toBe(false)
  })

  it("rejects when the secret differs", async () => {
    const body = "{}"
    const sig = await signWithPrefix(body, "different-secret")
    expect(await verifyGitHubWebhook(body, sig, SECRET)).toBe(false)
  })

  it("rejects empty inputs", async () => {
    expect(await verifyGitHubWebhook("body", "", SECRET)).toBe(false)
    const sig = await signWithPrefix("body", SECRET)
    expect(await verifyGitHubWebhook("body", sig, "")).toBe(false)
    expect(await verifyGitHubWebhook("body", "sha256=", SECRET)).toBe(false)
  })

  it("is case-insensitive on the hex digest portion", async () => {
    // GitHub always sends `sha256=` in lowercase; the prefix check is
    // strict on that. Only the hex digest portion needs case insensitivity.
    const body = "{}"
    const sig = await signWithPrefix(body, SECRET)
    const upperHex = "sha256=" + sig.slice("sha256=".length).toUpperCase()
    expect(await verifyGitHubWebhook(body, upperHex, SECRET)).toBe(true)
  })
})
