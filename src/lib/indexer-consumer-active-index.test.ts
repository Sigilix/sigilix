import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  mockGetInstallationToken,
  mockGetRepository,
  mockGetBranch,
  mockGetRepoTree,
  mockGetFileContent,
  mockAiRun,
  mockVectorizeUpsert,
  mockWriteFileGraph,
  mockCommitGraph,
} = vi.hoisted(() => ({
  mockGetInstallationToken: vi.fn(async (_args: unknown) => "test-token"),
  mockGetRepository: vi.fn(),
  mockGetBranch: vi.fn(),
  mockGetRepoTree: vi.fn(),
  mockGetFileContent: vi.fn(),
  mockAiRun: vi.fn(),
  mockVectorizeUpsert: vi.fn(async (..._args: unknown[]) => ({ ids: [], count: 0 })),
  mockWriteFileGraph: vi.fn(async (..._args: unknown[]) => undefined),
  mockCommitGraph: vi.fn(async (..._args: unknown[]) => undefined),
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
  return { ...actual, GitHubClient: GitHubClientMock }
})

vi.mock("@/src/lib/repo-graph-client", () => ({
  writeFileGraph: (...args: unknown[]) => mockWriteFileGraph(...args),
  commitGraph: (...args: unknown[]) => mockCommitGraph(...args),
  debugActiveGraphVersion: vi.fn(async () => null),
}))

import { handleIndexRepoJob, MAX_FILES_PER_JOB } from "@/src/lib/indexer"
import { repoIndexManifestKey, type RepoIndexManifestV1 } from "@/src/lib/repo-index-manifest"
import { EMBEDDING_DIMENSIONS } from "@/src/shared/adapters/model"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"

async function makeActiveIndexDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(
    readFileSync(new URL("../../migrations/0025_create_repo_active_index_stage.sql", import.meta.url), "utf8"),
  )
  return db
}

interface Sent {
  message: JobMessage
}

function makeEnv(activeIndexDb: D1Database): { env: Env; sent: Sent[]; kv: Map<string, string> } {
  const store = new Map<string, string>()
  const sent: Sent[] = []
  const env = {
    OPENCLAW_STATE: {
      async get(key: string): Promise<string | null> {
        return store.get(key) ?? null
      },
      async put(key: string, value: string): Promise<void> {
        store.set(key, value)
      },
      async delete(key: string): Promise<void> {
        store.delete(key)
      },
    },
    OPENCLAW_JOBS: {
      send: async (message: JobMessage) => {
        sent.push({ message })
      },
    },
    AI: { run: (model: string, input: unknown) => mockAiRun(model, input) },
    OPENCLAW_CODE_INDEX: { upsert: mockVectorizeUpsert },
    SIGILIX_PLATFORM_DB: activeIndexDb,
    OPENCLAW_REPO_ACTIVE_INDEX_MODE: "on",
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
  } as unknown as Env
  return { env, sent, kv: store }
}

type IndexRepoMessage = Extract<JobMessage, { type: "index-repo" }>

function bootstrapJob(): IndexRepoMessage {
  return {
    type: "index-repo",
    owner: "Sigilix",
    repo: "sigilix",
    installationId: 99,
    reason: "install",
  }
}

beforeEach(() => {
  mockGetInstallationToken.mockClear()
  mockGetRepository.mockReset().mockResolvedValue({ default_branch: "main", id: 808247824 })
  mockGetBranch.mockReset().mockResolvedValue({ headSha: "a".repeat(40), treeSha: "b".repeat(40) })
  mockGetRepoTree.mockReset()
  mockGetFileContent
    .mockReset()
    .mockImplementation(async (_o, _r, path: string) => `// content of ${path}\nconsole.log("hi")`)
  mockAiRun.mockReset().mockImplementation(async (_model: string, input: { text: string | string[] }) => {
    const texts = Array.isArray(input.text) ? input.text : [input.text]
    return { data: texts.map(() => new Array(EMBEDDING_DIMENSIONS).fill(0.5)) }
  })
  mockVectorizeUpsert.mockReset().mockResolvedValue({ ids: [], count: 0 })
  mockWriteFileGraph.mockReset().mockResolvedValue(undefined)
  mockCommitGraph.mockReset().mockResolvedValue(undefined)
})

describe("handleIndexRepoJob — immutable active index across a shard chain", () => {
  it("repairs a sealed divergent final replay with the canonical snapshot's chunk count", async () => {
    mockGetRepoTree.mockResolvedValue({
      tree: [{ path: "src/index.ts", type: "blob", size: 100 }],
      truncated: false,
    })
    const activeIndexDb = await makeActiveIndexDb()
    const { env, kv } = makeEnv(activeIndexDb)

    await handleIndexRepoJob({ job: bootstrapJob(), env })
    const manifestKey = repoIndexManifestKey("Sigilix", "sigilix")
    const winner = JSON.parse(kv.get(manifestKey)!) as RepoIndexManifestV1
    expect(winner.chunkCount).toBe(1)

    kv.delete(manifestKey)
    mockGetFileContent.mockResolvedValue(Array.from({ length: 100 }, (_, i) => `const line${i} = ${i}`).join("\n"))
    await handleIndexRepoJob({ job: bootstrapJob(), env })

    const repaired = JSON.parse(kv.get(manifestKey)!) as RepoIndexManifestV1
    const canonicalChunkCount = Object.values(repaired.activeIndex?.byPath ?? {}).reduce(
      (sum, pathIds) => sum + pathIds.length,
      0,
    )
    expect(canonicalChunkCount).toBe(1)
    expect(repaired.chunkCount).toBe(canonicalChunkCount)
  })

  it("publishes only the complete exact-ID snapshot and replays the final shard idempotently", async () => {
    const totalFiles = MAX_FILES_PER_JOB + 3
    mockGetRepoTree.mockResolvedValue({
      tree: Array.from({ length: totalFiles }, (_, i) => ({ path: `src/file-${i}.ts`, type: "blob", size: 100 })),
      truncated: false,
    })
    const activeIndexDb = await makeActiveIndexDb()
    const { env, sent, kv } = makeEnv(activeIndexDb)

    await handleIndexRepoJob({ job: bootstrapJob(), env })
    expect(mockGetFileContent).toHaveBeenCalledTimes(MAX_FILES_PER_JOB)
    expect(kv.has(repoIndexManifestKey("Sigilix", "sigilix"))).toBe(false)
    expect(sent).toHaveLength(1)
    const continuation = sent[0]!.message
    if (continuation.type !== "index-repo" || continuation.shard === undefined) {
      throw new Error("expected index continuation")
    }
    expect(continuation.githubRepoId).toBe(808247824)
    expect(continuation.activeIndexMode).toBe("on")
    expect(continuation.shard).toMatchObject({
      lo: MAX_FILES_PER_JOB,
      hi: totalFiles,
      totalFiles,
      filesDone: MAX_FILES_PER_JOB,
    })

    await handleIndexRepoJob({ job: continuation, env })
    const manifestKey = repoIndexManifestKey("Sigilix", "sigilix")
    const firstFinal = kv.get(manifestKey)
    expect(firstFinal).toBeTruthy()
    const parsed = JSON.parse(firstFinal!) as RepoIndexManifestV1
    expect(parsed.fileCount).toBe(totalFiles)
    expect(parsed.chunkCount).toBe(totalFiles)
    expect(parsed.shardCount).toBe(2)
    expect(Object.keys(parsed.activeIndex?.byPath ?? {})).toHaveLength(totalFiles)
    expect(parsed.activeIndex).toMatchObject({ version: 1, githubRepoId: 808247824, builtMode: "on" })
    await expect(
      activeIndexDb
        .prepare("SELECT completed_through, total_files, sealed, invalidated FROM repo_active_index_run")
        .first(),
    ).resolves.toEqual({ completed_through: totalFiles, total_files: totalFiles, sealed: 1, invalidated: 0 })

    await handleIndexRepoJob({ job: continuation, env })
    expect(kv.get(manifestKey)).toBe(firstFinal)
  })
})
