import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { extractLearningMock } = vi.hoisted(() => ({
  extractLearningMock: vi.fn(),
}))

vi.mock("@/src/features/learnings", async (importActual) => {
  const actual = await importActual<typeof import("@/src/features/learnings")>()
  return {
    ...actual,
    extractLearning: extractLearningMock,
  }
})

import { renderConfirmReply } from "@/src/features/learnings"
import { captureReviewFeedback, captureTopLevelReviewFeedback } from "@/src/lib/review-memory/capture"
import {
  makeConfig,
  PRECISION_FINDING_MARKERS,
  VALID_MARKER,
} from "@/src/lib/review-memory/review-memory-capture.test-helpers"
import type { GitHubClient } from "@/src/shared/adapters/github"
import type { Env } from "@/src/shared/types/env"

const OWNER = "a"
const REPO = "r"
const PR = 7
const REPO_ID = 555_000
const RULE = "Prefer service-layer database access in controllers."

interface KvStub {
  kv: Env["OPENCLAW_STATE"]
  store: Map<string, string>
  puts: Array<{ key: string; value: string }>
}

function makeKvStub(): KvStub {
  const store = new Map<string, string>()
  const puts: Array<{ key: string; value: string }> = []
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value)
      puts.push({ key, value })
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store, puts }
}

function makeEnv(kv: Env["OPENCLAW_STATE"], mode: "off" | "shadow" | "on"): Env {
  return {
    OPENCLAW_STATE: kv,
    OPENCLAW_REVIEW_MEMORY_CAPTURE: "on",
    OPENCLAW_LEARNINGS_MODE: mode,
  } as unknown as Env
}

function teachableLearning() {
  return {
    rule: RULE,
    polarity: "context" as const,
    category: null,
    pathGlob: null,
  }
}

function makeInlineClient(opts: {
  permission?: string
  parentBody?: string
  parentLogin?: string
  confirmReplyId?: number
}): GitHubClient {
  const parentBody = opts.parentBody ?? `${PRECISION_FINDING_MARKERS}\n\n${VALID_MARKER}`
  return {
    getPullRequestReviewComment: vi.fn(async () => ({
      id: 50,
      body: parentBody,
      user: { login: opts.parentLogin ?? "sigilix[bot]" },
    })),
    getRepository: vi.fn(async () => ({ default_branch: "main", id: REPO_ID })),
    replyToReviewComment: vi.fn(async () => ({ id: opts.confirmReplyId ?? 9_001 })),
    restGet: vi.fn(async () => ({ permission: opts.permission ?? "write" })),
  } as unknown as GitHubClient
}

function makeTopLevelClient(opts: { permission?: string; confirmReplyId?: number } = {}): GitHubClient {
  return {
    listIssueComments: vi.fn(async () => []),
    listPullRequestReviewComments: vi.fn(async () => [
      {
        id: 500,
        body: `${PRECISION_FINDING_MARKERS}\n\n${VALID_MARKER}`,
        path: "src/lib/foo.ts",
        line: 10,
        original_line: 10,
        user: { login: "sigilix[bot]" },
      },
    ]),
    listPullRequestReviews: vi.fn(async () => []),
    getPullRequest: vi.fn(async () => ({
      number: PR,
      title: "PR",
      body: "",
      user: { login: "human" },
      head: { sha: "head", ref: "branch" },
      base: { sha: "base", ref: "main" },
    })),
    getRepository: vi.fn(async () => ({ default_branch: "main", id: REPO_ID })),
    createIssueComment: vi.fn(async () => ({ id: opts.confirmReplyId ?? 8_001 })),
    restGet: vi.fn(async () => ({ permission: opts.permission ?? "write" })),
  } as unknown as GitHubClient
}

function readLearnings(store: Map<string, string>): Array<{
  rule: string
  polarity: string
  authorLogin?: string
  source?: { kind?: string; commentId?: number }
}> {
  const stored = JSON.parse(store.get(`learnings:repo:${REPO_ID}`) ?? "{}") as {
    entries?: Array<{
      rule: string
      polarity: string
      authorLogin?: string
      source?: { kind?: string; commentId?: number }
    }>
  }
  return stored.entries ?? []
}

describe("SIG-104 conversational learning capture surfaces", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    extractLearningMock.mockResolvedValue(teachableLearning())
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
  })

  it("captures a teachable inline reply by a write-access author and posts a confirmation", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeInlineClient({ confirmReplyId: 9_101 })

    await captureReviewFeedback({
      env,
      client,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      replyComment: {
        id: 100,
        body: "Going forward, prefer service-layer database access in controllers.",
        in_reply_to_id: 50,
        path: "src/lib/foo.ts",
        authorLogin: "alice",
      },
      config: makeConfig(),
      repoId: REPO_ID,
    })

    expect(extractLearningMock).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        surface: "inline-reply",
        replyText: "Going forward, prefer service-layer database access in controllers.",
        findingContext: expect.stringContaining(VALID_MARKER),
        changedPaths: ["src/lib/foo.ts"],
      }),
    )
    expect(readLearnings(store)[0]).toMatchObject({
      rule: RULE,
      polarity: "context",
      authorLogin: "alice",
      source: { kind: "inline-reply", commentId: 100 },
    })
    expect(client.replyToReviewComment).toHaveBeenCalledWith(OWNER, REPO, PR, 100, renderConfirmReply(RULE))
    const learningId = readLearnings(store)[0]?.source
      ? JSON.parse(store.get(`learnings:repo:${REPO_ID}`)!).entries[0].id
      : null
    expect(JSON.parse(store.get("learning-confirmation:9101") ?? "{}")).toEqual({
      scope: "repo",
      subjectId: String(REPO_ID),
      learningId,
    })
    expect(store.has("learning-capture-seen:inline-reply:100")).toBe(true)
    expect(consoleLogSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain("learning-mutation-audit")
  })

  it("keeps dismissal capture firing on a false-positive inline reply while learning is additive", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeInlineClient({ confirmReplyId: 9_102 })

    await captureReviewFeedback({
      env,
      client,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      replyComment: {
        id: 101,
        body: "false positive - in this repo, prefer service-layer database access in controllers.",
        in_reply_to_id: 50,
        path: "src/lib/foo.ts",
        authorLogin: "alice",
      },
      config: makeConfig(),
      repoId: REPO_ID,
    })

    expect(readLearnings(store)).toHaveLength(1)
    const memoryRecord = JSON.parse(store.get("review-memory:repo:555000:cat:performance") ?? "{}") as {
      signals?: Array<{ commentId?: number }>
    }
    expect(memoryRecord.signals?.[0]?.commentId).toBe(101)
  })

  it("does not capture an inline ack reply when the extractor returns null", async () => {
    extractLearningMock.mockResolvedValueOnce(null)
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeInlineClient({})

    await captureReviewFeedback({
      env,
      client,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      replyComment: {
        id: 102,
        body: "thanks, fixed",
        in_reply_to_id: 50,
        path: "src/lib/foo.ts",
        authorLogin: "alice",
      },
      config: makeConfig(),
      repoId: REPO_ID,
    })

    expect(readLearnings(store)).toEqual([])
    expect(client.replyToReviewComment).not.toHaveBeenCalled()
    expect(store.has("learning-capture-seen:inline-reply:102")).toBe(false)
  })

  it("fail-closes without learning capture for an unauthorized inline author", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeInlineClient({ permission: "read" })

    await captureReviewFeedback({
      env,
      client,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      replyComment: {
        id: 103,
        body: "Going forward, prefer service-layer database access in controllers.",
        in_reply_to_id: 50,
        path: "src/lib/foo.ts",
        authorLogin: "mallory",
      },
      config: makeConfig(),
      repoId: REPO_ID,
    })

    expect(client.restGet).toHaveBeenCalledWith(`/repos/${OWNER}/${REPO}/collaborators/mallory/permission`)
    expect(extractLearningMock).not.toHaveBeenCalled()
    expect(readLearnings(store)).toEqual([])
    expect(client.replyToReviewComment).not.toHaveBeenCalled()
  })

  it("leaves conversational learning inert when learnings mode is off", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "off")
    const client = makeInlineClient({})

    await captureReviewFeedback({
      env,
      client,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      replyComment: {
        id: 104,
        body: "Going forward, prefer service-layer database access in controllers.",
        in_reply_to_id: 50,
        path: "src/lib/foo.ts",
        authorLogin: "alice",
      },
      config: makeConfig(),
      repoId: REPO_ID,
    })

    expect(client.restGet).not.toHaveBeenCalled()
    expect(extractLearningMock).not.toHaveBeenCalled()
    expect(readLearnings(store)).toEqual([])
    expect(client.replyToReviewComment).not.toHaveBeenCalled()
  })

  it("telemeters shadow extraction without writing or posting", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "shadow")
    const client = makeInlineClient({})

    await captureReviewFeedback({
      env,
      client,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      replyComment: {
        id: 105,
        body: "Going forward, prefer service-layer database access in controllers.",
        in_reply_to_id: 50,
        path: "src/lib/foo.ts",
        authorLogin: "alice",
      },
      config: makeConfig(),
      repoId: REPO_ID,
    })

    expect(extractLearningMock).toHaveBeenCalledOnce()
    expect(readLearnings(store)).toEqual([])
    expect(client.replyToReviewComment).not.toHaveBeenCalled()
    expect(store.has("learning-capture-seen:inline-reply:105")).toBe(false)
    const logs = consoleLogSpy.mock.calls.map((call) => String(call[0])).join("\n")
    expect(logs).toContain("learning-extract-shadow")
    expect(logs).toContain(RULE)
  })

  it("captures a verified top-level teachable reply and posts confirmation as an issue comment", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeTopLevelClient({ confirmReplyId: 8_101 })

    await captureTopLevelReviewFeedback({
      env,
      client,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      comment: {
        id: 200,
        body: `${VALID_MARKER}\n\nGoing forward, prefer service-layer database access in controllers.`,
        authorLogin: "alice",
      },
      config: makeConfig(),
      repoId: REPO_ID,
    })

    expect(extractLearningMock).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        surface: "top-level",
        replyText: `${VALID_MARKER}\n\nGoing forward, prefer service-layer database access in controllers.`,
        findingContext: expect.stringContaining(VALID_MARKER),
        changedPaths: ["src/lib/foo.ts"],
      }),
    )
    expect(readLearnings(store)[0]).toMatchObject({
      rule: RULE,
      authorLogin: "alice",
      source: { kind: "top-level", commentId: 200 },
    })
    expect(client.createIssueComment).toHaveBeenCalledWith(OWNER, REPO, PR, renderConfirmReply(RULE))
    const learningId = JSON.parse(store.get(`learnings:repo:${REPO_ID}`)!).entries[0].id
    expect(JSON.parse(store.get("learning-confirmation:8101") ?? "{}")).toEqual({
      scope: "repo",
      subjectId: String(REPO_ID),
      learningId,
    })
  })
})
