// SIG-545 — the Astraeus gateway route: auth gating (503/401) BEFORE any GCP call, model
// forcing (GLM-5.2), daily metering, and response/stream/tool_calls passthrough. Plus a
// regression guard that the shared refactor did NOT swap the three routes' forced models.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { handleAstraeusApiRoute } from "@/src/lib/boreas-gateway/api-astraeus-route"
import { handleBoreasApiRoute } from "@/src/lib/boreas-gateway/api-boreas-route"
import { handlePyroeisApiRoute } from "@/src/lib/boreas-gateway/api-pyroeis-route"
import { __resetVertexTokenCacheForTests } from "@/src/lib/boreas-gateway/vertex-token"
import { __resetSigningKeyCacheForTests } from "@/src/lib/boreas-gateway/oidc"
import {
  STS_TOKEN_URL,
  GENERATE_ACCESS_TOKEN_URL,
  VERTEX_CHAT_COMPLETIONS_URL,
  VERTEX_MODEL,
  DEFAULT_PYROEIS_MODEL,
  ASTRAEUS_MODEL,
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
  return new Request("https://worker.example/v1/astraeus/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  })
}

/**
 * Stub fetch for the full STS → impersonate → Vertex chain. The Vertex leg returns
 * `vertexResponse` (default: a small JSON completion), so a test can swap in a stream or a
 * tool_calls body. Returns the spy.
 */
function stubFullChain(vertexResponse?: Response): ReturnType<typeof vi.fn> {
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
      return (
        vertexResponse ??
        new Response(JSON.stringify({ id: "cmpl-1", choices: [{ message: { content: "hi" } }] }), jsonHeaders)
      )
    }
    throw new Error(`unexpected fetch: ${u}`)
  })
  vi.stubGlobal("fetch", f)
  return f
}

describe("handleAstraeusApiRoute — auth gating", () => {
  it("503 when OPENCLAW_SIGILIX_API_KEY is unset — no GCP fetch", async () => {
    const f = vi.fn()
    vi.stubGlobal("fetch", f)
    const env = makeEnv({ OPENCLAW_GATEWAY_ISSUER: ISSUER }) // key unset
    const { ctx } = makeCtx()
    const res = await handleAstraeusApiRoute(post({ messages: [] }, `Bearer ${KEY}`), env, ctx)
    expect(res.status).toBe(503)
    expect(f).not.toHaveBeenCalled()
  })

  it("503 when OPENCLAW_GATEWAY_ISSUER is unset — no GCP fetch", async () => {
    const f = vi.fn()
    vi.stubGlobal("fetch", f)
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY }) // issuer unset
    const { ctx } = makeCtx()
    const res = await handleAstraeusApiRoute(post({ messages: [] }, `Bearer ${KEY}`), env, ctx)
    expect(res.status).toBe(503)
    expect(f).not.toHaveBeenCalled()
  })

  it("401 on a bad bearer — BEFORE any GCP fetch / token mint", async () => {
    const f = vi.fn()
    vi.stubGlobal("fetch", f)
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER })
    const { ctx } = makeCtx()
    const res = await handleAstraeusApiRoute(post({ messages: [] }, "Bearer wrong"), env, ctx)
    expect(res.status).toBe(401)
    expect(f).not.toHaveBeenCalled() // proves no STS/Vertex call on a 401
  })

  it("401 on a missing bearer — no GCP fetch", async () => {
    const f = vi.fn()
    vi.stubGlobal("fetch", f)
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER })
    const { ctx } = makeCtx()
    const res = await handleAstraeusApiRoute(post({ messages: [] }), env, ctx)
    expect(res.status).toBe(401)
    expect(f).not.toHaveBeenCalled()
  })
})

describe("handleAstraeusApiRoute — proxy", () => {
  it("forces the GLM-5.2 model id, passes the Vertex response through, and meters its own counter", async () => {
    const f = stubFullChain()
    const store = new Map<string, string>()
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER }, store)
    const { ctx } = makeCtx()

    const res = await handleAstraeusApiRoute(
      post({ messages: [{ role: "user", content: "hi" }], model: "attacker/chosen-model" }, `Bearer ${KEY}`),
      env,
      ctx,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { id?: string }
    expect(body.id).toBe("cmpl-1") // upstream body passed through

    // The forwarded Vertex request forced the pinned Astraeus model id.
    const vertexCall = f.mock.calls.find((c) => String(c[0]) === VERTEX_CHAT_COMPLETIONS_URL)
    expect(vertexCall).toBeDefined()
    const init = vertexCall![1] as RequestInit
    const sent = JSON.parse(init.body as string) as { model?: string }
    expect(sent.model).toBe(ASTRAEUS_MODEL)
    expect(sent.model).toBe("zai-org/glm-5-maas")
    expect(sent.model).not.toBe("attacker/chosen-model")
    expect(sent.model).not.toBe(VERTEX_MODEL) // NOT the Boreas (qwen) model
    expect(sent.model).not.toBe(DEFAULT_PYROEIS_MODEL) // NOT the Pyroeis (Gemini) model
    // Authorization is the minted SA token, not the caller's bearer.
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sa-token")

    // The request was metered under Astraeus's OWN day counter (not Boreas's or Pyroeis's).
    const day = new Date().toISOString().slice(0, 10)
    expect(await store.get(`astraeus:count:${day}`)).toBe("1")
    expect(await store.get(`boreas:count:${day}`)).toBeUndefined()
    expect(await store.get(`pyroeis:count:${day}`)).toBeUndefined()
  })

  it("passes a streamed (SSE) Vertex response through transparently", async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'
    const streamResponse = new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
    stubFullChain(streamResponse)
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER })
    const { ctx } = makeCtx()

    const res = await handleAstraeusApiRoute(
      post({ messages: [{ role: "user", content: "hi" }], stream: true }, `Bearer ${KEY}`),
      env,
      ctx,
    )

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/event-stream")
    expect(await res.text()).toBe(sse) // body streamed through byte-for-byte
  })

  it("passes tool_calls in the Vertex response through transparently", async () => {
    const toolCallBody = {
      id: "cmpl-tc",
      choices: [
        {
          message: {
            role: "assistant",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } }],
          },
        },
      ],
    }
    stubFullChain(new Response(JSON.stringify(toolCallBody), jsonHeaders))
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER })
    const { ctx } = makeCtx()

    const res = await handleAstraeusApiRoute(post({ messages: [] }, `Bearer ${KEY}`), env, ctx)

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      choices?: { message?: { tool_calls?: { function?: { name?: string } }[] } }[]
    }
    expect(body.choices?.[0]?.message?.tool_calls?.[0]?.function?.name).toBe("get_weather")
  })

  it("429 over the daily ceiling — AFTER auth but BEFORE any GCP fetch", async () => {
    const f = vi.fn()
    vi.stubGlobal("fetch", f)
    const store = new Map<string, string>()
    const day = new Date().toISOString().slice(0, 10)
    store.set(`astraeus:count:${day}`, "5") // already at the limit
    const env = makeEnv(
      { OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER, OPENCLAW_ASTRAEUS_DAILY_LIMIT: "5" },
      store,
    )
    const { ctx } = makeCtx()
    const res = await handleAstraeusApiRoute(post({ messages: [] }, `Bearer ${KEY}`), env, ctx)
    expect(res.status).toBe(429)
    expect(f).not.toHaveBeenCalled() // no token mint, no Vertex call
  })

  it("400 on a non-object JSON body", async () => {
    stubFullChain()
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER })
    const { ctx } = makeCtx()
    const res = await handleAstraeusApiRoute(post([1, 2, 3], `Bearer ${KEY}`), env, ctx)
    expect(res.status).toBe(400)
  })
})

describe("regression — the shared refactor did NOT swap the three routes' models", () => {
  it("the Boreas and Pyroeis routes still force their own models (not the Astraeus one)", async () => {
    const f = stubFullChain()
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER })
    const { ctx } = makeCtx()

    const boreasRes = await handleBoreasApiRoute(
      new Request("https://worker.example/v1/boreas/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ messages: [] }),
      }),
      env,
      ctx,
    )
    expect(boreasRes.status).toBe(200)
    const boreasCall = f.mock.calls.find((c) => String(c[0]) === VERTEX_CHAT_COMPLETIONS_URL)
    const boreasSent = JSON.parse((boreasCall![1] as RequestInit).body as string) as { model?: string }
    expect(boreasSent.model).toBe(VERTEX_MODEL)
    expect(boreasSent.model).not.toBe(ASTRAEUS_MODEL)

    f.mockClear()
    const pyroeisRes = await handlePyroeisApiRoute(
      new Request("https://worker.example/v1/pyroeis/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ messages: [] }),
      }),
      env,
      ctx,
    )
    expect(pyroeisRes.status).toBe(200)
    const pyroeisCall = f.mock.calls.find((c) => String(c[0]) === VERTEX_CHAT_COMPLETIONS_URL)
    const pyroeisSent = JSON.parse((pyroeisCall![1] as RequestInit).body as string) as { model?: string }
    expect(pyroeisSent.model).toBe(DEFAULT_PYROEIS_MODEL)
    expect(pyroeisSent.model).not.toBe(ASTRAEUS_MODEL)
  })

  it("the three forced model constants are distinct", () => {
    expect(VERTEX_MODEL).not.toBe(DEFAULT_PYROEIS_MODEL)
    expect(VERTEX_MODEL).not.toBe(ASTRAEUS_MODEL)
    expect(DEFAULT_PYROEIS_MODEL).not.toBe(ASTRAEUS_MODEL)
    expect(ASTRAEUS_MODEL).toBe("zai-org/glm-5-maas")
  })
})
