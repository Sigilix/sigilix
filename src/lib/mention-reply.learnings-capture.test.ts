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

// `admin` gates the org-teach authz check: only a Linear workspace admin may
// write an org learning. Default `true` (admin) keeps the capture test green;
// `false` / `undefined` drive the non-admin / fail-closed cases.
function seedComment(body: string, admin: boolean | null | undefined = true): void {
  getCommentWithIssueMock.mockResolvedValue({
    id: "comment-1",
    body,
    user: { name: "daniel", displayName: "daniel", admin },
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
  it("captures an ADMIN's correction as an org-scope learning keyed to the team's installation", async () => {
    extractLearningMock.mockResolvedValueOnce({ rule: "always name hooks with a use prefix", polarity: "require" })
    seedComment("@sigilix that's wrong — we always name hooks with a use prefix", true)
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

  it("ORG-TEACH AUTHZ — a NON-ADMIN's correction is NOT captured, and the reply still posts", async () => {
    seedComment("@sigilix that's wrong — we always name hooks with a use prefix", false)
    const { env, store } = makeEnv()

    await handleMention("comment-1", env)

    // No org learning; reply still posted.
    expect(Array.from(store.keys()).filter((k) => k.startsWith("learnings:"))).toHaveLength(0)
    expect(createCommentMock).toHaveBeenCalled()
    // The authz gate short-circuits before the extractor is consulted.
    expect(extractLearningMock).not.toHaveBeenCalled()
  })

  it("ORG-TEACH AUTHZ — FAIL-CLOSED: an undetermined admin status does NOT capture and logs a distinct deny", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    // `admin` null → cannot determine (older query / guest / unreadable field) →
    // fail-closed. (null, unlike undefined, does not trip seedComment's default.)
    seedComment("@sigilix that's wrong — we always name hooks with a use prefix", null)
    const { env, store } = makeEnv()

    await handleMention("comment-1", env)

    expect(Array.from(store.keys()).filter((k) => k.startsWith("learnings:"))).toHaveLength(0)
    const denyLine = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .find((s) => s.includes("org-teach-authz-denied"))
    expect(denyLine).toBeDefined()
    const deny = JSON.parse(denyLine!)
    expect(deny.surface).toBe("linear")
    expect(deny.reason).toBe("unknown")
    expect(deny.subject_id).toBe("111")
    logSpy.mockRestore()
  })

  it("does not capture a broker-bound legacy correction without exact tenant proof", async () => {
    seedComment("@sigilix remember: always keep the tenant boundary")
    const { env, store } = makeEnv()
    env.OPENCLAW_LINEAR_ALLOWED_ORG_ID = "org-dogfood"
    env.OPENCLAW_LINEAR_LEGACY_INSTALLATION_ID = "77"
    env.LINEAR_TOKEN_BROKER = {} as Env["LINEAR_TOKEN_BROKER"]

    await handleMention("comment-1", env)

    expect(
      Array.from(store.keys()).filter((key) => key.startsWith("learnings:") || key.startsWith("learning")),
    ).toEqual([])
  })

  it("QUALITY GATE — an ordinary question writes NO learning", async () => {
    extractLearningMock.mockResolvedValue(null)
    seedComment("@sigilix where is handleMention implemented?")
    const { env, store } = makeEnv()

    await handleMention("comment-1", env)

    expect(Array.from(store.keys()).filter((k) => k.startsWith("learnings:"))).toHaveLength(0)
  })
})
