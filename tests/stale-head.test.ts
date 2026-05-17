// ARC-250: tests for the `handleStaleHead` helper.
//
// The helper is called from three stale-head guards (Phase 3, ensemble
// before-fanout, ensemble after-review). On every call it emits a
// structured `pr-review-stale-head` log line and upserts a sticky
// comment on the PR. Upsert means: list existing comments, find one
// whose body contains `STALE_HEAD_MARKER`, PATCH it if present, POST a
// new one otherwise.
//
// ARC-251 (follow-up commit) extends this to auto-requeue against the
// live SHA when retry budget remains. That behaviour is NOT tested
// here — those tests live in the requeue commit.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// vi.hoisted ensures these mock fns exist BEFORE the hoisted vi.mock
// factories evaluate. Without this, the GitHubClient mock factory below
// can reference the consts in their temporal-dead-zone window — the
// returned object's methods become undefined instead of mock-wrapped.
const {
  mockGetInstallationToken,
  mockListIssueComments,
  mockCreateIssueComment,
  mockUpdateIssueComment,
  mockEnqueuePrReviewJob,
} = vi.hoisted(() => ({
  mockGetInstallationToken: vi.fn(async () => "test-token"),
  mockListIssueComments: vi.fn(),
  mockCreateIssueComment: vi.fn(),
  mockUpdateIssueComment: vi.fn(),
  mockEnqueuePrReviewJob: vi.fn(),
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
  }
  return {
    ...actual,
    GitHubClient: GitHubClientMock,
  }
})

vi.mock("../src/do/webhook-enqueue", () => ({
  enqueuePrReviewJob: (...args: unknown[]) => mockEnqueuePrReviewJob(...args),
}))

import {
  handleStaleHead,
  renderStaleHeadComment,
  STALE_HEAD_MARKER,
  MAX_STALE_HEAD_REQUEUES,
} from "../src/lib/stale-head"
import type { Env } from "../src/index"

function makeEnv(opts: { credentials?: boolean } = {}): Env {
  const haveCreds = opts.credentials ?? true
  return {
    OPENCLAW_STATE: { get: async () => null, put: async () => {}, delete: async () => {} } as unknown as Env["OPENCLAW_STATE"],
    GITHUB_APP_ID: haveCreds ? "12345" : undefined,
    GITHUB_PRIVATE_KEY: haveCreds ? "fake-key" : undefined,
  } as unknown as Env
}

const baseArgs = {
  owner: "Arc-and-Anchor",
  repo: "sigilix",
  prNumber: 237,
  installationId: 42,
  queuedHeadSha: "aaaaaaa1111111111111111111111111111aaaa",
  currentHeadSha: "bbbbbbb2222222222222222222222222222bbbb",
  baseSha: "ccccccc0000000000000000000000000000cccc",
} as const

beforeEach(() => {
  mockGetInstallationToken.mockClear()
  mockListIssueComments.mockReset()
  mockCreateIssueComment.mockReset()
  mockUpdateIssueComment.mockReset()
  mockEnqueuePrReviewJob.mockReset()
})

describe("renderStaleHeadComment", () => {
  it("includes the marker and a 7-char short SHA for each side", () => {
    const body = renderStaleHeadComment({
      queuedHeadSha: "aaaaaaa1111111111111111111111111111aaaa",
      currentHeadSha: "bbbbbbb2222222222222222222222222222bbbb",
    })
    expect(body).toContain(STALE_HEAD_MARKER)
    expect(body).toContain("`aaaaaaa`")
    expect(body).toContain("`bbbbbbb`")
    expect(body).toContain("/sigilix review")
  })
})

describe("handleStaleHead — sticky comment (exhausted retry budget)", () => {
  // These tests use depth = MAX_STALE_HEAD_REQUEUES so the requeue path
  // is skipped and the helper falls through to the upsert sticky. The
  // requeue path itself is exercised below.
  const exhaustedDepth = MAX_STALE_HEAD_REQUEUES

  it("creates a new sticky comment when no existing marker is found", async () => {
    mockListIssueComments.mockResolvedValue([
      { id: 1, body: "an unrelated comment" },
      { id: 2, body: "another one" },
    ])
    mockCreateIssueComment.mockResolvedValue({ id: 99 })

    const result = await handleStaleHead({
      env: makeEnv(),
      ...baseArgs,
      depth: exhaustedDepth,
      source: "phase3",
    })

    expect(result).toEqual({ posted: "created", commentId: 99 })
    expect(mockListIssueComments).toHaveBeenCalledTimes(1)
    expect(mockCreateIssueComment).toHaveBeenCalledTimes(1)
    expect(mockUpdateIssueComment).not.toHaveBeenCalled()
    expect(mockEnqueuePrReviewJob).not.toHaveBeenCalled()
    const [owner, repo, prNumber, body] = mockCreateIssueComment.mock.calls[0]!
    expect(owner).toBe("Arc-and-Anchor")
    expect(repo).toBe("sigilix")
    expect(prNumber).toBe(237)
    expect(body).toContain(STALE_HEAD_MARKER)
  })

  it("updates an existing sticky comment when the marker is found", async () => {
    mockListIssueComments.mockResolvedValue([
      { id: 1, body: "an unrelated comment" },
      { id: 77, body: `something\n${STALE_HEAD_MARKER}\nstale-head body` },
      { id: 3, body: "trailing comment" },
    ])
    mockUpdateIssueComment.mockResolvedValue(undefined)

    const result = await handleStaleHead({
      env: makeEnv(),
      ...baseArgs,
      depth: exhaustedDepth,
      source: "ensemble-before-fanout",
    })

    expect(result).toEqual({ posted: "updated", commentId: 77 })
    expect(mockUpdateIssueComment).toHaveBeenCalledTimes(1)
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
    expect(mockEnqueuePrReviewJob).not.toHaveBeenCalled()
    const [, , commentId, body] = mockUpdateIssueComment.mock.calls[0]!
    expect(commentId).toBe(77)
    expect(body).toContain(STALE_HEAD_MARKER)
  })

  it("returns failed without throwing when GitHub credentials are missing", async () => {
    const result = await handleStaleHead({
      env: makeEnv({ credentials: false }),
      ...baseArgs,
      depth: exhaustedDepth,
      source: "ensemble-after-review",
    })

    expect(result).toEqual({ posted: "failed", reason: "missing_github_app_credentials" })
    expect(mockListIssueComments).not.toHaveBeenCalled()
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
  })

  it("returns failed without throwing when GitHub API rejects the comment", async () => {
    mockListIssueComments.mockResolvedValue([])
    mockCreateIssueComment.mockRejectedValue(new Error("HTTP 403 Forbidden"))

    const result = await handleStaleHead({
      env: makeEnv(),
      ...baseArgs,
      depth: exhaustedDepth,
      source: "phase3",
    })

    expect(result.posted).toBe("failed")
    if (result.posted === "failed") {
      expect(result.reason).toContain("403")
    }
  })

  it("emits a structured pr-review-stale-head log on every call", async () => {
    mockListIssueComments.mockResolvedValue([])
    mockCreateIssueComment.mockResolvedValue({ id: 1 })
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      await handleStaleHead({
        env: makeEnv(),
        ...baseArgs,
        depth: exhaustedDepth,
        source: "ensemble-after-review",
      })
      const events = spy.mock.calls
        .map((c) => c[0])
        .filter((s): s is string => typeof s === "string")
        .map((s) => {
          try { return JSON.parse(s) as Record<string, unknown> }
          catch { return null }
        })
        .filter((o): o is Record<string, unknown> => o !== null && o.event === "pr-review-stale-head")
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        event: "pr-review-stale-head",
        guard_source: "ensemble-after-review",
        owner: "Arc-and-Anchor",
        repo: "sigilix",
        pr_number: 237,
        installation_id: 42,
        depth: exhaustedDepth,
        queued_head_sha: baseArgs.queuedHeadSha,
        current_head_sha: baseArgs.currentHeadSha,
      })
    } finally {
      spy.mockRestore()
    }
  })
})

describe("handleStaleHead — ARC-251 auto-requeue (depth < MAX_STALE_HEAD_REQUEUES)", () => {
  it("re-enqueues against the current SHA with depth+1 when depth=0 (first attempt)", async () => {
    mockEnqueuePrReviewJob.mockResolvedValue({ ok: true, mode: "off" })

    const result = await handleStaleHead({
      env: makeEnv(),
      ...baseArgs,
      depth: 0,
      source: "phase3",
    })

    expect(result).toEqual({ requeued: true, newHeadSha: baseArgs.currentHeadSha, nextDepth: 1 })
    expect(mockEnqueuePrReviewJob).toHaveBeenCalledTimes(1)
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
    expect(mockUpdateIssueComment).not.toHaveBeenCalled()

    const [, enqArgs] = mockEnqueuePrReviewJob.mock.calls[0]!
    expect(enqArgs).toMatchObject({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 237,
      headSha: baseArgs.currentHeadSha,
      baseSha: baseArgs.baseSha,
      installationId: 42,
      deliveryId: null,
      staleHeadRequeueDepth: 1,
    })
  })

  it("re-enqueues with depth+1 at every intermediate depth below the cap", async () => {
    mockEnqueuePrReviewJob.mockResolvedValue({ ok: true, mode: "post" })

    // depth = MAX-1 → still requeue (transitions to MAX, no further
    // requeue from THAT next attempt; this attempt still re-enqueues).
    const result = await handleStaleHead({
      env: makeEnv(),
      ...baseArgs,
      depth: MAX_STALE_HEAD_REQUEUES - 1,
      source: "ensemble-before-fanout",
    })

    expect(result).toEqual({
      requeued: true,
      newHeadSha: baseArgs.currentHeadSha,
      nextDepth: MAX_STALE_HEAD_REQUEUES,
    })
    expect(mockEnqueuePrReviewJob).toHaveBeenCalledTimes(1)
    const [, enqArgs] = mockEnqueuePrReviewJob.mock.calls[0]!
    expect(enqArgs.staleHeadRequeueDepth).toBe(MAX_STALE_HEAD_REQUEUES)
  })

  it("does NOT requeue at depth = MAX_STALE_HEAD_REQUEUES (falls through to sticky)", async () => {
    mockListIssueComments.mockResolvedValue([])
    mockCreateIssueComment.mockResolvedValue({ id: 1 })

    const result = await handleStaleHead({
      env: makeEnv(),
      ...baseArgs,
      depth: MAX_STALE_HEAD_REQUEUES,
      source: "phase3",
    })

    expect(result.posted).toBe("created")
    expect(mockEnqueuePrReviewJob).not.toHaveBeenCalled()
    expect(mockCreateIssueComment).toHaveBeenCalledTimes(1)
  })

  it("falls through to sticky when enqueuePrReviewJob returns non-ok (CR phase-end catch)", async () => {
    // CodeRabbit phase-end MAJOR: a transient requeue failure must NOT
    // become a silent ack. The dispatcher short-circuits Phase 3 on
    // stale_head, so an early `requeueFailed` return would reintroduce
    // the exact silent-drop bug ARC-250 was meant to fix. The helper
    // now falls through to the sticky-comment upsert path.
    mockEnqueuePrReviewJob.mockResolvedValue({
      ok: false,
      mode: "post",
      reason: "do-transport",
    })
    mockListIssueComments.mockResolvedValue([])
    mockCreateIssueComment.mockResolvedValue({ id: 555 })

    const result = await handleStaleHead({
      env: makeEnv(),
      ...baseArgs,
      depth: 0,
      source: "phase3",
    })

    expect(result).toEqual({ posted: "created", commentId: 555 })
    expect(mockCreateIssueComment).toHaveBeenCalledTimes(1)
  })

  it("falls through to sticky when enqueuePrReviewJob throws (CR phase-end catch)", async () => {
    mockEnqueuePrReviewJob.mockRejectedValue(new Error("kv lookup failed"))
    mockListIssueComments.mockResolvedValue([])
    mockCreateIssueComment.mockResolvedValue({ id: 556 })

    const result = await handleStaleHead({
      env: makeEnv(),
      ...baseArgs,
      depth: 0,
      source: "phase3",
    })

    expect(result).toEqual({ posted: "created", commentId: 556 })
    expect(mockCreateIssueComment).toHaveBeenCalledTimes(1)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
