// ARC-235 — tests for the repo-index-manifest KV module.
//
// Covers serdes (`readRepoIndexManifest`, `writeRepoIndexManifest`),
// freshness validation (`isManifestFresh`), and key normalization
// (`repoIndexManifestKey`).

import { describe, expect, it } from "vitest"
import {
  indexNamespace,
  isManifestFresh,
  legacyRepoIndexManifestKey,
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

describe("indexNamespace", () => {
  it("lowercases owner + repo and joins with a slash", () => {
    expect(indexNamespace("Arc-and-Anchor", "Sigilix")).toBe("arc-and-anchor/sigilix")
    expect(indexNamespace("ACME", "API")).toBe("acme/api")
    expect(indexNamespace("acme", "api")).toBe("acme/api")
  })
})

describe("repoIndexManifestKey", () => {
  it("keys by the lowercased <owner>/<repo> namespace", () => {
    expect(repoIndexManifestKey("Arc-and-Anchor", "SIGILIX")).toBe(
      "repo-index-manifest:arc-and-anchor/sigilix",
    )
    expect(repoIndexManifestKey("acme", "api")).toBe("repo-index-manifest:acme/api")
  })
})

describe("legacyRepoIndexManifestKey", () => {
  it("keys by the bare lowercased repo (pre-SIG-132 shape)", () => {
    expect(legacyRepoIndexManifestKey("SIGILIX")).toBe("repo-index-manifest:sigilix")
    expect(legacyRepoIndexManifestKey("api")).toBe("repo-index-manifest:api")
  })
})

describe("writeRepoIndexManifest / readRepoIndexManifest round-trip", () => {
  it("round-trips a valid manifest under the <owner>/<repo> key", async () => {
    const { kv, store } = makeKvStub()
    await writeRepoIndexManifest(makeEnv(kv), SAMPLE_MANIFEST)
    expect(store.has("repo-index-manifest:arc-and-anchor/sigilix")).toBe(true)

    const result = await readRepoIndexManifest(makeEnv(kv), "Arc-and-Anchor", "Sigilix")
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.manifest).toEqual(SAMPLE_MANIFEST)
    }
  })

  it("returns missing when no record exists", async () => {
    const { kv } = makeKvStub()
    const result = await readRepoIndexManifest(makeEnv(kv), "Arc-and-Anchor", "nothing")
    expect(result.kind).toBe("missing")
  })

  it("returns invalid/json-parse for non-JSON garbage", async () => {
    const { kv, store } = makeKvStub()
    store.set("repo-index-manifest:arc-and-anchor/sigilix", "{not json")
    const result = await readRepoIndexManifest(makeEnv(kv), "Arc-and-Anchor", "sigilix")
    expect(result.kind).toBe("invalid")
    if (result.kind === "invalid") {
      expect(result.reason).toBe("json-parse")
    }
  })

  it("returns invalid/wrong-version for a v0 (or otherwise mismatched) record", async () => {
    const { kv, store } = makeKvStub()
    store.set(
      "repo-index-manifest:arc-and-anchor/sigilix",
      JSON.stringify({ ...SAMPLE_MANIFEST, v: 2 }),
    )
    const result = await readRepoIndexManifest(makeEnv(kv), "Arc-and-Anchor", "sigilix")
    expect(result.kind).toBe("invalid")
    if (result.kind === "invalid") {
      expect(result.reason).toBe("wrong-version")
    }
  })

  it("returns invalid/shape when a required field is missing", async () => {
    const { kv, store } = makeKvStub()
    const broken = { ...SAMPLE_MANIFEST } as Partial<RepoIndexManifestV1>
    delete broken.headSha
    store.set("repo-index-manifest:arc-and-anchor/sigilix", JSON.stringify(broken))
    const result = await readRepoIndexManifest(makeEnv(kv), "Arc-and-Anchor", "sigilix")
    expect(result.kind).toBe("invalid")
    if (result.kind === "invalid") {
      expect(result.reason).toBe("shape")
    }
  })

  it("writeRepoIndexManifest propagates the KV.put error (SIG-156 PR3 hardening)", async () => {
    // Was best-effort (caught + returned false), leaving vectors written
    // with no manifest → repo undiscoverable + push won't bootstrap.
    // Now: throw → consumer aborts → queue retries the shard.
    const env = {
      OPENCLAW_STATE: {
        get: async () => null,
        put: async () => {
          throw new Error("KV down")
        },
        delete: async () => {},
      },
    } as unknown as Env
    await expect(writeRepoIndexManifest(env, SAMPLE_MANIFEST)).rejects.toThrow("KV down")
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
