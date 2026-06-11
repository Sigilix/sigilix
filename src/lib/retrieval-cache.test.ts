import { describe, expect, it } from "vitest"
import { createRetrievalCache, _testOnlyCacheKey } from "@/src/lib/retrieval-cache"
import type { RetrievedChunk } from "@/src/lib/retrieval"

const fakeChunk = (path: string): RetrievedChunk => ({
  path,
  lineStart: 1,
  lineEnd: 10,
  score: 0.9,
  content: `// ${path}`,
})

describe("retrieval cache key", () => {
  it("produces identical hashes for identical inputs", async () => {
    const a = await _testOnlyCacheKey("rubberfit", "where is auth")
    const b = await _testOnlyCacheKey("rubberfit", "where is auth")
    expect(a).toBe(b)
  })

  it("produces different hashes for different namespaces", async () => {
    const a = await _testOnlyCacheKey("rubberfit", "x")
    const b = await _testOnlyCacheKey("openclaw-worker", "x")
    expect(a).not.toBe(b)
  })

  it("uses NUL delimiter to prevent ambiguous concatenation", async () => {
    // (ns="ab", q="c") MUST NOT collide with (ns="a", q="bc"),
    // which would happen with a `${ns}${q}` join. NUL byte fixes it.
    const a = await _testOnlyCacheKey("ab", "c")
    const b = await _testOnlyCacheKey("a", "bc")
    expect(a).not.toBe(b)
  })

  it("does NOT normalize whitespace or case (v3.1 — preserve query diversity)", async () => {
    const a = await _testOnlyCacheKey("ns", "Where Is X")
    const b = await _testOnlyCacheKey("ns", "where is x")
    expect(a).not.toBe(b)
    const c = await _testOnlyCacheKey("ns", "where  is  x") // double space
    const d = await _testOnlyCacheKey("ns", "where is x")
    expect(c).not.toBe(d)
  })
})

describe("createRetrievalCache — basic hit/miss", () => {
  it("calls the fetcher once per unique (query, namespace) pair", async () => {
    const cache = createRetrievalCache({ maxCalls: 5 })
    let fetcherCalls = 0
    const fetcher = async () => {
      fetcherCalls++
      return [fakeChunk("a.ts")]
    }

    // First call — miss, fetcher invoked.
    const r1 = await cache.cachedRetrieve({ caller: "test", query: "x", namespace: "n", fetcher })
    expect(fetcherCalls).toBe(1)
    expect(r1.chunks).toEqual([fakeChunk("a.ts")])

    // Second call SAME query+namespace — hit, fetcher NOT invoked.
    const r2 = await cache.cachedRetrieve({ caller: "test", query: "x", namespace: "n", fetcher })
    expect(fetcherCalls).toBe(1)
    expect(r2.chunks).toEqual([fakeChunk("a.ts")])
    expect(r2.elapsedMs).toBe(0)
  })

  it("treats different queries in the same namespace as separate entries", async () => {
    const cache = createRetrievalCache({ maxCalls: 5 })
    let fetcherCalls = 0
    const fetcher = async () => {
      fetcherCalls++
      return [fakeChunk("a.ts")]
    }

    await cache.cachedRetrieve({ caller: "t", query: "q1", namespace: "n", fetcher })
    await cache.cachedRetrieve({ caller: "t", query: "q2", namespace: "n", fetcher })
    expect(fetcherCalls).toBe(2)
  })

  it("treats same query in different namespaces as separate entries", async () => {
    const cache = createRetrievalCache({ maxCalls: 5 })
    let fetcherCalls = 0
    const fetcher = async () => {
      fetcherCalls++
      return [fakeChunk("a.ts")]
    }

    await cache.cachedRetrieve({ caller: "t", query: "q", namespace: "ns1", fetcher })
    await cache.cachedRetrieve({ caller: "t", query: "q", namespace: "ns2", fetcher })
    expect(fetcherCalls).toBe(2)
  })
})

describe("createRetrievalCache — budget enforcement", () => {
  it("blocks new misses once the budget is exhausted (returns null chunks)", async () => {
    const cache = createRetrievalCache({ maxCalls: 2 })
    let fetcherCalls = 0
    const fetcher = async () => {
      fetcherCalls++
      return [fakeChunk("a.ts")]
    }

    // 2 misses use up the budget.
    await cache.cachedRetrieve({ caller: "t", query: "q1", namespace: "n", fetcher })
    await cache.cachedRetrieve({ caller: "t", query: "q2", namespace: "n", fetcher })
    expect(cache.budgetRemaining()).toBe(0)
    expect(fetcherCalls).toBe(2)

    // 3rd miss — budget exhausted, fetcher NOT called.
    const r = await cache.cachedRetrieve({ caller: "t", query: "q3", namespace: "n", fetcher })
    expect(fetcherCalls).toBe(2)
    expect(r.chunks).toBeNull()
  })

  it("hits do NOT consume budget — only misses do", async () => {
    const cache = createRetrievalCache({ maxCalls: 1 })
    const fetcher = async () => [fakeChunk("a.ts")]

    await cache.cachedRetrieve({ caller: "t", query: "q", namespace: "n", fetcher })
    expect(cache.budgetRemaining()).toBe(0)

    // Hit on same query — budget unchanged, no fetch.
    let secondFetcherCalls = 0
    const secondFetcher = async () => {
      secondFetcherCalls++
      return [fakeChunk("b.ts")]
    }
    const r = await cache.cachedRetrieve({
      caller: "t",
      query: "q",
      namespace: "n",
      fetcher: secondFetcher,
    })
    expect(secondFetcherCalls).toBe(0)
    expect(r.chunks).toEqual([fakeChunk("a.ts")])
    expect(cache.budgetRemaining()).toBe(0)
  })
})

describe("createRetrievalCache — failure handling", () => {
  it("caches fetcher failures so the same query doesn't retry mid-run", async () => {
    const cache = createRetrievalCache({ maxCalls: 5 })
    let fetcherCalls = 0
    const failingFetcher = async () => {
      fetcherCalls++
      throw new Error("vector DB down")
    }

    const r1 = await cache.cachedRetrieve({
      caller: "t",
      query: "q",
      namespace: "n",
      fetcher: failingFetcher,
    })
    expect(r1.chunks).toBeNull()
    expect(fetcherCalls).toBe(1)

    // Same query → cached failure, no second attempt.
    const r2 = await cache.cachedRetrieve({
      caller: "t",
      query: "q",
      namespace: "n",
      fetcher: failingFetcher,
    })
    expect(r2.chunks).toBeNull()
    expect(fetcherCalls).toBe(1)
  })

  it("counts failed misses against the budget (PR #34 / spec catch)", async () => {
    const cache = createRetrievalCache({ maxCalls: 2 })
    const failingFetcher = async () => {
      throw new Error("nope")
    }

    await cache.cachedRetrieve({
      caller: "t",
      query: "q1",
      namespace: "n",
      fetcher: failingFetcher,
    })
    await cache.cachedRetrieve({
      caller: "t",
      query: "q2",
      namespace: "n",
      fetcher: failingFetcher,
    })
    expect(cache.budgetRemaining()).toBe(0)

    // 3rd attempt — budget exhausted regardless of failures above.
    const r = await cache.cachedRetrieve({
      caller: "t",
      query: "q3",
      namespace: "n",
      fetcher: failingFetcher,
    })
    expect(r.chunks).toBeNull()
  })
})

describe("createRetrievalCache — stats / telemetry log", () => {
  it("records caller, query, namespace, hit/miss, chunk count, elapsedMs per call", async () => {
    const cache = createRetrievalCache({ maxCalls: 5 })
    const fetcher = async () => [fakeChunk("a.ts"), fakeChunk("b.ts")]

    await cache.cachedRetrieve({ caller: "preflight", query: "q1", namespace: "ns", fetcher })
    await cache.cachedRetrieve({
      caller: "specialist:logic",
      query: "q1",
      namespace: "ns",
      fetcher,
    })
    await cache.cachedRetrieve({ caller: "synthesizer", query: "q2", namespace: "ns", fetcher })

    const s = cache.stats()
    expect(s.totalCalls).toBe(3)
    expect(s.cacheHits).toBe(1) // q1 from logic was a hit
    expect(s.cacheMisses).toBe(2) // q1 preflight + q2 synth
    expect(s.errors).toBe(0)
    expect(s.log).toHaveLength(3)
    expect(s.log[0]?.caller).toBe("preflight")
    expect(s.log[0]?.cacheHit).toBe(false)
    expect(s.log[0]?.chunks).toBe(2)
    expect(s.log[1]?.caller).toBe("specialist:logic")
    expect(s.log[1]?.cacheHit).toBe(true)
    expect(s.log[1]?.elapsedMs).toBe(0)
  })

  it("records errors in the log with truncated message", async () => {
    const cache = createRetrievalCache({ maxCalls: 5 })
    const failingFetcher = async () => {
      throw new Error("upstream timeout")
    }

    await cache.cachedRetrieve({
      caller: "preflight",
      query: "q",
      namespace: "n",
      fetcher: failingFetcher,
    })
    const s = cache.stats()
    expect(s.errors).toBe(1)
    expect(s.log[0]?.error).toBe("upstream timeout")
  })

  it("returns defensive-copied log (caller mutation can't corrupt internal state)", async () => {
    const cache = createRetrievalCache({ maxCalls: 5 })
    const fetcher = async () => [fakeChunk("a.ts")]

    await cache.cachedRetrieve({ caller: "t", query: "q", namespace: "n", fetcher })
    const log1 = cache.stats().log
    log1[0]!.query = "MUTATED"

    const log2 = cache.stats().log
    expect(log2[0]?.query).toBe("q")
  })
})
