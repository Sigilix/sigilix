import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { mockChat, mockRetrieveChunks, mockGetCommentWithIssue, mockCreateComment } = vi.hoisted(() => ({
  mockChat: vi.fn(),
  mockRetrieveChunks: vi.fn(),
  mockGetCommentWithIssue: vi.fn(),
  mockCreateComment: vi.fn(),
}))

vi.mock("@/src/shared/adapters/model/ollama-chat", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/model/ollama-chat")>(
    "@/src/shared/adapters/model/ollama-chat",
  )
  return {
    ...actual,
    chat: (args: unknown) => mockChat(args),
  }
})

vi.mock("@/src/lib/retrieval", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/retrieval")>("@/src/lib/retrieval")
  return {
    ...actual,
    retrieveChunks: mockRetrieveChunks,
  }
})

vi.mock("@/src/lib/linear", () => ({
  buildLinearAuth: vi.fn(async () => ({ apiKey: "linear-key" })),
  LinearClient: vi.fn().mockImplementation(() => ({
    getCommentWithIssue: mockGetCommentWithIssue,
    createComment: mockCreateComment,
  })),
  // SIG-144 slice 4: handleMention now builds its client via buildLinearClient.
  buildLinearClient: vi.fn(async () => ({
    getCommentWithIssue: mockGetCommentWithIssue,
    createComment: mockCreateComment,
  })),
}))

import { handleMention } from "@/src/lib/mention-reply"
import { buildLinearClient } from "@/src/lib/linear"
import type { Env } from "@/src/shared/types/env"

const mockBuildLinearClient = vi.mocked(buildLinearClient)

function manifest(owner: string, repo: string): string {
  return JSON.stringify({
    v: 1,
    owner,
    repo,
    headSha: "abc123",
    runId: "run-1",
    fileCount: 1,
    chunkCount: 1,
    shardCount: 1,
    indexedAt: "2026-06-14T00:00:00.000Z",
    modelId: "m",
    embeddingDim: 768,
    chunkerVersion: 1,
    windowLines: 30,
    overlapLines: 10,
  })
}

function makeEnv(): { env: Env; puts: Array<{ key: string; value: string }> } {
  const store = new Map<string, string>([["repo-index-manifest:sigilix/sigilix", manifest("Sigilix", "sigilix")]])
  const puts: Array<{ key: string; value: string }> = []
  const env = {
    LINEAR_API_KEY: "linear-key",
    OLLAMA_API_KEY: "ollama-key",
    OLLAMA_CHAT_ENABLE: "on",
    OPENCLAW_AGENTIC_LINEAR_MODE: "on",
    OPENCLAW_TEAM_GITHUB_REPO_MAP: JSON.stringify({
      SIG: { owner: "Sigilix", repo: "sigilix" },
    }),
    OPENCLAW_CODE_INDEX: {} as VectorizeIndex,
    OPENCLAW_STATE: {
      get: async (key: string): Promise<string | null> => store.get(key) ?? null,
      put: async (key: string, value: string): Promise<void> => {
        store.set(key, value)
        puts.push({ key, value })
      },
      list: async (opts: { prefix?: string }) => {
        const prefix = opts.prefix ?? ""
        return {
          keys: [...store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
          list_complete: true,
        }
      },
    } as unknown as KVNamespace,
  } as Env
  return { env, puts }
}

beforeEach(() => {
  mockChat.mockReset()
  mockRetrieveChunks.mockReset()
  mockGetCommentWithIssue.mockReset()
  mockCreateComment.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("handleMention — SIG-207 retrieval proof", () => {
  it("advertises indexed repo choices, exposes retrieve_codebase, hard-gates bad repos, and records usage", async () => {
    mockGetCommentWithIssue.mockResolvedValue({
      id: "comment-1",
      body: "@sigilix where is handleMention implemented?",
      user: { name: "daniel", displayName: "daniel" },
      parent: null,
      issue: {
        id: "issue-1",
        identifier: "SIG-207",
        title: "Linear mentions must prove code retrieval",
        description: "Make Linear mention retrieval observable.",
        team: { id: "team-1", key: "SIG" },
        comments: { nodes: [] },
      },
    })
    mockCreateComment.mockResolvedValue("reply-1")
    mockRetrieveChunks.mockResolvedValue([
      {
        path: "src/lib/mention-reply.ts",
        lineStart: 240,
        lineEnd: 260,
        score: 0.92,
        content: "export async function handleMention() {}",
      },
    ])
    mockChat
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "bad-repo",
              function: {
                name: "retrieve_codebase",
                arguments: JSON.stringify({ query: "handleMention", repo: "evil/private" }),
              },
            },
          ],
        },
        hasToolCalls: true,
      })
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "good-repo",
              function: {
                name: "retrieve_codebase",
                arguments: JSON.stringify({ query: "handleMention", repo: "sigilix/sigilix" }),
              },
            },
          ],
        },
        hasToolCalls: true,
      })
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: JSON.stringify({
            answer: "The handler is in src/lib/mention-reply.ts.",
            confidence: 5,
            abstain: false,
          }),
        },
        hasToolCalls: false,
      })

    const { env, puts } = makeEnv()
    await handleMention("comment-1", env)

    const firstChat = mockChat.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>
      tools: Array<{ function: { name: string } }>
    }
    expect(firstChat.messages[1]!.content).toContain("[INDEXED REPOS] 'sigilix/sigilix'")
    expect(firstChat.messages[1]!.content).toContain("[REPO STATUS] mapped_indexed")
    expect(firstChat.tools.map((tool) => tool.function.name)).toEqual(["retrieve_codebase"])
    expect(mockRetrieveChunks).toHaveBeenCalledTimes(2)
    expect(mockRetrieveChunks).not.toHaveBeenCalledWith(expect.objectContaining({ teamKey: "evil/private" }))
    expect(mockRetrieveChunks).toHaveBeenLastCalledWith(expect.objectContaining({ teamKey: "sigilix/sigilix" }))

    const telemetryPut = puts.find((put) => put.key.startsWith("agent-loop-telemetry:"))
    expect(telemetryPut).toBeDefined()
    const telemetry = JSON.parse(telemetryPut?.value ?? "{}") as {
      linearMentionRetrieval?: {
        availableRepos: string[]
        mappedRepo: string
        repoStatus: string
        calledRetrieveCodebase: boolean
        retrieveCodebaseCallCount: number
        retrievalNamespace: string
        chunkCount: number
        toolRetrievals: Array<{ ok: boolean; repo?: string; count?: number; error?: string }>
      }
    }
    expect(telemetry.linearMentionRetrieval).toMatchObject({
      availableRepos: ["sigilix/sigilix"],
      mappedRepo: "sigilix/sigilix",
      repoStatus: "mapped_indexed",
      calledRetrieveCodebase: true,
      retrieveCodebaseCallCount: 2,
      retrievalNamespace: "sigilix/sigilix",
      chunkCount: 1,
    })
    expect(telemetry.linearMentionRetrieval?.toolRetrievals[0]).toMatchObject({
      ok: false,
      error: "repo 'evil/private' is not in the indexed namespace set",
    })
    expect(mockCreateComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("src/lib/mention-reply.ts"),
      undefined,
    )
  })
})

// ── SIG-144 slice 4 spot-check: the REAL caller (handleMention) under
// unified mode, through the REAL tenant-scoped buildLinearAuth/buildLinearClient
// — not the FakeLinearClient the suite above uses. Proves the production wiring.
describe("handleMention — tenant-scoped unified Linear auth", () => {
  it("routes handleMention through the exact organization shard and never the human LINEAR_API_KEY", async () => {
    const { env } = makeEnv()
    env.OPENCLAW_LINEAR_UNIFIED = "on"
    env.LINEAR_API_KEY = "human-key-must-never-be-used"
    const idFromName = vi.fn((n: string) => ({ toString: () => n }))
    env.LINEAR_TOKEN_BROKER = {
      idFromName,
      get: () => ({
        getValidTenantToken: async () => ({ ok: true, accessToken: "agent-token-xyz" }),
        forceRefreshTenant: async () => ({ ok: false, reason: "not-installed" }),
      }),
    } as unknown as Env["LINEAR_TOKEN_BROKER"]

    const actual = await vi.importActual<typeof import("@/src/lib/linear")>("@/src/lib/linear")
    mockBuildLinearClient.mockImplementationOnce(actual.buildLinearClient)

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { comment: null } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    // comment:null short-circuits handleMention right after
    // getCommentWithIssue (before retrieval / model call / reply post) — the
    // minimal real path that still proves buildLinearAuth picked the broker
    // token.
    await handleMention("comment-missing", env, {
      tenant: { organizationId: "org-1", installationId: 42, teamId: "team-1" },
    })

    expect(idFromName).toHaveBeenCalledWith("linear-org:v1:org-1")
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const authHeader = (init.headers as Record<string, string>).authorization
    expect(authHeader).toBe("Bearer agent-token-xyz")
    expect(authHeader).not.toContain("human-key-must-never-be-used")
  })
})
