import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  bodyHasSigilixResolutionCommand,
  maybeAutoApproveResolvedSigilixReview,
  type AutoApproveClient,
} from "./pr-review-auto-approve"
import type { Env } from "@/src/shared/types/env"

const HEAD = "a".repeat(40)
const REVIEW_MARKER = "<!-- sigilix:pr-review -->"
const FINDING_MARKER = "<!-- sigilix:pr-review-finding -->"

function makeKv(): Env["OPENCLAW_STATE"] {
  const values = new Map<string, string>()
  return {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => {
      values.set(key, value)
    },
    delete: async (key: string) => {
      values.delete(key)
    },
  } as unknown as Env["OPENCLAW_STATE"]
}

function makeContendedKv(): Env["OPENCLAW_STATE"] {
  let getCount = 0
  return {
    get: vi.fn(async () => {
      getCount += 1
      if (getCount === 1) return null
      return JSON.stringify({
        kind: "review-auto-approve-in-progress",
        token: "other-delivery",
        createdAt: Date.now(),
      })
    }),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  } as unknown as Env["OPENCLAW_STATE"]
}

function makeClient(
  options: {
    replyBody?: string
    replyAssociation?: string
    replyLogin?: string
    preSubmitApproval?: boolean
    preSubmitNewBlockingReview?: boolean
  } = {},
): AutoApproveClient {
  const replyBody = options.replyBody ?? "@sigilix dismiss not-a-bug"
  const replyLogin = options.replyLogin ?? "reviewer"
  let reviewListCalls = 0
  const blockingReview = {
    id: 10,
    state: "CHANGES_REQUESTED",
    user: { login: "sigilix[bot]" },
    body: REVIEW_MARKER,
    commitId: HEAD,
  }
  return {
    getPullRequest: vi.fn(async () => ({
      number: 1,
      title: "PR",
      body: "",
      user: { login: "author" },
      head: { sha: HEAD, ref: "feature" },
      base: { sha: "b".repeat(40), ref: "main" },
    })),
    listPullRequestReviews: vi.fn(async () => {
      reviewListCalls += 1
      if (options.preSubmitApproval && reviewListCalls > 1) {
        return [
          blockingReview,
          {
            id: 11,
            state: "APPROVED",
            user: { login: "sigilix[bot]" },
            body: REVIEW_MARKER,
            commitId: HEAD,
          },
        ]
      }
      if (options.preSubmitNewBlockingReview && reviewListCalls > 1) {
        return [
          blockingReview,
          {
            id: 11,
            state: "APPROVED",
            user: { login: "sigilix[bot]" },
            body: REVIEW_MARKER,
            commitId: HEAD,
          },
          {
            id: 12,
            state: "CHANGES_REQUESTED",
            user: { login: "sigilix[bot]" },
            body: REVIEW_MARKER,
            commitId: HEAD,
          },
        ]
      }
      return [blockingReview]
    }),
    listPullRequestReviewComments: vi.fn(async () => [
      {
        id: 100,
        user: { login: "sigilix[bot]" },
        body: FINDING_MARKER,
        path: "src/a.ts",
        line: 4,
        original_line: 4,
        pull_request_review_id: 10,
      },
      {
        id: 101,
        user: { login: replyLogin },
        ...(options.replyAssociation ? { author_association: options.replyAssociation } : {}),
        body: replyBody,
        path: "src/a.ts",
        line: 4,
        original_line: 4,
        in_reply_to_id: 100,
        pull_request_review_id: null,
      },
    ]),
    listPullRequestReviewThreads: vi.fn(async () => [
      { id: "T100", isResolved: false, firstCommentId: 100, firstCommentLogin: "sigilix[bot]" },
    ]),
    submitReview: vi.fn(async () => ({ id: 99, state: "APPROVED" })),
  }
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

describe("bodyHasSigilixResolutionCommand", () => {
  it("accepts explicit dismiss and resolved commands but ignores quoted text", () => {
    expect(bodyHasSigilixResolutionCommand("@sigilix dismiss not-a-bug")).toBe(true)
    expect(bodyHasSigilixResolutionCommand("@sigilix resolved")).toBe(true)
    expect(bodyHasSigilixResolutionCommand("> @sigilix dismiss\n\nnot doing that")).toBe(false)
    expect(bodyHasSigilixResolutionCommand("`@sigilix dismiss`")).toBe(false)
    expect(bodyHasSigilixResolutionCommand("```\n@sigilix resolved\n```")).toBe(false)
  })
})

describe("maybeAutoApproveResolvedSigilixReview", () => {
  it("counts explicit in-thread dismiss commands and suppresses duplicate approvals", async () => {
    const kv = makeKv()
    const client = makeClient({ replyAssociation: "MEMBER" })
    const args = {
      env: { OPENCLAW_STATE: kv },
      client,
      owner: "acme",
      repo: "site",
      prNumber: 1,
      trigger: "review-comment-created" as const,
    }

    await expect(maybeAutoApproveResolvedSigilixReview(args)).resolves.toMatchObject({
      kind: "approved",
      resolvedCount: 1,
      totalCount: 1,
    })
    await expect(maybeAutoApproveResolvedSigilixReview(args)).resolves.toEqual({ kind: "duplicate" })
    expect(client.submitReview).toHaveBeenCalledTimes(1)
  })

  it("does not count PR-author commands as resolution even when the author is trusted", async () => {
    const client = makeClient({ replyBody: "@sigilix dismiss", replyAssociation: "MEMBER", replyLogin: "author" })

    await expect(
      maybeAutoApproveResolvedSigilixReview({
        env: { OPENCLAW_STATE: makeKv() },
        client,
        owner: "acme",
        repo: "site",
        prNumber: 1,
        trigger: "review-comment-created",
      }),
    ).resolves.toEqual({ kind: "partial", resolvedCount: 0, totalCount: 1 })

    expect(client.submitReview).not.toHaveBeenCalled()
  })

  it("does not submit when a newer Sigilix blocking review appears before submit", async () => {
    const client = makeClient({ replyAssociation: "MEMBER", preSubmitNewBlockingReview: true })

    await expect(
      maybeAutoApproveResolvedSigilixReview({
        env: { OPENCLAW_STATE: makeKv() },
        client,
        owner: "acme",
        repo: "site",
        prNumber: 1,
        trigger: "review-comment-created",
      }),
    ).resolves.toEqual({ kind: "no-op", reason: "stale-review" })

    expect(client.submitReview).not.toHaveBeenCalled()
  })

  it("does not submit when a same-head Sigilix approval appears before submit", async () => {
    const client = makeClient({ replyAssociation: "MEMBER", preSubmitApproval: true })

    await expect(
      maybeAutoApproveResolvedSigilixReview({
        env: { OPENCLAW_STATE: makeKv() },
        client,
        owner: "acme",
        repo: "site",
        prNumber: 1,
        trigger: "review-comment-created",
      }),
    ).resolves.toEqual({ kind: "duplicate" })

    expect(client.submitReview).not.toHaveBeenCalled()
  })

  it("does not submit when another webhook owns the in-progress lock", async () => {
    const client = makeClient()
    await expect(
      maybeAutoApproveResolvedSigilixReview({
        env: { OPENCLAW_STATE: makeContendedKv() },
        client,
        owner: "acme",
        repo: "site",
        prNumber: 1,
        trigger: "review-comment-created",
      }),
    ).resolves.toEqual({ kind: "duplicate" })

    expect(client.listPullRequestReviewComments).not.toHaveBeenCalled()
    expect(client.submitReview).not.toHaveBeenCalled()
  })
})
