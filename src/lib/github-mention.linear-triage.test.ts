// SIG-545 A: Integration tests for the @sigilix make a linear triage command
// wired into handleGithubMention.
//
// Test coverage:
//   (a) triage command → handleLinearTriageCommand returns handled+reply → reply posted, Q&A NOT run
//   (a2) handleLinearTriageCommand returns reply without "— triaged" → omitted correctly
//   (a3) handleLinearTriageCommand returns no-team reply → setup-guidance reply posted
//   (a4) handleLinearTriageCommand returns error reply → degraded reply posted
//   (b) mode=off scenario → handleLinearTriageCommand returns {handled:false} → Q&A proceeds
//   (c) mode=shadow scenario → handleLinearTriageCommand returns {handled:true, reply:null} → no reply
//   (d) normal question (no triage cmd) → handleLinearTriageCommand returns {handled:false} → Q&A runs
//   (e) untrusted author + triage cmd → handleLinearTriageCommand returns {handled:true, reply:null}
//   (f) prior dedupe record → handleLinearTriageCommand returns "Already created" reply

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

// Mock handleLinearTriageCommand — keeps parseLinearTriageCommand / resolveGithubLinearTriageMode
// as real implementations but short-circuits the async triage action entirely.
// This is the right boundary: internal calls within handleLinearTriageCommand (runLinearTriageAction,
// KV reads) are not interceptable from outside the module under ESM, so we mock at this level.
const { handleLinearTriageCommandMock } = vi.hoisted(() => ({
  handleLinearTriageCommandMock: vi.fn(),
}))

vi.mock("@/src/lib/github-mention-linear-triage", async (importActual) => {
  const actual = await importActual<typeof import("@/src/lib/github-mention-linear-triage")>()
  return {
    ...actual,
    handleLinearTriageCommand: handleLinearTriageCommandMock,
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

function makeEnv(triageMode: string | undefined): { env: Env } {
  const kv = {
    get: vi.fn(async () => null),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  } as unknown as KVNamespace

  const env: Env = {
    OPENCLAW_STATE: kv,
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "private-key",
    ...(triageMode !== undefined ? { OPENCLAW_GITHUB_LINEAR_TRIAGE_MODE: triageMode } : {}),
  } as unknown as Env

  return { env }
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
  // Default: triage not handled → Q&A proceeds. Tests that want the triage branch
  // to "handle" the request override this before calling handleGithubMention.
  handleLinearTriageCommandMock.mockResolvedValue({ handled: false })
})

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("handleGithubMention — linear triage branch", () => {
  it("(a) triage command handled with reply: reply posted, Q&A NOT run", async () => {
    const { env } = makeEnv("on")
    listIssueCommentsMock.mockResolvedValue([makeSourceComment(TRIAGE_COMMENT_BODY, "OWNER")])
    handleLinearTriageCommandMock.mockResolvedValue({
      handled: true,
      reply: "Created **SIG-1** — triaged: https://linear.app/sigilix/issue/SIG-1",
    })

    await handleGithubMention({ ...BASE_ARGS, env })

    // handleLinearTriageCommand was called with the right args
    expect(handleLinearTriageCommandMock).toHaveBeenCalledOnce()
    expect(handleLinearTriageCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        owner: "Sigilix",
        repo: "sigilix",
        prNumber: 7,
        commentId: 4242,
        authorLogin: "dev-human",
        question: "make a linear triage",
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
  })

  it("(a2) reply without '— triaged' text is passed through unchanged", async () => {
    const { env } = makeEnv("on")
    listIssueCommentsMock.mockResolvedValue([makeSourceComment(TRIAGE_COMMENT_BODY, "MEMBER")])
    handleLinearTriageCommandMock.mockResolvedValue({
      handled: true,
      reply: "Created **SIG-1**: https://linear.app/sigilix/issue/SIG-1",
    })

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

  it("(a3) no-team reply: setup-guidance reply posted", async () => {
    const { env } = makeEnv("on")
    listIssueCommentsMock.mockResolvedValue([makeSourceComment(TRIAGE_COMMENT_BODY, "COLLABORATOR")])
    handleLinearTriageCommandMock.mockResolvedValue({
      handled: true,
      reply: "No Linear team is configured for this repo — an admin can set `OPENCLAW_GITHUB_REPO_LINEAR_TEAM_MAP`.",
    })

    await handleGithubMention({ ...BASE_ARGS, env })

    expect(createIssueCommentMock).toHaveBeenCalledWith(
      "Sigilix",
      "sigilix",
      7,
      expect.stringContaining("OPENCLAW_GITHUB_REPO_LINEAR_TEAM_MAP"),
    )
  })

  it("(a4) error reply: degraded message posted", async () => {
    const { env } = makeEnv("on")
    listIssueCommentsMock.mockResolvedValue([makeSourceComment(TRIAGE_COMMENT_BODY, "OWNER")])
    handleLinearTriageCommandMock.mockResolvedValue({
      handled: true,
      reply: "I couldn't create the Linear issue just now — please try again.",
    })

    await handleGithubMention({ ...BASE_ARGS, env })

    expect(createIssueCommentMock).toHaveBeenCalledWith(
      "Sigilix",
      "sigilix",
      7,
      expect.stringContaining("couldn't create"),
    )
  })

  it("(b) mode=off → handleLinearTriageCommand returns {handled:false} → Q&A proceeds", async () => {
    const { env } = makeEnv("off")
    listIssueCommentsMock.mockResolvedValue([makeSourceComment(TRIAGE_COMMENT_BODY, "OWNER")])
    // Default mock: {handled:false} — simulates mode=off behavior

    await handleGithubMention({ ...BASE_ARGS, env })

    // Q&A heavy fanout ran (generate was called)
    expect(generateMock).toHaveBeenCalled()
  })

  it("(c) mode=shadow → {handled:true, reply:null} → no reply, no Q&A", async () => {
    const { env } = makeEnv("shadow")
    listIssueCommentsMock.mockResolvedValue([makeSourceComment(TRIAGE_COMMENT_BODY, "OWNER")])
    handleLinearTriageCommandMock.mockResolvedValue({ handled: true, reply: null })

    await handleGithubMention({ ...BASE_ARGS, env })

    expect(createIssueCommentMock).not.toHaveBeenCalled()
    expect(generateMock).not.toHaveBeenCalled()
  })

  it("(d) normal question (no triage command), mode=on → {handled:false} → Q&A runs", async () => {
    const { env } = makeEnv("on")
    listIssueCommentsMock.mockResolvedValue([makeSourceComment(NORMAL_COMMENT_BODY, "OWNER")])
    // Default mock: {handled:false}

    await handleGithubMention({ ...BASE_ARGS, env })

    expect(generateMock).toHaveBeenCalled()
  })

  it("(e) untrusted author + triage command, mode=on → {handled:true, reply:null} → no reply", async () => {
    const { env } = makeEnv("on")
    listIssueCommentsMock.mockResolvedValue([makeSourceComment(TRIAGE_COMMENT_BODY, "NONE")])
    handleLinearTriageCommandMock.mockResolvedValue({ handled: true, reply: null })

    await handleGithubMention({ ...BASE_ARGS, env })

    expect(createIssueCommentMock).not.toHaveBeenCalled()
    expect(generateMock).not.toHaveBeenCalled()
  })

  it("(e2) FIRST_TIME_CONTRIBUTOR + triage command, mode=on → rejected", async () => {
    const { env } = makeEnv("on")
    listIssueCommentsMock.mockResolvedValue([makeSourceComment(TRIAGE_COMMENT_BODY, "FIRST_TIME_CONTRIBUTOR")])
    handleLinearTriageCommandMock.mockResolvedValue({ handled: true, reply: null })

    await handleGithubMention({ ...BASE_ARGS, env })

    expect(createIssueCommentMock).not.toHaveBeenCalled()
  })

  it("(f) prior dedupe record → replies with prior issue identifier", async () => {
    const { env } = makeEnv("on")
    listIssueCommentsMock.mockResolvedValue([makeSourceComment(TRIAGE_COMMENT_BODY, "OWNER")])
    handleLinearTriageCommandMock.mockResolvedValue({
      handled: true,
      reply: "Already created **SIG-42** for this comment: https://linear.app/sigilix/issue/SIG-42",
    })

    await handleGithubMention({ ...BASE_ARGS, env })

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
