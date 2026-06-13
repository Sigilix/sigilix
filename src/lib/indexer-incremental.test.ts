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
import { collectPushChangedPaths } from "@/src/lib/index-producer"
import { activeRunKey } from "@/src/lib/repo-index-active-run"
import { repoIndexManifestKey, type RepoIndexManifestV1 } from "@/src/lib/repo-index-manifest"
import { repoIndexVectorsKey, type RepoIndexVectorsV1 } from "@/src/lib/repo-index-vectors"
import { handlePushEvent } from "@/src/index-internals"
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

function makeEnv(opts: { getImpl?: (key: string, store: Map<string, string>) => Promise<string | null> } = {}): {
  env: Env
  kv: Map<string, string>
  sent: JobMessage[]
} {
  const { kv, store } = makeKvStub()
  const sent: JobMessage[] = []
  const state =
    opts.getImpl === undefined
      ? kv
      : ({
          ...kv,
          get: (key: string) => opts.getImpl?.(key, store) ?? kv.get(key),
        } as unknown as Env["OPENCLAW_STATE"])
  const env = {
    OPENCLAW_STATE: state,
    OPENCLAW_JOBS: {
      send: vi.fn(async (message: JobMessage) => {
        sent.push(message)
      }),
    },
    OPENCLAW_INDEXER_ENABLED: "on",
    AI: { run: (model: string, input: unknown) => mockAiRun(model, input) },
    OPENCLAW_CODE_INDEX: {
      upsert: mockVectorizeUpsert,
      deleteByIds: mockVectorizeDeleteByIds,
    },
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
  } as unknown as Env
  return { env, kv: store, sent }
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
  it("threads complete push changed paths from webhook enqueue to incremental consumption", async () => {
    const { env, sent, kv } = makeEnv()
    seedIndexedRepo(kv)
    mockGetRepository.mockResolvedValue({ id: 808247824, default_branch: "main" })
    const commits = [
      {
        id: "1".repeat(40),
        added: ["src/changed.ts"],
        modified: ["src/ignored.md"],
        removed: ["src/deleted.ts"],
      },
    ]

    const response = await handlePushEvent({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      installationId: 99,
      payload: {
        ref: "refs/heads/main",
        before: "a".repeat(40),
        after: "c".repeat(40),
        size: commits.length,
        commits,
        repository: { id: 808247824 },
      } as unknown as Parameters<typeof handlePushEvent>[0]["payload"],
    })

    expect(response.status).toBe(202)
    expect(collectPushChangedPaths(commits, commits.length)).toEqual({
      upsert: ["src/changed.ts", "src/ignored.md"],
      remove: ["src/deleted.ts"],
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: "index-repo",
      owner: "Sigilix",
      repo: "sigilix",
      githubRepoId: 808247824,
      installationId: 99,
      reason: "push",
      before: "a".repeat(40),
      changedPaths: {
        upsert: ["src/changed.ts", "src/ignored.md"],
        remove: ["src/deleted.ts"],
      },
    })

    await handleIndexRepoJob({ job: sent[0] as Extract<JobMessage, { type: "index-repo" }>, env })

    expect(mockGetFileContent).toHaveBeenCalledTimes(1)
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/changed.ts", "c".repeat(40))
    expect(mockGetFileContent).not.toHaveBeenCalledWith("Sigilix", "sigilix", "src/unchanged.ts", "c".repeat(40))
  })

  it("omits changed paths from webhook enqueue when the push commit list is truncated", async () => {
    const { env, sent, kv } = makeEnv()
    seedIndexedRepo(kv)
    mockGetRepository.mockResolvedValue({ id: 808247824, default_branch: "main" })
    const commits = Array.from({ length: 20 }, (_value, i) => ({
      id: String(i).padStart(40, "0"),
      modified: [`src/${i}.ts`],
    }))

    const response = await handlePushEvent({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      installationId: 99,
      payload: {
        ref: "refs/heads/main",
        before: "a".repeat(40),
        after: "c".repeat(40),
        size: 21,
        commits,
        repository: { id: 808247824 },
      } as unknown as Parameters<typeof handlePushEvent>[0]["payload"],
    })

    expect(response.status).toBe(202)
    expect(collectPushChangedPaths(commits, 21)).toBeUndefined()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: "index-repo",
      owner: "Sigilix",
      repo: "sigilix",
      githubRepoId: 808247824,
      installationId: 99,
      reason: "push",
    })
    expect(sent[0]).not.toHaveProperty("changedPaths")
  })

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

  it("logs when lexical cleanup is skipped because the D1 binding is absent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      const { env, kv } = makeEnv()
      seedIndexedRepo(kv)

      await handleIndexRepoJob({ job: pushJobWithChangedPaths(), env })

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("index-incremental-lexical-cleanup-skipped"))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("old-id-cleanup"))
    } finally {
      warn.mockRestore()
    }
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

  it("does not delete content-addressed vectors when superseded after embedding", async () => {
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
    expect(deletedIds).toHaveLength(0)

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

  it("preserves old vectors when the incremental vector ledger write fails", async () => {
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)
    const originalPut = env.OPENCLAW_STATE.put.bind(env.OPENCLAW_STATE)
    let vectorLedgerWrites = 0
    env.OPENCLAW_STATE.put = vi.fn(async (key: string, value: string, options?: unknown) => {
      if (key === repoIndexVectorsKey("Sigilix", "sigilix")) {
        vectorLedgerWrites += 1
        if (vectorLedgerWrites === 2) throw new Error("kv down")
      }
      return originalPut(key, value, options as never)
    }) as Env["OPENCLAW_STATE"]["put"]

    await expect(handleIndexRepoJob({ job: pushJobWithChangedPaths(), env })).rejects.toThrow(
      /repo-index-vectors incremental write failed/,
    )

    expect(mockVectorizeDeleteByIds).not.toHaveBeenCalledWith(["old-changed-id", "old-deleted-id"])
    const manifest = JSON.parse(kv.get(repoIndexManifestKey("Sigilix", "sigilix")) as string) as RepoIndexManifestV1
    expect(manifest.headSha).toBe("a".repeat(40))
  })

  it("skips finalization when the active run changes immediately before the vector ledger write", async () => {
    let activeReads = 0
    const { env, kv } = makeEnv({
      getImpl: async (key, store) => {
        if (key !== activeRunKey("Sigilix", "sigilix")) return store.get(key) ?? null
        activeReads += 1
        if (activeReads < 3) return store.get(key) ?? null
        return JSON.stringify({ v: 1, runId: "newer-run", startedAt: "2026-06-13T00:00:01.000Z" })
      },
    })
    seedIndexedRepo(kv)

    await handleIndexRepoJob({ job: pushJobWithChangedPaths(), env })

    const vectors = JSON.parse(kv.get(repoIndexVectorsKey("Sigilix", "sigilix")) as string) as RepoIndexVectorsV1
    expect(vectors.runId).toBe("old-run")
    const deletedIds = mockVectorizeDeleteByIds.mock.calls.flatMap((call) => call[0] as string[])
    expect(deletedIds).toHaveLength(0)
    const manifest = JSON.parse(kv.get(repoIndexManifestKey("Sigilix", "sigilix")) as string) as RepoIndexManifestV1
    expect(manifest.headSha).toBe("a".repeat(40))
  })

  it("skips manifest finalization when the active run changes after the vector ledger write", async () => {
    let activeReads = 0
    const { env, kv } = makeEnv({
      getImpl: async (key, store) => {
        if (key !== activeRunKey("Sigilix", "sigilix")) return store.get(key) ?? null
        activeReads += 1
        if (activeReads < 4) return store.get(key) ?? null
        return JSON.stringify({ v: 1, runId: "newer-run", startedAt: "2026-06-13T00:00:01.000Z" })
      },
    })
    seedIndexedRepo(kv)

    await handleIndexRepoJob({ job: pushJobWithChangedPaths(), env })

    const deletedIds = mockVectorizeDeleteByIds.mock.calls.flatMap((call) => call[0] as string[])
    expect(deletedIds).toHaveLength(0)
    const manifest = JSON.parse(kv.get(repoIndexManifestKey("Sigilix", "sigilix")) as string) as RepoIndexManifestV1
    expect(manifest.headSha).toBe("a".repeat(40))
  })

  it("retries without old-vector cleanup when superseded during the manifest write window", async () => {
    let activeReads = 0
    const { env, kv } = makeEnv({
      getImpl: async (key, store) => {
        if (key !== activeRunKey("Sigilix", "sigilix")) return store.get(key) ?? null
        activeReads += 1
        if (activeReads < 5) return store.get(key) ?? null
        return JSON.stringify({ v: 1, runId: "newer-run", startedAt: "2026-06-13T00:00:01.000Z" })
      },
    })
    seedIndexedRepo(kv)

    await expect(handleIndexRepoJob({ job: pushJobWithChangedPaths(), env })).rejects.toThrow(
      /repo-index-manifest superseded after incremental write/,
    )

    const deletedIds = mockVectorizeDeleteByIds.mock.calls.flatMap((call) => call[0] as string[])
    expect(deletedIds).toHaveLength(0)
    const manifest = JSON.parse(kv.get(repoIndexManifestKey("Sigilix", "sigilix")) as string) as RepoIndexManifestV1
    expect(manifest.headSha).toBe("c".repeat(40))
  })

  it("retries without old-vector cleanup when superseded immediately before cleanup", async () => {
    let activeReads = 0
    const { env, kv } = makeEnv({
      getImpl: async (key, store) => {
        if (key !== activeRunKey("Sigilix", "sigilix")) return store.get(key) ?? null
        activeReads += 1
        if (activeReads < 6) return store.get(key) ?? null
        return JSON.stringify({ v: 1, runId: "newer-run", startedAt: "2026-06-13T00:00:01.000Z" })
      },
    })
    seedIndexedRepo(kv)

    await expect(handleIndexRepoJob({ job: pushJobWithChangedPaths(), env })).rejects.toThrow(
      /repo-index old-id cleanup superseded after incremental write/,
    )

    const deletedIds = mockVectorizeDeleteByIds.mock.calls.flatMap((call) => call[0] as string[])
    expect(deletedIds).toHaveLength(0)
    const manifest = JSON.parse(kv.get(repoIndexManifestKey("Sigilix", "sigilix")) as string) as RepoIndexManifestV1
    expect(manifest.headSha).toBe("c".repeat(40))
  })

  it("preserves old IDs that the current vector ledger still references during cleanup", async () => {
    let vectorReads = 0
    const { env, kv } = makeEnv({
      getImpl: async (key, store) => {
        if (key !== repoIndexVectorsKey("Sigilix", "sigilix")) return store.get(key) ?? null
        vectorReads += 1
        if (vectorReads < 2) return store.get(key) ?? null
        const current = JSON.parse(store.get(key) as string) as RepoIndexVectorsV1
        return JSON.stringify({
          ...current,
          byPath: {
            ...current.byPath,
            "src/reverted.ts": ["old-changed-id"],
          },
        })
      },
    })
    seedIndexedRepo(kv)

    await handleIndexRepoJob({ job: pushJobWithChangedPaths(), env })

    const deletedIds = mockVectorizeDeleteByIds.mock.calls.flatMap((call) => call[0] as string[])
    expect(deletedIds).not.toContain("old-changed-id")
    expect(deletedIds).toContain("old-deleted-id")
  })
})
