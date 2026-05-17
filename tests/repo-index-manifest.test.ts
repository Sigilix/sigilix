// ARC-235 — tests for the repo-index-manifest KV module.
//
// Covers serdes (`readRepoIndexManifest`, `writeRepoIndexManifest`),
// freshness validation (`isManifestFresh`), and key normalization
// (`repoIndexManifestKey`).

import { describe, expect, it } from "vitest"
import {
  isManifestFresh,
  readRepoIndexManifest,
  repoIndexManifestKey,
  writeRepoIndexManifest,
  type RepoIndexManifestV1,
} from "../src/lib/repo-index-manifest"
import type { Env } from "../src/index"

function makeKvStub(): {
  kv: Env["OPENCLAW_STATE"]
  store: Map<string, string>
} {
  const store = new Map<string, string>()
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value)
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store }
}

function makeEnv(kv: Env["OPENCLAW_STATE"]): Env {
  return { OPENCLAW_STATE: kv } as unknown as Env
}

const SAMPLE_MANIFEST: RepoIndexManifestV1 = {
  v: 1,
  repo: "sigilix",
  owner: "Arc-and-Anchor",
  headSha: "a".repeat(40),
  runId: "0123456789abcdef",
  fileCount: 42,
  chunkCount: 420,
  shardCount: 1,
  indexedAt: "2026-05-17T00:00:00.000Z",
  modelId: "@cf/baai/bge-base-en-v1.5",
  embeddingDim: 768,
  chunkerVersion: 1,
  windowLines: 30,
  overlapLines: 10,
}

describe("repoIndexManifestKey", () => {
  it("lowercases the repo segment", () => {
    expect(repoIndexManifestKey("SIGILIX")).toBe("repo-index-manifest:sigilix")
    expect(repoIndexManifestKey("Sigilix")).toBe("repo-index-manifest:sigilix")
    expect(repoIndexManifestKey("rubberfit")).toBe("repo-index-manifest:rubberfit")
  })
})

describe("writeRepoIndexManifest / readRepoIndexManifest round-trip", () => {
  it("round-trips a valid manifest under the lowercased key", async () => {
    const { kv, store } = makeKvStub()
    const ok = await writeRepoIndexManifest(makeEnv(kv), SAMPLE_MANIFEST)
    expect(ok).toBe(true)
    expect(store.has("repo-index-manifest:sigilix")).toBe(true)

    const result = await readRepoIndexManifest(makeEnv(kv), "Sigilix")
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.manifest).toEqual(SAMPLE_MANIFEST)
    }
  })

  it("returns missing when no record exists", async () => {
    const { kv } = makeKvStub()
    const result = await readRepoIndexManifest(makeEnv(kv), "nothing")
    expect(result.kind).toBe("missing")
  })

  it("returns invalid/json-parse for non-JSON garbage", async () => {
    const { kv, store } = makeKvStub()
    store.set("repo-index-manifest:sigilix", "{not json")
    const result = await readRepoIndexManifest(makeEnv(kv), "sigilix")
    expect(result.kind).toBe("invalid")
    if (result.kind === "invalid") {
      expect(result.reason).toBe("json-parse")
    }
  })

  it("returns invalid/wrong-version for a v0 (or otherwise mismatched) record", async () => {
    const { kv, store } = makeKvStub()
    store.set("repo-index-manifest:sigilix", JSON.stringify({ ...SAMPLE_MANIFEST, v: 2 }))
    const result = await readRepoIndexManifest(makeEnv(kv), "sigilix")
    expect(result.kind).toBe("invalid")
    if (result.kind === "invalid") {
      expect(result.reason).toBe("wrong-version")
    }
  })

  it("returns invalid/shape when a required field is missing", async () => {
    const { kv, store } = makeKvStub()
    const broken = { ...SAMPLE_MANIFEST } as Partial<RepoIndexManifestV1>
    delete broken.headSha
    store.set("repo-index-manifest:sigilix", JSON.stringify(broken))
    const result = await readRepoIndexManifest(makeEnv(kv), "sigilix")
    expect(result.kind).toBe("invalid")
    if (result.kind === "invalid") {
      expect(result.reason).toBe("shape")
    }
  })

  it("writeRepoIndexManifest returns false when KV.put throws", async () => {
    const env = {
      OPENCLAW_STATE: {
        get: async () => null,
        put: async () => {
          throw new Error("KV down")
        },
        delete: async () => {},
      },
    } as unknown as Env
    const ok = await writeRepoIndexManifest(env, SAMPLE_MANIFEST)
    expect(ok).toBe(false)
  })
})

describe("isManifestFresh", () => {
  const base = {
    manifest: SAMPLE_MANIFEST,
    currentHeadSha: SAMPLE_MANIFEST.headSha,
    currentOwner: SAMPLE_MANIFEST.owner,
    currentModelId: SAMPLE_MANIFEST.modelId,
    currentEmbeddingDim: SAMPLE_MANIFEST.embeddingDim,
    currentChunkerVersion: SAMPLE_MANIFEST.chunkerVersion,
  }

  it("returns true when every freshness field matches", () => {
    expect(isManifestFresh(base)).toBe(true)
  })

  it("returns false when headSha differs (the most common case)", () => {
    expect(isManifestFresh({ ...base, currentHeadSha: "b".repeat(40) })).toBe(false)
  })

  it("returns false when modelId differs (Workers AI rotation)", () => {
    expect(isManifestFresh({ ...base, currentModelId: "@cf/some-new-model" })).toBe(false)
  })

  it("returns false when chunkerVersion differs (chunker code bump)", () => {
    expect(isManifestFresh({ ...base, currentChunkerVersion: 2 })).toBe(false)
  })

  it("returns false when embeddingDim differs", () => {
    expect(isManifestFresh({ ...base, currentEmbeddingDim: 1024 })).toBe(false)
  })

  it("returns false when owner differs (same-named repo collision)", () => {
    expect(isManifestFresh({ ...base, currentOwner: "different-org" })).toBe(false)
  })
})
