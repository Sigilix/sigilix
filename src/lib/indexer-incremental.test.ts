import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  mockGetInstallationToken,
  mockGetRepository,
  mockGetBranch,
  mockGetRepoTree,
  mockGetFileContent,
  mockAiRun,
  mockVectorizeUpsert,
  mockVectorizeDeleteByIds,
  mockDebugActiveGraphVersion,
} = vi.hoisted(() => ({
  mockGetInstallationToken: vi.fn(async (_args: unknown) => "test-token"),
  mockGetRepository: vi.fn(),
  mockGetBranch: vi.fn(),
  mockGetRepoTree: vi.fn(),
  mockGetFileContent: vi.fn(),
  mockAiRun: vi.fn(),
  mockVectorizeUpsert: vi.fn(
    async (..._args: unknown[]): Promise<{ ids: string[]; count: number }> => ({
      ids: [],
      count: 0,
    }),
  ),
  mockVectorizeDeleteByIds: vi.fn(async (..._args: unknown[]) => undefined),
  mockDebugActiveGraphVersion: vi.fn(async (..._args: unknown[]): Promise<string | null> => null),
}))

vi.mock("@/src/shared/adapters/github/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("@/src/shared/adapters/github", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/github")>("@/src/shared/adapters/github")
  class GitHubClientMock {
    async getRepository(owner: string, repo: string): Promise<unknown> {
      return mockGetRepository(owner, repo)
    }
    async getBranch(owner: string, repo: string, branch: string): Promise<unknown> {
      return mockGetBranch(owner, repo, branch)
    }
    async getRepoTree(owner: string, repo: string, treeSha: string): Promise<unknown> {
      return mockGetRepoTree(owner, repo, treeSha)
    }
    async getFileContent(owner: string, repo: string, path: string, ref: string): Promise<unknown> {
      return mockGetFileContent(owner, repo, path, ref)
    }
    async listOpenPullRequests(): Promise<unknown[]> {
      return []
    }
  }
  return {
    ...actual,
    GitHubClient: GitHubClientMock,
  }
})

vi.mock("@/src/lib/repo-graph-client", () => ({
  writeFileGraph: vi.fn(async (..._args: unknown[]) => undefined),
  commitGraph: vi.fn(async (..._args: unknown[]) => undefined),
  debugActiveGraphVersion: (...args: unknown[]) => mockDebugActiveGraphVersion(...args),
}))

import { handleIndexRepoJob } from "@/src/lib/indexer"
import { activeRunKey } from "@/src/lib/repo-index-active-run"
import { repoIndexManifestKey, type RepoIndexManifestV1 } from "@/src/lib/repo-index-manifest"
import { repoIndexVectorsKey, type RepoIndexVectorsV1 } from "@/src/lib/repo-index-vectors"
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "@/src/shared/adapters/model"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"

function makeKvStub(): { kv: Env["OPENCLAW_STATE"]; store: Map<string, string> } {
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

function makeEnv(): { env: Env; kv: Map<string, string> } {
  const { kv, store } = makeKvStub()
  const env = {
    OPENCLAW_STATE: kv,
    OPENCLAW_JOBS: { send: vi.fn(async (_message: JobMessage) => undefined) },
    AI: { run: (model: string, input: unknown) => mockAiRun(model, input) },
    OPENCLAW_CODE_INDEX: {
      upsert: mockVectorizeUpsert,
      deleteByIds: mockVectorizeDeleteByIds,
    },
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
  } as unknown as Env
  return { env, kv: store }
}

function seedIndexedRepo(kv: Map<string, string>): void {
  const manifest: RepoIndexManifestV1 = {
    v: 1,
    repo: "sigilix",
    owner: "Sigilix",
    actualRepo: "sigilix",
    defaultBranch: "main",
    namespace: "sigilix/sigilix",
    headSha: "a".repeat(40),
    runId: "old-run",
    fileCount: 3,
    chunkCount: 3,
    shardCount: 1,
    indexedAt: "2026-06-13T00:00:00.000Z",
    modelId: EMBEDDING_MODEL,
    embeddingDim: EMBEDDING_DIMENSIONS,
    chunkerVersion: 2,
    windowLines: 30,
    overlapLines: 10,
  }
  const vectors: RepoIndexVectorsV1 = {
    v: 1,
    owner: "Sigilix",
    repo: "sigilix",
    runId: "old-run",
    byPath: {
      "src/changed.ts": ["old-changed-id"],
      "src/deleted.ts": ["old-deleted-id"],
      "src/unchanged.ts": ["old-unchanged-id"],
    },
  }
  kv.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest))
  kv.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors))
}

function pushJobWithChangedPaths(): Extract<JobMessage, { type: "index-repo" }> {
  return {
    type: "index-repo",
    owner: "Sigilix",
    repo: "sigilix",
    installationId: 99,
    reason: "push",
    before: "a".repeat(40),
    changedPaths: {
      upsert: ["src/changed.ts"],
      remove: ["src/deleted.ts"],
    },
  } as unknown as Extract<JobMessage, { type: "index-repo" }>
}

beforeEach(() => {
  mockGetInstallationToken.mockClear()
  mockGetRepository.mockReset().mockResolvedValue({ default_branch: "main" })
  mockGetBranch.mockReset().mockResolvedValue({ headSha: "c".repeat(40), treeSha: "d".repeat(40) })
  mockGetRepoTree.mockReset().mockResolvedValue({
    tree: [
      { path: "src/changed.ts", type: "blob", size: 100 },
      { path: "src/unchanged.ts", type: "blob", size: 100 },
    ],
    truncated: false,
  })
  mockGetFileContent.mockReset().mockImplementation(async (_owner, _repo, path: string) => {
    if (path === "src/changed.ts") return "export const changed = 1\n"
    if (path === "src/unchanged.ts") return "export const unchanged = 1\n"
    return null
  })
  mockAiRun.mockReset().mockImplementation(async (_model: string, input: { text: string | string[] }) => {
    const texts = Array.isArray(input.text) ? input.text : [input.text]
    return { data: texts.map(() => new Array(EMBEDDING_DIMENSIONS).fill(0.5)) }
  })
  mockVectorizeUpsert.mockReset().mockResolvedValue({ ids: [], count: 0 })
  mockVectorizeDeleteByIds.mockReset().mockResolvedValue(undefined)
  mockDebugActiveGraphVersion.mockReset().mockResolvedValue(null)
})

describe("handleIndexRepoJob — incremental push indexing", () => {
  it("embeds only changed files and deletes stale vectors for changed/deleted paths", async () => {
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)

    await handleIndexRepoJob({ job: pushJobWithChangedPaths(), env })

    expect(mockGetFileContent).toHaveBeenCalledTimes(1)
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/changed.ts", "c".repeat(40))
    expect(mockGetFileContent).not.toHaveBeenCalledWith("Sigilix", "sigilix", "src/unchanged.ts", "c".repeat(40))
    expect(mockVectorizeDeleteByIds).toHaveBeenCalledWith(["old-changed-id", "old-deleted-id"])
    expect(mockVectorizeUpsert).toHaveBeenCalledTimes(1)

    const stored = kv.get(repoIndexManifestKey("Sigilix", "sigilix"))
    expect(stored).toBeTruthy()
    const manifest = JSON.parse(stored as string) as RepoIndexManifestV1
    expect(manifest.headSha).toBe("c".repeat(40))
    expect(manifest.fileCount).toBe(2)
    expect(manifest.chunkCount).toBe(2)

    const vectorsRaw = kv.get(repoIndexVectorsKey("Sigilix", "sigilix"))
    expect(vectorsRaw).toBeTruthy()
    const vectors = JSON.parse(vectorsRaw as string) as RepoIndexVectorsV1
    expect(vectors.runId).not.toBe("old-run")
    expect(vectors.byPath["src/unchanged.ts"]).toEqual(["old-unchanged-id"])
    expect(vectors.byPath["src/deleted.ts"]).toBeUndefined()
    expect(vectors.byPath["src/changed.ts"]).toHaveLength(1)
    expect(vectors.byPath["src/changed.ts"]).not.toContain("old-changed-id")
    const deletedIds = mockVectorizeDeleteByIds.mock.calls.flatMap((call) => call[0] as string[])
    expect(deletedIds).not.toEqual(expect.arrayContaining(vectors.byPath["src/changed.ts"] ?? []))
  })

  it("falls back to full indexing when the existing manifest does not match the push before SHA", async () => {
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)

    await handleIndexRepoJob({
      job: { ...pushJobWithChangedPaths(), before: "b".repeat(40) },
      env,
    })

    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/changed.ts", "c".repeat(40))
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/unchanged.ts", "c".repeat(40))
  })

  it("cleans up newly written vectors when superseded after embedding", async () => {
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)
    mockVectorizeUpsert.mockImplementationOnce(async (records: unknown) => {
      const vectorRecords = records as Array<{ id: string }>
      kv.set(
        activeRunKey("Sigilix", "sigilix"),
        JSON.stringify({ v: 1, runId: "newer-run", startedAt: "2026-06-13T00:00:01.000Z" }),
      )
      return { ids: vectorRecords.map((record) => record.id), count: vectorRecords.length }
    })

    await handleIndexRepoJob({ job: pushJobWithChangedPaths(), env })

    const deletedIds = mockVectorizeDeleteByIds.mock.calls.flatMap((call) => call[0] as string[])
    expect(deletedIds).toHaveLength(1)
    expect(deletedIds).not.toContain("old-changed-id")
    expect(deletedIds).not.toContain("old-deleted-id")

    const manifest = JSON.parse(kv.get(repoIndexManifestKey("Sigilix", "sigilix")) as string) as RepoIndexManifestV1
    expect(manifest.headSha).toBe("a".repeat(40))
  })

  it("falls back without deleting old vectors when a changed file produces no replacement ids", async () => {
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)
    mockGetFileContent.mockImplementation(async (_owner, _repo, path: string) => {
      if (path === "src/changed.ts") return null
      if (path === "src/unchanged.ts") return "export const unchanged = 1\n"
      return null
    })

    await handleIndexRepoJob({ job: pushJobWithChangedPaths(), env })

    const deletedIds = mockVectorizeDeleteByIds.mock.calls.flatMap((call) => call[0] as string[])
    expect(deletedIds).not.toContain("old-changed-id")
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/unchanged.ts", "c".repeat(40))
  })
})
