// SIG-185 — webhook dispatch wrappers for review-memory feedback capture.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"
import type { ResolvedReviewMemoryConfig } from "@/src/lib/review-memory/types"

const {
  mockCaptureReviewFeedback,
  mockCaptureDismissedReviewFeedback,
  mockCaptureTopLevelReviewFeedback,
  mockGetInstallationToken,
  mockGetPullRequest,
  mockGitHubClient,
  mockLoadSigilixConfig,
  mockResolveReviewMemoryConfig,
  resolvedReviewMemoryConfig,
} = vi.hoisted(() => {
  const resolvedReviewMemoryConfig: ResolvedReviewMemoryConfig = {
    enabled: true,
    captureOnly: true,
    categories: ["security", "logic", "performance", "tests"],
    maxInjectedMemories: 5,
    minSignalThreshold: 3,
    maxSignalAgeDays: 90,
    claimSoftening: false,
  }
  return {
    mockCaptureReviewFeedback: vi.fn(async (..._args: unknown[]) => undefined),
    mockCaptureDismissedReviewFeedback: vi.fn(async (..._args: unknown[]) => undefined),
    mockCaptureTopLevelReviewFeedback: vi.fn(async (..._args: unknown[]) => undefined),
    mockGetInstallationToken: vi.fn(async (_args?: unknown) => "test-token"),
    mockGetPullRequest: vi.fn(async (..._args: unknown[]) => ({ head: { sha: "c".repeat(40) } })),
    mockGitHubClient: vi.fn((args: { token: string }) => ({
      token: args.token,
      getPullRequest: (...getPullRequestArgs: unknown[]) => mockGetPullRequest(...getPullRequestArgs),
    })),
    mockLoadSigilixConfig: vi.fn(async (..._args: unknown[]) => ({
      reviewMemory: { enabled: true },
    })),
    mockResolveReviewMemoryConfig: vi.fn((_config?: unknown) => resolvedReviewMemoryConfig),
    resolvedReviewMemoryConfig,
  }
})

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

vi.mock("@/src/lib/sigilix-config", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/sigilix-config")>("@/src/lib/sigilix-config")
  return {
    ...actual,
    loadSigilixConfig: (...args: unknown[]) => mockLoadSigilixConfig(...args),
    resolveReviewMemoryConfig: (config: unknown) => mockResolveReviewMemoryConfig(config),
  }
})

vi.mock("@/src/lib/review-memory/capture", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/review-memory/capture")>(
    "@/src/lib/review-memory/capture",
  )
  return {
    ...actual,
    captureReviewFeedback: (...args: unknown[]) => mockCaptureReviewFeedback(...args),
    captureDismissedReviewFeedback: (...args: unknown[]) => mockCaptureDismissedReviewFeedback(...args),
    captureTopLevelReviewFeedback: (...args: unknown[]) => mockCaptureTopLevelReviewFeedback(...args),
  }
})

import {
  dispatchDismissedReviewMemoryCapture,
  dispatchReviewMemoryCapture,
  dispatchTopLevelReviewMemoryCapture,
} from "@/src/index"

function makeEnv(overrides: { [K in keyof Env]?: Env[K] | undefined } = {}): Env {
  return {
    OPENCLAW_REVIEW_MEMORY_CAPTURE: "on",
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
    OPENCLAW_STATE: {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
    } as unknown as Env["OPENCLAW_STATE"],
    ...overrides,
  } as Env
}

function topLevelArgs(env: Env) {
  return {
    env,
    owner: "acme",
    repo: "site",
    prNumber: 7,
    installationId: 99,
    comment: { id: 123, body: "false positive", authorLogin: "alice" },
    repoId: 555,
  }
}

function inlineArgs(env: Env) {
  return {
    env,
    owner: "acme",
    repo: "site",
    prNumber: 7,
    installationId: 99,
    comment: { id: 122, body: "false positive", path: "src/lib/foo.ts", in_reply_to_id: 50, authorLogin: "alice" },
    repoId: 555,
  }
}

function dismissedArgs(env: Env, headSha = "h".repeat(40)) {
  return {
    env,
    owner: "acme",
    repo: "site",
    prNumber: 7,
    installationId: 99,
    review: {
      id: 456,
      body: "<!-- sigilix:pr-review-finding -->",
      commit_id: "o".repeat(40),
      user: { login: "sigilix[bot]" },
    },
    headSha,
  }
}

beforeEach(() => {
  mockCaptureReviewFeedback.mockClear()
  mockCaptureDismissedReviewFeedback.mockClear()
  mockCaptureTopLevelReviewFeedback.mockClear()
  mockGetInstallationToken.mockReset().mockResolvedValue("test-token")
  mockGetPullRequest.mockReset().mockResolvedValue({ head: { sha: "c".repeat(40) } })
  mockGitHubClient.mockClear()
  mockLoadSigilixConfig.mockReset().mockResolvedValue({ reviewMemory: { enabled: true } })
  mockResolveReviewMemoryConfig.mockReset().mockReturnValue(resolvedReviewMemoryConfig)
  vi.spyOn(console, "log").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("review-memory dispatch wrappers", () => {
  it("skips top-level capture when the capture flag is off", async () => {
    await dispatchTopLevelReviewMemoryCapture(
      topLevelArgs(
        makeEnv({
          OPENCLAW_REVIEW_MEMORY_CAPTURE: "off",
        }),
      ),
    )

    expect(mockGetInstallationToken).not.toHaveBeenCalled()
    expect(mockLoadSigilixConfig).not.toHaveBeenCalled()
    expect(mockCaptureTopLevelReviewFeedback).not.toHaveBeenCalled()
  })

  it("skips dismissed-review capture when GitHub app credentials are missing", async () => {
    await dispatchDismissedReviewMemoryCapture(
      dismissedArgs(
        makeEnv({
          GITHUB_APP_ID: undefined,
        }),
      ),
    )

    expect(mockGetInstallationToken).not.toHaveBeenCalled()
    expect(mockLoadSigilixConfig).not.toHaveBeenCalled()
    expect(mockCaptureDismissedReviewFeedback).not.toHaveBeenCalled()
  })

  it("logs top-level token failures without throwing", async () => {
    const consoleSpy = vi.spyOn(console, "log")
    mockGetInstallationToken.mockRejectedValueOnce(new Error("token boom"))

    await dispatchTopLevelReviewMemoryCapture(topLevelArgs(makeEnv()))

    expect(mockLoadSigilixConfig).not.toHaveBeenCalled()
    expect(mockCaptureTopLevelReviewFeedback).not.toHaveBeenCalled()
    expect(consoleSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      '"signal_source":"top-level-explicit"',
    )
  })

  it("logs dismissed-review config failures without throwing", async () => {
    const consoleSpy = vi.spyOn(console, "log")
    mockLoadSigilixConfig.mockRejectedValueOnce(new Error("config boom"))

    await dispatchDismissedReviewMemoryCapture(dismissedArgs(makeEnv()))

    expect(mockCaptureDismissedReviewFeedback).not.toHaveBeenCalled()
    expect(consoleSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      '"signal_source":"review-dismissed-stale"',
    )
  })

  it("delegates top-level capture after resolving config", async () => {
    const args = topLevelArgs(makeEnv())

    await dispatchTopLevelReviewMemoryCapture(args)

    const client = mockGitHubClient.mock.results[0]?.value
    expect(mockGetPullRequest).toHaveBeenCalledWith("acme", "site", 7)
    expect(mockLoadSigilixConfig).toHaveBeenCalledWith(client, "acme", "site", "c".repeat(40))
    expect(mockResolveReviewMemoryConfig).toHaveBeenCalledWith({ reviewMemory: { enabled: true } })
    expect(mockCaptureTopLevelReviewFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        comment: args.comment,
        config: resolvedReviewMemoryConfig,
        repoId: 555,
      }),
    )
  })

  it("delegates inline capture with the reply author's login", async () => {
    const args = inlineArgs(makeEnv())

    await dispatchReviewMemoryCapture(args)

    const client = mockGitHubClient.mock.results[0]?.value
    expect(mockLoadSigilixConfig).toHaveBeenCalledWith(client, "acme", "site", "HEAD")
    expect(mockCaptureReviewFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        replyComment: args.comment,
        config: resolvedReviewMemoryConfig,
        repoId: 555,
      }),
    )
  })

  it("falls back to HEAD when top-level PR head lookup fails", async () => {
    const args = topLevelArgs(makeEnv())
    mockGetPullRequest.mockRejectedValueOnce(new Error("pr lookup failed"))

    await dispatchTopLevelReviewMemoryCapture(args)

    const client = mockGitHubClient.mock.results[0]?.value
    expect(mockLoadSigilixConfig).toHaveBeenCalledWith(client, "acme", "site", "HEAD")
    expect(mockCaptureTopLevelReviewFeedback).toHaveBeenCalled()
  })

  it("delegates dismissed-review capture using the webhook head SHA for config", async () => {
    const headSha = "a".repeat(40)
    const args = dismissedArgs(makeEnv(), headSha)

    await dispatchDismissedReviewMemoryCapture(args)

    const client = mockGitHubClient.mock.results[0]?.value
    expect(mockLoadSigilixConfig).toHaveBeenCalledWith(client, "acme", "site", headSha)
    expect(mockCaptureDismissedReviewFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        review: args.review,
        headSha,
        config: resolvedReviewMemoryConfig,
      }),
    )
  })
})
