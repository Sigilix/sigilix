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
//   - non-default-branch push
//   - happy path: enqueues with reason="push"
//   - OPENCLAW_JOBS.send throws → returns failed outcome

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
  mockGetInstallationToken,
  mockGetRepository,
} = vi.hoisted(() => ({
  mockGetInstallationToken: vi.fn(async () => "test-token"),
  mockGetRepository: vi.fn(),
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
  }
  return { ...actual, GitHubClient: GitHubClientMock }
})

import { maybeEnqueuePushIndexJob } from "../src/lib/index-producer"
import { repoIndexManifestKey, type RepoIndexManifestV1 } from "../src/lib/repo-index-manifest"
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "../src/lib/embeddings"
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

function makeEnv(opts: {
  sensitive?: string
  credentials?: boolean
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
  mockGetRepository.mockResolvedValue({ default_branch: "main" })
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

  it("skips branch delete (after === all-zero SHA)", async () => {
    const { env, sent } = makeEnv()
    const outcome = await maybeEnqueuePushIndexJob({
      env, ...baseArgs,
      ref: "refs/heads/main",
      after: "0000000000000000000000000000000000000000",
    })
    expect(outcome).toEqual({ skipped: "branch-delete" })
    expect(sent).toHaveLength(0)
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

  it("skips when push is on a non-default branch", async () => {
    const { env, sent, kv } = makeEnv()
    seedManifest(kv)
    mockGetRepository.mockResolvedValue({ default_branch: "main" })
    const outcome = await maybeEnqueuePushIndexJob({
      env, ...baseArgs,
      ref: "refs/heads/feature-branch",
      after: "b".repeat(40),
    })
    expect(outcome).toEqual({ skipped: "non-default-branch" })
    expect(sent).toHaveLength(0)
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
