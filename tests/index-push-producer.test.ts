// ARC-237 — tests for `maybeEnqueuePushIndexJob`.
//
// Covers every skip + enqueue branch:
//   - non-branch ref (e.g., refs/tags/v1.0.0)
//   - branch delete (after === "000…")
//   - sensitive-repo gate
//   - no prior index (manifest missing → bootstrap only via install)
//   - owner mismatch in manifest (cross-tenant same-name repo)
//   - missing GitHub credentials
//   - default-branch lookup failure
//   - untracked branch push
//   - tracked long-lived / active PR branch push
//   - PR lifecycle branch index/delete fanout
//   - happy path: enqueues with reason="push"
//   - OPENCLAW_JOBS.send throws → returns failed outcome

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
  mockGetInstallationToken,
  mockGetRepository,
  mockListOpenPullRequests,
} = vi.hoisted(() => ({
  mockGetInstallationToken: vi.fn(async () => "test-token"),
  mockGetRepository: vi.fn(),
  mockListOpenPullRequests: vi.fn(),
}))

vi.mock("../src/lib/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("../src/lib/github", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/github")>("../src/lib/github")
  class GitHubClientMock {
    async getRepository(owner: string, repo: string): Promise<unknown> {
      return mockGetRepository(owner, repo)
    }
    async listOpenPullRequests(owner: string, repo: string, options?: unknown): Promise<unknown> {
      return mockListOpenPullRequests(owner, repo, options)
    }
  }
  return { ...actual, GitHubClient: GitHubClientMock }
})

import {
  maybeEnqueuePullRequestBranchIndexJobs,
  maybeEnqueuePushIndexJob,
} from "../src/lib/index-producer"
import { repoIndexManifestKey, type RepoIndexManifestV1 } from "../src/lib/repo-index-manifest"
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "../src/lib/embeddings"
import type { Env } from "../src/shared/types/env"
import type { JobMessage } from "../src/shared/types/job"

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

function makeEnv(opts: {
  sensitive?: string
  credentials?: boolean
  trackedBranches?: string
  sendImpl?: (msg: JobMessage) => Promise<void> | void
} = {}): { env: Env; sent: JobMessage[]; kv: Map<string, string> } {
  const haveCreds = opts.credentials ?? true
  const { kv, store } = makeKvStub()
  const sent: JobMessage[] = []
  const env = {
    OPENCLAW_STATE: kv,
    OPENCLAW_JOBS: {
      send: opts.sendImpl ?? (async (m: JobMessage) => { sent.push(m) }),
    },
    OPENCLAW_SENSITIVE_REPOS: opts.sensitive,
    OPENCLAW_INDEXER_ENABLED: "on",
    OPENCLAW_INDEX_BRANCHES: opts.trackedBranches,
    GITHUB_APP_ID: haveCreds ? "12345" : undefined,
    GITHUB_PRIVATE_KEY: haveCreds ? "fake-key" : undefined,
  } as unknown as Env
  return { env, sent, kv: store }
}

const SAMPLE_MANIFEST: RepoIndexManifestV1 = {
  v: 1,
  repo: "sigilix",
  owner: "Arc-and-Anchor",
  headSha: "a".repeat(40),
  runId: "0123456789abcdef",
  fileCount: 10,
  chunkCount: 50,
  shardCount: 1,
  indexedAt: "2026-05-17T00:00:00.000Z",
  modelId: EMBEDDING_MODEL,
  embeddingDim: EMBEDDING_DIMENSIONS,
  chunkerVersion: 1,
  windowLines: 30,
  overlapLines: 10,
}

function seedManifest(kv: Map<string, string>, over: Partial<RepoIndexManifestV1> = {}): void {
  // SIG-132: the producer reads the manifest under the job's
  // `<owner>/<repo>` namespace (always "Arc-and-Anchor"/"sigilix" in
  // these tests). The cross-tenant test overrides the BODY's owner to
  // "different-org" while the record still lives under the read key, so
  // the producer's `manifest.owner !== owner` guard fires.
  kv.set(
    repoIndexManifestKey("Arc-and-Anchor", "sigilix"),
    JSON.stringify({ ...SAMPLE_MANIFEST, ...over }),
  )
}

beforeEach(() => {
  mockGetInstallationToken.mockClear()
  mockGetRepository.mockReset()
  mockListOpenPullRequests.mockReset()
  mockGetRepository.mockResolvedValue({ default_branch: "main" })
  mockListOpenPullRequests.mockResolvedValue([])
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

const baseArgs = {
  owner: "Arc-and-Anchor",
  repo: "sigilix",
  installationId: 99,
}

describe("maybeEnqueuePushIndexJob — skip branches (no enqueue, no GH calls when possible)", () => {
  it("skips non-branch refs (tag pushes)", async () => {
    const { env, sent } = makeEnv()
    const outcome = await maybeEnqueuePushIndexJob({
      env, ...baseArgs,
      ref: "refs/tags/v1.0.0",
      after: "b".repeat(40),
    })
    expect(outcome).toEqual({ skipped: "non-branch" })
    expect(sent).toHaveLength(0)
    expect(mockGetRepository).not.toHaveBeenCalled()
  })

  it("skips when ref is undefined", async () => {
    const { env, sent } = makeEnv()
    const outcome = await maybeEnqueuePushIndexJob({
      env, ...baseArgs,
      ref: undefined,
      after: "b".repeat(40),
    })
    expect(outcome).toEqual({ skipped: "non-branch" })
    expect(sent).toHaveLength(0)
  })

  it("skips default-branch delete (after === all-zero SHA)", async () => {
    const { env, sent, kv } = makeEnv()
    seedManifest(kv)
    const outcome = await maybeEnqueuePushIndexJob({
      env, ...baseArgs,
      ref: "refs/heads/main",
      after: "0000000000000000000000000000000000000000",
    })
    expect(outcome).toEqual({ skipped: "default-branch-delete" })
    expect(sent).toHaveLength(0)
  })

  it("enqueues branch-index deletion when a non-default branch is deleted", async () => {
    const { env, sent, kv } = makeEnv()
    seedManifest(kv)
    const outcome = await maybeEnqueuePushIndexJob({
      env, ...baseArgs,
      ref: "refs/heads/feature/remove-me",
      after: "0000000000000000000000000000000000000000",
    })
    expect(outcome).toEqual({ enqueued: true, reason: "branch-delete" })
    expect(sent).toEqual([{
      type: "delete-repo-index",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      branch: "feature/remove-me",
      reason: "branch-deleted",
    }])
  })

  it("skips sensitive repos before any GitHub I/O", async () => {
    const { env, sent } = makeEnv({ sensitive: "arc-and-anchor/sigilix" })
    const outcome = await maybeEnqueuePushIndexJob({
      env, ...baseArgs,
      ref: "refs/heads/main",
      after: "b".repeat(40),
    })
    expect(outcome).toEqual({ skipped: "sensitive" })
    expect(sent).toHaveLength(0)
    expect(mockGetRepository).not.toHaveBeenCalled()
  })

  it("skips when no prior index exists (bootstrap is install-only)", async () => {
    const { env, sent } = makeEnv()
    const outcome = await maybeEnqueuePushIndexJob({
      env, ...baseArgs,
      ref: "refs/heads/main",
      after: "b".repeat(40),
    })
    expect(outcome).toEqual({ skipped: "no-prior-index" })
    expect(sent).toHaveLength(0)
    expect(mockGetRepository).not.toHaveBeenCalled()
  })

  it("skips owner-mismatch (cross-tenant same-name repo)", async () => {
    const { env, sent, kv } = makeEnv()
    seedManifest(kv, { owner: "different-org" })
    const outcome = await maybeEnqueuePushIndexJob({
      env, ...baseArgs,
      ref: "refs/heads/main",
      after: "b".repeat(40),
    })
    expect(outcome).toEqual({ skipped: "owner-mismatch" })
    expect(sent).toHaveLength(0)
    expect(mockGetRepository).not.toHaveBeenCalled()
  })

  it("skips when GitHub credentials are missing", async () => {
    const { env, sent, kv } = makeEnv({ credentials: false })
    seedManifest(kv)
    const outcome = await maybeEnqueuePushIndexJob({
      env, ...baseArgs,
      ref: "refs/heads/main",
      after: "b".repeat(40),
    })
    expect(outcome).toEqual({ skipped: "missing-creds" })
    expect(sent).toHaveLength(0)
    expect(mockGetRepository).not.toHaveBeenCalled()
  })

  it("skips when getRepository returns null (default-branch lookup failure)", async () => {
    const { env, sent, kv } = makeEnv()
    seedManifest(kv)
    mockGetRepository.mockResolvedValue(null)
    const outcome = await maybeEnqueuePushIndexJob({
      env, ...baseArgs,
      ref: "refs/heads/main",
      after: "b".repeat(40),
    })
    expect(outcome).toEqual({ skipped: "missing-default-branch" })
    expect(sent).toHaveLength(0)
  })

  it("ENQUEUES on getRepository transient error — does NOT silently drop the push (CR Major #3)", async () => {
    // CR Major #3 on PR #77: GitHub does NOT auto-redeliver failed
    // webhooks (no automatic retry — manual redelivery via REST API
    // is the only path). Treating a transient `getRepository` error
    // as a skip would permanently lose the push. The default-branch
    // check here is purely an optimization (the ARC-235 consumer
    // always revalidates), so a lookup failure falls through to
    // enqueue + lets the consumer's freshness gate handle non-default
    // branches cheaply.
    const { env, sent, kv } = makeEnv()
    seedManifest(kv)
    mockGetRepository.mockRejectedValue(new Error("HTTP 502 Bad Gateway"))
    const outcome = await maybeEnqueuePushIndexJob({
      env, ...baseArgs,
      ref: "refs/heads/main",
      after: "b".repeat(40),
    })
    expect(outcome).toEqual({ enqueued: true, reason: "push" })
    expect(sent).toHaveLength(1)
  })

  it("skips when push is on an untracked non-default branch", async () => {
    const { env, sent, kv } = makeEnv()
    seedManifest(kv)
    mockGetRepository.mockResolvedValue({ default_branch: "main" })
    const outcome = await maybeEnqueuePushIndexJob({
      env, ...baseArgs,
      ref: "refs/heads/feature-branch",
      after: "b".repeat(40),
    })
    expect(outcome).toEqual({ skipped: "untracked-branch" })
    expect(sent).toHaveLength(0)
  })

  it("enqueues active-PR branch indexing when the PR lookup fails", async () => {
    const { env, sent, kv } = makeEnv()
    seedManifest(kv)
    mockGetRepository.mockResolvedValue({ default_branch: "main" })
    mockListOpenPullRequests.mockRejectedValue(new Error("GitHub 502"))
    const outcome = await maybeEnqueuePushIndexJob({
      env, ...baseArgs,
      ref: "refs/heads/feature-branch",
      after: "b".repeat(40),
    })
    expect(outcome).toEqual({ enqueued: true, reason: "push" })
    expect(sent).toEqual([{
      type: "index-repo",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      installationId: 99,
      reason: "push",
      branch: "feature-branch",
    }])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("index-push-open-pr-lookup-failed"))
  })
})

describe("maybeEnqueuePushIndexJob — happy path", () => {
  it("enqueues index-repo with reason='push' on default-branch push", async () => {
    const { env, sent, kv } = makeEnv()
    seedManifest(kv)
    mockGetRepository.mockResolvedValue({ default_branch: "main" })
    const outcome = await maybeEnqueuePushIndexJob({
      env, ...baseArgs,
      ref: "refs/heads/main",
      after: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    })
    expect(outcome).toEqual({ enqueued: true, reason: "push" })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({
      type: "index-repo",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      installationId: 99,
      reason: "push",
    })
  })

  it("attaches githubRepoId to the queue message when the push payload included repository.id (SIG-243 Phase 1)", async () => {
    // SIG-243: GitHub's immutable repository ID is captured at the
    // webhook entry point and threaded through to the queue message
    // so the consumer can persist it on the manifest. Phase 4
    // promotes the field to the canonical KV key.
    const { env, sent, kv } = makeEnv()
    seedManifest(kv)
    mockGetRepository.mockResolvedValue({ default_branch: "main" })
    const outcome = await maybeEnqueuePushIndexJob({
      env, ...baseArgs,
      repoId: 808247824,
      ref: "refs/heads/main",
      after: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    })
    expect(outcome).toEqual({ enqueued: true, reason: "push" })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({
      type: "index-repo",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      githubRepoId: 808247824,
      installationId: 99,
      reason: "push",
    })
  })

  it("omits githubRepoId from the queue message when the push payload had no repository.id (legacy / fallback)", async () => {
    // SIG-243: legacy webhook deliveries (replayed pre-Phase-1) and
    // non-push code paths that haven't been wired yet leave repoId
    // undefined. The producer must NOT land `githubRepoId: undefined`
    // on the queue message — that would fail the consumer's type
    // guard if it ever became strict-required in a later phase, and
    // it pollutes the message shape pointlessly.
    const { env, sent, kv } = makeEnv()
    seedManifest(kv)
    mockGetRepository.mockResolvedValue({ default_branch: "main" })
    const outcome = await maybeEnqueuePushIndexJob({
      env, ...baseArgs,
      repoId: undefined,
      ref: "refs/heads/main",
      after: "b".repeat(40),
    })
    expect(outcome).toEqual({ enqueued: true, reason: "push" })
    expect(sent).toHaveLength(1)
    expect(sent[0]).not.toHaveProperty("githubRepoId")
  })

  it("honors a non-`main` default branch", async () => {
    const { env, sent, kv } = makeEnv()
    seedManifest(kv)
    mockGetRepository.mockResolvedValue({ default_branch: "trunk" })
    const outcome = await maybeEnqueuePushIndexJob({
      env, ...baseArgs,
      ref: "refs/heads/trunk",
      after: "b".repeat(40),
    })
    expect(outcome).toEqual({ enqueued: true, reason: "push" })
    expect(sent).toHaveLength(1)
  })

  it("enqueues index-repo for a default tracked long-lived branch", async () => {
    const { env, sent, kv } = makeEnv()
    seedManifest(kv)
    const outcome = await maybeEnqueuePushIndexJob({
      env, ...baseArgs,
      ref: "refs/heads/dev",
      after: "b".repeat(40),
    })
    expect(outcome).toEqual({ enqueued: true, reason: "push" })
    expect(sent).toEqual([{
      type: "index-repo",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      installationId: 99,
      reason: "push",
      branch: "dev",
    }])
  })

  it("enqueues exactly once when a tracked branch also has an open PR", async () => {
    const { env, sent, kv } = makeEnv()
    seedManifest(kv)
    mockListOpenPullRequests.mockResolvedValue([
      { head: { ref: "dev", repo: { full_name: "Arc-and-Anchor/sigilix" } } },
    ])
    const outcome = await maybeEnqueuePushIndexJob({
      env, ...baseArgs,
      ref: "refs/heads/dev",
      after: "b".repeat(40),
    })
    expect(outcome).toEqual({ enqueued: true, reason: "push" })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: "index-repo", branch: "dev" })
    expect(mockListOpenPullRequests).not.toHaveBeenCalled()
  })

  it("honors configured long-lived branches", async () => {
    const { env, sent, kv } = makeEnv({ trackedBranches: "release,next" })
    seedManifest(kv)
    const outcome = await maybeEnqueuePushIndexJob({
      env, ...baseArgs,
      ref: "refs/heads/release",
      after: "b".repeat(40),
    })
    expect(outcome).toEqual({ enqueued: true, reason: "push" })
    expect(sent[0]).toMatchObject({ type: "index-repo", branch: "release" })
  })

  it("enqueues index-repo for an active same-repo PR branch", async () => {
    const { env, sent, kv } = makeEnv()
    seedManifest(kv)
    mockListOpenPullRequests.mockResolvedValue([
      { head: { ref: "feature-branch", repo: { full_name: "Arc-and-Anchor/sigilix" } } },
    ])
    const outcome = await maybeEnqueuePushIndexJob({
      env, ...baseArgs,
      ref: "refs/heads/feature-branch",
      after: "b".repeat(40),
    })
    expect(outcome).toEqual({ enqueued: true, reason: "push" })
    expect(sent[0]).toMatchObject({
      type: "index-repo",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      branch: "feature-branch",
      reason: "push",
    })
  })
})

describe("maybeEnqueuePullRequestBranchIndexJobs", () => {
  it("enqueues branch indexing for non-draft PR updates", async () => {
    const { env, sent } = makeEnv()
    await maybeEnqueuePullRequestBranchIndexJobs({
      env,
      ...baseArgs,
      action: "synchronize",
      draft: false,
      headRef: "feature-branch",
      baseRef: "main",
      merged: false,
    })
    expect(sent).toEqual([{
      type: "index-repo",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      installationId: 99,
      reason: "pull-request",
      branch: "feature-branch",
    }])
  })

  it("does not index draft PR branches", async () => {
    const { env, sent } = makeEnv()
    await maybeEnqueuePullRequestBranchIndexJobs({
      env,
      ...baseArgs,
      action: "opened",
      draft: true,
      headRef: "feature-branch",
      baseRef: "main",
      merged: false,
    })
    expect(sent).toHaveLength(0)
  })

  it("deletes the branch index and refreshes the base when a PR merges", async () => {
    const { env, sent } = makeEnv()
    await maybeEnqueuePullRequestBranchIndexJobs({
      env,
      ...baseArgs,
      action: "closed",
      draft: false,
      headRef: "feature-branch",
      baseRef: "main",
      merged: true,
    })
    expect(sent).toEqual([
      {
        type: "delete-repo-index",
        owner: "Arc-and-Anchor",
        repo: "sigilix",
        branch: "feature-branch",
        reason: "pr-branch-closed",
      },
      {
        type: "index-repo",
        owner: "Arc-and-Anchor",
        repo: "sigilix",
        installationId: 99,
        reason: "merged-pr",
        branch: "main",
      },
    ])
  })

  it("keeps long-lived branch indexes when a release PR closes", async () => {
    const { env, sent } = makeEnv()
    await maybeEnqueuePullRequestBranchIndexJobs({
      env,
      ...baseArgs,
      action: "closed",
      draft: false,
      headRef: "dev",
      baseRef: "main",
      merged: true,
    })
    expect(sent).toEqual([{
      type: "index-repo",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      installationId: 99,
      reason: "merged-pr",
      branch: "main",
    }])
  })

  it("continues to enqueue merged-base refresh and surfaces failure when branch-delete enqueue fails", async () => {
    const sent: JobMessage[] = []
    let call = 0
    const { env } = makeEnv({
      sendImpl: async (msg) => {
        call += 1
        if (call === 1) throw new Error("queue delete write failed")
        sent.push(msg)
      },
    })
    await expect(maybeEnqueuePullRequestBranchIndexJobs({
      env,
      ...baseArgs,
      action: "closed",
      draft: false,
      headRef: "feature-branch",
      baseRef: "main",
      merged: true,
    })).rejects.toThrow("pull-request branch enqueue failures")
    expect(sent).toEqual([{
      type: "index-repo",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      installationId: 99,
      reason: "merged-pr",
      branch: "main",
    }])
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("index-pr-branch-delete-enqueue-failed"))
  })
})

describe("maybeEnqueuePushIndexJob — enqueue failure", () => {
  it("returns failed outcome (caller turns into 503) when OPENCLAW_JOBS.send throws", async () => {
    const send = async (): Promise<void> => {
      throw new Error("queue binding down")
    }
    const { env, kv } = makeEnv({ sendImpl: send })
    seedManifest(kv)
    mockGetRepository.mockResolvedValue({ default_branch: "main" })
    const outcome = await maybeEnqueuePushIndexJob({
      env, ...baseArgs,
      ref: "refs/heads/main",
      after: "b".repeat(40),
    })
    expect("failed" in outcome ? outcome.failed : null).toBe("enqueue-throw")
  })
})
