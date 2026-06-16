// SIG-407 PR-3 — E2E coverage of the symbol-expansion flag THROUGH the real
// `handleGithubMention` Q&A path (single-shot, issue surface). Mocks only the
// boundaries the handler reaches over (the model, retrieval, the graph DO client,
// and the GitHub client) and asserts on the PROMPT the model actually receives.
//
// The recall-safety contract this pins:
//   - flag OFF / unset  → the DO is NEVER queried and the model prompt is
//     byte-identical to today's (no expansion path runs at all).
//   - flag SHADOW       → the expander RUNS (DO IS queried, telemetry emitted)
//     but the model prompt is byte-identical to OFF (nothing injected).
//   - flag ON           → the expanded [SYMBOL CONTEXT …] block is prepended to
//     the codebase-chunks section of the prompt.
//
// Without this, a flag that changed the posted output in shadow — or that fired
// the DO when off — would be a silent recall/cost regression.

import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  getInstallationTokenMock,
  listIssueCommentsMock,
  addReactionToIssueCommentMock,
  getPullRequestMock,
  getPullRequestDiffMock,
  getFileContentMock,
  createIssueCommentMock,
  generateMock,
  retrieveChunksMock,
  enclosingSymbolsForHitsForMock,
} = vi.hoisted(() => ({
  getInstallationTokenMock: vi.fn(async () => "fake-token"),
  listIssueCommentsMock: vi.fn(),
  addReactionToIssueCommentMock: vi.fn(),
  getPullRequestMock: vi.fn(),
  getPullRequestDiffMock: vi.fn(),
  getFileContentMock: vi.fn(),
  createIssueCommentMock: vi.fn(),
  generateMock: vi.fn(),
  retrieveChunksMock: vi.fn(),
  enclosingSymbolsForHitsForMock: vi.fn(),
}))

vi.mock("@/src/shared/adapters/github/github-app", () => ({
  getInstallationToken: getInstallationTokenMock,
}))

vi.mock("@/src/shared/adapters/github", async (importActual) => {
  const actual = await importActual<typeof import("@/src/shared/adapters/github")>()
  class FakeGitHubClient {
    listIssueComments = listIssueCommentsMock
    addReactionToIssueComment = addReactionToIssueCommentMock
    getPullRequest = getPullRequestMock
    getPullRequestDiff = getPullRequestDiffMock
    getFileContent = getFileContentMock
    createIssueComment = createIssueCommentMock
  }
  return { ...actual, GitHubClient: FakeGitHubClient }
})

vi.mock("@/src/shared/adapters/model", async (importActual) => {
  const actual = await importActual<typeof import("@/src/shared/adapters/model")>()
  return { ...actual, generate: generateMock }
})

vi.mock("@/src/lib/retrieval", async (importActual) => {
  const actual = await importActual<typeof import("@/src/lib/retrieval")>()
  return { ...actual, retrieveChunks: (args: unknown) => retrieveChunksMock(args) }
})

// The graph DO boundary. The expander calls enclosingSymbolsForHitsFor.
vi.mock("@/src/lib/repo-graph-client", async (importActual) => {
  const actual = await importActual<typeof import("@/src/lib/repo-graph-client")>()
  return {
    ...actual,
    enclosingSymbolsForHitsFor: (...args: unknown[]) => enclosingSymbolsForHitsForMock(...args),
  }
})

import { handleGithubMention } from "@/src/lib/github-mention"
import type { GraphHitExpansion } from "@/src/do/repo-graph"
import type { RetrievedChunk } from "@/src/lib/retrieval"
import type { Env } from "@/src/shared/types/env"

const OWNER = "Sigilix"
const REPO = "sigilix"
const PR = 7
const COMMENT_ID = 4242
const HEAD_SHA = "deadbeefcafe0001"

// A source comment that @-mentions the bot (so the handler treats it as a
// question rather than skipping). 30-line source so the symbol span has room.
const BILLING_SRC = Array.from({ length: 40 }, (_, i) => `// billing line ${i + 1}`).join("\n")

function chunk(over: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    path: "src/billing.ts",
    lineStart: 14,
    lineEnd: 18,
    content: "  // a 5-line slice inside applyRefund",
    score: 0.9,
    ...over,
  }
}

function hitExp(over: Partial<GraphHitExpansion> = {}): GraphHitExpansion {
  return {
    graphAvailable: true,
    headSha: HEAD_SHA,
    definitionRows: [
      {
        symbolId: "src/billing.ts function applyRefund 10 0",
        path: "src/billing.ts",
        name: "applyRefund",
        kind: "function",
        startLine: 10,
        endLine: 24,
      },
    ],
    callerRows: [],
    importRows: [],
    ...over,
  }
}

function makeEnv(overrides: Record<string, string | undefined> = {}): { env: Env; store: Map<string, string> } {
  const store = new Map<string, string>()
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key)
    }),
  } as unknown as KVNamespace
  return {
    store,
    env: {
      OPENCLAW_STATE: kv,
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY: "private-key",
      ...overrides,
    } as unknown as Env,
  }
}

beforeEach(() => {
  for (const m of [
    getInstallationTokenMock,
    listIssueCommentsMock,
    addReactionToIssueCommentMock,
    getPullRequestMock,
    getPullRequestDiffMock,
    getFileContentMock,
    createIssueCommentMock,
    generateMock,
    retrieveChunksMock,
    enclosingSymbolsForHitsForMock,
  ]) {
    m.mockReset()
  }
  getInstallationTokenMock.mockResolvedValue("fake-token")
  listIssueCommentsMock.mockResolvedValue([
    {
      id: COMMENT_ID,
      body: "@sigilix where is the refund applied?",
      user: { login: "human" },
      author_association: "MEMBER",
    },
  ])
  addReactionToIssueCommentMock.mockResolvedValue(undefined)
  getPullRequestMock.mockResolvedValue({ title: "Refund handling", body: "", head: { sha: HEAD_SHA, ref: "feature" } })
  getPullRequestDiffMock.mockResolvedValue("diff --git a/src/billing.ts b/src/billing.ts\n@@ -1 +1 @@\n-old\n+new")
  getFileContentMock.mockResolvedValue(BILLING_SRC)
  createIssueCommentMock.mockResolvedValue({ id: 777 })
  // Citation-free answer → verifyAndSanitizeCitations short-circuits, so the only
  // getFileContent calls come from the symbol expander.
  generateMock.mockResolvedValue({
    text: JSON.stringify({ answer: "It is in applyRefund.", confidence: 4, abstain: false }),
  })
  retrieveChunksMock.mockResolvedValue([chunk()])
  enclosingSymbolsForHitsForMock.mockResolvedValue(hitExp())
})

// Each call is a fresh handler invocation (fresh env + KV). Clear the call
// history of the spies a test inspects so a second runWith() in the SAME test
// (the OFF-vs-X comparisons) reads only its own invocation.
async function runWith(mode?: string): Promise<string> {
  generateMock.mockClear()
  enclosingSymbolsForHitsForMock.mockClear()
  getFileContentMock.mockClear()
  const { env } = makeEnv(mode === undefined ? {} : { OPENCLAW_MENTION_SYMBOL_EXPANSION: mode })
  await handleGithubMention({
    owner: OWNER,
    repo: REPO,
    prNumber: PR,
    installationId: 99,
    surface: "issue",
    commentId: COMMENT_ID,
    env,
  })
  expect(generateMock).toHaveBeenCalledTimes(1)
  const arg = generateMock.mock.calls[0]?.[0] as { prompt: string }
  return arg.prompt
}

describe("handleGithubMention — SIG-407 symbol-expansion flag (single-shot)", () => {
  it("OFF (unset): never queries the graph DO and the prompt is the today-baseline", async () => {
    const prompt = await runWith(undefined)
    expect(enclosingSymbolsForHitsForMock).not.toHaveBeenCalled()
    expect(prompt).not.toContain("[SYMBOL CONTEXT")
    // No expander → only the citation verifier could fetch, and the answer is
    // citation-free, so no file fetch happens at all.
    expect(getFileContentMock).not.toHaveBeenCalled()
  })

  it('OFF (explicit "off"): identical to unset — no DO call, baseline prompt', async () => {
    const prompt = await runWith("off")
    expect(enclosingSymbolsForHitsForMock).not.toHaveBeenCalled()
    expect(prompt).not.toContain("[SYMBOL CONTEXT")
  })

  it("SHADOW: queries the DO + fetches bodies, but the prompt is byte-identical to OFF", async () => {
    const offPrompt = await runWith("off")
    const shadowPrompt = await runWith("shadow")
    // The expander ran in shadow (DO queried, definition body fetched)…
    expect(enclosingSymbolsForHitsForMock).toHaveBeenCalledTimes(1)
    expect(getFileContentMock).toHaveBeenCalledWith(OWNER, REPO, "src/billing.ts", HEAD_SHA)
    // …yet injected NOTHING: the model sees exactly the OFF prompt.
    expect(shadowPrompt).toBe(offPrompt)
    expect(shadowPrompt).not.toContain("[SYMBOL CONTEXT")
  })

  it("ON: prepends the expanded [SYMBOL CONTEXT] block above the raw chunks", async () => {
    const offPrompt = await runWith("off")
    const onPrompt = await runWith("on")
    expect(enclosingSymbolsForHitsForMock).toHaveBeenCalledTimes(1)
    expect(onPrompt).toContain("[SYMBOL CONTEXT")
    expect(onPrompt).toContain("src/billing.ts:10-24 — function applyRefund")
    expect(onPrompt).not.toBe(offPrompt)
    // The raw-chunk section is still present (the expansion is purely ADDITIVE).
    expect(onPrompt).toContain("[RELEVANT CODEBASE CHUNKS]")
  })

  it("ON with no graph available: the block is null → prompt stays the OFF baseline", async () => {
    enclosingSymbolsForHitsForMock.mockResolvedValue(
      hitExp({ graphAvailable: false, headSha: null, definitionRows: [] }),
    )
    const onPrompt = await runWith("on")
    const offPrompt = await runWith("off")
    expect(onPrompt).toBe(offPrompt)
    expect(onPrompt).not.toContain("[SYMBOL CONTEXT")
  })
})
