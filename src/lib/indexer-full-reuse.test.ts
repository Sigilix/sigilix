// SIG-604: loadReuseIdsByPath — the safety gates that decide whether a full
// (re)index may reuse a prior run's vectors. Covers the flag, the embed-compat
// gate (model/chunker migration), and the active-index source (code-review
// C1/M1: reuse ONLY from the materialized active index, never the write-ahead
// coverage ledger, and only when an active index exists).

import { describe, expect, it } from "vitest"
import { loadReuseIdsByPath, indexFullReuseEnabled } from "@/src/lib/indexer-full-reuse"
import { writeRepoIndexManifest, type RepoIndexManifestV1 } from "@/src/lib/repo-index-manifest"
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "@/src/shared/adapters/model"
import { CITATION_CHUNK_VERSION } from "@/src/lib/chunk-core"
import { effectiveChunkerVersion } from "@/src/lib/indexer-internals"
import type { Env } from "@/src/shared/types/env"

const OWNER = "Sigilix"
const REPO = "sigilix"
const GITHUB_REPO_ID = 808247824

function makeEnv(reuse: string | undefined): { env: Env; kv: Map<string, string> } {
  const kv = new Map<string, string>()
  const state = {
    get: async (key: string) => kv.get(key) ?? null,
    put: async (key: string, value: string) => {
      kv.set(key, value)
    },
    delete: async (key: string) => {
      kv.delete(key)
    },
  }
  const env = {
    OPENCLAW_STATE: state,
    ...(reuse !== undefined ? { SIGILIX_INDEX_FULL_REUSE: reuse } : {}),
  } as unknown as Env
  return { env, kv }
}

// A manifest that is embed-COMPATIBLE with the current run's config.
function compatibleManifest(overrides: Partial<RepoIndexManifestV1> = {}): RepoIndexManifestV1 {
  return {
    v: 1,
    repo: REPO,
    owner: OWNER,
    headSha: "a".repeat(40),
    runId: "0123456789abcdef",
    fileCount: 1,
    chunkCount: 1,
    shardCount: 1,
    indexedAt: "2026-05-17T00:00:00.000Z",
    modelId: EMBEDDING_MODEL,
    embeddingDim: EMBEDDING_DIMENSIONS,
    chunkerVersion: effectiveChunkerVersion(false),
    citationChunkVersion: CITATION_CHUNK_VERSION,
    windowLines: 30,
    overlapLines: 10,
    githubRepoId: GITHUB_REPO_ID,
    activeIndex: {
      version: 1,
      githubRepoId: GITHUB_REPO_ID,
      builtMode: "on",
      byPath: { "src/foo.ts": ["a".repeat(48)] },
    },
    ...overrides,
  }
}

const call = (env: Env) => loadReuseIdsByPath({ env, owner: OWNER, stateRepo: REPO, astOn: false })

describe("indexFullReuseEnabled", () => {
  it('is true only for "on" (case/space-insensitive); default off', () => {
    expect(indexFullReuseEnabled(makeEnv("on").env)).toBe(true)
    expect(indexFullReuseEnabled(makeEnv("  ON ").env)).toBe(true)
    expect(indexFullReuseEnabled(makeEnv("shadow").env)).toBe(false)
    expect(indexFullReuseEnabled(makeEnv(undefined).env)).toBe(false)
  })
})

describe("loadReuseIdsByPath", () => {
  it("flag off → undefined (no reuse), even with a perfect manifest", async () => {
    const { env, kv } = makeEnv(undefined)
    await writeRepoIndexManifest(
      { OPENCLAW_STATE: { put: async (k: string, v: string) => void kv.set(k, v) } } as unknown as Env,
      compatibleManifest(),
    )
    expect(await call(env)).toBeUndefined()
  })

  it("flag on + no manifest → undefined", async () => {
    const { env } = makeEnv("on")
    expect(await call(env)).toBeUndefined()
  })

  it("flag on + compatible manifest WITH active index → returns the active-index byPath", async () => {
    const { env } = makeEnv("on")
    await writeRepoIndexManifest(env, compatibleManifest())
    expect(await call(env)).toEqual({ "src/foo.ts": ["a".repeat(48)] })
  })

  it("C1/M1: flag on + compatible manifest but NO active index → undefined (never reuse from the coverage ledger)", async () => {
    const { env } = makeEnv("on")
    const noActive = compatibleManifest()
    delete noActive.activeIndex
    await writeRepoIndexManifest(env, noActive)
    expect(await call(env)).toBeUndefined()
  })

  it("model migration (incompatible manifest) → undefined (must re-embed, no stale vectors)", async () => {
    const { env } = makeEnv("on")
    await writeRepoIndexManifest(env, compatibleManifest({ modelId: "@cf/some-old-model" }))
    expect(await call(env)).toBeUndefined()
  })

  it("chunker bump (incompatible) → undefined", async () => {
    const { env } = makeEnv("on")
    await writeRepoIndexManifest(env, compatibleManifest({ chunkerVersion: effectiveChunkerVersion(false) + 99 }))
    expect(await call(env)).toBeUndefined()
  })
})
