// ARC-235 — integration tests for the indexer queue consumer.
//
// Mocks the GitHubClient + getInstallationToken + Workers AI + Vectorize
// to exercise the full bootstrap + shard state machine:
//   - happy path (single shard) writes the manifest
//   - already-fresh manifest skips re-indexing
//   - bootstrap with >MAX_FILES_PER_JOB enqueues the next shard, does NOT
//     write the manifest (chain continues)
//   - final shard writes the manifest with cumulative file/chunk counts
//   - config-drift (modelId rotated between shards) refuses the chain
//   - tree-truncated refuses + no manifest
//   - sensitive-repo gate at the consumer

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
  mockDebugActiveGraphVersion,
} = vi.hoisted(() => ({
  mockGetInstallationToken: vi.fn(async () => "test-token"),
  mockGetRepository: vi.fn(),
  mockGetBranch: vi.fn(),
  mockGetRepoTree: vi.fn(),
  mockGetFileContent: vi.fn(),
  mockAiRun: vi.fn(),
  mockVectorizeUpsert: vi.fn(async () => ({ ids: [], count: 0 })),
  mockWriteFileGraph: vi.fn(async () => undefined),
  mockCommitGraph: vi.fn(async () => undefined),
  mockDebugActiveGraphVersion: vi.fn(async () => null),
}))

vi.mock("../src/shared/adapters/github/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("../src/shared/adapters/github", async () => {
  const actual = await vi.importActual<typeof import("../src/shared/adapters/github")>("../src/shared/adapters/github")
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

vi.mock("../src/lib/repo-graph-client", () => ({
  writeFileGraph: (...args: unknown[]) => mockWriteFileGraph(...args),
  commitGraph: (...args: unknown[]) => mockCommitGraph(...args),
  debugActiveGraphVersion: (...args: unknown[]) => mockDebugActiveGraphVersion(...args),
}))

import { handleIndexRepoJob, MAX_FILES_PER_JOB } from "../src/lib/indexer"
import {
  repoIndexManifestKey,
  type RepoIndexManifestV1,
} from "../src/lib/repo-index-manifest"
import { repoIndexVectorsKey, type RepoIndexVectorsV1 } from "../src/lib/repo-index-vectors"
import { activeRunKey } from "../src/lib/repo-index-active-run"
import { scopedRulesKey } from "../src/lib/scoped-rules-kv"
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "../src/lib/embeddings"
import { CHUNKER_VERSION } from "../src/lib/indexer"
import { encodeBranchName } from "../src/lib/index-branch"
import type { Env } from "../src/shared/types/env"
import type { JobMessage } from "../src/shared/types/job"

interface Sent {
  message: JobMessage
}

function makeKvStub(): {
  kv: Env["OPENCLAW_STATE"]
  store: Map<string, string>
} {
  const store = new Map<string, string>()
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null
    },
    put: vi.fn(async (key: string, value: string): Promise<void> => {
      store.set(key, value)
    }),
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store }
}

function makeEnv(opts: { sensitive?: string } = {}): { env: Env; sent: Sent[]; kv: Map<string, string> } {
  const { kv, store } = makeKvStub()
  const sent: Sent[] = []
  const env = {
    OPENCLAW_STATE: kv,
    OPENCLAW_JOBS: {
      send: async (message: JobMessage) => { sent.push({ message }) },
    },
    AI: { run: (model: string, input: unknown) => mockAiRun(model, input) },
    OPENCLAW_CODE_INDEX: { upsert: mockVectorizeUpsert },
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
    OPENCLAW_SENSITIVE_REPOS: opts.sensitive,
  } as unknown as Env
  return { env, sent, kv: store }
}

// Default mocks for the happy path
beforeEach(() => {
  mockGetInstallationToken.mockClear()
  mockGetRepository.mockReset()
  mockGetBranch.mockReset()
  mockGetRepoTree.mockReset()
  mockGetFileContent.mockReset()
  mockAiRun.mockReset()
  mockVectorizeUpsert.mockReset()
  mockWriteFileGraph.mockReset().mockResolvedValue(undefined)
  mockCommitGraph.mockReset().mockResolvedValue(undefined)
  mockDebugActiveGraphVersion.mockReset().mockResolvedValue(null)

  mockGetRepository.mockResolvedValue({ default_branch: "main" })
  mockGetBranch.mockResolvedValue({ headSha: "a".repeat(40), treeSha: "b".repeat(40) })
  mockGetFileContent.mockImplementation(async (_o, _r, path: string) => `// content of ${path}\nconsole.log("hi")`)
  mockAiRun.mockImplementation(async (_model: string, input: { text: string | string[] }) => {
    const texts = Array.isArray(input.text) ? input.text : [input.text]
    return { data: texts.map(() => new Array(EMBEDDING_DIMENSIONS).fill(0.5)) }
  })
  mockVectorizeUpsert.mockResolvedValue({ ids: [], count: 0 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function bootstrapJob(over: Partial<JobMessage & { type: "index-repo" }> = {}): JobMessage {
  return {
    type: "index-repo",
    owner: "Arc-and-Anchor",
    repo: "sigilix",
    installationId: 99,
    reason: "install",
    ...over,
  } as JobMessage
}

describe("handleIndexRepoJob — bootstrap happy path (single shard)", () => {
  it("walks tree, processes files, writes manifest", async () => {
    mockGetRepoTree.mockResolvedValue({
      tree: [
        { path: "src/index.ts", type: "blob", size: 100 },
        { path: "README.md", type: "blob", size: 100 },
      ],
      truncated: false,
    })

    const { env, sent, kv } = makeEnv()
    await handleIndexRepoJob({ job: bootstrapJob(), env })

    // CodeRabbit nit on PR #76: a regression that skipped installation
    // auth would still pass the rest of these asserts with these mocks.
    // Pin the token call so the auth path is exercised end-to-end.
    expect(mockGetInstallationToken).toHaveBeenCalledTimes(1)
    expect(mockGetRepoTree).toHaveBeenCalledTimes(1)
    expect(mockGetFileContent).toHaveBeenCalledTimes(2)
    expect(mockVectorizeUpsert).toHaveBeenCalled()
    // SIG-132: vectors are upserted under the <owner>/<repo> namespace,
    // not the bare repo, so two orgs with a repo named the same don't
    // share a Vectorize namespace.
    const upsertedRecords = mockVectorizeUpsert.mock.calls.flatMap(
      (call) => call[0] as Array<{ namespace?: string }>,
    )
    expect(upsertedRecords.length).toBeGreaterThan(0)
    for (const rec of upsertedRecords) {
      expect(rec.namespace).toBe("arc-and-anchor/sigilix")
    }
    expect(sent).toHaveLength(0) // no shard enqueued
    // manifest is written
    const stored = kv.get(repoIndexManifestKey("Arc-and-Anchor", "sigilix"))
    expect(stored).toBeTruthy()
    if (stored) {
      const parsed = JSON.parse(stored) as RepoIndexManifestV1
      expect(parsed.v).toBe(1)
      expect(parsed.repo).toBe("sigilix")
      expect(parsed.owner).toBe("Arc-and-Anchor")
      expect(parsed.fileCount).toBe(2)
      expect(parsed.shardCount).toBe(1)
      expect(parsed.modelId).toBe(EMBEDDING_MODEL)
      expect(parsed.embeddingDim).toBe(EMBEDDING_DIMENSIONS)
    }
  })

  it("indexes a non-default branch into isolated KV and Vectorize state", async () => {
    mockGetRepoTree.mockResolvedValue({
      tree: [{ path: "src/dev-only.ts", type: "blob", size: 100 }],
      truncated: false,
    })

    const { env, sent, kv } = makeEnv()
    ;(env as Env & { OPENCLAW_GRAPH_INDEX: string }).OPENCLAW_GRAPH_INDEX = "shadow"
    await handleIndexRepoJob({ job: bootstrapJob({ branch: "dev", reason: "pull-request" }), env })

    expect(mockGetBranch).toHaveBeenCalledWith("Arc-and-Anchor", "sigilix", "dev")
    expect(sent).toHaveLength(0)
    // SIG-218: branch segment is now `h` + 16-hex sha256(branch) prefix.
    const encodedDev = await encodeBranchName("dev")
    const branchRepo = `sigilix/__branch__/${encodedDev}`
    const branchNamespace = `arc-and-anchor/${branchRepo}`
    const upsertedRecords = mockVectorizeUpsert.mock.calls.flatMap(
      (call) => call[0] as Array<{ namespace?: string }>,
    )
    expect(upsertedRecords.length).toBeGreaterThan(0)
    for (const rec of upsertedRecords) {
      expect(rec.namespace).toBe(branchNamespace)
    }
    expect(mockWriteFileGraph).not.toHaveBeenCalled()
    expect(mockCommitGraph).not.toHaveBeenCalled()

    expect(kv.has(repoIndexManifestKey("Arc-and-Anchor", "sigilix"))).toBe(false)
    const stored = kv.get(repoIndexManifestKey("Arc-and-Anchor", branchRepo))
    expect(stored).toBeTruthy()
    if (stored) {
      const parsed = JSON.parse(stored) as RepoIndexManifestV1
      expect(parsed.repo).toBe(branchRepo)
      expect(parsed.actualRepo).toBe("sigilix")
      expect(parsed.branch).toBe("dev")
      expect(parsed.defaultBranch).toBe("main")
      expect(parsed.namespace).toBe(branchNamespace)
      expect(parsed.fileCount).toBe(1)
    }
  })
})

describe("handleIndexRepoJob — freshness skip", () => {
  it("skips when manifest matches current (headSha, modelId, chunkerVersion, embeddingDim, owner)", async () => {
    mockGetRepoTree.mockResolvedValue({
      tree: [{ path: "src/index.ts", type: "blob", size: 100 }],
      truncated: false,
    })

    const { env, kv } = makeEnv()
    // Seed a fresh manifest first.
    const headSha = "a".repeat(40)
    const manifest: RepoIndexManifestV1 = {
      v: 1, repo: "sigilix", owner: "Arc-and-Anchor",
      headSha,
      runId: "0123456789abcdef",
      fileCount: 1, chunkCount: 1, shardCount: 1,
      indexedAt: "2026-05-17T00:00:00.000Z",
      modelId: EMBEDDING_MODEL,
      embeddingDim: EMBEDDING_DIMENSIONS,
      chunkerVersion: 2,
      windowLines: 30, overlapLines: 10,
    }
    kv.set(repoIndexManifestKey("Arc-and-Anchor", "sigilix"), JSON.stringify(manifest))

    await handleIndexRepoJob({ job: bootstrapJob(), env })

    expect(mockGetRepoTree).not.toHaveBeenCalled()
    expect(mockGetFileContent).not.toHaveBeenCalled()
    expect(mockVectorizeUpsert).not.toHaveBeenCalled()
  })

  it("skips a fresh manifest only when graph active version also matches (SIG-155)", async () => {
    const headSha = "a".repeat(40)
    const { computeRunId } = await import("../src/lib/indexer")
    const runId = await computeRunId({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      headSha,
      modelId: EMBEDDING_MODEL,
      chunkerVersion: CHUNKER_VERSION,
    })
    const { env, kv } = makeEnv()
    ;(env as Env & { OPENCLAW_GRAPH_INDEX: string }).OPENCLAW_GRAPH_INDEX = "shadow"
    const manifest: RepoIndexManifestV1 = {
      v: 1, repo: "sigilix", owner: "Arc-and-Anchor",
      headSha,
      runId,
      fileCount: 1, chunkCount: 1, shardCount: 1,
      indexedAt: "2026-05-17T00:00:00.000Z",
      modelId: EMBEDDING_MODEL,
      embeddingDim: EMBEDDING_DIMENSIONS,
      chunkerVersion: CHUNKER_VERSION,
      windowLines: 30, overlapLines: 10,
    }
    kv.set(repoIndexManifestKey("Arc-and-Anchor", "sigilix"), JSON.stringify(manifest))
    mockDebugActiveGraphVersion.mockResolvedValue(runId)

    await handleIndexRepoJob({ job: bootstrapJob(), env })

    expect(mockDebugActiveGraphVersion).toHaveBeenCalledWith(env, "Arc-and-Anchor", "sigilix")
    expect(mockGetRepoTree).not.toHaveBeenCalled()
    expect(mockVectorizeUpsert).not.toHaveBeenCalled()
    expect(mockWriteFileGraph).not.toHaveBeenCalled()
    expect(mockCommitGraph).not.toHaveBeenCalled()
  })

  it("re-indexes a fresh manifest when graph active version is missing (SIG-155)", async () => {
    mockGetRepoTree.mockResolvedValue({
      tree: [{ path: "src/index.ts", type: "blob", size: 100 }],
      truncated: false,
    })

    const headSha = "a".repeat(40)
    const { computeRunId } = await import("../src/lib/indexer")
    const runId = await computeRunId({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      headSha,
      modelId: EMBEDDING_MODEL,
      chunkerVersion: CHUNKER_VERSION,
    })
    const { env, kv } = makeEnv()
    ;(env as Env & { OPENCLAW_GRAPH_INDEX: string }).OPENCLAW_GRAPH_INDEX = "shadow"
    const manifest: RepoIndexManifestV1 = {
      v: 1, repo: "sigilix", owner: "Arc-and-Anchor",
      headSha,
      runId,
      fileCount: 1, chunkCount: 1, shardCount: 1,
      indexedAt: "2026-05-17T00:00:00.000Z",
      modelId: EMBEDDING_MODEL,
      embeddingDim: EMBEDDING_DIMENSIONS,
      chunkerVersion: CHUNKER_VERSION,
      windowLines: 30, overlapLines: 10,
    }
    kv.set(repoIndexManifestKey("Arc-and-Anchor", "sigilix"), JSON.stringify(manifest))
    mockDebugActiveGraphVersion.mockResolvedValue(null)

    await handleIndexRepoJob({ job: bootstrapJob(), env })

    expect(mockGetRepoTree).toHaveBeenCalled()
    expect(mockWriteFileGraph).toHaveBeenCalled()
    expect(mockVectorizeUpsert).toHaveBeenCalled()
    expect(mockCommitGraph).toHaveBeenCalledWith(env, "Arc-and-Anchor", "sigilix", runId)
  })

  it("re-indexes a fresh manifest when graph active version is stale", async () => {
    mockGetRepoTree.mockResolvedValue({
      tree: [{ path: "src/index.ts", type: "blob", size: 100 }],
      truncated: false,
    })

    const headSha = "a".repeat(40)
    const { computeRunId } = await import("../src/lib/indexer")
    const runId = await computeRunId({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      headSha,
      modelId: EMBEDDING_MODEL,
      chunkerVersion: CHUNKER_VERSION,
    })
    const { env, kv } = makeEnv()
    ;(env as Env & { OPENCLAW_GRAPH_INDEX: string }).OPENCLAW_GRAPH_INDEX = "shadow"
    const manifest: RepoIndexManifestV1 = {
      v: 1, repo: "sigilix", owner: "Arc-and-Anchor",
      headSha,
      runId,
      fileCount: 1, chunkCount: 1, shardCount: 1,
      indexedAt: "2026-05-17T00:00:00.000Z",
      modelId: EMBEDDING_MODEL,
      embeddingDim: EMBEDDING_DIMENSIONS,
      chunkerVersion: CHUNKER_VERSION,
      windowLines: 30, overlapLines: 10,
    }
    kv.set(repoIndexManifestKey("Arc-and-Anchor", "sigilix"), JSON.stringify(manifest))
    mockDebugActiveGraphVersion.mockResolvedValue("older-run")

    await handleIndexRepoJob({ job: bootstrapJob(), env })

    expect(mockGetRepoTree).toHaveBeenCalled()
    expect(mockWriteFileGraph).toHaveBeenCalled()
    expect(mockCommitGraph).toHaveBeenCalledWith(env, "Arc-and-Anchor", "sigilix", runId)
  })

  it("does not re-index a fresh manifest on transient graph active-version read failure", async () => {
    const headSha = "a".repeat(40)
    const { computeRunId } = await import("../src/lib/indexer")
    const runId = await computeRunId({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      headSha,
      modelId: EMBEDDING_MODEL,
      chunkerVersion: CHUNKER_VERSION,
    })
    const { env, kv } = makeEnv()
    ;(env as Env & { OPENCLAW_GRAPH_INDEX: string }).OPENCLAW_GRAPH_INDEX = "shadow"
    const manifest: RepoIndexManifestV1 = {
      v: 1, repo: "sigilix", owner: "Arc-and-Anchor",
      headSha,
      runId,
      fileCount: 1, chunkCount: 1, shardCount: 1,
      indexedAt: "2026-05-17T00:00:00.000Z",
      modelId: EMBEDDING_MODEL,
      embeddingDim: EMBEDDING_DIMENSIONS,
      chunkerVersion: CHUNKER_VERSION,
      windowLines: 30, overlapLines: 10,
    }
    kv.set(repoIndexManifestKey("Arc-and-Anchor", "sigilix"), JSON.stringify(manifest))
    mockDebugActiveGraphVersion.mockRejectedValue(new Error("DO transient"))

    await handleIndexRepoJob({ job: bootstrapJob(), env })

    expect(mockGetRepoTree).not.toHaveBeenCalled()
    expect(mockVectorizeUpsert).not.toHaveBeenCalled()
    expect(mockWriteFileGraph).not.toHaveBeenCalled()
    expect(mockCommitGraph).not.toHaveBeenCalled()
  })

  it("re-indexes when headSha differs (the most common case)", async () => {
    mockGetRepoTree.mockResolvedValue({
      tree: [{ path: "src/index.ts", type: "blob", size: 100 }],
      truncated: false,
    })
    mockGetBranch.mockResolvedValue({ headSha: "c".repeat(40), treeSha: "d".repeat(40) })

    const { env, kv } = makeEnv()
    const manifest: RepoIndexManifestV1 = {
      v: 1, repo: "sigilix", owner: "Arc-and-Anchor",
      headSha: "a".repeat(40),
      runId: "deadbeefdeadbeef",
      fileCount: 1, chunkCount: 1, shardCount: 1,
      indexedAt: "2026-05-17T00:00:00.000Z",
      modelId: EMBEDDING_MODEL,
      embeddingDim: EMBEDDING_DIMENSIONS,
      chunkerVersion: 1,
      windowLines: 30, overlapLines: 10,
    }
    kv.set(repoIndexManifestKey("Arc-and-Anchor", "sigilix"), JSON.stringify(manifest))

    await handleIndexRepoJob({ job: bootstrapJob(), env })

    expect(mockGetRepoTree).toHaveBeenCalled()
    expect(mockVectorizeUpsert).toHaveBeenCalled()
  })

  // SIG-136: reproduces the stale-skip abort. UNLIKE the test above, this one
  // ALSO seeds a prior `repo-index-vectors` record for the OLD run — the piece
  // that drives the real stale-skip path. Pre-fix, a repo with a stale manifest
  // + a stored old-run vectors record stale-skipped the new run (no upsert, no
  // new manifest); now the lease lets computeMerge supersede so it re-indexes.
  // NOTE: HIGH-1's concurrent embedding-window race (the early-claim move) is a
  // best-effort-KV concurrency property, covered by the design + the claim
  // ordering — it is not directly reproducible in this single-threaded test.
  it("re-indexes (does NOT stale-abort) when a prior old-run vectors record exists", async () => {
    mockGetRepoTree.mockResolvedValue({
      tree: [{ path: "src/index.ts", type: "blob", size: 100 }],
      truncated: false,
    })
    // New head → new runId. headSha is the ONLY freshness difference.
    const newHeadSha = "c".repeat(40)
    mockGetBranch.mockResolvedValue({ headSha: newHeadSha, treeSha: "d".repeat(40) })

    const { env, kv } = makeEnv()

    // Seed the OLD-run manifest (old headSha, current model/dim/chunker).
    const manifest: RepoIndexManifestV1 = {
      v: 1, repo: "sigilix", owner: "Arc-and-Anchor",
      headSha: "a".repeat(40),
      runId: "old-run",
      fileCount: 1, chunkCount: 1, shardCount: 1,
      indexedAt: "2026-05-17T00:00:00.000Z",
      modelId: EMBEDDING_MODEL,
      embeddingDim: EMBEDDING_DIMENSIONS,
      chunkerVersion: CHUNKER_VERSION,
      windowLines: 30, overlapLines: 10,
    }
    kv.set(repoIndexManifestKey("Arc-and-Anchor", "sigilix"), JSON.stringify(manifest))

    // Seed the prior OLD-run vectors record — the piece the existing
    // re-index test omits. This is what drove the stale-skip pre-fix.
    const vectors: RepoIndexVectorsV1 = {
      v: 1, owner: "Arc-and-Anchor", repo: "sigilix",
      runId: "old-run",
      byPath: { "src/index.ts": ["arc-and-anchor/sigilix#old-run#0"] },
    }
    kv.set(repoIndexVectorsKey("Arc-and-Anchor", "sigilix"), JSON.stringify(vectors))

    await handleIndexRepoJob({ job: bootstrapJob(), env })

    // Compute the runId the consumer derives for the new head.
    const { computeRunId } = await import("../src/lib/indexer")
    const newRunId = await computeRunId({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      headSha: newHeadSha,
      modelId: EMBEDDING_MODEL,
      chunkerVersion: CHUNKER_VERSION,
    })
    // Sanity: the seeded path differs from the path under test.
    expect(newRunId).not.toBe("old-run")

    // It RE-INDEXES rather than stale-aborting.
    expect(mockVectorizeUpsert).toHaveBeenCalled()

    // A new manifest with the new runId lands.
    const storedManifest = kv.get(repoIndexManifestKey("Arc-and-Anchor", "sigilix"))
    expect(storedManifest).toBeTruthy()
    const parsedManifest = JSON.parse(storedManifest as string) as RepoIndexManifestV1
    expect(parsedManifest.runId).toBe(newRunId)
    expect(parsedManifest.headSha).toBe(newHeadSha)

    // The active-run lease holds the new runId.
    const storedLease = kv.get(activeRunKey("Arc-and-Anchor", "sigilix"))
    expect(storedLease).toBeTruthy()
    const parsedLease = JSON.parse(storedLease as string) as { runId: string }
    expect(parsedLease.runId).toBe(newRunId)

    // SIG-136 HIGH-1: the lease must be claimed BEFORE the (slow) embedding/upsert work.
    const putSpy = (env.OPENCLAW_STATE as unknown as { put: ReturnType<typeof vi.fn> }).put
    const leaseKey = activeRunKey("Arc-and-Anchor", "sigilix")
    const leaseCallIdx = putSpy.mock.calls.findIndex((args) => args[0] === leaseKey)
    expect(leaseCallIdx).toBeGreaterThanOrEqual(0)
    const leasePut = putSpy.mock.invocationCallOrder[leaseCallIdx]!
    const firstUpsert = mockVectorizeUpsert.mock.invocationCallOrder[0]!
    expect(leasePut).toBeLessThan(firstUpsert)
  })
})

describe("handleIndexRepoJob — bootstrap with >MAX_FILES_PER_JOB enqueues next shard", () => {
  it("processes first MAX slice and enqueues continuation; does NOT write manifest", async () => {
    // Build a tree with MAX_FILES_PER_JOB + 5 indexable files.
    const tree = Array.from({ length: MAX_FILES_PER_JOB + 5 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      type: "blob",
      size: 100,
    }))
    mockGetRepoTree.mockResolvedValue({ tree, truncated: false })

    const { env, sent, kv } = makeEnv()
    await handleIndexRepoJob({ job: bootstrapJob(), env })

    expect(mockGetFileContent).toHaveBeenCalledTimes(MAX_FILES_PER_JOB)
    // No manifest yet — chain not complete.
    expect(kv.has(repoIndexManifestKey("Arc-and-Anchor", "sigilix"))).toBe(false)
    // One shard enqueued.
    expect(sent).toHaveLength(1)
    const next = sent[0]!.message
    if (next.type !== "index-repo") throw new Error("unexpected job type")
    expect(next.shard).toBeDefined()
    expect(next.shard?.lo).toBe(MAX_FILES_PER_JOB)
    expect(next.shard?.hi).toBe(MAX_FILES_PER_JOB + 5)
    expect(next.shard?.totalFiles).toBe(MAX_FILES_PER_JOB + 5)
    expect(next.shard?.filesDone).toBe(MAX_FILES_PER_JOB)
  })
})

describe("handleIndexRepoJob — final shard writes manifest with cumulative totals", () => {
  it("uses incoming filesDone+chunksDone + own slice to write the manifest", async () => {
    const totalFiles = MAX_FILES_PER_JOB + 3
    const tree = Array.from({ length: totalFiles }, (_, i) => ({
      path: `src/file-${i}.ts`,
      type: "blob",
      size: 100,
    }))
    mockGetRepoTree.mockResolvedValue({ tree, truncated: false })

    // Simulate the final shard message that the bootstrap would have
    // enqueued: lo=MAX, hi=totalFiles, filesDone=MAX, chunksDone=K.
    const headSha = "a".repeat(40)
    const treeSha = "b".repeat(40)
    // Compute the actual runId the consumer expects.
    const { computeRunId } = await import("../src/lib/indexer")
    const runId = await computeRunId({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      headSha,
      modelId: EMBEDDING_MODEL,
      chunkerVersion: 2,
    })
    const job: JobMessage = {
      type: "index-repo",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      installationId: 99,
      reason: "install",
      shard: {
        lo: MAX_FILES_PER_JOB,
        hi: totalFiles,
        headSha,
        treeSha,
        totalFiles,
        filesDone: MAX_FILES_PER_JOB,
        chunksDone: 4242,
        runId,
      },
    }

    const { env, kv } = makeEnv()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    await handleIndexRepoJob({ job, env })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("index-shard-default-branch-missing"))

    // Final shard processed the trailing 3 files.
    expect(mockGetFileContent).toHaveBeenCalledTimes(3)
    // Manifest written with cumulative totals.
    const stored = kv.get(repoIndexManifestKey("Arc-and-Anchor", "sigilix"))
    expect(stored).toBeTruthy()
    if (stored) {
      const parsed = JSON.parse(stored) as RepoIndexManifestV1
      expect(parsed.fileCount).toBe(MAX_FILES_PER_JOB + 3)
      // CodeRabbit nit on PR #76: assert exact. The mock returns a
      // 2-line content per file → chunkFile emits exactly 1 chunk per
      // file. Final shard's 3 files add 3 chunks. 4242 + 3 = 4245.
      expect(parsed.chunkCount).toBe(4245)
      // shardCount derived from ceil(totalFiles / MAX_FILES_PER_JOB) = 2.
      expect(parsed.shardCount).toBe(2)
    }
  })
})

describe("handleIndexRepoJob — config-drift refusal (Kimi v2 d.1)", () => {
  it("aborts a shard chain when the recomputed runId doesn't match the shard's runId", async () => {
    const job: JobMessage = {
      type: "index-repo",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      installationId: 99,
      reason: "install",
      shard: {
        lo: 0, hi: 100,
        headSha: "a".repeat(40),
        treeSha: "b".repeat(40),
        totalFiles: 100,
        filesDone: 0,
        chunksDone: 0,
        runId: "stale-run-id-0000",
      },
    }

    const { env, kv } = makeEnv()
    await handleIndexRepoJob({ job, env })

    // No work performed.
    expect(mockGetRepoTree).not.toHaveBeenCalled()
    expect(mockGetFileContent).not.toHaveBeenCalled()
    expect(mockVectorizeUpsert).not.toHaveBeenCalled()
    expect(kv.has(repoIndexManifestKey("Arc-and-Anchor", "sigilix"))).toBe(false)
  })
})

describe("handleIndexRepoJob — tree truncated refusal", () => {
  it("does NOT write a manifest when the GitHub trees response is truncated", async () => {
    mockGetRepoTree.mockResolvedValue({
      tree: [{ path: "src/index.ts", type: "blob", size: 100 }],
      truncated: true,
    })

    const { env, kv } = makeEnv()
    await handleIndexRepoJob({ job: bootstrapJob(), env })

    expect(mockGetFileContent).not.toHaveBeenCalled()
    expect(mockVectorizeUpsert).not.toHaveBeenCalled()
    expect(kv.has(repoIndexManifestKey("Arc-and-Anchor", "sigilix"))).toBe(false)
  })
})

describe("handleIndexRepoJob — sensitive-repo gate (consumer-side)", () => {
  it("returns without touching anything when repo is in the sensitive denylist", async () => {
    const { env, kv } = makeEnv({ sensitive: "arc-and-anchor/sigilix" })
    await handleIndexRepoJob({ job: bootstrapJob(), env })

    expect(mockGetRepository).not.toHaveBeenCalled()
    expect(mockGetRepoTree).not.toHaveBeenCalled()
    expect(kv.has(repoIndexManifestKey("Arc-and-Anchor", "sigilix"))).toBe(false)
  })
})

describe("handleIndexRepoJob — repo lookups returning null", () => {
  it("acks cleanly when getRepository returns null (404)", async () => {
    mockGetRepository.mockResolvedValue(null)
    const { env, kv } = makeEnv()
    await handleIndexRepoJob({ job: bootstrapJob(), env })
    expect(mockGetBranch).not.toHaveBeenCalled()
    expect(kv.has(repoIndexManifestKey("Arc-and-Anchor", "sigilix"))).toBe(false)
  })

  it("acks cleanly when getBranch returns null", async () => {
    mockGetBranch.mockResolvedValue(null)
    const { env, kv } = makeEnv()
    await handleIndexRepoJob({ job: bootstrapJob(), env })
    expect(mockGetRepoTree).not.toHaveBeenCalled()
    expect(kv.has(repoIndexManifestKey("Arc-and-Anchor", "sigilix"))).toBe(false)
  })

  it("acks cleanly when getRepoTree returns null", async () => {
    mockGetRepoTree.mockResolvedValue(null)
    const { env, kv } = makeEnv()
    await handleIndexRepoJob({ job: bootstrapJob(), env })
    expect(mockGetFileContent).not.toHaveBeenCalled()
    expect(kv.has(repoIndexManifestKey("Arc-and-Anchor", "sigilix"))).toBe(false)
  })
})

describe("handleIndexRepoJob — empty repo (no indexable files)", () => {
  it("writes the manifest with zero counts so subsequent webhooks short-circuit", async () => {
    mockGetRepoTree.mockResolvedValue({
      tree: [{ path: "image.png", type: "blob", size: 100 }], // non-indexable extension
      truncated: false,
    })

    const { env, kv } = makeEnv()
    await handleIndexRepoJob({ job: bootstrapJob(), env })

    expect(mockGetFileContent).not.toHaveBeenCalled()
    expect(mockVectorizeUpsert).not.toHaveBeenCalled()
    const stored = kv.get(repoIndexManifestKey("Arc-and-Anchor", "sigilix"))
    expect(stored).toBeTruthy()
    if (stored) {
      const parsed = JSON.parse(stored) as RepoIndexManifestV1
      expect(parsed.fileCount).toBe(0)
      expect(parsed.chunkCount).toBe(0)
    }
  })
})

// code-reviewer NIT-5: pin the ARC-238 Codex B3 invariant — if the
// vectors-record KV write fails, the manifest MUST NOT be written
// (otherwise the repo looks indexed but uninstall has no ids to
// delete → silent vector retention).
describe("handleIndexRepoJob — ARC-238 B3 invariant: vectors-write failure blocks manifest write", () => {
  it("bootstrap path: when KV.put fails for repo-index-vectors:*, no manifest is written and the job throws", async () => {
    mockGetRepoTree.mockResolvedValue({
      tree: [{ path: "src/index.ts", type: "blob", size: 100 }],
      truncated: false,
    })

    // Custom env: KV.put rejects only when writing the vectors record.
    const store = new Map<string, string>()
    const kv = {
      async get(key: string): Promise<string | null> {
        return store.get(key) ?? null
      },
      async put(key: string, value: string): Promise<void> {
        if (key.startsWith("repo-index-vectors:")) {
          throw new Error("KV write failure for vectors record")
        }
        store.set(key, value)
      },
      async delete(key: string): Promise<void> {
        store.delete(key)
      },
    } as unknown as Env["OPENCLAW_STATE"]
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_JOBS: { send: async (_msg: JobMessage) => {} },
      AI: { run: (model: string, input: unknown) => mockAiRun(model, input) },
      OPENCLAW_CODE_INDEX: { upsert: mockVectorizeUpsert },
      GITHUB_APP_ID: "12345",
      GITHUB_PRIVATE_KEY: "fake-key",
    } as unknown as Env

    // SIG-137: the delete-coverage write now PRECEDES the Vectorize upsert, so
    // a repo-index-vectors KV failure is caught before any vector is upserted.
    await expect(handleIndexRepoJob({ job: bootstrapJob(), env })).rejects.toThrow(
      /repo-index-vectors coverage write failed/,
    )

    // Coverage-before-upsert guarantee: nothing was upserted to Vectorize
    // before the ledger write failed (so no orphan is even possible here).
    expect(mockVectorizeUpsert).not.toHaveBeenCalled()
    // Manifest must NOT have been written.
    expect(store.has(repoIndexManifestKey("Arc-and-Anchor", "sigilix"))).toBe(false)
  })

  it("shard path: same invariant — no manifest write + no next-shard enqueue on vectors-write failure", async () => {
    const totalFiles = MAX_FILES_PER_JOB + 3
    const tree = Array.from({ length: totalFiles }, (_, i) => ({
      path: `src/file-${i}.ts`,
      type: "blob",
      size: 100,
    }))
    mockGetRepoTree.mockResolvedValue({ tree, truncated: false })

    const store = new Map<string, string>()
    const sent: JobMessage[] = []
    const kv = {
      async get(key: string): Promise<string | null> {
        return store.get(key) ?? null
      },
      async put(key: string, value: string): Promise<void> {
        if (key.startsWith("repo-index-vectors:")) {
          throw new Error("KV write failure for vectors record")
        }
        store.set(key, value)
      },
      async delete(key: string): Promise<void> {
        store.delete(key)
      },
    } as unknown as Env["OPENCLAW_STATE"]
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_JOBS: { send: async (m: JobMessage) => { sent.push(m) } },
      AI: { run: (model: string, input: unknown) => mockAiRun(model, input) },
      OPENCLAW_CODE_INDEX: { upsert: mockVectorizeUpsert },
      GITHUB_APP_ID: "12345",
      GITHUB_PRIVATE_KEY: "fake-key",
    } as unknown as Env

    const { computeRunId } = await import("../src/lib/indexer")
    const headSha = "a".repeat(40)
    const runId = await computeRunId({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      headSha,
      // CodeRabbit phase-end fix: use the imported constant so a
      // future EMBEDDING_MODEL rotation doesn't make this test silently
      // hit the config-drift guard instead of exercising the B3 invariant.
      modelId: EMBEDDING_MODEL,
      chunkerVersion: 2,
    })
    const shardJob: JobMessage = {
      type: "index-repo",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      installationId: 99,
      reason: "install",
      shard: {
        lo: MAX_FILES_PER_JOB,
        hi: totalFiles,
        headSha,
        treeSha: "b".repeat(40),
        totalFiles,
        filesDone: MAX_FILES_PER_JOB,
        chunksDone: 4242,
        runId,
      },
    }

    // SIG-137: coverage write precedes upsert → caught before any upsert.
    await expect(handleIndexRepoJob({ job: shardJob, env })).rejects.toThrow(
      /repo-index-vectors coverage write failed/,
    )
    expect(mockVectorizeUpsert).not.toHaveBeenCalled()
    // No manifest, no next-shard enqueue (final shard would have
    // written the manifest; non-final would have enqueued).
    expect(store.has(repoIndexManifestKey("Arc-and-Anchor", "sigilix"))).toBe(false)
    expect(sent).toHaveLength(0)
  })
})

// SIG-172 M2 (fix-up) — `persistScopedRulesManifest` is gated by the
// active-run lease (same `shouldFinalize` check that protects
// `persistManifest` + `persistVectorIds`). An older overlapping
// bootstrap whose rule-file walk completes AFTER a newer run has
// taken the lease must NOT clobber the newer run's scoped-rules
// manifest with stale rule content.
describe("handleIndexRepoJob — scoped-rules write yields to a newer run", () => {
  it("does NOT write the scoped-rules manifest when the lease has been taken by a newer run mid-walk", async () => {
    // Tree includes a SIGILIX.md plus a normal source file so the
    // bootstrap still has shape; the scoped-rules walk + write are
    // the only thing we care about here.
    mockGetRepoTree.mockResolvedValue({
      tree: [
        { path: "SIGILIX.md", type: "blob", size: 100 },
        { path: "src/index.ts", type: "blob", size: 100 },
      ],
      truncated: false,
    })

    const { env, kv } = makeEnv()
    const owner = "Arc-and-Anchor"
    const repo = "sigilix"

    // Hook the rule-file content fetch: when the indexer pulls
    // SIGILIX.md (the per-rule-file step inside persistScopedRulesManifest),
    // simulate a competing newer bootstrap claiming the lease before
    // the current run reaches its leaseAllows check at the write site.
    mockGetFileContent.mockImplementation(async (_o, _r, path: string) => {
      if (path === "SIGILIX.md") {
        // Overwrite the active-run lease with a fresher runId. This
        // is the in-the-wild scenario: a second `writeActiveRun` from
        // a newer bootstrap landing while THIS run was mid-fetch.
        kv.set(activeRunKey(owner, repo), JSON.stringify({
          v: 1, runId: "newer-run-supersedes", startedAt: new Date().toISOString(),
        }))
        return `# Repo-root SIGILIX.md\nbody`
      }
      return `// content of ${path}\nconsole.log("hi")`
    })

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    await handleIndexRepoJob({ job: bootstrapJob(), env })

    // The KV write for the scoped-rules manifest MUST NOT have
    // landed: an older run cannot clobber the newer run's rules.
    expect(kv.has(scopedRulesKey(owner, repo))).toBe(false)

    // The skip-superseded telemetry MUST have fired so dashboards
    // can see that the rule walk was thrown away (rather than
    // silently dropped).
    const events = warnSpy.mock.calls.map((c) => {
      try { return JSON.parse(c[0] as string) } catch { return null }
    })
    warnSpy.mockRestore()
    const skipped = events.find((e) => e && e.event === "scoped-rules-manifest-skip-superseded")
    expect(skipped).toBeDefined()
    expect(skipped.owner).toBe(owner)
    expect(skipped.repo).toBe(repo)
    // file_count records what WOULD have been written — sanity that
    // the SIGILIX.md walk did reach the entry-build stage before the
    // lease check suppressed the write.
    expect(typeof skipped.file_count).toBe("number")
    expect(skipped.file_count).toBeGreaterThanOrEqual(1)
  })
})
