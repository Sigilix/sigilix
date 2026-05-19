// SIG-84 — stale-head guards in `handlePrOverview`.
//
// Codex Q4 sign-off: today only the pr-review handler has stale-head
// guards (`triage-pr-review-ensemble.ts:864` + post-review). The
// overview handler must also drop when a NEW commit lands while the
// queued head's overview is still computing — otherwise its
// walkthrough would overwrite either:
//   (a) the new head's `_Reviewing…_` stub (just posted by the
//       webhook handler via `postPrOverviewStubIfNeeded`), or
//   (b) the new head's already-rendered walkthrough.
// Either case moves the overview comment backwards from the customer's
// perspective.

import { beforeEach, describe, expect, it, vi } from "vitest"

const mockGetInstallationToken = vi.fn(async () => "fake-token")
const mockGetPullRequest = vi.fn()
const mockGetPullRequestDiff = vi.fn()
const mockGetPullRequestCommits = vi.fn()
const mockListIssueComments = vi.fn()
const mockCreateIssueComment = vi.fn()
const mockUpdateIssueComment = vi.fn()
const mockGenerate = vi.fn()
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

const QUEUED_HEAD = "a".repeat(40)
const NEW_HEAD = "b".repeat(40)

const baseArgs = {
  owner: "acme",
  repo: "site",
  prNumber: 73,
  headSha: QUEUED_HEAD,
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
  mockGetPullRequestDiff.mockResolvedValue("diff --git a/foo.ts ...\n+const x = 1")
  mockGetPullRequestCommits.mockResolvedValue([])
  mockListIssueComments.mockResolvedValue([])
  mockCreateIssueComment.mockResolvedValue({ id: 12345 })
  mockUpdateIssueComment.mockResolvedValue({})
  mockGenerate.mockResolvedValue(VALID_VERDICT_JSON)
})

describe("handlePrOverview — stale-head guard #1 (pre-Ollama, SIG-84)", () => {
  it("aborts when the live PR head differs from the queued headSha; does NOT call Ollama / post", async () => {
    // First (parallel) getPullRequest call observes the NEW head.
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: NEW_HEAD },
      title: "Stacked push landed mid-flight",
      body: "Body",
    })
    const { kv } = makeKvStub()

    await handlePrOverview({ ...baseArgs, env: makeEnv(kv) })

    expect(mockGenerate).not.toHaveBeenCalled()
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
    expect(mockUpdateIssueComment).not.toHaveBeenCalled()
  })

  it("emits pr-overview-stale-head-before-ollama telemetry on early-out", async () => {
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: NEW_HEAD },
      title: "T",
      body: "B",
    })
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const { kv } = makeKvStub()

    await handlePrOverview({ ...baseArgs, env: makeEnv(kv) })

    const matched = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("pr-overview-stale-head-before-ollama"))
    expect(matched).toBeDefined()
    logSpy.mockRestore()
  })

  it("force: true bypasses guard #1 (post-review refresh path)", async () => {
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: NEW_HEAD },
      title: "T",
      body: "B",
    })
    // For the post-write recheck (NOT bypassed by force, but force does
    // bypass guard #2 too — confirm both).
    const { kv } = makeKvStub()

    await handlePrOverview({ ...baseArgs, env: makeEnv(kv), force: true })

    // Force path proceeds through Ollama + posts the comment.
    expect(mockGenerate).toHaveBeenCalledOnce()
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
  })

  it("does NOT abort when head matches (happy path runs the full pipeline)", async () => {
    mockGetPullRequest.mockResolvedValue({
      head: { sha: QUEUED_HEAD },
      title: "T",
      body: "B",
    })
    const { kv } = makeKvStub()

    await handlePrOverview({ ...baseArgs, env: makeEnv(kv) })

    expect(mockGenerate).toHaveBeenCalledOnce()
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
  })
})

describe("handlePrOverview — stale-head guard #2 (pre-write, SIG-84)", () => {
  it("aborts at the pre-write re-check when the head moved during Ollama", async () => {
    // First (parallel) call: head matches → continue past guard #1.
    // Second call (the pre-write re-check): head is now NEW_HEAD.
    mockGetPullRequest
      .mockResolvedValueOnce({ head: { sha: QUEUED_HEAD }, title: "T", body: "B" })
      .mockResolvedValueOnce({ head: { sha: NEW_HEAD }, title: "T", body: "B" })
    const { kv } = makeKvStub()

    await handlePrOverview({ ...baseArgs, env: makeEnv(kv) })

    // Ollama ran (post-guard-#1) but we did NOT write the comment.
    expect(mockGenerate).toHaveBeenCalledOnce()
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
    expect(mockUpdateIssueComment).not.toHaveBeenCalled()
  })

  it("emits pr-overview-stale-head-before-write telemetry on the late-abort path", async () => {
    mockGetPullRequest
      .mockResolvedValueOnce({ head: { sha: QUEUED_HEAD }, title: "T", body: "B" })
      .mockResolvedValueOnce({ head: { sha: NEW_HEAD }, title: "T", body: "B" })
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const { kv } = makeKvStub()

    await handlePrOverview({ ...baseArgs, env: makeEnv(kv) })

    const matched = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("pr-overview-stale-head-before-write"))
    expect(matched).toBeDefined()
    logSpy.mockRestore()
  })

  it("falls through to the write when the re-check throws (best-effort, don't drop a good overview)", async () => {
    mockGetPullRequest
      .mockResolvedValueOnce({ head: { sha: QUEUED_HEAD }, title: "T", body: "B" })
      .mockRejectedValueOnce(new Error("503"))
    const { kv } = makeKvStub()

    await handlePrOverview({ ...baseArgs, env: makeEnv(kv) })

    expect(mockGenerate).toHaveBeenCalledOnce()
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
  })
})
