// SIG-298 — web search with an env-configurable provider fallback chain. The
// order comes from OPENCLAW_SEARCH_CHAIN (default: exa,tavily,brave,selfhost,
// google-pse); the first CONFIGURED provider in the resolved chain serves a
// query, and if it errors at runtime the next configured provider is tried.
// Unknown chain keys are skipped (logged); providers whose keys/config are unset
// are skipped silently. If NO provider is configured the caller fails fast (see
// `hasAnySearchProvider`) rather than hanging. Only the SERVED provider emits a
// `research-search-metered` line (provider + runId + tenant, no secrets). The
// self-hosted SearXNG/agent-search leg is an overflow lane; "serper" is not in
// the default chain but stays available when explicitly listed.

import type { Env } from "@/src/shared/types/env"
import type { SearchHit, SearchProvider } from "./types"

/** HTTP primitive the providers depend on (fakeable in tests). */
export type SearchFetchLike = (url: string, init: RequestInit) => Promise<Response>

const SEARCH_TIMEOUT_MS = 15_000
const SELFHOST_TIMEOUT_MS = 10_000
const MAX_HITS_PER_QUERY = 8

/** The default chain when OPENCLAW_SEARCH_CHAIN is unset/empty. */
const DEFAULT_CHAIN: SearchProvider[] = ["exa", "tavily", "brave", "selfhost", "google-pse"]

/** Every provider the code knows how to run (for validating chain entries). */
const KNOWN_PROVIDERS = new Set<SearchProvider>(["exa", "tavily", "brave", "serper", "selfhost", "google-pse"])

/** True when at least one provider in the resolved chain is configured. */
export function hasAnySearchProvider(env: Env): boolean {
  return configuredProviders(env).length > 0
}

/** Resolve the ordered chain from OPENCLAW_SEARCH_CHAIN (trim/lowercase; unknown
 *  keys skipped with a structured log), or the default when unset/empty. */
function resolveChain(env: Env): SearchProvider[] {
  const raw = env.OPENCLAW_SEARCH_CHAIN?.trim()
  if (!raw) return DEFAULT_CHAIN
  const out: SearchProvider[] = []
  for (const entry of raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)) {
    if (!KNOWN_PROVIDERS.has(entry as SearchProvider)) {
      console.error(JSON.stringify({ event: "research-search-chain-unknown-provider", provider: entry }))
      continue
    }
    out.push(entry as SearchProvider)
  }
  return out
}

/** Whether a given provider has the config it needs to run. */
function isProviderConfigured(provider: SearchProvider, env: Env): boolean {
  switch (provider) {
    case "exa":
      return !!env.OPENCLAW_EXA_API_KEY?.trim()
    case "tavily":
      return !!env.OPENCLAW_TAVILY_API_KEY?.trim()
    case "brave":
      return !!env.OPENCLAW_BRAVE_API_KEY?.trim()
    case "serper":
      return !!env.OPENCLAW_SERPER_API_KEY?.trim()
    case "selfhost":
      return !!env.OPENCLAW_SELFHOST_SEARCH_URL?.trim()
    case "google-pse":
      return !!env.OPENCLAW_GOOGLE_PSE_KEY?.trim() && !!env.OPENCLAW_GOOGLE_PSE_CX?.trim()
  }
}

/** The configured providers, in resolved-chain order. */
function configuredProviders(env: Env): SearchProvider[] {
  return resolveChain(env).filter((p) => isProviderConfigured(p, env))
}

export interface SearchArgs {
  query: string
  env: Env
  runId: string
  /** The owning tenant/creator identity — attributed in the metering line. */
  tenant: string
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
    try {
      const hits = await runProvider(provider, args.query, args.env, fetchImpl)
      // Meter ONLY the provider that actually served this query — a provider
      // that throws and falls through must not emit a metered line.
      meterSearch(provider, args.runId, args.tenant)
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
    case "exa":
      return searchExa(query, env.OPENCLAW_EXA_API_KEY!, fetchImpl)
    case "selfhost":
      return searchSelfhost(query, env.OPENCLAW_SELFHOST_SEARCH_URL!, env.OPENCLAW_SELFHOST_SEARCH_TOKEN, fetchImpl)
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

async function withTimeout(
  run: (signal: AbortSignal) => Promise<Response>,
  timeoutMs = SEARCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/** Exa: POST https://api.exa.ai/search {query, numResults} with x-api-key.
 *  Tolerant map results[].{url, title, text → snippet}. */
async function searchExa(query: string, apiKey: string, fetchImpl: SearchFetchLike): Promise<SearchHit[]> {
  const res = await withTimeout((signal) =>
    fetchImpl("https://api.exa.ai/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ query, numResults: MAX_HITS_PER_QUERY }),
      signal,
    }),
  )
  if (!res.ok) throw new Error(`exa-http-${res.status}`)
  const data = (await res.json()) as { results?: Array<{ url?: string; title?: string; text?: string }> }
  return (data.results ?? []).map((r) => ({ url: r.url ?? "", title: r.title ?? "", snippet: r.text ?? "" }))
}

/** Self-hosted SearXNG / agent-search compatible leg: GET {base}/search?q=…&format=json.
 *  Tolerant parse — accepts `{results:[{url,title,content?|snippet?}]}`. On any
 *  error / non-200 / empty results the caller falls through to the next leg. */
async function searchSelfhost(
  query: string,
  baseUrl: string,
  token: string | undefined,
  fetchImpl: SearchFetchLike,
): Promise<SearchHit[]> {
  const base = baseUrl.replace(/\/+$/, "")
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`
  const headers: Record<string, string> = { accept: "application/json" }
  if (token?.trim()) headers.authorization = `Bearer ${token.trim()}`
  const res = await withTimeout((signal) => fetchImpl(url, { method: "GET", headers, signal }), SELFHOST_TIMEOUT_MS)
  if (!res.ok) throw new Error(`selfhost-http-${res.status}`)
  const data = (await res.json()) as {
    results?: Array<{ url?: string; title?: string; content?: string; snippet?: string }>
  }
  const results = data.results ?? []
  if (results.length === 0) throw new Error("selfhost-empty")
  return results.map((r) => ({ url: r.url ?? "", title: r.title ?? "", snippet: r.content ?? r.snippet ?? "" }))
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

/** Structured per-query metering line — provider + runId + tenant, never secrets. */
function meterSearch(provider: SearchProvider, runId: string, tenant: string): void {
  console.log(JSON.stringify({ event: "research-search-metered", provider, queries: 1, runId, tenant }))
}
