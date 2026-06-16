import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  generateMock,
  retrieveChunksMock,
  getInstallationTokenMock,
  listIssueCommentsMock,
  listPullRequestReviewCommentsMock,
  addReactionToIssueCommentMock,
  addReactionToReviewCommentMock,
  getPullRequestMock,
  getPullRequestDiffMock,
  getFileContentMock,
  createIssueCommentMock,
  replyToReviewCommentMock,
  restGetMock,
  extractLearningMock,
} = vi.hoisted(() => ({
  generateMock: vi.fn(),
  retrieveChunksMock: vi.fn(),
  getInstallationTokenMock: vi.fn(async () => "fake-token"),
  listIssueCommentsMock: vi.fn(),
  listPullRequestReviewCommentsMock: vi.fn(),
  addReactionToIssueCommentMock: vi.fn(),
  addReactionToReviewCommentMock: vi.fn(),
  getPullRequestMock: vi.fn(),
  getPullRequestDiffMock: vi.fn(),
  getFileContentMock: vi.fn(),
  createIssueCommentMock: vi.fn(),
  replyToReviewCommentMock: vi.fn(),
  restGetMock: vi.fn(),
  extractLearningMock: vi.fn(),
}))

vi.mock("@/src/shared/adapters/model", async (importActual) => {
  const actual = await importActual<typeof import("@/src/shared/adapters/model")>()
  return { ...actual, generate: generateMock }
})

vi.mock("@/src/lib/retrieval", async (importActual) => {
  const actual = await importActual<typeof import("@/src/lib/retrieval")>()
  return { ...actual, retrieveChunks: retrieveChunksMock }
})

vi.mock("@/src/shared/adapters/github/github-app", () => ({
  getInstallationToken: getInstallationTokenMock,
}))

vi.mock("@/src/shared/adapters/github", async (importActual) => {
  const actual = await importActual<typeof import("@/src/shared/adapters/github")>()
  class FakeGitHubClient {
    listIssueComments = listIssueCommentsMock
    listPullRequestReviewComments = listPullRequestReviewCommentsMock
    addReactionToIssueComment = addReactionToIssueCommentMock
    addReactionToReviewComment = addReactionToReviewCommentMock
    getPullRequest = getPullRequestMock
    getPullRequestDiff = getPullRequestDiffMock
    getFileContent = getFileContentMock
    createIssueComment = createIssueCommentMock
    replyToReviewComment = replyToReviewCommentMock
    restGet = restGetMock
  }
  return { ...actual, GitHubClient: FakeGitHubClient }
})

vi.mock("@/src/features/learnings", async (importActual) => {
  const actual = await importActual<typeof import("@/src/features/learnings")>()
  return { ...actual, extractLearning: extractLearningMock }
})

import { queueGithubMention } from "@/src/index"
import { handleGithubMention } from "@/src/lib/github-mention"
import { renderConfirmReply, renderForgetConfirm } from "@/src/features/learnings"
import type { Env } from "@/src/shared/types/env"

const OWNER = "Sigilix"
const REPO = "sigilix"
const PR = 104
const REPO_ID = 123_456

interface TestEnv {
  env: Env
  store: Map<string, string>
  puts: Array<{ key: string; value: string }>
  queueSent: unknown[]
}

function makeEnv(mode: "off" | "shadow" | "on" = "shadow"): TestEnv {
  const store = new Map<string, string>()
  const puts: Array<{ key: string; value: string }> = []
  const queueSent: unknown[] = []
  const env = {
    OPENCLAW_LEARNINGS_MODE: mode,
    OPENCLAW_STATE: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value)
        puts.push({ key, value })
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key)
      }),
    } as unknown as KVNamespace,
    OPENCLAW_JOBS: {
      send: vi.fn(async (message: unknown) => {
        queueSent.push(message)
      }),
    } as unknown as Queue<unknown>,
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "private-key",
    OLLAMA_API_KEY: "ollama-key",
  } as unknown as Env
  return { env, store, puts, queueSent }
}

function reviewComment(overrides: { id: number; body: string; login?: string; inReplyToId?: number }): {
  id: number
  body: string
  user: { login: string }
  author_association: string
  path: string
  line: number
  original_line: number
  in_reply_to_id?: number
} {
  return {
    id: overrides.id,
    body: overrides.body,
    user: { login: overrides.login ?? "alice" },
    author_association: "CONTRIBUTOR",
    path: "src/service.ts",
    line: 12,
    original_line: 12,
    ...(overrides.inReplyToId !== undefined ? { in_reply_to_id: overrides.inReplyToId } : {}),
  }
}

async function runReviewMention(args: {
  env: Env
  commentId: number
  threadRootId?: number
  repoId?: number
}): Promise<void> {
  await handleGithubMention({
    owner: OWNER,
    repo: REPO,
    prNumber: PR,
    installationId: 99,
    surface: "review-comment",
    commentId: args.commentId,
    ...(args.threadRootId !== undefined ? { threadRootId: args.threadRootId } : {}),
    ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
    env: args.env,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  getInstallationTokenMock.mockResolvedValue("fake-token")
  listIssueCommentsMock.mockResolvedValue([])
  addReactionToIssueCommentMock.mockResolvedValue(undefined)
  addReactionToReviewCommentMock.mockResolvedValue(undefined)
  getPullRequestMock.mockResolvedValue({
    number: PR,
    title: "Learnings",
    body: "",
    user: { login: "author" },
    head: { sha: "headsha", ref: "feature" },
    base: { sha: "basesha", ref: "main" },
  })
  getPullRequestDiffMock.mockResolvedValue("diff --git a/src/service.ts b/src/service.ts\n")
  getFileContentMock.mockResolvedValue("export const service = true\n")
  generateMock.mockResolvedValue({
    text: JSON.stringify({ answer: "regular Q&A fallback", confidence: 4, abstain: false }),
  })
  extractLearningMock.mockResolvedValue(null)
  retrieveChunksMock.mockResolvedValue([])
  replyToReviewCommentMock.mockResolvedValue({ id: 9_001 })
  createIssueCommentMock.mockResolvedValue({ id: 8_001 })
  restGetMock.mockResolvedValue({ permission: "write" })
})

describe("handleGithubMention learnings commands", () => {
  it("remembers a write-access actor's command through the real mention handler", async () => {
    const { env, store } = makeEnv("shadow")
    const rule = "Always wrap database writes in service-layer helpers."
    listPullRequestReviewCommentsMock.mockResolvedValue([reviewComment({ id: 500, body: `@sigilix remember ${rule}` })])

    await runReviewMention({ env, commentId: 500, repoId: REPO_ID })

    const stored = JSON.parse(store.get(`learnings:repo:${REPO_ID}`) ?? "{}") as {
      entries?: Array<{ id: string; rule: string; authorLogin?: string; source?: { commentId?: number } }>
    }
    expect(stored.entries).toHaveLength(1)
    expect(stored.entries?.[0]).toMatchObject({
      rule,
      authorLogin: "alice",
      source: { commentId: 500 },
    })
    expect(replyToReviewCommentMock).toHaveBeenCalledWith(OWNER, REPO, PR, 500, renderConfirmReply(rule))
    const learningId = stored.entries?.[0]?.id
    expect(JSON.parse(store.get("learning-confirmation:9001") ?? "{}")).toEqual({
      scope: "repo",
      subjectId: String(REPO_ID),
      learningId,
    })
    expect(store.has("learning-capture-seen:github-mention:500")).toBe(true)
    expect(store.has("gh-mention:500")).toBe(false)
    expect(generateMock).not.toHaveBeenCalled()
  })

  it("skips a learnings command with no repoId (legacy in-flight message) — no write, no reply, no crash", async () => {
    const { env, store } = makeEnv("on")
    listPullRequestReviewCommentsMock.mockResolvedValue([
      reviewComment({ id: 510, body: "@sigilix remember always validate inputs" }),
    ])

    // repoId omitted (an old queued message): the command is repo-scoped, so it
    // must skip (log + return) — NOT crash, NOT write, NOT fall through to Q&A,
    // and NOT even reach the authz call (repoId is checked before the handler).
    await runReviewMention({ env, commentId: 510 })

    expect([...store.keys()].some((k) => k.startsWith("learnings:repo:"))).toBe(false)
    expect(replyToReviewCommentMock).not.toHaveBeenCalled()
    expect(restGetMock).not.toHaveBeenCalled()
    expect(generateMock).not.toHaveBeenCalled()
  })

  it("forgets by resolving the confirmation reply parent without exposing a learning id", async () => {
    const { env, store } = makeEnv("shadow")
    const rule = "Always wrap database writes in service-layer helpers."
    replyToReviewCommentMock.mockResolvedValueOnce({ id: 9_001 }).mockResolvedValueOnce({ id: 9_002 })
    listPullRequestReviewCommentsMock.mockResolvedValue([
      reviewComment({ id: 500, body: `@sigilix remember ${rule}` }),
      reviewComment({ id: 501, body: "@sigilix forget", inReplyToId: 9_001 }),
    ])

    await runReviewMention({ env, commentId: 500, repoId: REPO_ID })
    await runReviewMention({ env, commentId: 501, threadRootId: 9_001, repoId: REPO_ID })

    const stored = JSON.parse(store.get(`learnings:repo:${REPO_ID}`) ?? "{}") as { entries?: unknown[] }
    expect(stored.entries).toEqual([])
    expect(replyToReviewCommentMock).toHaveBeenLastCalledWith(OWNER, REPO, PR, 9_001, renderForgetConfirm())
    const forgetBody = replyToReviewCommentMock.mock.calls.at(-1)?.[4] as string
    expect(forgetBody).not.toMatch(/[0-9a-f]{16}/)
    expect(generateMock).not.toHaveBeenCalled()
  })

  it("rejects a read-only actor without writing learnings or falling through to Q&A", async () => {
    const { env, store } = makeEnv("shadow")
    restGetMock.mockResolvedValue({ permission: "read" })
    listPullRequestReviewCommentsMock.mockResolvedValue([
      reviewComment({ id: 502, body: "@sigilix remember Prefer retries around flaky APIs.", login: "bob" }),
    ])

    await runReviewMention({ env, commentId: 502, repoId: REPO_ID })

    expect(restGetMock).toHaveBeenCalledWith(`/repos/${OWNER}/${REPO}/collaborators/bob/permission`)
    expect([...store.keys()]).toEqual([])
    expect(replyToReviewCommentMock).not.toHaveBeenCalled()
    expect(generateMock).not.toHaveBeenCalled()
  })

  it("leaves commands inert when learnings mode is off", async () => {
    const { env, store } = makeEnv("off")
    listPullRequestReviewCommentsMock.mockResolvedValue([
      reviewComment({ id: 503, body: "@sigilix remember Prefer retries around flaky APIs." }),
    ])

    await runReviewMention({ env, commentId: 503, repoId: REPO_ID })

    expect([...store.keys()]).toEqual([])
    expect(restGetMock).not.toHaveBeenCalled()
    expect(replyToReviewCommentMock).not.toHaveBeenCalled()
    expect(generateMock).not.toHaveBeenCalled()
  })

  it("captures explicit remember intent from normal Q&A after posting the answer", async () => {
    const { env, store } = makeEnv("on")
    const rule = "Prefer service-layer database access in controllers."
    extractLearningMock.mockResolvedValueOnce({
      rule,
      polarity: "context",
      category: null,
      pathGlob: null,
    })
    replyToReviewCommentMock.mockResolvedValueOnce({ id: 9_010 }).mockResolvedValueOnce({ id: 9_011 })
    listPullRequestReviewCommentsMock.mockResolvedValue([
      reviewComment({
        id: 506,
        body: "@sigilix can you explain this? Please remember that controllers use service-layer database access.",
      }),
    ])

    await runReviewMention({ env, commentId: 506, repoId: REPO_ID })

    expect(generateMock).toHaveBeenCalledOnce()
    expect(replyToReviewCommentMock).toHaveBeenNthCalledWith(
      1,
      OWNER,
      REPO,
      PR,
      506,
      expect.stringContaining("regular Q&A fallback"),
    )
    expect(extractLearningMock).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        surface: "qa",
        replyText: "can you explain this? Please remember that controllers use service-layer database access.",
      }),
    )
    const stored = JSON.parse(store.get(`learnings:repo:${REPO_ID}`) ?? "{}") as {
      entries?: Array<{ id: string; rule: string; source?: { kind?: string; commentId?: number } }>
    }
    expect(stored.entries?.[0]).toMatchObject({
      rule,
      source: { kind: "qa", commentId: 506 },
    })
    expect(replyToReviewCommentMock).toHaveBeenNthCalledWith(2, OWNER, REPO, PR, 506, renderConfirmReply(rule))
    expect(JSON.parse(store.get("learning-confirmation:9011") ?? "{}")).toEqual({
      scope: "repo",
      subjectId: String(REPO_ID),
      learningId: stored.entries?.[0]?.id,
    })
    expect(store.get("gh-mention:506")).toBe("9010")
  })

  it("lists learned rule text without public ids", async () => {
    const { env, store } = makeEnv("on")
    store.set(
      `learnings:repo:${REPO_ID}`,
      JSON.stringify({
        schemaVersion: 1,
        scope: "repo",
        subjectId: String(REPO_ID),
        entries: [
          {
            id: "0123456789abcdef",
            rule: "Prefer service-layer database access.",
            polarity: "context",
            category: null,
            pathGlob: null,
            scope: "repo",
            subjectId: String(REPO_ID),
            source: { kind: "command", prNumber: PR, commentId: 500 },
            createdTs: "2026-06-15T00:00:00.000Z",
            appliedCount: 0,
          },
        ],
      }),
    )
    listPullRequestReviewCommentsMock.mockResolvedValue([reviewComment({ id: 504, body: "@sigilix list" })])

    await runReviewMention({ env, commentId: 504, repoId: REPO_ID })

    const body = replyToReviewCommentMock.mock.calls[0]?.[4] as string
    expect(body).toContain("Prefer service-layer database access.")
    expect(body).not.toContain("0123456789abcdef")
    expect(generateMock).not.toHaveBeenCalled()
  })
})

describe("queueGithubMention learnings repo id plumbing", () => {
  it("threads repository.id onto github-mention jobs so command storage is repo-keyed", async () => {
    const { env, queueSent } = makeEnv("shadow")
    const response = await queueGithubMention({
      env,
      ctx: {
        waitUntil: () => undefined,
        passThroughOnException: () => undefined,
      } as unknown as ExecutionContext,
      payload: {
        action: "created",
        installation: { id: 99 },
        repository: { id: REPO_ID, name: REPO, owner: { login: OWNER } },
        issue: { number: PR, pull_request: { url: "https://api.github.com/repos/Sigilix/sigilix/pulls/104" } },
        comment: {
          id: 505,
          body: "@sigilix remember Prefer service-layer database access.",
          user: { login: "alice" },
          author_association: "MEMBER",
        },
      },
      owner: OWNER,
      repo: REPO,
      installationId: 99,
      surface: "issue",
      prNumber: PR,
    })

    expect(response.status).toBe(202)
    expect(queueSent).toHaveLength(1)
    expect(queueSent[0]).toMatchObject({
      type: "github-mention",
      repoId: REPO_ID,
    })
  })
})
