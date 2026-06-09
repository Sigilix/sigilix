// Skip an automatic (re-)review of a PR that's already merged/closed. Under
// model-backend contention a pr-review job can be redelivered and re-run
// minutes AFTER the PR merged, posting a useless after-the-fact review and
// re-burning the model budget per redelivery. The guard fetches PR meta in
// dispatchJob and short-circuits — but FAILS OPEN so a live review is never
// wrongly skipped (recall over thrift).

import { describe, it, expect, vi, beforeEach } from "vitest"

const {
  mockGetInstallationToken,
  mockGetPullRequest,
  mockEnsemble,
  mockAttachCheckRun,
  mockCompleteCheckRun,
} = vi.hoisted(() => ({
  mockGetInstallationToken: vi.fn(async () => "test-token"),
  mockGetPullRequest: vi.fn(async () => ({
    head: { sha: "a".repeat(40) },
    base: { sha: "b".repeat(40) },
    state: "open",
    merged_at: null,
  })),
  mockEnsemble: vi.fn(async () => undefined),
  mockAttachCheckRun: vi.fn(async () => ({ checkRunId: 1 })),
  mockCompleteCheckRun: vi.fn(async () => undefined),
}))

vi.mock("../src/shared/adapters/github/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("../src/shared/adapters/github", async () => {
  const actual = await vi.importActual<typeof import("../src/shared/adapters/github")>("../src/shared/adapters/github")
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

vi.mock("../src/lib/pr-review-check-run", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/pr-review-check-run")>(
      "../src/lib/pr-review-check-run",
    )
  return {
    ...actual,
    attachExistingCheckRun: (args: unknown) => mockAttachCheckRun(args),
    completeCheckRun: (args: unknown) => mockCompleteCheckRun(args),
  }
})

import { dispatchJob, prMetaIsClosedOrMerged } from "../src/index"
import type { Env } from "../src/shared/types/env"
import type { JobMessage } from "../src/shared/types/job"

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

function prReviewJob(extra: Record<string, unknown> = {}): JobMessage {
  return {
    type: "pr-review",
    owner: "Sigilix",
    repo: "sigilix",
    prNumber: 7,
    headSha: "c".repeat(40),
    installationId: 99,
    ...extra,
  } as unknown as JobMessage
}

const MERGED_PR = {
  head: { sha: "a".repeat(40) },
  base: { sha: "b".repeat(40) },
  state: "closed",
  merged_at: "2026-06-03T00:00:00Z",
}

beforeEach(() => {
  mockGetInstallationToken.mockClear()
  // mockReset (not mockClear) so any queued mockResolvedValueOnce from a prior
  // test that short-circuited before the fetch can't bleed into the next test.
  mockGetPullRequest.mockReset()
  mockEnsemble.mockClear()
  mockAttachCheckRun.mockClear()
  mockCompleteCheckRun.mockClear()
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
  it("SKIPS the ensemble when the PR is merged (no check run to clean up)", async () => {
    mockGetPullRequest.mockResolvedValueOnce(MERGED_PR)
    await dispatchJob(prReviewJob(), makeEnv())
    expect(mockGetPullRequest).toHaveBeenCalledTimes(1)
    expect(mockEnsemble).not.toHaveBeenCalled()
    expect(mockCompleteCheckRun).not.toHaveBeenCalled()
  })

  it("RUNS an explicit rerun (bypassClosedSkip) even on a merged PR — and never fetches", async () => {
    // A slash-command rerun re-enqueues a pr-review message with this flag;
    // the user asked for it, so it must run even post-merge (CodeRabbit #319).
    // No PR-meta mock needed — the flag short-circuits before any fetch.
    await dispatchJob(prReviewJob({ bypassClosedSkip: true }), makeEnv()).catch(() => undefined)
    expect(mockGetPullRequest).not.toHaveBeenCalled() // flag short-circuits before any fetch
    expect(mockEnsemble).toHaveBeenCalledTimes(1)
  })

  it("completes a pre-created check run as 'skipped' when skipping a merged PR", async () => {
    // Don't leave the SIG-220 "Sigilix · In progress" row stuck forever (CodeRabbit #319).
    mockGetPullRequest.mockResolvedValueOnce(MERGED_PR)
    await dispatchJob(prReviewJob({ checkRunId: 4242 }), makeEnv())
    expect(mockEnsemble).not.toHaveBeenCalled()
    expect(mockAttachCheckRun).toHaveBeenCalledTimes(1)
    expect(mockCompleteCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: "skipped" }),
    )
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
