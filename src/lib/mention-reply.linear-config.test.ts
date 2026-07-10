import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  runAgentLoop: vi.fn(),
  retrieveChunks: vi.fn(),
  fetchPullRequestContext: vi.fn(),
  getCommentWithIssue: vi.fn(),
  createComment: vi.fn(),
  getLinearConfig: vi.fn(),
  resolveLinearTeamBinding: vi.fn(),
  getInstallationToken: vi.fn(),
}))

vi.mock("@/src/shared/adapters/model", () => ({ generate: mocks.generate }))
vi.mock("@/src/lib/agent-loop", () => ({ runAgentLoop: mocks.runAgentLoop }))
vi.mock("@/src/lib/retrieval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/retrieval")>()
  return { ...actual, retrieveChunks: mocks.retrieveChunks }
})
vi.mock("@/src/lib/github-pr-context", () => ({ fetchPullRequestContext: mocks.fetchPullRequestContext }))
vi.mock("@/src/shared/adapters/github/github-app", () => ({ getInstallationToken: mocks.getInstallationToken }))
vi.mock("@/src/lib/linear", () => ({
  buildLinearClient: vi.fn(async () => ({
    getCommentWithIssue: mocks.getCommentWithIssue,
    createComment: mocks.createComment,
  })),
}))
vi.mock("@/src/features/linear-integration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/features/linear-integration")>()
  return {
    ...actual,
    getLinearConfig: mocks.getLinearConfig,
    resolveLinearTeamBinding: mocks.resolveLinearTeamBinding,
  }
})

import { handleMention } from "@/src/lib/mention-reply"
import type { LinearConfig } from "@/src/features/linear-integration"
import type { Env } from "@/src/shared/types/env"

const TENANT = { organizationId: "org-a", installationId: 11, teamId: "team-a" }
const BASE_CONFIG: LinearConfig = {
  revision: 1,
  contextMode: "auto",
  scope: { mode: "explicit", teamIds: ["team-a"] },
  prValidation: false,
  createIssue: "manual",
  planning: true,
  writeback: { comments: true, status: false, labels: true },
}

function manifest(): string {
  return JSON.stringify({
    v: 1,
    owner: "acme",
    repo: "api",
    headSha: "abc123",
    runId: "run-1",
    fileCount: 1,
    chunkCount: 1,
    shardCount: 1,
    indexedAt: "2026-07-10T00:00:00.000Z",
    modelId: "m",
    embeddingDim: 768,
    chunkerVersion: 1,
    windowLines: 30,
    overlapLines: 10,
  })
}

function makeEnv(): { env: Env; get: ReturnType<typeof vi.fn> } {
  const store = new Map([["repo-index-manifest:acme/api", manifest()]])
  const get = vi.fn(async (key: string) => store.get(key) ?? null)
  return {
    env: {
      OLLAMA_API_KEY: "ollama-key",
      OLLAMA_CHAT_ENABLE: "on",
      OPENCLAW_AGENTIC_LINEAR_MODE: "on",
      OPENCLAW_STATE: {
        get,
        put: vi.fn(async () => undefined),
        list: vi.fn(async () => ({ keys: [], list_complete: true })),
      } as unknown as KVNamespace,
      OPENCLAW_CODE_INDEX: {} as VectorizeIndex,
    } as Env,
    get,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getCommentWithIssue.mockResolvedValue({
    id: "comment-a",
    body: "@sigilix inspect https://github.com/acme/api/pull/12",
    user: { name: "daniel", displayName: "daniel" },
    parent: null,
    issue: {
      id: "issue-a",
      identifier: "SIG-242",
      title: "Tenant settings",
      description: "Make each control real.",
      team: { id: "team-a", key: "SIG" },
      comments: { nodes: [] },
    },
  })
  mocks.createComment.mockResolvedValue("reply-a")
  mocks.resolveLinearTeamBinding.mockResolvedValue({
    organizationId: "org-a",
    installationId: 11,
    teamId: "team-a",
    accessState: "allowed",
    githubRepoId: 101,
    githubRepoFullName: "acme/api",
  })
  mocks.retrieveChunks.mockResolvedValue([])
  mocks.fetchPullRequestContext.mockResolvedValue({ ok: false, reason: "not_found" })
  mocks.generate.mockResolvedValue({
    text: JSON.stringify({ answer: "Handled from bounded context.", confidence: 5, abstain: false }),
    usage: { promptTokens: 1, completionTokens: 1 },
  })
  mocks.runAgentLoop.mockResolvedValue({
    ok: true,
    answer: { answer: "Handled with repo tools.", confidence: 5, abstain: false },
    stats: { toolTurns: 1, totalMs: 1, toolCallCount: 1 },
  })
})

describe("handleMention tenant Linear settings", () => {
  it("comments off short-circuits before retrieval, model work, and reply writeback", async () => {
    mocks.getLinearConfig.mockResolvedValue({
      ...BASE_CONFIG,
      writeback: { ...BASE_CONFIG.writeback, comments: false },
    })
    const { env } = makeEnv()

    await handleMention("comment-a", env, { tenant: TENANT })

    expect(mocks.retrieveChunks).not.toHaveBeenCalled()
    expect(mocks.fetchPullRequestContext).not.toHaveBeenCalled()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.runAgentLoop).not.toHaveBeenCalled()
    expect(mocks.createComment).not.toHaveBeenCalled()
  })

  it("context off performs no manifest, retrieval, linked-PR, tool, or citation IO", async () => {
    mocks.getLinearConfig.mockResolvedValue({ ...BASE_CONFIG, contextMode: "disabled" })
    mocks.generate.mockResolvedValueOnce({
      text: JSON.stringify({ answer: "The path is `src/auth.ts:42`.", confidence: 5, abstain: false }),
      usage: { promptTokens: 1, completionTokens: 1 },
    })
    const { env, get } = makeEnv()

    await handleMention("comment-a", env, { tenant: TENANT })

    expect(get).not.toHaveBeenCalledWith("repo-index-manifest:acme/api")
    expect(mocks.retrieveChunks).not.toHaveBeenCalled()
    expect(mocks.fetchPullRequestContext).not.toHaveBeenCalled()
    expect(mocks.runAgentLoop).not.toHaveBeenCalled()
    expect(mocks.getInstallationToken).not.toHaveBeenCalled()
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(mocks.createComment).toHaveBeenCalledOnce()
  })

  it("auto uses bounded preselected context without autonomous repo tools", async () => {
    mocks.getLinearConfig.mockResolvedValue(BASE_CONFIG)
    const { env } = makeEnv()

    await handleMention("comment-a", env, { tenant: TENANT })

    expect(mocks.retrieveChunks).toHaveBeenCalledOnce()
    expect(mocks.fetchPullRequestContext).toHaveBeenCalledOnce()
    expect(mocks.runAgentLoop).not.toHaveBeenCalled()
    expect(mocks.generate).toHaveBeenCalledOnce()
  })

  it("enabled adds the exact-bound repo tool to the agent loop", async () => {
    mocks.getLinearConfig.mockResolvedValue({ ...BASE_CONFIG, contextMode: "enabled" })
    const { env } = makeEnv()

    await handleMention("comment-a", env, { tenant: TENANT })

    expect(mocks.runAgentLoop).toHaveBeenCalledOnce()
    const args = mocks.runAgentLoop.mock.calls[0]?.[0] as { tools: Array<{ name: string }> }
    expect(args.tools.map((tool) => tool.name)).toContain("retrieve_codebase")
    expect(mocks.generate).not.toHaveBeenCalled()
  })
})
