import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { deleteRepoIndex, handleInstallReposRemoved, handleInstallationDeleted } from "@/src/lib/index-delete"
import { makeEnv, makeKvStub, manifest, vectors } from "@/src/lib/index-delete.test-helpers"
import { stageRepoActiveIndexSlice } from "@/src/lib/repo-active-index"
import { repoIndexManifestKey } from "@/src/lib/repo-index-manifest"
import { repoIndexVectorsKey } from "@/src/lib/repo-index-vectors"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"

async function makeActiveIndexDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(
    readFileSync(new URL("../../migrations/0025_create_repo_active_index_stage.sql", import.meta.url), "utf8"),
  )
  return db
}

async function seedActiveRun(
  db: D1Database,
  githubRepoId: number,
  installationId = 99,
  runId = (githubRepoId % 16).toString(16).repeat(16),
): Promise<void> {
  await stageRepoActiveIndexSlice({
    db,
    githubRepoId,
    installationId,
    runId,
    totalFiles: 1,
    lo: 0,
    hi: 1,
    mode: "shadow",
    idsByPath: { "src/index.ts": ["a".repeat(48)] },
  })
}

async function activeRunCount(db: D1Database): Promise<number> {
  return (
    (await db.prepare("SELECT COUNT(*) AS count FROM repo_active_index_run").first<{ count: number }>())?.count ?? 0
  )
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

describe("deleteRepoIndex — immutable active index cleanup", () => {
  it("unions canonical active membership with the mutable deletion ledger", async () => {
    const canonicalOnlyId = "c".repeat(48)
    const { kv, store } = makeKvStub()
    store.set(
      repoIndexManifestKey("Sigilix", "sigilix"),
      JSON.stringify(
        manifest({
          githubRepoId: 808247824,
          activeIndex: {
            version: 1,
            githubRepoId: 808247824,
            builtMode: "on",
            byPath: { "src/canonical.ts": [canonicalOnlyId] },
          },
        }),
      ),
    )
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors()))
    const { env, deletedBatches } = makeEnv({ kv })

    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("complete")
    expect(result.vectorIds).toBe(4)
    expect(new Set(deletedBatches.flat())).toEqual(new Set(["id-a1", "id-a2", "id-b1", canonicalOnlyId]))
  })

  it("deletes exact staged state on a default-branch uninstall", async () => {
    const platformDb = await makeActiveIndexDb()
    await seedActiveRun(platformDb, 808247824)
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest({ githubRepoId: 808247824 })))
    store.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors({ githubRepoId: 808247824 })))
    const { env } = makeEnv({ kv, platformDb })

    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      reason: "install-deleted",
    })

    expect(result.status).toBe("complete")
    expect(await activeRunCount(platformDb)).toBe(0)
  })

  it("preserves staged state when deleting a branch-scoped index", async () => {
    const platformDb = await makeActiveIndexDb()
    await seedActiveRun(platformDb, 808247824)
    const { kv, store } = makeKvStub()
    store.set(
      repoIndexManifestKey("Sigilix", "sigilix/__branch__/h646576"),
      JSON.stringify(
        manifest({
          repo: "sigilix/__branch__/h646576",
          actualRepo: "sigilix",
          branch: "feature/something",
          githubRepoId: 808247824,
        }),
      ),
    )
    store.set(
      repoIndexVectorsKey("Sigilix", "sigilix/__branch__/h646576"),
      JSON.stringify(vectors({ repo: "sigilix/__branch__/h646576", githubRepoId: 808247824 })),
    )
    const { env } = makeEnv({ kv, platformDb })

    const result = await deleteRepoIndex({
      env,
      owner: "Sigilix",
      repo: "sigilix/__branch__/h646576",
      reason: "pr-branch-closed",
    })

    expect(result.status).toBe("complete")
    expect(await activeRunCount(platformDb)).toBe(1)
  })
})

describe("handleInstallReposRemoved — immutable active index cleanup", () => {
  it("still deletes exact staging when a trusted payload id has an invalid display name", async () => {
    const platformDb = await makeActiveIndexDb()
    await seedActiveRun(platformDb, 101)
    const { env } = makeEnv({ platformDb })

    const { results, anyError } = await handleInstallReposRemoved({
      env,
      installationId: 99,
      repositories: [{ id: 101, full_name: "invalid no slash" }],
    })

    expect(results).toEqual([])
    expect(anyError).toBe(false)
    expect(await activeRunCount(platformDb)).toBe(0)
  })

  it("deletes pre-manifest staging by the removed repository's immutable payload ID", async () => {
    const platformDb = await makeActiveIndexDb()
    await seedActiveRun(platformDb, 101)
    await seedActiveRun(platformDb, 202)
    const { env } = makeEnv({ platformDb })

    const { anyError } = await handleInstallReposRemoved({
      env,
      installationId: 99,
      repositories: [{ id: 101, full_name: "Acme/repo-a" }],
    })

    expect(anyError).toBe(false)
    const rows = await platformDb
      .prepare("SELECT github_repo_id FROM repo_active_index_run")
      .all<{ github_repo_id: number }>()
    expect(rows.results).toEqual([{ github_repo_id: 202 }])
  })

  it("preserves a transferred repository's staging under a different installation", async () => {
    const platformDb = await makeActiveIndexDb()
    await seedActiveRun(platformDb, 101, 99, "a".repeat(16))
    await seedActiveRun(platformDb, 101, 100, "b".repeat(16))
    const { kv, store } = makeKvStub()
    store.set(
      repoIndexManifestKey("Acme", "repo-a"),
      JSON.stringify(manifest({ repo: "repo-a", owner: "Acme", githubRepoId: 101 })),
    )
    const { env } = makeEnv({ kv, platformDb })

    const { anyError } = await handleInstallReposRemoved({
      env,
      installationId: 99,
      repositories: [{ id: 101, full_name: "Acme/repo-a" }],
    })

    expect(anyError).toBe(false)
    const rows = await platformDb
      .prepare("SELECT installation_id FROM repo_active_index_run WHERE github_repo_id = ?")
      .bind(101)
      .all<{ installation_id: number }>()
    expect(rows.results).toEqual([{ installation_id: 100 }])
  })

  it("recovers an id-less removal from the owner-safe manifest and preserves a new installation", async () => {
    const platformDb = await makeActiveIndexDb()
    await seedActiveRun(platformDb, 101, 99, "a".repeat(16))
    await seedActiveRun(platformDb, 101, 100, "b".repeat(16))
    const { kv, store } = makeKvStub()
    store.set(
      repoIndexManifestKey("Acme", "repo-a"),
      JSON.stringify(manifest({ repo: "repo-a", owner: "Acme", githubRepoId: 101 })),
    )
    const { env } = makeEnv({ kv, platformDb })

    const { anyError } = await handleInstallReposRemoved({
      env,
      installationId: 99,
      repositories: [{ full_name: "Acme/repo-a" }],
    })

    expect(anyError).toBe(false)
    const rows = await platformDb
      .prepare("SELECT installation_id FROM repo_active_index_run WHERE github_repo_id = ?")
      .bind(101)
      .all<{ installation_id: number }>()
    expect(rows.results).toEqual([{ installation_id: 100 }])
  })

  it("marks an id-less removal partial when no owner-safe immutable id can be recovered", async () => {
    const platformDb = await makeActiveIndexDb()
    await seedActiveRun(platformDb, 101, 99)
    const { kv, store } = makeKvStub()
    store.set(repoIndexManifestKey("Acme", "repo-a"), JSON.stringify(manifest({ repo: "repo-a", owner: "Acme" })))
    const { env } = makeEnv({ kv, platformDb })

    const { results, anyError } = await handleInstallReposRemoved({
      env,
      installationId: 99,
      repositories: [{ full_name: "Acme/repo-a" }],
    })

    expect(anyError).toBe(true)
    expect(results[0]?.status).toBe("partial")
    expect(results[0]?.errors).toContain("d1.delete(repo-active-index): immutable repository id unavailable")
    expect(await activeRunCount(platformDb)).toBe(1)
    expect(store.has(repoIndexManifestKey("Acme", "repo-a"))).toBe(true)
  })
})

describe("handleInstallationDeleted — immutable active index cleanup", () => {
  it("deletes every staged run for the installation even before manifests exist", async () => {
    const platformDb = await makeActiveIndexDb()
    await seedActiveRun(platformDb, 101, 99)
    await seedActiveRun(platformDb, 202, 100)
    const { env } = makeEnv({ platformDb })

    const { anyError } = await handleInstallationDeleted({
      env,
      installationId: 99,
      ownerLogin: "Acme",
    })

    expect(anyError).toBe(false)
    const rows = await platformDb
      .prepare("SELECT github_repo_id FROM repo_active_index_run")
      .all<{ github_repo_id: number }>()
    expect(rows.results).toEqual([{ github_repo_id: 202 }])
  })

  it("does not let a delayed uninstall erase staging from a new installation", async () => {
    const platformDb = await makeActiveIndexDb()
    await seedActiveRun(platformDb, 101, 99, "a".repeat(16))
    await seedActiveRun(platformDb, 101, 100, "b".repeat(16))
    const { kv, store } = makeKvStub()
    store.set(
      repoIndexManifestKey("Acme", "repo-a"),
      JSON.stringify(manifest({ repo: "repo-a", owner: "Acme", githubRepoId: 101 })),
    )
    const { env } = makeEnv({ kv, platformDb })

    const { anyError } = await handleInstallationDeleted({
      env,
      installationId: 99,
      ownerLogin: "Acme",
    })

    expect(anyError).toBe(false)
    const rows = await platformDb
      .prepare("SELECT installation_id FROM repo_active_index_run WHERE github_repo_id = ?")
      .bind(101)
      .all<{ installation_id: number }>()
    expect(rows.results).toEqual([{ installation_id: 100 }])
  })
})
