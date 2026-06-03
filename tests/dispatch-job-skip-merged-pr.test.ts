// Skip an automatic (re-)review of a PR that's already merged/closed. Under
// model-backend contention a pr-review job can be redelivered and re-run
// minutes AFTER the PR merged, posting a useless after-the-fact review and
// re-burning the model budget per redelivery. The guard fetches PR meta in
// dispatchJob and short-circuits — but FAILS OPEN so a live review is never
// wrongly skipped (recall over thrift).

import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockGetInstallationToken, mockGetPullRequest, mockEnsemble } = vi.hoisted(() => ({
  mockGetInstallationToken: vi.fn(async () => "test-token"),
  mockGetPullRequest: vi.fn(async () => ({
    head: { sha: "a".repeat(40) },
    base: { sha: "b".repeat(40) },
    state: "open",
    merged_at: null,
  })),
  mockEnsemble: vi.fn(async () => undefined),
}))

vi.mock("../src/lib/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("../src/lib/github", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/github")>("../src/lib/github")
  class GitHubClientMock {
    async getPullRequest(...args: unknown[]): Promise<unknown> {
      return mockGetPullRequest(...args)
    }
  }
  return { ...actual, GitHubClient: GitHubClientMock }
})

vi.mock("../src/lib/triage-pr-review-ensemble", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/triage-pr-review-ensemble")>(
      "../src/lib/triage-pr-review-ensemble",
    )
  return { ...actual, handlePrReviewEnsemble: (...args: unknown[]) => mockEnsemble(...args) }
})

import { dispatchJob, prMetaIsClosedOrMerged } from "../src/index"
import type { Env, JobMessage } from "../src/index"

function makeEnv(): Env {
  const store = new Map<string, string>()
  return {
    OPENCLAW_STATE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        store.set(k, v)
      },
      delete: async (k: string) => {
        store.delete(k)
      },
    } as unknown as KVNamespace,
    OPENCLAW_JOBS: { send: async () => undefined } as unknown as Queue<unknown>,
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
  } as unknown as Env
}

function prReviewJob(): JobMessage {
  return {
    type: "pr-review",
    owner: "Sigilix",
    repo: "sigilix",
    prNumber: 7,
    headSha: "c".repeat(40),
    installationId: 99,
  } as unknown as JobMessage
}

beforeEach(() => {
  mockGetInstallationToken.mockClear()
  mockGetPullRequest.mockClear()
  mockEnsemble.mockClear()
  mockGetPullRequest.mockResolvedValue({
    head: { sha: "a".repeat(40) },
    base: { sha: "b".repeat(40) },
    state: "open",
    merged_at: null,
  })
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

describe("prMetaIsClosedOrMerged (pure decision)", () => {
  it("merged (merged_at set) -> true", () => {
    expect(prMetaIsClosedOrMerged({ merged_at: "2026-06-03T00:00:00Z", state: "closed" })).toBe(true)
  })
  it("closed-unmerged -> true", () => {
    expect(prMetaIsClosedOrMerged({ merged_at: null, state: "closed" })).toBe(true)
  })
  it("open -> false", () => {
    expect(prMetaIsClosedOrMerged({ merged_at: null, state: "open" })).toBe(false)
  })
  it("empty / partial mock -> false (treats unknown as open, fail-open)", () => {
    expect(prMetaIsClosedOrMerged({})).toBe(false)
  })
})

describe("dispatchJob pr-review — skip when the PR is no longer open", () => {
  it("SKIPS the ensemble when the PR is merged", async () => {
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: "a".repeat(40) },
      base: { sha: "b".repeat(40) },
      state: "closed",
      merged_at: "2026-06-03T00:00:00Z",
    })
    await dispatchJob(prReviewJob(), makeEnv())
    expect(mockGetPullRequest).toHaveBeenCalledTimes(1)
    expect(mockEnsemble).not.toHaveBeenCalled()
  })

  it("SKIPS the ensemble when the PR is closed-unmerged", async () => {
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: "a".repeat(40) },
      base: { sha: "b".repeat(40) },
      state: "closed",
      merged_at: null,
    })
    await dispatchJob(prReviewJob(), makeEnv())
    expect(mockEnsemble).not.toHaveBeenCalled()
  })

  it("PROCEEDS to the ensemble when the PR is open", async () => {
    // Tolerate any downstream metrics-flush throw in the test env — the guard
    // decision (proceed) already happened once the ensemble was invoked.
    await dispatchJob(prReviewJob(), makeEnv()).catch(() => undefined)
    expect(mockEnsemble).toHaveBeenCalledTimes(1)
  })

  it("FAILS OPEN (reviews) when GitHub App creds are missing — never wrongly skips", async () => {
    const env = makeEnv()
    ;(env as { GITHUB_APP_ID?: string }).GITHUB_APP_ID = undefined
    await dispatchJob(prReviewJob(), env).catch(() => undefined)
    expect(mockGetPullRequest).not.toHaveBeenCalled() // short-circuits before any fetch
    expect(mockEnsemble).toHaveBeenCalledTimes(1)
  })

  it("FAILS OPEN (reviews) when the PR-meta fetch throws — never wrongly skips", async () => {
    mockGetPullRequest.mockRejectedValueOnce(new Error("HTTP 502 Bad Gateway"))
    await dispatchJob(prReviewJob(), makeEnv()).catch(() => undefined)
    expect(mockEnsemble).toHaveBeenCalledTimes(1)
  })
})
