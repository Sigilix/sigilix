// SIG-119 — bearer-token auth for the /metrics/validation endpoint.

import { describe, expect, it } from "vitest"
import { extractBearerToken, requireBearerToken, sha256Hex } from "@/src/lib/auth-bearer"

const TOKEN = "s3cr3t-metrics-token"
const reqWith = (auth?: string) =>
  new Request("https://x/metrics/validation", auth ? { headers: { authorization: auth } } : undefined)

describe("requireBearerToken", () => {
  it("accepts a matching Bearer token", async () => {
    expect(await requireBearerToken(reqWith(`Bearer ${TOKEN}`), TOKEN)).toBe(true)
  })

  it("rejects a wrong token", async () => {
    expect(await requireBearerToken(reqWith("Bearer nope"), TOKEN)).toBe(false)
  })

  it("rejects a missing Authorization header", async () => {
    expect(await requireBearerToken(reqWith(), TOKEN)).toBe(false)
  })

  it("rejects a non-Bearer scheme", async () => {
    expect(await requireBearerToken(reqWith(`Basic ${TOKEN}`), TOKEN)).toBe(false)
  })

  it("rejects when the expected token is empty", async () => {
    expect(await requireBearerToken(reqWith("Bearer "), "")).toBe(false)
  })

  it("is case-insensitive on the scheme keyword", async () => {
    expect(await requireBearerToken(reqWith(`bearer ${TOKEN}`), TOKEN)).toBe(true)
  })
})

describe("extractBearerToken", () => {
  it("returns the token from a well-formed Bearer header", () => {
    expect(extractBearerToken(reqWith(`Bearer ${TOKEN}`))).toBe(TOKEN)
  })

  it("returns null when the header is missing", () => {
    expect(extractBearerToken(reqWith())).toBeNull()
  })

  it("returns null for a non-Bearer scheme", () => {
    expect(extractBearerToken(reqWith(`Basic ${TOKEN}`))).toBeNull()
  })

  it("is case-insensitive on the scheme keyword", () => {
    expect(extractBearerToken(reqWith(`bearer ${TOKEN}`))).toBe(TOKEN)
  })
})

describe("sha256Hex", () => {
  it("returns a 64-char lowercase hex digest", async () => {
    const hex = await sha256Hex(TOKEN)
    expect(hex).toMatch(/^[0-9a-f]{64}$/)
  })

  it("is deterministic for the same input", async () => {
    expect(await sha256Hex(TOKEN)).toBe(await sha256Hex(TOKEN))
  })

  it("differs for different inputs", async () => {
    expect(await sha256Hex(TOKEN)).not.toBe(await sha256Hex(`${TOKEN}x`))
  })
})
