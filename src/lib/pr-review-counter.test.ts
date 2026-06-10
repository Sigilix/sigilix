// SIG-101 — per-PR review counter helper tests.

import { describe, it, expect, vi, afterEach } from "vitest"

// CodeRabbit catch on PR #110: centralized spy cleanup so a failing
// assertion can't leak a `console.warn` spy into a subsequent test.
// Replaces per-test `warnSpy.mockRestore()` calls.
afterEach(() => {
  vi.restoreAllMocks()
})
import {
  bumpPrReviewCounter,
  buildReviewCounterKey,
  buildPrUrl,
  preparePrReviewCounter,
} from "@/lib/pr-review-counter"
import type { Env } from "@/shared/types/env"

interface MockKv {
  store: Map<string, string>
  asEnv: KVNamespace
}

function makeKv(seed: Record<string, string> = {}): MockKv {
  const store = new Map<string, string>(Object.entries(seed))
  const asEnv = {
    get: async (key: string): Promise<string | null> => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
  } as unknown as KVNamespace
  return { store, asEnv }
}

function makeEnv(kv: MockKv): Env {
  return { OPENCLAW_STATE: kv.asEnv } as unknown as Env
}

const OWNER = "Arc-and-Anchor"
const REPO = "sigilix"
const PR = 42

describe("buildReviewCounterKey", () => {
  it("uses the documented shape", () => {
    expect(buildReviewCounterKey(OWNER, REPO, PR)).toBe("pr-review-counter:Arc-and-Anchor/sigilix#42")
  })
})

describe("buildPrUrl", () => {
  it("constructs the github.com PR URL", () => {
    expect(buildPrUrl(OWNER, REPO, PR)).toBe("https://github.com/Arc-and-Anchor/sigilix/pull/42")
  })
})

describe("bumpPrReviewCounter", () => {
  it("returns 1 on the very first review (no prior KV state)", async () => {
    const kv = makeKv()
    const next = await bumpPrReviewCounter(makeEnv(kv), OWNER, REPO, PR)
    expect(next).toBe(1)
    expect(kv.store.get("pr-review-counter:Arc-and-Anchor/sigilix#42")).toBe("1")
  })

  it("increments the prior counter", async () => {
    const kv = makeKv({ "pr-review-counter:Arc-and-Anchor/sigilix#42": "5" })
    const next = await bumpPrReviewCounter(makeEnv(kv), OWNER, REPO, PR)
    expect(next).toBe(6)
    expect(kv.store.get("pr-review-counter:Arc-and-Anchor/sigilix#42")).toBe("6")
  })

  it("treats a garbage KV value as 0 (defensive parse)", async () => {
    const kv = makeKv({ "pr-review-counter:Arc-and-Anchor/sigilix#42": "not-a-number" })
    const next = await bumpPrReviewCounter(makeEnv(kv), OWNER, REPO, PR)
    expect(next).toBe(1)
  })

  it("treats a negative KV value as 0 (defensive parse)", async () => {
    const kv = makeKv({ "pr-review-counter:Arc-and-Anchor/sigilix#42": "-5" })
    const next = await bumpPrReviewCounter(makeEnv(kv), OWNER, REPO, PR)
    expect(next).toBe(1)
  })

  it("returns 1 when KV.get throws (best-effort fallback)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const putMock = vi.fn(async () => {})
    const env = {
      OPENCLAW_STATE: {
        get: async () => { throw new Error("KV get boom") },
        put: putMock,
        delete: async () => {},
      } as unknown as KVNamespace,
    } as unknown as Env
    const next = await bumpPrReviewCounter(env, OWNER, REPO, PR)
    expect(next).toBe(1)
    expect(console.warn).toHaveBeenCalled()
    // CodeRabbit catch on PR #110: when the read fails, the
    // bump must NOT write the synthetic `1` back — that would
    // clobber the real persisted counter once KV recovers.
    expect(putMock).not.toHaveBeenCalled()
  })

  it("returns the bumped value even when KV.put throws (best-effort persistence)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const env = {
      OPENCLAW_STATE: {
        get: async () => "9",
        put: async () => { throw new Error("KV put boom") },
        delete: async () => {},
      } as unknown as KVNamespace,
    } as unknown as Env
    const next = await bumpPrReviewCounter(env, OWNER, REPO, PR)
    expect(next).toBe(10)
    expect(console.warn).toHaveBeenCalled()
  })

  it("two sequential bumps produce N → N+1 → N+2", async () => {
    const kv = makeKv()
    const a = await bumpPrReviewCounter(makeEnv(kv), OWNER, REPO, PR)
    const b = await bumpPrReviewCounter(makeEnv(kv), OWNER, REPO, PR)
    const c = await bumpPrReviewCounter(makeEnv(kv), OWNER, REPO, PR)
    expect([a, b, c]).toEqual([1, 2, 3])
  })

  it("uses a distinct counter per (owner, repo, prNumber)", async () => {
    const kv = makeKv()
    const env = makeEnv(kv)
    await bumpPrReviewCounter(env, "a", "x", 1)
    await bumpPrReviewCounter(env, "a", "x", 1)
    await bumpPrReviewCounter(env, "a", "x", 2)
    expect(kv.store.get("pr-review-counter:a/x#1")).toBe("2")
    expect(kv.store.get("pr-review-counter:a/x#2")).toBe("1")
  })
})

describe("preparePrReviewCounter", () => {
  it("returns the next visible value without writing until persist is called", async () => {
    const kv = makeKv({ "pr-review-counter:Arc-and-Anchor/sigilix#42": "2" })
    const prepared = await preparePrReviewCounter(makeEnv(kv), OWNER, REPO, PR)

    expect(prepared.value).toBe(3)
    expect(kv.store.get("pr-review-counter:Arc-and-Anchor/sigilix#42")).toBe("2")

    await prepared.persist()
    expect(kv.store.get("pr-review-counter:Arc-and-Anchor/sigilix#42")).toBe("3")
  })

  it("makes persist idempotent", async () => {
    const kv = makeKv()
    const prepared = await preparePrReviewCounter(makeEnv(kv), OWNER, REPO, PR)

    await prepared.persist()
    await prepared.persist()

    expect(kv.store.get("pr-review-counter:Arc-and-Anchor/sigilix#42")).toBe("1")
  })

  it("does not write the synthetic value when the read failed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const putMock = vi.fn(async () => {})
    const env = {
      OPENCLAW_STATE: {
        get: async () => { throw new Error("KV get boom") },
        put: putMock,
        delete: async () => {},
      } as unknown as KVNamespace,
    } as unknown as Env

    const prepared = await preparePrReviewCounter(env, OWNER, REPO, PR)
    await prepared.persist()

    expect(prepared.value).toBe(1)
    expect(putMock).not.toHaveBeenCalled()
  })
})
