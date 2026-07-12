// sig-public-demo — the abuse-control primitives behind POST /v1/demo/review.
// The route test (api-demo-review-route.test.ts) covers them end-to-end; this pins
// the units, especially the FAIL-CLOSED defaults (a demo that defaults ON, or falls
// open when KV faults, is an unbounded bill).

import { describe, it, expect } from "vitest"
import type { Env } from "@/src/shared/types/env"
import type { DemoEnv } from "./demo-review-guards"
import {
  DEFAULT_DEMO_DAILY_BUDGET_USD,
  DEFAULT_DEMO_IP_LIMIT,
  DEFAULT_DEMO_MAX_FILES,
  DEFAULT_DEMO_MAX_LINES,
  DEMO_ASSUMED_COST_USD,
  addDemoSpend,
  consumeIpQuota,
  isDemoBudgetExhausted,
  parseDemoPrUrl,
  readDemoCache,
  readIpQuota,
  reserveDemoSpend,
  resolveDemoLimits,
  resolveDemoMode,
  secondsUntilNextUtcDay,
  settleDemoSpend,
  writeDemoCache,
} from "./demo-review-guards"

/** In-memory KV double (get/put only — all this module uses). */
function kv(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: async (key: string, type?: "json") => {
      const raw = store.get(key)
      if (raw === undefined) return null
      return type === "json" ? JSON.parse(raw) : raw
    },
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
  } as unknown as KVNamespace
}

/** A KV that throws on every operation — a genuine binding fault. */
function brokenKv(): KVNamespace {
  return {
    get: async () => {
      throw new Error("kv down")
    },
    put: async () => {
      throw new Error("kv down")
    },
  } as unknown as KVNamespace
}

const envWith = (extra: Partial<DemoEnv> = {}, namespace: KVNamespace = kv()): Env =>
  ({ OPENCLAW_STATE: namespace, ...extra }) as unknown as Env

const NOW = new Date("2026-07-11T12:00:00.000Z")

describe("resolveDemoMode — FAIL CLOSED", () => {
  it("is off when unset (the whole point: an unauthenticated spend endpoint never defaults on)", () => {
    expect(resolveDemoMode(envWith())).toBe("off")
  })

  it.each(["off", "ON", "On", "true", "1", "yes", "enabled", ""])("is off for %j", (value) => {
    expect(resolveDemoMode(envWith({ SIGILIX_DEMO_MODE: value }))).toBe("off")
  })

  it('is on ONLY for the exact string "on"', () => {
    expect(resolveDemoMode(envWith({ SIGILIX_DEMO_MODE: "on" }))).toBe("on")
  })
})

describe("resolveDemoLimits", () => {
  it("falls back to the built-in defaults when unset", () => {
    expect(resolveDemoLimits(envWith())).toEqual({
      ipLimit: DEFAULT_DEMO_IP_LIMIT,
      dailyBudgetUsd: DEFAULT_DEMO_DAILY_BUDGET_USD,
      maxLines: DEFAULT_DEMO_MAX_LINES,
      maxFiles: DEFAULT_DEMO_MAX_FILES,
    })
  })

  it("honours valid overrides", () => {
    const limits = resolveDemoLimits(
      envWith({
        SIGILIX_DEMO_IP_LIMIT: "10",
        SIGILIX_DEMO_DAILY_BUDGET_USD: "5.5",
        SIGILIX_DEMO_MAX_LINES: "300",
        SIGILIX_DEMO_MAX_FILES: "9",
      }),
    )
    expect(limits).toEqual({ ipLimit: 10, dailyBudgetUsd: 5.5, maxLines: 300, maxFiles: 9 })
  })

  it("rejects junk / zero / negative overrides rather than disabling the cap", () => {
    const limits = resolveDemoLimits(
      envWith({
        SIGILIX_DEMO_IP_LIMIT: "0",
        SIGILIX_DEMO_DAILY_BUDGET_USD: "-1",
        SIGILIX_DEMO_MAX_LINES: "not-a-number",
        SIGILIX_DEMO_MAX_FILES: "",
      }),
    )
    expect(limits).toEqual({
      ipLimit: DEFAULT_DEMO_IP_LIMIT,
      dailyBudgetUsd: DEFAULT_DEMO_DAILY_BUDGET_USD,
      maxLines: DEFAULT_DEMO_MAX_LINES,
      maxFiles: DEFAULT_DEMO_MAX_FILES,
    })
  })
})

describe("parseDemoPrUrl", () => {
  it("parses a canonical PR URL", () => {
    expect(parseDemoPrUrl("https://github.com/facebook/react/pull/28901")).toEqual({
      owner: "facebook",
      repo: "react",
      prNumber: 28901,
    })
  })

  it("tolerates trailing segments, query strings, fragments and whitespace", () => {
    expect(parseDemoPrUrl("  https://github.com/o/r/pull/7/files?w=1#diff-abc  ")).toEqual({
      owner: "o",
      repo: "r",
      prNumber: 7,
    })
  })

  it.each([
    ["not a url at all", "not a url at all"],
    ["a non-GitHub host", "https://gitlab.com/o/r/pull/1"],
    ["a lookalike host", "https://github.com.evil.io/o/r/pull/1"],
    ["a non-PR path", "https://github.com/o/r/issues/1"],
    ["a repo root", "https://github.com/o/r"],
    ["a non-numeric PR", "https://github.com/o/r/pull/abc"],
    ["PR zero", "https://github.com/o/r/pull/0"],
    ["a path-traversal owner", "https://github.com/../r/pull/1"],
    ["an internal scheme", "file:///etc/passwd"],
  ])("rejects %s", (_label, url) => {
    expect(parseDemoPrUrl(url)).toBeNull()
  })
})

describe("per-IP quota", () => {
  it("reads without consuming, and consumes only when told to", async () => {
    const env = envWith()
    const limits = resolveDemoLimits(env)
    expect(await readIpQuota(env, "1.2.3.4", NOW, limits)).toMatchObject({ used: 0, exhausted: false })
    // A pure read must not move the counter — a cached result must never cost quota.
    expect(await readIpQuota(env, "1.2.3.4", NOW, limits)).toMatchObject({ used: 0, exhausted: false })
    await consumeIpQuota(env, "1.2.3.4", NOW)
    expect(await readIpQuota(env, "1.2.3.4", NOW, limits)).toMatchObject({ used: 1, exhausted: false })
  })

  it("marks the IP exhausted at the limit, and does not leak across IPs", async () => {
    const env = envWith({ SIGILIX_DEMO_IP_LIMIT: "2" })
    const limits = resolveDemoLimits(env)
    await consumeIpQuota(env, "1.2.3.4", NOW)
    await consumeIpQuota(env, "1.2.3.4", NOW)
    expect(await readIpQuota(env, "1.2.3.4", NOW, limits)).toMatchObject({ used: 2, exhausted: true })
    expect(await readIpQuota(env, "9.9.9.9", NOW, limits)).toMatchObject({ used: 0, exhausted: false })
  })

  it("resets on the next UTC day", async () => {
    const env = envWith({ SIGILIX_DEMO_IP_LIMIT: "1" })
    const limits = resolveDemoLimits(env)
    await consumeIpQuota(env, "1.2.3.4", NOW)
    expect(await readIpQuota(env, "1.2.3.4", NOW, limits)).toMatchObject({ exhausted: true })
    const tomorrow = new Date("2026-07-12T00:00:01.000Z")
    expect(await readIpQuota(env, "1.2.3.4", tomorrow, limits)).toMatchObject({ used: 0, exhausted: false })
  })

  it("FAILS CLOSED when KV faults (an unreadable counter means stop, not spend freely)", async () => {
    const env = envWith({}, brokenKv())
    expect(await readIpQuota(env, "1.2.3.4", NOW, resolveDemoLimits(env))).toMatchObject({ exhausted: true })
  })

  it("does not store the raw IP address anywhere in the key space", async () => {
    const store = new Map<string, string>()
    const namespace = {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => void store.set(key, value),
    } as unknown as KVNamespace
    await consumeIpQuota(envWith({}, namespace), "203.0.113.7", NOW)
    expect([...store.keys()]).toHaveLength(1)
    expect([...store.keys()][0]).not.toContain("203.0.113.7")
  })
})

describe("global daily budget", () => {
  it("is not exhausted until the day's spend reaches the cap", async () => {
    const env = envWith({ SIGILIX_DEMO_DAILY_BUDGET_USD: "1" })
    const limits = resolveDemoLimits(env)
    expect(await isDemoBudgetExhausted(env, NOW, limits)).toBe(false)
    await addDemoSpend(env, NOW, 0.6)
    expect(await isDemoBudgetExhausted(env, NOW, limits)).toBe(false)
    await addDemoSpend(env, NOW, 0.4)
    expect(await isDemoBudgetExhausted(env, NOW, limits)).toBe(true)
  })

  it("reserves before the run and reconciles to the real cost afterwards", async () => {
    const env = envWith({ SIGILIX_DEMO_DAILY_BUDGET_USD: "10" })
    const limits = resolveDemoLimits(env)
    await reserveDemoSpend(env, NOW) // pre-charge one assumed review
    await settleDemoSpend(env, NOW, 0.9) // the ensemble actually cost $0.90
    // 0.25 reserved + (0.90 - 0.25) reconciled = 0.90 charged, not 1.15.
    await addDemoSpend(env, NOW, 10 - 0.9 - 0.0001)
    expect(await isDemoBudgetExhausted(env, NOW, limits)).toBe(false)
    await addDemoSpend(env, NOW, 0.0001)
    expect(await isDemoBudgetExhausted(env, NOW, limits)).toBe(true)
  })

  it("charges the assumed cost when the engine reports nothing usable", async () => {
    const env = envWith({ SIGILIX_DEMO_DAILY_BUDGET_USD: String(DEMO_ASSUMED_COST_USD) })
    await reserveDemoSpend(env, NOW)
    await settleDemoSpend(env, NOW, Number.NaN)
    expect(await isDemoBudgetExhausted(env, NOW, resolveDemoLimits(env))).toBe(true)
  })

  it("is day-scoped", async () => {
    const env = envWith({ SIGILIX_DEMO_DAILY_BUDGET_USD: "1" })
    const limits = resolveDemoLimits(env)
    await addDemoSpend(env, NOW, 5)
    expect(await isDemoBudgetExhausted(env, NOW, limits)).toBe(true)
    expect(await isDemoBudgetExhausted(env, new Date("2026-07-12T00:00:01.000Z"), limits)).toBe(false)
  })

  it("FAILS CLOSED when KV faults (this counter is the only bound on worst-case spend)", async () => {
    const env = envWith({}, brokenKv())
    expect(await isDemoBudgetExhausted(env, NOW, resolveDemoLimits(env))).toBe(true)
  })
})

describe("result cache", () => {
  it("round-trips a review keyed on owner/repo/pr/headSha", async () => {
    const env = envWith()
    const target = { owner: "O", repo: "R", prNumber: 3 }
    expect(await readDemoCache(env, target, "sha1")).toBeNull()
    await writeDemoCache(env, target, "sha1", { summary: "hi" })
    expect(await readDemoCache(env, target, "sha1")).toEqual({ summary: "hi" })
    // A new head SHA is a different review — it must NOT serve the stale one.
    expect(await readDemoCache(env, target, "sha2")).toBeNull()
  })

  it("is case-insensitive on owner/repo (github.com/Facebook/React == facebook/react)", async () => {
    const env = envWith()
    await writeDemoCache(env, { owner: "Facebook", repo: "React", prNumber: 1 }, "sha", { summary: "x" })
    expect(await readDemoCache(env, { owner: "facebook", repo: "react", prNumber: 1 }, "sha")).toEqual({ summary: "x" })
  })

  it("treats a KV fault as a miss (we pay again — never serves a wrong result)", async () => {
    const env = envWith({}, brokenKv())
    expect(await readDemoCache(env, { owner: "o", repo: "r", prNumber: 1 }, "sha")).toBeNull()
    await expect(writeDemoCache(env, { owner: "o", repo: "r", prNumber: 1 }, "sha", {})).resolves.toBeUndefined()
  })
})

describe("secondsUntilNextUtcDay", () => {
  it("counts down to the next UTC midnight", () => {
    expect(secondsUntilNextUtcDay(new Date("2026-07-11T23:59:30.000Z"))).toBe(30)
    expect(secondsUntilNextUtcDay(new Date("2026-07-11T00:00:00.000Z"))).toBe(24 * 60 * 60)
  })
})
