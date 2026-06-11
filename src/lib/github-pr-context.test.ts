import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GitHubHttpError } from "@/src/shared/adapters/github"
import type { PullRequestMeta, PrChangedFile } from "@/src/shared/types/github"

const mockMethods = {
  getPullRequest: vi.fn(),
  getPullRequestDiff: vi.fn(),
  listPullRequestFiles: vi.fn(),
}

vi.mock("@/src/shared/adapters/github/github-app", () => ({
  getInstallationToken: vi.fn(async () => "test-token"),
}))

vi.mock("@/src/shared/adapters/github", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/github")>("@/src/shared/adapters/github")
  return {
    ...actual,
    GitHubClient: vi.fn().mockImplementation(() => ({
      getPullRequest: mockMethods.getPullRequest,
      getPullRequestDiff: mockMethods.getPullRequestDiff,
      listPullRequestFiles: mockMethods.listPullRequestFiles,
    })),
  }
})

import { fetchPullRequestContext } from "@/src/lib/github-pr-context"
import type { Env } from "@/src/shared/types/env"

beforeEach(() => {
  mockMethods.getPullRequest.mockReset()
  mockMethods.getPullRequestDiff.mockReset()
  mockMethods.listPullRequestFiles.mockReset()
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
    OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({
      "Sigilix/rema-portal": "12345",
    }),
    ...overrides,
  } as Env
}

function makeMeta(overrides: Partial<PullRequestMeta> = {}): PullRequestMeta {
  return {
    number: 162,
    title: "Port headless logic to Rust",
    body: "Issue body text",
    user: { login: "danny" },
    head: { sha: "abc", ref: "feat/port" },
    base: { sha: "def", ref: "main" },
    state: "closed",
    merged_at: "2026-04-29T12:00:00Z",
    changed_files: 4,
    ...overrides,
  }
}

function abortError(): Error {
  const e = new Error("aborted")
  e.name = "AbortError"
  return e
}

describe("fetchPullRequestContext", () => {
  it("returns ok with full context when all calls succeed", async () => {
    mockMethods.getPullRequest.mockResolvedValue(makeMeta())
    mockMethods.getPullRequestDiff.mockResolvedValue("diff --git a/x b/x\n+foo")
    mockMethods.listPullRequestFiles.mockResolvedValue([
      { filename: "src/foo.ts", status: "modified", additions: 5, deletions: 2 },
      { filename: "src/bar.ts", status: "added", additions: 10, deletions: 0 },
    ] as PrChangedFile[])

    const result = await fetchPullRequestContext({
      owner: "Sigilix",
      repo: "rema-portal",
      number: 162,
      env: makeEnv(),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context.number).toBe(162)
    expect(result.context.title).toBe("Port headless logic to Rust")
    expect(result.context.state).toBe("merged")
    expect(result.context.diff).toContain("+foo")
    expect(result.context.filesChanged).toEqual({
      items: ["src/foo.ts", "src/bar.ts"],
      total: 4,
    })
  })

  it("returns no_installation when env missing the install map entry", async () => {
    const result = await fetchPullRequestContext({
      owner: "OtherOrg",
      repo: "other-repo",
      number: 1,
      env: makeEnv(),
    })
    expect(result).toEqual({ ok: false, reason: "no_installation" })
  })

  it("returns not_found when meta call returns 404", async () => {
    mockMethods.getPullRequest.mockRejectedValue(new GitHubHttpError(404, "not found"))
    const result = await fetchPullRequestContext({
      owner: "Sigilix",
      repo: "rema-portal",
      number: 999,
      env: makeEnv(),
    })
    expect(result).toEqual({ ok: false, reason: "not_found" })
  })

  it("returns forbidden when meta call returns 403", async () => {
    mockMethods.getPullRequest.mockRejectedValue(new GitHubHttpError(403, "forbidden"))
    const result = await fetchPullRequestContext({
      owner: "Sigilix",
      repo: "rema-portal",
      number: 1,
      env: makeEnv(),
    })
    expect(result).toEqual({ ok: false, reason: "forbidden" })
  })

  it("returns timeout when meta call aborts", async () => {
    mockMethods.getPullRequest.mockRejectedValue(abortError())
    const result = await fetchPullRequestContext({
      owner: "Sigilix",
      repo: "rema-portal",
      number: 1,
      env: makeEnv(),
    })
    expect(result).toEqual({ ok: false, reason: "timeout" })
  })

  it("returns context with diff='[timeout]' when only diff aborts", async () => {
    mockMethods.getPullRequest.mockResolvedValue(makeMeta())
    mockMethods.getPullRequestDiff.mockRejectedValue(abortError())
    mockMethods.listPullRequestFiles.mockResolvedValue([])

    const result = await fetchPullRequestContext({
      owner: "Sigilix",
      repo: "rema-portal",
      number: 1,
      env: makeEnv(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context.diff).toBe("[timeout]")
    expect(result.context.title).toBe("Port headless logic to Rust")
  })

  it("returns context with diff='[error]' when diff fails with 403 (NOT '[timeout]')", async () => {
    mockMethods.getPullRequest.mockResolvedValue(makeMeta())
    mockMethods.getPullRequestDiff.mockRejectedValue(new GitHubHttpError(403, "forbidden"))
    mockMethods.listPullRequestFiles.mockResolvedValue([])

    const result = await fetchPullRequestContext({
      owner: "Sigilix",
      repo: "rema-portal",
      number: 1,
      env: makeEnv(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context.diff).toBe("[error]")
  })

  it("returns context with filesChanged='[timeout]' when only files aborts", async () => {
    mockMethods.getPullRequest.mockResolvedValue(makeMeta())
    mockMethods.getPullRequestDiff.mockResolvedValue("diff")
    mockMethods.listPullRequestFiles.mockRejectedValue(abortError())

    const result = await fetchPullRequestContext({
      owner: "Sigilix",
      repo: "rema-portal",
      number: 1,
      env: makeEnv(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context.filesChanged).toBe("[timeout]")
    expect(result.context.diff).toBe("diff")
  })

  it("returns context with filesChanged='[error]' on 403 (NOT '[timeout]')", async () => {
    mockMethods.getPullRequest.mockResolvedValue(makeMeta())
    mockMethods.getPullRequestDiff.mockResolvedValue("diff")
    mockMethods.listPullRequestFiles.mockRejectedValue(new GitHubHttpError(403, "forbidden"))

    const result = await fetchPullRequestContext({
      owner: "Sigilix",
      repo: "rema-portal",
      number: 1,
      env: makeEnv(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context.filesChanged).toBe("[error]")
  })

  it("truncates 300-line diff to 250 lines + marker", async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`)
    mockMethods.getPullRequest.mockResolvedValue(makeMeta())
    mockMethods.getPullRequestDiff.mockResolvedValue(lines.join("\n"))
    mockMethods.listPullRequestFiles.mockResolvedValue([])

    const result = await fetchPullRequestContext({
      owner: "Sigilix",
      repo: "rema-portal",
      number: 1,
      env: makeEnv(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok || typeof result.context.diff !== "string") return
    const out = result.context.diff
    const outLines = out.split("\n")
    expect(outLines.length).toBe(251) // 250 lines + 1 marker line
    expect(outLines[outLines.length - 1]).toMatch(/\+50 more lines truncated/)
  })

  it("caps minified single-line diff via per-line + total-char bounds", async () => {
    const minified = "x".repeat(50_000)
    mockMethods.getPullRequest.mockResolvedValue(makeMeta())
    mockMethods.getPullRequestDiff.mockResolvedValue(minified)
    mockMethods.listPullRequestFiles.mockResolvedValue([])

    const result = await fetchPullRequestContext({
      owner: "Sigilix",
      repo: "rema-portal",
      number: 1,
      env: makeEnv(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok || typeof result.context.diff !== "string") return
    expect(result.context.diff.length).toBeLessThanOrEqual(20_000)
    expect(result.context.diff).toContain("[…line truncated…]")
  })

  it("uses changed_files from meta as total even when files list returns fewer", async () => {
    mockMethods.getPullRequest.mockResolvedValue(makeMeta({ changed_files: 60 }))
    mockMethods.getPullRequestDiff.mockResolvedValue("diff")
    mockMethods.listPullRequestFiles.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => ({
        filename: `f${i}.ts`,
        status: "modified",
        additions: 1,
        deletions: 0,
      })),
    )

    const result = await fetchPullRequestContext({
      owner: "Sigilix",
      repo: "rema-portal",
      number: 1,
      env: makeEnv(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok || typeof result.context.filesChanged === "string") return
    expect(result.context.filesChanged.items).toHaveLength(50)
    expect(result.context.filesChanged.total).toBe(60)
  })

  it("infers state='merged' when REST state='closed' and merged_at is set", async () => {
    mockMethods.getPullRequest.mockResolvedValue(makeMeta({ state: "closed", merged_at: "2026-04-29T12:00:00Z" }))
    mockMethods.getPullRequestDiff.mockResolvedValue("d")
    mockMethods.listPullRequestFiles.mockResolvedValue([])

    const result = await fetchPullRequestContext({
      owner: "Sigilix",
      repo: "rema-portal",
      number: 1,
      env: makeEnv(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context.state).toBe("merged")
  })

  it("normalizes malformed state from REST to a safe enum value", async () => {
    mockMethods.getPullRequest.mockResolvedValue(
      makeMeta({ state: "weird-thing" as unknown as PullRequestMeta["state"], merged_at: null }),
    )
    mockMethods.getPullRequestDiff.mockResolvedValue("d")
    mockMethods.listPullRequestFiles.mockResolvedValue([])

    const result = await fetchPullRequestContext({
      owner: "Sigilix",
      repo: "rema-portal",
      number: 1,
      env: makeEnv(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(["open", "closed", "merged"]).toContain(result.context.state)
  })
})
