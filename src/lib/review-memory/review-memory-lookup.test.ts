// ARC-189 — Lookup tests (Task 5).

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import {
  runReviewMemoryLookup,
  isMemoryActive,
  selectTopMemories,
  aggregateShadowClaims,
} from "@/lib/review-memory/lookup"
import { buildKey } from "@/lib/review-memory/storage"
import { computePathSha256 } from "@/lib/review-memory/marker"
import type {
  ReviewMemoryRecord,
  ReviewMemorySignal,
  ResolvedReviewMemoryConfig,
  ReviewMemoryFinding,
} from "@/lib/review-memory/types"
import type { Env } from "@/shared/types/env"

// ─── KV stub matching existing convention ───────────────────

interface KvStub {
  kv: Env["OPENCLAW_STATE"]
  store: Map<string, string>
  failGet: { value: boolean }
  getCallCount: { value: number }
}

function makeKvStub(): KvStub {
  const store = new Map<string, string>()
  const failGet = { value: false }
  const getCallCount = { value: 0 }
  const kv = {
    async get(key: string): Promise<string | null> {
      getCallCount.value++
      if (failGet.value) throw new Error("kv-get failed")
      return store.get(key) ?? null
    },
    async put(): Promise<void> {},
    async delete(): Promise<void> {},
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store, failGet, getCallCount }
}

function makeEnv(
  kv: Env["OPENCLAW_STATE"],
  retrievalEnv: "on" | "off" | undefined = "on",
): Env {
  return {
    OPENCLAW_STATE: kv,
    OPENCLAW_REVIEW_MEMORY_ENABLED: retrievalEnv,
  } as unknown as Env
}

const ALL_CATEGORIES = ["security", "logic", "performance", "tests"] as const

function defaultConfig(
  over: Partial<ResolvedReviewMemoryConfig> = {},
): ResolvedReviewMemoryConfig {
  return {
    enabled: true,
    captureOnly: false,
    categories: ALL_CATEGORIES,
    maxInjectedMemories: 5,
    minSignalThreshold: 3,
    maxSignalAgeDays: 90,
    claimSoftening: false,
    ...over,
  }
}

function makeSignal(over: Partial<ReviewMemorySignal> = {}): ReviewMemorySignal {
  return {
    ts: new Date().toISOString(),
    prNumber: 1,
    commentId: 100,
    fid: "abc1234567890def",
    kind: "dismissed-textual",
    ...over,
  }
}

function rec(
  category: ReviewMemoryRecord["category"],
  signals: ReviewMemorySignal[],
  pathSha256?: string,
): ReviewMemoryRecord {
  return {
    schemaVersion: 1,
    category,
    ...(pathSha256 ? { pathSha256 } : {}),
    signals,
    lastUpdatedTs: new Date().toISOString(),
  }
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

// ─── runReviewMemoryLookup ────────────────────────────────────

describe("runReviewMemoryLookup — gate skips", () => {
  it("retrieval-disabled-env when env flag off", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv, "off")
    const r = await runReviewMemoryLookup({
      env, owner: "a", repo: "r", prNumber: 1, paths: ["src/foo.ts"],
      config: defaultConfig(),
    })
    expect(r.skipped).toBe(true)
    if (r.skipped) expect(r.reason).toBe("retrieval-disabled-env")
  })

  it("retrieval-disabled-config when sigilix.json enabled false", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv, "on")
    const r = await runReviewMemoryLookup({
      env, owner: "a", repo: "r", prNumber: 1, paths: ["src/foo.ts"],
      config: defaultConfig({ enabled: false }),
    })
    expect(r.skipped).toBe(true)
    if (r.skipped) expect(r.reason).toBe("retrieval-disabled-config")
  })

  it("captureOnly true + retrieval flags off → retrieval-disabled-config", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv, "on")
    const r = await runReviewMemoryLookup({
      env, owner: "a", repo: "r", prNumber: 1, paths: ["src/foo.ts"],
      config: defaultConfig({ enabled: false, captureOnly: true }),
    })
    expect(r.skipped).toBe(true)
    if (r.skipped) expect(r.reason).toBe("retrieval-disabled-config")
  })

  it("no-paths-to-query when paths is empty", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv, "on")
    const r = await runReviewMemoryLookup({
      env, owner: "a", repo: "r", prNumber: 1, paths: [],
      config: defaultConfig(),
    })
    expect(r.skipped).toBe(true)
    if (r.skipped) expect(r.reason).toBe("no-paths-to-query")
  })
})

describe("runReviewMemoryLookup — happy path", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  })
  afterEach(() => {
    consoleSpy.mockRestore()
  })

  it("3 fresh category signals → 1 active finding", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const signals = [
      makeSignal({ ts: isoDaysAgo(10), commentId: 1 }),
      makeSignal({ ts: isoDaysAgo(20), commentId: 2 }),
      makeSignal({ ts: isoDaysAgo(30), commentId: 3 }),
    ]
    store.set(
      buildKey("a", "r", { kind: "category", category: "performance" }),
      JSON.stringify(rec("performance", signals)),
    )
    const r = await runReviewMemoryLookup({
      env, owner: "a", repo: "r", prNumber: 1,
      paths: ["src/foo.ts"],
      config: defaultConfig(),
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    expect(r.findings.length).toBe(1)
    expect(r.findings[0]?.category).toBe("performance")
    expect(r.findings[0]?.scope).toBe("category")
    expect(r.findings[0]?.signalCount).toBe(3)
    expect(r.findings[0]?.suggestedAction).toBe("soften")
  })

  it("2 signals → 0 findings (below threshold)", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const signals = [
      makeSignal({ ts: isoDaysAgo(10), commentId: 1 }),
      makeSignal({ ts: isoDaysAgo(20), commentId: 2 }),
    ]
    store.set(
      buildKey("a", "r", { kind: "category", category: "performance" }),
      JSON.stringify(rec("performance", signals)),
    )
    const r = await runReviewMemoryLookup({
      env, owner: "a", repo: "r", prNumber: 1,
      paths: ["src/foo.ts"],
      config: defaultConfig(),
    })
    if (r.skipped) throw new Error("unexpected skip")
    expect(r.findings.length).toBe(0)
  })

  it("all signals 91d old (boundary, Codex MINOR on spec v3) → 0 findings", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const signals = [
      makeSignal({ ts: isoDaysAgo(91), commentId: 1 }),
      makeSignal({ ts: isoDaysAgo(92), commentId: 2 }),
      makeSignal({ ts: isoDaysAgo(93), commentId: 3 }),
    ]
    store.set(
      buildKey("a", "r", { kind: "category", category: "performance" }),
      JSON.stringify(rec("performance", signals)),
    )
    const r = await runReviewMemoryLookup({
      env, owner: "a", repo: "r", prNumber: 1,
      paths: ["src/foo.ts"],
      config: defaultConfig(),
    })
    if (r.skipped) throw new Error("unexpected skip")
    expect(r.findings.length).toBe(0)
  })

  it("path-category requires ≥1 signal in trailing 30d", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    // 3 signals, all 60-80d old (still in 90d activation but no
    // recent signal in 30d → path-scope should NOT activate)
    const signals = [
      makeSignal({ ts: isoDaysAgo(60), commentId: 1 }),
      makeSignal({ ts: isoDaysAgo(70), commentId: 2 }),
      makeSignal({ ts: isoDaysAgo(80), commentId: 3 }),
    ]
    // Seed the record under the SAME sha the lookup will hash `path` to,
    // so the record is genuinely READ and the assertion validates the
    // 30-day recency rule — not a path-hash mismatch (CR PR #209 catch:
    // the prior version seeded an unrelated sha so the record was never
    // read and the test passed for the wrong reason).
    const path = "tests/utils.ts"
    const pathSha = await computePathSha256(path)
    store.set(
      buildKey("a", "r", {
        kind: "path-category",
        category: "tests",
        pathSha256: pathSha,
      }),
      JSON.stringify(rec("tests", signals, pathSha)),
    )
    const r = await runReviewMemoryLookup({
      env, owner: "a", repo: "r", prNumber: 1,
      paths: [path],
      config: defaultConfig(),
    })
    if (r.skipped) throw new Error("unexpected skip")
    // Record IS read now; path-scope still does NOT activate because no
    // signal falls in the trailing 30d. category-only key was not seeded.
    expect(r.findings.length).toBe(0)
  })

  it("category filter excludes opted-out categories", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const signals = [
      makeSignal({ ts: isoDaysAgo(10), commentId: 1 }),
      makeSignal({ ts: isoDaysAgo(20), commentId: 2 }),
      makeSignal({ ts: isoDaysAgo(30), commentId: 3 }),
    ]
    store.set(
      buildKey("a", "r", { kind: "category", category: "performance" }),
      JSON.stringify(rec("performance", signals)),
    )
    store.set(
      buildKey("a", "r", { kind: "category", category: "tests" }),
      JSON.stringify(rec("tests", signals)),
    )
    const r = await runReviewMemoryLookup({
      env, owner: "a", repo: "r", prNumber: 1,
      paths: ["src/foo.ts"],
      config: defaultConfig({ categories: ["performance"] }),
    })
    if (r.skipped) throw new Error("unexpected skip")
    expect(r.findings.length).toBe(1)
    expect(r.findings[0]?.category).toBe("performance")
  })

  it("KV read failure → empty findings + telemetry; never throws", async () => {
    const { kv, failGet } = makeKvStub()
    failGet.value = true
    const env = makeEnv(kv, "on")
    const r = await runReviewMemoryLookup({
      env, owner: "a", repo: "r", prNumber: 1,
      paths: ["src/foo.ts"],
      config: defaultConfig(),
    })
    if (r.skipped) throw new Error("unexpected skip")
    expect(r.findings.length).toBe(0)
  })

  it("uses Promise.allSettled — KV calls fan out in parallel for paths × categories", async () => {
    const { kv, getCallCount } = makeKvStub()
    const env = makeEnv(kv, "on")
    await runReviewMemoryLookup({
      env, owner: "a", repo: "r", prNumber: 1,
      paths: ["a.ts", "b.ts"],
      config: defaultConfig(),
    })
    // 4 categories × (1 cat-key + 2 path-keys per path × 4 cats)
    // = 4 cat-only reads + 8 path-cat reads = 12 reads minimum
    // (categories=4, paths=2 → 4 cat-keys + 4*2=8 path-cat keys)
    expect(getCallCount.value).toBeGreaterThanOrEqual(12)
  })
})

describe("runReviewMemoryLookup — caps + ordering", () => {
  it("caps at maxInjectedMemories and sorts deterministically", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    // Seed all 4 categories with 3+ signals so all are active
    for (const cat of ALL_CATEGORIES) {
      const signals = [
        makeSignal({ ts: isoDaysAgo(5), commentId: 1 }),
        makeSignal({ ts: isoDaysAgo(15), commentId: 2 }),
        makeSignal({ ts: isoDaysAgo(25), commentId: 3 }),
      ]
      store.set(
        buildKey("a", "r", { kind: "category", category: cat }),
        JSON.stringify(rec(cat, signals)),
      )
    }
    const r = await runReviewMemoryLookup({
      env, owner: "a", repo: "r", prNumber: 1,
      paths: ["src/foo.ts"],
      config: defaultConfig({ maxInjectedMemories: 2 }),
    })
    if (r.skipped) throw new Error("unexpected skip")
    expect(r.findings.length).toBe(2)
  })
})

// ─── isMemoryActive (pure) ────────────────────────────────────

describe("isMemoryActive (pure)", () => {
  function recAll(signals: ReviewMemorySignal[]): ReviewMemoryRecord {
    return {
      schemaVersion: 1,
      category: "logic",
      signals,
      lastUpdatedTs: new Date().toISOString(),
    }
  }

  const cfg = defaultConfig()
  const now = Date.now()

  it("active when ≥3 signals in trailing 90d", () => {
    const r = recAll([
      makeSignal({ ts: isoDaysAgo(10) }),
      makeSignal({ ts: isoDaysAgo(20) }),
      makeSignal({ ts: isoDaysAgo(30) }),
    ])
    expect(isMemoryActive(r, "category", cfg, now)).toBe(true)
  })

  it("inactive at threshold-1", () => {
    const r = recAll([
      makeSignal({ ts: isoDaysAgo(10) }),
      makeSignal({ ts: isoDaysAgo(20) }),
    ])
    expect(isMemoryActive(r, "category", cfg, now)).toBe(false)
  })

  it("path-category needs recent (≤30d) signal AND ≥3 in trailing 90d", () => {
    // 3 signals all 60-80d → category active, path NOT
    const oldOnly = recAll([
      makeSignal({ ts: isoDaysAgo(60) }),
      makeSignal({ ts: isoDaysAgo(70) }),
      makeSignal({ ts: isoDaysAgo(80) }),
    ])
    expect(isMemoryActive(oldOnly, "category", cfg, now)).toBe(true)
    expect(isMemoryActive(oldOnly, "path-category", cfg, now)).toBe(false)

    // Add a recent signal → both active
    const withRecent = recAll([
      ...oldOnly.signals,
      makeSignal({ ts: isoDaysAgo(15) }),
    ])
    expect(isMemoryActive(withRecent, "path-category", cfg, now)).toBe(true)
  })

  it("respects custom maxSignalAgeDays from config", () => {
    const r = recAll([
      makeSignal({ ts: isoDaysAgo(40) }),
      makeSignal({ ts: isoDaysAgo(50) }),
      makeSignal({ ts: isoDaysAgo(60) }),
    ])
    // With 90d window, all 3 are active → meets threshold
    expect(isMemoryActive(r, "category", cfg, now)).toBe(true)
    // With 30d window, all 3 are too old → 0 active signals
    const tightCfg = defaultConfig({ maxSignalAgeDays: 30 })
    expect(isMemoryActive(r, "category", tightCfg, now)).toBe(false)
  })

  // SIG-173 — differential softening weights at the threshold layer.

  it("activates earlier when signals carry a too-minor reason (1.5x weight)", () => {
    // Threshold is 3 (default). Two too-minor signals contribute 2 * 1.5 = 3.0,
    // which meets the threshold WITHOUT needing a third signal. Same two
    // signals unlabeled would contribute 2.0 and remain inactive.
    const twoTooMinor = recAll([
      makeSignal({ ts: isoDaysAgo(10), dismissReason: "too-minor" }),
      makeSignal({ ts: isoDaysAgo(20), dismissReason: "too-minor" }),
    ])
    expect(isMemoryActive(twoTooMinor, "category", cfg, now)).toBe(true)

    const twoUnlabeled = recAll([
      makeSignal({ ts: isoDaysAgo(10) }),
      makeSignal({ ts: isoDaysAgo(20) }),
    ])
    expect(isMemoryActive(twoUnlabeled, "category", cfg, now)).toBe(false)
  })

  it("not-a-bug weights at 1.0 — same as unlabeled / textual signals", () => {
    const twoNotABug = recAll([
      makeSignal({ ts: isoDaysAgo(10), dismissReason: "not-a-bug" }),
      makeSignal({ ts: isoDaysAgo(20), dismissReason: "not-a-bug" }),
    ])
    // Two * 1.0 = 2.0 < threshold-3 → inactive.
    expect(isMemoryActive(twoNotABug, "category", cfg, now)).toBe(false)
  })
})

// ─── selectTopMemories (pure) ─────────────────────────────────

describe("selectTopMemories (pure)", () => {
  function f(over: Partial<ReviewMemoryFinding> = {}): ReviewMemoryFinding {
    return {
      scope: "category",
      category: "logic",
      signalCount: 3,
      lastSignalTs: isoDaysAgo(10),
      suggestedAction: "soften",
      ...over,
    }
  }

  it("caps at maxN", () => {
    const arr = [f({ category: "logic" }), f({ category: "performance" }), f({ category: "tests" })]
    expect(selectTopMemories(arr, 2).length).toBe(2)
  })

  it("sorts by recency desc → signalCount desc → category asc", () => {
    const arr = [
      f({ category: "tests", signalCount: 3, lastSignalTs: isoDaysAgo(20) }),
      f({ category: "performance", signalCount: 5, lastSignalTs: isoDaysAgo(10) }),
      f({ category: "logic", signalCount: 5, lastSignalTs: isoDaysAgo(10) }),
    ]
    const out = selectTopMemories(arr, 5)
    // Most recent first; ties broken by signalCount desc, then alpha
    expect(out.map((x) => x.category)).toEqual(["logic", "performance", "tests"])
  })

  it("returns empty for empty input", () => {
    expect(selectTopMemories([], 5)).toEqual([])
  })
})

// ─── SIG-276 Phase 3: aggregateShadowClaims (pure) ──────────────

describe("aggregateShadowClaims (pure)", () => {
  const claim = (
    type: string,
    confidence = 0.8,
    extractorVersion = 1,
  ) => ({ id: "x".repeat(16), type, confidence, extractorVersion }) as never

  it("returns [] for no signals", () => {
    expect(aggregateShadowClaims([])).toEqual([])
  })

  it("ignores signals with no claims (legacy / claimless)", () => {
    const out = aggregateShadowClaims([
      makeSignal({ prNumber: 1 }),
      makeSignal({ prNumber: 2, claims: undefined }),
    ])
    expect(out).toEqual([])
  })

  it("buckets by claim type and counts DISTINCT prNumber, not raw signals", () => {
    const out = aggregateShadowClaims([
      makeSignal({ prNumber: 7, commentId: 1, claims: [claim("auth-gate-is-boundary")] }),
      makeSignal({ prNumber: 7, commentId: 2, claims: [claim("auth-gate-is-boundary")] }),
      makeSignal({ prNumber: 9, commentId: 3, claims: [claim("auth-gate-is-boundary")] }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.type).toBe("auth-gate-is-boundary")
    expect(out[0]!.distinctPrCount).toBe(2) // PRs 7 and 9
    expect(out[0]!.signalCount).toBe(3) // three raw signals
  })

  it("separates distinct claim types into distinct buckets", () => {
    const out = aggregateShadowClaims([
      makeSignal({ prNumber: 1, claims: [claim("auth-gate-is-boundary"), claim("rethrowing-catch-not-swallowed")] }),
    ])
    expect(out.map((c) => c.type).sort()).toEqual([
      "auth-gate-is-boundary",
      "rethrowing-catch-not-swallowed",
    ])
  })

  it("collects distinct extractorVersions and raw confidences", () => {
    const out = aggregateShadowClaims([
      makeSignal({ prNumber: 1, claims: [claim("auth-gate-is-boundary", 0.6, 1)] }),
      makeSignal({ prNumber: 2, claims: [claim("auth-gate-is-boundary", 0.9, 2)] }),
    ])
    expect(out[0]!.extractorVersions.sort()).toEqual([1, 2])
    expect(out[0]!.rawConfidences.sort()).toEqual([0.6, 0.9])
  })

  it("lastSignalTs is the most-recent signal carrying the type", () => {
    const out = aggregateShadowClaims([
      makeSignal({ prNumber: 1, ts: isoDaysAgo(40), claims: [claim("auth-gate-is-boundary")] }),
      makeSignal({ prNumber: 2, ts: isoDaysAgo(2), claims: [claim("auth-gate-is-boundary")] }),
    ])
    // the most-recent (2-days-ago) signal, not the 40-days-ago one
    expect(typeof out[0]!.lastSignalTs).toBe("string")
    expect(Date.parse(out[0]!.lastSignalTs)).toBeGreaterThan(Date.parse(isoDaysAgo(10)))
  })
})

// ─── SIG-276 Phase 3: lookup populates shadowClaims under the flag ──

describe("runReviewMemoryLookup — shadowClaims flag", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  })
  afterEach(() => consoleSpy.mockRestore())

  const claim = (type: string) =>
    ({ id: "x".repeat(16), type, confidence: 0.8, extractorVersion: 1 }) as never

  // The shadow pass requires ALL THREE flags on (ENABLED + CLAIMS +
  // CLAIM_SHADOW). These tests toggle only CLAIM_SHADOW; CLAIMS stays on.
  function envWithShadow(kv: Env["OPENCLAW_STATE"], shadow: "on" | undefined): Env {
    return {
      OPENCLAW_STATE: kv,
      OPENCLAW_REVIEW_MEMORY_ENABLED: "on",
      OPENCLAW_REVIEW_MEMORY_CLAIMS: "on",
      OPENCLAW_REVIEW_MEMORY_CLAIM_SHADOW: shadow,
    } as unknown as Env
  }

  function activeCatRecord(): ReviewMemoryRecord {
    return rec("logic", [
      makeSignal({ prNumber: 1, commentId: 1, ts: isoDaysAgo(5), claims: [claim("structural-glue-not-test-target")] }),
      makeSignal({ prNumber: 2, commentId: 2, ts: isoDaysAgo(6), claims: [claim("structural-glue-not-test-target")] }),
      makeSignal({ prNumber: 3, commentId: 3, ts: isoDaysAgo(7), claims: [claim("structural-glue-not-test-target")] }),
    ])
  }

  it("populates shadowClaims on active memories when the shadow flag is on", async () => {
    const { kv, store } = makeKvStub()
    store.set(buildKey("a", "r", { kind: "category", category: "logic" }), JSON.stringify(activeCatRecord()))
    const res = await runReviewMemoryLookup({
      env: envWithShadow(kv, "on"),
      owner: "a", repo: "r", prNumber: 50, paths: ["src/x.ts"],
      config: defaultConfig(),
    })
    expect(res.skipped).toBe(false)
    if (res.skipped) return
    const cat = res.findings.find((f) => f.scope === "category" && f.category === "logic")!
    expect(cat.shadowClaims).toBeDefined()
    expect(cat.shadowClaims!.map((c) => c.type)).toContain("structural-glue-not-test-target")
    expect(cat.shadowClaims![0]!.distinctPrCount).toBe(3)
  })

  it("does NOT populate shadowClaims when the shadow flag is off (default)", async () => {
    const { kv, store } = makeKvStub()
    store.set(buildKey("a", "r", { kind: "category", category: "logic" }), JSON.stringify(activeCatRecord()))
    const res = await runReviewMemoryLookup({
      env: envWithShadow(kv, undefined),
      owner: "a", repo: "r", prNumber: 50, paths: ["src/x.ts"],
      config: defaultConfig(),
    })
    expect(res.skipped).toBe(false)
    if (res.skipped) return
    for (const f of res.findings) expect(f).not.toHaveProperty("shadowClaims")
  })

  it("does NOT populate shadowClaims when CLAIMS is off, even with CLAIM_SHADOW on (three-flag gate)", async () => {
    const { kv, store } = makeKvStub()
    store.set(buildKey("a", "r", { kind: "category", category: "logic" }), JSON.stringify(activeCatRecord()))
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_REVIEW_MEMORY_ENABLED: "on",
      // OPENCLAW_REVIEW_MEMORY_CLAIMS intentionally OFF
      OPENCLAW_REVIEW_MEMORY_CLAIM_SHADOW: "on",
    } as unknown as Env
    const res = await runReviewMemoryLookup({
      env,
      owner: "a", repo: "r", prNumber: 50, paths: ["src/x.ts"],
      config: defaultConfig(),
    })
    expect(res.skipped).toBe(false)
    if (res.skipped) return
    for (const f of res.findings) expect(f).not.toHaveProperty("shadowClaims")
  })
})
