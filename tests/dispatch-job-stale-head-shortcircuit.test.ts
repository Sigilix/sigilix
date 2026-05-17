// ARC-250: when a pr-review pipeline returns `status === "stale_head"`,
// dispatchJob must NOT fall through to the alternate path. The two
// branches:
//
//   ensemble-post   : ensemble → if non-posted, fall through to Phase 3
//   ensemble-shadow : Phase 3 (customer-facing) → ensemble (telemetry)
//
// Without the short-circuit, the fallback's own stale-head guard fires
// too, the user-visible sticky comment is posted twice (or worse, in
// commit 2 the auto-requeue happens twice), and the dispatcher
// duplicates the work that ARC-250 was meant to centralize.

import { describe, it, expect, vi, beforeEach } from "vitest"

const {
  routeReviewMock,
  handlePrReviewEnsembleMock,
  handlePrReviewMock,
} = vi.hoisted(() => ({
  routeReviewMock: vi.fn(),
  handlePrReviewEnsembleMock: vi.fn(),
  handlePrReviewMock: vi.fn(),
}))

vi.mock("../src/lib/triage-pr-review-ensemble", () => ({
  routeReview: routeReviewMock,
  handlePrReviewEnsemble: handlePrReviewEnsembleMock,
}))
vi.mock("../src/lib/triage-pr-review", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/triage-pr-review")>("../src/lib/triage-pr-review")
  return {
    ...actual,
    handlePrReview: handlePrReviewMock,
  }
})

import { dispatchJob } from "../src/index"
import type { Env, JobMessage } from "../src/index"

function makeEnv(): Env {
  // No OPENCLAW_PR_REVIEW_MODE — the route decision is mocked at the
  // module level via routeReviewMock, so the env value doesn't gate
  // anything in this test path.
  return {
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "k",
  } as unknown as Env
}

const job: JobMessage = {
  type: "pr-review",
  owner: "Arc-and-Anchor",
  repo: "sigilix",
  prNumber: 237,
  headSha: "a".repeat(40),
  installationId: 99,
}

beforeEach(() => {
  routeReviewMock.mockReset()
  handlePrReviewEnsembleMock.mockReset()
  handlePrReviewMock.mockReset()
})

describe("dispatchJob — ARC-250 stale-head short-circuit", () => {
  it("ensemble-post: does NOT fall back to Phase 3 when ensemble returns stale_head", async () => {
    routeReviewMock.mockResolvedValue({ primary: "ensemble-post" })
    handlePrReviewEnsembleMock.mockResolvedValue({ status: "stale_head", telemetry: {} })

    await dispatchJob(job, makeEnv())

    expect(handlePrReviewEnsembleMock).toHaveBeenCalledTimes(1)
    expect(handlePrReviewMock).not.toHaveBeenCalled()
  })

  it("ensemble-post: still falls back to Phase 3 on errored / quorum-failure paths", async () => {
    routeReviewMock.mockResolvedValue({ primary: "ensemble-post" })
    handlePrReviewEnsembleMock.mockResolvedValue({ status: "errored", telemetry: {} })
    handlePrReviewMock.mockResolvedValue({ status: "posted" })

    await dispatchJob(job, makeEnv())

    expect(handlePrReviewEnsembleMock).toHaveBeenCalledTimes(1)
    expect(handlePrReviewMock).toHaveBeenCalledTimes(1)
  })

  it("ensemble-post: does NOT fall back when ensemble posted successfully (unchanged behaviour)", async () => {
    routeReviewMock.mockResolvedValue({ primary: "ensemble-post" })
    handlePrReviewEnsembleMock.mockResolvedValue({ status: "posted", telemetry: {} })

    await dispatchJob(job, makeEnv())

    expect(handlePrReviewEnsembleMock).toHaveBeenCalledTimes(1)
    expect(handlePrReviewMock).not.toHaveBeenCalled()
  })

  it("ensemble-shadow: does NOT run the shadow ensemble when Phase 3 returns stale_head", async () => {
    routeReviewMock.mockResolvedValue({ primary: "ensemble-shadow" })
    handlePrReviewMock.mockResolvedValue({ status: "stale_head" })

    await dispatchJob(job, makeEnv())

    expect(handlePrReviewMock).toHaveBeenCalledTimes(1)
    expect(handlePrReviewEnsembleMock).not.toHaveBeenCalled()
  })

  it("ensemble-shadow: still runs the shadow ensemble when Phase 3 posted normally", async () => {
    routeReviewMock.mockResolvedValue({ primary: "ensemble-shadow" })
    handlePrReviewMock.mockResolvedValue({ status: "posted" })
    handlePrReviewEnsembleMock.mockResolvedValue({ status: "shadow_recorded", telemetry: {} })

    await dispatchJob(job, makeEnv())

    expect(handlePrReviewMock).toHaveBeenCalledTimes(1)
    expect(handlePrReviewEnsembleMock).toHaveBeenCalledTimes(1)
  })
})
