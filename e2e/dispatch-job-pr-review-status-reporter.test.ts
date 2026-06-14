import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  handlePrReviewEnsembleMock,
  runPrReviewWithDoCallbackMock,
  startInProgressCheckRunMock,
  completeCheckRunMock,
  isRepoSensitiveMock,
} = vi.hoisted(() => ({
  handlePrReviewEnsembleMock: vi.fn(),
  runPrReviewWithDoCallbackMock: vi.fn(),
  startInProgressCheckRunMock: vi.fn(),
  completeCheckRunMock: vi.fn(),
  isRepoSensitiveMock: vi.fn(() => false),
}))

vi.mock("@/src/lib/triage-pr-review-ensemble", () => ({
  handlePrReviewEnsemble: handlePrReviewEnsembleMock,
}))

vi.mock("@/src/do/consumer-wrapper", () => ({
  runPrReviewWithDoCallback: runPrReviewWithDoCallbackMock,
}))

vi.mock("@/src/lib/pr-review-check-run", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/pr-review-check-run")>("@/src/lib/pr-review-check-run")
  return {
    ...actual,
    startInProgressCheckRun: startInProgressCheckRunMock,
    completeCheckRun: completeCheckRunMock,
  }
})

vi.mock("@/src/lib/repo-policy", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/repo-policy")>("@/src/lib/repo-policy")
  return { ...actual, isRepoSensitive: isRepoSensitiveMock }
})

import { dispatchJob } from "@/src/index"
import type { JobMessage } from "@/src/shared/types/job"
import type { Env } from "@/src/shared/types/env"
import type { ReviewStatusReporter } from "@/src/lib/pr-review-status-reporter"

const job: JobMessage = {
  type: "pr-review",
  owner: "Sigilix",
  repo: "sigilix",
  prNumber: 237,
  headSha: "a".repeat(40),
  installationId: 99,
  runId: "run-1",
}

function makeEnv(): Env {
  return {
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "k",
  } as unknown as Env
}

describe("dispatchJob — PR review status reporter", () => {
  beforeEach(() => {
    handlePrReviewEnsembleMock.mockReset()
    startInProgressCheckRunMock.mockReset().mockResolvedValue({ id: 1 })
    completeCheckRunMock.mockReset().mockResolvedValue(undefined)
    isRepoSensitiveMock.mockReset().mockReturnValue(false)
    runPrReviewWithDoCallbackMock.mockReset()
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
  })

  it("threads the DO status reporter into the ensemble and posts a final status update", async () => {
    const statusReporter: ReviewStatusReporter = { report: vi.fn(), flush: vi.fn(async () => undefined) }
    runPrReviewWithDoCallbackMock.mockImplementation(async (_job, _env, runEnsemble) => {
      await runEnsemble(statusReporter)
    })
    handlePrReviewEnsembleMock.mockResolvedValue({
      status: "posted",
      telemetry: {},
      reviewMeta: { event: "REQUEST_CHANGES", findingsCount: 2, surface: "review" },
    })

    await dispatchJob(job, makeEnv())

    expect(handlePrReviewEnsembleMock.mock.calls[0]?.[0]).toMatchObject({ statusReporter })
    expect(statusReporter.report).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "posted",
        final: expect.objectContaining({
          status: "posted",
          findingsCount: 2,
          surface: "review",
          reviewUrl: "https://github.com/Sigilix/sigilix/pull/237",
        }),
      }),
    )
    expect(statusReporter.flush).toHaveBeenCalledOnce()
  })

  it("reports failed final status when post-review work blocks the check", async () => {
    const statusReporter: ReviewStatusReporter = { report: vi.fn(), flush: vi.fn(async () => undefined) }
    runPrReviewWithDoCallbackMock.mockImplementation(async (_job, _env, runEnsemble) => {
      await runEnsemble(statusReporter)
    })
    handlePrReviewEnsembleMock.mockResolvedValue({
      status: "posted",
      telemetry: {},
      reviewMeta: { event: "REQUEST_CHANGES", findingsCount: 2, surface: "review" },
      postReviewWork: Promise.resolve({ status: "failed", error: "amendment post failed" }),
    })

    await dispatchJob(job, makeEnv())

    expect(statusReporter.report).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "failed",
        final: expect.objectContaining({
          status: "failed",
          findingsCount: 2,
          surface: "review",
          reviewUrl: "https://github.com/Sigilix/sigilix/pull/237",
        }),
      }),
    )
  })
})
