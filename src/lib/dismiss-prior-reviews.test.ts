// SIG-85 — tests for the prior-review stale-detector helper.
//
// Pre-SIG-85 this helper called `client.dismissReview` directly,
// producing "sigilix [Bot] dismissed their stale review" timeline
// entries. SIG-85 removed the bot-initiated dismissal; the helper now
// LISTS + FILTERS prior reviews and emits a `pr-review-stale-detected`
// telemetry event per match. Customers enable GitHub's repo-level
// "Dismiss stale pull request approvals when new commits are pushed"
// branch-protection setting to get native dismissal with the commit
// pusher as the attributor.
//
// These tests assert the new (non-dismissing) behavior:
//   - `client.dismissReview` is NEVER called.
//   - The listing + filtering logic still picks the same set of
//     prior Sigilix reviews that pre-SIG-85 would have dismissed.
//   - The bilingual matcher (SIG-85) finds legacy `openclaw:pr-review`
//     stickies as well as the current `sigilix:pr-review` form.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { mockListPullRequestReviews, mockDismissReview } = vi.hoisted(() => ({
  mockListPullRequestReviews: vi.fn(),
  mockDismissReview: vi.fn(async () => undefined),
}))

vi.mock("@/shared/adapters/github", async () => {
  const actual = await vi.importActual<typeof import("@/shared/adapters/github")>("@/shared/adapters/github")
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
  LEGACY_REVIEW_BODY_MARKER,
} from "@/lib/dismiss-prior-reviews"
import { GitHubClient } from "@/shared/adapters/github"

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
  // 40-char SHA — retained for back-compat with callers that still
  // pass headSha. SIG-85 no longer uses it (no dismissal message
  // built), but the helper accepts and ignores it.
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
    // don't collide with `headSha` in tests.
    commitId: opts.commitId === undefined
      ? "0000111122223333444455556666777788889999"
      : opts.commitId,
  }
}

function staleDetectedCount(spy: ReturnType<typeof vi.spyOn>): number {
  return spy.mock.calls.filter((call) => {
    const arg = call[0]
    return typeof arg === "string" && arg.includes("pr-review-stale-detected")
  }).length
}

describe("dismissPriorSigilixReviews", () => {
  it("SIG-85: never calls client.dismissReview, even for matching prior Sigilix reviews", async () => {
    mockListPullRequestReviews.mockResolvedValue([
      priorReview({ id: 100, state: "APPROVED" }),
      priorReview({ id: 200, state: "CHANGES_REQUESTED" }),
    ])
    const client = new GitHubClient({ token: "t" })

    const out = await dismissPriorSigilixReviews({ ...baseArgs, client })

    // SIG-85: bot-initiated dismissal removed. Both prior reviews
    // get a `pr-review-stale-detected` event instead.
    expect(out).toEqual({ dismissed: 0, failed: 0 })
    expect(mockDismissReview).not.toHaveBeenCalled()
    expect(staleDetectedCount(logSpy)).toBe(2)
  })

  it("ARC-287: currentReviewId=null still filters every matching prior (no exclusion)", async () => {
    // ARC-287 sentinel: when the helper fires BEFORE submitReview
    // (the new order), there's no current review yet to exclude.
    // `currentReviewId: null` should detect every matching prior
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

    expect(out).toEqual({ dismissed: 0, failed: 0 })
    expect(mockDismissReview).not.toHaveBeenCalled()
    // All three matching priors get a stale-detected event.
    expect(staleDetectedCount(logSpy)).toBe(3)
  })

  it("excludes the just-posted review (currentReviewId is filtered out)", async () => {
    mockListPullRequestReviews.mockResolvedValue([
      priorReview({ id: baseArgs.currentReviewId, state: "APPROVED" }), // our own fresh review
      priorReview({ id: 200, state: "APPROVED" }),
    ])
    const client = new GitHubClient({ token: "t" })

    await dismissPriorSigilixReviews({ ...baseArgs, client })

    expect(mockDismissReview).not.toHaveBeenCalled()
    expect(staleDetectedCount(logSpy)).toBe(1)
    // Stale-detected event references the OTHER review, not our fresh one.
    const staleCall = logSpy.mock.calls.find((call) => {
      const arg = call[0]
      return typeof arg === "string" && arg.includes("pr-review-stale-detected")
    })
    expect(typeof staleCall?.[0]).toBe("string")
    expect(staleCall?.[0] as string).toContain("\"review_id\":200")
    expect(staleCall?.[0] as string).not.toContain(`"review_id":${baseArgs.currentReviewId}`)
  })

  it("never touches reviews from other reviewers (body lacks the Sigilix marker)", async () => {
    mockListPullRequestReviews.mockResolvedValue([
      { id: 100, state: "APPROVED", user: { login: "alice" }, body: "LGTM" },               // human / coderabbit
      { id: 200, state: "CHANGES_REQUESTED", user: { login: "bob" }, body: "fix this" },     // human
      priorReview({ id: 300, state: "APPROVED" }),                                            // sigilix prior
    ])
    const client = new GitHubClient({ token: "t" })

    await dismissPriorSigilixReviews({ ...baseArgs, client })

    expect(mockDismissReview).not.toHaveBeenCalled()
    expect(staleDetectedCount(logSpy)).toBe(1)
  })

  // code-reviewer H1 catch on PR review: defense-in-depth against a
  // human (or another bot) impersonating Sigilix by pasting the
  // `<!-- sigilix:pr-review -->` marker into their own review body.
  // The user-login check guarantees only `sigilix[bot]`-authored
  // reviews are flagged stale even when the body marker matches.
  it("does NOT flag reviews where the body marker matches but author is NOT sigilix[bot]", async () => {
    mockListPullRequestReviews.mockResolvedValue([
      // Sneaky human pasted the marker into their body.
      priorReview({ id: 100, state: "APPROVED", user: { login: "sneaky-human" } }),
      // Bot that's not us, with the marker copied.
      priorReview({ id: 200, state: "APPROVED", user: { login: "evil-bot[bot]" } }),
      // Real Sigilix review.
      priorReview({ id: 300, state: "APPROVED" }),
    ])
    const client = new GitHubClient({ token: "t" })

    await dismissPriorSigilixReviews({ ...baseArgs, client })

    expect(mockDismissReview).not.toHaveBeenCalled()
    expect(staleDetectedCount(logSpy)).toBe(1)
  })

  it("does NOT flag reviews with a null user (defensive — shouldn't happen in practice)", async () => {
    mockListPullRequestReviews.mockResolvedValue([
      priorReview({ id: 100, state: "APPROVED", user: null }),
    ])
    const client = new GitHubClient({ token: "t" })

    await dismissPriorSigilixReviews({ ...baseArgs, client })

    expect(mockDismissReview).not.toHaveBeenCalled()
    expect(staleDetectedCount(logSpy)).toBe(0)
  })

  it("skips reviews in non-dismissible states (COMMENTED / PENDING / DISMISSED)", async () => {
    mockListPullRequestReviews.mockResolvedValue([
      priorReview({ id: 100, state: "COMMENTED" }),  // body has marker but state isn't dismissible
      priorReview({ id: 200, state: "PENDING" }),
      priorReview({ id: 300, state: "DISMISSED" }),
      priorReview({ id: 400, state: "APPROVED" }),    // this one IS flag-worthy
    ])
    const client = new GitHubClient({ token: "t" })

    await dismissPriorSigilixReviews({ ...baseArgs, client })

    expect(mockDismissReview).not.toHaveBeenCalled()
    expect(staleDetectedCount(logSpy)).toBe(1)
  })

  it("returns zero counts when listPullRequestReviews fails", async () => {
    mockListPullRequestReviews.mockRejectedValue(new Error("HTTP 502"))
    const client = new GitHubClient({ token: "t" })

    const out = await dismissPriorSigilixReviews({ ...baseArgs, client })

    expect(out).toEqual({ dismissed: 0, failed: 0 })
    expect(mockDismissReview).not.toHaveBeenCalled()
  })

  it("handles empty review list", async () => {
    mockListPullRequestReviews.mockResolvedValue([])
    const client = new GitHubClient({ token: "t" })

    const out = await dismissPriorSigilixReviews({ ...baseArgs, client })

    expect(out).toEqual({ dismissed: 0, failed: 0 })
    expect(mockDismissReview).not.toHaveBeenCalled()
    expect(staleDetectedCount(logSpy)).toBe(0)
  })

  // SIG-85: bilingual marker matcher. Prior reviews posted under the
  // legacy `<!-- openclaw:pr-review -->` marker must still be
  // recognized as Sigilix reviews so the stale-detector counts them.
  it("SIG-85: bilingual marker — finds prior reviews under the legacy openclaw:pr-review marker", async () => {
    mockListPullRequestReviews.mockResolvedValue([
      // Legacy openclaw marker (pre-rebrand sticky).
      priorReview({
        id: 100,
        state: "APPROVED",
        body: `${LEGACY_REVIEW_BODY_MARKER}\nlegacy body`,
      }),
      // Current sigilix marker (post-rebrand sticky).
      priorReview({
        id: 200,
        state: "CHANGES_REQUESTED",
        body: `${SIGILIX_REVIEW_BODY_MARKER}\ncurrent body`,
      }),
    ])
    const client = new GitHubClient({ token: "t" })

    await dismissPriorSigilixReviews({ ...baseArgs, client })

    expect(mockDismissReview).not.toHaveBeenCalled()
    // Both legacy + current markers count as targets.
    expect(staleDetectedCount(logSpy)).toBe(2)
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
