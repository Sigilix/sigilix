import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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

import { dispatchJob } from "@/src/index-dispatch"
import { repoIndexManifestKey, type RepoIndexManifestV1 } from "@/src/lib/repo-index-manifest"
import { EMBEDDING_DIMENSIONS } from "@/src/shared/adapters/model"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"

const PROCESSING_BUDGET_MS = 10 * 60 * 1000

async function makeActiveIndexDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(readFileSync(new URL("../migrations/0025_create_repo_active_index_stage.sql", import.meta.url), "utf8"))
  return db
}

function makeEnv(activeIndexDb: D1Database): {
  env: Env
  sent: JobMessage[]
  kv: Map<string, string>
} {
  const kv = new Map<string, string>()
  const sent: JobMessage[] = []
  const env = {
    OPENCLAW_STATE: {
      async get(key: string): Promise<string | null> {
        return kv.get(key) ?? null
      },
      async put(key: string, value: string): Promise<void> {
        kv.set(key, value)
      },
      async delete(key: string): Promise<void> {
        kv.delete(key)
      },
    },
    OPENCLAW_JOBS: {
      async send(message: JobMessage): Promise<void> {
        sent.push(message)
      },
    },
    AI: { run: (model: string, input: unknown) => mockAiRun(model, input) },
    OPENCLAW_CODE_INDEX: { upsert: mockVectorizeUpsert },
    SIGILIX_PLATFORM_DB: activeIndexDb,
    OPENCLAW_REPO_ACTIVE_INDEX_MODE: "on",
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
  } as unknown as Env
  return { env, sent, kv }
}

function bootstrapJob(): Extract<JobMessage, { type: "index-repo" }> {
  return {
    type: "index-repo",
    owner: "Sigilix",
    repo: "large-repo",
    installationId: 99,
    reason: "install",
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-07-18T00:00:00Z"))
  mockGetInstallationToken.mockClear()
  mockGetRepository.mockReset().mockResolvedValue({ default_branch: "main", id: 808247824 })
  mockGetBranch.mockReset().mockResolvedValue({ headSha: "a".repeat(40), treeSha: "b".repeat(40) })
  mockGetRepoTree.mockReset().mockResolvedValue({
    tree: [
      { path: "src/first.ts", type: "blob", size: 100 },
      { path: "src/second.ts", type: "blob", size: 100 },
    ],
    truncated: false,
  })
  mockGetFileContent.mockReset()
  mockAiRun.mockReset().mockImplementation(async (_model: string, input: { text: string | string[] }) => {
    const texts = Array.isArray(input.text) ? input.text : [input.text]
    return { data: texts.map(() => new Array(EMBEDDING_DIMENSIONS).fill(0.5)) }
  })
  mockVectorizeUpsert.mockReset().mockResolvedValue({ ids: [], count: 0 })
  mockWriteFileGraph.mockReset().mockResolvedValue(undefined)
  mockCommitGraph.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("index-repo queue deadline checkpoint", () => {
  it("stages a bounded prefix and resumes it to one sealed manifest", async () => {
    let firstFetch = true
    mockGetFileContent.mockImplementation(async (_owner, _repo, path: string) => {
      if (firstFetch) {
        firstFetch = false
        vi.setSystemTime(new Date(Date.now() + PROCESSING_BUDGET_MS))
      }
      return `export const path = ${JSON.stringify(path)}`
    })
    const activeIndexDb = await makeActiveIndexDb()
    const { env, sent, kv } = makeEnv(activeIndexDb)
    const manifestKey = repoIndexManifestKey("Sigilix", "large-repo")

    await dispatchJob(bootstrapJob(), env)

    expect(mockGetFileContent).toHaveBeenCalledTimes(1)
    expect(kv.has(manifestKey)).toBe(false)
    expect(sent).toHaveLength(1)
    const continuation = sent[0]
    if (continuation?.type !== "index-repo" || continuation.shard === undefined) {
      throw new Error("expected index continuation")
    }
    expect(continuation.shard).toEqual(
      expect.objectContaining({ lo: 1, hi: 2, totalFiles: 2, filesDone: 1, shardsDone: 1 }),
    )
    await expect(
      activeIndexDb
        .prepare("SELECT completed_through, total_files, sealed, invalidated FROM repo_active_index_run")
        .first(),
    ).resolves.toEqual({ completed_through: 1, total_files: 2, sealed: 0, invalidated: 0 })

    await dispatchJob(bootstrapJob(), env)

    expect(mockGetFileContent).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({
      type: "index-repo",
      owner: "Sigilix",
      repo: "large-repo",
      githubRepoId: 808247824,
      installationId: 99,
      activeIndexMode: "on",
      shard: { lo: 1, hi: 2, totalFiles: 2, filesDone: 1, chunksDone: 1, shardsDone: 1 },
    })

    mockGetFileContent.mockImplementation(
      async (_owner, _repo, path: string) => `export const path = ${JSON.stringify(path)}`,
    )
    await dispatchJob(continuation, env)
    await dispatchJob(sent[1]!, env)

    const stored = kv.get(manifestKey)
    expect(stored).toBeTruthy()
    const manifest = JSON.parse(stored!) as RepoIndexManifestV1
    expect(manifest.fileCount).toBe(2)
    expect(manifest.chunkCount).toBe(2)
    expect(manifest.shardCount).toBe(2)
    expect(Object.keys(manifest.activeIndex?.byPath ?? {}).sort()).toEqual(["src/first.ts", "src/second.ts"])
    await expect(
      activeIndexDb
        .prepare("SELECT completed_through, total_files, sealed, invalidated FROM repo_active_index_run")
        .first(),
    ).resolves.toEqual({ completed_through: 2, total_files: 2, sealed: 1, invalidated: 0 })
  })
})
