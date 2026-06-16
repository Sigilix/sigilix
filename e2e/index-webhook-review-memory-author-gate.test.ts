// SIG-185 follow-up / SIG-104 PR-2 — top-level review-memory capture
// schedules human PR conversation comments that carry copied Sigilix
// markers, but the capture layer still verifies the marker against a
// real Sigilix-authored source before any write.
//
// Exercises the real signed GitHub webhook route because the hardening
// boundary lives at dispatch time, before ctx.waitUntil schedules the
// GitHub/config/KV I/O chain.

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"

const { mockCaptureTopLevelReviewFeedback, mockGetInstallationToken, mockGetPullRequest, mockLoadSigilixConfig } =
  vi.hoisted(() => ({
    mockCaptureTopLevelReviewFeedback: vi.fn((..._args: unknown[]) => undefined),
    mockGetInstallationToken: vi.fn((_args?: unknown) => "test-token"),
    mockGetPullRequest: vi.fn((..._args: unknown[]) => ({ head: { sha: "c".repeat(40) } })),
    mockLoadSigilixConfig: vi.fn((..._args: unknown[]) => ({ reviewMemory: { enabled: true } })),
  }))

vi.mock("@/src/shared/adapters/github/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("@/src/shared/adapters/github", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/github")>("@/src/shared/adapters/github")
  return {
    ...actual,
    GitHubClient: vi.fn().mockImplementation(() => ({
      getPullRequest: (...args: unknown[]) => mockGetPullRequest(...args),
    })),
  }
})

vi.mock("@/src/lib/sigilix-config", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/sigilix-config")>("@/src/lib/sigilix-config")
  return {
    ...actual,
    loadSigilixConfig: (...args: unknown[]) => mockLoadSigilixConfig(...args),
  }
})

vi.mock("@/src/lib/review-memory/capture", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/review-memory/capture")>(
    "@/src/lib/review-memory/capture",
  )
  return {
    ...actual,
    captureTopLevelReviewFeedback: (...args: unknown[]) => mockCaptureTopLevelReviewFeedback(...args),
  }
})

const SECRET = "test-webhook-secret"
const encoder = new TextEncoder()
const VALID_MARKER = "<!-- sigilix:fid:a1b2c3d4e5f6a7b8:cat:performance:sev:warning:path:ffaabbccddee -->"

async function signBody(body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
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

function makeIssueCommentPayload(login: string, body = `${VALID_MARKER}\n\nfalse positive`) {
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
      body,
      user: { login },
      author_association: "MEMBER",
    },
  }
}

async function postIssueCommentWebhook(payload: unknown, waitUntilPromises: Promise<unknown>[]): Promise<Response> {
  const body = JSON.stringify(payload)
  const sig = await signBody(body)
  const worker = (await import("@/src/index")).default
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
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilPromises.push(promise)
      },
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

describe("issue_comment webhook review-memory author plumbing", () => {
  it("schedules top-level review-memory capture for copied markers from humans and threads author login", async () => {
    const waitUntilPromises: Promise<unknown>[] = []

    const res = await postIssueCommentWebhook(makeIssueCommentPayload("human-reviewer"), waitUntilPromises)
    await Promise.all(waitUntilPromises)

    expect(res.status).toBe(200)
    expect(waitUntilPromises).toHaveLength(1)
    expect(mockGetInstallationToken).toHaveBeenCalledOnce()
    expect(mockLoadSigilixConfig).toHaveBeenCalledOnce()
    expect(mockCaptureTopLevelReviewFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "site",
        prNumber: 7,
        repoId: 555,
        comment: {
          id: 123,
          body: `${VALID_MARKER}\n\nfalse positive`,
          authorLogin: "human-reviewer",
        },
      }),
    )
  })

  it("still schedules top-level review-memory capture for Sigilix-authored markers", async () => {
    const waitUntilPromises: Promise<unknown>[] = []

    const res = await postIssueCommentWebhook(makeIssueCommentPayload("sigilix[bot]"), waitUntilPromises)
    await Promise.all(waitUntilPromises)

    expect(res.status).toBe(200)
    expect(waitUntilPromises).toHaveLength(1)
    expect(mockGetInstallationToken).toHaveBeenCalledOnce()
    expect(mockGetPullRequest).toHaveBeenCalledWith("acme", "site", 7)
    expect(mockCaptureTopLevelReviewFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "site",
        prNumber: 7,
        repoId: 555,
        comment: {
          id: 123,
          body: `${VALID_MARKER}\n\nfalse positive`,
          authorLogin: "sigilix[bot]",
        },
      }),
    )
  })

  it("schedules teachable top-level comments even without a dismissal keyword", async () => {
    const waitUntilPromises: Promise<unknown>[] = []
    const body = `${VALID_MARKER}\n\nGoing forward, prefer service-layer database access in controllers.`

    const res = await postIssueCommentWebhook(makeIssueCommentPayload("human-reviewer", body), waitUntilPromises)
    await Promise.all(waitUntilPromises)

    expect(res.status).toBe(200)
    expect(waitUntilPromises).toHaveLength(1)
    expect(mockCaptureTopLevelReviewFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        comment: {
          id: 123,
          body,
          authorLogin: "human-reviewer",
        },
      }),
    )
  })
})
