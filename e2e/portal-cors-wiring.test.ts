// #155 onboarding-backend slice 3 — end-to-end CORS wiring test. Drives the
// REAL worker fetch() (src/index.ts), not the individual route handlers in
// isolation, so it proves the OPTIONS-preflight + withPortalCors wrapping is
// actually wired to /v1/keys, /v1/keys/:id, /v1/onboarding,
// /v1/onboarding/context, and (sig-workspace-prs) /v1/workspace/prs — not
// just that portal-cors.ts works standalone.

import { afterEach, describe, expect, it, vi } from "vitest"
import worker from "@/src/index"
import { createSession, base64urlEncode } from "@/src/lib/auth-session"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(3))
const PORTAL_ORIGIN = "https://app.sigilix.ai"

function ctx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext
}

function makeKV(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: async (key: string, type?: "json") => {
      const raw = store.get(key)
      if (raw === undefined) return null
      return type === "json" ? JSON.parse(raw) : raw
    },
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
    list: async () => ({ keys: [], list_complete: true }),
  } as unknown as KVNamespace
}

async function seedSession(kv: KVNamespace, sessionId: string, githubUserId: number): Promise<void> {
  await createSession({
    kv,
    sessionId,
    login: "octocat",
    githubUserId,
    accessToken: "ghu_test_token",
    encryptionKeyB64url: ENC_KEY,
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("portal CORS wiring (real worker.fetch)", () => {
  it("OPTIONS /v1/keys from an allowlisted origin: 204 + full CORS grant", async () => {
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    const res = await worker.fetch(
      new Request("https://worker.example/v1/keys", { method: "OPTIONS", headers: { origin: PORTAL_ORIGIN } }),
      env,
      ctx(),
    )
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBe(PORTAL_ORIGIN)
    expect(res.headers.get("access-control-allow-credentials")).toBe("true")
  })

  it("OPTIONS /v1/keys from a non-allowlisted origin: 403, no CORS headers", async () => {
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    const res = await worker.fetch(
      new Request("https://worker.example/v1/keys", { method: "OPTIONS", headers: { origin: "https://evil.example" } }),
      env,
      ctx(),
    )
    expect(res.status).toBe(403)
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("OPTIONS /v1/keys/abc (DELETE preflight) is also CORS'd", async () => {
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    const res = await worker.fetch(
      new Request("https://worker.example/v1/keys/abc", { method: "OPTIONS", headers: { origin: PORTAL_ORIGIN } }),
      env,
      ctx(),
    )
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-methods")).toContain("DELETE")
  })

  it("GET /v1/onboarding/context response carries the CORS grant for an allowlisted Origin", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    const env = { OPENCLAW_STATE: kv, OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY } as unknown as Env
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }),
      ),
    )
    const res = await worker.fetch(
      new Request("https://worker.example/v1/onboarding/context", {
        headers: { origin: PORTAL_ORIGIN, cookie: `${SESSION_COOKIE}=sess-1` },
      }),
      env,
      ctx(),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("access-control-allow-origin")).toBe(PORTAL_ORIGIN)
    expect(res.headers.get("access-control-allow-credentials")).toBe("true")
  })

  it("GET /v1/onboarding/context WITHOUT a matching Origin header carries no CORS grant (same-origin caller)", async () => {
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    const res = await worker.fetch(new Request("https://worker.example/v1/onboarding/context"), env, ctx())
    expect(res.status).toBe(401) // no session either — just confirms no CORS headers leak in
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("POST /v1/onboarding response carries the CORS grant + stores the payload", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    const res = await worker.fetch(
      new Request("https://worker.example/v1/onboarding", {
        method: "POST",
        headers: { origin: PORTAL_ORIGIN, cookie: `${SESSION_COOKIE}=sess-1`, "content-type": "application/json" },
        body: JSON.stringify({ fullName: "Ada" }),
      }),
      env,
      ctx(),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("access-control-allow-origin")).toBe(PORTAL_ORIGIN)
    expect(await kv.get("onboarding:111", "json")).toEqual({ fullName: "Ada" })
  })

  it("OPTIONS /v1/workspace/prs from an allowlisted origin: 204 + full CORS grant", async () => {
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    const res = await worker.fetch(
      new Request("https://worker.example/v1/workspace/prs", { method: "OPTIONS", headers: { origin: PORTAL_ORIGIN } }),
      env,
      ctx(),
    )
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBe(PORTAL_ORIGIN)
    expect(res.headers.get("access-control-allow-credentials")).toBe("true")
  })

  it("OPTIONS /v1/workspace/prs from a non-allowlisted origin: 403, no CORS headers", async () => {
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    const res = await worker.fetch(
      new Request("https://worker.example/v1/workspace/prs", {
        method: "OPTIONS",
        headers: { origin: "https://evil.example" },
      }),
      env,
      ctx(),
    )
    expect(res.status).toBe(403)
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("GET /v1/workspace/prs response carries the CORS grant for an allowlisted Origin", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    const env = { OPENCLAW_STATE: kv, OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY } as unknown as Env
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ total_count: 0, installations: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    )
    const res = await worker.fetch(
      new Request("https://worker.example/v1/workspace/prs", {
        headers: { origin: PORTAL_ORIGIN, cookie: `${SESSION_COOKIE}=sess-1` },
      }),
      env,
      ctx(),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("access-control-allow-origin")).toBe(PORTAL_ORIGIN)
    expect(res.headers.get("access-control-allow-credentials")).toBe("true")
  })

  it("GET /v1/workspace/prs without any auth is a 401, CORS'd (never leaks org data)", async () => {
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    const res = await worker.fetch(
      new Request("https://worker.example/v1/workspace/prs", { headers: { origin: PORTAL_ORIGIN } }),
      env,
      ctx(),
    )
    expect(res.status).toBe(401)
    expect(res.headers.get("access-control-allow-origin")).toBe(PORTAL_ORIGIN)
  })

  it("POST /v1/keys response carries the CORS grant (existing key route, now CORS'd)", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    const env = { OPENCLAW_STATE: kv } as unknown as Env // no SIGILIX_PLATFORM_DB -> 503, but CORS still applies
    const res = await worker.fetch(
      new Request("https://worker.example/v1/keys", {
        method: "POST",
        headers: { origin: PORTAL_ORIGIN, cookie: `${SESSION_COOKIE}=sess-1`, "content-type": "application/json" },
        body: JSON.stringify({ installationId: 1 }),
      }),
      env,
      ctx(),
    )
    expect(res.status).toBe(503)
    expect(res.headers.get("access-control-allow-origin")).toBe(PORTAL_ORIGIN)
  })
})
