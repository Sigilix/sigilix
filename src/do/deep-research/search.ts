// SIG-298 — web search with an ordered provider fallback chain. The chain is
// Tavily → Brave → Serper → Google PSE; the first CONFIGURED provider serves a
// query, and if it errors at runtime the next configured provider is tried.
// Unset providers are skipped silently. If NO provider is configured the caller
// fails fast (see `hasAnySearchProvider`) rather than hanging. Each executed
// query emits one `research-search-metered` line (provider + runId, no secrets).

import type { Env } from "@/src/shared/types/env"
import type { SearchHit, SearchProvider } from "./types"

/** HTTP primitive the providers depend on (fakeable in tests). */
export type SearchFetchLike = (url: string, init: RequestInit) => Promise<Response>

const SEARCH_TIMEOUT_MS = 15_000
const MAX_HITS_PER_QUERY = 8

/** True when at least one provider in the chain is configured. */
export function hasAnySearchProvider(env: Env): boolean {
  return configuredProviders(env).length > 0
}

/** The configured providers in fallback order. */
function configuredProviders(env: Env): SearchProvider[] {
  const chain: SearchProvider[] = []
  if (env.OPENCLAW_TAVILY_API_KEY?.trim()) chain.push("tavily")
  if (env.OPENCLAW_BRAVE_API_KEY?.trim()) chain.push("brave")
  if (env.OPENCLAW_SERPER_API_KEY?.trim()) chain.push("serper")
  if (env.OPENCLAW_GOOGLE_PSE_KEY?.trim() && env.OPENCLAW_GOOGLE_PSE_CX?.trim()) chain.push("google-pse")
  return chain
}

export interface SearchArgs {
  query: string
  env: Env
  runId: string
  fetchImpl?: SearchFetchLike
}

/** Structured search outcome for one query. */
export type SearchQueryResult =
  | { ok: true; provider: SearchProvider; hits: SearchHit[] }
  | { ok: false; reason: string }

/**
 * Run one query through the fallback chain. Walks configured providers in order;
 * the first that returns without throwing wins. A provider that throws (network
 * / non-2xx / parse) is logged and the next configured provider is tried. Meters
 * each provider attempt that actually executes a request.
 */
export async function searchWeb(args: SearchArgs): Promise<SearchQueryResult> {
  const providers = configuredProviders(args.env)
  if (providers.length === 0) return { ok: false, reason: "no-search-provider-configured" }

  const fetchImpl = args.fetchImpl ?? ((u, init) => fetch(u, init))
  let lastReason = "no-search-provider-configured"
  for (const provider of providers) {
    meterSearch(provider, args.runId)
    try {
      const hits = await runProvider(provider, args.query, args.env, fetchImpl)
      return { ok: true, provider, hits: hits.slice(0, MAX_HITS_PER_QUERY) }
    } catch (err) {
      lastReason = err instanceof Error ? err.message : String(err)
      console.error(
        JSON.stringify({ event: "research-search-provider-failed", provider, runId: args.runId, reason: lastReason }),
      )
      // fall through to the next configured provider
    }
  }
  return { ok: false, reason: lastReason }
}

/** Dispatch to the concrete provider implementation. */
function runProvider(
  provider: SearchProvider,
  query: string,
  env: Env,
  fetchImpl: SearchFetchLike,
): Promise<SearchHit[]> {
  switch (provider) {
    case "tavily":
      return searchTavily(query, env.OPENCLAW_TAVILY_API_KEY!, fetchImpl)
    case "brave":
      return searchBrave(query, env.OPENCLAW_BRAVE_API_KEY!, fetchImpl)
    case "serper":
      return searchSerper(query, env.OPENCLAW_SERPER_API_KEY!, fetchImpl)
    case "google-pse":
      return searchGooglePse(query, env.OPENCLAW_GOOGLE_PSE_KEY!, env.OPENCLAW_GOOGLE_PSE_CX!, fetchImpl)
  }
}

async function withTimeout(run: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

async function searchTavily(query: string, apiKey: string, fetchImpl: SearchFetchLike): Promise<SearchHit[]> {
  const res = await withTimeout((signal) =>
    fetchImpl("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, query, max_results: MAX_HITS_PER_QUERY }),
      signal,
    }),
  )
  if (!res.ok) throw new Error(`tavily-http-${res.status}`)
  const data = (await res.json()) as { results?: Array<{ url?: string; title?: string; content?: string }> }
  return (data.results ?? []).map((r) => ({ url: r.url ?? "", title: r.title ?? "", snippet: r.content ?? "" }))
}

async function searchBrave(query: string, apiKey: string, fetchImpl: SearchFetchLike): Promise<SearchHit[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_HITS_PER_QUERY}`
  const res = await withTimeout((signal) =>
    fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json", "x-subscription-token": apiKey },
      signal,
    }),
  )
  if (!res.ok) throw new Error(`brave-http-${res.status}`)
  const data = (await res.json()) as {
    web?: { results?: Array<{ url?: string; title?: string; description?: string }> }
  }
  return (data.web?.results ?? []).map((r) => ({
    url: r.url ?? "",
    title: r.title ?? "",
    snippet: r.description ?? "",
  }))
}

async function searchSerper(query: string, apiKey: string, fetchImpl: SearchFetchLike): Promise<SearchHit[]> {
  const res = await withTimeout((signal) =>
    fetchImpl("https://google.serper.dev/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ q: query, num: MAX_HITS_PER_QUERY }),
      signal,
    }),
  )
  if (!res.ok) throw new Error(`serper-http-${res.status}`)
  const data = (await res.json()) as { organic?: Array<{ link?: string; title?: string; snippet?: string }> }
  return (data.organic ?? []).map((r) => ({ url: r.link ?? "", title: r.title ?? "", snippet: r.snippet ?? "" }))
}

async function searchGooglePse(
  query: string,
  key: string,
  cx: string,
  fetchImpl: SearchFetchLike,
): Promise<SearchHit[]> {
  const url =
    `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}` +
    `&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(query)}&num=${MAX_HITS_PER_QUERY}`
  const res = await withTimeout((signal) => fetchImpl(url, { method: "GET", signal }))
  if (!res.ok) throw new Error(`google-pse-http-${res.status}`)
  const data = (await res.json()) as { items?: Array<{ link?: string; title?: string; snippet?: string }> }
  return (data.items ?? []).map((r) => ({ url: r.link ?? "", title: r.title ?? "", snippet: r.snippet ?? "" }))
}

/** Structured per-query metering line — provider + runId only, never secrets. */
function meterSearch(provider: SearchProvider, runId: string): void {
  console.log(JSON.stringify({ event: "research-search-metered", provider, queries: 1, runId }))
}
