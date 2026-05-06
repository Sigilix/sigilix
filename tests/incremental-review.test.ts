// ARC-194 — incremental review: KV serdes + diff selection.

import { describe, it, expect, vi } from "vitest"

import {
  readLastReviewedSha,
  writeLastReviewedSha,
  selectDiff,
} from "../src/lib/incremental-review"
import type { Env } from "../src/index"

// Minimal KV stub — only the get/put surface we exercise. Cast through
// `unknown` to avoid pulling in the full Workers types.
function fakeKV(initial: Record<string, string> = {}) {
  const store = { ...initial }
  const stub = {
    get: vi.fn(async (k: string) => store[k] ?? null),
    put: vi.fn(async (k: string, v: string, _opts?: unknown) => {
      store[k] = v
    }),
    delete: vi.fn(async (k: string) => {
      delete store[k]
    }),
  }
  return { stub, store }
}

const fakeEnv = (kv: ReturnType<typeof fakeKV>["stub"]): Env =>
  ({ OPENCLAW_STATE: kv } as unknown as Env)

describe("readLastReviewedSha", () => {
  it("returns null for unknown PR", async () => {
    const { stub } = fakeKV()
    const result = await readLastReviewedSha(fakeEnv(stub), "o", "r", 1)
    expect(result).toBeNull()
  })

  it("returns the parsed record on hit", async () => {
    const { stub } = fakeKV({
      "pr-last-reviewed:owner/repo#42": JSON.stringify({
        reviewedSha: "abc1234",
        reviewedAt: 1700000000000,
      }),
    })
    const result = await readLastReviewedSha(fakeEnv(stub), "owner", "repo", 42)
    expect(result).toEqual({ reviewedSha: "abc1234", reviewedAt: 1700000000000 })
  })

  it("returns null on malformed JSON", async () => {
    const { stub } = fakeKV({ "pr-last-reviewed:o/r#1": "{not json" })
    expect(await readLastReviewedSha(fakeEnv(stub), "o", "r", 1)).toBeNull()
  })

  it("returns null when reviewedSha is missing/wrong type", async () => {
    const { stub } = fakeKV({
      "pr-last-reviewed:o/r#1": JSON.stringify({ reviewedAt: 123 }),
    })
    expect(await readLastReviewedSha(fakeEnv(stub), "o", "r", 1)).toBeNull()
  })

  it("returns null when reviewedAt is missing/wrong type", async () => {
    const { stub } = fakeKV({
      "pr-last-reviewed:o/r#1": JSON.stringify({ reviewedSha: "abc" }),
    })
    expect(await readLastReviewedSha(fakeEnv(stub), "o", "r", 1)).toBeNull()
  })

  it("returns null when KV throws", async () => {
    const stub = {
      get: vi.fn(async () => { throw new Error("KV down") }),
      put: vi.fn(),
      delete: vi.fn(),
    }
    expect(await readLastReviewedSha(fakeEnv(stub), "o", "r", 1)).toBeNull()
  })
})

describe("writeLastReviewedSha", () => {
  it("writes a JSON-encoded record with the right key", async () => {
    const { stub, store } = fakeKV()
    await writeLastReviewedSha(fakeEnv(stub), "owner", "repo", 42, "abc1234")
    const stored = store["pr-last-reviewed:owner/repo#42"]
    expect(stored).toBeDefined()
    if (!stored) return  // narrows for TS
    const parsed = JSON.parse(stored)
    expect(parsed.reviewedSha).toBe("abc1234")
    expect(typeof parsed.reviewedAt).toBe("number")
  })

  it("passes the 30-day TTL", async () => {
    const { stub } = fakeKV()
    await writeLastReviewedSha(fakeEnv(stub), "o", "r", 1, "abc")
    expect(stub.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ expirationTtl: 30 * 24 * 60 * 60 }),
    )
  })

  it("swallows KV errors silently (best-effort write)", async () => {
    const stub = {
      get: vi.fn(),
      put: vi.fn(async () => { throw new Error("KV down") }),
      delete: vi.fn(),
    }
    // Should not throw.
    await expect(
      writeLastReviewedSha(fakeEnv(stub), "o", "r", 1, "abc"),
    ).resolves.toBeUndefined()
  })
})

describe("selectDiff — first review", () => {
  it("returns full diff with mode=first-review when no previous SHA", () => {
    const result = selectDiff({
      fullDiff: "full",
      compareDiff: null,
      previousSha: null,
      currentHeadSha: "abc",
    })
    expect(result).toEqual({ diff: "full", mode: "first-review" })
  })
})

describe("selectDiff — incremental path", () => {
  it("returns compare diff when smaller than full and SHA differs", () => {
    const result = selectDiff({
      fullDiff: "x".repeat(1000),
      compareDiff: "x".repeat(100),
      previousSha: "old",
      currentHeadSha: "new",
    })
    expect(result.mode).toBe("incremental")
    expect(result.previousSha).toBe("old")
    expect(result.diff.length).toBe(100)
    expect(result.reason).toBeUndefined()
  })
})

describe("selectDiff — fall-back paths", () => {
  it("falls back to full when previous SHA == current", () => {
    const result = selectDiff({
      fullDiff: "full",
      compareDiff: "compare",
      previousSha: "abc",
      currentHeadSha: "abc",
    })
    expect(result.mode).toBe("full")
    expect(result.diff).toBe("full")
    expect(result.reason).toBe("same_sha")
  })

  it("falls back to full when compareDiff is null (fetch failed)", () => {
    const result = selectDiff({
      fullDiff: "full",
      compareDiff: null,
      previousSha: "old",
      currentHeadSha: "new",
    })
    expect(result.mode).toBe("full")
    expect(result.reason).toBe("compare_fetch_failed")
  })

  it("falls back to full when compareDiff is empty", () => {
    const result = selectDiff({
      fullDiff: "full",
      compareDiff: "",
      previousSha: "old",
      currentHeadSha: "new",
    })
    expect(result.mode).toBe("full")
    expect(result.reason).toBe("compare_empty")
  })

  it("falls back to full when compare is too large (force-push case)", () => {
    // Compare diff > 0.9 × full → suspicious. Use full.
    const result = selectDiff({
      fullDiff: "x".repeat(100),
      compareDiff: "x".repeat(95),
      previousSha: "old",
      currentHeadSha: "new",
    })
    expect(result.mode).toBe("full")
    expect(result.reason).toBe("compare_not_smaller")
  })
})
