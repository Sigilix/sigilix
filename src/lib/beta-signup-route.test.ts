import { afterEach, describe, expect, it, vi } from "vitest"
import { handleBetaSignupRoute } from "./beta-signup-route"
import type { Env } from "@/src/shared/types/env"

function formRequest(body: string): Request {
  return new Request("https://app.sigilix.ai/beta/signup", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  })
}

const envWithKey = { RESEND_API_KEY: "re_test_key" } as unknown as Env
const envNoKey = {} as unknown as Env

afterEach(() => {
  vi.restoreAllMocks()
})

describe("handleBetaSignupRoute", () => {
  it("rejects an invalid email with 400 and does not send", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const res = await handleBetaSignupRoute(formRequest("email=not-an-email"), envWithKey)
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await res.text()).toContain("valid email")
  })

  it("rejects an empty email with 400", async () => {
    const res = await handleBetaSignupRoute(formRequest("email="), envWithKey)
    expect(res.status).toBe(400)
  })

  it("sends via Resend and confirms on a valid email", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "email_123" }), { status: 200 }))
    const res = await handleBetaSignupRoute(formRequest("email=dev%40acme.com"), envWithKey)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("on the list")

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const call = fetchSpy.mock.calls[0]
    if (!call) throw new Error("fetch was not called")
    const [url, init] = call
    expect(String(url)).toBe("https://api.resend.com/emails")
    const sent = JSON.parse(String((init as RequestInit).body)) as {
      to: string[]
      reply_to?: string
      text: string
    }
    expect(sent.to).toEqual(["support@sigilix.ai"])
    expect(sent.reply_to).toBe("dev@acme.com")
    expect(sent.text).toContain("dev@acme.com")
  })

  it("returns 502 when Resend is unconfigured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const res = await handleBetaSignupRoute(formRequest("email=dev%40acme.com"), envNoKey)
    expect(res.status).toBe(502)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await res.text()).toContain("support@sigilix.ai")
  })

  it("returns 502 when Resend errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("rate limited", { status: 429 }))
    const res = await handleBetaSignupRoute(formRequest("email=dev%40acme.com"), envWithKey)
    expect(res.status).toBe(502)
  })

  it("silently absorbs a tripped honeypot without sending", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const res = await handleBetaSignupRoute(formRequest("email=dev%40acme.com&company=Acme+Inc"), envWithKey)
    expect(res.status).toBe(200)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await res.text()).toContain("on the list")
  })

  it("rejects an oversized body by content-length with 413", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const req = new Request("https://app.sigilix.ai/beta/signup", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": "999999",
      },
      body: "email=dev%40acme.com",
    })
    const res = await handleBetaSignupRoute(req, envWithKey)
    expect(res.status).toBe(413)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("treats malformed JSON as a missing email (400)", async () => {
    const req = new Request("https://app.sigilix.ai/beta/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    })
    const res = await handleBetaSignupRoute(req, envWithKey)
    expect(res.status).toBe(400)
  })

  it("rate-limits by IP once the per-window cap is hit (429)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const env = {
      RESEND_API_KEY: "re_test_key",
      OPENCLAW_STATE: {
        get: vi.fn().mockResolvedValue("5"),
        put: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as Env
    const req = new Request("https://app.sigilix.ai/beta/signup", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "CF-Connecting-IP": "203.0.113.7",
      },
      body: "email=dev%40acme.com",
    })
    const res = await handleBetaSignupRoute(req, env)
    expect(res.status).toBe(429)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("accepts a JSON body too", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "x" }), { status: 200 }))
    const req = new Request("https://app.sigilix.ai/beta/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.co" }),
    })
    const res = await handleBetaSignupRoute(req, envWithKey)
    expect(res.status).toBe(200)
  })
})
