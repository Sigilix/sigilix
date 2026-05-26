// ARC-258 + ARC-280 — dispatcher-level check-run lifecycle test.
//
// Validates that `dispatchJob`'s `pr-review` case picks the right
// final conclusion from the ensemble's result. ARC-280 simplified
// this dramatically: Phase 3 (`handlePrReview`) is gone, and the
// `routeReview` decision layer collapsed to an inline sensitive-
// repo skip check. The dispatcher now reads exactly one outcome —
// the ensemble's — and maps it to the Check Run conclusion.
//
// Matrix covered:
//   - ensemble posted (real review) → success
//   - ensemble posted with reviewMeta.surface=comment → failure
//     (ARC-279: comment fallback fired; customer sees a comment
//     instead of a formal review)
//   - ensemble stale_head → skipped
//   - ensemble errored → failure
//   - ensemble skipped (legitimate, e.g., label gate) → success
//   - sensitive-repo skip → no check created
//   - throw mid-pipeline → failure
//   - null handle (createCheckRun failed/skipped) → completeCheckRun
//     still called and no-ops

import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  handlePrReviewEnsembleMock,
  startInProgressCheckRunMock,
  completeCheckRunMock,
  isRepoSensitiveMock,
} = vi.hoisted(() => ({
  handlePrReviewEnsembleMock: vi.fn(),
  startInProgressCheckRunMock: vi.fn(),
  completeCheckRunMock: vi.fn(),
  isRepoSensitiveMock: vi.fn(() => false),
}))

vi.mock("../src/lib/triage-pr-review-ensemble", () => ({
  handlePrReviewEnsemble: handlePrReviewEnsembleMock,
}))
vi.mock("../src/lib/pr-review-check-run", () => ({
  startInProgressCheckRun: startInProgressCheckRunMock,
  completeCheckRun: completeCheckRunMock,
}))
vi.mock("../src/lib/repo-policy", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/repo-policy")>("../src/lib/repo-policy")
  return { ...actual, isRepoSensitive: isRepoSensitiveMock }
})

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
  handlePrReviewEnsembleMock.mockReset()
  startInProgressCheckRunMock.mockReset().mockResolvedValue(HANDLE)
  completeCheckRunMock.mockReset().mockResolvedValue(undefined)
  isRepoSensitiveMock.mockReset().mockReturnValue(false)
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

describe("dispatchJob — ARC-258 / ARC-280 check-run lifecycle", () => {
  it("ensemble posted (real review) → completeCheckRun(success) with reviewMeta", async () => {
    const reviewMeta = { event: "APPROVE" as const, findingsCount: 0 }
    handlePrReviewEnsembleMock.mockResolvedValue({
      status: "posted",
      telemetry: {},
      reviewMeta,
    })

    await dispatchJob(job, makeEnv())

    expect(startInProgressCheckRunMock).toHaveBeenCalledTimes(1)
    expect(completeCheckRunMock).toHaveBeenCalledWith({
      handle: HANDLE,
      conclusion: "success",
      // SIG-216: dispatcher now threads prNumber into reviewMeta so the
      // check-run summary can render the `[View review](pr-url)` link.
      reviewMeta: { ...reviewMeta, prNumber: job.prNumber },
    })
  })

  // ARC-279: when the ensemble had to use the comment fallback
  // (formal review submit silently rejected), the Check Run reflects
  // that the normal pipeline didn't run — even though synth's body
  // posted as a PR comment. `failure` + reviewMeta.surface="comment"
  // routes to the "see PR comment" title.
  it("ensemble posted with surface=comment → completeCheckRun(failure) with reviewMeta", async () => {
    const reviewMeta = {
      event: "REQUEST_CHANGES" as const,
      findingsCount: 3,
      surface: "comment" as const,
    }
    handlePrReviewEnsembleMock.mockResolvedValue({
      status: "posted",
      telemetry: {},
      reviewMeta,
    })

    await dispatchJob(job, makeEnv())

    expect(completeCheckRunMock).toHaveBeenCalledWith({
      handle: HANDLE,
      conclusion: "failure",
      // SIG-216: prNumber threaded into reviewMeta by the dispatcher.
      reviewMeta: { ...reviewMeta, prNumber: job.prNumber },
    })
  })

  it("ensemble stale_head → completeCheckRun(skipped)", async () => {
    handlePrReviewEnsembleMock.mockResolvedValue({ status: "stale_head", telemetry: {} })

    await dispatchJob(job, makeEnv())

    expect(completeCheckRunMock).toHaveBeenCalledWith({
      handle: HANDLE,
      conclusion: "skipped",
    })
  })

  // ARC-258: synth produced output but the submit silently rejected
  // AND the comment fallback ALSO failed. `errored` → failure so the
  // customer sees the truth.
  it("ensemble errored → completeCheckRun(failure)", async () => {
    handlePrReviewEnsembleMock.mockResolvedValue({ status: "errored", telemetry: {} })

    await dispatchJob(job, makeEnv())

    expect(completeCheckRunMock).toHaveBeenCalledWith({
      handle: HANDLE,
      conclusion: "failure",
    })
  })

  // ARC-280 follow-up: when the ensemble couldn't generate a verdict
  // and posted a skip-notice instead (specialists_all_failed,
  // synth retry exhausted, etc.), the dispatcher threads
  // reviewMeta.surface=skip-notice so the Check Run renderer shows
  // "Couldn't review — see PR comment" instead of the generic
  // "Review failed" title.
  it("ensemble errored with surface=skip-notice → completeCheckRun(failure) with reviewMeta", async () => {
    const reviewMeta = {
      event: "REQUEST_CHANGES" as const,
      findingsCount: 0,
      surface: "skip-notice" as const,
    }
    handlePrReviewEnsembleMock.mockResolvedValue({
      status: "errored",
      telemetry: {},
      reviewMeta,
    })

    await dispatchJob(job, makeEnv())

    expect(completeCheckRunMock).toHaveBeenCalledWith({
      handle: HANDLE,
      conclusion: "failure",
      // SIG-216: prNumber threaded into reviewMeta by the dispatcher.
      reviewMeta: { ...reviewMeta, prNumber: job.prNumber },
    })
  })

  // Legitimate skip path (label gate, specialists_all_failed, etc.):
  // success conclusion (nothing reviewed because user-config or
  // unreviewable input).
  it("ensemble skipped → completeCheckRun(success) (legitimate skip)", async () => {
    handlePrReviewEnsembleMock.mockResolvedValue({ status: "skipped", telemetry: {} })

    await dispatchJob(job, makeEnv())

    expect(completeCheckRunMock).toHaveBeenCalledWith({
      handle: HANDLE,
      conclusion: "success",
    })
  })

  it("sensitive-repo skip → NO check created (we early-return before start)", async () => {
    isRepoSensitiveMock.mockReturnValue(true)

    await dispatchJob(job, makeEnv())

    expect(startInProgressCheckRunMock).not.toHaveBeenCalled()
    expect(completeCheckRunMock).not.toHaveBeenCalled()
    expect(handlePrReviewEnsembleMock).not.toHaveBeenCalled()
  })

  it("throw mid-pipeline → completeCheckRun(failure) AND error re-throws", async () => {
    handlePrReviewEnsembleMock.mockRejectedValue(new Error("network blew up"))

    await expect(dispatchJob(job, makeEnv())).rejects.toThrow(/network blew up/)

    expect(completeCheckRunMock).toHaveBeenCalledWith({
      handle: HANDLE,
      conclusion: "failure",
    })
  })

  it("null handle (createCheckRun failed/skipped) → completeCheckRun still called", async () => {
    startInProgressCheckRunMock.mockResolvedValue(null)
    handlePrReviewEnsembleMock.mockResolvedValue({
      status: "posted",
      telemetry: {},
      reviewMeta: { event: "APPROVE", findingsCount: 0 },
    })

    await dispatchJob(job, makeEnv())

    expect(completeCheckRunMock).toHaveBeenCalledWith({
      handle: null,
      conclusion: "success",
      // SIG-216: prNumber threaded into reviewMeta by the dispatcher.
      reviewMeta: { event: "APPROVE", findingsCount: 0, prNumber: job.prNumber },
    })
  })
})
