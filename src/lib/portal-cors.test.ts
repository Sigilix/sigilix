// #155 onboarding-backend slice 3 — CORS-with-credentials helper tests.

import { describe, expect, it } from "vitest"
import { handlePortalPreflight, isAllowedPortalOrigin, withPortalCors, type PortalCorsEnv } from "@/src/lib/portal-cors"

const DEFAULT_ENV: PortalCorsEnv = {}
const CUSTOM_ENV: PortalCorsEnv = { OPENCLAW_PORTAL_ORIGINS: "https://custom.example,https://second.example" }

describe("isAllowedPortalOrigin", () => {
  it("defaults to the prod portal + localhost dev server", () => {
    expect(isAllowedPortalOrigin("https://app.sigilix.ai", DEFAULT_ENV)).toBe(true)
    expect(isAllowedPortalOrigin("http://localhost:3300", DEFAULT_ENV)).toBe(true)
  })

  it("allows the marketing origins so the site nav can read /auth/session", () => {
    expect(isAllowedPortalOrigin("https://sigilix.ai", DEFAULT_ENV)).toBe(true)
    expect(isAllowedPortalOrigin("https://www.sigilix.ai", DEFAULT_ENV)).toBe(true)
  })

  it("rejects a non-allowlisted origin", () => {
    expect(isAllowedPortalOrigin("https://evil.example", DEFAULT_ENV)).toBe(false)
  })

  it("rejects null (no Origin header)", () => {
    expect(isAllowedPortalOrigin(null, DEFAULT_ENV)).toBe(false)
  })

  it("does not substring/suffix match — a look-alike origin is rejected", () => {
    expect(isAllowedPortalOrigin("https://app.sigilix.ai.evil.example", DEFAULT_ENV)).toBe(false)
    expect(isAllowedPortalOrigin("https://notapp.sigilix.ai", DEFAULT_ENV)).toBe(false)
  })

  it("honors OPENCLAW_PORTAL_ORIGINS override", () => {
    expect(isAllowedPortalOrigin("https://custom.example", CUSTOM_ENV)).toBe(true)
    expect(isAllowedPortalOrigin("https://second.example", CUSTOM_ENV)).toBe(true)
    // The default prod portal is NOT allowed once the env var overrides the list.
    expect(isAllowedPortalOrigin("https://app.sigilix.ai", CUSTOM_ENV)).toBe(false)
  })
})

describe("withPortalCors", () => {
  function req(origin: string | null): Request {
    const headers = new Headers()
    if (origin) headers.set("origin", origin)
    return new Request("https://worker.example/v1/keys", { headers })
  }

  it("echoes the EXACT allowlisted origin — never a wildcard", () => {
    const res = withPortalCors(req("https://app.sigilix.ai"), new Response("ok", { status: 200 }), DEFAULT_ENV)
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.sigilix.ai")
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*")
    expect(res.headers.get("access-control-allow-credentials")).toBe("true")
  })

  it("sets no CORS headers for a non-allowlisted origin", () => {
    const res = withPortalCors(req("https://evil.example"), new Response("ok", { status: 200 }), DEFAULT_ENV)
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
    expect(res.headers.get("access-control-allow-credentials")).toBeNull()
  })

  it("always sets Vary: Origin, allowed or not", () => {
    const allowed = withPortalCors(req("https://app.sigilix.ai"), new Response("ok"), DEFAULT_ENV)
    const denied = withPortalCors(req("https://evil.example"), new Response("ok"), DEFAULT_ENV)
    const none = withPortalCors(req(null), new Response("ok"), DEFAULT_ENV)
    expect(allowed.headers.get("vary")).toBe("Origin")
    expect(denied.headers.get("vary")).toBe("Origin")
    expect(none.headers.get("vary")).toBe("Origin")
  })

  it("preserves the wrapped response's status + body", async () => {
    const res = withPortalCors(
      req("https://app.sigilix.ai"),
      new Response(JSON.stringify({ hello: "world" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
      DEFAULT_ENV,
    )
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ hello: "world" })
    expect(res.headers.get("content-type")).toBe("application/json")
  })
})

describe("handlePortalPreflight", () => {
  function preflightReq(origin: string | null): Request {
    const headers = new Headers()
    if (origin) headers.set("origin", origin)
    return new Request("https://worker.example/v1/keys", { method: "OPTIONS", headers })
  }

  it("204s an allowlisted origin with the full CORS grant", () => {
    const res = handlePortalPreflight(preflightReq("http://localhost:3300"), DEFAULT_ENV)
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3300")
    expect(res.headers.get("access-control-allow-credentials")).toBe("true")
    expect(res.headers.get("access-control-allow-methods")).toContain("POST")
    expect(res.headers.get("access-control-allow-methods")).toContain("DELETE")
    expect(res.headers.get("access-control-allow-headers")).toContain("content-type")
    expect(res.headers.get("access-control-max-age")).toBeTruthy()
    expect(res.headers.get("vary")).toBe("Origin")
  })

  it("403s a non-allowlisted origin with NO CORS headers", () => {
    const res = handlePortalPreflight(preflightReq("https://evil.example"), DEFAULT_ENV)
    expect(res.status).toBe(403)
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
    expect(res.headers.get("access-control-allow-credentials")).toBeNull()
  })

  it("403s a preflight with no Origin header at all", () => {
    const res = handlePortalPreflight(preflightReq(null), DEFAULT_ENV)
    expect(res.status).toBe(403)
  })
})
