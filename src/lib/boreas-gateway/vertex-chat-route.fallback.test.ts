// #158 — the model-gateway ordered failover chain (Vertex -> Ollama Turbo -> AWS
// Bedrock scaffold), exercised end-to-end through the real routes
// (handleBoreasApiRoute / handlePyroeisApiRoute / handleAstraeusApiRoute), the
// same entry points api-*-route.test.ts already covers for the Vertex-only path.
// This file pins the NEW behavior: only-before-first-byte failover triggers,
// the never-silent marker (header + telemetry), fail-closed when every leg
// fails, Pyroeis's no-Turbo-fallback-by-default posture, the Bedrock scaffold
// staying skipped without creds, single metering regardless of leg, and no
// secret material ever logged.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { handleBoreasApiRoute } from "@/src/lib/boreas-gateway/api-boreas-route"
import { handlePyroeisApiRoute } from "@/src/lib/boreas-gateway/api-pyroeis-route"
import { handleAstraeusApiRoute } from "@/src/lib/boreas-gateway/api-astraeus-route"
import { __resetVertexTokenCacheForTests } from "@/src/lib/boreas-gateway/vertex-token"
import { __resetSigningKeyCacheForTests } from "@/src/lib/boreas-gateway/oidc"
import {
  STS_TOKEN_URL,
  GENERATE_ACCESS_TOKEN_URL,
  VERTEX_CHAT_COMPLETIONS_URL,
  ASTRAEUS_MODEL,
  OLLAMA_TURBO_CHAT_COMPLETIONS_URL,
  DEFAULT_BOREAS_FALLBACK_TURBO_MODEL,
  DEFAULT_ASTRAEUS_FALLBACK_TURBO_MODEL,
} from "@/src/lib/boreas-gateway/constants"
import { makeEnv, makeCtx } from "@/src/lib/boreas-gateway/boreas-gateway.test-helpers"

const KEY = "secret-bearer"
const ISSUER = "https://gw.example"
const OLLAMA_KEY = "ollama-turbo-secret-key"
const jsonHeaders = { headers: { "content-type": "application/json" } }

beforeEach(() => {
  __resetVertexTokenCacheForTests()
  __resetSigningKeyCacheForTests()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function post(path: string, body: unknown, auth?: string): Request {
  return new Request(`https://worker.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  })
}

function stsAndImpersonateOk(u: string): Response | null {
  if (u === STS_TOKEN_URL) return new Response(JSON.stringify({ access_token: "fed-token" }), jsonHeaders)
  if (u === GENERATE_ACCESS_TOKEN_URL) {
    return new Response(
      JSON.stringify({ accessToken: "sa-token", expireTime: new Date(Date.now() + 3600_000).toISOString() }),
      jsonHeaders,
    )
  }
  return null
}

describe("model-gateway failover chain — #158", () => {
  it("Vertex 200 → no fallback, no marker header, no telemetry event", async () => {
    const logSpy = vi.spyOn(console, "log")
    const f = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url)
      const stock = stsAndImpersonateOk(u)
      if (stock) return stock
      if (u === VERTEX_CHAT_COMPLETIONS_URL) {
        return new Response(
          JSON.stringify({ id: "cmpl-vertex", choices: [{ message: { content: "hi" } }] }),
          jsonHeaders,
        )
      }
      throw new Error(`unexpected fetch: ${u}`)
    })
    vi.stubGlobal("fetch", f)
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER, OLLAMA_API_KEY: OLLAMA_KEY })
    const { ctx } = makeCtx()

    const res = await handleBoreasApiRoute(
      post("/v1/boreas/chat/completions", { messages: [] }, `Bearer ${KEY}`),
      env,
      ctx,
    )

    expect(res.status).toBe(200)
    expect(res.headers.get("x-sigilix-served-by")).toBeNull()
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("gateway-fallback"))).toBe(false)
    expect(f.mock.calls.some((c) => String(c[0]) === OLLAMA_TURBO_CHAT_COMPLETIONS_URL)).toBe(false)
  })

  it("Vertex 500 → Turbo leg serves the built-in default model + marker header + telemetry event", async () => {
    const logSpy = vi.spyOn(console, "log")
    const f = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url)
      const stock = stsAndImpersonateOk(u)
      if (stock) return stock
      if (u === VERTEX_CHAT_COMPLETIONS_URL) return new Response("vertex down", { status: 500 })
      if (u === OLLAMA_TURBO_CHAT_COMPLETIONS_URL) {
        return new Response(
          JSON.stringify({ id: "cmpl-turbo", choices: [{ message: { content: "hi from turbo" } }] }),
          jsonHeaders,
        )
      }
      throw new Error(`unexpected fetch: ${u}`)
    })
    vi.stubGlobal("fetch", f)
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER, OLLAMA_API_KEY: OLLAMA_KEY })
    const { ctx } = makeCtx()

    const res = await handleBoreasApiRoute(
      post("/v1/boreas/chat/completions", { messages: [] }, `Bearer ${KEY}`),
      env,
      ctx,
    )

    expect(res.status).toBe(200)
    expect(res.headers.get("x-sigilix-served-by")).toBe("turbo")
    const body = (await res.json()) as { id?: string }
    expect(body.id).toBe("cmpl-turbo")

    const turboCall = f.mock.calls.find((c) => String(c[0]) === OLLAMA_TURBO_CHAT_COMPLETIONS_URL)
    expect(turboCall).toBeDefined()
    const init = turboCall![1] as RequestInit
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${OLLAMA_KEY}`)
    const sentBody = JSON.parse(init.body as string) as { model?: string }
    expect(sentBody.model).toBe(DEFAULT_BOREAS_FALLBACK_TURBO_MODEL)

    const event = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("gateway-fallback"))
    expect(event).toBeDefined()
    const parsed = JSON.parse(event!) as Record<string, unknown>
    expect(parsed).toMatchObject({
      event: "gateway-fallback",
      sigilixModel: "boreas",
      leg: "turbo",
      upstreamModel: DEFAULT_BOREAS_FALLBACK_TURBO_MODEL,
      reason: "5xx",
    })
  })

  it("Vertex 429 → Turbo leg serves + marker + telemetry with reason 429", async () => {
    const logSpy = vi.spyOn(console, "log")
    const f = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url)
      const stock = stsAndImpersonateOk(u)
      if (stock) return stock
      if (u === VERTEX_CHAT_COMPLETIONS_URL) return new Response("rate limited", { status: 429 })
      if (u === OLLAMA_TURBO_CHAT_COMPLETIONS_URL) {
        return new Response(JSON.stringify({ id: "cmpl-turbo", choices: [] }), jsonHeaders)
      }
      throw new Error(`unexpected fetch: ${u}`)
    })
    vi.stubGlobal("fetch", f)
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER, OLLAMA_API_KEY: OLLAMA_KEY })
    const { ctx } = makeCtx()

    const res = await handleBoreasApiRoute(
      post("/v1/boreas/chat/completions", { messages: [] }, `Bearer ${KEY}`),
      env,
      ctx,
    )

    expect(res.status).toBe(200)
    expect(res.headers.get("x-sigilix-served-by")).toBe("turbo")
    const event = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("gateway-fallback"))
    expect(JSON.parse(event!)).toMatchObject({ reason: "429", leg: "turbo" })
  })

  it("Vertex connect error / timeout (a fetch that never gets a response — before any byte) → Turbo leg serves", async () => {
    // Simulates the "timeout" / "connect error" trigger class directly: the leg's own
    // fetch() call rejects before any response headers arrive (same code path an
    // AbortController-driven timeout takes — both land in attemptVertexLeg's catch
    // block and are treated as retryable), without needing to drive a real 20s clock.
    const f = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url)
      const stock = stsAndImpersonateOk(u)
      if (stock) return stock
      if (u === VERTEX_CHAT_COMPLETIONS_URL) {
        const err = new Error("The operation timed out")
        err.name = "AbortError"
        throw err
      }
      if (u === OLLAMA_TURBO_CHAT_COMPLETIONS_URL) {
        return new Response(JSON.stringify({ id: "cmpl-turbo" }), jsonHeaders)
      }
      throw new Error(`unexpected fetch: ${u}`)
    })
    vi.stubGlobal("fetch", f)
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER, OLLAMA_API_KEY: OLLAMA_KEY })
    const { ctx } = makeCtx()

    const res = await handleBoreasApiRoute(
      post("/v1/boreas/chat/completions", { messages: [] }, `Bearer ${KEY}`),
      env,
      ctx,
    )

    expect(res.status).toBe(200)
    expect(res.headers.get("x-sigilix-served-by")).toBe("turbo")
    expect(f.mock.calls.some((c) => String(c[0]) === OLLAMA_TURBO_CHAT_COMPLETIONS_URL)).toBe(true)
  })

  it("both Vertex AND Turbo fail → the real error surfaces (no fake success, no marker)", async () => {
    const f = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url)
      const stock = stsAndImpersonateOk(u)
      if (stock) return stock
      if (u === VERTEX_CHAT_COMPLETIONS_URL) return new Response("vertex down", { status: 500 })
      if (u === OLLAMA_TURBO_CHAT_COMPLETIONS_URL) return new Response("turbo also down", { status: 503 })
      throw new Error(`unexpected fetch: ${u}`)
    })
    vi.stubGlobal("fetch", f)
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER, OLLAMA_API_KEY: OLLAMA_KEY })
    const { ctx } = makeCtx()

    const res = await handleBoreasApiRoute(
      post("/v1/boreas/chat/completions", { messages: [] }, `Bearer ${KEY}`),
      env,
      ctx,
    )

    expect(res.status).toBe(503) // Turbo's real error, surfaced as-is — never a fabricated 200
    expect(res.headers.get("x-sigilix-served-by")).toBeNull()
    const text = await res.text()
    expect(text).toBe("turbo also down")
  })

  it("Pyroeis with NO configured Turbo fallback → Vertex error surfaces directly (Turbo never attempted)", async () => {
    const f = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url)
      const stock = stsAndImpersonateOk(u)
      if (stock) return stock
      if (u === VERTEX_CHAT_COMPLETIONS_URL) return new Response("vertex down", { status: 500 })
      throw new Error(`unexpected fetch: ${u}`) // proves Turbo/Bedrock are never reached
    })
    vi.stubGlobal("fetch", f)
    // OLLAMA_API_KEY IS set (so the key alone isn't what gates it) but
    // OPENCLAW_PYROEIS_FALLBACK_TURBO_MODEL is left unset — no built-in default exists.
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER, OLLAMA_API_KEY: OLLAMA_KEY })
    const { ctx } = makeCtx()

    const res = await handlePyroeisApiRoute(
      post("/v1/pyroeis/chat/completions", { messages: [] }, `Bearer ${KEY}`),
      env,
      ctx,
    )

    expect(res.status).toBe(500)
    expect(res.headers.get("x-sigilix-served-by")).toBeNull()
    expect(f.mock.calls.some((c) => String(c[0]) === OLLAMA_TURBO_CHAT_COMPLETIONS_URL)).toBe(false)
  })

  it("Pyroeis DOES fall back once OPENCLAW_PYROEIS_FALLBACK_TURBO_MODEL is explicitly configured", async () => {
    const f = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url)
      const stock = stsAndImpersonateOk(u)
      if (stock) return stock
      if (u === VERTEX_CHAT_COMPLETIONS_URL) return new Response("vertex down", { status: 500 })
      if (u === OLLAMA_TURBO_CHAT_COMPLETIONS_URL)
        return new Response(JSON.stringify({ id: "cmpl-turbo" }), jsonHeaders)
      throw new Error(`unexpected fetch: ${u}`)
    })
    vi.stubGlobal("fetch", f)
    const env = makeEnv({
      OPENCLAW_SIGILIX_API_KEY: KEY,
      OPENCLAW_GATEWAY_ISSUER: ISSUER,
      OLLAMA_API_KEY: OLLAMA_KEY,
      OPENCLAW_PYROEIS_FALLBACK_TURBO_MODEL: "some-gemma-tag:cloud",
    })
    const { ctx } = makeCtx()

    const res = await handlePyroeisApiRoute(
      post("/v1/pyroeis/chat/completions", { messages: [] }, `Bearer ${KEY}`),
      env,
      ctx,
    )

    expect(res.status).toBe(200)
    expect(res.headers.get("x-sigilix-served-by")).toBe("turbo")
    const turboCall = f.mock.calls.find((c) => String(c[0]) === OLLAMA_TURBO_CHAT_COMPLETIONS_URL)
    const sentBody = JSON.parse((turboCall![1] as RequestInit).body as string) as { model?: string }
    expect(sentBody.model).toBe("some-gemma-tag:cloud")
  })

  it("Astraeus uses glm-5.2:cloud as its built-in Turbo fallback default", async () => {
    const f = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url)
      const stock = stsAndImpersonateOk(u)
      if (stock) return stock
      if (u === VERTEX_CHAT_COMPLETIONS_URL) return new Response("vertex down", { status: 502 })
      if (u === OLLAMA_TURBO_CHAT_COMPLETIONS_URL)
        return new Response(JSON.stringify({ id: "cmpl-turbo" }), jsonHeaders)
      throw new Error(`unexpected fetch: ${u}`)
    })
    vi.stubGlobal("fetch", f)
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER, OLLAMA_API_KEY: OLLAMA_KEY })
    const { ctx } = makeCtx()

    const res = await handleAstraeusApiRoute(
      post("/v1/astraeus/chat/completions", { messages: [] }, `Bearer ${KEY}`),
      env,
      ctx,
    )

    expect(res.status).toBe(200)
    const turboCall = f.mock.calls.find((c) => String(c[0]) === OLLAMA_TURBO_CHAT_COMPLETIONS_URL)
    const sentBody = JSON.parse((turboCall![1] as RequestInit).body as string) as { model?: string }
    expect(sentBody.model).toBe(DEFAULT_ASTRAEUS_FALLBACK_TURBO_MODEL)
    expect(DEFAULT_ASTRAEUS_FALLBACK_TURBO_MODEL).toBe("glm-5.2:cloud")
    // Regression guard mirroring the sibling suite: Astraeus's forced Vertex model
    // is untouched by this refactor.
    const vertexCall = f.mock.calls.find((c) => String(c[0]) === VERTEX_CHAT_COMPLETIONS_URL)
    const vertexSent = JSON.parse((vertexCall![1] as RequestInit).body as string) as { model?: string }
    expect(vertexSent.model).toBe(ASTRAEUS_MODEL)
  })

  it("an env override replaces the built-in default Turbo fallback model", async () => {
    const f = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url)
      const stock = stsAndImpersonateOk(u)
      if (stock) return stock
      if (u === VERTEX_CHAT_COMPLETIONS_URL) return new Response("vertex down", { status: 500 })
      if (u === OLLAMA_TURBO_CHAT_COMPLETIONS_URL)
        return new Response(JSON.stringify({ id: "cmpl-turbo" }), jsonHeaders)
      throw new Error(`unexpected fetch: ${u}`)
    })
    vi.stubGlobal("fetch", f)
    const env = makeEnv({
      OPENCLAW_SIGILIX_API_KEY: KEY,
      OPENCLAW_GATEWAY_ISSUER: ISSUER,
      OLLAMA_API_KEY: OLLAMA_KEY,
      OPENCLAW_BOREAS_FALLBACK_TURBO_MODEL: "custom-qwen-tag:cloud",
    })
    const { ctx } = makeCtx()

    await handleBoreasApiRoute(post("/v1/boreas/chat/completions", { messages: [] }, `Bearer ${KEY}`), env, ctx)

    const turboCall = f.mock.calls.find((c) => String(c[0]) === OLLAMA_TURBO_CHAT_COMPLETIONS_URL)
    const sentBody = JSON.parse((turboCall![1] as RequestInit).body as string) as { model?: string }
    expect(sentBody.model).toBe("custom-qwen-tag:cloud")
    expect(sentBody.model).not.toBe(DEFAULT_BOREAS_FALLBACK_TURBO_MODEL)
  })

  it("the Bedrock leg is skipped entirely when AWS creds are unset — never fetched, all three routes", async () => {
    const f = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url)
      const stock = stsAndImpersonateOk(u)
      if (stock) return stock
      if (u === VERTEX_CHAT_COMPLETIONS_URL) return new Response("vertex down", { status: 500 })
      if (u === OLLAMA_TURBO_CHAT_COMPLETIONS_URL) return new Response("turbo down too", { status: 500 })
      throw new Error(`unexpected fetch: ${u}`) // any bedrock-runtime.* URL would land here
    })
    vi.stubGlobal("fetch", f)
    // No OPENCLAW_AWS_* creds and no fallback-bedrock-model env var set at all.
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER, OLLAMA_API_KEY: OLLAMA_KEY })
    const { ctx } = makeCtx()

    const res = await handleBoreasApiRoute(
      post("/v1/boreas/chat/completions", { messages: [] }, `Bearer ${KEY}`),
      env,
      ctx,
    )
    expect(res.status).toBe(500) // Turbo's real (final) error surfaces — Bedrock was never a leg
    expect(f.mock.calls.every((c) => !String(c[0]).includes("bedrock-runtime"))).toBe(true)
  })

  it("meters the daily counter exactly once even when the request falls through to a fallback leg", async () => {
    const f = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url)
      const stock = stsAndImpersonateOk(u)
      if (stock) return stock
      if (u === VERTEX_CHAT_COMPLETIONS_URL) return new Response("vertex down", { status: 500 })
      if (u === OLLAMA_TURBO_CHAT_COMPLETIONS_URL)
        return new Response(JSON.stringify({ id: "cmpl-turbo" }), jsonHeaders)
      throw new Error(`unexpected fetch: ${u}`)
    })
    vi.stubGlobal("fetch", f)
    const store = new Map<string, string>()
    const env = makeEnv(
      { OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER, OLLAMA_API_KEY: OLLAMA_KEY },
      store,
    )
    const { ctx } = makeCtx()

    const res = await handleBoreasApiRoute(
      post("/v1/boreas/chat/completions", { messages: [] }, `Bearer ${KEY}`),
      env,
      ctx,
    )
    expect(res.status).toBe(200)

    const day = new Date().toISOString().slice(0, 10)
    expect(await store.get(`boreas:count:${day}`)).toBe("1")
  })

  it("never logs the Ollama API key or the minted Vertex SA token, even across a fallback + failure path", async () => {
    const logSpy = vi.spyOn(console, "log")
    const errSpy = vi.spyOn(console, "error")
    const f = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url)
      const stock = stsAndImpersonateOk(u)
      if (stock) return stock
      if (u === VERTEX_CHAT_COMPLETIONS_URL) return new Response("vertex down", { status: 500 })
      if (u === OLLAMA_TURBO_CHAT_COMPLETIONS_URL) return new Response("bad turbo request", { status: 401 })
      throw new Error(`unexpected fetch: ${u}`)
    })
    vi.stubGlobal("fetch", f)
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER, OLLAMA_API_KEY: OLLAMA_KEY })
    const { ctx } = makeCtx()

    await handleBoreasApiRoute(post("/v1/boreas/chat/completions", { messages: [] }, `Bearer ${KEY}`), env, ctx)

    const allLogged = [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) => c.map(String).join(" ")).join("\n")
    expect(allLogged).not.toContain(OLLAMA_KEY)
    expect(allLogged).not.toContain("sa-token")
    expect(allLogged).not.toContain("fed-token")
  })
})
