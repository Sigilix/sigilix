import { beforeEach, describe, expect, it, vi } from "vitest"
import { createAgentTools } from "@/src/lib/agent-tools"
import type { RetrievedChunk } from "@/src/lib/retrieval"
import type { GitHubClient } from "@/src/shared/adapters/github"
import type { Env } from "@/src/shared/types/env"

const retrieveChunksMock = vi.fn()
const enclosingSymbolsMock = vi.fn()

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
          githubRepoId: 101,
          repo: "Acme/Api",
          path: value.path,
          lineStart: value.lineStart,
          lineEnd: value.lineEnd,
          ref: "c".repeat(40),
          runId: "d".repeat(16),
          chunkId: value.id!,
        },
      })),
    ),
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
          githubRepoId: 101,
          repo: "Acme/Api",
          path: "src/live.ts",
          lineStart: 1,
          lineEnd: 1,
          ref: "c".repeat(40),
          runId: "d".repeat(16),
          chunkId: second.id!,
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
          githubRepoId: 101,
          repo: "Acme/Api",
          path: "src/live.ts",
          lineStart: 1,
          lineEnd: 1,
          ref: "c".repeat(40),
          runId: "d".repeat(16),
          chunkId: second.id!,
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
