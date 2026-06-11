// ARC-238 / SIG-132 / SIG-138 — uninstall delete fan-out: legacy
// bare-repo (GDPR) orphan deletion + the graph-delete arm.
//
// Sibling of index-delete.test.ts (split out under SIG-318/SIG-376 to
// keep each suite ≤1,000 lines). Shares fixtures via
// index-delete.test-helpers.ts.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { deleteRepoIndex, handleInstallationDeleted } from "@/src/lib/index-delete"
import { legacyRepoIndexManifestKey, repoIndexManifestKey } from "@/src/lib/repo-index-manifest"
import { legacyRepoIndexVectorsKey, repoIndexVectorsKey } from "@/src/lib/repo-index-vectors"
import { makeKvStub, makeEnv, manifest, vectors } from "@/src/lib/index-delete.test-helpers"

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

// ─── deleteRepoIndex — SIG-132 orphaned legacy (bare-repo) key shape ───

describe("deleteRepoIndex — SIG-132 legacy bare-repo orphan deletion (GDPR)", () => {
  it("deletes a NEW-shape (<owner>/<repo>) record on uninstall", async () => {
    // Sanity baseline for the orphan test below: the modern key shape
    // purges cleanly.
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest()))
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors()))

    const { env, deletedBatches } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("complete")
    expect(result.vectorIds).toBe(3)
    expect(deletedBatches).toHaveLength(1)
    expect(store.has(repoIndexManifestKey("Sigilix", "sigilix"))).toBe(false)
    expect(store.has(repoIndexVectorsKey("Sigilix", "sigilix"))).toBe(false)
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
    expect(store.has(repoIndexManifestKey("Sigilix", "sigilix"))).toBe(false)

    const { env, deletedBatches } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
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
    store.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest()))
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors()))
    // Same-owner legacy orphan with DIFFERENT (old-namespace) ids.
    store.set(legacyRepoIndexManifestKey("sigilix"), JSON.stringify(manifest()))
    store.set(
      legacyRepoIndexVectorsKey("sigilix"),
      JSON.stringify(
        vectors({
          byPath: { "src/legacy.ts": ["old-id-1", "old-id-2"] },
        }),
      ),
    )

    const { env, deletedBatches } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("complete")
    // 3 new ids + 2 legacy ids all deleted.
    expect(result.vectorIds).toBe(5)
    const allDeleted = new Set(deletedBatches.flat())
    expect(allDeleted).toEqual(new Set(["id-a1", "id-a2", "id-b1", "old-id-1", "old-id-2"]))
    // All four KV keys gone.
    expect(store.has(repoIndexManifestKey("Sigilix", "sigilix"))).toBe(false)
    expect(store.has(repoIndexVectorsKey("Sigilix", "sigilix"))).toBe(false)
    expect(store.has(legacyRepoIndexManifestKey("sigilix"))).toBe(false)
    expect(store.has(legacyRepoIndexVectorsKey("sigilix"))).toBe(false)
  })

  it("keeps a coexisting DIFFERENT-owner legacy orphan untouched while purging the new-shape record", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest()))
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors()))
    // Legacy orphan belongs to a DIFFERENT tenant — must survive.
    store.set(legacyRepoIndexManifestKey("sigilix"), JSON.stringify(manifest({ owner: "different-org" })))
    store.set(legacyRepoIndexVectorsKey("sigilix"), JSON.stringify(vectors({ owner: "different-org" })))

    const { env, deletedBatches } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("complete")
    // Only the new-shape record's 3 ids deleted, not the orphan's.
    expect(result.vectorIds).toBe(3)
    expect(new Set(deletedBatches.flat())).toEqual(new Set(["id-a1", "id-a2", "id-b1"]))
    // New-shape gone, other tenant's legacy orphan survives.
    expect(store.has(repoIndexManifestKey("Sigilix", "sigilix"))).toBe(false)
    expect(store.has(repoIndexVectorsKey("Sigilix", "sigilix"))).toBe(false)
    expect(store.has(legacyRepoIndexManifestKey("sigilix"))).toBe(true)
    expect(store.has(legacyRepoIndexVectorsKey("sigilix"))).toBe(true)
  })

  it("does NOT delete an orphaned OLD-shape record owned by ANOTHER tenant (cross-tenant guard)", async () => {
    // The legacy bare key `repo-index-vectors:sigilix` is exactly where a
    // genuine cross-tenant collision can still occur post-SIG-132: two
    // orgs each indexed a repo named `sigilix` pre-migration. When
    // Sigilix uninstalls, a `different-org`-owned orphan under the
    // shared bare key MUST survive.
    const { kv, store } = makeKvStub()
    store.set(legacyRepoIndexManifestKey("sigilix"), JSON.stringify(manifest({ owner: "different-org" })))
    store.set(legacyRepoIndexVectorsKey("sigilix"), JSON.stringify(vectors({ owner: "different-org" })))

    const { env, deletedBatches } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
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
    store.set(legacyRepoIndexManifestKey("sigilix"), JSON.stringify(manifest({ repo: "sigilix", owner: "Sigilix" })))
    store.set(legacyRepoIndexVectorsKey("sigilix"), JSON.stringify(vectors({ repo: "sigilix", owner: "Sigilix" })))

    const { env } = makeEnv({ kv })
    const { results, anyError } = await handleInstallationDeleted({
      env,
      installationId: 99,
      ownerLogin: "Sigilix",
    })

    expect(anyError).toBe(false)
    expect(results.length).toBe(1)
    expect(results[0]?.status).toBe("complete")
    expect(store.has(legacyRepoIndexManifestKey("sigilix"))).toBe(false)
    expect(store.has(legacyRepoIndexVectorsKey("sigilix"))).toBe(false)
  })
})
// ─── deleteRepoIndex — SIG-138 T8 graph-delete arm ─────────────────────

describe("deleteRepoIndex — SIG-138 T8 graph-delete arm", () => {
  it("invokes deleteGraph for the resolved owner/repo on a normal uninstall", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest()))
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors()))

    const { env, graphDeletedNamespaces } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("complete")
    // The graph stub records the DO namespace string (indexNamespace(owner, repo)).
    // indexNamespace lowercases: "sigilix/sigilix".
    expect(graphDeletedNamespaces).toHaveLength(1)
    expect(graphDeletedNamespaces[0]).toBe("sigilix/sigilix")
  })

  it("graph delete runs even when OPENCLAW_INDEXER_ENABLED is absent (ungated by indexer flag)", async () => {
    // The delete path must not check OPENCLAW_INDEXER_ENABLED. Verify by
    // ensuring the graph delete fires on an env that does NOT define the flag.
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest()))
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors()))

    const { env, graphDeletedNamespaces } = makeEnv({ kv })
    // Explicitly confirm the flag is absent on the env stub.
    expect((env as unknown as Record<string, unknown>)["OPENCLAW_INDEXER_ENABLED"]).toBeUndefined()

    await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      reason: "install-repos-removed",
    })

    expect(graphDeletedNamespaces).toHaveLength(1)
    expect(graphDeletedNamespaces[0]).toBe("sigilix/sigilix")
  })

  it("graph delete fires for the requested owner/repo even when safeToTouchRepoOnlyState is false (owner mismatch)", async () => {
    // Fix #4 (CodeRabbit): the graph DO is keyed by indexNamespace(owner, repo)
    // — deleting it only ever touches the requested tenant's DO. The owner guard
    // exists to protect shared KV/vector records that can collide across tenants;
    // it must NOT gate the graph delete. Repo-only KV/vector cleanup is still
    // skipped on mismatch.
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest({ owner: "different-org" })))
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors({ owner: "different-org" })))

    const { env, graphDeletedNamespaces } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("owner-mismatch-skip")
    // Repo-only KV/vector records are protected (different owner).
    expect(store.has(repoIndexManifestKey("Sigilix", "sigilix"))).toBe(true)
    expect(store.has(repoIndexVectorsKey("Sigilix", "sigilix"))).toBe(true)
    // Graph delete DOES fire for the requested namespace (tenant-safe by design).
    expect(graphDeletedNamespaces).toHaveLength(1)
    expect(graphDeletedNamespaces[0]).toBe("sigilix/sigilix")
  })

  it("graph delete failure is best-effort: logs an error and sets status=partial but other arms complete", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest()))
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors()))

    const { env, deletedBatches } = makeEnv({
      kv,
      graphDeleteImpl: async () => {
        throw new Error("DO unavailable")
      },
    })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
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

  it("SIG-138: graph delete fires even when Vectorize deleteByIds fails (independent of vectorize outcome)", async () => {
    // GDPR regression guard: the graph-delete arm is unconditional under
    // the owner guard. A persistent Vectorize failure (e.g. Vectorize 503)
    // must NOT leave the DO graph data lingering. The graph needs only
    // indexNamespace(owner, repo), not the vector id-list, so there is no
    // stranding risk and deferral serves no purpose.
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest()))
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors()))

    const { env, graphDeletedNamespaces } = makeEnv({
      kv,
      deleteByIdsImpl: async () => {
        throw new Error("vectorize 503 service unavailable")
      },
    })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      reason: "install-deleted",
    })

    // Vectorize failure → status is partial and KV id-list/manifest survive
    // (so redelivery can retry the embeddings).
    expect(result.status).toBe("partial")
    expect(result.errors.some((e) => e.includes("vectorize.deleteByIds"))).toBe(true)
    expect(result.vectorsKvDeleted).toBe(false)
    expect(result.manifestDeleted).toBe(false)
    expect(store.has(repoIndexVectorsKey("Sigilix", "sigilix"))).toBe(true)
    expect(store.has(repoIndexManifestKey("Sigilix", "sigilix"))).toBe(true)

    // Graph delete still fired unconditionally (owner guard passed).
    expect(graphDeletedNamespaces).toHaveLength(1)
    expect(graphDeletedNamespaces[0]).toBe("sigilix/sigilix")
  })

  it("owner-mismatch AND graph delete throws → status=partial (not owner-mismatch-skip)", async () => {
    // CodeRabbit finding on PR #128: the graph-delete arm runs
    // unconditionally (even when !safeToTouchRepoOnlyState) and pushes
    // failures to result.errors. The old status logic checked
    // !safeToTouchRepoOnlyState BEFORE result.errors.length, so a
    // failed GDPR graph delete during an owner-mismatch was silently
    // masked as "owner-mismatch-skip" (treated as success → no 5xx /
    // no redelivery retry). Fix: errors take precedence over the
    // owner-mismatch label so callers surface a 503 and GitHub
    // redelivers for the failed compliance delete.
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest({ owner: "different-org" })))
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors({ owner: "different-org" })))

    const { env } = makeEnv({
      kv,
      graphDeleteImpl: async () => {
        throw new Error("DO write failed")
      },
    })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      reason: "install-deleted",
    })

    // Graph delete failed → must surface as partial, not owner-mismatch-skip.
    expect(result.status).toBe("partial")
    expect(result.errors.some((e) => e.includes("graph.delete"))).toBe(true)
    // Repo-only state (KV/Vectorize) is still protected — the owner guard
    // correctly blocked those arms.
    expect(store.has(repoIndexManifestKey("Sigilix", "sigilix"))).toBe(true)
    expect(store.has(repoIndexVectorsKey("Sigilix", "sigilix"))).toBe(true)
  })

  it("owner-mismatch AND graph delete succeeds → status=owner-mismatch-skip (happy path unaffected)", async () => {
    // Regression guard: the fix must NOT change the happy-path behavior
    // where owner mismatch AND graph delete succeeds — that should remain
    // "owner-mismatch-skip" (no errors in result.errors).
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest({ owner: "different-org" })))
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors({ owner: "different-org" })))

    const { env, graphDeletedNamespaces } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      reason: "install-deleted",
    })

    // No errors → owner-mismatch-skip preserved.
    expect(result.status).toBe("owner-mismatch-skip")
    expect(result.errors).toEqual([])
    // Graph delete still fired.
    expect(graphDeletedNamespaces).toHaveLength(1)
    expect(graphDeletedNamespaces[0]).toBe("sigilix/sigilix")
    // Repo-only KV untouched.
    expect(store.has(repoIndexManifestKey("Sigilix", "sigilix"))).toBe(true)
    expect(store.has(repoIndexVectorsKey("Sigilix", "sigilix"))).toBe(true)
  })
})
