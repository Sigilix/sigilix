// Stale-head guard for handlePrReview: when synchronize-driven
// re-reviews queue jobs faster than Ollama processes them, a slow job
// for SHA A can finish AFTER SHA B's job has posted. The guard at
// triage-pr-review.ts:150 skips the job when the PR head has moved.
//
// This file is dedicated to the guard so module-level vi.mock calls
// don't pollute the pure-helper tests in triage-pr-review.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest"

const mockGetInstallationToken = vi.fn(async () => "test-token")
const mockGetPullRequest = vi.fn()
const mockGetPullRequestDiff = vi.fn(async () => "fake diff")
const mockSubmitReview = vi.fn()
const mockGenerate = vi.fn()
// ARC-182: stack-detection adds a parallel `listOpenPullRequests` call.
// Default to empty list (no-stack review) so the existing stale-head
// guard tests are unaffected.
const mockListOpenPullRequests = vi.fn(async () => [])
const mockListPullRequestFiles = vi.fn(async () => [])
// ARC-250: the stale-head guard now hands off to `handleStaleHead`,
// which lists/creates/updates issue comments to upsert a sticky.
const mockListIssueComments = vi.fn(async () => [] as { id: number; body: string }[])
const mockCreateIssueComment = vi.fn(async () => ({ id: 12345 }))
const mockUpdateIssueComment = vi.fn(async () => undefined)
// ARC-251: the guard now auto-requeues against the live SHA when retry
// budget remains, via `enqueuePrReviewJob`. Mocked here so the test
// doesn't depend on the (un-mocked) DO / queue bindings on the env.
const mockEnqueuePrReviewJob = vi.fn(async () => ({ ok: true, mode: "off" as const }))

vi.mock("../src/lib/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("../src/do/webhook-enqueue", () => ({
  enqueuePrReviewJob: (...args: unknown[]) => mockEnqueuePrReviewJob(...args),
}))

vi.mock("../src/lib/github", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/github")>("../src/lib/github")
  return {
    ...actual,
    GitHubClient: vi.fn().mockImplementation(() => ({
      getPullRequest: (...args: unknown[]) => mockGetPullRequest(...args),
      getPullRequestDiff: (...args: unknown[]) => mockGetPullRequestDiff(...args),
      submitReview: (...args: unknown[]) => mockSubmitReview(...args),
      listOpenPullRequests: (...args: unknown[]) => mockListOpenPullRequests(...args),
      listPullRequestFiles: (...args: unknown[]) => mockListPullRequestFiles(...args),
      listIssueComments: (...args: unknown[]) => mockListIssueComments(...args),
      createIssueComment: (...args: unknown[]) => mockCreateIssueComment(...args),
      updateIssueComment: (...args: unknown[]) => mockUpdateIssueComment(...args),
    })),
  }
})

vi.mock("../src/lib/ollama", () => ({
  generate: (args: unknown) => mockGenerate(args),
}))

import { handlePrReview } from "../src/lib/triage-pr-review"
import type { Env } from "../src/index"

function makeKvStub(): { kv: Env["OPENCLAW_STATE"]; store: Map<string, string>; deletes: string[] } {
  const store = new Map<string, string>()
  const deletes: string[] = []
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value)
    },
    async delete(key: string): Promise<void> {
      deletes.push(key)
      store.delete(key)
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store, deletes }
}

function makeEnv(kv: Env["OPENCLAW_STATE"]): Env {
  return {
    OPENCLAW_STATE: kv,
    OLLAMA_API_KEY: "fake-ollama",
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
  } as unknown as Env
}

beforeEach(() => {
  // mockClear (not mockReset) — preserves the implementation set by the
  // module-level vi.mock factory. mockReset would wipe it and the next
  // test's `mockResolvedValue(...)` call would still leave the function
  // behaving as if the underlying constructor returns undefined.
  mockGetInstallationToken.mockClear()
  mockGetPullRequest.mockClear()
  mockGetPullRequestDiff.mockClear()
  mockSubmitReview.mockClear()
  mockGenerate.mockClear()
  mockListIssueComments.mockClear()
  mockCreateIssueComment.mockClear()
  mockUpdateIssueComment.mockClear()
  mockEnqueuePrReviewJob.mockClear()
})

describe("handlePrReview stale-head guard", () => {
  it("auto-requeues against the live SHA when retry budget remains (depth 0 → 1)", async () => {
    const queuedSha = "aaaaaaa1111111111111111111111111111aaaa"
    const currentSha = "bbbbbbb2222222222222222222222222222bbbb"
    mockGetPullRequest.mockResolvedValue({
      title: "test",
      body: null,
      head: { sha: currentSha, ref: "feature" },
      base: { sha: "ccccccc0000000000000000000000000000cccc" },
    })
    const { kv, store, deletes } = makeKvStub()

    const result = await handlePrReview({
      owner: "Arc-and-Anchor",
      repo: "openclaw-worker",
      prNumber: 99,
      headSha: queuedSha,
      installationId: 1,
      env: makeEnv(kv),
    })

    // ARC-250: the guard returns a status so the dispatcher can
    // short-circuit the Phase 3 fallback instead of running it twice.
    expect(result).toEqual({ status: "stale_head" })
    expect(mockGenerate).not.toHaveBeenCalled()
    expect(mockSubmitReview).not.toHaveBeenCalled()
    // ARC-251: at depth 0 the helper auto-requeues against the live
    // SHA rather than posting the sticky. The sticky-comment path is
    // exercised at MAX_STALE_HEAD_REQUEUES in `tests/stale-head.test.ts`.
    expect(mockEnqueuePrReviewJob).toHaveBeenCalledTimes(1)
    const [, enqArgs] = mockEnqueuePrReviewJob.mock.calls[0]!
    expect(enqArgs).toMatchObject({
      owner: "Arc-and-Anchor",
      repo: "openclaw-worker",
      prNumber: 99,
      headSha: currentSha,
      staleHeadRequeueDepth: 1,
    })
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
    // The finally block releases the dedupe key when posted=false. The
    // re-enqueued job has a different (currentSha) dedupe key and so
    // is unaffected. Confirm the old-SHA key release happened.
    const dedupeKey = `pr-review:Arc-and-Anchor/openclaw-worker#99@${queuedSha}`
    expect(deletes).toContain(dedupeKey)
    expect(store.has(dedupeKey)).toBe(false)
  })

  it("proceeds past the guard when the PR head matches the queued SHA", async () => {
    const queuedSha = "ccccccc3333333333333333333333333333cccc"
    mockGetPullRequest.mockResolvedValue({
      title: "test",
      body: null,
      head: { sha: queuedSha, ref: "feature" },
    })
    // Force a parse failure AFTER the guard so we don't have to mock
    // the entire submit chain — we only need to prove generate() WAS
    // called (i.e. control flow passed the guard).
    mockGenerate.mockResolvedValue("not-valid-json")
    const { kv } = makeKvStub()

    await expect(
      handlePrReview({
        owner: "Arc-and-Anchor",
        repo: "openclaw-worker",
        prNumber: 99,
        headSha: queuedSha,
        installationId: 1,
        env: makeEnv(kv),
      }),
    ).rejects.toThrow(/verdict did not parse/)

    expect(mockGenerate).toHaveBeenCalledTimes(1)
    expect(mockSubmitReview).not.toHaveBeenCalled()
  })

  it("proceeds past the guard when meta.head is missing (defensive)", async () => {
    const queuedSha = "ddddddd4444444444444444444444444444dddd"
    mockGetPullRequest.mockResolvedValue({
      title: "test",
      body: null,
      head: undefined,
    })
    mockGenerate.mockResolvedValue("not-valid-json")
    const { kv } = makeKvStub()

    await expect(
      handlePrReview({
        owner: "Arc-and-Anchor",
        repo: "openclaw-worker",
        prNumber: 99,
        headSha: queuedSha,
        installationId: 1,
        env: makeEnv(kv),
      }),
    ).rejects.toThrow(/verdict did not parse/)

    // No meta.head.sha to compare → guard does NOT fire → generate runs.
    expect(mockGenerate).toHaveBeenCalledTimes(1)
  })
})
