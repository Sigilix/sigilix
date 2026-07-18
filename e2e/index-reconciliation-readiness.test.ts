import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { mockListInstallations, mockListRepositories } = vi.hoisted(() => ({
  mockListInstallations: vi.fn(),
  mockListRepositories: vi.fn(),
}))

vi.mock("@/src/shared/adapters/github/github-app", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/github/github-app")>(
    "@/src/shared/adapters/github/github-app",
  )
  return {
    ...actual,
    listAppInstallationIds: (...args: unknown[]) => mockListInstallations(...args),
    listInstallationRepoFullNames: (...args: unknown[]) => mockListRepositories(...args),
  }
})

import worker from "@/src/index"
import { CITATION_CHUNK_VERSION } from "@/src/lib/chunk-core"
import { repoIndexManifestKey, repoTenantKey, type RepoIndexManifestV1 } from "@/src/lib/repo-index-manifest"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"

const ADMIN_TOKEN = "test-admin-token"
const INSTALLATION_ID = 99
const GITHUB_REPO_ID = 808247824
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8")

function configured(name: string): string | undefined {
  return new RegExp(`^${name}\\s*=\\s*"([^"]*)"$`, "mu").exec(wrangler)?.[1]
}

function manifest(builtMode: "shadow" | "on"): RepoIndexManifestV1 {
  return {
    v: 1,
    repo: "api",
    owner: "acme",
    githubRepoId: GITHUB_REPO_ID,
    headSha: "a".repeat(40),
    runId: "0123456789abcdef",
    fileCount: 1,
    chunkCount: 1,
    shardCount: 1,
    indexedAt: "2026-07-18T00:00:00.000Z",
    modelId: "@cf/baai/bge-base-en-v1.5",
    embeddingDim: 768,
    chunkerVersion: 2,
    citationChunkVersion: CITATION_CHUNK_VERSION,
    windowLines: 30,
    overlapLines: 10,
    activeIndex: { version: 1, githubRepoId: GITHUB_REPO_ID, builtMode, byPath: {} },
  }
}

function makeHarness(initialManifest: RepoIndexManifestV1): {
  env: Env
  sent: JobMessage[]
  store: Map<string, string>
} {
  const sent: JobMessage[] = []
  const store = new Map<string, string>()
  const writeManifest = (value: RepoIndexManifestV1) => {
    const raw = JSON.stringify(value)
    store.set(repoIndexManifestKey("acme", "api"), raw)
    store.set(repoTenantKey(GITHUB_REPO_ID), raw)
  }
  writeManifest(initialManifest)
  const state = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  } as unknown as KVNamespace
  return {
    sent,
    store,
    env: {
      OPENCLAW_ADMIN_TOKEN: ADMIN_TOKEN,
      GITHUB_APP_ID: "12345",
      GITHUB_PRIVATE_KEY: "test-key",
      OPENCLAW_STATE: state,
      OPENCLAW_JOBS: { send: async (job: JobMessage) => void sent.push(job) },
      OPENCLAW_REPO_ACTIVE_INDEX_MODE: "on",
      SIGILIX_PLATFORM_DB: {} as D1Database,
    } as unknown as Env,
  }
}

function request(dryRun: boolean): Request {
  return new Request(`https://api.sigilix.ai/admin/index-reconcile?dryRun=${dryRun}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  })
}

beforeEach(() => {
  mockListInstallations.mockReset().mockResolvedValue({ items: [INSTALLATION_ID], complete: true })
  mockListRepositories.mockReset().mockResolvedValue({ items: ["acme/api"], complete: true })
})

describe("index reconciliation rollout readiness", () => {
  it("promotes only the active-index writer while strict Slack reads remain shadowed", () => {
    expect(configured("SIGILIX_REPO_ACTIVE_INDEX_MODE")).toBe("on")
    expect(configured("SIGILIX_SLACK_CODE_CITATIONS_MODE")).toBe("shadow")
    expect(configured("SIGILIX_SLACK_MEMORY_SCOPE_MODE")).toBe("shadow")
  })

  it("enqueues a shadow-built repo, then reports ready after its exact on-built manifest lands", async () => {
    const { env, sent, store } = makeHarness(manifest("shadow"))

    const backfill = await worker.fetch(request(false), env, ctx)

    expect(backfill.status).toBe(200)
    await expect(backfill.json()).resolves.toMatchObject({
      activeIndexMode: "on",
      reposChecked: 1,
      reposMissingActiveIndex: 1,
      reposReady: 0,
      ready: false,
      enqueued: 1,
    })
    expect(sent).toEqual([
      expect.objectContaining({
        type: "index-repo",
        owner: "acme",
        repo: "api",
        installationId: INSTALLATION_ID,
        reason: "manual",
      }),
    ])

    const onManifest = manifest("on")
    const raw = JSON.stringify(onManifest)
    store.set(repoIndexManifestKey("acme", "api"), raw)

    const mismatchedTenant = await worker.fetch(request(true), env, ctx)

    expect(mismatchedTenant.status).toBe(200)
    await expect(mismatchedTenant.json()).resolves.toMatchObject({
      reposMissingActiveIndex: 1,
      reposReady: 0,
      ready: false,
      enqueued: 0,
    })

    store.set(repoTenantKey(GITHUB_REPO_ID), raw)

    const readiness = await worker.fetch(request(true), env, ctx)

    expect(readiness.status).toBe(200)
    await expect(readiness.json()).resolves.toMatchObject({
      activeIndexMode: "on",
      reposChecked: 1,
      reposMissingCitationMetadata: 0,
      reposMissingActiveIndex: 0,
      activeIndexReadErrors: 0,
      reposReady: 1,
      ready: true,
      enqueued: 0,
    })
    expect(sent).toHaveLength(1)
  })
})
