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

const { lookupRepoByFullNameMock } = vi.hoisted(() => ({
  lookupRepoByFullNameMock: vi.fn(async () => null as { repoId: number; installationId: number } | null),
}))
vi.mock("@/src/features/tenancy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/features/tenancy")>()
  return { ...actual, lookupRepoByFullName: lookupRepoByFullNameMock }
})

import { handleMention } from "@/src/lib/mention-reply"
import { appendLearning } from "@/src/features/learnings/adapters/store"
import type { LearningEntry } from "@/src/features/learnings/domain/types"
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
  lookupRepoByFullNameMock.mockReset()
  lookupRepoByFullNameMock.mockResolvedValue(null)
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

  it("posts a grounded reply when the tool-using model needs a structured final-answer repair", async () => {
    mockGetCommentWithIssue.mockResolvedValue({
      id: "comment-repair",
      body: "@sigilix where is parseSlackCodeCitationMode defined?",
      user: { name: "daniel", displayName: "daniel" },
      parent: null,
      issue: {
        id: "issue-repair",
        identifier: "SIG-REPAIR",
        title: "Find the Slack citation mode parser",
        description: "Exercise the production agent loop after retrieval.",
        team: { id: "team-1", key: "SIG" },
        comments: { nodes: [] },
      },
    })
    mockCreateComment.mockResolvedValue("reply-repair")
    mockRetrieveChunks.mockResolvedValue([
      {
        path: "src/lib/slack/slack-code-citations.ts",
        lineStart: 184,
        lineEnd: 186,
        score: 0.99,
        content: 'return value === "shadow" || value === "on" ? value : "off"',
      },
    ])
    const productionProse = "The parser is in src/lib/slack/slack-code-citations.ts and returns off, shadow, or on."
    mockChat
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "retrieve-parser",
              function: {
                name: "retrieve_codebase",
                arguments: JSON.stringify({ query: "parseSlackCodeCitationMode", repo: "sigilix/sigilix" }),
              },
            },
          ],
        },
        hasToolCalls: true,
      })
      .mockResolvedValueOnce({
        message: { role: "assistant", content: productionProse },
        hasToolCalls: false,
      })
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: JSON.stringify({ answer: productionProse, confidence: 5, abstain: false }),
        },
        hasToolCalls: false,
      })

    const { env, puts } = makeEnv()
    await handleMention("comment-repair", env)

    expect(mockRetrieveChunks).toHaveBeenCalledWith(
      expect.objectContaining({ teamKey: "sigilix/sigilix", text: "parseSlackCodeCitationMode" }),
    )
    expect(mockChat).toHaveBeenCalledTimes(3)
    expect(mockChat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tools: [],
        format: expect.objectContaining({ type: "object" }),
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "assistant", content: productionProse }),
          expect.objectContaining({ role: "user", content: expect.stringContaining("same answer") }),
        ]),
      }),
    )
    expect(mockCreateComment).toHaveBeenCalledWith("issue-repair", expect.stringContaining(productionProse), undefined)
    const telemetryPut = puts.find((put) => put.key.startsWith("agent-loop-telemetry:"))
    const telemetry = JSON.parse(telemetryPut?.value ?? "{}") as {
      fallback?: string
      finalAnswer?: unknown
      finalAnswerRepairAttempts?: number
    }
    expect(telemetry.fallback).toBeUndefined()
    expect(telemetry.finalAnswer).toEqual({ answer: productionProse, confidence: 5, abstain: false })
    expect(telemetry.finalAnswerRepairAttempts).toBe(1)
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

  it("fails closed when a broker-bound legacy job has no tenant or explicit dogfood scope", async () => {
    const { env } = makeEnv()
    const idFromName = vi.fn()
    env.OPENCLAW_LINEAR_UNIFIED = "off"
    env.LINEAR_TOKEN_BROKER = { idFromName } as unknown as Env["LINEAR_TOKEN_BROKER"]
    let humanKeyRead = false
    Object.defineProperty(env, "LINEAR_API_KEY", {
      configurable: true,
      get() {
        humanKeyRead = true
        return "human-key-must-never-be-used"
      },
    })
    const actual = await vi.importActual<typeof import("@/src/lib/linear")>("@/src/lib/linear")
    mockBuildLinearClient.mockImplementationOnce(actual.buildLinearClient)

    await expect(handleMention("comment-missing-tenant", env)).rejects.toThrow(/explicit dogfood tenant token/)
    expect(humanKeyRead).toBe(false)
    expect(idFromName).not.toHaveBeenCalled()
  })
})

// ─── Surface memory apply (OPENCLAW_SURFACE_MEMORY_APPLY) ──────────────────────
//
// The Linear mention-reply answer must APPLY the org∪repo learnings: an org
// guardrail + a repo fact both land in the answer's system prompt, gated dark
// behind the flag. Runs the agentic path (systemPrompt = messages[0]).
describe("handleMention — surface memory apply (org∪repo learnings in the answer prompt)", () => {
  const TS_MS = Date.parse("2026-06-15T12:00:00.000Z")
  const INSTALL_ID = 555
  const REPO_ID = 900

  function memEntry(id: string, over: Partial<LearningEntry>): LearningEntry {
    return {
      id,
      rule: `rule-${id}`,
      polarity: "context",
      category: "style",
      pathGlob: null,
      scope: "repo",
      subjectId: String(REPO_ID),
      source: { kind: "chat" },
      createdTs: new Date(TS_MS).toISOString(),
      appliedCount: 0,
      ...over,
    }
  }

  const ORG_POLICY = memEntry("orgP", {
    rule: "ORG GUARDRAIL: always require a rollback plan.",
    scope: "org",
    subjectId: String(INSTALL_ID),
    type: "durable_preference",
    polarity: "require",
  })
  const REPO_FACT = memEntry("repoF", {
    rule: "REPO FACT: auth lives in src/auth/session.ts.",
    scope: "repo",
    subjectId: String(REPO_ID),
    type: "architectural_fact",
    polarity: "context",
  })

  function seedComment(): void {
    mockGetCommentWithIssue.mockResolvedValue({
      id: "comment-mem",
      body: "@sigilix where does auth live?",
      user: { name: "daniel", displayName: "daniel" },
      parent: null,
      issue: {
        id: "issue-mem",
        identifier: "SIG-900",
        title: "Auth question",
        description: "asking about auth",
        team: { id: "team-1", key: "SIG" },
        comments: { nodes: [] },
      },
    })
    mockCreateComment.mockResolvedValue("reply-mem")
    mockRetrieveChunks.mockResolvedValue([])
    // Single-turn: the model returns a final answer immediately (no tool calls).
    mockChat.mockResolvedValue({
      message: {
        role: "assistant",
        content: JSON.stringify({ answer: "Auth is in src/auth/session.ts.", confidence: 5, abstain: false }),
      },
      hasToolCalls: false,
    })
  }

  function systemPrompt(): string {
    const firstChat = mockChat.mock.calls[0]?.[0] as { messages: Array<{ role: string; content: string }> }
    return firstChat.messages[0]!.content
  }

  it("flag ON — org guardrail + repo fact appear in the answer system prompt, org labeled above", async () => {
    seedComment()
    lookupRepoByFullNameMock.mockResolvedValue({ repoId: REPO_ID, installationId: INSTALL_ID })
    const { env } = makeEnv()
    env.OPENCLAW_GITHUB_INSTALLATION_MAP = JSON.stringify({ "Sigilix/sigilix": INSTALL_ID })
    env.OPENCLAW_SURFACE_MEMORY_APPLY = "on"
    await appendLearning(env, "org", String(INSTALL_ID), ORG_POLICY, TS_MS)
    await appendLearning(env, "repo", String(REPO_ID), REPO_FACT, TS_MS)

    await handleMention("comment-mem", env)

    const sys = systemPrompt()
    expect(sys).toContain(ORG_POLICY.rule)
    expect(sys).toContain(REPO_FACT.rule)
    expect(sys).toContain("[org policy — must follow]")
    expect(sys.indexOf(ORG_POLICY.rule)).toBeLessThan(sys.indexOf(REPO_FACT.rule))
  })

  it("flag OFF (default) — NO memory is injected (true no-op) and no repo lookup happens", async () => {
    seedComment()
    lookupRepoByFullNameMock.mockResolvedValue({ repoId: REPO_ID, installationId: INSTALL_ID })
    const { env } = makeEnv()
    env.OPENCLAW_GITHUB_INSTALLATION_MAP = JSON.stringify({ "Sigilix/sigilix": INSTALL_ID })
    // flag unset
    await appendLearning(env, "org", String(INSTALL_ID), ORG_POLICY, TS_MS)
    await appendLearning(env, "repo", String(REPO_ID), REPO_FACT, TS_MS)

    await handleMention("comment-mem", env)

    const sys = systemPrompt()
    expect(sys).not.toContain(ORG_POLICY.rule)
    expect(sys).not.toContain(REPO_FACT.rule)
    expect(sys).not.toContain("Team & repository guidance")
    // Off is a true no-op — the numeric-repoId lookup never runs.
    expect(lookupRepoByFullNameMock).not.toHaveBeenCalled()
  })

  it("fail-soft — a learnings-store fault still posts the answer (no memory injected)", async () => {
    seedComment()
    lookupRepoByFullNameMock.mockResolvedValue({ repoId: REPO_ID, installationId: INSTALL_ID })
    const { env } = makeEnv()
    env.OPENCLAW_GITHUB_INSTALLATION_MAP = JSON.stringify({ "Sigilix/sigilix": INSTALL_ID })
    env.OPENCLAW_SURFACE_MEMORY_APPLY = "on"
    // Wrap OPENCLAW_STATE so get throws only for learnings:* keys.
    const realGet = env.OPENCLAW_STATE.get.bind(env.OPENCLAW_STATE)
    env.OPENCLAW_STATE.get = (async (key: string): Promise<string | null> => {
      if (key.startsWith("learnings:")) throw new Error("kv exploded")
      return realGet(key)
    }) as KVNamespace["get"]

    await handleMention("comment-mem", env)

    // The reply is still posted…
    expect(mockCreateComment).toHaveBeenCalled()
    // …and no memory block is injected.
    expect(systemPrompt()).not.toContain("Team & repository guidance")
  })
})
