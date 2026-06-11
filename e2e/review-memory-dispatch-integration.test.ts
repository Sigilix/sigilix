// SIG-185 — integration coverage for review-memory dispatch wrappers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"

const VALID_MARKER = "<!-- sigilix:fid:1111111111111111:cat:performance:sev:warning:path:222222222222 -->"
const VALID_FINGERPRINT = "f".repeat(64)
const PRECISION_FINDING_MARKERS = [
  "<!-- sigilix:pr-review-finding -->",
  "<!-- sigilix:category:performance -->",
  "<!-- sigilix:severity:3 -->",
  `<!-- sigilix:fingerprint:${VALID_FINGERPRINT} -->`,
].join("\n")

const {
  mockGetFileContent,
  mockGetInstallationToken,
  mockGetPullRequest,
  mockGetRepository,
  mockGitHubClient,
  mockListIssueComments,
  mockListPullRequestReviewComments,
  mockListPullRequestReviews,
} = vi.hoisted(() => ({
  mockGetFileContent: vi.fn(async (..._args: unknown[]) => JSON.stringify({ reviewMemory: { captureOnly: true } })),
  mockGetInstallationToken: vi.fn(async (_args?: unknown) => "test-token"),
  mockGetPullRequest: vi.fn(async (..._args: unknown[]) => ({
    number: 7,
    title: "PR",
    body: "",
    user: { login: "human" },
    head: { sha: "head", ref: "branch" },
    base: { sha: "base", ref: "main" },
  })),
  mockGetRepository: vi.fn(async (..._args: unknown[]) => ({
    default_branch: "main",
    id: 555_000,
  })),
  mockGitHubClient: vi.fn(() => ({
    getFileContent: (...args: unknown[]) => mockGetFileContent(...args),
    getPullRequest: (...args: unknown[]) => mockGetPullRequest(...args),
    getRepository: (...args: unknown[]) => mockGetRepository(...args),
    listIssueComments: (...args: unknown[]) => mockListIssueComments(...args),
    listPullRequestReviewComments: (...args: unknown[]) => mockListPullRequestReviewComments(...args),
    listPullRequestReviews: (...args: unknown[]) => mockListPullRequestReviews(...args),
  })),
  mockListIssueComments: vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>[]> => []),
  mockListPullRequestReviewComments: vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>[]> => []),
  mockListPullRequestReviews: vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>[]> => []),
}))

vi.mock("@/src/shared/adapters/github/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("@/src/shared/adapters/github", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/github")>("@/src/shared/adapters/github")
  return {
    ...actual,
    GitHubClient: mockGitHubClient,
  }
})

import { dispatchDismissedReviewMemoryCapture, dispatchTopLevelReviewMemoryCapture } from "@/src/index"

interface KvStub {
  kv: Env["OPENCLAW_STATE"]
  store: Map<string, string>
}

function makeKvStub(): KvStub {
  const store = new Map<string, string>()
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store }
}

function makeEnv(kv: Env["OPENCLAW_STATE"]): Env {
  return {
    OPENCLAW_REVIEW_MEMORY_CAPTURE: "on",
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
    OPENCLAW_STATE: kv,
  } as Env
}

beforeEach(() => {
  mockGetFileContent.mockReset().mockResolvedValue(JSON.stringify({ reviewMemory: { captureOnly: true } }))
  mockGetInstallationToken.mockReset().mockResolvedValue("test-token")
  mockGetPullRequest.mockClear()
  mockGetRepository.mockClear()
  mockGitHubClient.mockClear()
  mockListIssueComments.mockReset().mockResolvedValue([])
  mockListPullRequestReviewComments.mockReset().mockResolvedValue([])
  mockListPullRequestReviews.mockReset().mockResolvedValue([])
  vi.spyOn(console, "log").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("review-memory dispatch wrappers — real capture path", () => {
  it("top-level dispatch resolves config and writes through captureTopLevelReviewFeedback", async () => {
    const { kv, store } = makeKvStub()
    mockListPullRequestReviewComments.mockResolvedValue([
      {
        id: 500,
        body: VALID_MARKER,
        path: "src/lib/foo.ts",
        user: { login: "sigilix[bot]" },
      },
    ])

    await dispatchTopLevelReviewMemoryCapture({
      env: makeEnv(kv),
      owner: "acme",
      repo: "site",
      prNumber: 7,
      installationId: 99,
      comment: {
        id: 900,
        body: `${VALID_MARKER}\n\nfalse positive`,
      },
      repoId: 555,
    })

    expect(mockGetInstallationToken).toHaveBeenCalledOnce()
    expect(mockGitHubClient).toHaveBeenCalledWith({ token: "test-token" })
    expect(mockGetFileContent).toHaveBeenCalledWith("acme", "site", "sigilix.json", "head")
    const record = JSON.parse(store.get("review-memory:repo:555:cat:performance")!)
    expect(record.signals[0].commentId).toBe(900)
    expect(record.signals[0].fid).toBe("1111111111111111")
  })

  it("dismissed-review dispatch resolves config at the webhook head SHA and records stale precision", async () => {
    const { kv, store } = makeKvStub()
    const headSha = "a".repeat(40)

    await dispatchDismissedReviewMemoryCapture({
      env: makeEnv(kv),
      owner: "acme",
      repo: "site",
      prNumber: 7,
      installationId: 99,
      review: {
        id: 700,
        body: PRECISION_FINDING_MARKERS,
        commit_id: "b".repeat(40),
        user: { login: "sigilix[bot]" },
      },
      headSha,
    })

    expect(mockGetFileContent).toHaveBeenCalledWith("acme", "site", "sigilix.json", headSha)
    const profile = JSON.parse(store.get("precision-profile:repo:acme/site")!)
    expect(profile.patterns[VALID_FINGERPRINT].suppress).toBe(0)
  })
})
