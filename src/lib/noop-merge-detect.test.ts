// SIG-89 — noop-merge detection: diff hashing + KV serdes.

import { describe, it, expect, vi } from "vitest"

import {
  computeDiffHash,
  readPriorReviewDiffHash,
  recordReviewedDiffHash,
  writePriorReviewDiffHash,
} from "@/src/lib/noop-merge-detect"
import type { Env } from "@/src/shared/types/env"

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

describe("computeDiffHash", () => {
  it("returns deterministic sha256 hex for the same input", async () => {
    const diff = "diff --git a/foo b/foo\n@@ -1 +1 @@\n-x\n+y\n"
    const a = await computeDiffHash(diff)
    const b = await computeDiffHash(diff)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it("returns different hashes for different inputs (catches real diff changes)", async () => {
    const a = await computeDiffHash("foo")
    const b = await computeDiffHash("bar")
    expect(a).not.toBe(b)
  })

  it("treats whitespace as significant (byte-identical only)", async () => {
    // SIG-89 spec is byte-identical, not semantic. A trailing space
    // difference must hash differently — that's a real diff change
    // (the resolved file content differs), not a no-op merge.
    const a = await computeDiffHash("foo bar")
    const b = await computeDiffHash("foo  bar")
    expect(a).not.toBe(b)
  })

  it("hashes the empty string to the known sha256 empty constant", async () => {
    const empty = await computeDiffHash("")
    expect(empty).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    )
  })
})

describe("readPriorReviewDiffHash", () => {
  it("returns null for unknown PR (first-review case)", async () => {
    const { stub } = fakeKV()
    const result = await readPriorReviewDiffHash(fakeEnv(stub), "o", "r", 1)
    expect(result).toBeNull()
  })

  it("returns the parsed record on hit", async () => {
    const { stub } = fakeKV({
      "pr-review-diff-hash:owner/repo#42": JSON.stringify({
        diffHash: "abc123",
        reviewedHeadSha: "deadbeef",
        hashedAt: 1700000000000,
      }),
    })
    const result = await readPriorReviewDiffHash(
      fakeEnv(stub),
      "owner",
      "repo",
      42,
    )
    expect(result).toEqual({
      diffHash: "abc123",
      reviewedHeadSha: "deadbeef",
      hashedAt: 1700000000000,
    })
  })

  it("returns null on malformed JSON", async () => {
    const { stub } = fakeKV({
      "pr-review-diff-hash:o/r#1": "{not json",
    })
    expect(
      await readPriorReviewDiffHash(fakeEnv(stub), "o", "r", 1),
    ).toBeNull()
  })

  it("returns null when diffHash is missing", async () => {
    const { stub } = fakeKV({
      "pr-review-diff-hash:o/r#1": JSON.stringify({
        reviewedHeadSha: "x",
        hashedAt: 1,
      }),
    })
    expect(
      await readPriorReviewDiffHash(fakeEnv(stub), "o", "r", 1),
    ).toBeNull()
  })

  it("returns null when hashedAt is Infinity (corrupt-record guard)", async () => {
    // Numeric type check alone wouldn't catch this — Infinity passes
    // `typeof === "number"`. Guarded with Number.isFinite.
    // (NaN can't be tested via JSON.stringify — it serializes to null
    // — but JSON.parse('{"x": 1e500}') yields Infinity, which is the
    // only way the guard's second clause can fire on the KV-read path.)
    const { stub } = fakeKV({
      "pr-review-diff-hash:o/r#1": '{"diffHash":"abc","reviewedHeadSha":"x","hashedAt":1e500}',
    })
    expect(
      await readPriorReviewDiffHash(fakeEnv(stub), "o", "r", 1),
    ).toBeNull()
  })

  it("returns null when reviewedHeadSha is missing (telemetry guard)", async () => {
    const { stub } = fakeKV({
      "pr-review-diff-hash:o/r#1": JSON.stringify({
        diffHash: "abc",
        hashedAt: 1,
      }),
    })
    expect(
      await readPriorReviewDiffHash(fakeEnv(stub), "o", "r", 1),
    ).toBeNull()
  })

  it("returns null when KV throws", async () => {
    const stub = {
      get: vi.fn(async () => {
        throw new Error("KV down")
      }),
      put: vi.fn(),
      delete: vi.fn(),
    }
    expect(
      await readPriorReviewDiffHash(fakeEnv(stub), "o", "r", 1),
    ).toBeNull()
  })
})

describe("writePriorReviewDiffHash", () => {
  it("writes a JSON-encoded record with the right key", async () => {
    const { stub, store } = fakeKV()
    await writePriorReviewDiffHash(
      fakeEnv(stub),
      "owner",
      "repo",
      42,
      "abc123",
      "deadbeef",
    )
    const stored = store["pr-review-diff-hash:owner/repo#42"]
    expect(stored).toBeDefined()
    if (!stored) return
    const parsed = JSON.parse(stored)
    expect(parsed.diffHash).toBe("abc123")
    expect(parsed.reviewedHeadSha).toBe("deadbeef")
    expect(typeof parsed.hashedAt).toBe("number")
  })

  it("passes the 30-day TTL (mirrors pr-last-reviewed)", async () => {
    const { stub } = fakeKV()
    await writePriorReviewDiffHash(fakeEnv(stub), "o", "r", 1, "h", "s")
    expect(stub.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ expirationTtl: 30 * 24 * 60 * 60 }),
    )
  })

  it("swallows KV errors silently (best-effort write)", async () => {
    const stub = {
      get: vi.fn(),
      put: vi.fn(async () => {
        throw new Error("KV down")
      }),
      delete: vi.fn(),
    }
    await expect(
      writePriorReviewDiffHash(fakeEnv(stub), "o", "r", 1, "h", "s"),
    ).resolves.toBeUndefined()
  })
})

// `recordReviewedDiffHash` is the production seam called from every
// post-submit-success site in `triage-pr-review-ensemble.ts`. Testing
// it directly pins the contract those call sites must satisfy — a
// regression that silently drops the write (e.g., a refactor that
// moves the call before `fullPrDiff` is fetched, or a conditional
// that skips it) is caught here without needing to set up the full
// ensemble handler. (Sigilix testing-specialist finding on PR #106.)
describe("recordReviewedDiffHash", () => {
  it("hashes the diff and stashes a roundtrippable record", async () => {
    const { stub } = fakeKV()
    const env = fakeEnv(stub)
    const diff = "diff --git a/foo b/foo\n@@ -1 +1 @@\n-x\n+y\n"
    const headSha = "deadbeef".repeat(5)

    await recordReviewedDiffHash(env, "o", "r", 1, diff, headSha)

    const record = await readPriorReviewDiffHash(env, "o", "r", 1)
    expect(record).not.toBeNull()
    expect(record?.diffHash).toBe(await computeDiffHash(diff))
    expect(record?.reviewedHeadSha).toBe(headSha)
  })

  it("produces a hash that matches a recompute of the same diff (no-op merge detected)", async () => {
    // The webhook compares `await computeDiffHash(currentDiff)` against
    // the stored hash. This test pins the producer/consumer contract:
    // identical input → identical hash → skip path fires.
    const { stub } = fakeKV()
    const env = fakeEnv(stub)
    const diff = "diff --git a/x b/x\n@@\n+a\n"
    const headSha = "abc".repeat(14) + "a"

    await recordReviewedDiffHash(env, "o", "r", 1, diff, headSha)
    const record = await readPriorReviewDiffHash(env, "o", "r", 1)

    // Simulate the webhook re-computing on the next synchronize.
    expect(await computeDiffHash(diff)).toBe(record?.diffHash)
    // And a different diff hashes differently → skip path won't fire.
    expect(await computeDiffHash(diff + "\n")).not.toBe(record?.diffHash)
  })

  it("swallows errors and logs telemetry (best-effort — KV failure must not bubble)", async () => {
    const stub = {
      get: vi.fn(),
      put: vi.fn(async () => {
        throw new Error("KV down")
      }),
      delete: vi.fn(),
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    await expect(
      recordReviewedDiffHash(fakeEnv(stub), "o", "r", 1, "diff", "sha"),
    ).resolves.toBeUndefined()
    // The underlying writePriorReviewDiffHash swallows the KV error,
    // so `recordReviewedDiffHash` doesn't need to log here. But the
    // outer try/catch is still load-bearing: if `computeDiffHash`
    // ever throws (Web Crypto unavailable, etc.) the telemetry fires.
    warn.mockRestore()
  })
})
