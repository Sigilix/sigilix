// Composition regression for the fetch_pr authorization boundary. The tool
// must use the already-scoped client supplied by its caller; an absent, stale,
// or hostile global installation map is not a second authorization source.

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { GitHubClient } from "@/src/shared/adapters/github"
import type { PullRequestMeta, PrChangedFile } from "@/src/shared/types/github"
import type { Env } from "@/src/shared/types/env"

const mocks = vi.hoisted(() => ({
  getInstallationToken: vi.fn(),
  githubClientConstructor: vi.fn(),
  constructedGetPullRequest: vi.fn(),
  constructedGetPullRequestDiff: vi.fn(),
  constructedListPullRequestFiles: vi.fn(),
}))

vi.mock("@/src/shared/adapters/github/github-app", () => ({
  getInstallationToken: (args: unknown) => mocks.getInstallationToken(args),
}))

vi.mock("@/src/shared/adapters/github", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/github")>("@/src/shared/adapters/github")
  return {
    ...actual,
    GitHubClient: mocks.githubClientConstructor,
  }
})

import { createAgentTools } from "@/src/lib/agent-tools"

function makeMeta(title: string): PullRequestMeta {
  return {
    number: 7,
    title,
    body: "body",
    user: { login: "octocat" },
    head: { sha: "head", ref: "feature" },
    base: { sha: "base", ref: "main" },
    state: "open",
    merged_at: null,
    changed_files: 1,
  }
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    OPENCLAW_STATE: { get: vi.fn(), put: vi.fn() } as unknown as KVNamespace,
    OPENCLAW_CODE_INDEX: {} as VectorizeIndex,
    AI: {} as Ai,
    OPENCLAW_JOBS: {} as Queue<never>,
    LINEAR_API_KEY: "x",
    LINEAR_WEBHOOK_SECRET: "x",
    OLLAMA_API_KEY: "x",
    ...overrides,
  } as Env
}

beforeEach(() => {
  mocks.getInstallationToken.mockReset().mockResolvedValue("wrong-installation-token")
  mocks.constructedGetPullRequest.mockReset().mockResolvedValue(makeMeta("wrong installation client"))
  mocks.constructedGetPullRequestDiff.mockReset().mockResolvedValue("+wrong-installation-client")
  mocks.constructedListPullRequestFiles.mockReset().mockResolvedValue([])
  mocks.githubClientConstructor.mockReset().mockImplementation(() => ({
    getPullRequest: mocks.constructedGetPullRequest,
    getPullRequestDiff: mocks.constructedGetPullRequestDiff,
    listPullRequestFiles: mocks.constructedListPullRequestFiles,
  }))
})

async function executeFetchPr(env: Env): Promise<{
  result: { ok: boolean; pr?: { title?: string; diff?: string }; error?: string }
  suppliedGetPullRequest: ReturnType<typeof vi.fn>
}> {
  const suppliedGetPullRequest = vi.fn().mockResolvedValue(makeMeta("supplied installation client"))
  const suppliedClient = {
    getPullRequest: suppliedGetPullRequest,
    getPullRequestDiff: vi.fn().mockResolvedValue("+supplied-installation-client"),
    listPullRequestFiles: vi
      .fn()
      .mockResolvedValue([
        { filename: "src/scoped.ts", status: "modified", additions: 1, deletions: 0 },
      ] as PrChangedFile[]),
  } as unknown as GitHubClient
  const tool = createAgentTools({
    env,
    surface: "slack-mention",
    github: {
      githubClient: suppliedClient,
      allowedRepos: [{ owner: "acme", repo: "api" }],
      defaultRef: "main",
      installationId: 12345,
    },
  }).find((candidate) => candidate.name === "fetch_pr")!

  const result = (await tool.execute(
    { owner: "acme", repo: "api", number: 7 },
    new AbortController().signal,
    new Map(),
  )) as { ok: boolean; pr?: { title?: string; diff?: string }; error?: string }
  return { result, suppliedGetPullRequest }
}

describe("fetch_pr — supplied GitHub client boundary", () => {
  it("succeeds through the supplied client when no installation map or App credentials exist", async () => {
    const { result, suppliedGetPullRequest } = await executeFetchPr(makeEnv())

    expect(result).toMatchObject({
      ok: true,
      pr: { title: "supplied installation client", diff: "+supplied-installation-client" },
    })
    expect(suppliedGetPullRequest).toHaveBeenCalledOnce()
    expect(mocks.getInstallationToken).not.toHaveBeenCalled()
    expect(mocks.githubClientConstructor).not.toHaveBeenCalled()
  })

  it("ignores a malicious installation map instead of minting or replacing the supplied client", async () => {
    const { result, suppliedGetPullRequest } = await executeFetchPr(
      makeEnv({
        GITHUB_APP_ID: "1",
        GITHUB_PRIVATE_KEY: "key",
        OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ "acme/api": "999" }),
      }),
    )

    expect(mocks.getInstallationToken).not.toHaveBeenCalled()
    expect(mocks.githubClientConstructor).not.toHaveBeenCalled()
    expect(suppliedGetPullRequest).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      ok: true,
      pr: { title: "supplied installation client", diff: "+supplied-installation-client" },
    })
  })
})
