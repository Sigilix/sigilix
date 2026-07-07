// SIG-545 — the Pyroeis gateway route: auth gating (503/401) BEFORE any GCP call, model
// forcing (Gemini 3.5 Flash, env-overridable via SIGILIX_PYROEIS_MODEL), daily metering,
// and response/stream/tool_calls passthrough. Plus a regression guard that the shared
// refactor did NOT swap the two routes' forced models.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { handlePyroeisApiRoute } from "@/src/lib/boreas-gateway/api-pyroeis-route"
import { handleBoreasApiRoute } from "@/src/lib/boreas-gateway/api-boreas-route"
import { __resetVertexTokenCacheForTests } from "@/src/lib/boreas-gateway/vertex-token"
import { __resetSigningKeyCacheForTests } from "@/src/lib/boreas-gateway/oidc"
import {
  STS_TOKEN_URL,
  GENERATE_ACCESS_TOKEN_URL,
  VERTEX_CHAT_COMPLETIONS_URL,
  VERTEX_MODEL,
  DEFAULT_PYROEIS_MODEL,
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
  return new Request("https://worker.example/v1/pyroeis/chat/completions", {
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

describe("handlePyroeisApiRoute — auth gating", () => {
  it("503 when OPENCLAW_SIGILIX_API_KEY is unset — no GCP fetch", async () => {
    const f = vi.fn()
    vi.stubGlobal("fetch", f)
    const env = makeEnv({ OPENCLAW_GATEWAY_ISSUER: ISSUER }) // key unset
    const { ctx } = makeCtx()
    const res = await handlePyroeisApiRoute(post({ messages: [] }, `Bearer ${KEY}`), env, ctx)
    expect(res.status).toBe(503)
    expect(f).not.toHaveBeenCalled()
  })

  it("503 when OPENCLAW_GATEWAY_ISSUER is unset — no GCP fetch", async () => {
    const f = vi.fn()
    vi.stubGlobal("fetch", f)
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY }) // issuer unset
    const { ctx } = makeCtx()
    const res = await handlePyroeisApiRoute(post({ messages: [] }, `Bearer ${KEY}`), env, ctx)
    expect(res.status).toBe(503)
    expect(f).not.toHaveBeenCalled()
  })

  it("401 on a bad bearer — BEFORE any GCP fetch / token mint", async () => {
    const f = vi.fn()
    vi.stubGlobal("fetch", f)
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER })
    const { ctx } = makeCtx()
    const res = await handlePyroeisApiRoute(post({ messages: [] }, "Bearer wrong"), env, ctx)
    expect(res.status).toBe(401)
    expect(f).not.toHaveBeenCalled() // proves no STS/Vertex call on a 401
  })

  it("401 on a missing bearer — no GCP fetch", async () => {
    const f = vi.fn()
    vi.stubGlobal("fetch", f)
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER })
    const { ctx } = makeCtx()
    const res = await handlePyroeisApiRoute(post({ messages: [] }), env, ctx)
    expect(res.status).toBe(401)
    expect(f).not.toHaveBeenCalled()
  })
})

describe("handlePyroeisApiRoute — proxy", () => {
  it("forces the default Pyroeis (Gemini) model id, passes the Vertex response through, and meters its own counter", async () => {
    const f = stubFullChain()
    const store = new Map<string, string>()
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER }, store)
    const { ctx } = makeCtx()

    const res = await handlePyroeisApiRoute(
      post({ messages: [{ role: "user", content: "hi" }], model: "attacker/chosen-model" }, `Bearer ${KEY}`),
      env,
      ctx,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { id?: string }
    expect(body.id).toBe("cmpl-1") // upstream body passed through

    // The forwarded Vertex request forced the pinned Pyroeis model id.
    const vertexCall = f.mock.calls.find((c) => String(c[0]) === VERTEX_CHAT_COMPLETIONS_URL)
    expect(vertexCall).toBeDefined()
    const init = vertexCall![1] as RequestInit
    const sent = JSON.parse(init.body as string) as { model?: string }
    expect(sent.model).toBe(DEFAULT_PYROEIS_MODEL)
    expect(sent.model).toBe("google/gemini-3.5-flash")
    expect(sent.model).not.toBe("attacker/chosen-model")
    expect(sent.model).not.toBe(VERTEX_MODEL) // NOT the Boreas (qwen) model
    // Authorization is the minted SA token, not the caller's bearer.
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sa-token")

    // The request was metered under Pyroeis's OWN day counter (not the Boreas one).
    const day = new Date().toISOString().slice(0, 10)
    expect(await store.get(`pyroeis:count:${day}`)).toBe("1")
    expect(await store.get(`boreas:count:${day}`)).toBeUndefined()
  })

  it("SIGILIX_PYROEIS_MODEL overrides the default Gemini id in the forwarded Vertex request", async () => {
    const f = stubFullChain()
    const override = "google/gemini-3.5-flash-001" // e.g. a pinned version string
    const env = makeEnv({
      OPENCLAW_SIGILIX_API_KEY: KEY,
      OPENCLAW_GATEWAY_ISSUER: ISSUER,
      SIGILIX_PYROEIS_MODEL: override,
    })
    const { ctx } = makeCtx()

    const res = await handlePyroeisApiRoute(post({ messages: [] }, `Bearer ${KEY}`), env, ctx)
    expect(res.status).toBe(200)

    const vertexCall = f.mock.calls.find((c) => String(c[0]) === VERTEX_CHAT_COMPLETIONS_URL)
    const sent = JSON.parse((vertexCall![1] as RequestInit).body as string) as { model?: string }
    expect(sent.model).toBe(override)
    expect(sent.model).not.toBe(DEFAULT_PYROEIS_MODEL) // env override wins over the built-in default
  })

  it("a blank/whitespace SIGILIX_PYROEIS_MODEL falls back to the built-in default", async () => {
    const f = stubFullChain()
    const env = makeEnv({
      OPENCLAW_SIGILIX_API_KEY: KEY,
      OPENCLAW_GATEWAY_ISSUER: ISSUER,
      SIGILIX_PYROEIS_MODEL: "   ",
    })
    const { ctx } = makeCtx()

    const res = await handlePyroeisApiRoute(post({ messages: [] }, `Bearer ${KEY}`), env, ctx)
    expect(res.status).toBe(200)

    const vertexCall = f.mock.calls.find((c) => String(c[0]) === VERTEX_CHAT_COMPLETIONS_URL)
    const sent = JSON.parse((vertexCall![1] as RequestInit).body as string) as { model?: string }
    expect(sent.model).toBe(DEFAULT_PYROEIS_MODEL)
  })

  it("passes a streamed (SSE) Vertex response through transparently", async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'
    const streamResponse = new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
    stubFullChain(streamResponse)
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER })
    const { ctx } = makeCtx()

    const res = await handlePyroeisApiRoute(
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

    const res = await handlePyroeisApiRoute(post({ messages: [] }, `Bearer ${KEY}`), env, ctx)

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
    store.set(`pyroeis:count:${day}`, "5") // already at the limit
    const env = makeEnv(
      { OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER, OPENCLAW_PYROEIS_DAILY_LIMIT: "5" },
      store,
    )
    const { ctx } = makeCtx()
    const res = await handlePyroeisApiRoute(post({ messages: [] }, `Bearer ${KEY}`), env, ctx)
    expect(res.status).toBe(429)
    expect(f).not.toHaveBeenCalled() // no token mint, no Vertex call
  })

  it("400 on a non-object JSON body", async () => {
    stubFullChain()
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER })
    const { ctx } = makeCtx()
    const res = await handlePyroeisApiRoute(post([1, 2, 3], `Bearer ${KEY}`), env, ctx)
    expect(res.status).toBe(400)
  })
})

describe("regression — the shared refactor did NOT swap the two routes' models", () => {
  it("the Boreas route still forces the qwen model (not the Pyroeis/Gemini one)", async () => {
    const f = stubFullChain()
    const env = makeEnv({ OPENCLAW_SIGILIX_API_KEY: KEY, OPENCLAW_GATEWAY_ISSUER: ISSUER })
    const { ctx } = makeCtx()

    // Hit the BOREAS handler explicitly and confirm it still pins the qwen model.
    const res = await handleBoreasApiRoute(
      new Request("https://worker.example/v1/boreas/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ messages: [] }),
      }),
      env,
      ctx,
    )
    expect(res.status).toBe(200)

    const vertexCall = f.mock.calls.find((c) => String(c[0]) === VERTEX_CHAT_COMPLETIONS_URL)
    const sent = JSON.parse((vertexCall![1] as RequestInit).body as string) as { model?: string }
    expect(sent.model).toBe(VERTEX_MODEL)
    expect(sent.model).toBe("qwen/qwen3-next-80b-a3b-instruct-maas")
    expect(sent.model).not.toBe(DEFAULT_PYROEIS_MODEL) // the refactor didn't swap them
  })

  it("the two forced model constants are distinct", () => {
    expect(VERTEX_MODEL).not.toBe(DEFAULT_PYROEIS_MODEL)
    expect(DEFAULT_PYROEIS_MODEL).toBe("google/gemini-3.5-flash")
    expect(VERTEX_MODEL).toBe("qwen/qwen3-next-80b-a3b-instruct-maas")
  })
})
