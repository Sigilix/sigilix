// ARC-236 — tests for the cold-start warmup helper.
//
// Covers the three entry points:
//   - `postWarmupStickyIfUnindexed`: posts sticky when manifest is missing,
//     skips when manifest exists; idempotent upsert when sticky already exists.
//   - `updateWarmupStickyToReady`: gated on manifest existence; no-ops on
//     "still warming" repos so a diff-only review doesn't claim indexing is ready.
//   - `enqueueWarmupRerunsForIndex`: scans open PRs, filters to those with
//     warmup sticky, enqueues `pr-review-rerun` per match.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
  mockGetInstallationToken,
  mockListIssueComments,
  mockCreateIssueComment,
  mockUpdateIssueComment,
  mockListOpenPullRequests,
} = vi.hoisted(() => ({
  mockGetInstallationToken: vi.fn(async () => "test-token"),
  mockListIssueComments: vi.fn(),
  mockCreateIssueComment: vi.fn(),
  mockUpdateIssueComment: vi.fn(),
  mockListOpenPullRequests: vi.fn(),
}))

vi.mock("../src/lib/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("../src/lib/github", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/github")>("../src/lib/github")
  class GitHubClientMock {
    async listIssueComments(...args: unknown[]): Promise<unknown> {
      return mockListIssueComments(...args)
    }
    async createIssueComment(...args: unknown[]): Promise<unknown> {
      return mockCreateIssueComment(...args)
    }
    async updateIssueComment(...args: unknown[]): Promise<unknown> {
      return mockUpdateIssueComment(...args)
    }
    async listOpenPullRequests(...args: unknown[]): Promise<unknown> {
      return mockListOpenPullRequests(...args)
    }
  }
  return { ...actual, GitHubClient: GitHubClientMock }
})

import {
  enqueueWarmupRerunsForIndex,
  postWarmupStickyIfUnindexed,
  updateWarmupStickyToReady,
  WARMUP_MARKER,
} from "../src/lib/warmup"
import {
  repoIndexManifestKey,
  type RepoIndexManifestV1,
} from "../src/lib/repo-index-manifest"
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "../src/lib/embeddings"
import { GitHubClient } from "../src/lib/github"
import type { Env, JobMessage } from "../src/index"

function makeKvStub(): {
  kv: Env["OPENCLAW_STATE"]
  store: Map<string, string>
} {
  const store = new Map<string, string>()
  const kv = {
    async get(key: string): Promise<string | null> { return store.get(key) ?? null },
    async put(key: string, value: string): Promise<void> { store.set(key, value) },
    async delete(key: string): Promise<void> { store.delete(key) },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store }
}

function makeEnv(opts: { credentials?: boolean } = {}): { env: Env; sent: JobMessage[]; kv: Map<string, string> } {
  const haveCreds = opts.credentials ?? true
  const { kv, store } = makeKvStub()
  const sent: JobMessage[] = []
  const env = {
    OPENCLAW_STATE: kv,
    OPENCLAW_JOBS: { send: async (m: JobMessage) => { sent.push(m) } },
    GITHUB_APP_ID: haveCreds ? "12345" : undefined,
    GITHUB_PRIVATE_KEY: haveCreds ? "fake-key" : undefined,
  } as unknown as Env
  return { env, sent, kv: store }
}

function manifest(over: Partial<RepoIndexManifestV1> = {}): RepoIndexManifestV1 {
  return {
    v: 1, repo: "sigilix", owner: "Arc-and-Anchor",
    headSha: "a".repeat(40), runId: "0123456789abcdef",
    fileCount: 1, chunkCount: 1, shardCount: 1,
    indexedAt: "2026-05-17T00:00:00.000Z",
    modelId: EMBEDDING_MODEL, embeddingDim: EMBEDDING_DIMENSIONS,
    chunkerVersion: 1, windowLines: 30, overlapLines: 10,
    ...over,
  }
}

const baseArgs = {
  owner: "Arc-and-Anchor",
  repo: "sigilix",
  prNumber: 237,
  installationId: 99,
} as const

beforeEach(() => {
  mockGetInstallationToken.mockClear()
  mockListIssueComments.mockReset()
  mockCreateIssueComment.mockReset()
  mockUpdateIssueComment.mockReset()
  mockListOpenPullRequests.mockReset()
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("postWarmupStickyIfUnindexed", () => {
  it("skips when manifest exists (repo is already indexed)", async () => {
    const { env, kv } = makeEnv()
    kv.set(repoIndexManifestKey("sigilix"), JSON.stringify(manifest()))
    const outcome = await postWarmupStickyIfUnindexed({ env, ...baseArgs })
    expect(outcome).toEqual({ skipped: "already-indexed" })
    expect(mockGetInstallationToken).not.toHaveBeenCalled()
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
  })

  it("creates the warmup sticky when manifest is missing", async () => {
    mockListIssueComments.mockResolvedValue([])
    mockCreateIssueComment.mockResolvedValue({ id: 555 })

    const { env } = makeEnv()
    const outcome = await postWarmupStickyIfUnindexed({ env, ...baseArgs })

    expect(outcome).toEqual({ posted: "created", commentId: 555 })
    expect(mockCreateIssueComment).toHaveBeenCalledTimes(1)
    const [, , , body] = mockCreateIssueComment.mock.calls[0]!
    expect(body).toContain(WARMUP_MARKER)
    expect(body).toContain("warming up")
  })

  it("updates the existing sticky in-place (idempotent on re-fire)", async () => {
    mockListIssueComments.mockResolvedValue([
      { id: 77, body: `prior ${WARMUP_MARKER} content` },
    ])
    mockUpdateIssueComment.mockResolvedValue(undefined)

    const { env } = makeEnv()
    const outcome = await postWarmupStickyIfUnindexed({ env, ...baseArgs })

    expect(outcome).toEqual({ posted: "updated", commentId: 77 })
    expect(mockUpdateIssueComment).toHaveBeenCalledTimes(1)
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
  })

  it("returns missing-creds skip without throwing when GitHub App not configured", async () => {
    const { env } = makeEnv({ credentials: false })
    const outcome = await postWarmupStickyIfUnindexed({ env, ...baseArgs })
    expect(outcome).toEqual({ skipped: "missing-creds" })
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
  })

  it("returns failed without throwing when GitHub rejects the create", async () => {
    mockListIssueComments.mockResolvedValue([])
    mockCreateIssueComment.mockRejectedValue(new Error("HTTP 403 Forbidden"))
    const { env } = makeEnv()
    const outcome = await postWarmupStickyIfUnindexed({ env, ...baseArgs })
    expect("failed" in outcome).toBe(true)
  })
})

describe("updateWarmupStickyToReady", () => {
  it("skips (not-yet-indexed) when manifest is missing — the review just posted was diff-only", async () => {
    const { env } = makeEnv()
    // No manifest seeded.
    const outcome = await updateWarmupStickyToReady({ env, ...baseArgs })
    expect(outcome).toEqual({ skipped: "not-yet-indexed" })
    expect(mockListIssueComments).not.toHaveBeenCalled()
  })

  it("flips sticky to ready body when manifest exists AND sticky is present", async () => {
    mockListIssueComments.mockResolvedValue([
      { id: 88, body: `${WARMUP_MARKER}\nwarming up` },
    ])
    mockUpdateIssueComment.mockResolvedValue(undefined)

    const { env, kv } = makeEnv()
    kv.set(repoIndexManifestKey("sigilix"), JSON.stringify(manifest()))
    const outcome = await updateWarmupStickyToReady({ env, ...baseArgs })

    expect(outcome).toEqual({ updated: true, commentId: 88 })
    const [, , commentId, body] = mockUpdateIssueComment.mock.calls[0]!
    expect(commentId).toBe(88)
    expect(body).toContain(WARMUP_MARKER)
    expect(body).toContain("Index ready")
  })

  it("skips (no-sticky) when sticky doesn't exist — typical post-indexing PR", async () => {
    mockListIssueComments.mockResolvedValue([
      { id: 1, body: "unrelated comment" },
    ])

    const { env, kv } = makeEnv()
    kv.set(repoIndexManifestKey("sigilix"), JSON.stringify(manifest()))
    const outcome = await updateWarmupStickyToReady({ env, ...baseArgs })

    expect(outcome).toEqual({ skipped: "no-sticky" })
    expect(mockUpdateIssueComment).not.toHaveBeenCalled()
  })

  it("returns missing-creds skip when GitHub App not configured", async () => {
    const { env, kv } = makeEnv({ credentials: false })
    kv.set(repoIndexManifestKey("sigilix"), JSON.stringify(manifest()))
    const outcome = await updateWarmupStickyToReady({ env, ...baseArgs })
    expect(outcome).toEqual({ skipped: "missing-creds" })
  })
})

describe("enqueueWarmupRerunsForIndex", () => {
  it("enqueues pr-review-rerun for every open PR with the warmup sticky", async () => {
    mockListOpenPullRequests.mockResolvedValue([
      { number: 10 },
      { number: 11 },
      { number: 12 },
    ])
    // PR 10 has sticky, PR 11 doesn't, PR 12 has sticky.
    mockListIssueComments.mockImplementation(async (_o: string, _r: string, prNumber: number) => {
      if (prNumber === 10) return [{ id: 1, body: `something ${WARMUP_MARKER}` }]
      if (prNumber === 11) return [{ id: 2, body: "no marker" }]
      if (prNumber === 12) return [{ id: 3, body: WARMUP_MARKER }]
      return []
    })

    const { env, sent } = makeEnv()
    const client = new GitHubClient({ token: "t" })
    const result = await enqueueWarmupRerunsForIndex({
      env, client, owner: "Arc-and-Anchor", repo: "sigilix", installationId: 99,
    })

    expect(result).toEqual({ enqueued: 2, scanned: 3 })
    expect(sent).toHaveLength(2)
    const numbers = sent.flatMap((m) => m.type === "pr-review-rerun" ? [m.prNumber] : [])
    expect(numbers.sort()).toEqual([10, 12])
  })

  it("returns zero counts when listOpenPullRequests fails", async () => {
    mockListOpenPullRequests.mockRejectedValue(new Error("HTTP 502"))
    const { env, sent } = makeEnv()
    const client = new GitHubClient({ token: "t" })
    const result = await enqueueWarmupRerunsForIndex({
      env, client, owner: "Arc-and-Anchor", repo: "sigilix", installationId: 99,
    })
    expect(result).toEqual({ enqueued: 0, scanned: 0 })
    expect(sent).toHaveLength(0)
  })

  it("skips individual PR if listIssueComments fails for it (doesn't abort fan-out)", async () => {
    mockListOpenPullRequests.mockResolvedValue([
      { number: 10 },
      { number: 11 },
    ])
    mockListIssueComments.mockImplementation(async (_o: string, _r: string, prNumber: number) => {
      if (prNumber === 10) throw new Error("403 on PR 10")
      return [{ id: 99, body: WARMUP_MARKER }]
    })

    const { env, sent } = makeEnv()
    const client = new GitHubClient({ token: "t" })
    const result = await enqueueWarmupRerunsForIndex({
      env, client, owner: "Arc-and-Anchor", repo: "sigilix", installationId: 99,
    })

    expect(result).toEqual({ enqueued: 1, scanned: 2 })
    expect(sent).toHaveLength(1)
    if (sent[0]?.type === "pr-review-rerun") {
      expect(sent[0].prNumber).toBe(11)
    }
  })

  it("handles empty open-PR list", async () => {
    mockListOpenPullRequests.mockResolvedValue([])
    const { env, sent } = makeEnv()
    const client = new GitHubClient({ token: "t" })
    const result = await enqueueWarmupRerunsForIndex({
      env, client, owner: "Arc-and-Anchor", repo: "sigilix", installationId: 99,
    })
    expect(result).toEqual({ enqueued: 0, scanned: 0 })
    expect(sent).toHaveLength(0)
  })
})
