import { beforeEach, describe, expect, it, vi } from "vitest"
import { createAgentTools } from "@/src/lib/agent-tools"
import type { RetrievedChunk } from "@/src/lib/retrieval"
import type { GitHubClient } from "@/src/shared/adapters/github"
import type { Env } from "@/src/shared/types/env"

const retrieveChunksMock = vi.fn()
const enclosingSymbolsMock = vi.fn()
const fetchPullRequestContextWithClientMock = vi.fn()
const fetchPullRequestSnapshotWithClientMock = vi.fn()
const getInstallationTokenMock = vi.fn(async (_args: unknown) => "test-token")
const readFileContentMock = vi.fn()

vi.mock("@/src/lib/retrieval", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/retrieval")>("@/src/lib/retrieval")
  return { ...actual, retrieveChunks: (args: unknown) => retrieveChunksMock(args) }
})

vi.mock("@/src/lib/repo-graph-client", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/repo-graph-client")>("@/src/lib/repo-graph-client")
  return {
    ...actual,
    enclosingSymbolsForHitsFor: (...args: unknown[]) => enclosingSymbolsMock(...args),
  }
})

vi.mock("@/src/lib/github-pr-context", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/github-pr-context")>("@/src/lib/github-pr-context")
  return {
    ...actual,
    fetchPullRequestContextWithClient: (args: unknown) => fetchPullRequestContextWithClientMock(args),
    fetchPullRequestSnapshotWithClient: (args: unknown) => fetchPullRequestSnapshotWithClientMock(args),
  }
})

vi.mock("@/src/shared/adapters/github/github-app", () => ({
  getInstallationToken: (args: unknown) => getInstallationTokenMock(args),
}))

vi.mock("@/src/shared/adapters/github", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/github")>("@/src/shared/adapters/github")
  return {
    ...actual,
    GitHubClient: vi.fn().mockImplementation(() => ({
      getFileContent: (...args: unknown[]) => readFileContentMock(...args),
    })),
  }
})

function env(): Env {
  return {
    OPENCLAW_STATE: {} as KVNamespace,
    OPENCLAW_CODE_INDEX: {} as VectorizeIndex,
    AI: {} as Ai,
  } as Env
}

function github() {
  return {
    githubClient: {} as GitHubClient,
    allowedRepos: [
      { owner: "Acme", repo: "Api" },
      { owner: "Acme", repo: "Web" },
    ],
    defaultRef: "main",
    installationId: 42,
  }
}

function chunk(path: string, score = 0.9): RetrievedChunk {
  return {
    id: score === 0.9 ? "a".repeat(48) : "b".repeat(48),
    path,
    lineStart: 1,
    lineEnd: 1,
    score,
    content: "export const value = true",
    indexedHeadSha: "c".repeat(40),
    indexRunId: "d".repeat(16),
  }
}

function policy(mode: "shadow" | "on") {
  return {
    mode,
    preflight: vi.fn(async (): Promise<{ ok: true } | { ok: false; error: string }> => ({ ok: true })),
    filterAndIssue: vi.fn(async (_namespace: string, chunks: RetrievedChunk[]) =>
      chunks.map((value) => ({
        chunk: value,
        citation: {
          kind: "code" as const,
          id: `code-${value.path}`,
        },
      })),
    ),
    prepareFileRead: vi.fn(async () => ({ ok: true as const, ref: "c".repeat(40) })),
    issueFileLines: vi.fn(async () => ({ kind: "file_lines" as const, id: "file-lines-1" })),
    issuePullRequest: vi.fn(async () => ({ kind: "pull_request" as const, id: "pull-request-1" })),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  retrieveChunksMock.mockResolvedValue([chunk("src/a.ts")])
  enclosingSymbolsMock.mockResolvedValue({
    graphAvailable: true,
    headSha: "c".repeat(40),
    definitionRows: [
      {
        symbolId: "src/a.ts function value 1 0",
        path: "src/a.ts",
        name: "value",
        kind: "function",
        startLine: 1,
        endLine: 1,
      },
    ],
    callerRows: [],
    importRows: [],
  })
  fetchPullRequestContextWithClientMock.mockResolvedValue({
    ok: true,
    context: {
      owner: "Acme",
      repo: "Api",
      number: 7,
      title: "Pin citation snapshots",
      body: "",
      diff: "diff --git a/src/a.ts b/src/a.ts",
      filesChanged: { items: ["src/a.ts"], total: 1 },
      state: "open",
      mergedAt: null,
    },
  })
  fetchPullRequestSnapshotWithClientMock.mockResolvedValue({
    ok: true,
    context: {
      owner: "Acme",
      repo: "Api",
      number: 7,
      title: "Pin citation snapshots",
      body: "",
      diff: "diff --git a/src/a.ts b/src/a.ts",
      filesChanged: { items: ["src/a.ts"], total: 1 },
      state: "open",
      mergedAt: null,
    },
    proof: {
      source: "github_compare",
      baseSha: "b".repeat(40),
      headSha: "c".repeat(40),
    },
  })
  getInstallationTokenMock.mockResolvedValue("test-token")
  readFileContentMock.mockResolvedValue("first\nsecond\nthird")
})

describe("retrieve_codebase — verified Slack citations", () => {
  it("keeps shadow tool output byte-identical while inspecting the exact chunks", async () => {
    const baselineTool = createAgentTools({ env: env(), surface: "slack-mention", github: github() })[0]!
    const baseline = await baselineTool.execute(
      { query: "auth", repo: "acme/api" },
      new AbortController().signal,
      new Map(),
    )
    const shadow = policy("shadow")
    const shadowTool = createAgentTools({
      env: env(),
      surface: "slack-mention",
      github: github(),
      slackCodeCitations: shadow,
    })[0]!
    const observed = await shadowTool.execute(
      { query: "auth", repo: "acme/api" },
      new AbortController().signal,
      new Map(),
    )

    expect(observed).toEqual(baseline)
    expect(shadow.preflight).toHaveBeenCalledWith("acme/api", "", expect.any(AbortSignal))
    expect(shadow.filterAndIssue).toHaveBeenCalledWith("acme/api", [chunk("src/a.ts")])
    expect(JSON.stringify(observed)).not.toContain("citation")
  })

  it("does not wait for a hung shadow proof before returning the legacy tool bytes", async () => {
    const shadow = policy("shadow")
    shadow.preflight.mockReturnValueOnce(new Promise(() => {}))
    const tool = createAgentTools({
      env: env(),
      surface: "slack-mention",
      github: github(),
      slackCodeCitations: shadow,
    })[0]!

    const outcome = await Promise.race([
      tool.execute({ query: "auth", repo: "acme/api" }, new AbortController().signal, new Map()),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 50)),
    ])

    expect(outcome).not.toBe("timed-out")
    expect(shadow.filterAndIssue).not.toHaveBeenCalled()
  })

  it("rejects missing immutable proof before Vectorize in on mode", async () => {
    const on = policy("on")
    on.preflight.mockResolvedValueOnce({ ok: false as const, error: "proof unavailable" })
    const tool = createAgentTools({
      env: env(),
      surface: "slack-mention",
      github: github(),
      slackCodeCitations: on,
    })[0]!

    const result = await tool.execute({ query: "auth", repo: "acme/api" }, new AbortController().signal, new Map())

    expect(result).toEqual({ ok: false, error: "proof unavailable" })
    expect(retrieveChunksMock).not.toHaveBeenCalled()
  })

  it("returns only active issued chunks and their exact sidecars in on mode", async () => {
    const first = chunk("src/stale.ts")
    const second = chunk("src/live.ts", 0.8)
    retrieveChunksMock.mockResolvedValueOnce([first, second])
    const on = policy("on")
    on.filterAndIssue.mockResolvedValueOnce([
      {
        chunk: second,
        citation: {
          kind: "code",
          id: "code-src/live.ts",
        },
      },
    ])
    const tool = createAgentTools({
      env: env(),
      surface: "slack-mention",
      github: github(),
      slackCodeCitations: on,
    })[0]!

    const result = (await tool.execute(
      { query: "auth", repo: "acme/api" },
      new AbortController().signal,
      new Map(),
    )) as { count: number; chunks: Array<{ path: string; citation?: unknown }> }

    expect(result.count).toBe(1)
    expect(result.chunks).toEqual([
      expect.objectContaining({
        path: "src/live.ts",
        citation: {
          kind: "code",
          id: "code-src/live.ts",
        },
      }),
    ])
    expect(retrieveChunksMock).toHaveBeenCalledWith(
      expect.objectContaining({ teamKey: "acme/api", namespace: "acme/api" }),
    )
  })

  it("never injects mutable-ref symbol expansion into verified Slack retrieval", async () => {
    const getFileContent = vi.fn(async () => "export const value = true")
    const on = policy("on")
    const tool = createAgentTools({
      env: { ...env(), OPENCLAW_MENTION_SYMBOL_EXPANSION: "on" },
      surface: "slack-mention",
      github: { ...github(), githubClient: { getFileContent } as unknown as GitHubClient },
      slackCodeCitations: on,
    })[0]!

    const result = (await tool.execute(
      { query: "auth", repo: "acme/api" },
      new AbortController().signal,
      new Map(),
    )) as { symbolContext?: string }

    expect(result.symbolContext).toBeUndefined()
    expect(enclosingSymbolsMock).not.toHaveBeenCalled()
    expect(getFileContent).not.toHaveBeenCalled()
  })
})

describe("direct GitHub tools — verified Slack citations", () => {
  it("attaches an issued ref to an immutable compare-backed PR snapshot in on mode", async () => {
    const on = policy("on")
    const tools = createAgentTools({
      env: env(),
      surface: "slack-mention",
      github: github(),
      slackCodeCitations: on,
    })
    const tool = tools.find((candidate) => candidate.name === "fetch_pr")!

    const result = (await tool.execute(
      { owner: "Acme", repo: "Api", number: 7 },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean; pr?: unknown; citation?: unknown }

    expect(result).toMatchObject({
      ok: true,
      pr: { number: 7 },
      citation: { kind: "pull_request", id: "pull-request-1" },
    })
    expect(fetchPullRequestSnapshotWithClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "Acme", repo: "Api", number: 7, client: github().githubClient }),
    )
    expect(fetchPullRequestContextWithClientMock).not.toHaveBeenCalled()
    expect(on.issuePullRequest).toHaveBeenCalledWith({
      namespace: "acme/api",
      number: 7,
      baseSha: "b".repeat(40),
      headSha: "c".repeat(40),
      source: "github_compare",
    })
  })

  it("pins a default-branch file read to the active full SHA before exposing content", async () => {
    const on = policy("on")
    const tools = createAgentTools({
      env: env(),
      surface: "slack-mention",
      github: github(),
      slackCodeCitations: on,
    })
    const tool = tools.find((candidate) => candidate.name === "read_file_lines")!

    const result = (await tool.execute(
      { owner: "Acme", repo: "Api", path: "src/config.ts", lineStart: 2, lineEnd: 2 },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean; ref?: string; content?: string; citation?: unknown }

    expect(on.prepareFileRead).toHaveBeenCalledWith("acme/api", "", expect.any(AbortSignal))
    expect(readFileContentMock).toHaveBeenCalledWith("Acme", "Api", "src/config.ts", "c".repeat(40))
    expect(on.issueFileLines).toHaveBeenCalledWith({
      namespace: "acme/api",
      path: "src/config.ts",
      lineStart: 2,
      lineEnd: 2,
      ref: "c".repeat(40),
      content: "second",
    })
    expect(result).toMatchObject({
      ok: true,
      ref: "c".repeat(40),
      content: "second",
      citation: { kind: "file_lines", id: "file-lines-1" },
    })
  })

  it("keeps direct-tool shadow results byte-identical and free of refs", async () => {
    const baselineTools = createAgentTools({ env: env(), surface: "slack-mention", github: github() })
    const shadow = policy("shadow")
    const shadowTools = createAgentTools({
      env: env(),
      surface: "slack-mention",
      github: github(),
      slackCodeCitations: shadow,
    })
    const baseline = await baselineTools
      .find((candidate) => candidate.name === "fetch_pr")!
      .execute({ owner: "Acme", repo: "Api", number: 7 }, new AbortController().signal, new Map())
    const observed = await shadowTools
      .find((candidate) => candidate.name === "fetch_pr")!
      .execute({ owner: "Acme", repo: "Api", number: 7 }, new AbortController().signal, new Map())

    expect(observed).toEqual(baseline)
    expect(observed).not.toHaveProperty("citation")
    expect(fetchPullRequestSnapshotWithClientMock).not.toHaveBeenCalled()
    expect(shadow.issuePullRequest).not.toHaveBeenCalled()
  })
})
