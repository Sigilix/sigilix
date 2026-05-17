// ARC-236 (code-reviewer M1 catch on PR #80) — when
// `enqueueWarmupRerunsForIndex` fires a `pr-review-rerun` job
// post-indexing, the customer didn't type `/sigilix review` and the
// slash-command ack ("👀 reviewing...") would be unsolicited noise on
// every open PR. The handler honors `job.silent === true` by skipping
// `createIssueComment`. Slash-command-driven reruns omit `silent` and
// keep the existing ack behavior.

import { describe, it, expect, vi, beforeEach } from "vitest"

const {
  mockGetInstallationToken,
  mockCreateIssueComment,
  mockGetPullRequest,
} = vi.hoisted(() => ({
  mockGetInstallationToken: vi.fn(async () => "test-token"),
  mockCreateIssueComment: vi.fn(async () => undefined),
  mockGetPullRequest: vi.fn(async () => ({ head: { sha: "a".repeat(40) } })),
}))

vi.mock("../src/lib/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("../src/lib/github", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/github")>("../src/lib/github")
  class GitHubClientMock {
    async createIssueComment(...args: unknown[]): Promise<unknown> {
      return mockCreateIssueComment(...args)
    }
    async getPullRequest(...args: unknown[]): Promise<unknown> {
      return mockGetPullRequest(...args)
    }
  }
  return { ...actual, GitHubClient: GitHubClientMock }
})

import { dispatchJob } from "../src/index"
import type { Env, JobMessage } from "../src/index"

function makeEnv(): { env: Env; sent: JobMessage[]; kv: Map<string, string> } {
  const store = new Map<string, string>()
  const sent: JobMessage[] = []
  const env = {
    OPENCLAW_STATE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v) },
      delete: async (k: string) => { store.delete(k) },
    } as unknown as KVNamespace,
    OPENCLAW_JOBS: {
      send: async (m: JobMessage) => { sent.push(m) },
    } as unknown as Queue<unknown>,
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
  } as unknown as Env
  return { env, sent, kv: store }
}

beforeEach(() => {
  mockGetInstallationToken.mockClear()
  mockCreateIssueComment.mockClear()
  mockGetPullRequest.mockClear()
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

describe("dispatchJob — pr-review-rerun silent flag (ARC-236 M1)", () => {
  it("skips slash-command ack when silent=true (warmup-fired rerun)", async () => {
    const { env, sent } = makeEnv()
    const job: JobMessage = {
      type: "pr-review-rerun",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 237,
      installationId: 99,
      silent: true,
    }
    await dispatchJob(job, env)

    expect(mockCreateIssueComment).not.toHaveBeenCalled()
    // The rerun still enqueues the regular pr-review job — silence is
    // ack-only, the review itself must still happen.
    expect(sent).toHaveLength(1)
    expect(sent[0]?.type).toBe("pr-review")
  })

  it("posts slash-command ack when silent is unset (slash-command-driven rerun)", async () => {
    const { env, sent } = makeEnv()
    const job: JobMessage = {
      type: "pr-review-rerun",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 237,
      installationId: 99,
    }
    await dispatchJob(job, env)

    expect(mockCreateIssueComment).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.type).toBe("pr-review")
  })

  it("posts slash-command ack when silent=false (explicit opt-in to ack)", async () => {
    const { env, sent } = makeEnv()
    const job: JobMessage = {
      type: "pr-review-rerun",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 237,
      installationId: 99,
      silent: false,
    }
    await dispatchJob(job, env)

    expect(mockCreateIssueComment).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)
  })

  it("ack failure when silent=false does NOT block the underlying review enqueue", async () => {
    mockCreateIssueComment.mockRejectedValueOnce(new Error("HTTP 403 Forbidden"))
    const { env, sent } = makeEnv()
    const job: JobMessage = {
      type: "pr-review-rerun",
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 237,
      installationId: 99,
    }
    await dispatchJob(job, env)

    expect(mockCreateIssueComment).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.type).toBe("pr-review")
  })
})
