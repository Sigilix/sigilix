import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  generateMock,
  retrieveChunksMock,
  getInstallationTokenMock,
  listIssueCommentsMock,
  addReactionToIssueCommentMock,
  getPullRequestMock,
  getPullRequestDiffMock,
  createIssueCommentMock,
  getFileContentMock,
} = vi.hoisted(() => ({
  generateMock: vi.fn(),
  retrieveChunksMock: vi.fn(),
  getInstallationTokenMock: vi.fn(async () => "fake-token"),
  listIssueCommentsMock: vi.fn(),
  addReactionToIssueCommentMock: vi.fn(),
  getPullRequestMock: vi.fn(),
  getPullRequestDiffMock: vi.fn(),
  createIssueCommentMock: vi.fn(),
  getFileContentMock: vi.fn(),
}))

vi.mock("@/src/shared/adapters/model", () => ({
  generate: generateMock,
}))

vi.mock("@/src/lib/retrieval", async (importActual) => {
  const actual = await importActual<typeof import("@/src/lib/retrieval")>()
  return {
    ...actual,
    retrieveChunks: retrieveChunksMock,
  }
})

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
    createIssueComment = createIssueCommentMock
    getFileContent = getFileContentMock
  }
  return {
    ...actual,
    GitHubClient: FakeGitHubClient,
  }
})

import { handleGithubMention } from "@/src/lib/github-mention"
import type { Env } from "@/src/shared/types/env"

function makeEnv(): Env {
  const store = new Map<string, string>()
  return {
    OPENCLAW_STATE: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value)
      }),
    } as unknown as KVNamespace,
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "private-key",
    OLLAMA_API_KEY: "ollama-key",
  } as unknown as Env
}

describe("handleGithubMention citation verification", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getInstallationTokenMock.mockResolvedValue("fake-token")
    addReactionToIssueCommentMock.mockResolvedValue(undefined)
    retrieveChunksMock.mockResolvedValue([])
    getPullRequestMock.mockResolvedValue({
      number: 7,
      title: "Refresh ask docs",
      body: null,
      user: { login: "author" },
      head: { sha: "headsha123456", ref: "feature" },
      base: { sha: "basesha", ref: "main" },
    })
    getPullRequestDiffMock.mockResolvedValue("diff --git a/src/lib/current.ts b/src/lib/current.ts\n")
    createIssueCommentMock.mockResolvedValue({ id: 777 })
    getFileContentMock.mockResolvedValue(Array.from({ length: 549 }, (_, i) => `line ${i + 1}`).join("\n"))
    generateMock.mockResolvedValue({
      text: JSON.stringify({
        answer: "The slash dispatcher is still at `src/index.ts:3689`.",
        confidence: 4,
        abstain: false,
        verdict: "answer",
      }),
    })
  })

  it("rewrites stale file/line citations before posting a GitHub mention reply", async () => {
    listIssueCommentsMock.mockResolvedValue([
      {
        id: 4242,
        body: "@sigilix where is the slash dispatcher?",
        user: { login: "human" },
        author_association: "MEMBER",
      },
    ])

    await handleGithubMention({
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 7,
      installationId: 99,
      surface: "issue",
      commentId: 4242,
      env: makeEnv(),
    })

    expect(getFileContentMock).toHaveBeenCalledWith("Sigilix", "sigilix", "src/index.ts", "headsha123456")
    const posted = createIssueCommentMock.mock.calls[0]?.[3] as string
    expect(posted).not.toContain("src/index.ts:3689")
    expect(posted).toContain("src/index.ts (line 3689 not verified on current ref)")
    expect(posted).toContain("Citation check:")
  })
})
