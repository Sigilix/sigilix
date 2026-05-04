// Per-PR retrieval cache for Phase 4 ensemble review.
//
// The orchestrator pre-fetches a snapshot once before fanout (using
// the diff + PR title as the query). All four specialists see the
// SAME snapshot in their initial user message, eliminating the v1
// "vector DB non-determinism" risk where two specialists would see
// different versions of the same helper function.
//
// During fanout, specialists may make follow-up retrieve_codebase
// calls. Those route through this cache: identical query+namespace
// hits, novel queries miss-then-populate. The synthesizer's optional
// conflict-verification calls share the same cache.
//
// Cache key (v3.1 LOCKED):
//   sha256(`${namespace}\0${query}`)
// Explicit NUL byte delimiter prevents (ns="ab", q="c") colliding
// with (ns="a", q="bc"). NO query normalization — preserves query
// diversity for bake-off telemetry analysis.
//
// Budget: every call (hit OR miss, success OR failure) counts against
// OPENCLAW_ENSEMBLE_MAX_RETRIEVE_CALLS_PER_PR. Pre-flight that fails
// before returning chunks still counts (it incurred latency/cost).

import type { RetrievedChunk } from "./retrieval"

export interface RetrievalCacheEntry {
  query: string
  namespace: string
  /** Truthy on success; null when fetcher threw. */
  chunks: RetrievedChunk[] | null
  /** ms wall-clock the fetcher took, or 0 on cache hit. */
  elapsedMs: number
}

export interface RetrievalCacheStats {
  totalCalls: number
  cacheHits: number
  cacheMisses: number
  /** Calls that errored (fetcher threw). Subset of cacheMisses. */
  errors: number
  /** Per-call log for telemetry (query strings included). */
  log: Array<{
    caller: string
    query: string
    namespace: string
    cacheHit: boolean
    chunks: number
    error?: string
    elapsedMs: number
  }>
}

export interface RetrievalCache {
  /**
   * Retrieve via the cache. Identical (query, namespace) returns the
   * cached value without invoking `fetcher`. Novel pair calls fetcher
   * once and stores the result. Cache hits are counted but don't draw
   * from the budget — only misses (every fetcher invocation) do.
   *
   * `caller` is a human-readable role tag for telemetry ("preflight",
   * "specialist:logic", "synthesizer", etc.).
   */
  cachedRetrieve(args: {
    caller: string
    query: string
    namespace: string
    fetcher: () => Promise<RetrievedChunk[]>
  }): Promise<RetrievalCacheEntry>

  /** Calls remaining against the per-PR retrieve budget. */
  budgetRemaining(): number

  /** Snapshot of cache stats + per-call log. Safe to read mid-flight. */
  stats(): RetrievalCacheStats
}

export interface CreateRetrievalCacheArgs {
  /** Per-PR retrieve budget. Hits don't consume budget; misses do. */
  maxCalls: number
}

export function createRetrievalCache(args: CreateRetrievalCacheArgs): RetrievalCache {
  const { maxCalls } = args
  const store = new Map<string, RetrievedChunk[] | null>()
  const stats: RetrievalCacheStats = {
    totalCalls: 0,
    cacheHits: 0,
    cacheMisses: 0,
    errors: 0,
    log: [],
  }
  let missesUsed = 0

  return {
    async cachedRetrieve({ caller, query, namespace, fetcher }) {
      stats.totalCalls++
      const key = await cacheKey(namespace, query)

      if (store.has(key)) {
        const cached = store.get(key) ?? null
        stats.cacheHits++
        stats.log.push({
          caller,
          query,
          namespace,
          cacheHit: true,
          chunks: cached?.length ?? 0,
          elapsedMs: 0,
        })
        return { query, namespace, chunks: cached, elapsedMs: 0 }
      }

      // Miss. Check budget BEFORE consuming.
      if (missesUsed >= maxCalls) {
        const error = `retrieve budget exhausted (${maxCalls})`
        stats.cacheMisses++
        stats.errors++
        stats.log.push({
          caller,
          query,
          namespace,
          cacheHit: false,
          chunks: 0,
          error,
          elapsedMs: 0,
        })
        return { query, namespace, chunks: null, elapsedMs: 0 }
      }

      missesUsed++
      stats.cacheMisses++
      const t0 = Date.now()
      try {
        const chunks = await fetcher()
        const elapsedMs = Date.now() - t0
        store.set(key, chunks)
        stats.log.push({
          caller,
          query,
          namespace,
          cacheHit: false,
          chunks: chunks.length,
          elapsedMs,
        })
        return { query, namespace, chunks, elapsedMs }
      } catch (e) {
        const elapsedMs = Date.now() - t0
        const error = e instanceof Error ? e.message : String(e)
        // Still cache the FAILURE so the same query doesn't retry
        // mid-run and re-burn budget. Stored as null = "we tried, it
        // failed."
        store.set(key, null)
        stats.errors++
        stats.log.push({
          caller,
          query,
          namespace,
          cacheHit: false,
          chunks: 0,
          error,
          elapsedMs,
        })
        return { query, namespace, chunks: null, elapsedMs }
      }
    },

    budgetRemaining() {
      return Math.max(0, maxCalls - missesUsed)
    },

    stats() {
      return {
        totalCalls: stats.totalCalls,
        cacheHits: stats.cacheHits,
        cacheMisses: stats.cacheMisses,
        errors: stats.errors,
        // Defensive copy so callers can't mutate live state.
        log: stats.log.map((entry) => ({ ...entry })),
      }
    },
  }
}

// ─── cache key ─────────────────────────────────────────────────────────

/**
 * SHA-256 over `${namespace}\0${query}` per v3.1 LOCKED.
 * Web Crypto only (Cloudflare Workers + modern Node).
 */
async function cacheKey(namespace: string, query: string): Promise<string> {
  const text = `${namespace}\0${query}`
  const bytes = new TextEncoder().encode(text)
  const buf = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/** Exposed for tests — same hash function the cache uses internally. */
export const _testOnlyCacheKey = cacheKey
