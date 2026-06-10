// SIG-119 — bearer-token auth for the /metrics/validation endpoint.

import { describe, expect, it } from "vitest"
import { requireBearerToken } from "@/lib/auth-bearer"

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
