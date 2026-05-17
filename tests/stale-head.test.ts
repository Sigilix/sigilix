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
const { mockGetInstallationToken, mockListIssueComments, mockCreateIssueComment, mockUpdateIssueComment } = vi.hoisted(() => ({
  mockGetInstallationToken: vi.fn(async () => "test-token"),
  mockListIssueComments: vi.fn(),
  mockCreateIssueComment: vi.fn(),
  mockUpdateIssueComment: vi.fn(),
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

import {
  handleStaleHead,
  renderStaleHeadComment,
  STALE_HEAD_MARKER,
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
} as const

beforeEach(() => {
  mockGetInstallationToken.mockClear()
  mockListIssueComments.mockReset()
  mockCreateIssueComment.mockReset()
  mockUpdateIssueComment.mockReset()
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

describe("handleStaleHead", () => {
  it("creates a new sticky comment when no existing marker is found", async () => {
    mockListIssueComments.mockResolvedValue([
      { id: 1, body: "an unrelated comment" },
      { id: 2, body: "another one" },
    ])
    mockCreateIssueComment.mockResolvedValue({ id: 99 })

    const result = await handleStaleHead({
      env: makeEnv(),
      ...baseArgs,
      source: "phase3",
    })

    expect(result).toEqual({ posted: "created", commentId: 99 })
    expect(mockListIssueComments).toHaveBeenCalledTimes(1)
    expect(mockCreateIssueComment).toHaveBeenCalledTimes(1)
    expect(mockUpdateIssueComment).not.toHaveBeenCalled()
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
      source: "ensemble-before-fanout",
    })

    expect(result).toEqual({ posted: "updated", commentId: 77 })
    expect(mockUpdateIssueComment).toHaveBeenCalledTimes(1)
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
    const [, , commentId, body] = mockUpdateIssueComment.mock.calls[0]!
    expect(commentId).toBe(77)
    expect(body).toContain(STALE_HEAD_MARKER)
  })

  it("returns failed without throwing when GitHub credentials are missing", async () => {
    const result = await handleStaleHead({
      env: makeEnv({ credentials: false }),
      ...baseArgs,
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
        queued_head_sha: baseArgs.queuedHeadSha,
        current_head_sha: baseArgs.currentHeadSha,
      })
    } finally {
      spy.mockRestore()
    }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
