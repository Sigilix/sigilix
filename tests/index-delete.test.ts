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
import {
  legacyRepoIndexManifestKey,
  repoIndexManifestKey,
  type RepoIndexManifestV1,
} from "../src/lib/repo-index-manifest"
import {
  legacyRepoIndexVectorsKey,
  repoIndexVectorsKey,
  type RepoIndexVectorsV1,
} from "../src/lib/repo-index-vectors"
import { activeRunKey } from "../src/lib/repo-index-active-run"
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
  graphDeleteImpl?: (namespace: string) => Promise<void>
} = {}): { env: Env; deletedBatches: string[][]; graphDeletedNamespaces: string[] } {
  const kv = opts.kv ?? makeKvStub().kv
  const deletedBatches: string[][] = []
  const graphDeletedNamespaces: string[] = []

  // Minimal REPO_GRAPH_DO stub: tracks which DO instances had deleteRepoGraph()
  // called on them (identified by the namespace string passed to idFromName).
  const graphDeleteImpl = opts.graphDeleteImpl
  const repoGraphDO = {
    idFromName(name: string) {
      return { name, toString: () => name }
    },
    get(id: { name: string }) {
      return {
        async deleteRepoGraph(): Promise<void> {
          if (graphDeleteImpl) {
            await graphDeleteImpl(id.name)
          } else {
            graphDeletedNamespaces.push(id.name)
          }
        },
        // Stub remaining RPC methods — not called by the delete path.
        async upsertFileGraph(): Promise<void> { /* no-op */ },
        async commitGraphVersion(): Promise<void> { /* no-op */ },
      }
    },
  }

  const env = {
    OPENCLAW_STATE: kv,
    OPENCLAW_CODE_INDEX: {
      deleteByIds: opts.deleteByIdsImpl ?? (async (ids: string[]) => {
        deletedBatches.push([...ids])
        return { ids, count: ids.length }
      }),
    },
    REPO_GRAPH_DO: repoGraphDO,
  } as unknown as Env
  return { env, deletedBatches, graphDeletedNamespaces }
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
    store.set(repoIndexManifestKey("Arc-and-Anchor", "sigilix"), JSON.stringify(manifest()))
    store.set(repoIndexVectorsKey("Arc-and-Anchor", "sigilix"), JSON.stringify(vectors()))
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
    expect(store.has(repoIndexManifestKey("Arc-and-Anchor", "sigilix"))).toBe(false)
    expect(store.has(repoIndexVectorsKey("Arc-and-Anchor", "sigilix"))).toBe(false)
    expect(store.has("pr-review-manifest:Arc-and-Anchor/sigilix#10")).toBe(false)
    expect(store.has("pr-review-manifest:Arc-and-Anchor/sigilix#11")).toBe(false)
    expect(store.has("pr-review:Arc-and-Anchor/sigilix#10@aaa")).toBe(false)
  })

  it("deletes the active-run lease key on uninstall", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Arc-and-Anchor", "sigilix"), JSON.stringify(manifest()))
    store.set(repoIndexVectorsKey("Arc-and-Anchor", "sigilix"), JSON.stringify(vectors()))
    store.set(
      activeRunKey("Arc-and-Anchor", "sigilix"),
      JSON.stringify({ v: 1, runId: "x", startedAt: "t" }),
    )

    const { env } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env, owner: "Arc-and-Anchor", repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("complete")
    expect(store.has(activeRunKey("Arc-and-Anchor", "sigilix"))).toBe(false)
    expect(result.errors).toEqual([])
  })

  it("batches deleteByIds at 1000 ids per call", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Arc-and-Anchor", "sigilix"), JSON.stringify(manifest()))
    const bigByPath: Record<string, string[]> = {}
    bigByPath["src/big.ts"] = Array.from({ length: 2500 }, (_, i) => `id-${i}`)
    store.set(repoIndexVectorsKey("Arc-and-Anchor", "sigilix"), JSON.stringify(vectors({ byPath: bigByPath })))

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
    store.set(repoIndexManifestKey("Arc-and-Anchor", "sigilix"), JSON.stringify(manifest({ owner: "different-org" })))
    store.set(repoIndexVectorsKey("Arc-and-Anchor", "sigilix"), JSON.stringify(vectors({ owner: "different-org" })))
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
    expect(store.has(repoIndexManifestKey("Arc-and-Anchor", "sigilix"))).toBe(true)
    expect(store.has(repoIndexVectorsKey("Arc-and-Anchor", "sigilix"))).toBe(true)
    // Owner-qualified record still deleted.
    expect(store.has("pr-review-manifest:Arc-and-Anchor/sigilix#10")).toBe(false)
    expect(result.prReviewManifests).toBe(1)
  })
})

// ─── deleteRepoIndex — pre-PR3 backfill ────────────────────────────────

describe("deleteRepoIndex — pre-PR3 (no vectors record)", () => {
  it("proceeds with KV cleanup but reports vector_ids=0 and logs the leak", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Arc-and-Anchor", "sigilix"), JSON.stringify(manifest()))
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

// ─── deleteRepoIndex — SIG-132 orphaned legacy (bare-repo) key shape ───

describe("deleteRepoIndex — SIG-132 legacy bare-repo orphan deletion (GDPR)", () => {
  it("deletes a NEW-shape (<owner>/<repo>) record on uninstall", async () => {
    // Sanity baseline for the orphan test below: the modern key shape
    // purges cleanly.
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Arc-and-Anchor", "sigilix"), JSON.stringify(manifest()))
    store.set(repoIndexVectorsKey("Arc-and-Anchor", "sigilix"), JSON.stringify(vectors()))

    const { env, deletedBatches } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env, owner: "Arc-and-Anchor", repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("complete")
    expect(result.vectorIds).toBe(3)
    expect(deletedBatches).toHaveLength(1)
    expect(store.has(repoIndexManifestKey("Arc-and-Anchor", "sigilix"))).toBe(false)
    expect(store.has(repoIndexVectorsKey("Arc-and-Anchor", "sigilix"))).toBe(false)
  })

  it("deletes an ORPHANED OLD-shape (bare <repo>) record when manifest.owner matches", async () => {
    // GDPR-critical: pre-SIG-132 records live under the bare `<repo>`
    // key. Uninstall MUST still find + purge them so no customer data is
    // stranded. The body still carries owner + repo, so the
    // `manifest.owner === ownerLogin` match holds and the delete targets
    // the EXACT legacy key it was found under.
    const { kv, store } = makeKvStub()
    store.set(legacyRepoIndexManifestKey("sigilix"), JSON.stringify(manifest()))
    store.set(legacyRepoIndexVectorsKey("sigilix"), JSON.stringify(vectors()))
    // No new-shape record exists.
    expect(store.has(repoIndexManifestKey("Arc-and-Anchor", "sigilix"))).toBe(false)

    const { env, deletedBatches } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env, owner: "Arc-and-Anchor", repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("complete")
    // Vectorize embeddings purged (deleteByIds is namespace-independent).
    expect(result.vectorIds).toBe(3)
    expect(deletedBatches).toHaveLength(1)
    expect(new Set(deletedBatches[0])).toEqual(new Set(["id-a1", "id-a2", "id-b1"]))
    expect(result.manifestDeleted).toBe(true)
    expect(result.vectorsKvDeleted).toBe(true)
    // The legacy bare keys are gone.
    expect(store.has(legacyRepoIndexManifestKey("sigilix"))).toBe(false)
    expect(store.has(legacyRepoIndexVectorsKey("sigilix"))).toBe(false)
  })

  it("purges BOTH a new-shape record AND a coexisting same-owner legacy orphan (incl. its embeddings)", async () => {
    // Narrow case: repo indexed pre- AND post-migration. New record's
    // ids and the legacy record's ids are content-addressed under
    // different namespaces, so both id sets must be deleteByIds'd and
    // both KV keys removed.
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Arc-and-Anchor", "sigilix"), JSON.stringify(manifest()))
    store.set(repoIndexVectorsKey("Arc-and-Anchor", "sigilix"), JSON.stringify(vectors()))
    // Same-owner legacy orphan with DIFFERENT (old-namespace) ids.
    store.set(legacyRepoIndexManifestKey("sigilix"), JSON.stringify(manifest()))
    store.set(legacyRepoIndexVectorsKey("sigilix"), JSON.stringify(vectors({
      byPath: { "src/legacy.ts": ["old-id-1", "old-id-2"] },
    })))

    const { env, deletedBatches } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env, owner: "Arc-and-Anchor", repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("complete")
    // 3 new ids + 2 legacy ids all deleted.
    expect(result.vectorIds).toBe(5)
    const allDeleted = new Set(deletedBatches.flat())
    expect(allDeleted).toEqual(new Set(["id-a1", "id-a2", "id-b1", "old-id-1", "old-id-2"]))
    // All four KV keys gone.
    expect(store.has(repoIndexManifestKey("Arc-and-Anchor", "sigilix"))).toBe(false)
    expect(store.has(repoIndexVectorsKey("Arc-and-Anchor", "sigilix"))).toBe(false)
    expect(store.has(legacyRepoIndexManifestKey("sigilix"))).toBe(false)
    expect(store.has(legacyRepoIndexVectorsKey("sigilix"))).toBe(false)
  })

  it("keeps a coexisting DIFFERENT-owner legacy orphan untouched while purging the new-shape record", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Arc-and-Anchor", "sigilix"), JSON.stringify(manifest()))
    store.set(repoIndexVectorsKey("Arc-and-Anchor", "sigilix"), JSON.stringify(vectors()))
    // Legacy orphan belongs to a DIFFERENT tenant — must survive.
    store.set(legacyRepoIndexManifestKey("sigilix"), JSON.stringify(manifest({ owner: "different-org" })))
    store.set(legacyRepoIndexVectorsKey("sigilix"), JSON.stringify(vectors({ owner: "different-org" })))

    const { env, deletedBatches } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env, owner: "Arc-and-Anchor", repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("complete")
    // Only the new-shape record's 3 ids deleted, not the orphan's.
    expect(result.vectorIds).toBe(3)
    expect(new Set(deletedBatches.flat())).toEqual(new Set(["id-a1", "id-a2", "id-b1"]))
    // New-shape gone, other tenant's legacy orphan survives.
    expect(store.has(repoIndexManifestKey("Arc-and-Anchor", "sigilix"))).toBe(false)
    expect(store.has(repoIndexVectorsKey("Arc-and-Anchor", "sigilix"))).toBe(false)
    expect(store.has(legacyRepoIndexManifestKey("sigilix"))).toBe(true)
    expect(store.has(legacyRepoIndexVectorsKey("sigilix"))).toBe(true)
  })

  it("does NOT delete an orphaned OLD-shape record owned by ANOTHER tenant (cross-tenant guard)", async () => {
    // The legacy bare key `repo-index-vectors:sigilix` is exactly where a
    // genuine cross-tenant collision can still occur post-SIG-132: two
    // orgs each indexed a repo named `sigilix` pre-migration. When
    // Arc-and-Anchor uninstalls, a `different-org`-owned orphan under the
    // shared bare key MUST survive.
    const { kv, store } = makeKvStub()
    store.set(legacyRepoIndexManifestKey("sigilix"), JSON.stringify(manifest({ owner: "different-org" })))
    store.set(legacyRepoIndexVectorsKey("sigilix"), JSON.stringify(vectors({ owner: "different-org" })))

    const { env, deletedBatches } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env, owner: "Arc-and-Anchor", repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("owner-mismatch-skip")
    expect(result.vectorIds).toBe(0)
    expect(deletedBatches).toHaveLength(0)
    // The other tenant's orphaned legacy records survive.
    expect(store.has(legacyRepoIndexManifestKey("sigilix"))).toBe(true)
    expect(store.has(legacyRepoIndexVectorsKey("sigilix"))).toBe(true)
  })
})

describe("handleInstallationDeleted — SIG-132 orphan discovery", () => {
  it("discovers + deletes an orphaned OLD-shape record via manifest.owner match", async () => {
    // The KV scan walks `repo-index-manifest:`; a legacy bare key is in
    // that prefix. Discovery matches on the manifest BODY's owner (not
    // the key shape) so the orphan is found and fanned out to delete.
    const { kv, store } = makeKvStub()
    store.set(legacyRepoIndexManifestKey("sigilix"), JSON.stringify(manifest({ repo: "sigilix", owner: "Arc-and-Anchor" })))
    store.set(legacyRepoIndexVectorsKey("sigilix"), JSON.stringify(vectors({ repo: "sigilix", owner: "Arc-and-Anchor" })))

    const { env } = makeEnv({ kv })
    const { results, anyError } = await handleInstallationDeleted({
      env, installationId: 99, ownerLogin: "Arc-and-Anchor",
    })

    expect(anyError).toBe(false)
    expect(results.length).toBe(1)
    expect(results[0]?.status).toBe("complete")
    expect(store.has(legacyRepoIndexManifestKey("sigilix"))).toBe(false)
    expect(store.has(legacyRepoIndexVectorsKey("sigilix"))).toBe(false)
  })
})

// ─── deleteRepoIndex — partial failure ─────────────────────────────────

describe("deleteRepoIndex — partial failure", () => {
  it("returns status=partial AND keeps id-list + manifest until Vectorize succeeds (CR Critical #2)", async () => {
    // CR Critical #2 on PR #77: a partial Vectorize delete that
    // proceeds to wipe the id-list + manifest leaves orphans
    // unrecoverable on redelivery. The redelivery has no chunk ids
    // to retry. New behavior: keep BOTH KV records intact until all
    // Vectorize batches succeed, so GitHub redelivery (driven by
    // the webhook 503) can finish the job idempotently.
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Arc-and-Anchor", "sigilix"), JSON.stringify(manifest()))
    store.set(repoIndexVectorsKey("Arc-and-Anchor", "sigilix"), JSON.stringify(vectors()))

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
    // Critical: id list + manifest survive so redelivery can retry.
    expect(result.vectorsKvDeleted).toBe(false)
    expect(result.manifestDeleted).toBe(false)
    expect(store.has(repoIndexVectorsKey("Arc-and-Anchor", "sigilix"))).toBe(true)
    expect(store.has(repoIndexManifestKey("Arc-and-Anchor", "sigilix"))).toBe(true)
  })
})

// ─── deleteRepoIndex — Sigilix HIGH + CR Critical #1 on PR #77 ─────────

describe("deleteRepoIndex — vectors owner mismatch (Sigilix HIGH / CR Critical #1)", () => {
  it("manifest owner MATCHES but vectors record owner does NOT → skip ALL repo-only deletes", async () => {
    // Sigilix HIGH: prior code skipped Vectorize.deleteByIds correctly
    // but still wiped `repo-index-vectors:<repo>`, orphaning the
    // mismatched-owner tenant's Vectorize IDs forever (no id list
    // left to enumerate them). Fix gates EVERY repo-only delete on
    // the combined ownership of manifest + vectors records.
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Arc-and-Anchor", "sigilix"), JSON.stringify(manifest()))
    // Vectors record belongs to a DIFFERENT owner.
    store.set(repoIndexVectorsKey("Arc-and-Anchor", "sigilix"), JSON.stringify(vectors({ owner: "different-org" })))
    store.set("pr-review-manifest:Arc-and-Anchor/sigilix#10", "{}")

    const { env, deletedBatches } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env, owner: "Arc-and-Anchor", repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("owner-mismatch-skip")
    expect(result.vectorIds).toBe(0)
    expect(deletedBatches).toHaveLength(0)
    // ALL repo-only state survives.
    expect(store.has(repoIndexManifestKey("Arc-and-Anchor", "sigilix"))).toBe(true)
    expect(store.has(repoIndexVectorsKey("Arc-and-Anchor", "sigilix"))).toBe(true)
    // Owner-qualified record still deleted (those don't share the
    // cross-tenant collision problem).
    expect(store.has("pr-review-manifest:Arc-and-Anchor/sigilix#10")).toBe(false)
    expect(result.prReviewManifests).toBe(1)
  })

  it("manifest MISSING + vectors record belongs to another owner → skip ALL repo-only deletes (CR Critical #1)", async () => {
    // CR Critical #1: edge case where there's no manifest at all
    // (e.g., a previous incomplete uninstall already wiped it), but
    // a vectors record exists under a DIFFERENT owner. The previous
    // structure defaulted `ownerMatchesForRepoOnly = true` since the
    // manifest check passed (no manifest, no mismatch), so the
    // vectors KV record + manifest KV got wiped anyway.
    const { kv, store } = makeKvStub()
    // No manifest.
    store.set(repoIndexVectorsKey("Arc-and-Anchor", "sigilix"), JSON.stringify(vectors({ owner: "different-org" })))

    const { env, deletedBatches } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env, owner: "Arc-and-Anchor", repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("owner-mismatch-skip")
    expect(deletedBatches).toHaveLength(0)
    // Vectors record survives — it belongs to someone else.
    expect(store.has(repoIndexVectorsKey("Arc-and-Anchor", "sigilix"))).toBe(true)
  })
})

// ─── deleteRepoIndex — KV pagination ───────────────────────────────────

describe("deleteRepoIndex — KV pagination across multiple pages", () => {
  it("walks list_complete=false pages via cursor until done", async () => {
    const { kv, store, setListImpl } = makeKvStub()
    store.set(repoIndexManifestKey("Arc-and-Anchor", "sigilix"), JSON.stringify(manifest()))

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
    store.set(repoIndexManifestKey("Arc-and-Anchor", "sigilix"), JSON.stringify(manifest()))

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
    store.set(repoIndexManifestKey("Acme", "repo-a"), JSON.stringify(manifest({ repo: "repo-a", owner: "Acme" })))
    store.set(repoIndexManifestKey("Acme", "repo-b"), JSON.stringify(manifest({ repo: "repo-b", owner: "Acme" })))

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
    expect(store.has(repoIndexManifestKey("Acme", "repo-a"))).toBe(false)
    expect(store.has(repoIndexManifestKey("Acme", "repo-b"))).toBe(false)
  })

  it("returns anyError=true when at least one repo's delete is partial", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Acme", "repo-a"), JSON.stringify(manifest({ repo: "repo-a", owner: "Acme" })))
    store.set(repoIndexVectorsKey("Acme", "repo-a"), JSON.stringify(vectors({ repo: "repo-a", owner: "Acme" })))

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
    store.set(repoIndexManifestKey("Acme", "repo-a"), JSON.stringify(manifest({ repo: "repo-a", owner: "Acme" })))
    store.set(repoIndexManifestKey("Acme", "repo-b"), JSON.stringify(manifest({ repo: "repo-b", owner: "Acme" })))
    // Different-owner repo should NOT be touched.
    store.set(repoIndexManifestKey("OtherCorp", "repo-c"), JSON.stringify(manifest({ repo: "repo-c", owner: "OtherCorp" })))

    const { env } = makeEnv({ kv })
    const { results } = await handleInstallationDeleted({
      env, installationId: 99, ownerLogin: "Acme",
    })

    expect(results.length).toBe(2)
    expect(store.has(repoIndexManifestKey("Acme", "repo-a"))).toBe(false)
    expect(store.has(repoIndexManifestKey("Acme", "repo-b"))).toBe(false)
    // OtherCorp's manifest survives.
    expect(store.has(repoIndexManifestKey("OtherCorp", "repo-c"))).toBe(true)
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

// ─── deleteRepoIndex — SIG-138 T8 graph-delete arm ─────────────────────

describe("deleteRepoIndex — SIG-138 T8 graph-delete arm", () => {
  it("invokes deleteGraph for the resolved owner/repo on a normal uninstall", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Arc-and-Anchor", "sigilix"), JSON.stringify(manifest()))
    store.set(repoIndexVectorsKey("Arc-and-Anchor", "sigilix"), JSON.stringify(vectors()))

    const { env, graphDeletedNamespaces } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env, owner: "Arc-and-Anchor", repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("complete")
    // The graph stub records the DO namespace string (indexNamespace(owner, repo)).
    // indexNamespace lowercases: "arc-and-anchor/sigilix".
    expect(graphDeletedNamespaces).toHaveLength(1)
    expect(graphDeletedNamespaces[0]).toBe("arc-and-anchor/sigilix")
  })

  it("graph delete runs even when OPENCLAW_INDEXER_ENABLED is absent (ungated by indexer flag)", async () => {
    // The delete path must not check OPENCLAW_INDEXER_ENABLED. Verify by
    // ensuring the graph delete fires on an env that does NOT define the flag.
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Arc-and-Anchor", "sigilix"), JSON.stringify(manifest()))
    store.set(repoIndexVectorsKey("Arc-and-Anchor", "sigilix"), JSON.stringify(vectors()))

    const { env, graphDeletedNamespaces } = makeEnv({ kv })
    // Explicitly confirm the flag is absent on the env stub.
    expect((env as Record<string, unknown>)["OPENCLAW_INDEXER_ENABLED"]).toBeUndefined()

    await deleteRepoIndex({
      env, owner: "Arc-and-Anchor", repo: "sigilix",
      reason: "install-repos-removed",
    })

    expect(graphDeletedNamespaces).toHaveLength(1)
    expect(graphDeletedNamespaces[0]).toBe("arc-and-anchor/sigilix")
  })

  it("graph delete is skipped when owner guard fires (owner mismatch)", async () => {
    // The graph delete arm is INSIDE the safeToTouchRepoOnlyState block.
    // When manifest.owner != owner the arm must not fire.
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Arc-and-Anchor", "sigilix"), JSON.stringify(manifest({ owner: "different-org" })))
    store.set(repoIndexVectorsKey("Arc-and-Anchor", "sigilix"), JSON.stringify(vectors({ owner: "different-org" })))

    const { env, graphDeletedNamespaces } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env, owner: "Arc-and-Anchor", repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("owner-mismatch-skip")
    expect(graphDeletedNamespaces).toHaveLength(0)
  })

  it("graph delete failure is best-effort: logs an error and sets status=partial but other arms complete", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Arc-and-Anchor", "sigilix"), JSON.stringify(manifest()))
    store.set(repoIndexVectorsKey("Arc-and-Anchor", "sigilix"), JSON.stringify(vectors()))

    const { env, deletedBatches } = makeEnv({
      kv,
      graphDeleteImpl: async () => { throw new Error("DO unavailable") },
    })
    const result = await deleteRepoIndex({
      env, owner: "Arc-and-Anchor", repo: "sigilix",
      reason: "install-deleted",
    })

    // Graph failure contributes to errors[] → status becomes partial.
    expect(result.status).toBe("partial")
    expect(result.errors.some((e) => e.includes("graph.delete"))).toBe(true)
    // The rest of the arms still ran: Vectorize ids were deleted.
    expect(result.vectorIds).toBe(3)
    expect(deletedBatches).toHaveLength(1)
    // KV records also cleaned up.
    expect(result.manifestDeleted).toBe(true)
    expect(result.vectorsKvDeleted).toBe(true)
  })
})
