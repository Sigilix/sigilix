// ARC-231 — pr-overview duplicate-comment race regression.
//
// Two `pull_request` webhooks (opened + synchronize) arriving close in time
// can both reach the listIssueComments → no-marker branch and POST a
// duplicate sticky-summary comment. KV is eventually consistent across
// regions so the existing `dedupeKey` guard is advisory, not atomic.
//
// Stage 1 mitigation (Codex APPROVE-WITH-NOTES, bundled into ARC-156):
// re-run findExistingOverviewComment after Ollama returns. If a sibling
// Worker posted the marker during the 10-30s model window, PATCH that
// comment instead of POSTing a second one. Stage 2 (Durable Object port
// mirroring ARC-190) is a separate ticket.

import { beforeEach, describe, expect, it, vi } from "vitest"

const mockGetInstallationToken = vi.fn(async () => "fake-token")
const mockGetPullRequest = vi.fn()
const mockGetPullRequestDiff = vi.fn()
const mockGetPullRequestCommits = vi.fn()
const mockListIssueComments = vi.fn()
const mockCreateIssueComment = vi.fn()
const mockUpdateIssueComment = vi.fn()
const mockGenerate = vi.fn()
const mockGetFileContent = vi.fn(async () => null)
// ARC-263: handlePrOverview now also calls listPullRequestFiles for
// the walkthrough cache. Default to an empty list — the race tests
// don't care about per-file caching; they assert dedupe/race behavior.
const mockListPullRequestFiles = vi.fn(async () => [])
// SIG-216 CR fix-up: the read-after-write idempotency rescan
// (`findExistingOverviewComment`) calls `listIssueCommentsPage`.
// Default the page mock to an empty array so the existing tests
// — which expect a clean POST when both scans see no marker —
// land in the create branch with the final rescan returning null.
const mockListIssueCommentsPage = vi.fn(async () => [])

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
      createIssueComment: (...args: unknown[]) => mockCreateIssueComment(...args),
      updateIssueComment: (...args: unknown[]) => mockUpdateIssueComment(...args),
      listPullRequestFiles: (...args: unknown[]) => mockListPullRequestFiles(...args),
      getFileContent: (...args: unknown[]) => mockGetFileContent(...args),
    })),
  }
})

// SIG-212: adapt legacy string-returning mockGenerate to the new
// `{ text, usage }` return shape.
vi.mock("@/src/shared/adapters/model/ollama", () => ({
  generate: async (args: unknown) => {
    const result = await mockGenerate(args)
    return typeof result === "string" ? { text: result, usage: {} } : result
  },
}))

import { handlePrOverview } from "@/src/lib/triage-pr-overview"
import type { Env } from "@/src/shared/types/env"

function makeKvStub() {
  const store = new Map<string, string>()
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value)
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store }
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

const VALID_VERDICT_JSON = JSON.stringify({
  summary: "Adds a regex guard around path normalization.",
  confidence: 4,
  confidenceReason: "Small surface, well-tested.",
  files: [{ path: "src/foo.ts", score: 4, overview: "Guard added", nextStep: "Add a fuzz test" }],
  bullets: ["Verify the regex catches `..` segments"],
})

const args = {
  owner: "acme",
  repo: "site",
  prNumber: 73,
  headSha: "h".repeat(40),
  installationId: 1,
}

beforeEach(() => {
  mockGetInstallationToken.mockClear()
  mockGetPullRequest.mockClear()
  mockGetPullRequestDiff.mockClear()
  mockGetPullRequestCommits.mockClear()
  mockListIssueComments.mockClear()
  mockListIssueCommentsPage.mockClear()
  mockListIssueCommentsPage.mockImplementation(async () => [])
  mockCreateIssueComment.mockClear()
  mockUpdateIssueComment.mockClear()
  mockGenerate.mockClear()
  mockGetFileContent.mockClear()
  mockGetFileContent.mockImplementation(async () => null)
  mockGetPullRequest.mockResolvedValue({
    head: { sha: args.headSha, ref: "feature" },
    base: { sha: "b".repeat(40), ref: "main" },
    title: "Some PR",
    body: "Body",
  })
  mockGetPullRequestDiff.mockResolvedValue("diff --git a/foo.ts ...\n+const x = 1")
  mockGetPullRequestCommits.mockResolvedValue([])
  mockCreateIssueComment.mockResolvedValue({ id: 12345 })
  mockUpdateIssueComment.mockResolvedValue({})
  mockGenerate.mockResolvedValue(VALID_VERDICT_JSON)
})

describe("handlePrOverview — CODEOWNERS suggested reviewers (SIG-150)", () => {
  it("merges CODEOWNERS reviewers from the base branch into the SIG-99 reviewer slot", async () => {
    mockGetPullRequest.mockResolvedValue({
      head: { sha: args.headSha, ref: "feature" },
      base: { sha: "b".repeat(40), ref: "main" },
      title: "Some PR",
      body: "Body",
      user: { login: "alice" },
    })
    mockListIssueComments.mockResolvedValue([])
    mockListPullRequestFiles.mockResolvedValue([
      {
        filename: "src/foo.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1 +1 @@",
      },
    ])
    mockGetFileContent.mockImplementation(async (_owner: string, _repo: string, path: string, ref: string) => {
      if (path === ".github/CODEOWNERS" && ref === "b".repeat(40)) {
        return "*.ts @fallback\n/src/** @alice @bob @acme/platform\n"
      }
      return null
    })
    mockGenerate.mockResolvedValue(
      JSON.stringify({
        summary: "Adds a regex guard around path normalization.",
        confidence: 4,
        confidenceReason: "Small surface, well-tested.",
        files: [{ path: "src/foo.ts", score: 4, overview: "Guard added", nextStep: "Add a fuzz test" }],
        bullets: ["Verify the regex catches `..` segments"],
        suggestedReviewers: ["alice", "charlie"],
      }),
    )
    const { kv } = makeKvStub()

    await handlePrOverview({ ...args, env: makeEnv(kv) })

    const body = mockCreateIssueComment.mock.calls[0]?.[3] as string
    expect(body).toContain("**Suggested reviewers:** @bob, @charlie")
    expect(body).not.toContain("@alice")
    expect(body).not.toContain("@acme/platform")
    expect(mockGetFileContent).toHaveBeenCalledWith("acme", "site", ".github/CODEOWNERS", "b".repeat(40))
  })

  it("falls back to model-only reviewers when the base branch has no CODEOWNERS file", async () => {
    mockListIssueComments.mockResolvedValue([])
    mockListPullRequestFiles.mockResolvedValue([
      {
        filename: "src/foo.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1 +1 @@",
      },
    ])
    mockGenerate.mockResolvedValue(
      JSON.stringify({
        summary: "Adds a regex guard around path normalization.",
        confidence: 4,
        confidenceReason: "Small surface, well-tested.",
        files: [{ path: "src/foo.ts", score: 4, overview: "Guard added", nextStep: "Add a fuzz test" }],
        bullets: ["Verify the regex catches `..` segments"],
        suggestedReviewers: ["model-owner"],
      }),
    )
    const { kv } = makeKvStub()

    await handlePrOverview({ ...args, env: makeEnv(kv) })

    const body = mockCreateIssueComment.mock.calls[0]?.[3] as string
    expect(body).toContain("**Suggested reviewers:** @model-owner")
  })

  it("checks lower-priority CODEOWNERS locations only when higher-priority files are missing", async () => {
    mockListIssueComments.mockResolvedValue([])
    mockListPullRequestFiles.mockResolvedValue([
      {
        filename: "src/foo.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1 +1 @@",
      },
    ])
    mockGetFileContent.mockImplementation(async (_owner: string, _repo: string, path: string) => {
      if (path === "CODEOWNERS") return "*.ts @root-owner\n"
      return null
    })
    mockGenerate.mockResolvedValue(
      JSON.stringify({
        summary: "Adds a regex guard around path normalization.",
        confidence: 4,
        confidenceReason: "Small surface, well-tested.",
        files: [{ path: "src/foo.ts", score: 4, overview: "Guard added", nextStep: "Add a fuzz test" }],
        bullets: ["Verify the regex catches `..` segments"],
        suggestedReviewers: ["model-owner"],
      }),
    )
    const { kv } = makeKvStub()

    await handlePrOverview({ ...args, env: makeEnv(kv) })

    const body = mockCreateIssueComment.mock.calls[0]?.[3] as string
    expect(body).toContain("**Suggested reviewers:** @root-owner, @model-owner")
    const codeownersCalls = mockGetFileContent.mock.calls.filter((call) =>
      [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"].includes(call[2] as string),
    )
    expect(codeownersCalls).toEqual([
      ["acme", "site", ".github/CODEOWNERS", "b".repeat(40)],
      ["acme", "site", "CODEOWNERS", "b".repeat(40)],
    ])
  })

  it("fails closed on non-404 CODEOWNERS fetch errors instead of using a lower-priority file", async () => {
    mockListIssueComments.mockResolvedValue([])
    mockListPullRequestFiles.mockResolvedValue([
      {
        filename: "src/foo.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1 +1 @@",
      },
    ])
    mockGetFileContent.mockImplementation(async (_owner: string, _repo: string, path: string) => {
      if (path === ".github/CODEOWNERS") throw new Error("rate limited")
      if (path === "CODEOWNERS") return "*.ts @root-owner\n"
      return null
    })
    mockGenerate.mockResolvedValue(
      JSON.stringify({
        summary: "Adds a regex guard around path normalization.",
        confidence: 4,
        confidenceReason: "Small surface, well-tested.",
        files: [{ path: "src/foo.ts", score: 4, overview: "Guard added", nextStep: "Add a fuzz test" }],
        bullets: ["Verify the regex catches `..` segments"],
        suggestedReviewers: ["model-owner"],
      }),
    )
    const { kv } = makeKvStub()

    await handlePrOverview({ ...args, env: makeEnv(kv) })

    const body = mockCreateIssueComment.mock.calls[0]?.[3] as string
    expect(body).toContain("**Suggested reviewers:** @model-owner")
    expect(body).not.toContain("@root-owner")
    const codeownersCalls = mockGetFileContent.mock.calls.filter((call) =>
      [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"].includes(call[2] as string),
    )
    expect(codeownersCalls).toEqual([["acme", "site", ".github/CODEOWNERS", "b".repeat(40)]])
  })

  it("does not read CODEOWNERS from the head SHA when PR metadata has no base SHA", async () => {
    mockGetPullRequest.mockResolvedValue({
      head: { sha: args.headSha, ref: "feature" },
      title: "Some PR",
      body: "Body",
    })
    mockListIssueComments.mockResolvedValue([])
    mockListPullRequestFiles.mockResolvedValue([
      {
        filename: "src/foo.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1 +1 @@",
      },
    ])
    mockGetFileContent.mockImplementation(async (_owner: string, _repo: string, path: string) => {
      if (path === ".github/CODEOWNERS") return "*.ts @head-owner\n"
      return null
    })
    mockGenerate.mockResolvedValue(
      JSON.stringify({
        summary: "Adds a regex guard around path normalization.",
        confidence: 4,
        confidenceReason: "Small surface, well-tested.",
        files: [{ path: "src/foo.ts", score: 4, overview: "Guard added", nextStep: "Add a fuzz test" }],
        bullets: ["Verify the regex catches `..` segments"],
        suggestedReviewers: ["model-owner"],
      }),
    )
    const { kv } = makeKvStub()

    await handlePrOverview({ ...args, env: makeEnv(kv) })

    const body = mockCreateIssueComment.mock.calls[0]?.[3] as string
    expect(body).toContain("**Suggested reviewers:** @model-owner")
    expect(body).not.toContain("@head-owner")
    const codeownersCalls = mockGetFileContent.mock.calls.filter((call) =>
      [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"].includes(call[2] as string),
    )
    expect(codeownersCalls).toEqual([])
  })
})

describe("handlePrOverview — 2nd-pass dedupe (ARC-231)", () => {
  it("PATCHes a marker discovered during the Ollama window instead of POSTing a second comment", async () => {
    // Sibling Worker posts the marker between our first scan and the
    // post-Ollama re-scan. First listIssueComments → []; second → [marker].
    mockListIssueComments
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 999, body: "<!-- sigilix:pr-overview -->\n## Sigilix Overview\nold" }])
    const { kv } = makeKvStub()

    await handlePrOverview({ ...args, env: makeEnv(kv) })

    expect(mockGenerate).toHaveBeenCalledOnce()
    expect(mockListIssueComments).toHaveBeenCalledTimes(2)
    expect(mockUpdateIssueComment).toHaveBeenCalledOnce()
    expect(mockUpdateIssueComment.mock.calls[0]![2]).toBe(999)
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
  })

  it("emits pr-overview-second-pass-dedupe-fired telemetry when the late re-check catches a marker", async () => {
    mockListIssueComments
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 777, body: "<!-- sigilix:pr-overview -->\nbody" }])
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const { kv } = makeKvStub()

    await handlePrOverview({ ...args, env: makeEnv(kv) })

    const log = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("pr-overview-second-pass-dedupe-fired"))
    expect(log).toBeDefined()
    const parsed = JSON.parse(log!)
    expect(parsed.owner).toBe("acme")
    expect(parsed.repo).toBe("site")
    expect(parsed.prNumber).toBe(73)
    expect(parsed.foundCommentId).toBe(777)
    logSpy.mockRestore()
  })

  it("renders the late-discovered update as an incremental run, not a first-run summary", async () => {
    mockListIssueComments
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 999, body: "<!-- sigilix:pr-overview -->\nold" }])
    const { kv } = makeKvStub()

    await handlePrOverview({ ...args, env: makeEnv(kv) })

    const body = mockUpdateIssueComment.mock.calls[0]![3] as string
    expect(body).toContain("### Summary — latest push")
  })

  it("POSTs as usual when both scans see no marker (no race)", async () => {
    mockListIssueComments.mockResolvedValue([])
    const { kv } = makeKvStub()

    await handlePrOverview({ ...args, env: makeEnv(kv) })

    expect(mockListIssueComments).toHaveBeenCalledTimes(2)
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
    expect(mockUpdateIssueComment).not.toHaveBeenCalled()
  })

  it("skips the late re-check when the first scan already found a marker (PATCH on existing)", async () => {
    mockListIssueComments.mockResolvedValueOnce([{ id: 555, body: "<!-- sigilix:pr-overview -->\nprior" }])
    const { kv } = makeKvStub()

    await handlePrOverview({ ...args, env: makeEnv(kv) })

    expect(mockListIssueComments).toHaveBeenCalledTimes(1)
    expect(mockUpdateIssueComment).toHaveBeenCalledOnce()
    expect(mockUpdateIssueComment.mock.calls[0]![2]).toBe(555)
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
  })

  // ARC-258 follow-up: the pr-review success path enqueues a forced
  // pr-overview refresh to clear any stale warmup-callout marker. The
  // refresh must bypass the per-(PR, headSha) dedupe (set by the
  // initial pr-overview run earlier in the same headSha) — without
  // bypass, the refresh would be silently suppressed for 5 min.
  it("force: true bypasses the dedupe lock so a refresh runs within the same headSha", async () => {
    const { kv, store } = makeKvStub()
    // Seed the dedupe key from a prior pr-overview run on this headSha.
    store.set(`pr-overview:${args.owner}/${args.repo}#${args.prNumber}@${args.headSha}`, String(Date.now()))
    mockListIssueComments.mockResolvedValue([])

    await handlePrOverview({ ...args, env: makeEnv(kv), force: true })

    // Despite the dedupe key being present, the run proceeded: it
    // hit Ollama (one call) and posted the comment.
    expect(mockGenerate).toHaveBeenCalledOnce()
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
  })

  it("force: true does NOT release the dedupe lock (avoids stomping a sibling non-force run)", async () => {
    const { kv, store } = makeKvStub()
    const dedupeKey = `pr-overview:${args.owner}/${args.repo}#${args.prNumber}@${args.headSha}`
    store.set(dedupeKey, "sibling-marker")
    mockListIssueComments.mockResolvedValue([])

    await handlePrOverview({ ...args, env: makeEnv(kv), force: true })

    // The dedupe key the SIBLING set is still present after the force run.
    expect(store.get(dedupeKey)).toBe("sibling-marker")
  })

  it("force: undefined (default) still honors the dedupe lock", async () => {
    const { kv, store } = makeKvStub()
    store.set(`pr-overview:${args.owner}/${args.repo}#${args.prNumber}@${args.headSha}`, String(Date.now()))
    mockListIssueComments.mockResolvedValue([])

    await handlePrOverview({ ...args, env: makeEnv(kv) })

    expect(mockGenerate).not.toHaveBeenCalled()
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
  })
})

// SIG-216 CR fix-up — read-after-write idempotency on the create
// path. `runInlineOverviewWithRetry` retries `handlePrOverview` end-
// to-end with `skipDedupe: true`. If attempt #1's
// `createIssueComment` succeeded server-side but the response failed
// transiently, attempt #2's pre-Ollama + post-Ollama `scanComments`
// snapshots may both still miss the just-written marker (KV / list-
// comments propagation lag). A final targeted rescan immediately
// before the POST catches that case and switches to PATCH.
describe("handlePrOverview — final-rescan idempotency on create (SIG-216)", () => {
  it("PATCHes when both scanComments snapshots miss the marker but the final rescan finds it (retry race)", async () => {
    // Both `listIssueComments` calls (pre-Ollama + post-Ollama) see
    // an empty list — the marker hadn't propagated yet. The final
    // targeted rescan (`listIssueCommentsPage`, page 1) DOES see
    // the marker — that's the just-written-but-not-yet-listable
    // comment from a retried attempt #1. Asserts: PATCH on the
    // discovered id, NO duplicate POST.
    mockListIssueComments.mockResolvedValue([])
    mockListIssueCommentsPage.mockResolvedValueOnce([
      { id: 4242, body: "<!-- sigilix:pr-overview -->\nfrom attempt #1" },
    ])
    const { kv } = makeKvStub()

    await handlePrOverview({ ...args, env: makeEnv(kv), skipDedupe: true })

    expect(mockGenerate).toHaveBeenCalledOnce()
    // Both scanComments snapshots ran (pre-Ollama + post-Ollama).
    expect(mockListIssueComments).toHaveBeenCalledTimes(2)
    // The final rescan fired once (page 1, short-circuited on the
    // marker hit before any further pages).
    expect(mockListIssueCommentsPage).toHaveBeenCalledTimes(1)
    expect(mockUpdateIssueComment).toHaveBeenCalledOnce()
    expect(mockUpdateIssueComment.mock.calls[0]![2]).toBe(4242)
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
  })

  it("emits pr-overview-final-rescan-found-marker telemetry on the race-hit path", async () => {
    mockListIssueComments.mockResolvedValue([])
    mockListIssueCommentsPage.mockResolvedValueOnce([
      { id: 8181, body: "<!-- sigilix:pr-overview -->\nfrom attempt #1" },
    ])
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const { kv } = makeKvStub()

    await handlePrOverview({ ...args, env: makeEnv(kv), skipDedupe: true })

    const log = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("pr-overview-final-rescan-found-marker"))
    expect(log).toBeDefined()
    const parsed = JSON.parse(log!)
    expect(parsed.owner).toBe("acme")
    expect(parsed.repo).toBe("site")
    expect(parsed.prNumber).toBe(73)
    expect(parsed.foundCommentId).toBe(8181)
    logSpy.mockRestore()
  })

  it("POSTs once when every rescan (pre-Ollama, post-Ollama, AND final) sees no marker (no race)", async () => {
    // Normal create path: nothing exists, nothing surfaces in any
    // of the three reads. POST should fire exactly once.
    mockListIssueComments.mockResolvedValue([])
    mockListIssueCommentsPage.mockResolvedValue([])
    const { kv } = makeKvStub()

    await handlePrOverview({ ...args, env: makeEnv(kv) })

    expect(mockListIssueComments).toHaveBeenCalledTimes(2)
    // Final rescan still fires before the POST, but finds nothing
    // → falls through to the actual create call.
    expect(mockListIssueCommentsPage).toHaveBeenCalled()
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
    expect(mockUpdateIssueComment).not.toHaveBeenCalled()
  })
})
