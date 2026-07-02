import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { searchWeb, hasAnySearchProvider, type SearchFetchLike } from "./search"
import type { Env } from "@/src/shared/types/env"

function env(over: Partial<Env>): Env {
  return over as unknown as Env
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
}

const TAVILY_BODY = { results: [{ url: "https://t.example/1", title: "T", content: "tav snippet" }] }
const BRAVE_BODY = { web: { results: [{ url: "https://b.example/1", title: "B", description: "brave snippet" }] } }
const SERPER_BODY = { organic: [{ link: "https://s.example/1", title: "S", snippet: "serper snippet" }] }
const PSE_BODY = { items: [{ link: "https://g.example/1", title: "G", snippet: "pse snippet" }] }

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

function meteredProviders(): string[] {
  const lines = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))
  return lines.filter((l) => l.includes("research-search-metered")).map((l) => JSON.parse(l).provider as string)
}

describe("hasAnySearchProvider", () => {
  it("false when nothing is configured", () => {
    expect(hasAnySearchProvider(env({}))).toBe(false)
  })
  it("true when any provider key is set", () => {
    expect(hasAnySearchProvider(env({ OPENCLAW_SERPER_API_KEY: "k" }))).toBe(true)
  })
  it("google-pse needs BOTH key and cx", () => {
    expect(hasAnySearchProvider(env({ OPENCLAW_GOOGLE_PSE_KEY: "k" }))).toBe(false)
    expect(hasAnySearchProvider(env({ OPENCLAW_GOOGLE_PSE_KEY: "k", OPENCLAW_GOOGLE_PSE_CX: "c" }))).toBe(true)
  })
})

describe("searchWeb provider precedence", () => {
  it("uses Tavily first when all are configured", async () => {
    const fake: SearchFetchLike = async (url) => {
      if (url.includes("tavily")) return jsonResponse(TAVILY_BODY)
      throw new Error("should not reach other providers")
    }
    const res = await searchWeb({
      query: "q",
      runId: "run",
      env: env({
        OPENCLAW_TAVILY_API_KEY: "t",
        OPENCLAW_BRAVE_API_KEY: "b",
        OPENCLAW_SERPER_API_KEY: "s",
        OPENCLAW_GOOGLE_PSE_KEY: "g",
        OPENCLAW_GOOGLE_PSE_CX: "c",
      }),
      fetchImpl: fake,
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.provider).toBe("tavily")
      expect(res.hits[0]!.snippet).toBe("tav snippet")
    }
    expect(meteredProviders()).toEqual(["tavily"])
  })

  it("skips unset providers and uses the first configured (Serper)", async () => {
    const fake: SearchFetchLike = async (url) => {
      if (url.includes("serper")) return jsonResponse(SERPER_BODY)
      throw new Error("wrong provider")
    }
    const res = await searchWeb({
      query: "q",
      runId: "run",
      env: env({ OPENCLAW_SERPER_API_KEY: "s", OPENCLAW_GOOGLE_PSE_KEY: "g", OPENCLAW_GOOGLE_PSE_CX: "c" }),
      fetchImpl: fake,
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.provider).toBe("serper")
    expect(meteredProviders()).toEqual(["serper"])
  })

  it("falls back to the next configured provider when the first errors at runtime", async () => {
    const fake: SearchFetchLike = async (url) => {
      if (url.includes("tavily")) return new Response("boom", { status: 500 })
      if (url.includes("brave")) return jsonResponse(BRAVE_BODY)
      throw new Error("wrong provider")
    }
    const res = await searchWeb({
      query: "q",
      runId: "run",
      env: env({ OPENCLAW_TAVILY_API_KEY: "t", OPENCLAW_BRAVE_API_KEY: "b" }),
      fetchImpl: fake,
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.provider).toBe("brave")
    // Both attempts metered (Tavily attempted then Brave served).
    expect(meteredProviders()).toEqual(["tavily", "brave"])
  })

  it("uses Google PSE when it is the only one configured", async () => {
    const fake: SearchFetchLike = async (url) => {
      if (url.includes("customsearch")) return jsonResponse(PSE_BODY)
      throw new Error("wrong provider")
    }
    const res = await searchWeb({
      query: "q",
      runId: "run",
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
    const res = await searchWeb({ query: "q", runId: "run", env: env({}), fetchImpl: fake })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("no-search-provider-configured")
    expect(called).toBe(false)
    expect(meteredProviders()).toEqual([])
  })

  it("never leaks the API key into metering or logs", async () => {
    const fake: SearchFetchLike = async () => jsonResponse(TAVILY_BODY)
    await searchWeb({
      query: "q",
      runId: "run",
      env: env({ OPENCLAW_TAVILY_API_KEY: "super-secret-key" }),
      fetchImpl: fake,
    })
    const allLines = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))
    for (const line of allLines) expect(line).not.toContain("super-secret-key")
  })
})
