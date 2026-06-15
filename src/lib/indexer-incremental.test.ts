import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  mockGetInstallationToken,
  mockGetRepository,
  mockGetBranch,
  mockGetRepoTree,
  mockGetFileContent,
  mockCompareCommits,
  mockAiRun,
  mockVectorizeUpsert,
  mockVectorizeDeleteByIds,
  mockDebugActiveGraphVersion,
  mockDeleteLexicalIds,
  mockWriteFileGraph,
  mockCommitGraph,
} = vi.hoisted(() => ({
  mockGetInstallationToken: vi.fn(async (_args: unknown) => "test-token"),
  mockGetRepository: vi.fn(),
  mockGetBranch: vi.fn(),
  mockGetRepoTree: vi.fn(),
  mockGetFileContent: vi.fn(),
  mockCompareCommits: vi.fn(),
  mockAiRun: vi.fn(),
  mockVectorizeUpsert: vi.fn(
    async (..._args: unknown[]): Promise<{ ids: string[]; count: number }> => ({
      ids: [],
      count: 0,
    }),
  ),
  mockVectorizeDeleteByIds: vi.fn(async (..._args: unknown[]) => undefined),
  mockDebugActiveGraphVersion: vi.fn(async (..._args: unknown[]): Promise<string | null> => null),
  mockDeleteLexicalIds: vi.fn(async (..._args: unknown[]): Promise<number> => 0),
  // SIG-423: assertable spies for the graph write/commit path.
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
    async compareCommits(owner: string, repo: string, base: string, head: string): Promise<unknown> {
      return mockCompareCommits(owner, repo, base, head)
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
  writeFileGraph: (...args: unknown[]) => mockWriteFileGraph(...args),
  commitGraph: (...args: unknown[]) => mockCommitGraph(...args),
  debugActiveGraphVersion: (...args: unknown[]) => mockDebugActiveGraphVersion(...args),
}))

vi.mock("@/src/lib/lexical-index", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/lexical-index")>("@/src/lib/lexical-index")
  return {
    ...actual,
    deleteLexicalIds: (...args: unknown[]) => mockDeleteLexicalIds(...args),
  }
})

import { chunkFile, chunkId, handleIndexRepoJob } from "@/src/lib/indexer"
import { collectPushChangedPaths } from "@/src/lib/index-producer"
import { activeRunKey } from "@/src/lib/repo-index-active-run"
import { repoIndexManifestKey, type RepoIndexManifestV1 } from "@/src/lib/repo-index-manifest"
import { repoIndexVectorsKey, type RepoIndexVectorsV1 } from "@/src/lib/repo-index-vectors"
import { handlePushEvent } from "@/src/index-internals"
import { EMBEDDING_DIMENSIONS } from "@/src/shared/adapters/model"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"
import {
  makeEnv as makeEnvShared,
  seedIndexedRepo,
  pushJobWithChangedPaths,
} from "@/src/lib/indexer-incremental.test-helpers"

function makeEnv(opts: { getImpl?: (key: string, store: Map<string, string>) => Promise<string | null> } = {}): {
  env: ReturnType<typeof makeEnvShared>["env"]
  kv: Map<string, string>
  sent: JobMessage[]
} {
  return makeEnvShared(
    { aiRun: mockAiRun, vectorizeUpsert: mockVectorizeUpsert, vectorizeDeleteByIds: mockVectorizeDeleteByIds },
    opts,
  )
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
  mockDeleteLexicalIds.mockReset().mockResolvedValue(0)
  // SIG-422: default compare response mirrors the push fast-path's changed
  // set (changed.ts modified, deleted.ts removed) so a job that recovers via
  // the Compare API lands on the same incremental delta. Per-test overrides
  // exercise the diverged / truncated / unknown-status fallbacks.
  mockCompareCommits.mockReset().mockResolvedValue({
    status: "ahead",
    files: [
      { status: "modified", filename: "src/changed.ts", previous_filename: null },
      { status: "removed", filename: "src/deleted.ts", previous_filename: null },
    ],
  })
  mockWriteFileGraph.mockReset().mockResolvedValue(undefined)
  mockCommitGraph.mockReset().mockResolvedValue(undefined)
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

    expect(mockGetFileContent).toHaveBeenCalledTimes(2)
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

    expect(mockGetFileContent).toHaveBeenCalledTimes(2)
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

  it("refreshes metadata without walking the tree when changed paths cannot affect the index", async () => {
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)

    await handleIndexRepoJob({
      job: {
        ...pushJobWithChangedPaths(),
        changedPaths: {
          upsert: ["package-lock.json"],
          remove: ["assets/logo.png"],
        },
      },
      env,
    })

    expect(mockGetRepoTree).not.toHaveBeenCalled()
    expect(mockGetFileContent).not.toHaveBeenCalled()
    expect(mockAiRun).not.toHaveBeenCalled()
    expect(mockVectorizeUpsert).not.toHaveBeenCalled()
    expect(mockVectorizeDeleteByIds).not.toHaveBeenCalled()

    const manifest = JSON.parse(kv.get(repoIndexManifestKey("Sigilix", "sigilix")) as string) as RepoIndexManifestV1
    expect(manifest.headSha).toBe("c".repeat(40))
    expect(manifest.fileCount).toBe(3)
    expect(manifest.chunkCount).toBe(3)

    const vectors = JSON.parse(kv.get(repoIndexVectorsKey("Sigilix", "sigilix")) as string) as RepoIndexVectorsV1
    expect(vectors.runId).not.toBe("old-run")
    expect(vectors.byPath).toEqual({
      "src/changed.ts": ["old-changed-id"],
      "src/deleted.ts": ["old-deleted-id"],
      "src/unchanged.ts": ["old-unchanged-id"],
    })
  })

  it("cleans stale stored ids for removed non-indexable paths without walking the tree", async () => {
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)
    const lexicalDb = {} as D1Database
    ;(env as Env & { OPENCLAW_LEXICAL_INDEX: D1Database }).OPENCLAW_LEXICAL_INDEX = lexicalDb
    const vectors = JSON.parse(kv.get(repoIndexVectorsKey("Sigilix", "sigilix")) as string) as RepoIndexVectorsV1
    vectors.byPath["assets/logo.png"] = ["stale-nonindexable-id"]
    kv.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors))

    await handleIndexRepoJob({
      job: {
        ...pushJobWithChangedPaths(),
        changedPaths: {
          upsert: ["package-lock.json"],
          remove: ["assets/logo.png"],
        },
      },
      env,
    })

    expect(mockGetRepoTree).not.toHaveBeenCalled()
    expect(mockGetFileContent).not.toHaveBeenCalled()
    expect(mockAiRun).not.toHaveBeenCalled()
    expect(mockVectorizeUpsert).not.toHaveBeenCalled()
    expect(mockVectorizeDeleteByIds).toHaveBeenCalledWith(["stale-nonindexable-id"])
    expect(mockDeleteLexicalIds).toHaveBeenCalledWith(lexicalDb, ["stale-nonindexable-id"])

    const stored = JSON.parse(kv.get(repoIndexVectorsKey("Sigilix", "sigilix")) as string) as RepoIndexVectorsV1
    expect(stored.byPath["assets/logo.png"]).toBeUndefined()
    expect(stored.byPath["src/changed.ts"]).toEqual(["old-changed-id"])
    expect(stored.byPath["src/deleted.ts"]).toEqual(["old-deleted-id"])

    const manifest = JSON.parse(kv.get(repoIndexManifestKey("Sigilix", "sigilix")) as string) as RepoIndexManifestV1
    expect(manifest.chunkCount).toBe(3)
  })

  it("falls back to full indexing instead of noop when the active graph version drifted", async () => {
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)
    ;(env as Env & { OPENCLAW_GRAPH_INDEX: string }).OPENCLAW_GRAPH_INDEX = "on"
    const manifest = JSON.parse(kv.get(repoIndexManifestKey("Sigilix", "sigilix")) as string) as RepoIndexManifestV1
    manifest.graphRunId = "old-graph-run"
    kv.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest))
    mockDebugActiveGraphVersion.mockResolvedValue("newer-graph-run")

    await handleIndexRepoJob({
      job: {
        ...pushJobWithChangedPaths(),
        changedPaths: {
          upsert: ["package-lock.json"],
          remove: ["assets/logo.png"],
        },
      },
      env,
    })

    expect(mockGetRepoTree).toHaveBeenCalled()
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/changed.ts", "c".repeat(40))
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/unchanged.ts", "c".repeat(40))
    expect(mockVectorizeUpsert).toHaveBeenCalled()
    // SIG-423: the FULL-TREE fallback still writes + commits the graph — the
    // skip is incremental-path-only. (Guards against the gate leaking to the
    // path that builds the active graph the reviewer reads.)
    expect(mockWriteFileGraph).toHaveBeenCalled()
    expect(mockCommitGraph).toHaveBeenCalled()
  })

  // SIG-423: when the incremental push path PROCEEDS (graph writer on, the
  // manifest's graphRunId still matches the DO's active version), it embeds only
  // the changed file but must NOT write graph rows — those rows would land under
  // an uncommitted runId no read path ever resolves (all graph reads use
  // debugActiveVersion → the unchanged old active version). Writing them is pure
  // SQLite waste; skipping is recall-neutral. Reverting writeGraph:false fails
  // this assertion (processSlice would call writeFileGraph for the changed file).
  it("does not write graph rows on the incremental push path (SIG-423)", async () => {
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)
    ;(env as Env & { OPENCLAW_GRAPH_INDEX: string }).OPENCLAW_GRAPH_INDEX = "on"
    const manifest = JSON.parse(kv.get(repoIndexManifestKey("Sigilix", "sigilix")) as string) as RepoIndexManifestV1
    // graphRunId matches the DO's active version → incremental PROCEEDS (no
    // graph-version-drift fallback to full indexing).
    manifest.graphRunId = "active-graph-run"
    kv.set(repoIndexManifestKey("Sigilix", "sigilix"), JSON.stringify(manifest))
    mockDebugActiveGraphVersion.mockResolvedValue("active-graph-run")

    await handleIndexRepoJob({ job: pushJobWithChangedPaths(), env })

    // Incremental delta ran: only the changed file embedded, stale vectors gone.
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/changed.ts", "c".repeat(40))
    expect(mockGetFileContent).not.toHaveBeenCalledWith("Sigilix", "sigilix", "src/unchanged.ts", "c".repeat(40))
    expect(mockVectorizeUpsert).toHaveBeenCalled()
    // The whole point of SIG-423: NO graph writes (and no commit) on this path.
    expect(mockWriteFileGraph).not.toHaveBeenCalled()
    expect(mockCommitGraph).not.toHaveBeenCalled()
  })

  it("falls back to full indexing when scoped rule files change", async () => {
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)

    await handleIndexRepoJob({
      job: {
        ...pushJobWithChangedPaths(),
        changedPaths: {
          upsert: [".sigilix/rules/security.md"],
          remove: [],
        },
      },
      env,
    })

    expect(mockGetRepoTree).toHaveBeenCalled()
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/changed.ts", "c".repeat(40))
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/unchanged.ts", "c".repeat(40))
    expect(mockVectorizeUpsert).toHaveBeenCalled()
  })

  it("reuses unchanged chunk ids instead of re-embedding touched files", async () => {
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)
    const changedContent = "export const changed = 1\n"
    const existingId = await chunkId("sigilix/sigilix", chunkFile("src/changed.ts", changedContent)[0]!)
    const vectors = JSON.parse(kv.get(repoIndexVectorsKey("Sigilix", "sigilix")) as string) as RepoIndexVectorsV1
    vectors.byPath["src/changed.ts"] = [existingId]
    kv.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors))

    await handleIndexRepoJob({ job: pushJobWithChangedPaths(), env })

    expect(mockGetFileContent).toHaveBeenCalledTimes(1)
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/changed.ts", "c".repeat(40))
    expect(mockAiRun).not.toHaveBeenCalled()
    expect(mockVectorizeUpsert).not.toHaveBeenCalled()
    expect(mockVectorizeDeleteByIds).toHaveBeenCalledWith(["old-deleted-id"])

    const stored = JSON.parse(kv.get(repoIndexVectorsKey("Sigilix", "sigilix")) as string) as RepoIndexVectorsV1
    expect(stored.byPath["src/changed.ts"]).toEqual([existingId])
    expect(stored.byPath["src/deleted.ts"]).toBeUndefined()
  })

  it("falls back to embedding when a reuse content probe rejects", async () => {
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)
    const changedContent = "export const changed = 1\n"
    const existingId = await chunkId("sigilix/sigilix", chunkFile("src/changed.ts", changedContent)[0]!)
    const vectors = JSON.parse(kv.get(repoIndexVectorsKey("Sigilix", "sigilix")) as string) as RepoIndexVectorsV1
    vectors.byPath["src/changed.ts"] = [existingId]
    kv.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors))
    mockGetFileContent.mockRejectedValueOnce(new Error("github 503"))

    await handleIndexRepoJob({ job: pushJobWithChangedPaths(), env })

    expect(mockGetFileContent).toHaveBeenCalledTimes(2)
    expect(mockAiRun).toHaveBeenCalled()
    expect(mockVectorizeUpsert).toHaveBeenCalledTimes(1)
    const stored = JSON.parse(kv.get(repoIndexVectorsKey("Sigilix", "sigilix")) as string) as RepoIndexVectorsV1
    expect(stored.byPath["src/changed.ts"]).toEqual([existingId])
  })

  it("embeds only failed reuse probes while keeping concurrent successful probes reused", async () => {
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)
    const contents: Record<string, string> = {
      "src/one.ts": "export const one = 1\n",
      "src/two.ts": "export const two = 2\n",
    }
    mockGetRepoTree.mockResolvedValue({
      tree: Object.keys(contents).map((path) => ({ path, type: "blob", size: 100 })),
      truncated: false,
    })
    const vectors = JSON.parse(kv.get(repoIndexVectorsKey("Sigilix", "sigilix")) as string) as RepoIndexVectorsV1
    vectors.byPath = {}
    for (const [path, content] of Object.entries(contents)) {
      vectors.byPath[path] = [await chunkId("sigilix/sigilix", chunkFile(path, content)[0]!)]
    }
    const oneId = vectors.byPath["src/one.ts"]![0]!
    const twoId = vectors.byPath["src/two.ts"]![0]!
    kv.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors))
    let rejectedOneProbe = false
    mockGetFileContent.mockImplementation(async (_owner, _repo, path: string) => {
      if (path === "src/one.ts" && !rejectedOneProbe) {
        rejectedOneProbe = true
        throw new Error("github 503")
      }
      return contents[path] ?? null
    })

    await handleIndexRepoJob({
      job: {
        ...pushJobWithChangedPaths(),
        changedPaths: {
          upsert: Object.keys(contents),
          remove: [],
        },
      },
      env,
    })

    expect(mockGetFileContent).toHaveBeenCalledTimes(3)
    expect(mockAiRun).toHaveBeenCalledTimes(1)
    expect(mockVectorizeUpsert).toHaveBeenCalledTimes(1)
    const stored = JSON.parse(kv.get(repoIndexVectorsKey("Sigilix", "sigilix")) as string) as RepoIndexVectorsV1
    expect(stored.byPath["src/one.ts"]).toEqual([oneId])
    expect(stored.byPath["src/two.ts"]).toEqual([twoId])
  })

  it("probes reusable changed files concurrently", async () => {
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)
    const contents: Record<string, string> = {
      "src/one.ts": "export const one = 1\n",
      "src/two.ts": "export const two = 2\n",
      "src/three.ts": "export const three = 3\n",
    }
    mockGetRepoTree.mockResolvedValue({
      tree: Object.keys(contents).map((path) => ({ path, type: "blob", size: 100 })),
      truncated: false,
    })
    const vectors = JSON.parse(kv.get(repoIndexVectorsKey("Sigilix", "sigilix")) as string) as RepoIndexVectorsV1
    vectors.byPath = {}
    for (const [path, content] of Object.entries(contents)) {
      vectors.byPath[path] = [await chunkId("sigilix/sigilix", chunkFile(path, content)[0]!)]
    }
    kv.set(repoIndexVectorsKey("Sigilix", "sigilix"), JSON.stringify(vectors))
    let active = 0
    let maxActive = 0
    mockGetFileContent.mockImplementation(async (_owner, _repo, path: string) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      active -= 1
      return contents[path] ?? null
    })

    await handleIndexRepoJob({
      job: {
        ...pushJobWithChangedPaths(),
        changedPaths: {
          upsert: Object.keys(contents),
          remove: [],
        },
      },
      env,
    })

    expect(maxActive).toBeGreaterThan(1)
    expect(mockGetFileContent).toHaveBeenCalledTimes(3)
    expect(mockAiRun).not.toHaveBeenCalled()
    expect(mockVectorizeUpsert).not.toHaveBeenCalled()
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

  it("recovers the delta via the Compare API when the push chain drifts off the manifest head", async () => {
    // SIG-422 case (b): push `before` no longer matches the manifest head
    // (the indexer resolved a live head that advanced past the push chain).
    // Pre-SIG-422 this forced a full re-embed; now it recovers a complete
    // forward delta from the Compare API and stays incremental.
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)

    await handleIndexRepoJob({
      job: { ...pushJobWithChangedPaths(), before: "b".repeat(40) },
      env,
    })

    expect(mockCompareCommits).toHaveBeenCalledWith("Sigilix", "sigilix", "a".repeat(40), "c".repeat(40))
    // Only the changed file is fetched — unchanged.ts is never touched, which
    // proves the incremental (not full-tree) path ran.
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/changed.ts", "c".repeat(40))
    expect(mockGetFileContent).not.toHaveBeenCalledWith("Sigilix", "sigilix", "src/unchanged.ts", "c".repeat(40))
    expect(mockVectorizeDeleteByIds).toHaveBeenCalledWith(["old-changed-id", "old-deleted-id"])
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
        if (activeReads < 6) return store.get(key) ?? null
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
        if (activeReads < 7) return store.get(key) ?? null
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
