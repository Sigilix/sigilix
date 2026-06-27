// Slack request signature verification tests.
// Slack signs requests using HMAC-SHA256 of "v0:<timestamp>:<rawBody>" with the
// app signing secret, then sends the digest as "v0=<hex>" in X-Slack-Signature.
// The timestamp is in X-Slack-Request-Timestamp (Unix seconds). Requests older
// than 5 minutes are rejected as replays.

import { describe, expect, it } from "vitest"
import { verifySlackSignature } from "@/src/lib/slack/slack-verify"

const SECRET = "test-slack-signing-secret"
const encoder = new TextEncoder()

/** Produce a valid Slack v0 HMAC signature for the given inputs. */
async function sign(ts: string, body: string, secret: string): Promise<string> {
  const basestring = `v0:${ts}:${body}`
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(basestring))
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  return `v0=${hex}`
}

describe("verifySlackSignature", () => {
  it("accepts a fresh correctly-signed request", async () => {
    const nowMs = Date.now()
    const ts = String(Math.floor(nowMs / 1000))
    const body = JSON.stringify({ event: "message", text: "hello" })
    const sig = await sign(ts, body, SECRET)
    expect(await verifySlackSignature({ rawBody: body, signature: sig, timestamp: ts, signingSecret: SECRET, nowMs })).toBe(true)
  })

  it("rejects a request with a wrong signature", async () => {
    const nowMs = Date.now()
    const ts = String(Math.floor(nowMs / 1000))
    const body = "{}"
    const sig = await sign(ts, body, "wrong-secret")
    expect(await verifySlackSignature({ rawBody: body, signature: sig, timestamp: ts, signingSecret: SECRET, nowMs })).toBe(false)
  })

  it("rejects a stale request older than 5 minutes", async () => {
    const nowMs = Date.now()
    const staleTs = String(Math.floor(nowMs / 1000) - 301)
    const body = "{}"
    const sig = await sign(staleTs, body, SECRET)
    expect(await verifySlackSignature({ rawBody: body, signature: sig, timestamp: staleTs, signingSecret: SECRET, nowMs })).toBe(false)
  })

  it("rejects a future timestamp beyond 5 minutes", async () => {
    const nowMs = Date.now()
    const futureTs = String(Math.floor(nowMs / 1000) + 301)
    const body = "{}"
    const sig = await sign(futureTs, body, SECRET)
    expect(await verifySlackSignature({ rawBody: body, signature: sig, timestamp: futureTs, signingSecret: SECRET, nowMs })).toBe(false)
  })

  it("rejects when signature is null", async () => {
    const nowMs = Date.now()
    const ts = String(Math.floor(nowMs / 1000))
    expect(await verifySlackSignature({ rawBody: "{}", signature: null, timestamp: ts, signingSecret: SECRET, nowMs })).toBe(false)
  })

  it("rejects when timestamp is null", async () => {
    const nowMs = Date.now()
    const ts = String(Math.floor(nowMs / 1000))
    const sig = await sign(ts, "{}", SECRET)
    expect(await verifySlackSignature({ rawBody: "{}", signature: sig, timestamp: null, signingSecret: SECRET, nowMs })).toBe(false)
  })

  it("rejects when timestamp is not a number (NaN)", async () => {
    const nowMs = Date.now()
    const sig = await sign("notanumber", "{}", SECRET)
    expect(await verifySlackSignature({ rawBody: "{}", signature: sig, timestamp: "notanumber", signingSecret: SECRET, nowMs })).toBe(false)
  })

  it("is case-insensitive on the hex signature", async () => {
    const nowMs = Date.now()
    const ts = String(Math.floor(nowMs / 1000))
    const body = "{}"
    const sig = await sign(ts, body, SECRET)
    expect(await verifySlackSignature({ rawBody: body, signature: sig.toUpperCase(), timestamp: ts, signingSecret: SECRET, nowMs })).toBe(true)
  })

  it("accepts a request exactly at the 5-minute boundary (300s)", async () => {
    const nowMs = Date.now()
    const boundaryTs = String(Math.floor(nowMs / 1000) - 300)
    const body = "{}"
    const sig = await sign(boundaryTs, body, SECRET)
    expect(await verifySlackSignature({ rawBody: body, signature: sig, timestamp: boundaryTs, signingSecret: SECRET, nowMs })).toBe(true)
  })
})
