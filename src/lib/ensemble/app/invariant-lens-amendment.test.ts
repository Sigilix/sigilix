import { describe, expect, it, vi } from "vitest"
import { parseDiffToReviewablePositions } from "@/src/shared/util/diff-positions"
import type { InvariantLensApplyResult } from "@/src/lib/ensemble/app/invariant-lens"
import {
  INVARIANT_LENS_AMENDMENT_MARKER,
  runInvariantLensAmendment,
} from "@/src/lib/ensemble/app/invariant-lens-amendment"
import type { Env } from "@/src/shared/types/env"
import type { SubmitReviewBody } from "@/src/shared/types/github"

const HEAD = "a".repeat(40)
const DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -0,0 +1,3 @@",
  "+const priceCents = amountDollars",
  "+charge(priceCents)",
  "+export const ok = true",
].join("\n")

function env(): Env {
  return {
    OPENCLAW_STATE: {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    },
  } as unknown as Env
}

function lensResult(score = 4): InvariantLensApplyResult {
  return {
    lensFindingIds: ["logic-2"],
    verdicts: [
      {
        role: "logic",
        elapsedMs: 1,
        verdict: {
          summary: "logic pass",
          confidence: 5,
          findings: [
            {
              id: "logic-1",
              path: "src/app.ts",
              line: 1,
              score: 2,
              category: "logic",
              headline: "Lower severity baseline finding",
              body: "This pre-existing finding should not drive the amendment.",
            },
            {
              id: "logic-2",
              path: "src/app.ts",
              line: 1,
              score,
              category: "logic",
              headline: "Charge receives dollars as cents",
              body: "The new code assigns a dollar-denominated value to priceCents before charging.",
            },
          ],
        },
      },
    ],
  } as unknown as InvariantLensApplyResult
}

function client(
  overrides: {
    currentHead?: string
    existingReviews?: Array<{
      id: number
      body: string
      user: { login: string } | null
      state: string
      commitId: string
    }>
    failVerifyLookup?: boolean
    submitReview?: (body: SubmitReviewBody) => Promise<{ id: number; state: string }>
  } = {},
) {
  const submitted: SubmitReviewBody[] = []
  const submitReview = vi.fn(async (_owner: string, _repo: string, _prNumber: number, body: SubmitReviewBody) => {
    submitted.push(body)
    if (overrides.submitReview) return overrides.submitReview(body)
    return { id: 123, state: "CHANGES_REQUESTED" }
  })
  const listPullRequestReviews = vi.fn(async () => {
    if (submitted.length > 0) {
      if (overrides.failVerifyLookup === true) throw new Error("rate-limited")
      return [
        {
          id: 123,
          body: submitted[0]?.body ?? "",
          user: { login: "sigilix[bot]" },
          state: "CHANGES_REQUESTED",
          commitId: HEAD,
        },
      ]
    }
    return overrides.existingReviews ?? []
  })
  return {
    submitted,
    client: {
      getPullRequest: vi.fn(async () => ({
        head: { sha: overrides.currentHead ?? HEAD, ref: "feature" },
        base: { sha: "b".repeat(40), ref: "main" },
      })),
      listPullRequestReviews,
      submitReview,
    },
  }
}

function baseArgs(overrides: Partial<Parameters<typeof runInvariantLensAmendment>[0]> = {}) {
  return {
    env: env(),
    client: client().client,
    owner: "Sigilix",
    repo: "sigilix",
    prNumber: 402,
    headSha: HEAD,
    lensWork: Promise.resolve(lensResult()),
    reviewable: parseDiffToReviewablePositions(DIFF),
    ...overrides,
  }
}

describe("runInvariantLensAmendment", () => {
  it("posts a native REQUEST_CHANGES follow-up for score>=4 lens findings that survive validation", async () => {
    const fake = client()

    const outcome = await runInvariantLensAmendment(baseArgs({ client: fake.client }))

    expect(outcome).toMatchObject({ status: "posted", findingsCount: 1, reviewId: 123 })
    expect(fake.submitted).toHaveLength(1)
    expect(fake.submitted[0]).toMatchObject({
      event: "REQUEST_CHANGES",
      commit_id: HEAD,
    })
    expect(fake.submitted[0]?.body).toContain(INVARIANT_LENS_AMENDMENT_MARKER)
    expect(fake.submitted[0]?.body).toContain(HEAD)
    expect(fake.submitted[0]?.comments?.[0]).toMatchObject({ path: "src/app.ts", line: 1 })
  })

  it("fails closed when the posted amendment cannot be verified", async () => {
    const fake = client({ failVerifyLookup: true })

    const outcome = await runInvariantLensAmendment(baseArgs({ client: fake.client }))

    expect(outcome).toEqual({ status: "failed", findingsCount: 1, error: "review-not-persisted" })
    expect(fake.submitted).toHaveLength(1)
  })

  it("does not post when no lens finding is score>=4", async () => {
    const fake = client()

    const outcome = await runInvariantLensAmendment(
      baseArgs({ client: fake.client, lensWork: Promise.resolve(lensResult(3)) }),
    )

    expect(outcome).toEqual({ status: "no_findings", findingsCount: 0 })
    expect(fake.submitted).toHaveLength(0)
  })

  it("skips stale heads without posting an amendment", async () => {
    const fake = client({ currentHead: "b".repeat(40) })

    const outcome = await runInvariantLensAmendment(baseArgs({ client: fake.client }))

    expect(outcome).toEqual({ status: "stale_head", currentHeadSha: "b".repeat(40) })
    expect(fake.submitted).toHaveLength(0)
  })

  it("dedupes when a prior Sigilix amendment review already exists for the same head", async () => {
    const fake = client({
      existingReviews: [
        {
          id: 99,
          user: { login: "sigilix[bot]" },
          state: "CHANGES_REQUESTED",
          commitId: HEAD,
          body: `${INVARIANT_LENS_AMENDMENT_MARKER}\n<!-- sigilix:invariant-lens-amendment:${HEAD} -->`,
        },
      ],
    })

    const outcome = await runInvariantLensAmendment(baseArgs({ client: fake.client }))

    expect(outcome).toEqual({ status: "duplicate", reviewId: 99 })
    expect(fake.submitted).toHaveLength(0)
  })
})
