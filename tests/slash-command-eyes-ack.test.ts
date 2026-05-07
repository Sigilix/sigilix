// ARC-190 Task 10 — slash-command 👀 eye-emoji ack helper unit tests.
//
// Bundled into the ARC-190 PR per the plan but independent of the DO
// architecture. Mirrors the @-mention path's instant ack (see
// `src/lib/github-mention.ts:131-147`) so slash-command users get
// visible feedback within ~1s instead of waiting on queue + LLM.
//
// Dispatch-site integration tests (queueGithubMention wiring) live in
// `tests/slash-command-eyes-ack-dispatch.test.ts`.

import { describe, it, expect, vi } from "vitest"

// Hoisted mocks — vi.mock is hoisted, so use vi.hoisted.
const { getInstallationTokenMock, addReactionToIssueCommentMock, addReactionToReviewCommentMock } = vi.hoisted(() => ({
  getInstallationTokenMock: vi.fn(async () => "fake-token"),
  addReactionToIssueCommentMock: vi.fn(async () => {}),
  addReactionToReviewCommentMock: vi.fn(async () => {}),
}))
vi.mock("../src/lib/github-app", () => ({
  getInstallationToken: getInstallationTokenMock,
}))
vi.mock("../src/lib/github", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/github")>()
  class FakeClient {
    addReactionToIssueComment = addReactionToIssueCommentMock
    addReactionToReviewComment = addReactionToReviewCommentMock
    createIssueComment = vi.fn(async () => ({ id: 1 }))
  }
  return {
    ...actual,
    GitHubClient: FakeClient,
  }
})

import { postSlashCommandEyesAck } from "../src/lib/slash-command-eyes-ack"
import type { Env } from "../src/index"

function makeEnv(): Env {
  return {
    OPENCLAW_STATE: { get: vi.fn(), put: vi.fn(), delete: vi.fn() } as unknown as KVNamespace,
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "k",
  } as unknown as Env
}

describe("postSlashCommandEyesAck — surface routing", () => {
  it("uses addReactionToIssueComment for issue surface", async () => {
    addReactionToIssueCommentMock.mockClear()
    addReactionToReviewCommentMock.mockClear()
    await postSlashCommandEyesAck({
      env: makeEnv(),
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      commentId: 4242,
      surface: "issue",
      installationId: 99,
    })
    expect(addReactionToIssueCommentMock).toHaveBeenCalledOnce()
    expect(addReactionToIssueCommentMock).toHaveBeenCalledWith("Arc-and-Anchor", "sigilix", 4242, "eyes")
    expect(addReactionToReviewCommentMock).not.toHaveBeenCalled()
  })

  it("uses addReactionToReviewComment for review-comment surface", async () => {
    addReactionToIssueCommentMock.mockClear()
    addReactionToReviewCommentMock.mockClear()
    await postSlashCommandEyesAck({
      env: makeEnv(),
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      commentId: 4242,
      surface: "review-comment",
      installationId: 99,
    })
    expect(addReactionToReviewCommentMock).toHaveBeenCalledOnce()
    expect(addReactionToReviewCommentMock).toHaveBeenCalledWith("Arc-and-Anchor", "sigilix", 4242, "eyes")
    expect(addReactionToIssueCommentMock).not.toHaveBeenCalled()
  })
})

describe("postSlashCommandEyesAck — failure swallow", () => {
  it("React API failure is swallowed (resolves; logs warning)", async () => {
    addReactionToIssueCommentMock.mockClear()
    addReactionToIssueCommentMock.mockRejectedValueOnce(new Error("403 Forbidden"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(
      postSlashCommandEyesAck({
        env: makeEnv(),
        owner: "Arc-and-Anchor",
        repo: "sigilix",
        commentId: 4242,
        surface: "issue",
        installationId: 99,
      }),
    ).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("Token mint failure is swallowed", async () => {
    getInstallationTokenMock.mockRejectedValueOnce(new Error("JWT signing failed"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(
      postSlashCommandEyesAck({
        env: makeEnv(),
        owner: "Arc-and-Anchor",
        repo: "sigilix",
        commentId: 4242,
        surface: "issue",
        installationId: 99,
      }),
    ).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("Missing GITHUB_APP_ID / GITHUB_PRIVATE_KEY → swallow + log", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const env = {
      OPENCLAW_STATE: { get: vi.fn(), put: vi.fn(), delete: vi.fn() } as unknown as KVNamespace,
      // GITHUB_APP_ID + GITHUB_PRIVATE_KEY missing
    } as unknown as Env
    await expect(
      postSlashCommandEyesAck({
        env,
        owner: "Arc-and-Anchor",
        repo: "sigilix",
        commentId: 4242,
        surface: "issue",
        installationId: 99,
      }),
    ).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
