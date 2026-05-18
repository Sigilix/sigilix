// ARC-258 follow-up — tests for the prior-review dismissal helper.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { mockListPullRequestReviews, mockDismissReview } = vi.hoisted(() => ({
  mockListPullRequestReviews: vi.fn(),
  mockDismissReview: vi.fn(async () => undefined),
}))

vi.mock("../src/lib/github", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/github")>("../src/lib/github")
  class GitHubClientMock {
    async listPullRequestReviews(...args: unknown[]): Promise<unknown> {
      return mockListPullRequestReviews(...args)
    }
    async dismissReview(...args: unknown[]): Promise<unknown> {
      return mockDismissReview(...args)
    }
  }
  return { ...actual, GitHubClient: GitHubClientMock }
})

import {
  dismissPriorSigilixReviews,
  SIGILIX_REVIEW_BODY_MARKER,
} from "../src/lib/dismiss-prior-reviews"
import { GitHubClient } from "../src/lib/github"

let logSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  mockListPullRequestReviews.mockReset()
  mockDismissReview.mockReset().mockResolvedValue(undefined)
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  // Targeted spy restoration only (code-reviewer L3): grab the spy
  // handle in beforeEach so we restore the SAME spy, not a new
  // no-op. `vi.restoreAllMocks` would strip the GitHubClient
  // constructor's `mockImplementation` factory and break the next
  // test.
  logSpy.mockRestore()
  warnSpy.mockRestore()
})

const baseArgs = {
  owner: "Arc-and-Anchor",
  repo: "sigilix",
  prNumber: 42,
  currentReviewId: 1000,
  // 40-char SHA — short(headSha) will trim to the first 7 chars
  // (`abcdef1`) for display in the dismissal message.
  headSha: "abcdef1234567890abcdef1234567890abcdef12",
} as const

function priorReview(opts: {
  id: number
  state: string
  body?: string
  user?: { login: string } | null
  commitId?: string | null
}): { id: number; state: string; user: { login: string } | null; body: string; commitId: string | null } {
  return {
    id: opts.id,
    state: opts.state,
    body: opts.body ?? `${SIGILIX_REVIEW_BODY_MARKER}\nfoo`,
    user: opts.user === undefined ? { login: "sigilix[bot]" } : opts.user,
    // Default to a non-overlapping 40-char SHA so prior-review SHAs
    // don't collide with `headSha` in the dismissal-message tests.
    commitId: opts.commitId === undefined
      ? "0000111122223333444455556666777788889999"
      : opts.commitId,
  }
}

describe("dismissPriorSigilixReviews", () => {
  it("dismisses prior Sigilix APPROVED + CHANGES_REQUESTED reviews", async () => {
    mockListPullRequestReviews.mockResolvedValue([
      priorReview({ id: 100, state: "APPROVED" }),
      priorReview({ id: 200, state: "CHANGES_REQUESTED" }),
    ])
    const client = new GitHubClient({ token: "t" })

    const out = await dismissPriorSigilixReviews({ ...baseArgs, client })

    expect(out).toEqual({ dismissed: 2, failed: 0 })
    expect(mockDismissReview).toHaveBeenCalledTimes(2)
    const ids = mockDismissReview.mock.calls.map((c) => c[3])
    expect(ids.sort()).toEqual([100, 200])
  })

  it("ARC-287: currentReviewId=null dismisses ALL matching priors (dismiss-then-post sentinel)", async () => {
    // ARC-287 sentinel: when the helper fires BEFORE submitReview
    // (the new order), there's no current review yet to exclude.
    // `currentReviewId: null` should dismiss every matching prior
    // Sigilix review without the per-id filter kicking in.
    mockListPullRequestReviews.mockResolvedValue([
      priorReview({ id: 100, state: "APPROVED" }),
      priorReview({ id: 200, state: "CHANGES_REQUESTED" }),
      priorReview({ id: 300, state: "APPROVED" }),
    ])
    const client = new GitHubClient({ token: "t" })

    const out = await dismissPriorSigilixReviews({
      ...baseArgs,
      currentReviewId: null,
      client,
    })

    // All three matching priors get dismissed — no exclusion.
    expect(out).toEqual({ dismissed: 3, failed: 0 })
    expect(mockDismissReview).toHaveBeenCalledTimes(3)
    const ids = mockDismissReview.mock.calls.map((c) => c[3])
    expect(ids.sort()).toEqual([100, 200, 300])
  })

  it("never dismisses the just-posted review (currentReviewId is excluded)", async () => {
    mockListPullRequestReviews.mockResolvedValue([
      priorReview({ id: baseArgs.currentReviewId, state: "APPROVED" }), // our own fresh review
      priorReview({ id: 200, state: "APPROVED" }),
    ])
    const client = new GitHubClient({ token: "t" })

    const out = await dismissPriorSigilixReviews({ ...baseArgs, client })

    expect(out.dismissed).toBe(1)
    expect(mockDismissReview).toHaveBeenCalledWith(
      "Arc-and-Anchor", "sigilix", 42, 200, expect.any(String),
    )
    expect(mockDismissReview).not.toHaveBeenCalledWith(
      "Arc-and-Anchor", "sigilix", 42, baseArgs.currentReviewId, expect.any(String),
    )
  })

  it("never touches reviews from other reviewers (body lacks the Sigilix marker)", async () => {
    mockListPullRequestReviews.mockResolvedValue([
      { id: 100, state: "APPROVED", user: { login: "alice" }, body: "LGTM" },               // human / coderabbit
      { id: 200, state: "CHANGES_REQUESTED", user: { login: "bob" }, body: "fix this" },     // human
      priorReview({ id: 300, state: "APPROVED" }),                                            // sigilix prior
    ])
    const client = new GitHubClient({ token: "t" })

    const out = await dismissPriorSigilixReviews({ ...baseArgs, client })

    expect(out.dismissed).toBe(1)
    expect(mockDismissReview).toHaveBeenCalledTimes(1)
    expect(mockDismissReview.mock.calls[0]?.[3]).toBe(300)
  })

  // code-reviewer H1 catch on PR review: defense-in-depth against a
  // human (or another bot) impersonating Sigilix by pasting the
  // `<!-- sigilix:pr-review -->` marker into their own review body.
  // The user-login check guarantees only `sigilix[bot]`-authored
  // reviews are dismissed even when the body marker matches.
  it("does NOT dismiss reviews where the body marker matches but author is NOT sigilix[bot]", async () => {
    mockListPullRequestReviews.mockResolvedValue([
      // Sneaky human pasted the marker into their body.
      priorReview({ id: 100, state: "APPROVED", user: { login: "sneaky-human" } }),
      // Bot that's not us, with the marker copied.
      priorReview({ id: 200, state: "APPROVED", user: { login: "evil-bot[bot]" } }),
      // Real Sigilix review.
      priorReview({ id: 300, state: "APPROVED" }),
    ])
    const client = new GitHubClient({ token: "t" })

    const out = await dismissPriorSigilixReviews({ ...baseArgs, client })

    expect(out.dismissed).toBe(1)
    expect(mockDismissReview).toHaveBeenCalledTimes(1)
    expect(mockDismissReview.mock.calls[0]?.[3]).toBe(300)
  })

  it("does NOT dismiss reviews with a null user (defensive — shouldn't happen in practice)", async () => {
    mockListPullRequestReviews.mockResolvedValue([
      priorReview({ id: 100, state: "APPROVED", user: null }),
    ])
    const client = new GitHubClient({ token: "t" })

    const out = await dismissPriorSigilixReviews({ ...baseArgs, client })

    expect(out.dismissed).toBe(0)
    expect(mockDismissReview).not.toHaveBeenCalled()
  })

  it("skips reviews in non-dismissible states (COMMENTED / PENDING / DISMISSED)", async () => {
    mockListPullRequestReviews.mockResolvedValue([
      priorReview({ id: 100, state: "COMMENTED" }),  // body has marker but state isn't dismissible
      priorReview({ id: 200, state: "PENDING" }),
      priorReview({ id: 300, state: "DISMISSED" }),
      priorReview({ id: 400, state: "APPROVED" }),    // this one IS dismissible
    ])
    const client = new GitHubClient({ token: "t" })

    const out = await dismissPriorSigilixReviews({ ...baseArgs, client })

    expect(out.dismissed).toBe(1)
    expect(mockDismissReview.mock.calls[0]?.[3]).toBe(400)
  })

  it("returns zero counts when listPullRequestReviews fails", async () => {
    mockListPullRequestReviews.mockRejectedValue(new Error("HTTP 502"))
    const client = new GitHubClient({ token: "t" })

    const out = await dismissPriorSigilixReviews({ ...baseArgs, client })

    expect(out).toEqual({ dismissed: 0, failed: 0 })
    expect(mockDismissReview).not.toHaveBeenCalled()
  })

  it("isolates per-review dismissal failures (some succeed, some fail)", async () => {
    mockListPullRequestReviews.mockResolvedValue([
      priorReview({ id: 100, state: "APPROVED" }),
      priorReview({ id: 200, state: "APPROVED" }),
      priorReview({ id: 300, state: "APPROVED" }),
    ])
    let n = 0
    mockDismissReview.mockImplementation(async () => {
      n += 1
      if (n === 2) throw new Error("HTTP 422 already dismissed")
      return undefined
    })
    const client = new GitHubClient({ token: "t" })

    const out = await dismissPriorSigilixReviews({ ...baseArgs, client })

    expect(out).toEqual({ dismissed: 2, failed: 1 })
  })

  it("handles empty review list", async () => {
    mockListPullRequestReviews.mockResolvedValue([])
    const client = new GitHubClient({ token: "t" })

    const out = await dismissPriorSigilixReviews({ ...baseArgs, client })

    expect(out).toEqual({ dismissed: 0, failed: 0 })
    expect(mockDismissReview).not.toHaveBeenCalled()
  })

  it("dismissal message starts with 'Stale' and names the new head SHA when provided (ARC-293 minimal)", async () => {
    mockListPullRequestReviews.mockResolvedValue([
      priorReview({ id: 100, state: "APPROVED" }),
    ])
    const client = new GitHubClient({ token: "t" })

    await dismissPriorSigilixReviews({ ...baseArgs, client })

    const message = mockDismissReview.mock.calls[0]?.[4] as string
    expect(typeof message).toBe("string")
    // ARC-293: the dismissal banner GitHub renders already says
    // "sigilix [Bot] dismissed their stale review" with a link to the
    // dismissed review, so our expansion-box message only needs to
    // carry the one extra bit — which SHA Sigilix re-reviewed at.
    expect(message).toMatch(/^Stale/)
    expect(message).toContain("abcdef1") // 7-char SHA of the new head
  })

  it("dismissal message omits the new-head clause when headSha is not provided (backwards compat)", async () => {
    mockListPullRequestReviews.mockResolvedValue([
      priorReview({ id: 100, state: "APPROVED" }),
    ])
    const client = new GitHubClient({ token: "t" })

    // Call without headSha (legacy callers).
    const { headSha: _unused, ...argsWithoutHead } = baseArgs
    await dismissPriorSigilixReviews({ ...argsWithoutHead, client })

    const message = mockDismissReview.mock.calls[0]?.[4] as string
    expect(message).toMatch(/^Stale/)
    expect(message).not.toMatch(/Re-reviewed/i)
  })

  it("dismissal message drops the new-head clause when headSha is shorter than 7 chars (short() <7 branch)", async () => {
    // `short()` returns null when sha.length < 7. The dismissal
    // message must still be coherent — no empty backticks or stray
    // "Re-reviewed at ``" suffix.
    mockListPullRequestReviews.mockResolvedValue([
      priorReview({ id: 100, state: "APPROVED", commitId: "abc123" }),
    ])
    const client = new GitHubClient({ token: "t" })

    await dismissPriorSigilixReviews({
      ...baseArgs,
      client,
      headSha: "def456", // 6 chars — under threshold
    })

    const message = mockDismissReview.mock.calls[0]?.[4] as string
    expect(message).toMatch(/^Stale/)
    expect(message).not.toMatch(/Re-reviewed/i)
    expect(message).not.toMatch(/`\s*`/) // no empty backticks
  })

  // code-reviewer M2 catch: warn when the list-call hits the 100-cap
  // so we notice if a real PR ever accumulates that many reviews.
  it("logs a cap-warning when listPullRequestReviews returns 100 items", async () => {
    const many = Array.from({ length: 100 }, (_, i) => priorReview({ id: 9000 + i, state: "APPROVED" }))
    mockListPullRequestReviews.mockResolvedValue(many)
    const client = new GitHubClient({ token: "t" })

    await dismissPriorSigilixReviews({ ...baseArgs, client })

    const warnedAboutCap = warnSpy.mock.calls.some((call) => {
      const arg = call[0]
      return typeof arg === "string" && arg.includes("pr-review-dismiss-list-capped")
    })
    expect(warnedAboutCap).toBe(true)
  })

  it("does not log the cap-warning when the list is small", async () => {
    mockListPullRequestReviews.mockResolvedValue([
      priorReview({ id: 100, state: "APPROVED" }),
    ])
    const client = new GitHubClient({ token: "t" })

    await dismissPriorSigilixReviews({ ...baseArgs, client })

    const warnedAboutCap = warnSpy.mock.calls.some((call) => {
      const arg = call[0]
      return typeof arg === "string" && arg.includes("pr-review-dismiss-list-capped")
    })
    expect(warnedAboutCap).toBe(false)
  })
})
