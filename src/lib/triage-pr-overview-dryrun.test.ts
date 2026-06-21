// SIG-304 (review CLI) Phase 1b — the headless dry-run seam on the PR-overview
// pass. `dryRun: true` must COMPUTE the overview verdict (summary + files +
// mermaidDiagram) and RETURN it without posting to GitHub or touching KV; an
// injected `githubClient` must bypass the GitHub-App `buildClient` path; and the
// default (dryRun absent) path must still post (prod path byte-unchanged).
//
// Mock harness mirrors triage-pr-overview-race.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest"

const mockGetInstallationToken = vi.fn(async (_args: unknown) => "fake-token")
const mockGetPullRequest = vi.fn()
const mockGetPullRequestDiff = vi.fn()
const mockGetPullRequestCommits = vi.fn()
const mockListIssueComments = vi.fn()
const mockGetIssueComment = vi.fn()
const mockCreateIssueComment = vi.fn()
const mockUpdateIssueComment = vi.fn()
const mockGenerate = vi.fn()
const mockGetFileContent = vi.fn(
  async (_owner: string, _repo: string, _path: string, _ref?: string): Promise<string | null> => null,
)
const mockListPullRequestFiles = vi.fn(async (..._args: unknown[]): Promise<unknown[]> => [])
const mockListIssueCommentsPage = vi.fn(async (..._args: unknown[]): Promise<unknown[]> => [])

vi.mock("@/src/shared/adapters/github/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("@/src/shared/adapters/github", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/github")>("@/src/shared/adapters/github")
  return {
    ...actual,
    GitHubClient: vi.fn().mockImplementation(() => ({
      getPullRequest: (...args: unknown[]) => mockGetPullRequest(...args),
      getPullRequestDiff: (...args: unknown[]) => mockGetPullRequestDiff(...args),
      getPullRequestCommits: (...args: unknown[]) => mockGetPullRequestCommits(...args),
      listIssueComments: (...args: unknown[]) => mockListIssueComments(...args),
      listIssueCommentsPage: (...args: unknown[]) => mockListIssueCommentsPage(...args),
      getIssueComment: (...args: unknown[]) => mockGetIssueComment(...args),
      createIssueComment: (...args: unknown[]) => mockCreateIssueComment(...args),
      updateIssueComment: (...args: unknown[]) => mockUpdateIssueComment(...args),
      listPullRequestFiles: (...args: unknown[]) => mockListPullRequestFiles(...args),
      getFileContent: (...args: unknown[]) => mockGetFileContent(...(args as Parameters<typeof mockGetFileContent>)),
    })),
  }
})

vi.mock("@/src/shared/adapters/model/ollama", () => ({
  generate: async (args: unknown) => {
    const result = await mockGenerate(args)
    return typeof result === "string" ? { text: result, usage: {} } : result
  },
}))

import { handlePrOverview } from "@/src/lib/triage-pr-overview"
import type { GitHubClient } from "@/src/shared/adapters/github"
import type { Env } from "@/src/shared/types/env"

function makeKvStub() {
  const store = new Map<string, string>()
  const putSpy = vi.fn()
  const deleteSpy = vi.fn()
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null
    },
    async put(key: string, value: string): Promise<void> {
      putSpy(key)
      store.set(key, value)
    },
    async delete(key: string): Promise<void> {
      deleteSpy(key)
      store.delete(key)
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store, putSpy, deleteSpy }
}

function makeEnv(kv: Env["OPENCLAW_STATE"]): Env {
  return {
    OPENCLAW_STATE: kv,
    OLLAMA_API_KEY: "fake-ollama",
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
    OPENCLAW_MODEL: undefined,
  } as unknown as Env
}

// A verdict WITH a mermaid sequence diagram (valid per triage-pr-overview-parse:
// starts with `sequenceDiagram`, contains no triple-backtick).
const VERDICT_WITH_DIAGRAM = JSON.stringify({
  summary: "Adds a retry guard around the payment submit path.",
  confidence: 3,
  confidenceReason: "Two payment paths touched.",
  files: [{ path: "src/pay.ts", score: 4, overview: "retry added", nextStep: "add idempotency key" }],
  bullets: ["Check the retry doesn't double-charge"],
  mermaidDiagram: "sequenceDiagram\n  Client->>API: charge()\n  API-->>Client: 200",
})

const args = {
  owner: "acme",
  repo: "site",
  prNumber: 73,
  headSha: "h".repeat(40),
  installationId: 1,
}

beforeEach(() => {
  for (const m of [
    mockGetInstallationToken,
    mockGetPullRequest,
    mockGetPullRequestDiff,
    mockGetPullRequestCommits,
    mockListIssueComments,
    mockGetIssueComment,
    mockCreateIssueComment,
    mockUpdateIssueComment,
    mockGenerate,
    mockGetFileContent,
    mockListPullRequestFiles,
    mockListIssueCommentsPage,
  ]) {
    m.mockClear()
  }
  mockGetIssueComment.mockResolvedValue({ body: "" })
  mockListIssueComments.mockResolvedValue([])
  mockListIssueCommentsPage.mockImplementation(async () => [])
  mockGetFileContent.mockImplementation(async () => null)
  mockGetPullRequest.mockResolvedValue({
    head: { sha: args.headSha, ref: "feature" },
    base: { sha: "b".repeat(40), ref: "main" },
    title: "Some PR",
    body: "Body",
  })
  mockGetPullRequestDiff.mockResolvedValue("diff --git a/pay.ts b/pay.ts\n+const x = 1")
  mockGetPullRequestCommits.mockResolvedValue([])
  mockCreateIssueComment.mockResolvedValue({ id: 12345 })
  mockUpdateIssueComment.mockResolvedValue({})
  mockGenerate.mockResolvedValue(VERDICT_WITH_DIAGRAM)
})

describe("handlePrOverview — dryRun seam (SIG-304)", () => {
  it("returns the computed verdict (incl. mermaidDiagram) and posts NOTHING", async () => {
    const { kv, store, putSpy, deleteSpy } = makeKvStub()

    const result = await handlePrOverview({ ...args, env: makeEnv(kv), dryRun: true })

    if (!result) throw new Error("expected dryRun to return a verdict")
    expect(result.summary).toContain("retry guard")
    expect(result.confidence).toBe(3)
    expect(result.files).toHaveLength(1)
    expect(result.mermaidDiagram).toContain("sequenceDiagram")
    expect(mockGenerate).toHaveBeenCalledOnce()
    // No posting, no late re-scan.
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
    expect(mockUpdateIssueComment).not.toHaveBeenCalled()
    // dryRun ∈ bypassDedupe → the lock is neither written nor released (finally).
    expect(store.size).toBe(0)
    expect(putSpy).not.toHaveBeenCalled()
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  it("uses an injected githubClient and never builds the GitHub-App client", async () => {
    const createSpy = vi.fn(async () => ({ id: 1 }))
    const updateSpy = vi.fn(async () => ({}))
    const fakeClient = {
      getPullRequest: vi.fn(async () => ({
        head: { sha: args.headSha, ref: "feature" },
        base: { sha: "b".repeat(40), ref: "main" },
        title: "t",
        body: "b",
      })),
      getPullRequestDiff: vi.fn(async () => "diff --git a/pay.ts b/pay.ts\n+const x = 1"),
      getPullRequestCommits: vi.fn(async () => []),
      listPullRequestFiles: vi.fn(async () => []),
      getFileContent: vi.fn(async () => null),
      listIssueComments: vi.fn(async () => []),
      listIssueCommentsPage: vi.fn(async () => []),
      createIssueComment: createSpy,
      updateIssueComment: updateSpy,
    } as unknown as GitHubClient
    const { kv } = makeKvStub()

    const result = await handlePrOverview({ ...args, env: makeEnv(kv), githubClient: fakeClient, dryRun: true })

    if (!result) throw new Error("expected dryRun to return a verdict")
    expect(result.mermaidDiagram).toContain("sequenceDiagram")
    // buildClient (GitHub-App installation token) was bypassed.
    expect(mockGetInstallationToken).not.toHaveBeenCalled()
    // The injected client did the reads.
    expect(fakeClient.getPullRequest).toHaveBeenCalled()
    expect(fakeClient.getPullRequestDiff).toHaveBeenCalled()
    // Still no writes.
    expect(createSpy).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it("reviews the requested SHA even when the live head moved (stale-head guard #1 exempt)", async () => {
    // Live head differs from the requested headSha — the prod path would abort at
    // stale-head guard #1, but dryRun is exempt (it never posts, so no overwrite
    // hazard) and must still return a verdict for the requested SHA.
    mockGetPullRequest.mockResolvedValue({
      head: { sha: "z".repeat(40), ref: "feature" },
      base: { sha: "b".repeat(40), ref: "main" },
      title: "Some PR",
      body: "Body",
    })
    const { kv } = makeKvStub()

    const result = await handlePrOverview({ ...args, env: makeEnv(kv), dryRun: true })

    if (!result) throw new Error("expected a verdict despite a moved head")
    expect(result.mermaidDiagram).toContain("sequenceDiagram")
    expect(mockGenerate).toHaveBeenCalledOnce()
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
  })

  it("default path (dryRun absent) still posts — prod path unchanged", async () => {
    const { kv } = makeKvStub()

    const result = await handlePrOverview({ ...args, env: makeEnv(kv) })

    expect(result).toBeUndefined()
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
    // Parity: the same diagram dryRun returns is rendered into the posted body.
    const body = mockCreateIssueComment.mock.calls[0]?.[3] as string
    expect(body).toContain("sequenceDiagram")
  })
})
