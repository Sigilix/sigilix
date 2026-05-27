// SIG-243 Phase 3 — unit tests for the per-repo migration helper.
//
// The full `migrateInstallToRepoId` enumeration path uses
// `listInstallationRepoFullNames` (real GitHub App token mint) which
// is exercised by SIG-156 backfill tests in a different file. Here we
// focus on the per-repo state machine: what `migrateOneRepo` returns
// for each of the eight outcomes (migrated, already-migrated,
// manifest-missing, manifest-invalid, github-404, github-no-id,
// github-error, kv-write-failed).

import { describe, expect, it } from "vitest"
import { migrateOneRepo } from "../src/lib/index-migrate-to-repo-id"
import { GitHubClient } from "../src/lib/github"
import type { Env } from "../src/index"
import type { RepoIndexManifestV1 } from "../src/lib/repo-index-manifest"

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

function makeClient(getRepository: (owner: string, repo: string) => Promise<{ default_branch: string; id: number | undefined } | null>): GitHubClient {
  return { getRepository } as unknown as GitHubClient
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

describe("migrateOneRepo — outcome state machine", () => {
  it("returns 'manifest-missing' when no manifest exists at the legacy key", async () => {
    const { kv } = makeKvStub()
    const client = makeClient(async () => null)
    const outcome = await migrateOneRepo(makeEnv(kv), client, "Arc-and-Anchor", "sigilix")
    expect(outcome.status).toBe("manifest-missing")
  })

  it("returns 'manifest-invalid' when the legacy manifest has bad shape", async () => {
    const { kv, store } = makeKvStub()
    store.set("repo-index-manifest:arc-and-anchor/sigilix", "{not json}")
    const client = makeClient(async () => null)
    const outcome = await migrateOneRepo(makeEnv(kv), client, "Arc-and-Anchor", "sigilix")
    expect(outcome.status).toBe("manifest-invalid")
  })

  it("returns 'already-migrated' when manifest already has a positive integer githubRepoId", async () => {
    const { kv, store } = makeKvStub()
    store.set(
      "repo-index-manifest:arc-and-anchor/sigilix",
      JSON.stringify({ ...SAMPLE_MANIFEST, githubRepoId: 808247824 }),
    )
    const client = makeClient(async () => {
      throw new Error("should not be called — manifest already migrated")
    })
    const outcome = await migrateOneRepo(makeEnv(kv), client, "Arc-and-Anchor", "sigilix")
    expect(outcome.status).toBe("already-migrated")
    expect(outcome.githubRepoId).toBe(808247824)
  })

  it("returns 'github-404' when the GitHub repo is gone", async () => {
    const { kv, store } = makeKvStub()
    store.set("repo-index-manifest:arc-and-anchor/sigilix", JSON.stringify(SAMPLE_MANIFEST))
    const client = makeClient(async () => null)
    const outcome = await migrateOneRepo(makeEnv(kv), client, "Arc-and-Anchor", "sigilix")
    expect(outcome.status).toBe("github-404")
  })

  it("returns 'github-no-id' when GitHub responds without a positive integer id", async () => {
    const { kv, store } = makeKvStub()
    store.set("repo-index-manifest:arc-and-anchor/sigilix", JSON.stringify(SAMPLE_MANIFEST))
    const client = makeClient(async () => ({ default_branch: "main", id: undefined }))
    const outcome = await migrateOneRepo(makeEnv(kv), client, "Arc-and-Anchor", "sigilix")
    expect(outcome.status).toBe("github-no-id")
  })

  it("returns 'github-error' when the GitHub call throws (e.g. transient 502)", async () => {
    const { kv, store } = makeKvStub()
    store.set("repo-index-manifest:arc-and-anchor/sigilix", JSON.stringify(SAMPLE_MANIFEST))
    const client = makeClient(async () => {
      throw new Error("github 502")
    })
    const outcome = await migrateOneRepo(makeEnv(kv), client, "Arc-and-Anchor", "sigilix")
    expect(outcome.status).toBe("github-error")
    expect(outcome.detail).toContain("github 502")
  })

  it("returns 'migrated' on the happy path and writes the new manifest with the ID set", async () => {
    const { kv, store } = makeKvStub()
    store.set("repo-index-manifest:arc-and-anchor/sigilix", JSON.stringify(SAMPLE_MANIFEST))
    const client = makeClient(async () => ({ default_branch: "main", id: 808247824 }))
    const outcome = await migrateOneRepo(makeEnv(kv), client, "Arc-and-Anchor", "sigilix")
    expect(outcome.status).toBe("migrated")
    expect(outcome.githubRepoId).toBe(808247824)

    // Phase 2 dual-write fires — both the legacy key AND the new
    // tenant key should now exist with the ID-populated payload.
    expect(store.has("repo-index-manifest:arc-and-anchor/sigilix")).toBe(true)
    expect(store.has("repo-tenant:808247824")).toBe(true)
    const written = JSON.parse(store.get("repo-tenant:808247824")!)
    expect(written.githubRepoId).toBe(808247824)
  })

  it("returns 'kv-write-failed' when the manifest write throws", async () => {
    const { store } = makeKvStub()
    store.set("repo-index-manifest:arc-and-anchor/sigilix", JSON.stringify(SAMPLE_MANIFEST))
    // KV stub whose `put` throws — simulates a transient KV outage
    // during the migration write.
    const explodingKv = {
      async get(key: string): Promise<string | null> { return store.get(key) ?? null },
      async put(): Promise<void> { throw new Error("KV transient") },
      async delete(): Promise<void> {},
    } as unknown as Env["OPENCLAW_STATE"]
    const env = { OPENCLAW_STATE: explodingKv } as unknown as Env
    const client = makeClient(async () => ({ default_branch: "main", id: 808247824 }))
    const outcome = await migrateOneRepo(env, client, "Arc-and-Anchor", "sigilix")
    expect(outcome.status).toBe("kv-write-failed")
    expect(outcome.detail).toContain("KV transient")
  })

  it("re-reads the manifest right before write (TOCTOU) and prefers the freshest stored snapshot", async () => {
    // SIG-243 Phase 3 / CR Critical: a concurrent push + index run
    // could land a new manifest (with new headSha/runId) between
    // the initial read and the migration write. Without re-read,
    // the naive `{...manifest, githubRepoId}` would clobber the
    // newer state. This test simulates that race by mutating the
    // stored manifest between the initial read and the second read
    // inside migrateOneRepo.
    const { kv, store } = makeKvStub()
    store.set("repo-index-manifest:arc-and-anchor/sigilix", JSON.stringify(SAMPLE_MANIFEST))
    let getCalls = 0
    const client = makeClient(async () => {
      // After the initial manifest read inside migrateOneRepo, but
      // before the GitHub API call returns, simulate a concurrent
      // re-index landing — bump `headSha` and `runId` in KV.
      getCalls += 1
      if (getCalls === 1) {
        store.set(
          "repo-index-manifest:arc-and-anchor/sigilix",
          JSON.stringify({
            ...SAMPLE_MANIFEST,
            headSha: "f".repeat(40),
            runId: "fedcba9876543210",
            fileCount: 99,
          }),
        )
      }
      return { default_branch: "main", id: 808247824 }
    })
    const outcome = await migrateOneRepo(makeEnv(kv), client, "Arc-and-Anchor", "sigilix")
    expect(outcome.status).toBe("migrated")

    // The written manifest preserves the FRESHER headSha + runId
    // (from the simulated concurrent re-index) and only patches the
    // githubRepoId field on top. The original "a".repeat(40) headSha
    // must NOT be on the post-write record.
    const written = JSON.parse(store.get("repo-tenant:808247824")!)
    expect(written.headSha).toBe("f".repeat(40))
    expect(written.runId).toBe("fedcba9876543210")
    expect(written.fileCount).toBe(99)
    expect(written.githubRepoId).toBe(808247824)
  })

  it("idempotent: re-running on a just-migrated repo returns 'already-migrated' without re-fetching from GitHub", async () => {
    const { kv, store } = makeKvStub()
    store.set("repo-index-manifest:arc-and-anchor/sigilix", JSON.stringify(SAMPLE_MANIFEST))
    let getCalls = 0
    const client = makeClient(async () => {
      getCalls += 1
      return { default_branch: "main", id: 808247824 }
    })

    const first = await migrateOneRepo(makeEnv(kv), client, "Arc-and-Anchor", "sigilix")
    expect(first.status).toBe("migrated")
    expect(getCalls).toBe(1)

    const second = await migrateOneRepo(makeEnv(kv), client, "Arc-and-Anchor", "sigilix")
    expect(second.status).toBe("already-migrated")
    // Second call must NOT have hit GitHub — saves API quota across
    // operator re-runs.
    expect(getCalls).toBe(1)
  })
})
