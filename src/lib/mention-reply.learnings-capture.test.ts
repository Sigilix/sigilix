// Unified learnings capture — Linear surface e2e.
//
// Drives the REAL handleMention single-shot path (model + retrieval + Linear
// client mocked, extractor quality-gate mocked) and asserts that a human
// correction on a Sigilix-touched issue lands as an ORG-scope learning keyed to
// the team's installation — the same store the PR-review + Slack + CLI surfaces
// read back from.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { generateMock, retrieveChunksMock, getCommentWithIssueMock, createCommentMock, extractLearningMock } =
  vi.hoisted(() => ({
    generateMock: vi.fn(),
    retrieveChunksMock: vi.fn(async () => [] as unknown[]),
    getCommentWithIssueMock: vi.fn(),
    createCommentMock: vi.fn(async () => "reply-1"),
    extractLearningMock: vi.fn(async () => null as { rule: string; polarity: "require" } | null),
  }))

vi.mock("@/src/shared/adapters/model", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/model")>("@/src/shared/adapters/model")
  return { ...actual, generate: generateMock }
})

vi.mock("@/src/lib/retrieval", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/retrieval")>("@/src/lib/retrieval")
  return { ...actual, retrieveChunks: retrieveChunksMock }
})

vi.mock("@/src/lib/linear", () => ({
  buildLinearClient: vi.fn(async () => ({
    getCommentWithIssue: getCommentWithIssueMock,
    createComment: createCommentMock,
  })),
}))

vi.mock("@/src/features/learnings/adapters/extractor-model", () => ({
  extractLearning: extractLearningMock,
}))

import { handleMention } from "@/src/lib/mention-reply"
import { learningsKey } from "@/src/features/learnings/domain/store-ops"
import type { Env } from "@/src/shared/types/env"

function makeEnv(): { env: Env; store: Map<string, string> } {
  const store = new Map<string, string>()
  const env = {
    LINEAR_API_KEY: "linear-key",
    OLLAMA_API_KEY: "ollama-key",
    OPENCLAW_MENTION_TRIGGERS: "sigilix",
    OPENCLAW_LEARNINGS_MODE: "on",
    OPENCLAW_ORG_MEMORY_CAPTURE: "on",
    OPENCLAW_TEAM_GITHUB_REPO_MAP: JSON.stringify({ SIG: { owner: "Sigilix", repo: "sigilix" } }),
    OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ "Sigilix/sigilix": 111 }),
    OPENCLAW_CODE_INDEX: {} as VectorizeIndex,
    OPENCLAW_STATE: {
      get: async (key: string): Promise<string | null> => store.get(key) ?? null,
      put: async (key: string, value: string): Promise<void> => {
        store.set(key, value)
      },
      list: async (opts: { prefix?: string }) => ({
        keys: [...store.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).map((name) => ({ name })),
        list_complete: true,
      }),
    } as unknown as KVNamespace,
  } as Env
  return { env, store }
}

function seedComment(body: string): void {
  getCommentWithIssueMock.mockResolvedValue({
    id: "comment-1",
    body,
    user: { name: "daniel", displayName: "daniel" },
    parent: null,
    issue: {
      id: "issue-1",
      identifier: "SIG-1",
      title: "Triaged issue",
      description: "A Sigilix-triaged issue.",
      team: { id: "team-1", key: "SIG" },
      comments: { nodes: [] },
    },
  })
  generateMock.mockResolvedValue({
    text: JSON.stringify({ answer: "Understood — I'll remember that.", confidence: 5, abstain: false }),
    usage: { promptTokens: 10, completionTokens: 5 },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  retrieveChunksMock.mockResolvedValue([])
  createCommentMock.mockResolvedValue("reply-1")
  extractLearningMock.mockResolvedValue(null)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("handleMention — unified learnings capture", () => {
  it("captures a human CORRECTION as an org-scope learning keyed to the team's installation", async () => {
    extractLearningMock.mockResolvedValueOnce({ rule: "always name hooks with a use prefix", polarity: "require" })
    seedComment("@sigilix that's wrong — we always name hooks with a use prefix")
    const { env, store } = makeEnv()

    await handleMention("comment-1", env)

    const orgKey = learningsKey("org", "111")
    expect(store.has(orgKey)).toBe(true)
    const orgStore = JSON.parse(store.get(orgKey)!)
    expect(orgStore.scope).toBe("org")
    expect(orgStore.subjectId).toBe("111")
    expect(orgStore.entries[0].rule).toBe("always name hooks with a use prefix")
    expect(orgStore.entries[0].source.kind).toBe("chat")
  })

  it("QUALITY GATE — an ordinary question writes NO learning", async () => {
    extractLearningMock.mockResolvedValue(null)
    seedComment("@sigilix where is handleMention implemented?")
    const { env, store } = makeEnv()

    await handleMention("comment-1", env)

    expect(Array.from(store.keys()).filter((k) => k.startsWith("learnings:"))).toHaveLength(0)
  })
})
