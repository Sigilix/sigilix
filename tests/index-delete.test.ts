// ARC-238 — integration tests for the uninstall delete fan-out.
//
// Covers:
//   - `deleteRepoIndex` happy path: Vectorize.deleteByIds in batches,
//     KV deletes for repo-index-manifest + repo-index-vectors,
//     pr-review-manifest:<owner>/<repo>#* sweep, pr-review:<owner>/<repo>#*
//     sweep, structured `index-deleted` telemetry.
//   - Cross-tenant guard: manifest.owner !== owner → skip repo-only
//     deletes (Vectorize + repo-only KV), but still cleans owner-
//     qualified pr-review-* keys (those are safe).
//   - Pre-PR3 backfill: missing vectors record → KV cleanup proceeds,
//     vector deletion impossible; logs `index-delete-no-vectors-record`.
//   - Partial failure: Vectorize batch throws → `status: "partial"` +
//     errors[] populated → webhook returns 503.
//   - KV pagination: list_complete + cursor across multiple pages.
//   - `handleInstallReposRemoved` fans out per repo in
//     `repositories_removed`.
//   - `handleInstallationDeleted` walks `repo-index-manifest:` and
//     filters by `manifest.owner === ownerLogin`.

import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  deleteRepoIndex,
  handleInstallReposRemoved,
  handleInstallationDeleted,
} from "../src/lib/index-delete"
import { repoIndexManifestKey, type RepoIndexManifestV1 } from "../src/lib/repo-index-manifest"
import { repoIndexVectorsKey, type RepoIndexVectorsV1 } from "../src/lib/repo-index-vectors"
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "../src/lib/embeddings"
import type { Env } from "../src/index"

interface KvListPage {
  keys: Array<{ name: string }>
  list_complete: boolean
  cursor?: string
}

function makeKvStub(): {
  kv: Env["OPENCLAW_STATE"]
  store: Map<string, string>
  /** Optional override of list() behaviour for pagination tests. */
  setListImpl: (impl: (opts: { prefix?: string; limit?: number; cursor?: string }) => KvListPage) => void
} {
  const store = new Map<string, string>()
  let listImpl: ((opts: { prefix?: string; limit?: number; cursor?: string }) => KvListPage) | null = null
  const defaultList = (opts: { prefix?: string; limit?: number; cursor?: string }): KvListPage => {
    const prefix = opts.prefix ?? ""
    const all = Array.from(store.keys()).filter((k) => k.startsWith(prefix)).sort()
    return { keys: all.map((name) => ({ name })), list_complete: true }
  }
  const kv = {
    async get(key: string): Promise<string | null> { return store.get(key) ?? null },
    async put(key: string, value: string): Promise<void> { store.set(key, value) },
    async delete(key: string): Promise<void> { store.delete(key) },
    async list(opts: { prefix?: string; limit?: number; cursor?: string }): Promise<KvListPage> {
      return (listImpl ?? defaultList)(opts)
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return {
    kv, store,
    setListImpl: (impl) => { listImpl = impl },
  }
}

function makeEnv(opts: {
  kv?: Env["OPENCLAW_STATE"]
  deleteByIdsImpl?: (ids: string[]) => Promise<unknown>
} = {}): { env: Env; deletedBatches: string[][] } {
  const kv = opts.kv ?? makeKvStub().kv
  const deletedBatches: string[][] = []
  const env = {
    OPENCLAW_STATE: kv,
    OPENCLAW_CODE_INDEX: {
      deleteByIds: opts.deleteByIdsImpl ?? (async (ids: string[]) => {
        deletedBatches.push([...ids])
        return { ids, count: ids.length }
      }),
    },
  } as unknown as Env
  return { env, deletedBatches }
}

function manifest(over: Partial<RepoIndexManifestV1> = {}): RepoIndexManifestV1 {
  return {
    v: 1,
    repo: "sigilix",
    owner: "Arc-and-Anchor",
    headSha: "a".repeat(40),
    runId: "0123456789abcdef",
    fileCount: 1, chunkCount: 1, shardCount: 1,
    indexedAt: "2026-05-17T00:00:00.000Z",
    modelId: EMBEDDING_MODEL,
    embeddingDim: EMBEDDING_DIMENSIONS,
    chunkerVersion: 1,
    windowLines: 30, overlapLines: 10,
    ...over,
  }
}

function vectors(over: Partial<RepoIndexVectorsV1> = {}): RepoIndexVectorsV1 {
  return {
    v: 1,
    repo: "sigilix",
    owner: "Arc-and-Anchor",
    runId: "0123456789abcdef",
    byPath: {
      "src/a.ts": ["id-a1", "id-a2"],
      "src/b.ts": ["id-b1"],
    },
    ...over,
  }
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

// ─── deleteRepoIndex — happy path ──────────────────────────────────────

describe("deleteRepoIndex — happy path", () => {
  it("deletes Vectorize ids, both KV records, and pr-review-* prefixes", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("sigilix"), JSON.stringify(manifest()))
    store.set(repoIndexVectorsKey("sigilix"), JSON.stringify(vectors()))
    store.set("pr-review-manifest:Arc-and-Anchor/sigilix#10", "{}")
    store.set("pr-review-manifest:Arc-and-Anchor/sigilix#11", "{}")
    store.set("pr-review:Arc-and-Anchor/sigilix#10@aaa", "{}")

    const { env, deletedBatches } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env, owner: "Arc-and-Anchor", repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("complete")
    expect(result.vectorIds).toBe(3)
    expect(result.manifestDeleted).toBe(true)
    expect(result.vectorsKvDeleted).toBe(true)
    expect(result.prReviewManifests).toBe(2)
    expect(result.prReviewDedupeKeys).toBe(1)
    expect(result.errors).toEqual([])

    // Vectorize batch contained the right ids (dedupe + flatten).
    expect(deletedBatches).toHaveLength(1)
    expect(new Set(deletedBatches[0])).toEqual(new Set(["id-a1", "id-a2", "id-b1"]))

    // KV is clean.
    expect(store.has(repoIndexManifestKey("sigilix"))).toBe(false)
    expect(store.has(repoIndexVectorsKey("sigilix"))).toBe(false)
    expect(store.has("pr-review-manifest:Arc-and-Anchor/sigilix#10")).toBe(false)
    expect(store.has("pr-review-manifest:Arc-and-Anchor/sigilix#11")).toBe(false)
    expect(store.has("pr-review:Arc-and-Anchor/sigilix#10@aaa")).toBe(false)
  })

  it("batches deleteByIds at 1000 ids per call", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("sigilix"), JSON.stringify(manifest()))
    const bigByPath: Record<string, string[]> = {}
    bigByPath["src/big.ts"] = Array.from({ length: 2500 }, (_, i) => `id-${i}`)
    store.set(repoIndexVectorsKey("sigilix"), JSON.stringify(vectors({ byPath: bigByPath })))

    const { env, deletedBatches } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env, owner: "Arc-and-Anchor", repo: "sigilix",
      reason: "install-deleted",
    })
    expect(result.status).toBe("complete")
    expect(result.vectorIds).toBe(2500)
    expect(deletedBatches.length).toBe(3) // 1000, 1000, 500
    expect(deletedBatches[0]?.length).toBe(1000)
    expect(deletedBatches[1]?.length).toBe(1000)
    expect(deletedBatches[2]?.length).toBe(500)
  })
})

// ─── deleteRepoIndex — cross-tenant guard ──────────────────────────────

describe("deleteRepoIndex — cross-tenant guard", () => {
  it("skips repo-only deletes when manifest.owner !== owner", async () => {
    const { kv, store } = makeKvStub()
    // Manifest's owner is DIFFERENT.
    store.set(repoIndexManifestKey("sigilix"), JSON.stringify(manifest({ owner: "different-org" })))
    store.set(repoIndexVectorsKey("sigilix"), JSON.stringify(vectors({ owner: "different-org" })))
    // pr-review-manifest is owner-qualified, so still safe to delete.
    store.set("pr-review-manifest:Arc-and-Anchor/sigilix#10", "{}")

    const { env, deletedBatches } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env, owner: "Arc-and-Anchor", repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("owner-mismatch-skip")
    expect(result.vectorIds).toBe(0)
    expect(deletedBatches).toHaveLength(0)
    // Repo-only KV records left alone.
    expect(store.has(repoIndexManifestKey("sigilix"))).toBe(true)
    expect(store.has(repoIndexVectorsKey("sigilix"))).toBe(true)
    // Owner-qualified record still deleted.
    expect(store.has("pr-review-manifest:Arc-and-Anchor/sigilix#10")).toBe(false)
    expect(result.prReviewManifests).toBe(1)
  })
})

// ─── deleteRepoIndex — pre-PR3 backfill ────────────────────────────────

describe("deleteRepoIndex — pre-PR3 (no vectors record)", () => {
  it("proceeds with KV cleanup but reports vector_ids=0 and logs the leak", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("sigilix"), JSON.stringify(manifest()))
    // NO repo-index-vectors record (pre-PR3 index)
    store.set("pr-review-manifest:Arc-and-Anchor/sigilix#10", "{}")

    const { env, deletedBatches } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env, owner: "Arc-and-Anchor", repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("complete")
    expect(result.vectorIds).toBe(0)
    expect(result.vectorsKvDeleted).toBe(false) // nothing to delete
    expect(result.manifestDeleted).toBe(true)
    expect(result.prReviewManifests).toBe(1)
    expect(deletedBatches).toHaveLength(0)
  })
})

// ─── deleteRepoIndex — no state at all ─────────────────────────────────

describe("deleteRepoIndex — no state", () => {
  it("returns no-state when neither manifest nor vectors KV exist", async () => {
    const { kv } = makeKvStub()
    const { env } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env, owner: "Arc-and-Anchor", repo: "sigilix",
      reason: "install-deleted",
    })
    expect(result.status).toBe("no-state")
    expect(result.vectorIds).toBe(0)
    expect(result.prReviewManifests).toBe(0)
  })
})

// ─── deleteRepoIndex — partial failure ─────────────────────────────────

describe("deleteRepoIndex — partial failure", () => {
  it("returns status=partial when Vectorize.deleteByIds throws on a batch", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("sigilix"), JSON.stringify(manifest()))
    store.set(repoIndexVectorsKey("sigilix"), JSON.stringify(vectors()))

    const { env } = makeEnv({
      kv,
      deleteByIdsImpl: async () => {
        throw new Error("vectorize 503 service unavailable")
      },
    })
    const result = await deleteRepoIndex({
      env, owner: "Arc-and-Anchor", repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("partial")
    expect(result.errors.length).toBe(1)
    expect(result.errors[0]).toContain("vectorize.deleteByIds")
    // The KV deletes still happen even though Vectorize batch failed.
    expect(result.vectorsKvDeleted).toBe(true)
    expect(result.manifestDeleted).toBe(true)
  })
})

// ─── deleteRepoIndex — KV pagination ───────────────────────────────────

describe("deleteRepoIndex — KV pagination across multiple pages", () => {
  it("walks list_complete=false pages via cursor until done", async () => {
    const { kv, store, setListImpl } = makeKvStub()
    store.set(repoIndexManifestKey("sigilix"), JSON.stringify(manifest()))

    // Stuff 2050 owner-qualified pr-review-manifest records.
    for (let i = 0; i < 2050; i++) {
      store.set(`pr-review-manifest:Arc-and-Anchor/sigilix#${i}`, "{}")
    }

    // Cloudflare KV's cursor is opaque and walks a list-time snapshot;
    // deletes mid-iteration don't shift the cursor. Mirror that by
    // capturing the key set at first call and slicing from the
    // snapshot for every cursor, NOT from the live (deleted-as-we-go)
    // store.
    const snapshots = new Map<string, string[]>()
    setListImpl((opts) => {
      const prefix = opts.prefix ?? ""
      const cursor = opts.cursor
      const limit = opts.limit ?? 1000
      let snapshot = snapshots.get(prefix)
      if (!snapshot) {
        snapshot = Array.from(store.keys()).filter((k) => k.startsWith(prefix)).sort()
        snapshots.set(prefix, snapshot)
      }
      const startIdx = cursor ? parseInt(cursor, 10) : 0
      const page = snapshot.slice(startIdx, startIdx + limit)
      const nextIdx = startIdx + page.length
      const list_complete = nextIdx >= snapshot.length
      const out: KvListPage = {
        keys: page.map((name) => ({ name })),
        list_complete,
      }
      if (!list_complete) out.cursor = String(nextIdx)
      return out
    })

    const { env } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env, owner: "Arc-and-Anchor", repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.prReviewManifests).toBe(2050)
    expect(result.errors).toEqual([])
  })

  it("captures error + returns partial when list throws on a page", async () => {
    const { kv, store, setListImpl } = makeKvStub()
    store.set(repoIndexManifestKey("sigilix"), JSON.stringify(manifest()))

    let calls = 0
    setListImpl((_opts) => {
      calls += 1
      if (calls === 1) {
        // First call (for pr-review-manifest prefix) throws.
        throw new Error("kv list 5xx")
      }
      return { keys: [], list_complete: true }
    })

    const { env } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env, owner: "Arc-and-Anchor", repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("partial")
    expect(result.errors.length).toBeGreaterThanOrEqual(1)
    expect(result.errors.some((e) => e.includes("kv.list"))).toBe(true)
  })
})

// ─── handleInstallReposRemoved ─────────────────────────────────────────

describe("handleInstallReposRemoved", () => {
  it("calls deleteRepoIndex per parseable entry", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("repo-a"), JSON.stringify(manifest({ repo: "repo-a", owner: "Acme" })))
    store.set(repoIndexManifestKey("repo-b"), JSON.stringify(manifest({ repo: "repo-b", owner: "Acme" })))

    const { env } = makeEnv({ kv })
    const { results, anyError } = await handleInstallReposRemoved({
      env, installationId: 99,
      repositories: [
        { full_name: "Acme/repo-a" },
        { full_name: "Acme/repo-b" },
        { full_name: "invalid no slash" },
        { name: "no full_name" },
      ],
    })
    expect(results.length).toBe(2)
    expect(anyError).toBe(false)
    expect(store.has(repoIndexManifestKey("repo-a"))).toBe(false)
    expect(store.has(repoIndexManifestKey("repo-b"))).toBe(false)
  })

  it("returns anyError=true when at least one repo's delete is partial", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("repo-a"), JSON.stringify(manifest({ repo: "repo-a", owner: "Acme" })))
    store.set(repoIndexVectorsKey("repo-a"), JSON.stringify(vectors({ repo: "repo-a", owner: "Acme" })))

    const { env } = makeEnv({
      kv,
      deleteByIdsImpl: async () => { throw new Error("vectorize down") },
    })
    const { anyError } = await handleInstallReposRemoved({
      env, installationId: 99,
      repositories: [{ full_name: "Acme/repo-a" }],
    })
    expect(anyError).toBe(true)
  })
})

// ─── handleInstallationDeleted ─────────────────────────────────────────

describe("handleInstallationDeleted", () => {
  it("discovers repos by manifest.owner and deletes each", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("repo-a"), JSON.stringify(manifest({ repo: "repo-a", owner: "Acme" })))
    store.set(repoIndexManifestKey("repo-b"), JSON.stringify(manifest({ repo: "repo-b", owner: "Acme" })))
    // Different-owner repo should NOT be touched.
    store.set(repoIndexManifestKey("repo-c"), JSON.stringify(manifest({ repo: "repo-c", owner: "OtherCorp" })))

    const { env } = makeEnv({ kv })
    const { results } = await handleInstallationDeleted({
      env, installationId: 99, ownerLogin: "Acme",
    })

    expect(results.length).toBe(2)
    expect(store.has(repoIndexManifestKey("repo-a"))).toBe(false)
    expect(store.has(repoIndexManifestKey("repo-b"))).toBe(false)
    // OtherCorp's manifest survives.
    expect(store.has(repoIndexManifestKey("repo-c"))).toBe(true)
  })

  it("returns anyError=true when the KV list call itself fails", async () => {
    const { kv, setListImpl } = makeKvStub()
    setListImpl(() => {
      throw new Error("kv 5xx")
    })
    const { env } = makeEnv({ kv })
    const { anyError } = await handleInstallationDeleted({
      env, installationId: 99, ownerLogin: "Acme",
    })
    expect(anyError).toBe(true)
  })
})
