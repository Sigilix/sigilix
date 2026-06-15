// SIG-422 — compare-recovery incremental indexing. The producer enqueues a
// default-branch re-index (`merged-pr`) on every PR merge with no push
// `before` / `changedPaths`; chain-drifted pushes lose their fast-path too.
// Before SIG-422 both forced a full repo re-embed (~16,694 chunks → ~$372/mo).
// These suites prove the consumer gate now recovers a complete forward delta
// from the GitHub Compare API and stays incremental — or falls back to full
// whenever the delta could be incomplete (recall-safety absolute).
//
// Shares the env / KV / job fixtures with indexer-incremental.test.ts via
// indexer-incremental.test-helpers.ts; the `vi.hoisted` / `vi.mock` blocks
// stay per-file because vitest hoists them per module.

import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  mockGetInstallationToken,
  mockGetRepository,
  mockGetBranch,
  mockGetCommit,
  mockGetRepoTree,
  mockGetFileContent,
  mockCompareCommits,
  mockAiRun,
  mockVectorizeUpsert,
  mockVectorizeDeleteByIds,
  mockDebugActiveGraphVersion,
  mockDeleteLexicalIds,
} = vi.hoisted(() => ({
  mockGetInstallationToken: vi.fn(async (_args: unknown) => "test-token"),
  mockGetRepository: vi.fn(),
  mockGetBranch: vi.fn(),
  mockGetCommit: vi.fn(),
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
    async getCommit(owner: string, repo: string, sha: string): Promise<unknown> {
      return mockGetCommit(owner, repo, sha)
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
  writeFileGraph: vi.fn(async (..._args: unknown[]) => undefined),
  commitGraph: vi.fn(async (..._args: unknown[]) => undefined),
  debugActiveGraphVersion: (...args: unknown[]) => mockDebugActiveGraphVersion(...args),
}))

vi.mock("@/src/lib/lexical-index", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/lexical-index")>("@/src/lib/lexical-index")
  return {
    ...actual,
    deleteLexicalIds: (...args: unknown[]) => mockDeleteLexicalIds(...args),
  }
})

import { handleIndexRepoJob } from "@/src/lib/indexer"
import { repoIndexManifestKey, type RepoIndexManifestV1 } from "@/src/lib/repo-index-manifest"
import { repoIndexVectorsKey, type RepoIndexVectorsV1 } from "@/src/lib/repo-index-vectors"
import { EMBEDDING_DIMENSIONS } from "@/src/shared/adapters/model"
import type { JobMessage } from "@/src/shared/types/job"
import {
  makeEnv as makeEnvShared,
  seedIndexedRepo,
  pushJobWithChangedPaths,
  pushJobPinned,
  pullRequestJob,
  mergedPrJob,
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
  // SIG-422: `getCommit` resolves a pinned push `after` to its tree. Default
  // echoes the requested SHA as headSha with the same tree the live branch +
  // `getRepoTree` mock use, so a pinned head walks the same indexable files.
  mockGetCommit.mockReset().mockImplementation(async (_owner, _repo, sha: string) => ({
    headSha: sha,
    treeSha: "d".repeat(40),
  }))
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
    totalCommits: 1,
    files: [
      { status: "modified", filename: "src/changed.ts", previous_filename: null },
      { status: "removed", filename: "src/deleted.ts", previous_filename: null },
    ],
  })
})

describe("handleIndexRepoJob — SIG-422 compare-recovery incremental", () => {
  it("recovers the delta via the Compare API for a merged-pr re-index instead of a full re-embed", async () => {
    // SIG-422 case (a) — THE key regression. merged-pr carries no `before`
    // and no `changedPaths`, so before SIG-422 it forced a full repo
    // re-embed (every file fetched). Now it recovers a complete forward
    // delta from the Compare API and stays incremental.
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)

    await handleIndexRepoJob({ job: mergedPrJob(), env })

    expect(mockCompareCommits).toHaveBeenCalledWith("Sigilix", "sigilix", "a".repeat(40), "c".repeat(40))
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/changed.ts", "c".repeat(40))
    // The unchanged file is NEVER fetched — that's the proof this is the
    // incremental path, not the full-tree re-embed it used to take.
    expect(mockGetFileContent).not.toHaveBeenCalledWith("Sigilix", "sigilix", "src/unchanged.ts", "c".repeat(40))
    expect(mockVectorizeDeleteByIds).toHaveBeenCalledWith(["old-changed-id", "old-deleted-id"])

    const manifest = JSON.parse(kv.get(repoIndexManifestKey("Sigilix", "sigilix")) as string) as RepoIndexManifestV1
    expect(manifest.headSha).toBe("c".repeat(40))
  })

  it("maps renamed files in the compare delta to a remove of the old path plus an upsert of the new", async () => {
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)
    mockGetRepoTree.mockResolvedValue({
      tree: [
        { path: "src/renamed.ts", type: "blob", size: 100 },
        { path: "src/unchanged.ts", type: "blob", size: 100 },
      ],
      truncated: false,
    })
    mockGetFileContent.mockImplementation(async (_owner, _repo, path: string) => {
      if (path === "src/renamed.ts") return "export const renamed = 1\n"
      if (path === "src/unchanged.ts") return "export const unchanged = 1\n"
      return null
    })
    mockCompareCommits.mockResolvedValue({
      status: "ahead",
      totalCommits: 1,
      files: [{ status: "renamed", filename: "src/renamed.ts", previous_filename: "src/changed.ts" }],
    })

    await handleIndexRepoJob({ job: mergedPrJob(), env })

    // Old path's vectors removed, new path fetched + embedded.
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/renamed.ts", "c".repeat(40))
    const deletedIds = mockVectorizeDeleteByIds.mock.calls.flatMap((call) => call[0] as string[])
    expect(deletedIds).toContain("old-changed-id")
    const stored = JSON.parse(kv.get(repoIndexVectorsKey("Sigilix", "sigilix")) as string) as RepoIndexVectorsV1
    expect(stored.byPath["src/changed.ts"]).toBeUndefined()
    expect(stored.byPath["src/renamed.ts"]).toHaveLength(1)
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
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/changed.ts", "c".repeat(40))
    expect(mockGetFileContent).not.toHaveBeenCalledWith("Sigilix", "sigilix", "src/unchanged.ts", "c".repeat(40))
    expect(mockVectorizeDeleteByIds).toHaveBeenCalledWith(["old-changed-id", "old-deleted-id"])
  })

  it("keeps the cheap push fast-path (no Compare call) when changedPaths are present and the chain is intact", async () => {
    // SIG-422 case (c): the pre-existing cheap path must be unchanged — a
    // chain-intact push with changedPaths never hits the Compare API.
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)

    await handleIndexRepoJob({ job: pushJobWithChangedPaths(), env })

    expect(mockCompareCommits).not.toHaveBeenCalled()
    expect(mockGetFileContent).toHaveBeenCalledTimes(2)
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/changed.ts", "c".repeat(40))
    expect(mockGetFileContent).not.toHaveBeenCalledWith("Sigilix", "sigilix", "src/unchanged.ts", "c".repeat(40))
  })

  it("falls back to full indexing when the compare status is diverged", async () => {
    // SIG-422 case (d): a force-push / history rewrite — base is not an
    // ancestor of head, so a delta would be unsafe. Full fallback.
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)
    mockCompareCommits.mockResolvedValue({
      status: "diverged",
      totalCommits: 1,
      files: [{ status: "modified", filename: "src/changed.ts", previous_filename: null }],
    })

    await handleIndexRepoJob({ job: mergedPrJob(), env })

    // Full-tree path: BOTH files fetched (no incremental delta trusted).
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/changed.ts", "c".repeat(40))
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/unchanged.ts", "c".repeat(40))
  })

  it("falls back to full indexing when the compare file list is at the page cap (possibly truncated)", async () => {
    // SIG-422 case (e, truncation): GitHub caps the compare files array at
    // 300 for the whole comparison; at the cap the delta may be incomplete,
    // so recovery must not trust it.
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)
    mockCompareCommits.mockResolvedValue({
      status: "ahead",
      totalCommits: 1,
      files: Array.from({ length: 300 }, (_v, i) => ({
        status: "modified",
        filename: `src/file-${i}.ts`,
        previous_filename: null,
      })),
    })

    await handleIndexRepoJob({ job: mergedPrJob(), env })

    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/changed.ts", "c".repeat(40))
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/unchanged.ts", "c".repeat(40))
  })

  it("falls back to full indexing when the comparison exceeds the 250-commit no-paging cap", async () => {
    // SIG-422 case (e, commit truncation): a no-paging compare returns only
    // the first 250 commits, so a larger comparison can omit files changed in
    // the dropped commits even when the files array is under 300. The delta
    // would be incomplete — full fallback. (Reachable: the producer drops
    // changedPaths for any push of >20 commits, routing it to compare.)
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)
    mockCompareCommits.mockResolvedValue({
      status: "ahead",
      totalCommits: 251,
      files: [{ status: "modified", filename: "src/changed.ts", previous_filename: null }],
    })

    await handleIndexRepoJob({ job: mergedPrJob(), env })

    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/changed.ts", "c".repeat(40))
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/unchanged.ts", "c".repeat(40))
  })

  it("falls back to full indexing when the comparison commit count is unknown", async () => {
    // SIG-422: a missing/unparseable total_commits is treated as unsafe (we
    // can't prove the files array is complete) — full fallback.
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)
    mockCompareCommits.mockResolvedValue({
      status: "ahead",
      totalCommits: null,
      files: [{ status: "modified", filename: "src/changed.ts", previous_filename: null }],
    })

    await handleIndexRepoJob({ job: mergedPrJob(), env })

    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/changed.ts", "c".repeat(40))
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/unchanged.ts", "c".repeat(40))
  })

  it("falls back to full indexing when the mapped compare delta exceeds the incremental cap", async () => {
    // SIG-422 case (e, oversize): under the 300-file page cap but over the
    // 200-path incremental cap — cheaper to re-embed fully.
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)
    mockCompareCommits.mockResolvedValue({
      status: "ahead",
      totalCommits: 1,
      files: Array.from({ length: 250 }, (_v, i) => ({
        status: "modified",
        filename: `src/file-${i}.ts`,
        previous_filename: null,
      })),
    })

    await handleIndexRepoJob({ job: mergedPrJob(), env })

    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/changed.ts", "c".repeat(40))
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/unchanged.ts", "c".repeat(40))
  })

  it("falls back to full indexing when the compare delta contains an unknown file status", async () => {
    // SIG-422 case (f): an unrecognized status — never leave a file stale
    // because we couldn't classify its change. Full fallback.
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)
    mockCompareCommits.mockResolvedValue({
      status: "ahead",
      totalCommits: 1,
      files: [
        { status: "modified", filename: "src/changed.ts", previous_filename: null },
        { status: "frobnicated", filename: "src/weird.ts", previous_filename: null },
      ],
    })

    await handleIndexRepoJob({ job: mergedPrJob(), env })

    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/changed.ts", "c".repeat(40))
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/unchanged.ts", "c".repeat(40))
  })

  it("falls back to full indexing when the compare call fails", async () => {
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)
    mockCompareCommits.mockResolvedValue(null)

    await handleIndexRepoJob({ job: mergedPrJob(), env })

    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/changed.ts", "c".repeat(40))
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/unchanged.ts", "c".repeat(40))
  })

  it("advances the manifest head via the noop path when the compare delta is empty", async () => {
    // SIG-422: identical / ahead-with-no-net-files is NOT a fallback — it
    // refreshes the manifest head so the NEXT push's `before` matches and
    // the cheap chain re-establishes. No embedding, no tree walk.
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)
    mockCompareCommits.mockResolvedValue({ status: "identical", totalCommits: 0, files: [] })

    await handleIndexRepoJob({ job: mergedPrJob(), env })

    expect(mockGetRepoTree).not.toHaveBeenCalled()
    expect(mockGetFileContent).not.toHaveBeenCalled()
    expect(mockAiRun).not.toHaveBeenCalled()
    expect(mockVectorizeUpsert).not.toHaveBeenCalled()

    const manifest = JSON.parse(kv.get(repoIndexManifestKey("Sigilix", "sigilix")) as string) as RepoIndexManifestV1
    expect(manifest.headSha).toBe("c".repeat(40))
  })

  it("falls back to full indexing for a manual (operator-intent) re-index even with a clean compare", async () => {
    // SIG-422 case (g): manual / install reasons are bootstrap or operator
    // intent — they deliberately re-embed the whole repo, never incremental.
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)

    await handleIndexRepoJob({
      job: { ...mergedPrJob(), reason: "manual" } as Extract<JobMessage, { type: "index-repo" }>,
      env,
    })

    expect(mockCompareCommits).not.toHaveBeenCalled()
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/changed.ts", "c".repeat(40))
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/unchanged.ts", "c".repeat(40))
  })

  it("labels a pull-request compare-recovery as `pull-request`, not `merged-pr`", async () => {
    // SIG-422 telemetry: a pull-request re-index recovers via compare just
    // like merged-pr, but the recovered log's `trigger` must distinguish it.
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)

    await handleIndexRepoJob({ job: pullRequestJob(), env })

    const recovered = logSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.event === "index-incremental-compare-recovered")
    expect(recovered).toBeDefined()
    expect(recovered!.trigger).toBe("pull-request")
    logSpy.mockRestore()
  })

  it("threads the trigger AND the fallback cause into the fallback-full log", async () => {
    // SIG-422 telemetry: a merged-pr that falls back (here: diverged) logs
    // BOTH axes — trigger=merged-pr (what routed it) and reason=diverged (why
    // the compare delta was rejected).
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)
    mockCompareCommits.mockResolvedValue({
      status: "diverged",
      totalCommits: 1,
      files: [{ status: "modified", filename: "src/changed.ts", previous_filename: null }],
    })
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    await handleIndexRepoJob({ job: mergedPrJob(), env })

    const fallback = warnSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.event === "index-incremental-compare-fallback-full")
    expect(fallback).toBeDefined()
    expect(fallback!.trigger).toBe("merged-pr")
    expect(fallback!.reason).toBe("diverged")
    warnSpy.mockRestore()
  })
})

describe("handleIndexRepoJob — SIG-422 pin index head to the pushed `after`", () => {
  it("pins the index head to the pushed `after` and keeps the chain (no Compare call)", async () => {
    // The key follow-up. A chain-intact push (before == manifest head) pins
    // the head to the pushed commit via getCommit instead of the live tip,
    // trusts the cheap changedPaths delta (no Compare call), and writes
    // manifest.headSha === after — so the NEXT push's `before` matches it.
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)

    await handleIndexRepoJob({ job: pushJobPinned(), env })

    // Head resolved via getCommit(after), NOT the live branch tip.
    expect(mockGetCommit).toHaveBeenCalledWith("Sigilix", "sigilix", "e".repeat(40))
    expect(mockGetBranch).not.toHaveBeenCalled()
    // Cheap fast-path: changedPaths trusted, no Compare recovery.
    expect(mockCompareCommits).not.toHaveBeenCalled()
    // Files fetched at the PINNED head, not the live tip "c".
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/changed.ts", "e".repeat(40))
    expect(mockGetFileContent).not.toHaveBeenCalledWith("Sigilix", "sigilix", "src/unchanged.ts", "e".repeat(40))

    // The chain stays tight: manifest head == pushed after.
    const manifest = JSON.parse(kv.get(repoIndexManifestKey("Sigilix", "sigilix")) as string) as RepoIndexManifestV1
    expect(manifest.headSha).toBe("e".repeat(40))
  })

  it("a second pinned push from the new head stays on the cheap fast-path (chain holds)", async () => {
    // Proves the chain self-sustains: after one pinned index lands at "e"…,
    // the next push with before=="e"… (== the new manifest head) pins again
    // with no Compare call. This is the whole point — fewer recoveries.
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)

    await handleIndexRepoJob({ job: pushJobPinned(), env })
    const afterFirst = JSON.parse(kv.get(repoIndexManifestKey("Sigilix", "sigilix")) as string) as RepoIndexManifestV1
    expect(afterFirst.headSha).toBe("e".repeat(40))

    mockGetCommit.mockClear()
    mockCompareCommits.mockClear()
    // Second push: before is the prior pushed tip, after is a new tip "f"….
    const secondPush = { ...pushJobPinned(), before: "e".repeat(40), after: "f".repeat(40) } as Extract<
      JobMessage,
      { type: "index-repo" }
    >

    await handleIndexRepoJob({ job: secondPush, env })

    expect(mockGetCommit).toHaveBeenCalledWith("Sigilix", "sigilix", "f".repeat(40))
    expect(mockCompareCommits).not.toHaveBeenCalled()
    const afterSecond = JSON.parse(kv.get(repoIndexManifestKey("Sigilix", "sigilix")) as string) as RepoIndexManifestV1
    expect(afterSecond.headSha).toBe("f".repeat(40))
  })

  it("does NOT pin a chain-broken push — uses the live tip and recovers via Compare", async () => {
    // Recall-safety guard #1: when before != manifest head (out-of-order /
    // backlogged push), pinning to its older `after` could regress the index,
    // so we DON'T pin. We resolve the live tip and let compare-recovery
    // compute a safe forward delta. getCommit is never called.
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)
    // before "b"… does not match the seeded manifest head "a"….
    const driftedPush = { ...pushJobPinned(), before: "b".repeat(40) } as Extract<JobMessage, { type: "index-repo" }>

    await handleIndexRepoJob({ job: driftedPush, env })

    expect(mockGetCommit).not.toHaveBeenCalled()
    expect(mockGetBranch).toHaveBeenCalled()
    // Live tip "c"… → compare(manifest "a"…, "c"…) recovers the delta.
    expect(mockCompareCommits).toHaveBeenCalledWith("Sigilix", "sigilix", "a".repeat(40), "c".repeat(40))
    const manifest = JSON.parse(kv.get(repoIndexManifestKey("Sigilix", "sigilix")) as string) as RepoIndexManifestV1
    expect(manifest.headSha).toBe("c".repeat(40))
  })

  it("an out-of-order OLDER push does NOT regress the manifest head", async () => {
    // Recall-safety guard #1, the regression scenario Codex flagged: the
    // manifest is already AHEAD (at "c"…). A late older push (before "a"… !=
    // "c"…) must NOT pin to its older after and full-index that older tree.
    // It uses the live tip "c"…; freshness then skips it (manifest already
    // at "c"…). The head never goes backwards.
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv, { headSha: "c".repeat(40) })
    const oldPush = { ...pushJobPinned(), before: "a".repeat(40), after: "b".repeat(40) } as Extract<
      JobMessage,
      { type: "index-repo" }
    >

    await handleIndexRepoJob({ job: oldPush, env })

    // Not pinned to the older "b"… (would regress); live tip used.
    expect(mockGetCommit).not.toHaveBeenCalled()
    // Manifest already fresh at the live tip → no re-embed, head unchanged.
    expect(mockGetFileContent).not.toHaveBeenCalled()
    const manifest = JSON.parse(kv.get(repoIndexManifestKey("Sigilix", "sigilix")) as string) as RepoIndexManifestV1
    expect(manifest.headSha).toBe("c".repeat(40))
  })

  it("on a getCommit 404, falls back to the live tip AND forces a safe Compare (guard #2)", async () => {
    // Recall-safety guard #2: a pinned push whose `after` 404s (commit GC'd)
    // falls back to the live tip. Because the resolved head (live "c"…) no
    // longer equals `after` ("e"…), the fast-path is NOT trusted — compare
    // recovers the full live delta so the after→tip commits aren't missed.
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)
    mockGetCommit.mockResolvedValue(null)

    await handleIndexRepoJob({ job: pushJobPinned(), env })

    expect(mockGetCommit).toHaveBeenCalledWith("Sigilix", "sigilix", "e".repeat(40))
    expect(mockGetBranch).toHaveBeenCalled()
    // Live tip "c"… → safe compare against the manifest head, NOT a blind
    // trust of the stale before→after changedPaths at the wrong head.
    expect(mockCompareCommits).toHaveBeenCalledWith("Sigilix", "sigilix", "a".repeat(40), "c".repeat(40))
  })

  it("a chain-intact push WITHOUT `after` keeps the legacy cheap fast-path (no getCommit, no Compare)", async () => {
    // Legacy in-flight push messages (pre-SIG-422) have before+changedPaths
    // but no `after`. They must keep the original behavior: live tip + cheap
    // changedPaths trust, no Compare, no getCommit.
    const { env, kv } = makeEnv()
    seedIndexedRepo(kv)

    await handleIndexRepoJob({ job: pushJobWithChangedPaths(), env })

    expect(mockGetCommit).not.toHaveBeenCalled()
    expect(mockCompareCommits).not.toHaveBeenCalled()
    expect(mockGetFileContent).toHaveBeenCalledWith("Sigilix", "sigilix", "src/changed.ts", "c".repeat(40))
  })
})
