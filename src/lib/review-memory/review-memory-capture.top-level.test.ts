// ARC-189 / SIG-185 — top-level explicit-correlation capture tests.
//
// Sibling of review-memory-capture.test.ts (split out under
// SIG-318/SIG-376 to keep each suite ≤1,000 lines). Shares pure fixtures
// via review-memory-capture.test-helpers.ts. This block does not override
// the marker module, so no per-file `vi.mock` is replicated here.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import {
  captureTopLevelReviewFeedback,
  hasExplicitTopLevelReviewFeedbackSignal,
} from "@/lib/review-memory/capture"
import type { GitHubClient } from "@/shared/adapters/github"
import {
  makeKvStub,
  makeEnv,
  makeConfig,
  VALID_MARKER,
  OTHER_VALID_MARKER,
  VALID_FINGERPRINT,
  VALID_FINGERPRINT_2,
  PRECISION_FINDING_MARKERS,
  SECOND_PRECISION_FINDING_MARKERS,
} from "@/lib/review-memory/review-memory-capture.test-helpers"

describe("captureTopLevelReviewFeedback — explicit verified source", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  })
  afterEach(() => {
    consoleSpy.mockRestore()
  })

  function makeTopLevelClient(sourceBody: string, authorLogin = "sigilix[bot]"): GitHubClient {
    return {
      listIssueComments: vi.fn(async () => []),
      listPullRequestReviewComments: vi.fn(async () => [
        {
          id: 500,
          body: sourceBody,
          path: "src/lib/foo.ts",
          line: 10,
          original_line: 10,
          user: { login: authorLogin },
        },
      ]),
      listPullRequestReviews: vi.fn(async () => []),
      getPullRequest: vi.fn(async () => ({
        number: 7,
        title: "PR",
        body: "",
        user: { login: "human" },
        head: { sha: "head", ref: "branch" },
        base: { sha: "base", ref: "main" },
      })),
      getRepository: vi.fn(async () => ({ default_branch: "main", id: 555_000 })),
    } as unknown as GitHubClient
  }

  it("prefilters ordinary PR comments before token/config work", () => {
    expect(hasExplicitTopLevelReviewFeedbackSignal("Looks good to me")).toBe(false)
    expect(hasExplicitTopLevelReviewFeedbackSignal(`${VALID_MARKER}\n\nfalse positive`)).toBe(true)
    expect(hasExplicitTopLevelReviewFeedbackSignal(`${PRECISION_FINDING_MARKERS}\n\nGood catch`)).toBe(true)
  })

  it("captures a top-level dismissal only after verifying the copied marker against a Sigilix-authored source", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const sourceBody = `${PRECISION_FINDING_MARKERS}\n\n${VALID_MARKER}`
    const client = makeTopLevelClient(sourceBody)
    await captureTopLevelReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 7,
      comment: {
        id: 900,
        body: `> copied finding\n> ${VALID_MARKER}\n\nfalse positive`,
      },
      config: makeConfig(),
    })
    const catRecord = JSON.parse(store.get("review-memory:a/r:cat:performance")!)
    expect(catRecord.signals).toHaveLength(1)
    expect(catRecord.signals[0].commentId).toBe(900)
    const pathKeys = Array.from(store.keys()).filter((k) =>
      k.startsWith("review-memory:a/r:path:"),
    )
    expect(pathKeys).toHaveLength(1)
    const profile = JSON.parse(store.get("precision-profile:repo:a/r")!)
    expect(profile.patterns[VALID_FINGERPRINT].suppress).toBe(0.3)
  })

  it("does not trust a copied marker when no Sigilix-authored source matches it", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeTopLevelClient(`${PRECISION_FINDING_MARKERS}\n\n${VALID_MARKER}`, "human")
    await captureTopLevelReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 7,
      comment: {
        id: 900,
        body: `${VALID_MARKER}\n\nfalse positive`,
      },
      config: makeConfig(),
    })
    expect(Array.from(store.keys()).some((k) => k.startsWith("review-memory:"))).toBe(false)
    expect(store.get("precision-profile:repo:a/r")).toBeUndefined()
    const skipped = consoleSpy.mock.calls
      .map((a) => String(a[0]))
      .find((s) => s.includes("not-a-reply-to-sigilix"))
    expect(skipped).toBeDefined()
  })

  it("verifies top-level feedback against a Sigilix-authored formal review body", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = {
      listIssueComments: vi.fn(async () => []),
      listPullRequestReviewComments: vi.fn(async () => []),
      listPullRequestReviews: vi.fn(async () => [
        {
          id: 800,
          state: "CHANGES_REQUESTED",
          body: `${PRECISION_FINDING_MARKERS}\n\n${SECOND_PRECISION_FINDING_MARKERS}`,
          user: { login: "sigilix[bot]" },
          commitId: "old-head",
        },
      ]),
      getPullRequest: vi.fn(async () => ({
        number: 7,
        title: "PR",
        body: "",
        user: { login: "human" },
        head: { sha: "head", ref: "branch" },
        base: { sha: "base", ref: "main" },
      })),
      getRepository: vi.fn(async () => ({ default_branch: "main", id: 555_000 })),
    } as unknown as GitHubClient
    await captureTopLevelReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 7,
      comment: {
        id: 900,
        body: `${SECOND_PRECISION_FINDING_MARKERS}\n\nGood catch`,
      },
      config: makeConfig(),
    })
    expect(Array.from(store.keys()).some((k) => k.startsWith("review-memory:"))).toBe(false)
    const profile = JSON.parse(store.get("precision-profile:repo:a/r")!)
    expect(profile.patterns[VALID_FINGERPRINT_2].suppress).toBe(0)
    expect(profile.categories.security.boost).toBe(0.3)
  })

  it("prefers marker-bearing inline sources over body-only formal review matches", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = {
      listIssueComments: vi.fn(async () => []),
      listPullRequestReviewComments: vi.fn(async () => [
        {
          id: 500,
          body: `${PRECISION_FINDING_MARKERS}\n\n${VALID_MARKER}`,
          path: "src/lib/foo.ts",
          line: 10,
          original_line: 10,
          user: { login: "sigilix[bot]" },
        },
      ]),
      listPullRequestReviews: vi.fn(async () => [
        {
          id: 800,
          state: "CHANGES_REQUESTED",
          body: PRECISION_FINDING_MARKERS,
          user: { login: "sigilix[bot]" },
          commitId: "old-head",
        },
      ]),
      getPullRequest: vi.fn(async () => ({
        number: 7,
        title: "PR",
        body: "",
        user: { login: "human" },
        head: { sha: "head", ref: "branch" },
        base: { sha: "base", ref: "main" },
      })),
      getRepository: vi.fn(async () => ({ default_branch: "main", id: 555_000 })),
    } as unknown as GitHubClient
    await captureTopLevelReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 7,
      comment: {
        id: 900,
        body: `${PRECISION_FINDING_MARKERS}\n\nfalse positive`,
      },
      config: makeConfig(),
    })
    const catRecord = JSON.parse(store.get("review-memory:a/r:cat:performance")!)
    expect(catRecord.signals).toHaveLength(1)
    const pathKeys = Array.from(store.keys()).filter((k) =>
      k.startsWith("review-memory:a/r:path:"),
    )
    expect(pathKeys).toHaveLength(1)
  })

  it("prefers exact copied-marker matches over earlier generic fingerprint matches", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = {
      listIssueComments: vi.fn(async () => []),
      listPullRequestReviewComments: vi.fn(async () => [
        {
          id: 500,
          body: `${PRECISION_FINDING_MARKERS}\n\n${OTHER_VALID_MARKER}`,
          path: "src/lib/other.ts",
          line: 10,
          original_line: 10,
          user: { login: "sigilix[bot]" },
        },
        {
          id: 501,
          body: `${PRECISION_FINDING_MARKERS}\n\n${VALID_MARKER}`,
          path: "src/lib/foo.ts",
          line: 20,
          original_line: 20,
          user: { login: "sigilix[bot]" },
        },
      ]),
      listPullRequestReviews: vi.fn(async () => []),
      getPullRequest: vi.fn(async () => ({
        number: 7,
        title: "PR",
        body: "",
        user: { login: "human" },
        head: { sha: "head", ref: "branch" },
        base: { sha: "base", ref: "main" },
      })),
      getRepository: vi.fn(async () => ({ default_branch: "main", id: 555_000 })),
    } as unknown as GitHubClient
    await captureTopLevelReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 7,
      comment: {
        id: 900,
        body: `${VALID_MARKER}\n\n${PRECISION_FINDING_MARKERS}\n\nfalse positive`,
      },
      config: makeConfig(),
    })
    const performanceRecord = JSON.parse(store.get("review-memory:a/r:cat:performance")!)
    expect(performanceRecord.signals[0].fid).toBe("1111111111111111")
    expect(store.get("review-memory:a/r:cat:security")).toBeUndefined()
  })

  it("exits cleanly when no source review comments are available to verify the marker", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = {
      listIssueComments: vi.fn(async () => []),
      listPullRequestReviewComments: vi.fn(async () => []),
      listPullRequestReviews: vi.fn(async () => []),
      getPullRequest: vi.fn(async () => ({
        number: 7,
        title: "PR",
        body: "",
        user: { login: "human" },
        head: { sha: "head", ref: "branch" },
        base: { sha: "base", ref: "main" },
      })),
      getRepository: vi.fn(async () => ({ default_branch: "main", id: 555_000 })),
    } as unknown as GitHubClient
    await captureTopLevelReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 7,
      comment: {
        id: 900,
        body: `${VALID_MARKER}\n\nfalse positive`,
      },
      config: makeConfig(),
    })
    expect(Array.from(store.keys()).some((k) => k.startsWith("review-memory:"))).toBe(false)
    expect(store.get("precision-profile:repo:a/r")).toBeUndefined()
    const skipped = consoleSpy.mock.calls
      .map((a) => String(a[0]))
      .find((s) => s.includes("not-a-reply-to-sigilix"))
    expect(skipped).toBeDefined()
  })
})
