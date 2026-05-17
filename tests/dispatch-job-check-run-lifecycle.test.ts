// ARC-258 — dispatcher-level check-run lifecycle test.
//
// Validates that `dispatchJob`'s `pr-review` case picks the right
// final conclusion across the routing matrix. This is the load-
// bearing piece of ARC-258 because the prior PENDING-review
// approach was customer-invisible and the in-ensemble Check Run
// approach contradicted Phase 3 fallback outcomes (CodeRabbit H1
// catch on commit 4). The fix moves the lifecycle to the
// dispatcher so a single owner can reconcile ensemble + Phase 3
// results.
//
// Matrix covered:
//   - ensemble-post posted → success
//   - ensemble-post stale_head → skipped, NO Phase 3 fallback
//   - ensemble-post errored, Phase 3 posted → success (H1 fix)
//   - ensemble-post errored, Phase 3 stale_head → skipped
//   - ensemble-shadow posted → success
//   - Phase 3 only path: posted → success
//   - sensitive-repo skip → no check created
//   - throw mid-pipeline → failure

import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  routeReviewMock,
  handlePrReviewEnsembleMock,
  handlePrReviewMock,
  startInProgressCheckRunMock,
  completeCheckRunMock,
} = vi.hoisted(() => ({
  routeReviewMock: vi.fn(),
  handlePrReviewEnsembleMock: vi.fn(),
  handlePrReviewMock: vi.fn(),
  startInProgressCheckRunMock: vi.fn(),
  completeCheckRunMock: vi.fn(),
}))

vi.mock("../src/lib/triage-pr-review-ensemble", () => ({
  routeReview: routeReviewMock,
  handlePrReviewEnsemble: handlePrReviewEnsembleMock,
}))
vi.mock("../src/lib/triage-pr-review", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/triage-pr-review")>("../src/lib/triage-pr-review")
  return { ...actual, handlePrReview: handlePrReviewMock }
})
vi.mock("../src/lib/warmup", () => ({
  postWarmupStickyIfUnindexed: vi.fn(async () => ({ skipped: "already-indexed" })),
}))
vi.mock("../src/lib/pr-review-check-run", () => ({
  startInProgressCheckRun: startInProgressCheckRunMock,
  completeCheckRun: completeCheckRunMock,
}))

import { dispatchJob } from "../src/index"
import type { Env, JobMessage } from "../src/index"

function makeEnv(): Env {
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

const HANDLE = { id: 7777 } as never

beforeEach(() => {
  routeReviewMock.mockReset()
  handlePrReviewEnsembleMock.mockReset()
  handlePrReviewMock.mockReset()
  startInProgressCheckRunMock.mockReset().mockResolvedValue(HANDLE)
  completeCheckRunMock.mockReset().mockResolvedValue(undefined)
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

describe("dispatchJob — ARC-258 check-run lifecycle", () => {
  it("ensemble-post posted → completeCheckRun(success)", async () => {
    routeReviewMock.mockResolvedValue({ primary: "ensemble-post" })
    handlePrReviewEnsembleMock.mockResolvedValue({ status: "posted", telemetry: {} })

    await dispatchJob(job, makeEnv())

    expect(startInProgressCheckRunMock).toHaveBeenCalledTimes(1)
    expect(completeCheckRunMock).toHaveBeenCalledWith({
      handle: HANDLE, conclusion: "success",
    })
    expect(handlePrReviewMock).not.toHaveBeenCalled()
  })

  it("ensemble-post stale_head → completeCheckRun(skipped), NO Phase 3", async () => {
    routeReviewMock.mockResolvedValue({ primary: "ensemble-post" })
    handlePrReviewEnsembleMock.mockResolvedValue({ status: "stale_head", telemetry: {} })

    await dispatchJob(job, makeEnv())

    expect(completeCheckRunMock).toHaveBeenCalledWith({
      handle: HANDLE, conclusion: "skipped",
    })
    expect(handlePrReviewMock).not.toHaveBeenCalled()
  })

  // CodeRabbit H1 catch on commit 4: previously the in-ensemble
  // check completed as `failure` here, which contradicted Phase 3's
  // successful review post. The dispatcher-owned lifecycle picks
  // the conclusion AFTER Phase 3 runs.
  it("ensemble-post errored + Phase 3 posted → success (H1 fix)", async () => {
    routeReviewMock.mockResolvedValue({ primary: "ensemble-post" })
    handlePrReviewEnsembleMock.mockResolvedValue({ status: "errored", telemetry: {} })
    handlePrReviewMock.mockResolvedValue({ status: "posted" })

    await dispatchJob(job, makeEnv())

    expect(handlePrReviewMock).toHaveBeenCalledTimes(1)
    expect(completeCheckRunMock).toHaveBeenCalledWith({
      handle: HANDLE, conclusion: "success",
    })
  })

  it("ensemble-post errored + Phase 3 stale_head → skipped", async () => {
    routeReviewMock.mockResolvedValue({ primary: "ensemble-post" })
    handlePrReviewEnsembleMock.mockResolvedValue({ status: "errored", telemetry: {} })
    handlePrReviewMock.mockResolvedValue({ status: "stale_head" })

    await dispatchJob(job, makeEnv())

    expect(completeCheckRunMock).toHaveBeenCalledWith({
      handle: HANDLE, conclusion: "skipped",
    })
  })

  it("ensemble-shadow Phase-3-posted → success", async () => {
    routeReviewMock.mockResolvedValue({ primary: "ensemble-shadow" })
    handlePrReviewMock.mockResolvedValue({ status: "posted" })
    handlePrReviewEnsembleMock.mockResolvedValue({ status: "posted", telemetry: {} })

    await dispatchJob(job, makeEnv())

    expect(completeCheckRunMock).toHaveBeenCalledWith({
      handle: HANDLE, conclusion: "success",
    })
  })

  it("Phase 3 only (agentic/singleshot) posted → success", async () => {
    routeReviewMock.mockResolvedValue({ primary: "phase3-agentic" })
    handlePrReviewMock.mockResolvedValue({ status: "posted" })

    await dispatchJob(job, makeEnv())

    expect(completeCheckRunMock).toHaveBeenCalledWith({
      handle: HANDLE, conclusion: "success",
    })
  })

  it("Phase 3 only skipped (dedupe-hit on same head) → success, NOT skipped", async () => {
    // Phase 3 returns `skipped` when a prior run already reviewed
    // this exact head SHA. From the customer's perspective the
    // review IS done (the earlier run posted it), so `success`
    // beats `skipped` (which would imply nothing was reviewed).
    routeReviewMock.mockResolvedValue({ primary: "phase3-singleshot-legacy" })
    handlePrReviewMock.mockResolvedValue({ status: "skipped" })

    await dispatchJob(job, makeEnv())

    expect(completeCheckRunMock).toHaveBeenCalledWith({
      handle: HANDLE, conclusion: "success",
    })
  })

  it("sensitive-repo skip → NO check created (we early-return before start)", async () => {
    routeReviewMock.mockResolvedValue({ primary: "skipped-sensitive", reason: "denylisted" })

    await dispatchJob(job, makeEnv())

    expect(startInProgressCheckRunMock).not.toHaveBeenCalled()
    expect(completeCheckRunMock).not.toHaveBeenCalled()
  })

  it("throw mid-pipeline → completeCheckRun(failure) AND error re-throws", async () => {
    routeReviewMock.mockResolvedValue({ primary: "ensemble-post" })
    handlePrReviewEnsembleMock.mockRejectedValue(new Error("network blew up"))

    await expect(dispatchJob(job, makeEnv())).rejects.toThrow(/network blew up/)

    expect(completeCheckRunMock).toHaveBeenCalledWith({
      handle: HANDLE, conclusion: "failure",
    })
  })

  it("null handle (createCheckRun failed/skipped) → completeCheckRun still called and no-ops", async () => {
    startInProgressCheckRunMock.mockResolvedValue(null)
    routeReviewMock.mockResolvedValue({ primary: "ensemble-post" })
    handlePrReviewEnsembleMock.mockResolvedValue({ status: "posted", telemetry: {} })

    await dispatchJob(job, makeEnv())

    expect(completeCheckRunMock).toHaveBeenCalledWith({
      handle: null, conclusion: "success",
    })
  })
})
