// SIG-545 A: Integration tests for the @sigilix make a linear triage command
// wired into handleGithubMention.
//
// Test coverage:
//   (a) mode=on + trusted author + triage command → runLinearTriageAction called,
//       created reply posted, Q&A fanout NOT run, dedupe record written
//   (b) mode=off → triage branch skipped, Q&A proceeds (runLinearTriageAction NOT called)
//   (c) mode=shadow → would-create log, no runLinearTriageAction, no reply
//   (d) normal question (no triage command) → no runLinearTriageAction, Q&A runs
//   (e) untrusted author + triage command → no runLinearTriageAction, no reply
//   (f) prior dedupe record → replies with prior issue, no runLinearTriageAction

import { beforeEach, describe, expect, it, vi } from "vitest"

// ─── Hoisted mocks ─────────────────────────────────────────────────────────

const {
  getInstallationTokenMock,
  listIssueCommentsMock,
  listPullRequestReviewCommentsMock,
  addReactionToIssueCommentMock,
  addReactionToReviewCommentMock,
  listPullRequestReviewsMock,
  dismissReviewMock,
  createIssueCommentMock,
  replyToReviewCommentMock,
  getPullRequestMock,
  getPullRequestDiffMock,
} = vi.hoisted(() => ({
  getInstallationTokenMock: vi.fn(async () => "fake-token"),
  listIssueCommentsMock: vi.fn(),
  listPullRequestReviewCommentsMock: vi.fn(),
  addReactionToIssueCommentMock: vi.fn(),
  addReactionToReviewCommentMock: vi.fn(),
  listPullRequestReviewsMock: vi.fn(),
  dismissReviewMock: vi.fn(),
  createIssueCommentMock: vi.fn(),
  replyToReviewCommentMock: vi.fn(),
  getPullRequestMock: vi.fn(),
  getPullRequestDiffMock: vi.fn(),
}))

vi.mock("@/src/shared/adapters/github/github-app", () => ({
  getInstallationToken: getInstallationTokenMock,
}))

vi.mock("@/src/shared/adapters/github", async (importActual) => {
  const actual = await importActual<typeof import("@/src/shared/adapters/github")>()
  class FakeGitHubClient {
    listIssueComments = listIssueCommentsMock
    listPullRequestReviewComments = listPullRequestReviewCommentsMock
    addReactionToIssueComment = addReactionToIssueCommentMock
    addReactionToReviewComment = addReactionToReviewCommentMock
    listPullRequestReviews = listPullRequestReviewsMock
    dismissReview = dismissReviewMock
    createIssueComment = createIssueCommentMock
    replyToReviewComment = replyToReviewCommentMock
    getPullRequest = getPullRequestMock
    getPullRequestDiff = getPullRequestDiffMock
  }
  return {
    ...actual,
    GitHubClient: FakeGitHubClient,
  }
})

// Mock runLinearTriageAction only — keep resolveGithubLinearTriageMode and
// parseLinearTriageCommand as real implementations (driven via env + question).
const { runLinearTriageActionMock } = vi.hoisted(() => ({
  runLinearTriageActionMock: vi.fn(),
}))

vi.mock("@/src/lib/github-mention-linear-triage", async (importActual) => {
  const actual = await importActual<typeof import("@/src/lib/github-mention-linear-triage")>()
  return {
    ...actual,
    runLinearTriageAction: runLinearTriageActionMock,
  }
})

// Stub generate so the Q&A fanout short-circuits without a real LLM call.
// Returning non-JSON text makes parseGithubMentionResponse return null →
// the handler logs "verdict did not parse" and returns — no postReply.
const { generateMock } = vi.hoisted(() => ({
  generateMock: vi.fn(async () => ({ text: "not-valid-json-verdict", usage: {} })),
}))
vi.mock("@/src/shared/adapters/model", () => ({
  generate: generateMock,
}))

// Stub retrieval to return empty chunks so we avoid network calls.
vi.mock("@/src/lib/retrieval", () => ({
  retrieveChunks: vi.fn(async () => []),
  formatChunksForPrompt: vi.fn(() => null),
}))

// ─── Imports (after all vi.mock calls) ─────────────────────────────────────

import { handleGithubMention } from "@/src/lib/github-mention"
import type { Env } from "@/src/shared/types/env"

// ─── Helpers ───────────────────────────────────────────────────────────────

const TRIAGE_COMMENT_BODY = "@sigilix make a linear triage"
const NORMAL_COMMENT_BODY = "@sigilix what does this PR do?"

const FAKE_PR = {
  title: "Fix the flaky test",
  body: "This PR fixes the flaky test in the auth module.",
  head: { sha: "abc123", ref: "fix-flaky-test" },
}

const LINEAR_RESULT = {
  kind: "created" as const,
  identifier: "SIG-1",
  url: "https://linear.app/sigilix/issue/SIG-1",
  triaged: true,
}

function makeEnv(
  triageMode: string | undefined,
  initial: Record<string, string> = {},
): { env: Env; store: Map<string, string> } {
  const store = new Map(Object.entries(initial))
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key)
    }),
  } as unknown as KVNamespace

  const env: Env = {
    OPENCLAW_STATE: kv,
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "private-key",
    ...(triageMode !== undefined ? { OPENCLAW_GITHUB_LINEAR_TRIAGE_MODE: triageMode } : {}),
  } as unknown as Env

  return { env, store }
}

function makeSourceComment(
  body: string,
  authorAssociation: string,
  id = 4242,
): Record<string, unknown> {
  return {
    id,
    body,
    user: { login: "dev-human" },
    author_association: authorAssociation,
  }
}

const BASE_ARGS = {
  owner: "Sigilix",
  repo: "sigilix",
  prNumber: 7,
  installationId: 99,
  surface: "issue" as const,
  commentId: 4242,
}

// ─── Setup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  getInstallationTokenMock.mockResolvedValue("fake-token")
  addReactionToIssueCommentMock.mockResolvedValue(undefined)
  addReactionToReviewCommentMock.mockResolvedValue(undefined)
  createIssueCommentMock.mockResolvedValue({ id: 777 })
  replyToReviewCommentMock.mockResolvedValue({ id: 888 })
  getPullRequestMock.mockResolvedValue(FAKE_PR)
  getPullRequestDiffMock.mockResolvedValue("")
  generateMock.mockResolvedValue({ text: "not-valid-json-verdict", usage: {} })
  runLinearTriageActionMock.mockResolvedValue(LINEAR_RESULT)
})

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("handleGithubMention — linear triage branch", () => {
  it("(a) mode=on + trusted author + triage command: runLinearTriageAction called, created reply posted, Q&A NOT run, dedupe written", async () => {
    const { env, store } = makeEnv("on")
    listIssueCommentsMock.mockResolvedValue([makeSourceComment(TRIAGE_COMMENT_BODY, "OWNER")])

    await handleGithubMention({ ...BASE_ARGS, env })

    // runLinearTriageAction was called with the right PR args
    expect(runLinearTriageActionMock).toHaveBeenCalledOnce()
    expect(runLinearTriageActionMock).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        owner: "Sigilix",
        repo: "sigilix",
        prNumber: 7,
        title: FAKE_PR.title,
        body: FAKE_PR.body,
        author: "dev-human",
        prUrl: "https://github.com/Sigilix/sigilix/pull/7",
      }),
    )

    // Reply posted with the created issue identifier
    expect(createIssueCommentMock).toHaveBeenCalledOnce()
    expect(createIssueCommentMock).toHaveBeenCalledWith(
      "Sigilix",
      "sigilix",
      7,
      expect.stringContaining("**SIG-1**"),
    )
    expect(createIssueCommentMock).toHaveBeenCalledWith(
      "Sigilix",
      "sigilix",
      7,
      expect.stringContaining("https://linear.app/sigilix/issue/SIG-1"),
    )

    // Q&A fanout did NOT run (generate was not called)
    expect(generateMock).not.toHaveBeenCalled()

    // Dedupe record was written
    expect(store.get("linear-triage:4242")).toBe("SIG-1|https://linear.app/sigilix/issue/SIG-1")
  })

  it("(a2) mode=on, created with triaged:false → reply omits '— triaged'", async () => {
    const { env } = makeEnv("on")
    listIssueCommentsMock.mockResolvedValue([makeSourceComment(TRIAGE_COMMENT_BODY, "MEMBER")])
    runLinearTriageActionMock.mockResolvedValue({ ...LINEAR_RESULT, triaged: false })

    await handleGithubMention({ ...BASE_ARGS, env })

    expect(createIssueCommentMock).toHaveBeenCalledWith(
      "Sigilix",
      "sigilix",
      7,
      expect.not.stringContaining("— triaged"),
    )
    expect(createIssueCommentMock).toHaveBeenCalledWith(
      "Sigilix",
      "sigilix",
      7,
      expect.stringContaining("**SIG-1**"),
    )
  })

  it("(a3) mode=on, no-team result → setup-guidance reply, no dedupe written", async () => {
    const { env, store } = makeEnv("on")
    listIssueCommentsMock.mockResolvedValue([makeSourceComment(TRIAGE_COMMENT_BODY, "COLLABORATOR")])
    runLinearTriageActionMock.mockResolvedValue({ kind: "no-team" })

    await handleGithubMention({ ...BASE_ARGS, env })

    expect(createIssueCommentMock).toHaveBeenCalledWith(
      "Sigilix",
      "sigilix",
      7,
      expect.stringContaining("OPENCLAW_GITHUB_REPO_LINEAR_TEAM_MAP"),
    )
    expect(store.has("linear-triage:4242")).toBe(false)
  })

  it("(a4) mode=on, error result → degraded reply, no dedupe written", async () => {
    const { env, store } = makeEnv("on")
    listIssueCommentsMock.mockResolvedValue([makeSourceComment(TRIAGE_COMMENT_BODY, "OWNER")])
    runLinearTriageActionMock.mockResolvedValue({ kind: "error", message: "timeout" })

    await handleGithubMention({ ...BASE_ARGS, env })

    expect(createIssueCommentMock).toHaveBeenCalledWith(
      "Sigilix",
      "sigilix",
      7,
      expect.stringContaining("couldn't create"),
    )
    expect(store.has("linear-triage:4242")).toBe(false)
  })

  it("(b) mode=off → triage branch skipped, Q&A proceeds (runLinearTriageAction NOT called)", async () => {
    const { env } = makeEnv("off")
    listIssueCommentsMock.mockResolvedValue([makeSourceComment(TRIAGE_COMMENT_BODY, "OWNER")])

    await handleGithubMention({ ...BASE_ARGS, env })

    // Triage not triggered
    expect(runLinearTriageActionMock).not.toHaveBeenCalled()

    // Q&A heavy fanout ran (generate was called)
    expect(generateMock).toHaveBeenCalled()
  })

  it("(c) mode=shadow → would-create log, no runLinearTriageAction, no reply", async () => {
    const consoleSpy = vi.spyOn(console, "log")
    const { env } = makeEnv("shadow")
    listIssueCommentsMock.mockResolvedValue([makeSourceComment(TRIAGE_COMMENT_BODY, "OWNER")])

    await handleGithubMention({ ...BASE_ARGS, env })

    expect(runLinearTriageActionMock).not.toHaveBeenCalled()
    expect(createIssueCommentMock).not.toHaveBeenCalled()
    // Would-create event logged
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("github-linear-triage-would-create"),
    )
    consoleSpy.mockRestore()
  })

  it("(d) normal question (no triage command), mode=on → no runLinearTriageAction, Q&A runs", async () => {
    const { env } = makeEnv("on")
    listIssueCommentsMock.mockResolvedValue([makeSourceComment(NORMAL_COMMENT_BODY, "OWNER")])

    await handleGithubMention({ ...BASE_ARGS, env })

    expect(runLinearTriageActionMock).not.toHaveBeenCalled()
    expect(generateMock).toHaveBeenCalled()
  })

  it("(e) untrusted author + triage command, mode=on → no runLinearTriageAction, no reply", async () => {
    const { env } = makeEnv("on")
    listIssueCommentsMock.mockResolvedValue([makeSourceComment(TRIAGE_COMMENT_BODY, "NONE")])

    await handleGithubMention({ ...BASE_ARGS, env })

    expect(runLinearTriageActionMock).not.toHaveBeenCalled()
    expect(createIssueCommentMock).not.toHaveBeenCalled()
    expect(generateMock).not.toHaveBeenCalled()
  })

  it("(e2) FIRST_TIME_CONTRIBUTOR + triage command, mode=on → rejected", async () => {
    const { env } = makeEnv("on")
    listIssueCommentsMock.mockResolvedValue([makeSourceComment(TRIAGE_COMMENT_BODY, "FIRST_TIME_CONTRIBUTOR")])

    await handleGithubMention({ ...BASE_ARGS, env })

    expect(runLinearTriageActionMock).not.toHaveBeenCalled()
    expect(createIssueCommentMock).not.toHaveBeenCalled()
  })

  it("(f) prior dedupe record → replies with prior issue, no runLinearTriageAction re-create", async () => {
    const priorValue = "SIG-42|https://linear.app/sigilix/issue/SIG-42"
    const { env } = makeEnv("on", { "linear-triage:4242": priorValue })
    listIssueCommentsMock.mockResolvedValue([makeSourceComment(TRIAGE_COMMENT_BODY, "OWNER")])

    await handleGithubMention({ ...BASE_ARGS, env })

    // No new issue created
    expect(runLinearTriageActionMock).not.toHaveBeenCalled()

    // Reply references the prior issue
    expect(createIssueCommentMock).toHaveBeenCalledWith(
      "Sigilix",
      "sigilix",
      7,
      expect.stringContaining("**SIG-42**"),
    )
    expect(createIssueCommentMock).toHaveBeenCalledWith(
      "Sigilix",
      "sigilix",
      7,
      expect.stringContaining("https://linear.app/sigilix/issue/SIG-42"),
    )
  })
})
