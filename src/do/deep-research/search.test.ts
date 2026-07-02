import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { searchWeb, hasAnySearchProvider, type SearchFetchLike } from "./search"
import type { Env } from "@/src/shared/types/env"

function env(over: Partial<Env>): Env {
  return over as unknown as Env
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
}

const EXA_BODY = { results: [{ url: "https://exa.example/1", title: "E", text: "exa text" }] }
const TAVILY_BODY = { results: [{ url: "https://t.example/1", title: "T", content: "tav snippet" }] }
const BRAVE_BODY = { web: { results: [{ url: "https://b.example/1", title: "B", description: "brave snippet" }] } }
const SERPER_BODY = { organic: [{ link: "https://s.example/1", title: "S", snippet: "serper snippet" }] }
const PSE_BODY = { items: [{ link: "https://g.example/1", title: "G", snippet: "pse snippet" }] }
const SELFHOST_CONTENT_BODY = { results: [{ url: "https://self.example/1", title: "SH", content: "selfhost content" }] }
const SELFHOST_SNIPPET_BODY = {
  results: [{ url: "https://self.example/2", title: "SH2", snippet: "selfhost snippet" }],
}

const ALL_KEYS = {
  OPENCLAW_EXA_API_KEY: "e",
  OPENCLAW_TAVILY_API_KEY: "t",
  OPENCLAW_BRAVE_API_KEY: "b",
  OPENCLAW_SERPER_API_KEY: "s",
  OPENCLAW_SELFHOST_SEARCH_URL: "https://search.sigilix.ai",
  OPENCLAW_GOOGLE_PSE_KEY: "g",
  OPENCLAW_GOOGLE_PSE_CX: "c",
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

function meteredProviders(): string[] {
  const lines = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))
  return lines.filter((l) => l.includes("research-search-metered")).map((l) => JSON.parse(l).provider as string)
}

/** Route the fake fetch by URL to the matching provider body. */
function routedFetch(overrides: Partial<Record<string, Response | (() => Response)>> = {}): SearchFetchLike {
  return async (url) => {
    for (const [needle, resp] of Object.entries(overrides)) {
      if (url.includes(needle)) return typeof resp === "function" ? resp() : resp!
    }
    if (url.includes("api.exa.ai")) return jsonResponse(EXA_BODY)
    if (url.includes("tavily")) return jsonResponse(TAVILY_BODY)
    if (url.includes("brave")) return jsonResponse(BRAVE_BODY)
    if (url.includes("serper")) return jsonResponse(SERPER_BODY)
    if (url.includes("search.sigilix.ai/search")) return jsonResponse(SELFHOST_CONTENT_BODY)
    if (url.includes("customsearch")) return jsonResponse(PSE_BODY)
    throw new Error(`unexpected url ${url}`)
  }
}

describe("hasAnySearchProvider", () => {
  it("false when nothing is configured", () => {
    expect(hasAnySearchProvider(env({}))).toBe(false)
  })
  it("true when a chain provider key is set", () => {
    expect(hasAnySearchProvider(env({ OPENCLAW_TAVILY_API_KEY: "k" }))).toBe(true)
    expect(hasAnySearchProvider(env({ OPENCLAW_EXA_API_KEY: "k" }))).toBe(true)
    expect(hasAnySearchProvider(env({ OPENCLAW_SELFHOST_SEARCH_URL: "https://x" }))).toBe(true)
  })
  it("google-pse needs BOTH key and cx", () => {
    expect(hasAnySearchProvider(env({ OPENCLAW_GOOGLE_PSE_KEY: "k" }))).toBe(false)
    expect(hasAnySearchProvider(env({ OPENCLAW_GOOGLE_PSE_KEY: "k", OPENCLAW_GOOGLE_PSE_CX: "c" }))).toBe(true)
  })
  it("serper is NOT in the default chain, so a serper-only env has no provider", () => {
    expect(hasAnySearchProvider(env({ OPENCLAW_SERPER_API_KEY: "s" }))).toBe(false)
    // …unless explicitly listed in the chain.
    expect(hasAnySearchProvider(env({ OPENCLAW_SERPER_API_KEY: "s", OPENCLAW_SEARCH_CHAIN: "serper" }))).toBe(true)
  })
})

describe("default chain order (exa → tavily → brave → selfhost → google-pse)", () => {
  it("exa serves first when everything is configured", async () => {
    const fake = routedFetch()
    const res = await searchWeb({ query: "q", runId: "run", tenant: "t1", env: env(ALL_KEYS), fetchImpl: fake })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.provider).toBe("exa")
      expect(res.hits[0]!.snippet).toBe("exa text")
    }
    expect(meteredProviders()).toEqual(["exa"])
  })

  it("skips unset exa → tavily serves", async () => {
    const fake = routedFetch()
    const res = await searchWeb({
      query: "q",
      runId: "run",
      tenant: "t1",
      env: env({ OPENCLAW_TAVILY_API_KEY: "t", OPENCLAW_BRAVE_API_KEY: "b" }),
      fetchImpl: fake,
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.provider).toBe("tavily")
    expect(meteredProviders()).toEqual(["tavily"])
  })

  it("falls back to the next configured provider when the first errors (meter only the served one)", async () => {
    const fake = routedFetch({ "api.exa.ai": new Response("boom", { status: 500 }) })
    const res = await searchWeb({
      query: "q",
      runId: "run",
      tenant: "t1",
      env: env({ OPENCLAW_EXA_API_KEY: "e", OPENCLAW_TAVILY_API_KEY: "t" }),
      fetchImpl: fake,
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.provider).toBe("tavily")
    // Exa threw and fell through → NOT metered (P2.4). Only tavily is metered.
    expect(meteredProviders()).toEqual(["tavily"])
  })

  it("uses Google PSE when it is the only one configured", async () => {
    const fake = routedFetch()
    const res = await searchWeb({
      query: "q",
      runId: "run",
      tenant: "t1",
      env: env({ OPENCLAW_GOOGLE_PSE_KEY: "g", OPENCLAW_GOOGLE_PSE_CX: "c" }),
      fetchImpl: fake,
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.provider).toBe("google-pse")
  })

  it("fails fast (never hangs) when NO provider is configured", async () => {
    let called = false
    const fake: SearchFetchLike = async () => {
      called = true
      return jsonResponse({})
    }
    const res = await searchWeb({ query: "q", runId: "run", tenant: "t1", env: env({}), fetchImpl: fake })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("no-search-provider-configured")
    expect(called).toBe(false)
    expect(meteredProviders()).toEqual([])
  })
})

describe("OPENCLAW_SEARCH_CHAIN (custom order)", () => {
  it("honors a custom order (brave,exa) — brave serves first", async () => {
    const fake = routedFetch()
    const res = await searchWeb({
      query: "q",
      runId: "run",
      tenant: "t1",
      env: env({ OPENCLAW_SEARCH_CHAIN: "brave,exa", OPENCLAW_BRAVE_API_KEY: "b", OPENCLAW_EXA_API_KEY: "e" }),
      fetchImpl: fake,
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.provider).toBe("brave")
    expect(meteredProviders()).toEqual(["brave"])
  })

  it("skips an unknown chain key (logged) and still serves the rest", async () => {
    const fake = routedFetch()
    const res = await searchWeb({
      query: "q",
      runId: "run",
      tenant: "t1",
      env: env({ OPENCLAW_SEARCH_CHAIN: "bogus,tavily", OPENCLAW_TAVILY_API_KEY: "t" }),
      fetchImpl: fake,
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.provider).toBe("tavily")
    const errLines = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))
    expect(errLines.some((l) => l.includes("research-search-chain-unknown-provider") && l.includes("bogus"))).toBe(true)
  })

  it("serper is still usable when explicitly listed", async () => {
    const fake = routedFetch()
    const res = await searchWeb({
      query: "q",
      runId: "run",
      tenant: "t1",
      env: env({ OPENCLAW_SEARCH_CHAIN: "serper", OPENCLAW_SERPER_API_KEY: "s" }),
      fetchImpl: fake,
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.provider).toBe("serper")
      expect(res.hits[0]!.snippet).toBe("serper snippet")
    }
  })
})

describe("Exa adapter", () => {
  it("maps url/title/text→snippet and sends x-api-key without leaking it", async () => {
    let sawKey: string | null = null
    const fake: SearchFetchLike = async (_url, init) => {
      sawKey = new Headers(init.headers).get("x-api-key")
      return jsonResponse(EXA_BODY)
    }
    const res = await searchWeb({
      query: "q",
      runId: "run",
      tenant: "t1",
      env: env({ OPENCLAW_EXA_API_KEY: "exa-secret-key" }),
      fetchImpl: fake,
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.hits[0]).toMatchObject({ url: "https://exa.example/1", title: "E", snippet: "exa text" })
    }
    expect(sawKey).toBe("exa-secret-key")
    const logLines = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))
    for (const line of logLines) expect(line).not.toContain("exa-secret-key")
  })
})

describe("self-hosted leg (overflow lane)", () => {
  it("serves when it is the first configured in the chain", async () => {
    const fake = routedFetch()
    const res = await searchWeb({
      query: "q",
      runId: "run",
      tenant: "t1",
      env: env({ OPENCLAW_SELFHOST_SEARCH_URL: "https://search.sigilix.ai" }),
      fetchImpl: fake,
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.provider).toBe("selfhost")
      expect(res.hits[0]!.snippet).toBe("selfhost content")
    }
    expect(meteredProviders()).toEqual(["selfhost"])
  })

  it("tolerantly parses the snippet-field result shape", async () => {
    const fake = routedFetch({ "search.sigilix.ai/search": jsonResponse(SELFHOST_SNIPPET_BODY) })
    const res = await searchWeb({
      query: "q",
      runId: "run",
      tenant: "t1",
      env: env({ OPENCLAW_SELFHOST_SEARCH_URL: "https://search.sigilix.ai" }),
      fetchImpl: fake,
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.hits[0]!.snippet).toBe("selfhost snippet")
  })

  it("falls through to the next configured leg on non-200", async () => {
    const fake = routedFetch({ "search.sigilix.ai/search": new Response("err", { status: 502 }) })
    const res = await searchWeb({
      query: "q",
      runId: "run",
      tenant: "t1",
      env: env({
        OPENCLAW_SELFHOST_SEARCH_URL: "https://search.sigilix.ai",
        OPENCLAW_GOOGLE_PSE_KEY: "g",
        OPENCLAW_GOOGLE_PSE_CX: "c",
      }),
      fetchImpl: fake,
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.provider).toBe("google-pse")
    expect(meteredProviders()).toEqual(["google-pse"])
  })

  it("falls through when the self-hosted response has empty results", async () => {
    const fake = routedFetch({ "search.sigilix.ai/search": jsonResponse({ results: [] }) })
    const res = await searchWeb({
      query: "q",
      runId: "run",
      tenant: "t1",
      env: env({
        OPENCLAW_SELFHOST_SEARCH_URL: "https://search.sigilix.ai",
        OPENCLAW_GOOGLE_PSE_KEY: "g",
        OPENCLAW_GOOGLE_PSE_CX: "c",
      }),
      fetchImpl: fake,
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.provider).toBe("google-pse")
  })

  it("attaches the bearer token when set, and never leaks it", async () => {
    let sawAuth: string | null = null
    const fake: SearchFetchLike = async (_url, init) => {
      sawAuth = new Headers(init.headers).get("authorization")
      return jsonResponse(SELFHOST_CONTENT_BODY)
    }
    await searchWeb({
      query: "q",
      runId: "run",
      tenant: "t1",
      env: env({
        OPENCLAW_SELFHOST_SEARCH_URL: "https://search.sigilix.ai",
        OPENCLAW_SELFHOST_SEARCH_TOKEN: "sh-secret-token",
      }),
      fetchImpl: fake,
    })
    expect(sawAuth).toBe("Bearer sh-secret-token")
    const allLines = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))
    for (const line of allLines) expect(line).not.toContain("sh-secret-token")
  })
})

describe("metering", () => {
  it("attributes the metered line to the tenant", async () => {
    const fake = routedFetch()
    await searchWeb({
      query: "q",
      runId: "run",
      tenant: "tenant:42",
      env: env({ OPENCLAW_TAVILY_API_KEY: "t" }),
      fetchImpl: fake,
    })
    const line = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("research-search-metered"))!
    expect(JSON.parse(line)).toMatchObject({ provider: "tavily", queries: 1, runId: "run", tenant: "tenant:42" })
  })

  it("never leaks a paid-provider key", async () => {
    const fake = routedFetch()
    await searchWeb({
      query: "q",
      runId: "run",
      tenant: "t1",
      env: env({ OPENCLAW_TAVILY_API_KEY: "super-secret-key" }),
      fetchImpl: fake,
    })
    const allLines = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))
    for (const line of allLines) expect(line).not.toContain("super-secret-key")
  })
})
