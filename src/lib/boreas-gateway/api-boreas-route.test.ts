// SIG-545 — the authenticated gateway route: auth gating (503/401) BEFORE any GCP
// call, model forcing, response passthrough, and request metering.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { handleBoreasApiRoute } from "@/src/lib/boreas-gateway/api-boreas-route"
import { __resetVertexTokenCacheForTests } from "@/src/lib/boreas-gateway/vertex-token"
import { __resetSigningKeyCacheForTests } from "@/src/lib/boreas-gateway/oidc"
import {
  STS_TOKEN_URL,
  GENERATE_ACCESS_TOKEN_URL,
  VERTEX_CHAT_COMPLETIONS_URL,
  VERTEX_MODEL,
} from "@/src/lib/boreas-gateway/constants"
import { makeEnv, makeCtx } from "@/src/lib/boreas-gateway/boreas-gateway.test-helpers"

const KEY = "secret-bearer"
const ISSUER = "https://gw.example"
const jsonHeaders = { headers: { "content-type": "application/json" } }

beforeEach(() => {
  __resetVertexTokenCacheForTests()
  __resetSigningKeyCacheForTests()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function post(body: unknown, auth?: string): Request {
  return new Request("https://worker.example/v1/boreas/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  })
}

/** Stub fetch for the full STS → impersonate → Vertex chain. Returns the spy. */
function stubFullChain(): ReturnType<typeof vi.fn> {
  const f = vi.fn(async (url: string | URL | Request) => {
    const u = String(url)
    if (u === STS_TOKEN_URL) return new Response(JSON.stringify({ access_token: "fed-token" }), jsonHeaders)
    if (u === GENERATE_ACCESS_TOKEN_URL) {
      return new Response(
        JSON.stringify({ accessToken: "sa-token", expireTime: new Date(Date.now() + 3600_000).toISOString() }),
        jsonHeaders,
      )
    }
    if (u === VERTEX_CHAT_COMPLETIONS_URL) {
      return new Response(JSON.stringify({ id: "cmpl-1", choices: [{ message: { content: "hi" } }] }), jsonHeaders)
    }
    throw new Error(`unexpected fetch: ${u}`)
  })
  vi.stubGlobal("fetch", f)
  return f
}

describe("handleBoreasApiRoute — auth gating", () => {
  it("503 when OPENCLAW_SIGILIX_API_KEY is unset — no GCP fetch", async () => {
    const f = vi.fn()
    vi.stubGlobal("fetch", f)
    const env = makeEnv({ OPENCLAW_GATEWAY_ISSUER: ISSUER }) // key unset
    const { ctx } = makeCtx()
    const res = await handleBoreasApiRoute(post({ messages: [] }, `Bearer ${KEY}`), env, ctx)
    expect(res.status).toBe(503)
    expect(f).not.toHaveBeenCalled()
  })

  it("503 when OPENCLAW_GATEWAY_ISSUER is unset — no GCP fetch", async () => {
    const f = vi.fn()
    vi.stubGlobal("fetch", f)
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY }) // issuer unset
    const { ctx } = makeCtx()
    const res = await handleBoreasApiRoute(post({ messages: [] }, `Bearer ${KEY}`), env, ctx)
    expect(res.status).toBe(503)
    expect(f).not.toHaveBeenCalled()
  })

  it("401 on a bad bearer — BEFORE any GCP fetch / token mint", async () => {
    const f = vi.fn()
    vi.stubGlobal("fetch", f)
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER })
    const { ctx } = makeCtx()
    const res = await handleBoreasApiRoute(post({ messages: [] }, "Bearer wrong"), env, ctx)
    expect(res.status).toBe(401)
    expect(f).not.toHaveBeenCalled() // proves no STS/Vertex call on a 401
  })

  it("401 on a missing bearer — no GCP fetch", async () => {
    const f = vi.fn()
    vi.stubGlobal("fetch", f)
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER })
    const { ctx } = makeCtx()
    const res = await handleBoreasApiRoute(post({ messages: [] }), env, ctx)
    expect(res.status).toBe(401)
    expect(f).not.toHaveBeenCalled()
  })
})

describe("handleBoreasApiRoute — proxy", () => {
  it("forces the model id, passes the Vertex response through, and meters the counter", async () => {
    const f = stubFullChain()
    const store = new Map<string, string>()
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER }, store)
    const { ctx } = makeCtx()

    const res = await handleBoreasApiRoute(
      post({ messages: [{ role: "user", content: "hi" }], model: "attacker/chosen-model" }, `Bearer ${KEY}`),
      env,
      ctx,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { id?: string }
    expect(body.id).toBe("cmpl-1") // upstream body passed through

    // The forwarded Vertex request forced the pinned model id.
    const vertexCall = f.mock.calls.find((c) => String(c[0]) === VERTEX_CHAT_COMPLETIONS_URL)
    expect(vertexCall).toBeDefined()
    const init = vertexCall![1] as RequestInit
    const sent = JSON.parse(init.body as string) as { model?: string }
    expect(sent.model).toBe(VERTEX_MODEL)
    expect(sent.model).not.toBe("attacker/chosen-model")
    // Authorization is the minted SA token, not the caller's bearer.
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sa-token")

    // The request was metered under today's counter.
    const day = new Date().toISOString().slice(0, 10)
    expect(await store.get(`boreas:count:${day}`)).toBe("1")
  })

  it("502 when the GCP token mint fails (STS error) — never a clean pass", async () => {
    const f = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u === STS_TOKEN_URL) return new Response("nope", { status: 403 })
      throw new Error(`unexpected fetch: ${u}`)
    })
    vi.stubGlobal("fetch", f)
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER })
    const { ctx } = makeCtx()
    const res = await handleBoreasApiRoute(post({ messages: [] }, `Bearer ${KEY}`), env, ctx)
    expect(res.status).toBe(502)
    // Vertex was never reached.
    expect(f.mock.calls.some((c) => String(c[0]) === VERTEX_CHAT_COMPLETIONS_URL)).toBe(false)
  })

  it("does NOT leak the GCP error body (SA email / pool / provider / project) on an STS failure", async () => {
    // A realistic STS error body that names the federation identity.
    const leaky =
      "permission denied for pool sigilix-gateway-pool provider sigilix-worker-oidc " +
      "sa sigilix-vertex@sigilix-496118.iam.gserviceaccount.com project 102681693225"
    const f = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u === STS_TOKEN_URL) return new Response(leaky, { status: 403 })
      throw new Error(`unexpected fetch: ${u}`)
    })
    vi.stubGlobal("fetch", f)
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER })
    const { ctx } = makeCtx()
    const res = await handleBoreasApiRoute(post({ messages: [] }, `Bearer ${KEY}`), env, ctx)
    expect(res.status).toBe(502)
    const text = await res.text()
    expect(text).not.toContain("sigilix-gateway-pool")
    expect(text).not.toContain("sigilix-worker-oidc")
    expect(text).not.toContain("sigilix-vertex@sigilix-496118.iam.gserviceaccount.com")
    expect(text).not.toContain("102681693225")
  })

  it("429 over the daily ceiling — AFTER auth but BEFORE any GCP fetch", async () => {
    const f = vi.fn()
    vi.stubGlobal("fetch", f)
    const store = new Map<string, string>()
    const day = new Date().toISOString().slice(0, 10)
    store.set(`boreas:count:${day}`, "5") // already at the limit
    const env = makeEnv(
      { OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER, OPENCLAW_BOREAS_DAILY_LIMIT: "5" },
      store,
    )
    const { ctx } = makeCtx()
    const res = await handleBoreasApiRoute(post({ messages: [] }, `Bearer ${KEY}`), env, ctx)
    expect(res.status).toBe(429)
    expect(f).not.toHaveBeenCalled() // no token mint, no Vertex call
  })

  it("400 on a non-object JSON body", async () => {
    stubFullChain()
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER })
    const { ctx } = makeCtx()
    const res = await handleBoreasApiRoute(post([1, 2, 3], `Bearer ${KEY}`), env, ctx)
    expect(res.status).toBe(400)
  })
})
