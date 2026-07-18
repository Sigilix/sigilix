// ARC-235 — tests for the repo-index-manifest KV module.
//
// Covers serdes (`readRepoIndexManifest`, `writeRepoIndexManifest`),
// freshness validation (`isManifestFresh`), and key normalization
// (`repoIndexManifestKey`).

import { describe, expect, it, vi } from "vitest"
import {
  indexNamespace,
  isManifestFresh,
  legacyRepoIndexManifestKey,
  parseRepoIndexManifest,
  readRepoIndexManifest,
  repoIndexManifestKey,
  REPO_TENANT_PREFIX,
  repoTenantKey,
  writeRepoIndexManifest,
  type RepoIndexManifestV1,
} from "@/src/lib/repo-index-manifest"
import { CITATION_CHUNK_VERSION } from "@/src/lib/chunk-core"
import type { Env } from "@/src/shared/types/env"

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
  owner: "Sigilix",
  headSha: "a".repeat(40),
  runId: "0123456789abcdef",
  fileCount: 42,
  chunkCount: 420,
  shardCount: 1,
  indexedAt: "2026-05-17T00:00:00.000Z",
  modelId: "@cf/baai/bge-base-en-v1.5",
  embeddingDim: 768,
  chunkerVersion: 1,
  citationChunkVersion: CITATION_CHUNK_VERSION,
  windowLines: 30,
  overlapLines: 10,
}

const SAMPLE_ACTIVE_INDEX = {
  version: 1 as const,
  githubRepoId: 808247824,
  builtMode: "shadow" as const,
  byPath: {
    "src/a.ts": ["a".repeat(48), "b".repeat(48)],
    "src/b.ts": ["c".repeat(48)],
  },
}

describe("indexNamespace", () => {
  it("lowercases owner + repo and joins with a slash", () => {
    expect(indexNamespace("Sigilix", "Sigilix")).toBe("sigilix/sigilix")
    expect(indexNamespace("ACME", "API")).toBe("acme/api")
    expect(indexNamespace("acme", "api")).toBe("acme/api")
  })
})

describe("repoIndexManifestKey", () => {
  it("keys by the lowercased <owner>/<repo> namespace", () => {
    expect(repoIndexManifestKey("Sigilix", "SIGILIX")).toBe("repo-index-manifest:sigilix/sigilix")
    expect(repoIndexManifestKey("acme", "api")).toBe("repo-index-manifest:acme/api")
  })
})

describe("legacyRepoIndexManifestKey", () => {
  it("keys by the bare lowercased repo (pre-SIG-132 shape)", () => {
    expect(legacyRepoIndexManifestKey("SIGILIX")).toBe("repo-index-manifest:sigilix")
    expect(legacyRepoIndexManifestKey("api")).toBe("repo-index-manifest:api")
  })
})

describe("repoTenantKey (SIG-243 Phase 2)", () => {
  it("keys by the immutable GitHub repository ID", () => {
    expect(repoTenantKey(808247824)).toBe("repo-tenant:808247824")
    expect(repoTenantKey(1)).toBe("repo-tenant:1")
  })

  it("exports the prefix for KV-scan callers", () => {
    expect(REPO_TENANT_PREFIX).toBe("repo-tenant:")
  })
})

describe("writeRepoIndexManifest / readRepoIndexManifest round-trip", () => {
  it("round-trips a valid manifest under the <owner>/<repo> key", async () => {
    const { kv, store } = makeKvStub()
    await writeRepoIndexManifest(makeEnv(kv), SAMPLE_MANIFEST)
    expect(store.has("repo-index-manifest:sigilix/sigilix")).toBe(true)

    const result = await readRepoIndexManifest(makeEnv(kv), "Sigilix", "Sigilix")
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.manifest).toEqual(SAMPLE_MANIFEST)
    }
  })

  it("returns missing when no record exists", async () => {
    const { kv } = makeKvStub()
    const result = await readRepoIndexManifest(makeEnv(kv), "Sigilix", "nothing")
    expect(result.kind).toBe("missing")
  })

  it("returns invalid/json-parse for non-JSON garbage", async () => {
    const { kv, store } = makeKvStub()
    store.set("repo-index-manifest:sigilix/sigilix", "{not json")
    const result = await readRepoIndexManifest(makeEnv(kv), "Sigilix", "sigilix")
    expect(result.kind).toBe("invalid")
    if (result.kind === "invalid") {
      expect(result.reason).toBe("json-parse")
    }
  })

  it("returns invalid/wrong-version for a v0 (or otherwise mismatched) record", async () => {
    const { kv, store } = makeKvStub()
    store.set("repo-index-manifest:sigilix/sigilix", JSON.stringify({ ...SAMPLE_MANIFEST, v: 2 }))
    const result = await readRepoIndexManifest(makeEnv(kv), "Sigilix", "sigilix")
    expect(result.kind).toBe("invalid")
    if (result.kind === "invalid") {
      expect(result.reason).toBe("wrong-version")
    }
  })

  it("returns invalid/shape when a required field is missing", async () => {
    const { kv, store } = makeKvStub()
    const broken = { ...SAMPLE_MANIFEST } as Partial<RepoIndexManifestV1>
    delete broken.headSha
    store.set("repo-index-manifest:sigilix/sigilix", JSON.stringify(broken))
    const result = await readRepoIndexManifest(makeEnv(kv), "Sigilix", "sigilix")
    expect(result.kind).toBe("invalid")
    if (result.kind === "invalid") {
      expect(result.reason).toBe("shape")
    }
  })

  it("round-trips a manifest with githubRepoId set (SIG-243 Phase 1)", async () => {
    // SIG-243: optional immutable identifier added in Phase 1. Reads must
    // preserve it across the round trip so Phase 2 can dual-write under
    // the new repo-tenant:{id} key.
    const { kv } = makeKvStub()
    const withId: RepoIndexManifestV1 = { ...SAMPLE_MANIFEST, githubRepoId: 808247824 }
    await writeRepoIndexManifest(makeEnv(kv), withId)
    const result = await readRepoIndexManifest(makeEnv(kv), "Sigilix", "Sigilix")
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.manifest.githubRepoId).toBe(808247824)
      expect(result.manifest).toEqual(withId)
    }
  })

  it("reads a legacy manifest without githubRepoId as valid (additive field)", async () => {
    // SIG-243: githubRepoId is optional during Phase 1 + 2 so the
    // millions of existing manifests in production keep parsing.
    // Phase 3's backfill is what populates the field for legacy
    // records; until then, absence is legitimate.
    const { kv } = makeKvStub()
    await writeRepoIndexManifest(makeEnv(kv), SAMPLE_MANIFEST)
    const result = await readRepoIndexManifest(makeEnv(kv), "Sigilix", "Sigilix")
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.manifest.githubRepoId).toBeUndefined()
    }
  })

  it("round-trips the optional immutable active index", async () => {
    const { kv } = makeKvStub()
    const manifest = {
      ...SAMPLE_MANIFEST,
      githubRepoId: SAMPLE_ACTIVE_INDEX.githubRepoId,
      activeIndex: SAMPLE_ACTIVE_INDEX,
    } as RepoIndexManifestV1

    await writeRepoIndexManifest(makeEnv(kv), manifest)

    const result = await readRepoIndexManifest(makeEnv(kv), "Sigilix", "Sigilix")
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.manifest.activeIndex).toEqual(SAMPLE_ACTIVE_INDEX)
      expect(Object.getPrototypeOf(result.manifest.activeIndex?.byPath)).toBeNull()
    }
  })

  it("keeps legacy manifests without an active index valid", () => {
    const result = parseRepoIndexManifest(JSON.stringify(SAMPLE_MANIFEST))
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") expect(result.manifest.activeIndex).toBeUndefined()
  })

  it.each([
    ["wrong version", { ...SAMPLE_ACTIVE_INDEX, version: 2 }],
    ["unsafe repository id", { ...SAMPLE_ACTIVE_INDEX, githubRepoId: Number.MAX_SAFE_INTEGER + 1 }],
    ["unsupported build mode", { ...SAMPLE_ACTIVE_INDEX, builtMode: "off" }],
    ["array map", { ...SAMPLE_ACTIVE_INDEX, byPath: [] }],
    ["empty path", { ...SAMPLE_ACTIVE_INDEX, byPath: { "": ["a".repeat(48)] } }],
    ["NUL path", { ...SAMPLE_ACTIVE_INDEX, byPath: { "src/a\0.ts": ["a".repeat(48)] } }],
    ["non-array ids", { ...SAMPLE_ACTIVE_INDEX, byPath: { "src/a.ts": "a".repeat(48) } }],
    ["empty chunk id", { ...SAMPLE_ACTIVE_INDEX, byPath: { "src/a.ts": [""] } }],
    ["NUL chunk id", { ...SAMPLE_ACTIVE_INDEX, byPath: { "src/a.ts": [`${"a".repeat(24)}\0a`] } }],
    ["repository identity mismatch", { ...SAMPLE_ACTIVE_INDEX, githubRepoId: SAMPLE_ACTIVE_INDEX.githubRepoId + 1 }],
  ])("rejects an active index with %s", (_label, activeIndex) => {
    const result = parseRepoIndexManifest(JSON.stringify({ ...SAMPLE_MANIFEST, githubRepoId: 808247824, activeIndex }))
    expect(result).toEqual({ kind: "invalid", reason: "shape" })
  })

  it("rejects an unsafe top-level githubRepoId", () => {
    const result = parseRepoIndexManifest(
      JSON.stringify({ ...SAMPLE_MANIFEST, githubRepoId: Number.MAX_SAFE_INTEGER + 1 }),
    )
    expect(result).toEqual({ kind: "invalid", reason: "shape" })
  })

  it("dual-writes to the new repo-tenant:{id} key when githubRepoId is set (SIG-243 Phase 2)", async () => {
    // SIG-243: Phase 2's dual-write writes the SAME payload to both
    // the legacy `repo-index-manifest:owner/repo` key (unchanged)
    // AND the new `repo-tenant:{githubRepoId}` key. Phase 3 will
    // flip reads to the new key with the legacy as fallback.
    const { kv, store } = makeKvStub()
    const withId: RepoIndexManifestV1 = { ...SAMPLE_MANIFEST, githubRepoId: 808247824 }
    await writeRepoIndexManifest(makeEnv(kv), withId)
    expect(store.has("repo-index-manifest:sigilix/sigilix")).toBe(true)
    expect(store.has("repo-tenant:808247824")).toBe(true)

    // Both keys contain identical payloads — the new key isn't a
    // pointer; it's a sibling write so Phase 3's read-switch is a
    // pure code change with no data migration needed.
    const legacyValue = store.get("repo-index-manifest:sigilix/sigilix")
    const newValue = store.get("repo-tenant:808247824")
    expect(newValue).toBe(legacyValue)
  })

  it("does NOT write the repo-tenant:{id} key when githubRepoId is absent (legacy path)", async () => {
    // SIG-243: legacy manifests (without githubRepoId) only write to
    // the original key. Phase 3's admin backfill is what populates
    // the new key for these records by reading them, looking up the
    // repo ID via the GitHub API, and re-writing through this
    // writer with the ID set.
    const { kv, store } = makeKvStub()
    await writeRepoIndexManifest(makeEnv(kv), SAMPLE_MANIFEST)
    expect(store.has("repo-index-manifest:sigilix/sigilix")).toBe(true)
    const tenantKeys = [...store.keys()].filter((k) => k.startsWith("repo-tenant:"))
    expect(tenantKeys).toEqual([])
  })

  it("does NOT dual-write branch-scoped manifests to repo-tenant:{id} (CR PR #202 finding)", async () => {
    // SIG-243 Phase 2: the `repo-tenant:{id}` key does not carry
    // branch state. If a branch-scoped manifest dual-wrote there, it
    // would overwrite the canonical default-branch record for the
    // same repo. Phase 4 introduces branch-aware keying; until then,
    // branch manifests stay on the legacy key only.
    const { kv, store } = makeKvStub()
    const branchManifest: RepoIndexManifestV1 = {
      ...SAMPLE_MANIFEST,
      repo: "sigilix/__branch__/h646576",
      actualRepo: "sigilix",
      branch: "feature/something",
      githubRepoId: 808247824,
    }
    await writeRepoIndexManifest(makeEnv(kv), branchManifest)
    // Legacy key writes (branch state lives under the branch-state
    // namespace).
    expect(store.has("repo-index-manifest:sigilix/sigilix/__branch__/h646576")).toBe(true)
    // New key NOT written — would have stomped the default-branch
    // manifest for the same repo ID.
    expect(store.has("repo-tenant:808247824")).toBe(false)
  })

  it("does NOT dual-write when githubRepoId is zero (invalid GitHub repo ID)", async () => {
    // SIG-243: GitHub repository IDs are strictly positive integers.
    // A spoofed or malformed payload landing zero must not be
    // accepted at the writer — that would land an invalid
    // `repo-tenant:0` key in KV.
    const { kv, store } = makeKvStub()
    const zeroId = { ...SAMPLE_MANIFEST, githubRepoId: 0 } as RepoIndexManifestV1
    await writeRepoIndexManifest(makeEnv(kv), zeroId)
    expect(store.has("repo-tenant:0")).toBe(false)
  })

  it("does NOT dual-write when githubRepoId is negative", async () => {
    const { kv, store } = makeKvStub()
    const negativeId = { ...SAMPLE_MANIFEST, githubRepoId: -1 } as RepoIndexManifestV1
    await writeRepoIndexManifest(makeEnv(kv), negativeId)
    expect(store.has("repo-tenant:-1")).toBe(false)
  })

  it("does NOT dual-write when githubRepoId is a non-integer float", async () => {
    const { kv, store } = makeKvStub()
    const floatId = { ...SAMPLE_MANIFEST, githubRepoId: 808247824.5 } as RepoIndexManifestV1
    await writeRepoIndexManifest(makeEnv(kv), floatId)
    const tenantKeys = [...store.keys()].filter((k) => k.startsWith("repo-tenant:"))
    expect(tenantKeys).toEqual([])
  })

  it("rejects githubRepoId of wrong type (must be a positive integer when present)", async () => {
    // Defense-in-depth: stale or spoofed write paths landing a
    // non-positive-integer value would poison the new keying for
    // that repo. Validate the shape at read time.
    const { kv, store } = makeKvStub()
    const stringId = { ...SAMPLE_MANIFEST, githubRepoId: "not-a-number" }
    store.set("repo-index-manifest:sigilix/sigilix", JSON.stringify(stringId))
    const r1 = await readRepoIndexManifest(makeEnv(kv), "Sigilix", "sigilix")
    expect(r1.kind).toBe("invalid")
    if (r1.kind === "invalid") expect(r1.reason).toBe("shape")

    // Zero is not a valid GitHub repo ID.
    const zeroId = { ...SAMPLE_MANIFEST, githubRepoId: 0 }
    store.set("repo-index-manifest:sigilix/sigilix", JSON.stringify(zeroId))
    const r2 = await readRepoIndexManifest(makeEnv(kv), "Sigilix", "sigilix")
    expect(r2.kind).toBe("invalid")

    // Negative integers are not valid GitHub repo IDs.
    const negId = { ...SAMPLE_MANIFEST, githubRepoId: -5 }
    store.set("repo-index-manifest:sigilix/sigilix", JSON.stringify(negId))
    const r3 = await readRepoIndexManifest(makeEnv(kv), "Sigilix", "sigilix")
    expect(r3.kind).toBe("invalid")

    // Non-integer floats are not valid.
    const floatId = { ...SAMPLE_MANIFEST, githubRepoId: 808247824.5 }
    store.set("repo-index-manifest:sigilix/sigilix", JSON.stringify(floatId))
    const r4 = await readRepoIndexManifest(makeEnv(kv), "Sigilix", "sigilix")
    expect(r4.kind).toBe("invalid")
  })

  it("round-trips a manifest with repoRole set (additive field)", async () => {
    // repo-role classification is additive metadata: a stamped role must
    // survive the read so a later slice can re-rank by it.
    const { kv } = makeKvStub()
    const withRole: RepoIndexManifestV1 = { ...SAMPLE_MANIFEST, repoRole: "backend" }
    await writeRepoIndexManifest(makeEnv(kv), withRole)
    const result = await readRepoIndexManifest(makeEnv(kv), "Sigilix", "Sigilix")
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.manifest.repoRole).toBe("backend")
      expect(result.manifest).toEqual(withRole)
    }
  })

  it("reads a legacy manifest without repoRole as valid (backward-compat)", async () => {
    // Records written before repo-role classification (and any record written
    // while the flag is off) simply lack the field — they must still parse.
    const { kv } = makeKvStub()
    await writeRepoIndexManifest(makeEnv(kv), SAMPLE_MANIFEST)
    const result = await readRepoIndexManifest(makeEnv(kv), "Sigilix", "Sigilix")
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.manifest.repoRole).toBeUndefined()
    }
  })

  it("rejects a manifest whose repoRole is not a known role (shape)", async () => {
    const { kv, store } = makeKvStub()
    const bad = { ...SAMPLE_MANIFEST, repoRole: "frontendish" }
    store.set("repo-index-manifest:sigilix/sigilix", JSON.stringify(bad))
    const result = await readRepoIndexManifest(makeEnv(kv), "Sigilix", "sigilix")
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

  it("serializes the manifest candidate exactly once before dual-writing", async () => {
    const { kv } = makeKvStub()
    const manifest = { ...SAMPLE_MANIFEST, githubRepoId: 808247824 }
    const stringify = vi.spyOn(JSON, "stringify")
    try {
      await writeRepoIndexManifest(makeEnv(kv), manifest)
      expect(stringify.mock.calls.filter(([value]) => value === manifest)).toHaveLength(1)
    } finally {
      stringify.mockRestore()
    }
  })

  it("uses UTF-8 bytes to reject an oversized candidate before either key is mutated", async () => {
    const { kv, store } = makeKvStub()
    const legacyKey = repoIndexManifestKey("Sigilix", "sigilix")
    const tenantKey = repoTenantKey(808247824)
    store.set(legacyKey, "prior-legacy")
    store.set(tenantKey, "prior-tenant")
    const manifest = {
      ...SAMPLE_MANIFEST,
      githubRepoId: 808247824,
      // Fewer than 10 MiB JavaScript code units, but more than 10 MiB UTF-8.
      runId: "é".repeat(5 * 1024 * 1024 + 1),
    } as RepoIndexManifestV1

    await expect(writeRepoIndexManifest(makeEnv(kv), manifest)).rejects.toThrow(/too large/i)
    expect(store.get(legacyKey)).toBe("prior-legacy")
    expect(store.get(tenantKey)).toBe("prior-tenant")
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
    currentCitationChunkVersion: CITATION_CHUNK_VERSION,
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

  it("returns false when citation metadata predates the current splitter identity", () => {
    const legacy = { ...SAMPLE_MANIFEST }
    delete legacy.citationChunkVersion
    expect(isManifestFresh({ ...base, manifest: legacy })).toBe(false)
  })

  it("returns false when embeddingDim differs", () => {
    expect(isManifestFresh({ ...base, currentEmbeddingDim: 1024 })).toBe(false)
  })

  it("returns false when owner differs (same-named repo collision)", () => {
    expect(isManifestFresh({ ...base, currentOwner: "different-org" })).toBe(false)
  })
})
