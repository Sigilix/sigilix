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
import { deleteRepoIndex, handleInstallReposRemoved, handleInstallationDeleted } from "@/src/lib/index-delete"
import { repoIndexManifestKey } from "@/src/lib/repo-index-manifest"
import { repoIndexVectorsKey } from "@/src/lib/repo-index-vectors"
import { activeRunKey } from "@/src/lib/repo-index-active-run"
import type { Env } from "@/src/shared/types/env"
import { makeKvStub, makeEnv, manifest, vectors, type KvListPage } from "@/src/lib/index-delete.test-helpers"

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

// ─── deleteRepoIndex — happy path ──────────────────────────────────────

describe("deleteRepoIndex — happy path", () => {
  it("deletes Vectorize ids, both KV records, and pr-review-* prefixes", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest()))
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors()))
    store.set("pr-review-manifest:Sigilix/sigilix#10", "{}")
    store.set("pr-review-manifest:Sigilix/sigilix#11", "{}")
    store.set("pr-review:Sigilix/sigilix#10@aaa", "{}")

    const { env, deletedBatches } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
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
    expect(store.has(repoIndexManifestKey("Sigilix", "sigilix"))).toBe(false)
    expect(store.has(repoIndexVectorsKey("Sigilix", "sigilix"))).toBe(false)
    expect(store.has("pr-review-manifest:Sigilix/sigilix#10")).toBe(false)
    expect(store.has("pr-review-manifest:Sigilix/sigilix#11")).toBe(false)
    expect(store.has("pr-review:Sigilix/sigilix#10@aaa")).toBe(false)
  })

  it("deletes the active-run lease key on uninstall", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest()))
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors()))
    store.set(activeRunKey("Sigilix", "sigilix"), JSON.stringify({ v: 1, runId: "x", startedAt: "t" }))

    const { env } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("complete")
    expect(store.has(activeRunKey("Sigilix", "sigilix"))).toBe(false)
    expect(result.errors).toEqual([])
  })

  it("batches deleteByIds at <=100 ids per call (Vectorize cap; regression guard)", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest()))
    const bigByPath: Record<string, string[]> = {}
    bigByPath["src/big.ts"] = Array.from({ length: 2500 }, (_, i) => `id-${i}`)
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors({ byPath: bigByPath })))

    const { env, deletedBatches } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      reason: "install-deleted",
    })
    expect(result.status).toBe("complete")
    expect(result.vectorIds).toBe(2500)
    // Vectorize deleteByIds rejects >100 ids/call (error 40007). NO batch may
    // exceed 100 — this fails if VECTORIZE_DELETE_BATCH is reverted above 100.
    expect(deletedBatches.every((b) => b.length <= 100)).toBe(true)
    expect(deletedBatches.length).toBe(25) // 2500 / 100
    expect(deletedBatches.reduce((n, b) => n + b.length, 0)).toBe(2500)
  })
})

// ─── deleteRepoIndex — SIG-243 Phase 2b tenant-key cleanup ─────────────

describe("deleteRepoIndex — SIG-243 tenant-key cleanup gate", () => {
  it("deletes repo-tenant:{id} + repo-vectors:{id} on default-branch uninstall when githubRepoId is set", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest({ githubRepoId: 808247824 })))
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors({ githubRepoId: 808247824 })))
    store.set("repo-tenant:808247824", "{}")
    store.set("repo-vectors:808247824", "{}")

    const { env } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("complete")
    // Legacy keys gone — existing behavior.
    expect(store.has(repoIndexManifestKey("Sigilix", "sigilix"))).toBe(false)
    expect(store.has(repoIndexVectorsKey("Sigilix", "sigilix"))).toBe(false)
    // NEW: tenant keys also cleaned up.
    expect(store.has("repo-tenant:808247824")).toBe(false)
    expect(store.has("repo-vectors:808247824")).toBe(false)
  })

  it("does NOT delete tenant keys when the delete targets branch-scoped state (CR PR #203 regression guard)", async () => {
    // Branch-scoped state repos use the `<repo>/__branch__/<hash>`
    // marker. The writers ONLY populate tenant keys for the
    // canonical default-branch record, so a branch delete must
    // never wipe the repo-wide tenant keys. Even if a stale or
    // malformed branch manifest happens to carry githubRepoId,
    // the delete handler's branch-gate must skip the cleanup.
    const { kv, store } = makeKvStub()
    store.set(
      repoIndexManifestKey("Sigilix", "sigilix/__branch__/h646576"),
      JSON.stringify(
        manifest({
          repo: "sigilix/__branch__/h646576",
          actualRepo: "sigilix",
          branch: "feature/something",
          githubRepoId: 808247824, // would-be-bug: branch manifest carrying ID
        }),
      ),
    )
    store.set(
      repoIndexVectorsKey("Sigilix", "sigilix/__branch__/h646576"),
      JSON.stringify(
        vectors({
          repo: "sigilix/__branch__/h646576",
          githubRepoId: 808247824,
        }),
      ),
    )
    // Canonical default-branch tenant keys exist — these MUST NOT
    // be touched by the branch-scoped delete.
    store.set("repo-tenant:808247824", '{"canonical":true}')
    store.set("repo-vectors:808247824", '{"canonical":true}')

    const { env } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix/__branch__/h646576",
      reason: "pr-branch-closed",
    })

    expect(result.status).toBe("complete")
    // Tenant keys survive — the canonical default-branch record
    // for this repo is intact.
    expect(store.get("repo-tenant:808247824")).toBe('{"canonical":true}')
    expect(store.get("repo-vectors:808247824")).toBe('{"canonical":true}')
  })

  it("does not touch tenant keys for pre-Phase-2 legacy records without githubRepoId", async () => {
    const { kv, store } = makeKvStub()
    store.set(
      repoIndexManifestKey("Sigilix", "sigilix"),
      JSON.stringify(manifest()), // no githubRepoId field
    )
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors()))
    // A pre-existing canonical tenant key for a different repo with the
    // same hypothetical ID (defensive — shouldn't happen in practice).
    store.set("repo-tenant:99999999", "{}")

    const { env } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("complete")
    // No tenant key derived → no tenant deletes attempted.
    expect(store.has("repo-tenant:99999999")).toBe(true)
  })
})

// ─── deleteRepoIndex — SIG-247 Phase 1 PR B review-memory cleanup ─────

describe("deleteRepoIndex — SIG-247 Phase 1 review-memory cleanup", () => {
  it("deletes the legacy review-memory:<owner>/<repo>:* prefix on uninstall", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest()))
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors()))
    store.set("review-memory:Sigilix/sigilix:cat:performance", "{}")
    store.set("review-memory:Sigilix/sigilix:cat:logic", "{}")
    store.set("review-memory:Sigilix/sigilix:path:abc:cat:tests", "{}")

    const { env } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("complete")
    expect(result.reviewMemoryKeys).toBe(3)
    expect(store.has("review-memory:Sigilix/sigilix:cat:performance")).toBe(false)
    expect(store.has("review-memory:Sigilix/sigilix:cat:logic")).toBe(false)
    expect(store.has("review-memory:Sigilix/sigilix:path:abc:cat:tests")).toBe(false)
  })

  it("ALSO deletes the new review-memory:repo:<id>:* prefix when manifest carries githubRepoId", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest({ githubRepoId: 808247824 })))
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors({ githubRepoId: 808247824 })))
    store.set("review-memory:Sigilix/sigilix:cat:performance", "{}")
    store.set("review-memory:repo:808247824:cat:performance", "{}")
    store.set("review-memory:repo:808247824:cat:logic", "{}")

    const { env } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("complete")
    expect(result.reviewMemoryKeys).toBe(3) // 1 legacy + 2 new
    expect(store.has("review-memory:Sigilix/sigilix:cat:performance")).toBe(false)
    expect(store.has("review-memory:repo:808247824:cat:performance")).toBe(false)
    expect(store.has("review-memory:repo:808247824:cat:logic")).toBe(false)
  })

  it("does NOT delete review-memory:repo:<id>:* when no positive integer githubRepoId is on either record", async () => {
    const { kv, store } = makeKvStub()
    // Manifest exists but lacks githubRepoId (pre-Phase-2 record)
    store.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest()))
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors()))
    // Hypothetical foreign new-key (e.g., a different repo's id that
    // accidentally collided — defensive guard: must NOT delete)
    store.set("review-memory:repo:99999999:cat:performance", "{}")

    const { env } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("complete")
    // No legacy keys to delete, no foreign new-key delete
    expect(result.reviewMemoryKeys).toBe(0)
    expect(store.has("review-memory:repo:99999999:cat:performance")).toBe(true)
  })

  it("returns reviewMemoryKeys=0 when no review-memory state exists at all", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest({ githubRepoId: 808247824 })))
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors({ githubRepoId: 808247824 })))
    const { env } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      reason: "install-deleted",
    })
    expect(result.reviewMemoryKeys).toBe(0)
  })

  it("review-memory delete still runs even when manifest is missing (legacy keys are owner-qualified)", async () => {
    // Edge case: a repo where indexer state never landed but
    // review-memory captures DID accumulate. Should still clean up.
    const { kv, store } = makeKvStub()
    store.set("review-memory:Sigilix/sigilix:cat:performance", "{}")

    const { env } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.reviewMemoryKeys).toBe(1)
    expect(store.has("review-memory:Sigilix/sigilix:cat:performance")).toBe(false)
  })

  it("CR-Critical (PR #206): does NOT delete review-memory:repo:<id>:* on owner mismatch", async () => {
    // Owner-mismatch scenario: a delete fires for owner X but the
    // manifest reports owner Y. The legacy review-memory keys are
    // owner-qualified by X (safe to delete unguarded). But the new
    // repo-id keyspace's id was sourced from manifest Y — using it
    // would delete owner Y's review-memory data.
    const { kv, store } = makeKvStub()
    store.set(
      repoIndexManifestKey("Sigilix", "sigilix"),
      JSON.stringify(manifest({ owner: "different-org", githubRepoId: 808247824 })),
    )
    store.set(
      repoIndexVectorsKey("Sigilix", "sigilix"),
      JSON.stringify(vectors({ owner: "different-org", githubRepoId: 808247824 })),
    )
    store.set("review-memory:Sigilix/sigilix:cat:performance", "{}")
    // Hypothetical foreign new-key — must NOT be deleted
    store.set("review-memory:repo:808247824:cat:performance", "{}")

    const { env } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      reason: "install-deleted",
    })

    // Legacy keys (owner-qualified by string) ARE deleted
    expect(store.has("review-memory:Sigilix/sigilix:cat:performance")).toBe(false)
    expect(result.reviewMemoryKeys).toBe(1)
    // New repo-id key (sourced from mismatched manifest) is preserved
    expect(store.has("review-memory:repo:808247824:cat:performance")).toBe(true)
  })

  it("CR-Critical (PR #206): does NOT delete review-memory:repo:<id>:* on branch-scoped delete", async () => {
    // A branch-scoped delete (e.g., pr-branch-closed) MUST NOT touch
    // the default-branch tenant keys — the writer never populated
    // repo-id review-memory keys for that branch state, and using
    // the id from a branch-scoped manifest would clobber the
    // canonical default-branch tenant's memory data.
    const { kv, store } = makeKvStub()
    store.set(
      repoIndexManifestKey("Sigilix", "sigilix"),
      JSON.stringify(manifest({ branch: "feature-x", githubRepoId: 808247824 })),
    )
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors({ githubRepoId: 808247824 })))
    store.set("review-memory:Sigilix/sigilix:cat:performance", "{}")
    store.set("review-memory:repo:808247824:cat:performance", "{}")

    const { env } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      reason: "branch-deleted",
    })

    // Legacy keys (owner-qualified by string) ARE deleted
    expect(store.has("review-memory:Sigilix/sigilix:cat:performance")).toBe(false)
    expect(result.reviewMemoryKeys).toBe(1)
    // New repo-id key NOT touched — branch-scoped delete must not
    // wipe the canonical default-branch tenant's memory.
    expect(store.has("review-memory:repo:808247824:cat:performance")).toBe(true)
  })
})

// ─── deleteRepoIndex — cross-tenant guard ──────────────────────────────

describe("deleteRepoIndex — cross-tenant guard", () => {
  it("skips repo-only deletes when manifest.owner !== owner", async () => {
    const { kv, store } = makeKvStub()
    // Manifest's owner is DIFFERENT.
    store.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest({ owner: "different-org" })))
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors({ owner: "different-org" })))
    // pr-review-manifest is owner-qualified, so still safe to delete.
    store.set("pr-review-manifest:Sigilix/sigilix#10", "{}")

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
    // Repo-only KV records left alone.
    expect(store.has(repoIndexManifestKey("Sigilix", "sigilix"))).toBe(true)
    expect(store.has(repoIndexVectorsKey("Sigilix", "sigilix"))).toBe(true)
    // Owner-qualified record still deleted.
    expect(store.has("pr-review-manifest:Sigilix/sigilix#10")).toBe(false)
    expect(result.prReviewManifests).toBe(1)
  })
})

// ─── deleteRepoIndex — pre-PR3 backfill ────────────────────────────────

describe("deleteRepoIndex — pre-PR3 (no vectors record)", () => {
  it("proceeds with KV cleanup but reports vector_ids=0 and logs the leak", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest()))
    // NO repo-index-vectors record (pre-PR3 index)
    store.set("pr-review-manifest:Sigilix/sigilix#10", "{}")

    const { env, deletedBatches } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
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
      env,
      owner: "Sigilix",
      repo: "sigilix",
      reason: "install-deleted",
    })
    expect(result.status).toBe("no-state")
    expect(result.vectorIds).toBe(0)
    expect(result.prReviewManifests).toBe(0)
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
    store.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest()))
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors()))

    const { env } = makeEnv({
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

    expect(result.status).toBe("partial")
    expect(result.errors.length).toBe(1)
    expect(result.errors[0]).toContain("vectorize.deleteByIds")
    // Critical: id list + manifest survive so redelivery can retry.
    expect(result.vectorsKvDeleted).toBe(false)
    expect(result.manifestDeleted).toBe(false)
    expect(store.has(repoIndexVectorsKey("Sigilix", "sigilix"))).toBe(true)
    expect(store.has(repoIndexManifestKey("Sigilix", "sigilix"))).toBe(true)
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
    store.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest()))
    // Vectors record belongs to a DIFFERENT owner.
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors({ owner: "different-org" })))
    store.set("pr-review-manifest:Sigilix/sigilix#10", "{}")

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
    // ALL repo-only state survives.
    expect(store.has(repoIndexManifestKey("Sigilix", "sigilix"))).toBe(true)
    expect(store.has(repoIndexVectorsKey("Sigilix", "sigilix"))).toBe(true)
    // Owner-qualified record still deleted (those don't share the
    // cross-tenant collision problem).
    expect(store.has("pr-review-manifest:Sigilix/sigilix#10")).toBe(false)
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
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors({ owner: "different-org" })))

    const { env, deletedBatches } = makeEnv({ kv })
    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("owner-mismatch-skip")
    expect(deletedBatches).toHaveLength(0)
    // Vectors record survives — it belongs to someone else.
    expect(store.has(repoIndexVectorsKey("Sigilix", "sigilix"))).toBe(true)
  })
})

// ─── deleteRepoIndex — KV pagination ───────────────────────────────────

describe("deleteRepoIndex — KV pagination across multiple pages", () => {
  it("walks list_complete=false pages via cursor until done", async () => {
    const { kv, store, setListImpl } = makeKvStub()
    store.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest()))

    // Stuff 2050 owner-qualified pr-review-manifest records.
    for (let i = 0; i < 2050; i++) {
      store.set(`pr-review-manifest:Sigilix/sigilix#${i}`, "{}")
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
        snapshot = Array.from(store.keys())
          .filter((k) => k.startsWith(prefix))
          .sort()
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
      env,
      owner: "Sigilix",
      repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.prReviewManifests).toBe(2050)
    expect(result.errors).toEqual([])
  })

  it("captures error + returns partial when list throws on a page", async () => {
    const { kv, store, setListImpl } = makeKvStub()
    store.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest()))

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
      env,
      owner: "Sigilix",
      repo: "sigilix",
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
      env,
      installationId: 99,
      repositories: [
        { full_name: "Acme/repo-a" },
        { full_name: "Acme/repo-b" },
        { full_name: "invalid no slash" },
        { name: "no full_name" } as { full_name?: string },
      ],
    })
    expect(results.length).toBe(2)
    expect(anyError).toBe(false)
    expect(store.has(repoIndexManifestKey("Acme", "repo-a"))).toBe(false)
    expect(store.has(repoIndexManifestKey("Acme", "repo-b"))).toBe(false)
  })

  it("also deletes branch-scoped indexes for a removed repo (SIG-35)", async () => {
    const { kv, store } = makeKvStub()
    const branchRepo = "repo-a/__branch__/h646576"
    store.set(repoIndexManifestKey("Acme", "repo-a"), JSON.stringify(manifest({ repo: "repo-a", owner: "Acme" })))
    store.set(repoIndexVectorsKey("Acme", "repo-a"), JSON.stringify(vectors({ repo: "repo-a", owner: "Acme" })))
    store.set(
      repoIndexManifestKey("Acme", branchRepo),
      JSON.stringify(
        manifest({
          repo: branchRepo,
          owner: "Acme",
          actualRepo: "repo-a",
          branch: "dev",
          defaultBranch: "main",
          namespace: "acme/repo-a/__branch__/h646576",
        }),
      ),
    )
    store.set(
      repoIndexVectorsKey("Acme", branchRepo),
      JSON.stringify(
        vectors({
          repo: branchRepo,
          owner: "Acme",
          byPath: { "src/dev.ts": ["dev-id"] },
        }),
      ),
    )

    const { env, deletedBatches } = makeEnv({ kv })
    const { results, anyError } = await handleInstallReposRemoved({
      env,
      installationId: 99,
      repositories: [{ full_name: "Acme/repo-a" }],
    })

    expect(anyError).toBe(false)
    expect(results).toHaveLength(2)
    expect(results.map((r) => r.status)).toEqual(["complete", "complete"])
    expect(store.has(repoIndexManifestKey("Acme", "repo-a"))).toBe(false)
    expect(store.has(repoIndexVectorsKey("Acme", "repo-a"))).toBe(false)
    expect(store.has(repoIndexManifestKey("Acme", branchRepo))).toBe(false)
    expect(store.has(repoIndexVectorsKey("Acme", branchRepo))).toBe(false)
    expect(new Set(deletedBatches.flat())).toEqual(new Set(["id-a1", "id-a2", "id-b1", "dev-id"]))
  })

  it("continues branch-scoped discovery when one branch manifest get fails", async () => {
    const { kv, store } = makeKvStub()
    const okBranchRepo = "repo-a/__branch__/h646576"
    const badBranchRepo = "repo-a/__branch__/h6661696c"
    const badManifestKey = repoIndexManifestKey("Acme", badBranchRepo)
    store.set(repoIndexManifestKey("Acme", "repo-a"), JSON.stringify(manifest({ repo: "repo-a", owner: "Acme" })))
    store.set(repoIndexVectorsKey("Acme", "repo-a"), JSON.stringify(vectors({ repo: "repo-a", owner: "Acme" })))
    store.set(
      repoIndexManifestKey("Acme", okBranchRepo),
      JSON.stringify(
        manifest({
          repo: okBranchRepo,
          owner: "Acme",
          actualRepo: "repo-a",
          branch: "dev",
          defaultBranch: "main",
          namespace: "acme/repo-a/__branch__/h646576",
        }),
      ),
    )
    store.set(
      repoIndexVectorsKey("Acme", okBranchRepo),
      JSON.stringify(
        vectors({
          repo: okBranchRepo,
          owner: "Acme",
          byPath: { "src/dev.ts": ["dev-id"] },
        }),
      ),
    )
    store.set(
      badManifestKey,
      JSON.stringify(
        manifest({
          repo: badBranchRepo,
          owner: "Acme",
          actualRepo: "repo-a",
          branch: "fail",
          defaultBranch: "main",
          namespace: "acme/repo-a/__branch__/h6661696c",
        }),
      ),
    )

    const kvWithTransientGet = {
      ...kv,
      async get(key: string): Promise<string | null> {
        if (key === badManifestKey) throw new Error("kv get transient")
        return kv.get(key)
      },
    } as Env["OPENCLAW_STATE"]

    const { env, deletedBatches } = makeEnv({ kv: kvWithTransientGet })
    const { results, anyError } = await handleInstallReposRemoved({
      env,
      installationId: 99,
      repositories: [{ full_name: "Acme/repo-a" }],
    })

    expect(anyError).toBe(true)
    expect(results.map((r) => r.status)).toEqual(["complete", "complete"])
    expect(store.has(repoIndexManifestKey("Acme", "repo-a"))).toBe(false)
    expect(store.has(repoIndexManifestKey("Acme", okBranchRepo))).toBe(false)
    expect(store.has(badManifestKey)).toBe(true)
    expect(new Set(deletedBatches.flat())).toEqual(new Set(["id-a1", "id-a2", "id-b1", "dev-id"]))
  })

  it("returns anyError=true when at least one repo's delete is partial", async () => {
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Acme", "repo-a"), JSON.stringify(manifest({ repo: "repo-a", owner: "Acme" })))
    store.set(repoIndexVectorsKey("Acme", "repo-a"), JSON.stringify(vectors({ repo: "repo-a", owner: "Acme" })))

    const { env } = makeEnv({
      kv,
      deleteByIdsImpl: async () => {
        throw new Error("vectorize down")
      },
    })
    const { anyError } = await handleInstallReposRemoved({
      env,
      installationId: 99,
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
    store.set(
      repoIndexManifestKey("OtherCorp", "repo-c"),
      JSON.stringify(manifest({ repo: "repo-c", owner: "OtherCorp" })),
    )

    const { env } = makeEnv({ kv })
    const { results } = await handleInstallationDeleted({
      env,
      installationId: 99,
      ownerLogin: "Acme",
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
      env,
      installationId: 99,
      ownerLogin: "Acme",
    })
    expect(anyError).toBe(true)
  })
})
