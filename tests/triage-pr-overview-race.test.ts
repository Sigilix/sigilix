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
// ARC-263: handlePrOverview now also calls listPullRequestFiles for
// the walkthrough cache. Default to an empty list — the race tests
// don't care about per-file caching; they assert dedupe/race behavior.
const mockListPullRequestFiles = vi.fn(async () => [])

vi.mock("../src/lib/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("../src/lib/github", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/github")>("../src/lib/github")
  return {
    ...actual,
    GitHubClient: vi.fn().mockImplementation(() => ({
      getPullRequest: (...args: unknown[]) => mockGetPullRequest(...args),
      getPullRequestDiff: (...args: unknown[]) => mockGetPullRequestDiff(...args),
      getPullRequestCommits: (...args: unknown[]) => mockGetPullRequestCommits(...args),
      listIssueComments: (...args: unknown[]) => mockListIssueComments(...args),
      createIssueComment: (...args: unknown[]) => mockCreateIssueComment(...args),
      updateIssueComment: (...args: unknown[]) => mockUpdateIssueComment(...args),
      listPullRequestFiles: (...args: unknown[]) => mockListPullRequestFiles(...args),
    })),
  }
})

vi.mock("../src/lib/ollama", () => ({
  generate: (args: unknown) => mockGenerate(args),
}))

import { handlePrOverview } from "../src/lib/triage-pr-overview"
import type { Env } from "../src/index"

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
  mockCreateIssueComment.mockClear()
  mockUpdateIssueComment.mockClear()
  mockGenerate.mockClear()
  mockGetPullRequest.mockResolvedValue({
    head: { sha: args.headSha },
    title: "Some PR",
    body: "Body",
  })
  mockGetPullRequestDiff.mockResolvedValue("diff --git a/foo.ts ...\n+const x = 1")
  mockGetPullRequestCommits.mockResolvedValue([])
  mockCreateIssueComment.mockResolvedValue({ id: 12345 })
  mockUpdateIssueComment.mockResolvedValue({})
  mockGenerate.mockResolvedValue(VALID_VERDICT_JSON)
})

describe("handlePrOverview — 2nd-pass dedupe (ARC-231)", () => {
  it("PATCHes a marker discovered during the Ollama window instead of POSTing a second comment", async () => {
    // Sibling Worker posts the marker between our first scan and the
    // post-Ollama re-scan. First listIssueComments → []; second → [marker].
    mockListIssueComments
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 999, body: "<!-- openclaw:pr-overview -->\n## Sigilix Overview\nold" },
      ])
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
      .mockResolvedValueOnce([
        { id: 777, body: "<!-- openclaw:pr-overview -->\nbody" },
      ])
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
      .mockResolvedValueOnce([
        { id: 999, body: "<!-- openclaw:pr-overview -->\nold" },
      ])
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
    mockListIssueComments.mockResolvedValueOnce([
      { id: 555, body: "<!-- openclaw:pr-overview -->\nprior" },
    ])
    const { kv } = makeKvStub()

    await handlePrOverview({ ...args, env: makeEnv(kv) })

    expect(mockListIssueComments).toHaveBeenCalledTimes(1)
    expect(mockUpdateIssueComment).toHaveBeenCalledOnce()
    expect(mockUpdateIssueComment.mock.calls[0]![2]).toBe(555)
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
  })
})
