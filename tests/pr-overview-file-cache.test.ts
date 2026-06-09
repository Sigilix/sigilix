// ARC-263 — tests for the per-file walkthrough cache.
//
// Pure-helper tests over `buildCacheKey`, `readFileCache`,
// `writeFileCache`, `batchReadFileCache`, `batchWriteFileCache`.
// Cache integration with `handlePrOverview` is exercised via the
// race test plus a focused merge/scoped-diff test in
// `triage-pr-overview.test.ts`.

import { describe, expect, it, vi } from "vitest"

import {
  buildCacheKey,
  batchReadFileCache,
  batchWriteFileCache,
  readFileCache,
  writeFileCache,
  type CachedFileRow,
} from "../src/lib/pr-overview-file-cache"
import type { Env } from "../src/shared/types/env"

function makeKvStub(): { kv: Env["OPENCLAW_STATE"]; store: Map<string, string> } {
  const store = new Map<string, string>()
  const kv = {
    async get(key: string): Promise<string | null> { return store.get(key) ?? null },
    async put(key: string, value: string): Promise<void> { store.set(key, value) },
    async delete(key: string): Promise<void> { store.delete(key) },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store }
}

function makeEnv(kv: Env["OPENCLAW_STATE"]): Env {
  return { OPENCLAW_STATE: kv } as unknown as Env
}

const sampleRow: CachedFileRow = {
  path: "src/foo.ts",
  score: 4,
  overview: "Adds a guard clause.",
  nextStep: "Add a fuzz test.",
}

describe("buildCacheKey", () => {
  it("normalizes owner/repo to lowercase and includes both hashes", async () => {
    const key = await buildCacheKey({
      owner: "Arc-and-Anchor", repo: "Sigilix", prNumber: 42,
      filename: "src/foo.ts", patch: "@@ -1 +1 @@\n-old\n+new",
    })
    expect(key.startsWith("pr-overview-file-cache:arc-and-anchor/sigilix#42:")).toBe(true)
    // Two SHA-256 hex hashes (24 chars each) separated by ":"
    const tail = key.split("#42:")[1]!
    const [pathHash, patchHash] = tail.split(":")
    expect(pathHash).toMatch(/^[0-9a-f]{24}$/)
    expect(patchHash).toMatch(/^[0-9a-f]{24}$/)
  })

  it("different filenames at the same patch → different keys", async () => {
    const a = await buildCacheKey({
      owner: "o", repo: "r", prNumber: 1, filename: "a.ts", patch: "X",
    })
    const b = await buildCacheKey({
      owner: "o", repo: "r", prNumber: 1, filename: "b.ts", patch: "X",
    })
    expect(a).not.toBe(b)
  })

  it("same filename + same patch → same key (idempotent)", async () => {
    const a = await buildCacheKey({
      owner: "o", repo: "r", prNumber: 1, filename: "a.ts", patch: "X",
    })
    const b = await buildCacheKey({
      owner: "o", repo: "r", prNumber: 1, filename: "a.ts", patch: "X",
    })
    expect(a).toBe(b)
  })
})

describe("readFileCache / writeFileCache round-trip", () => {
  it("writes then reads back the same row", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv)
    await writeFileCache({
      env, owner: "o", repo: "r", prNumber: 1,
      filename: "src/foo.ts", patch: "P", row: sampleRow,
    })
    expect(store.size).toBe(1)
    const out = await readFileCache({
      env, owner: "o", repo: "r", prNumber: 1,
      filename: "src/foo.ts", patch: "P",
    })
    expect(out).toEqual(sampleRow)
  })

  it("returns null on cache miss", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    const out = await readFileCache({
      env, owner: "o", repo: "r", prNumber: 1,
      filename: "missing.ts", patch: "P",
    })
    expect(out).toBeNull()
  })

  it("returns null (no throw) when KV.get rejects", async () => {
    const errSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const env = {
      OPENCLAW_STATE: {
        async get(): Promise<string | null> { throw new Error("KV outage") },
        async put(): Promise<void> { /* unreached */ },
        async delete(): Promise<void> { /* unreached */ },
      },
    } as unknown as Env
    const out = await readFileCache({
      env, owner: "o", repo: "r", prNumber: 1,
      filename: "x.ts", patch: "P",
    })
    expect(out).toBeNull()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("returns null when cached payload is malformed JSON", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv)
    const key = await buildCacheKey({
      owner: "o", repo: "r", prNumber: 1, filename: "x.ts", patch: "P",
    })
    store.set(key, "not json")
    const out = await readFileCache({
      env, owner: "o", repo: "r", prNumber: 1, filename: "x.ts", patch: "P",
    })
    expect(out).toBeNull()
  })

  it("returns null when cached payload is JSON but wrong shape", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv)
    const key = await buildCacheKey({
      owner: "o", repo: "r", prNumber: 1, filename: "x.ts", patch: "P",
    })
    store.set(key, JSON.stringify({ path: "x.ts" })) // missing score/overview/nextStep
    const out = await readFileCache({
      env, owner: "o", repo: "r", prNumber: 1, filename: "x.ts", patch: "P",
    })
    expect(out).toBeNull()
  })

  it("swallows KV.put failures (best-effort)", async () => {
    const errSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const env = {
      OPENCLAW_STATE: {
        async get(): Promise<string | null> { return null },
        async put(): Promise<void> { throw new Error("KV write outage") },
        async delete(): Promise<void> { /* unreached */ },
      },
    } as unknown as Env
    await expect(writeFileCache({
      env, owner: "o", repo: "r", prNumber: 1,
      filename: "x.ts", patch: "P", row: sampleRow,
    })).resolves.toBeUndefined()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe("batchReadFileCache", () => {
  it("partitions files into hits and misses based on cached state", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    // Pre-populate cache for two of three files.
    await writeFileCache({
      env, owner: "o", repo: "r", prNumber: 1,
      filename: "a.ts", patch: "PA", row: { ...sampleRow, path: "a.ts" },
    })
    await writeFileCache({
      env, owner: "o", repo: "r", prNumber: 1,
      filename: "c.ts", patch: "PC", row: { ...sampleRow, path: "c.ts" },
    })

    const { hits, misses } = await batchReadFileCache({
      env, owner: "o", repo: "r", prNumber: 1,
      files: [
        { filename: "a.ts", patch: "PA" },
        { filename: "b.ts", patch: "PB" },
        { filename: "c.ts", patch: "PC" },
      ],
    })

    expect(hits.size).toBe(2)
    expect(hits.get("a.ts")?.path).toBe("a.ts")
    expect(hits.get("c.ts")?.path).toBe("c.ts")
    expect(misses).toHaveLength(1)
    expect(misses[0]?.filename).toBe("b.ts")
  })

  it("treats files without a patch (binary / >500KB) as misses", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    const { hits, misses } = await batchReadFileCache({
      env, owner: "o", repo: "r", prNumber: 1,
      files: [
        { filename: "binary.png" }, // no patch
        { filename: "huge.lock", patch: "" }, // empty patch
      ],
    })
    expect(hits.size).toBe(0)
    expect(misses).toHaveLength(2)
  })
})

describe("batchWriteFileCache", () => {
  it("writes a cache entry for each miss whose path appears in fresh rows", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv)
    const result = await batchWriteFileCache({
      env, owner: "o", repo: "r", prNumber: 1,
      misses: [
        { filename: "a.ts", patch: "PA" },
        { filename: "b.ts", patch: "PB" },
      ],
      rows: [
        { ...sampleRow, path: "a.ts" },
        { ...sampleRow, path: "b.ts" },
      ],
    })
    expect(result.written).toBe(2)
    expect(store.size).toBe(2)
  })

  it("skips misses whose path isn't in the fresh rows (model didn't emit a row)", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv)
    const result = await batchWriteFileCache({
      env, owner: "o", repo: "r", prNumber: 1,
      misses: [
        { filename: "a.ts", patch: "PA" },
        { filename: "b.ts", patch: "PB" },
      ],
      rows: [{ ...sampleRow, path: "a.ts" }],
    })
    expect(result.written).toBe(1)
    expect(store.size).toBe(1)
  })

  it("skips misses without a patch", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv)
    const result = await batchWriteFileCache({
      env, owner: "o", repo: "r", prNumber: 1,
      misses: [{ filename: "binary.png" }],
      rows: [{ ...sampleRow, path: "binary.png" }],
    })
    expect(result.written).toBe(0)
    expect(store.size).toBe(0)
  })
})
