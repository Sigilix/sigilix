import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Mock the Phase 1 primitives this layer wraps. retrieveChunks +
// fetchPullRequestContext + getInstallationToken + GitHubClient.
const mockRetrieveChunks = vi.fn()
const mockFetchPullRequestContext = vi.fn()
const mockGetInstallationToken = vi.fn(async () => "test-token")
const mockGetFileContent = vi.fn()

vi.mock("../src/lib/retrieval", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/retrieval")>("../src/lib/retrieval")
  return {
    ...actual,
    retrieveChunks: (args: unknown) => mockRetrieveChunks(args),
  }
})

vi.mock("../src/lib/github-pr-context", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/github-pr-context")>(
    "../src/lib/github-pr-context"
  )
  return {
    ...actual,
    fetchPullRequestContext: (args: unknown) => mockFetchPullRequestContext(args),
  }
})

vi.mock("../src/lib/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("../src/lib/github", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/github")>("../src/lib/github")
  return {
    ...actual,
    GitHubClient: vi.fn().mockImplementation(() => ({
      getFileContent: (...args: unknown[]) => mockGetFileContent(...args),
    })),
  }
})

import { createAgentTools, type AgentToolsContext } from "../src/lib/agent-tools"
import { GitHubClient } from "../src/lib/github"
import { encodeBranchName } from "../src/lib/index-branch"
import type { Env } from "../src/shared/types/env"

beforeEach(() => {
  mockRetrieveChunks.mockReset()
  mockFetchPullRequestContext.mockReset()
  mockGetInstallationToken.mockReset().mockResolvedValue("test-token")
  mockGetFileContent.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    OPENCLAW_STATE: { get: vi.fn(), put: vi.fn() } as unknown as KVNamespace,
    OPENCLAW_CODE_INDEX: {} as VectorizeIndex,
    AI: {} as Ai,
    OPENCLAW_JOBS: {} as Queue<never>,
    LINEAR_API_KEY: "x",
    LINEAR_WEBHOOK_SECRET: "x",
    OLLAMA_API_KEY: "x",
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "key",
    ...overrides,
  } as Env
}

function makeGithubCtx(): NonNullable<AgentToolsContext["github"]> {
  return {
    githubClient: new GitHubClient({ token: "t" }),
    allowedRepos: [{ owner: "Arc-and-Anchor", repo: "rubberfit" }],
    defaultRef: "main",
    installationId: 12345,
  }
}

describe("createAgentTools — surface scoping", () => {
  it("Linear surface gets retrieve_codebase only", () => {
    const tools = createAgentTools({ env: makeEnv(), surface: "linear-mention" })
    expect(tools.map((t) => t.name)).toEqual(["retrieve_codebase"])
  })

  it("GitHub surface gets all 3 tools", () => {
    const tools = createAgentTools({
      env: makeEnv(),
      surface: "github-mention",
      github: makeGithubCtx(),
    })
    expect(tools.map((t) => t.name).sort()).toEqual([
      "fetch_pr",
      "read_file_lines",
      "retrieve_codebase",
    ])
  })

  it("Linear with no github ctx never exposes fetch_pr / read_file_lines", () => {
    const tools = createAgentTools({ env: makeEnv(), surface: "linear-mention" })
    expect(tools.find((t) => t.name === "fetch_pr")).toBeUndefined()
    expect(tools.find((t) => t.name === "read_file_lines")).toBeUndefined()
  })
})

describe("retrieve_codebase", () => {
  it("returns ok with chunks when retrieveChunks succeeds", async () => {
    mockRetrieveChunks.mockResolvedValue([
      { path: "src/foo.ts", lineStart: 10, lineEnd: 30, score: 0.85, content: "function foo() {}" },
    ])
    const [tool] = createAgentTools({ env: makeEnv(), surface: "linear-mention" })
    const result = await tool!.execute(
      { query: "where is foo defined", repo: "rubberfit" },
      new AbortController().signal,
      new Map(),
    )
    expect(result).toEqual({
      ok: true,
      repo: "rubberfit",
      chunks: [
        {
          path: "src/foo.ts",
          lineStart: 10,
          lineEnd: 30,
          score: 0.85,
          content: "function foo() {}",
        },
      ],
      count: 1,
    })
  })

  it("returns ok with empty chunks when retrieval finds nothing", async () => {
    mockRetrieveChunks.mockResolvedValue([])
    const [tool] = createAgentTools({ env: makeEnv(), surface: "linear-mention" })
    const result = (await tool!.execute(
      { query: "x", repo: "rubberfit" },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean; count: number; message?: string }
    expect(result.ok).toBe(true)
    expect(result.count).toBe(0)
    expect(result.message).toContain("Retrieval returned no chunks for repo 'rubberfit'")
    expect(result.message).toContain("retrieval may be temporarily unavailable")
  })

  it("returns recoverable error on missing args (does not throw)", async () => {
    const [tool] = createAgentTools({ env: makeEnv(), surface: "linear-mention" })
    const result = (await tool!.execute(
      { query: "" },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/non-empty/)
    expect(mockRetrieveChunks).not.toHaveBeenCalled()
  })

  it("re-throws AbortError so loop maps to wall_clock_exceeded", async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const [tool] = createAgentTools({ env: makeEnv(), surface: "linear-mention" })
    await expect(
      tool!.execute({ query: "x", repo: "y" }, ctrl.signal, new Map()),
    ).rejects.toThrow(/aborted/)
  })

  it("rejects out-of-allowedRepos as recoverable (does not throw, includes valid choices)", async () => {
    const [tool] = createAgentTools({
      env: makeEnv(),
      surface: "linear-mention",
      allowedRepos: ["rubberfit", "arc-and-anchor-website"],
    })
    const result = (await tool!.execute(
      { query: "x", repo: "made-up-repo" },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean; error: string; allowedRepos: string[] }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/'made-up-repo' is not in the indexed namespace set/)
    expect(result.allowedRepos).toEqual(["rubberfit", "arc-and-anchor-website"])
    expect(mockRetrieveChunks).not.toHaveBeenCalled()
  })

  it("matches allowedRepos case-insensitively", async () => {
    mockRetrieveChunks.mockResolvedValue([])
    const [tool] = createAgentTools({
      env: makeEnv(),
      surface: "linear-mention",
      allowedRepos: ["rubberfit"],
    })
    const result = (await tool!.execute(
      { query: "x", repo: "RubberFit" },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(mockRetrieveChunks).toHaveBeenCalledOnce()
  })

  it("accepts an exact <owner>/<repo> namespace and queries it verbatim (SIG-132)", async () => {
    mockRetrieveChunks.mockResolvedValue([])
    const [tool] = createAgentTools({
      env: makeEnv(),
      surface: "linear-mention",
      allowedRepos: ["arc-and-anchor/rubberfit", "acme/api"],
    })
    const result = (await tool!.execute(
      { query: "x", repo: "Arc-and-Anchor/Rubberfit" },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(mockRetrieveChunks).toHaveBeenCalledWith(
      expect.objectContaining({ teamKey: "arc-and-anchor/rubberfit" }),
    )
  })

  it("accepts an exact branch-scoped namespace and queries it verbatim (SIG-35)", async () => {
    mockRetrieveChunks.mockResolvedValue([])
    // SIG-218: branch segment is the bounded-length sha256 hash.
    const encodedDev = await encodeBranchName("dev")
    const branchNs = `arc-and-anchor/sigilix/__branch__/${encodedDev}`
    const [tool] = createAgentTools({
      env: makeEnv(),
      surface: "linear-mention",
      allowedRepos: [
        "arc-and-anchor/sigilix",
        branchNs,
      ],
    })
    const result = (await tool!.execute(
      { query: "x", repo: `Arc-and-Anchor/Sigilix/__branch__/${encodedDev}` },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(mockRetrieveChunks).toHaveBeenCalledWith(
      expect.objectContaining({ teamKey: branchNs }),
    )
  })

  it("resolves a human branch argument to the encoded branch namespace (SIG-207)", async () => {
    mockRetrieveChunks.mockResolvedValue([])
    const encodedDev = await encodeBranchName("dev")
    const branchNs = `arc-and-anchor/sigilix/__branch__/${encodedDev}`
    const [tool] = createAgentTools({
      env: makeEnv(),
      surface: "linear-mention",
      allowedRepos: [
        "arc-and-anchor/sigilix",
        branchNs,
      ],
    })
    const result = (await tool!.execute(
      { query: "index producer", repo: "arc-and-anchor/sigilix", branch: "dev" },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean; repo?: string }

    expect(result.ok).toBe(true)
    expect(result.repo).toBe(branchNs)
    expect(mockRetrieveChunks).toHaveBeenCalledWith(
      expect.objectContaining({ teamKey: branchNs }),
    )
  })

  it("returns branch choices when a requested branch is not indexed (SIG-207)", async () => {
    const encodedDev = await encodeBranchName("dev")
    const branchNs = `arc-and-anchor/sigilix/__branch__/${encodedDev}`
    const [tool] = createAgentTools({
      env: makeEnv(),
      surface: "linear-mention",
      allowedRepos: [
        "arc-and-anchor/sigilix",
        branchNs,
      ],
    })
    const result = (await tool!.execute(
      { query: "index producer", repo: "sigilix", branch: "release" },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean; error: string; availableBranches: Array<{ repo: string; encodedBranch: string; namespace: string }> }

    expect(result.ok).toBe(false)
    expect(result.error).toContain("branch 'release' is not indexed")
    // SIG-218: availableBranches now exposes the encoded segment instead of
    // the human branch name (the hash is irreversible).
    expect(result.availableBranches).toEqual([
      {
        repo: "arc-and-anchor/sigilix",
        encodedBranch: encodedDev,
        namespace: branchNs,
      },
    ])
    expect(mockRetrieveChunks).not.toHaveBeenCalled()
  })

  it("resolves a mixed-case branch via case-folding fallback (SIG-218)", async () => {
    // The branch namespace is encoded from the lowercased branch name.
    // When the asker passes a mixed-case branch, exact-encoded lookup
    // misses; the fallback re-encodes from the lowercased form and
    // matches.
    mockRetrieveChunks.mockResolvedValue([])
    const encodedLower = await encodeBranchName("my-branch")
    const branchNs = `arc-and-anchor/sigilix/__branch__/${encodedLower}`
    const [tool] = createAgentTools({
      env: makeEnv(),
      surface: "linear-mention",
      allowedRepos: [
        "arc-and-anchor/sigilix",
        branchNs,
      ],
    })
    const result = (await tool!.execute(
      { query: "x", repo: "arc-and-anchor/sigilix", branch: "My-Branch" },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean; repo?: string }

    expect(result.ok).toBe(true)
    expect(result.repo).toBe(branchNs)
    expect(mockRetrieveChunks).toHaveBeenCalledWith(
      expect.objectContaining({ teamKey: branchNs }),
    )
  })

  it("resolves an ALL-CAPS branch via case-folding fallback (SIG-218)", async () => {
    mockRetrieveChunks.mockResolvedValue([])
    const encodedLower = await encodeBranchName("my-branch")
    const branchNs = `arc-and-anchor/sigilix/__branch__/${encodedLower}`
    const [tool] = createAgentTools({
      env: makeEnv(),
      surface: "linear-mention",
      allowedRepos: [
        "arc-and-anchor/sigilix",
        branchNs,
      ],
    })
    const result = (await tool!.execute(
      { query: "x", repo: "arc-and-anchor/sigilix", branch: "MY-BRANCH" },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean; repo?: string }

    expect(result.ok).toBe(true)
    expect(result.repo).toBe(branchNs)
  })

  it("rejects a nonexistent branch even after case-folding (SIG-218)", async () => {
    const encodedLower = await encodeBranchName("my-branch")
    const branchNs = `arc-and-anchor/sigilix/__branch__/${encodedLower}`
    const [tool] = createAgentTools({
      env: makeEnv(),
      surface: "linear-mention",
      allowedRepos: [
        "arc-and-anchor/sigilix",
        branchNs,
      ],
    })
    const result = (await tool!.execute(
      { query: "x", repo: "arc-and-anchor/sigilix", branch: "Nonexistent-Branch" },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean; error: string }

    expect(result.ok).toBe(false)
    expect(result.error).toContain("branch 'Nonexistent-Branch' is not indexed")
    expect(mockRetrieveChunks).not.toHaveBeenCalled()
  })

  it("resolves a bare repo to its <owner>/<repo> namespace when unique (SIG-132 back-compat)", async () => {
    mockRetrieveChunks.mockResolvedValue([])
    const [tool] = createAgentTools({
      env: makeEnv(),
      surface: "linear-mention",
      allowedRepos: ["arc-and-anchor/rubberfit", "acme/api"],
    })
    const result = (await tool!.execute(
      { query: "x", repo: "rubberfit" },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(mockRetrieveChunks).toHaveBeenCalledWith(
      expect.objectContaining({ teamKey: "arc-and-anchor/rubberfit" }),
    )
  })

  it("rejects a bare repo that matches more than one allowed namespace (ambiguous)", async () => {
    const [tool] = createAgentTools({
      env: makeEnv(),
      surface: "linear-mention",
      allowedRepos: ["arc-and-anchor/api", "acme/api"],
    })
    const result = (await tool!.execute(
      { query: "x", repo: "api" },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/'api' is not in the indexed namespace set/)
    expect(mockRetrieveChunks).not.toHaveBeenCalled()
  })

  it("accepts any repo when allowedRepos is unset (back-compat with existing GitHub-mention surface)", async () => {
    mockRetrieveChunks.mockResolvedValue([])
    const [tool] = createAgentTools({ env: makeEnv(), surface: "linear-mention" })
    const result = (await tool!.execute(
      { query: "x", repo: "anything" },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(mockRetrieveChunks).toHaveBeenCalledOnce()
  })

  it("rejects every repo when allowedRepos is empty array (explicit lock to none)", async () => {
    // ARC-239: matches listIndexedRepos's KV-backed semantics — an
    // empty `repo-index-manifest:*` prefix returns `[]`, meaning
    // "no repos indexed yet." The agent should cleanly reject
    // retrieval against any namespace rather than soft-failing.
    const [tool] = createAgentTools({
      env: makeEnv(),
      surface: "linear-mention",
      allowedRepos: [],
    })
    const result = (await tool!.execute(
      { query: "x", repo: "anything" },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean; error: string; allowedRepos: string[] }
    expect(result.ok).toBe(false)
    expect(result.error).toBe("No indexed repositories are available in the current retrieval scope.")
    expect(result.allowedRepos).toEqual([])
    expect(mockRetrieveChunks).not.toHaveBeenCalled()
  })
})

describe("fetch_pr", () => {
  function ghTool(): ReturnType<typeof createAgentTools>[number] {
    const tools = createAgentTools({
      env: makeEnv(),
      surface: "github-mention",
      github: makeGithubCtx(),
    })
    return tools.find((t) => t.name === "fetch_pr")!
  }

  it("returns ok with PR context when fetch succeeds", async () => {
    mockFetchPullRequestContext.mockResolvedValue({
      ok: true,
      context: {
        owner: "Arc-and-Anchor",
        repo: "rubberfit",
        number: 162,
        title: "x",
        body: "",
        diff: "diff",
        filesChanged: { items: ["a.ts"], total: 1 },
        state: "merged",
        mergedAt: null,
      },
    })
    const result = (await ghTool().execute(
      { owner: "Arc-and-Anchor", repo: "rubberfit", number: 162 },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean; pr: unknown }
    expect(result.ok).toBe(true)
    expect(result.pr).toMatchObject({ number: 162 })
  })

  it("REJECTS out-of-allowedRepos as recoverable tool error (not throw)", async () => {
    const result = (await ghTool().execute(
      { owner: "torvalds", repo: "linux", number: 1 },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean; error: string; allowedRepos: Array<{ owner: string; repo: string }> }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/outside the allowed set/)
    expect(result.allowedRepos).toEqual([{ owner: "Arc-and-Anchor", repo: "rubberfit" }])
    expect(mockFetchPullRequestContext).not.toHaveBeenCalled()
  })

  it("returns recoverable error on missing args", async () => {
    const result = (await ghTool().execute(
      { owner: "Arc-and-Anchor", repo: "rubberfit" },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/positive integer/)
  })

  it("returns recoverable error on number = 0 or negative", async () => {
    for (const n of [0, -1, 1.5]) {
      const result = (await ghTool().execute(
        { owner: "Arc-and-Anchor", repo: "rubberfit", number: n },
        new AbortController().signal,
        new Map(),
      )) as { ok: boolean }
      expect(result.ok).toBe(false)
    }
  })

  it("propagates fetchPullRequestContext failure as recoverable error", async () => {
    mockFetchPullRequestContext.mockResolvedValue({ ok: false, reason: "not_found" })
    const result = (await ghTool().execute(
      { owner: "Arc-and-Anchor", repo: "rubberfit", number: 999 },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not_found/)
  })
})

describe("read_file_lines", () => {
  function ghTool(): ReturnType<typeof createAgentTools>[number] {
    const tools = createAgentTools({
      env: makeEnv(),
      surface: "github-mention",
      github: makeGithubCtx(),
    })
    return tools.find((t) => t.name === "read_file_lines")!
  }

  it("returns ok with sliced content on happy path", async () => {
    const fileContent = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")
    mockGetFileContent.mockResolvedValue(fileContent)
    const result = (await ghTool().execute(
      { owner: "Arc-and-Anchor", repo: "rubberfit", path: "src/foo.ts", lineStart: 10, lineEnd: 14 },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean; content: string; lineStart: number; lineEnd: number; totalLinesInFile: number }
    expect(result.ok).toBe(true)
    expect(result.content).toBe("line 10\nline 11\nline 12\nline 13\nline 14")
    expect(result.lineStart).toBe(10)
    expect(result.lineEnd).toBe(14)
    expect(result.totalLinesInFile).toBe(100)
  })

  it("rejects lineEnd < lineStart with recoverable error", async () => {
    const result = (await ghTool().execute(
      { owner: "Arc-and-Anchor", repo: "rubberfit", path: "src/foo.ts", lineStart: 50, lineEnd: 10 },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/lineEnd.*must be >= lineStart/)
    expect(mockGetFileContent).not.toHaveBeenCalled()
  })

  it("rejects per-call cap (>200 lines)", async () => {
    const result = (await ghTool().execute(
      { owner: "Arc-and-Anchor", repo: "rubberfit", path: "src/foo.ts", lineStart: 1, lineEnd: 500 },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/per-call cap is 200 lines.*requested 500/)
  })

  it("rejects out-of-allowedRepos as recoverable", async () => {
    const result = (await ghTool().execute(
      { owner: "torvalds", repo: "linux", path: "kernel.c", lineStart: 1, lineEnd: 10 },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean; error: string; allowedRepos: unknown }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/outside the allowed set/)
    expect(result.allowedRepos).toEqual([{ owner: "Arc-and-Anchor", repo: "rubberfit" }])
  })

  it("enforces 50KB per-loop bytes budget across multiple calls", async () => {
    // First call: 30KB (allowed). Second call: 30KB more (rejected — budget exhausted).
    const lineSize = 600 // ~600 chars per line
    const fileLines = Array.from({ length: 200 }, () => "x".repeat(lineSize))
    mockGetFileContent.mockResolvedValue(fileLines.join("\n"))

    const tool = ghTool()
    const perLoopContext = new Map()

    // First call returns 50 lines * ~601 bytes = ~30KB
    const r1 = (await tool.execute(
      { owner: "Arc-and-Anchor", repo: "rubberfit", path: "f.ts", lineStart: 1, lineEnd: 50 },
      new AbortController().signal,
      perLoopContext,
    )) as { ok: boolean; bytesReturned: number; bytesBudgetRemaining: number }
    expect(r1.ok).toBe(true)
    expect(r1.bytesReturned).toBeGreaterThan(20_000)
    expect(r1.bytesReturned).toBeLessThan(50_000)

    // Second call should be rejected because bytesUsed > 50KB cap
    // (we make sure to push it over by another big read)
    const r2 = (await tool.execute(
      { owner: "Arc-and-Anchor", repo: "rubberfit", path: "f.ts", lineStart: 51, lineEnd: 200 },
      new AbortController().signal,
      perLoopContext,
    )) as { ok: boolean; bytesReturned?: number; error?: string }
    // At this point bytesUsed >= 30KB. Budget is 50KB. Second call may
    // succeed or fail depending on cumulative cost. Check semantics:
    // either it's ok and budget went DOWN, or it's not ok with the
    // budget-exhausted message. Either is consistent with the spec.
    if (!r2.ok) {
      expect(r2.error).toMatch(/budget exhausted/)
    } else {
      // Third call WILL be rejected.
      const r3 = (await tool.execute(
        { owner: "Arc-and-Anchor", repo: "rubberfit", path: "f.ts", lineStart: 1, lineEnd: 50 },
        new AbortController().signal,
        perLoopContext,
      )) as { ok: boolean; error?: string }
      expect(r3.ok).toBe(false)
      expect(r3.error).toMatch(/budget exhausted/)
    }
  })

  it("returns recoverable error when file is missing or unreadable", async () => {
    mockGetFileContent.mockResolvedValue(null)
    const result = (await ghTool().execute(
      { owner: "Arc-and-Anchor", repo: "rubberfit", path: "nope.ts", lineStart: 1, lineEnd: 5 },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Could not read/)
  })

  it("returns recoverable error when lineStart exceeds file length", async () => {
    mockGetFileContent.mockResolvedValue("a\nb\nc")
    const result = (await ghTool().execute(
      { owner: "Arc-and-Anchor", repo: "rubberfit", path: "f.ts", lineStart: 100, lineEnd: 150 },
      new AbortController().signal,
      new Map(),
    )) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/exceeds file length/)
  })

  it("THROWS on getInstallationToken failure (real auth runtime error)", async () => {
    mockGetInstallationToken.mockRejectedValue(new Error("token expired"))
    await expect(
      ghTool().execute(
        { owner: "Arc-and-Anchor", repo: "rubberfit", path: "f.ts", lineStart: 1, lineEnd: 5 },
        new AbortController().signal,
        new Map(),
      ),
    ).rejects.toThrow(/install token failed/)
  })

  it("uses defaultRef when ref omitted", async () => {
    mockGetFileContent.mockResolvedValue("a\nb\nc")
    await ghTool().execute(
      { owner: "Arc-and-Anchor", repo: "rubberfit", path: "f.ts", lineStart: 1, lineEnd: 2 },
      new AbortController().signal,
      new Map(),
    )
    expect(mockGetFileContent).toHaveBeenCalledWith(
      "Arc-and-Anchor",
      "rubberfit",
      "f.ts",
      "main", // defaultRef
    )
  })
})
