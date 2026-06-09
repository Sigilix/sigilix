// SIG-185 follow-up — top-level review-memory capture must not parse
// copied Sigilix markers from non-Sigilix PR conversation comments.
//
// Exercises the real signed GitHub webhook route because the hardening
// boundary lives at dispatch time, before ctx.waitUntil schedules the
// GitHub/config/KV I/O chain.

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../src/shared/types/env"

const {
  mockCaptureTopLevelReviewFeedback,
  mockGetInstallationToken,
  mockGetPullRequest,
  mockLoadSigilixConfig,
} = vi.hoisted(() => ({
  mockCaptureTopLevelReviewFeedback: vi.fn(() => undefined),
  mockGetInstallationToken: vi.fn(() => "test-token"),
  mockGetPullRequest: vi.fn(() => ({ head: { sha: "c".repeat(40) } })),
  mockLoadSigilixConfig: vi.fn(() => ({ reviewMemory: { enabled: true } })),
}))

vi.mock("../src/lib/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("../src/lib/github", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/github")>("../src/lib/github")
  return {
    ...actual,
    GitHubClient: vi.fn().mockImplementation(() => ({
      getPullRequest: (...args: unknown[]) => mockGetPullRequest(...args),
    })),
  }
})

vi.mock("../src/lib/sigilix-config", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/sigilix-config")>(
    "../src/lib/sigilix-config",
  )
  return {
    ...actual,
    loadSigilixConfig: (...args: unknown[]) => mockLoadSigilixConfig(...args),
  }
})

vi.mock("../src/lib/review-memory/capture", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/review-memory/capture")>(
    "../src/lib/review-memory/capture",
  )
  return {
    ...actual,
    captureTopLevelReviewFeedback: (...args: unknown[]) =>
      mockCaptureTopLevelReviewFeedback(...args),
  }
})

const SECRET = "test-webhook-secret"
const encoder = new TextEncoder()
const VALID_MARKER =
  "<!-- sigilix:fid:a1b2c3d4e5f6a7b8:cat:performance:sev:warning:path:ffaabbccddee -->"

async function signBody(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(body))
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  return `sha256=${hex}`
}

function makeEnv(): Env {
  return {
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
    GITHUB_WEBHOOK_SECRET: SECRET,
    OPENCLAW_REVIEW_MEMORY_CAPTURE: "on",
    OPENCLAW_STATE: {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
    } as unknown as Env["OPENCLAW_STATE"],
    OPENCLAW_JOBS: {
      send: async () => undefined,
    } as unknown as Env["OPENCLAW_JOBS"],
  } as Env
}

function makeIssueCommentPayload(login: string) {
  return {
    action: "created",
    installation: { id: 99 },
    repository: {
      id: 555,
      name: "site",
      owner: { login: "acme" },
      full_name: "acme/site",
    },
    issue: {
      number: 7,
      pull_request: { url: "https://api.github.com/repos/acme/site/pulls/7" },
    },
    comment: {
      id: 123,
      body: `${VALID_MARKER}\n\nfalse positive`,
      user: { login },
      author_association: "MEMBER",
    },
  }
}

async function postIssueCommentWebhook(
  payload: unknown,
  waitUntilPromises: Promise<unknown>[],
): Promise<Response> {
  const body = JSON.stringify(payload)
  const sig = await signBody(body)
  const worker = (await import("../src/index")).default
  return worker.fetch(
    new Request("https://example.com/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issue_comment",
        "x-github-delivery": "test-delivery-id",
        "x-hub-signature-256": sig,
      },
      body,
    }),
    makeEnv(),
    {
      waitUntil: (promise: Promise<unknown>) => { waitUntilPromises.push(promise) },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
  )
}

beforeEach(() => {
  mockCaptureTopLevelReviewFeedback.mockClear()
  mockGetInstallationToken.mockClear()
  mockGetPullRequest.mockClear()
  mockLoadSigilixConfig.mockClear()
})

describe("issue_comment webhook review-memory author gate", () => {
  it("does not schedule top-level review-memory capture for copied markers from humans", async () => {
    const waitUntilPromises: Promise<unknown>[] = []

    const res = await postIssueCommentWebhook(
      makeIssueCommentPayload("human-reviewer"),
      waitUntilPromises,
    )

    expect(res.status).toBe(200)
    expect(waitUntilPromises).toHaveLength(0)
    // The author gate must run before the marker parser can schedule
    // the token/config/capture I/O chain.
    expect(mockGetInstallationToken).not.toHaveBeenCalled()
    expect(mockLoadSigilixConfig).not.toHaveBeenCalled()
    expect(mockCaptureTopLevelReviewFeedback).not.toHaveBeenCalled()
  })

  it("still schedules top-level review-memory capture for Sigilix-authored markers", async () => {
    const waitUntilPromises: Promise<unknown>[] = []

    const res = await postIssueCommentWebhook(
      makeIssueCommentPayload("sigilix[bot]"),
      waitUntilPromises,
    )
    await Promise.all(waitUntilPromises)

    expect(res.status).toBe(200)
    expect(waitUntilPromises).toHaveLength(1)
    expect(mockGetInstallationToken).toHaveBeenCalledOnce()
    expect(mockGetPullRequest).toHaveBeenCalledWith("acme", "site", 7)
    expect(mockCaptureTopLevelReviewFeedback).toHaveBeenCalledWith(expect.objectContaining({
      owner: "acme",
      repo: "site",
      prNumber: 7,
      repoId: 555,
      comment: {
        id: 123,
        body: `${VALID_MARKER}\n\nfalse positive`,
      },
    }))
  })
})
