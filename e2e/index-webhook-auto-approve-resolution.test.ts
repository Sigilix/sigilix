// SIG-223 — webhook-level auto-APPROVE when the latest blocking
// Sigilix review's finding threads have all been addressed without a
// new commit. Exercises the real signed GitHub webhook route; GitHub
// API calls are mocked at the adapter boundary.

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"

const HEAD_A = "a".repeat(40)
const HEAD_B = "b".repeat(40)
const REVIEW_MARKER = "<!-- sigilix:pr-review -->"
const FINDING_MARKER = "<!-- sigilix:pr-review-finding -->"

const {
  mockGetInstallationToken,
  mockGetPullRequest,
  mockListPullRequestReviews,
  mockListPullRequestReviewComments,
  mockListPullRequestReviewThreads,
  mockSubmitReview,
} = vi.hoisted(() => ({
  mockGetInstallationToken: vi.fn(async (_args?: unknown) => "test-token"),
  mockGetPullRequest: vi.fn(),
  mockListPullRequestReviews: vi.fn(),
  mockListPullRequestReviewComments: vi.fn(),
  mockListPullRequestReviewThreads: vi.fn(),
  mockSubmitReview: vi.fn(),
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
      listPullRequestReviews: (...args: unknown[]) => mockListPullRequestReviews(...args),
      listPullRequestReviewComments: (...args: unknown[]) => mockListPullRequestReviewComments(...args),
      listPullRequestReviewThreads: (...args: unknown[]) => mockListPullRequestReviewThreads(...args),
      submitReview: (...args: unknown[]) => mockSubmitReview(...args),
    })),
  }
})

const SECRET = "test-webhook-secret"
const encoder = new TextEncoder()
const OWNER = "acme"
const REPO = "site"
const PR_NUMBER = 7

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
  const kv = new Map<string, string>()
  return {
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
    GITHUB_WEBHOOK_SECRET: SECRET,
    OPENCLAW_STATE: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => {
        kv.set(key, value)
      },
      delete: async (key: string) => {
        kv.delete(key)
      },
    } as unknown as Env["OPENCLAW_STATE"],
    OPENCLAW_JOBS: {
      send: async () => undefined,
    } as unknown as Env["OPENCLAW_JOBS"],
  } as Env
}

function latestBlockingReview(headSha = HEAD_A) {
  return {
    id: 101,
    state: "CHANGES_REQUESTED",
    user: { login: "sigilix[bot]" },
    body: `${REVIEW_MARKER}\nNeeds changes.`,
    commitId: headSha,
  }
}

function reviewComments({ secondResolved }: { secondResolved: boolean }) {
  return [
    {
      id: 11,
      user: { login: "sigilix[bot]" },
      body: FINDING_MARKER,
      path: "src/a.ts",
      line: 2,
      original_line: 2,
      pull_request_review_id: 101,
    },
    {
      id: 12,
      user: { login: "sigilix[bot]" },
      body: FINDING_MARKER,
      path: "src/b.ts",
      line: 5,
      original_line: 5,
      pull_request_review_id: 101,
    },
    ...(secondResolved
      ? [
          {
            id: 21,
            user: { login: "maintainer" },
            author_association: "MEMBER",
            body: "@sigilix resolved",
            path: "src/b.ts",
            line: 5,
            original_line: 5,
            in_reply_to_id: 12,
            pull_request_review_id: null,
          },
        ]
      : []),
  ]
}

function reviewThreads() {
  return [
    { id: "T1", isResolved: true, firstCommentId: 11, firstCommentLogin: "sigilix[bot]" },
    { id: "T2", isResolved: false, firstCommentId: 12, firstCommentLogin: "sigilix[bot]" },
  ]
}

function basePayload() {
  return {
    action: "resolved",
    installation: { id: 99 },
    repository: { id: 555, name: REPO, owner: { login: OWNER }, full_name: `${OWNER}/${REPO}` },
    pull_request: {
      number: PR_NUMBER,
      head: { sha: HEAD_A, ref: "feature/x" },
      base: { sha: "c".repeat(40), ref: "main" },
      user: { login: "feature-author" },
    },
    sender: { login: "maintainer" },
    thread: { node_id: "T1", comments: [{ id: 11 }] },
  }
}

async function postWebhook(event: string, payload: unknown, waitUntilPromises: Promise<unknown>[]): Promise<Response> {
  const body = JSON.stringify(payload)
  const sig = await signBody(body)
  const worker = (await import("@/src/index")).default
  return worker.fetch(
    new Request("https://example.com/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": `test-${event}`,
        "x-hub-signature-256": sig,
      },
      body,
    }),
    makeEnv(),
    {
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilPromises.push(promise)
      },
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext,
  )
}

beforeEach(() => {
  mockGetInstallationToken.mockReset().mockResolvedValue("test-token")
  mockGetPullRequest.mockReset().mockResolvedValue({
    number: PR_NUMBER,
    title: "PR",
    body: "",
    user: { login: "feature-author" },
    head: { sha: HEAD_A, ref: "feature/x" },
    base: { sha: "c".repeat(40), ref: "main" },
  })
  mockListPullRequestReviews.mockReset().mockResolvedValue([latestBlockingReview()])
  mockListPullRequestReviewComments.mockReset().mockResolvedValue(reviewComments({ secondResolved: true }))
  mockListPullRequestReviewThreads.mockReset().mockResolvedValue(reviewThreads())
  mockSubmitReview.mockReset().mockResolvedValue({ id: 202, state: "APPROVED" })
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

describe("GitHub webhook auto-APPROVE on resolved Sigilix findings (SIG-223)", () => {
  it("submits APPROVE on pull_request_review_thread.resolved when all findings are resolved on the same head", async () => {
    const waitUntilPromises: Promise<unknown>[] = []

    const res = await postWebhook("pull_request_review_thread", basePayload(), waitUntilPromises)
    await Promise.all(waitUntilPromises)

    expect(res.status).toBe(202)
    expect(mockSubmitReview).toHaveBeenCalledWith(
      OWNER,
      REPO,
      PR_NUMBER,
      expect.objectContaining({
        event: "APPROVE",
        commit_id: HEAD_A,
        body: expect.stringContaining("All prior findings addressed."),
      }),
    )
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("pr-review-auto-approved-on-resolution"))
  })

  it("does not trust pull_request_review_thread.resolved when the PR author resolved the thread", async () => {
    const waitUntilPromises: Promise<unknown>[] = []
    const payload = { ...basePayload(), sender: { login: "feature-author" } }

    const res = await postWebhook("pull_request_review_thread", payload, waitUntilPromises)
    await Promise.all(waitUntilPromises)

    expect(res.status).toBe(200)
    expect(waitUntilPromises).toHaveLength(0)
    expect(mockSubmitReview).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("pr-review-auto-approve-skipped-untrusted-thread-resolution"),
    )
  })

  it("skips on pull_request_review_comment.created when the current head moved after the prior review", async () => {
    const waitUntilPromises: Promise<unknown>[] = []
    mockGetPullRequest.mockResolvedValueOnce({
      number: PR_NUMBER,
      title: "PR",
      body: "",
      user: { login: "feature-author" },
      head: { sha: HEAD_B, ref: "feature/x" },
      base: { sha: "c".repeat(40), ref: "main" },
    })
    const payload = {
      ...basePayload(),
      action: "created",
      comment: { id: 21, body: "Fixed", user: { login: "feature-author" }, in_reply_to_id: 12 },
    }

    const res = await postWebhook("pull_request_review_comment", payload, waitUntilPromises)
    await Promise.all(waitUntilPromises)

    expect(res.status).toBe(200)
    expect(mockSubmitReview).not.toHaveBeenCalled()
    expect(mockListPullRequestReviewComments).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("pr-review-auto-approve-skipped-head-moved"))
  })

  it("skips on issue_comment @sigilix resolved when only some latest-review findings are resolved", async () => {
    const waitUntilPromises: Promise<unknown>[] = []
    mockListPullRequestReviewComments.mockResolvedValueOnce(reviewComments({ secondResolved: false }))
    const payload = {
      ...basePayload(),
      action: "created",
      issue: { number: PR_NUMBER, pull_request: { url: "https://api.github.com/repos/acme/site/pulls/7" } },
      comment: {
        id: 501,
        body: "@sigilix resolved",
        user: { login: "feature-author" },
        author_association: "MEMBER",
      },
    }

    const res = await postWebhook("issue_comment", payload, waitUntilPromises)
    await Promise.all(waitUntilPromises)

    expect(res.status).toBe(202)
    expect(waitUntilPromises).toHaveLength(1)
    expect(mockSubmitReview).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("pr-review-auto-approve-skipped-partial"))
  })
})
