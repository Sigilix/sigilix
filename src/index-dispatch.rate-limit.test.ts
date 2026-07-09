// SIG-38 Task 5 — rate-limit admission gate tests for the pr-review dispatch callback.
//
// Exercises the gate inserted AFTER the sensitive-repo skip and BEFORE `const checkRun`.
//
// Strategy:
//   - `runPrReviewWithDoCallback` is mocked to immediately invoke the callback so the
//     full pr-review gate sequence runs without a real DO.
//   - `checkRateLimit` is mocked to return controlled decisions.
//   - `handlePrReviewEnsemble` is mocked to return `{status:"skipped"}` so we can assert
//     whether the real review pipeline ran.
//   - `getInstallationToken` + `GitHubClient` are mocked so `prClosedOrMerged` always
//     returns false (open PR) and comment posting is controllable.
//   - `attachExistingCheckRun` / `completeCheckRun` / `startInProgressCheckRun` are mocked
//     so the check-run path doesn't need a real GitHub connection.

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"
import type { RateLimitDecision } from "@/src/features/tenancy"

// ─── hoisted mocks ────────────────────────────────────────────────────────────

const { checkRateLimitMock } = vi.hoisted(() => ({ checkRateLimitMock: vi.fn<() => Promise<RateLimitDecision>>() }))
vi.mock("@/src/features/tenancy", async (importActual) => {
  const actual = await importActual()
  return { ...(actual as object), checkRateLimit: checkRateLimitMock }
})

const { ensembleMock } = vi.hoisted(() => ({ ensembleMock: vi.fn(async () => ({ status: "skipped" as const })) }))
vi.mock("@/src/lib/triage-pr-review-ensemble", async (importActual) => {
  const actual = await importActual()
  return { ...(actual as object), handlePrReviewEnsemble: ensembleMock }
})

// Mock the consumer wrapper to invoke the callback immediately (bypasses the DO path).
vi.mock("@/src/do/consumer-wrapper", () => ({
  runPrReviewWithDoCallback: async (_job: unknown, _env: unknown, runEnsemble: (reporter?: unknown) => Promise<void>) =>
    runEnsemble(undefined),
}))

// Control comment posting and PR-open check through the GitHub client.
const { createIssueCommentMock, getPullRequestMock } = vi.hoisted(() => ({
  createIssueCommentMock: vi.fn(async () => {}),
  getPullRequestMock: vi.fn(async () => ({ state: "open" as const, merged_at: null })),
}))

vi.mock("@/src/shared/adapters/github/github-app", () => ({
  getInstallationToken: vi.fn(async () => "fake-token"),
}))

vi.mock("@/src/shared/adapters/github", () => ({
  GitHubClient: vi.fn().mockImplementation(() => ({
    createIssueComment: createIssueCommentMock,
    getPullRequest: getPullRequestMock,
  })),
  GitHubHttpError: class GitHubHttpError extends Error {},
}))

// Stub check-run helpers so we don't need a real GitHub connection.
const { attachExistingCheckRunMock, completeCheckRunMock, startInProgressCheckRunMock } = vi.hoisted(() => ({
  attachExistingCheckRunMock: vi.fn(async () => ({ _tag: "fake-handle" })),
  completeCheckRunMock: vi.fn(async () => {}),
  startInProgressCheckRunMock: vi.fn(async () => ({ _tag: "fake-handle" })),
}))
vi.mock("@/src/lib/pr-review-check-run", async (importActual) => {
  const actual = await importActual()
  return {
    ...(actual as object),
    attachExistingCheckRun: attachExistingCheckRunMock,
    completeCheckRun: completeCheckRunMock,
    startInProgressCheckRun: startInProgressCheckRunMock,
  }
})

// ─── import SUT after mocks ───────────────────────────────────────────────────

import { dispatchJob } from "@/src/index-dispatch"

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeJob(
  over: Partial<Extract<JobMessage, { type: "pr-review" }>> = {},
): Extract<JobMessage, { type: "pr-review" }> {
  return {
    type: "pr-review",
    owner: "Sigilix",
    repo: "sigilix",
    prNumber: 7,
    headSha: "a".repeat(40),
    installationId: 42,
    authorLogin: "alice",
    // No runId — so runPrReviewWithDoCallback fires the callback immediately.
    ...over,
  } as Extract<JobMessage, { type: "pr-review" }>
}

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
    OPENCLAW_STATE: {} as unknown as KVNamespace,
    SIGILIX_RATE_LIMIT_MODE: "enforce",
    // Disable fairness / quota so the path hits the rate-limit gate.
    SIGILIX_FAIRNESS_MODE: "off",
    SIGILIX_TENANT_QUOTA_MODE: "off",
    ...extra,
  } as unknown as Env
}

/** Decision for an over-cap enforce deny. */
function denied(): RateLimitDecision {
  return {
    allowed: false,
    mode: "enforce",
    used: 10,
    cap: 10,
    resetMs: 45_000,
    usedCostUsd: 0,
    costBudgetUsd: null,
    costRemainingUsd: null,
    footer: "",
  }
}

/** Decision for an allowed enforce. */
function allowed(mode: "enforce" | "shadow" | "off" = "enforce"): RateLimitDecision {
  return {
    allowed: true,
    mode,
    used: 5,
    cap: 10,
    resetMs: 0,
    usedCostUsd: 0,
    costBudgetUsd: null,
    costRemainingUsd: null,
    footer: "",
  }
}

beforeEach(() => {
  checkRateLimitMock.mockClear()
  ensembleMock.mockClear()
  createIssueCommentMock.mockClear()
  getPullRequestMock.mockClear()
  attachExistingCheckRunMock.mockClear()
  completeCheckRunMock.mockClear()
  startInProgressCheckRunMock.mockClear()
  // Reset defaults (mockClear keeps the implementation, so re-establish per test).
  createIssueCommentMock.mockResolvedValue(undefined)
  getPullRequestMock.mockResolvedValue({ state: "open", merged_at: null })
  completeCheckRunMock.mockResolvedValue(undefined)
  attachExistingCheckRunMock.mockResolvedValue({ _tag: "fake-handle" })
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

// ─── matrix ───────────────────────────────────────────────────────────────────

describe("SIG-38 Task 5 — rate-limit gate in pr-review dispatch", () => {
  it("enforce + over-cap + comment OK → ensemble skipped, comment posted, check closed skipped", async () => {
    checkRateLimitMock.mockResolvedValue(denied())
    const job = makeJob({ checkRunId: 99 })
    await dispatchJob(job, makeEnv())

    // Ensemble must NOT have run.
    expect(ensembleMock).not.toHaveBeenCalled()

    // Comment must have been posted.
    expect(createIssueCommentMock).toHaveBeenCalledOnce()
    const callArgs = createIssueCommentMock.mock.calls[0] as unknown as [string, string, number, string]
    expect(callArgs[2]).toBe(7)
    expect(callArgs[3]).toMatch(/Rate limit reached/)
    expect(callArgs[3]).toMatch(/10 of 10/)

    // Check run must have been closed as skipped.
    expect(attachExistingCheckRunMock).toHaveBeenCalledWith(expect.objectContaining({ checkRunId: 99 }))
    expect(completeCheckRunMock).toHaveBeenCalledWith(expect.objectContaining({ conclusion: "skipped" }))
  })

  it("enforce + over-cap + comment OK, no checkRunId → ensemble skipped, comment posted, no check-run call", async () => {
    checkRateLimitMock.mockResolvedValue(denied())
    const job = makeJob() // no checkRunId
    await dispatchJob(job, makeEnv())

    expect(ensembleMock).not.toHaveBeenCalled()
    expect(createIssueCommentMock).toHaveBeenCalledOnce()
    // No checkRunId → attachExistingCheckRun never called.
    expect(attachExistingCheckRunMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ checkRunId: expect.anything() }),
    )
  })

  it("enforce + over-cap + comment OK but check-run close THROWS → still skips (no throw, ensemble not called)", async () => {
    checkRateLimitMock.mockResolvedValue(denied())
    completeCheckRunMock.mockRejectedValue(new Error("github 500"))

    const job = makeJob({ checkRunId: 99 })
    await expect(dispatchJob(job, makeEnv())).resolves.toBeUndefined()

    // Comment posted, ensemble must NOT run — the close failure is best-effort.
    expect(createIssueCommentMock).toHaveBeenCalledOnce()
    expect(ensembleMock).not.toHaveBeenCalled()
  })

  it("enforce + over-cap + comment THROWS → fail-open: ensemble IS called", async () => {
    checkRateLimitMock.mockResolvedValue(denied())
    createIssueCommentMock.mockRejectedValue(new Error("network failure"))

    const job = makeJob()
    await dispatchJob(job, makeEnv())

    // Comment attempt was made.
    expect(createIssueCommentMock).toHaveBeenCalledOnce()
    // Fail-open: the review must still run.
    expect(ensembleMock).toHaveBeenCalledOnce()
    // Check run must NOT have been marked skipped (we fell through).
    expect(completeCheckRunMock).not.toHaveBeenCalledWith(expect.objectContaining({ conclusion: "skipped" }))
  })

  it("shadow mode (allowed:true) → ensemble called, no comment posted, no skip", async () => {
    checkRateLimitMock.mockResolvedValue(allowed("shadow"))

    const job = makeJob()
    await dispatchJob(job, makeEnv({ SIGILIX_RATE_LIMIT_MODE: "shadow" }))

    expect(ensembleMock).toHaveBeenCalledOnce()
    expect(createIssueCommentMock).not.toHaveBeenCalled()
  })

  it("bypassClosedSkip:true → checkRateLimit receives bypass reason, ensemble called", async () => {
    // Even if checkRateLimitMock would deny, the bypass reason makes it allow.
    checkRateLimitMock.mockResolvedValue(allowed("enforce"))

    const job = makeJob({ bypassClosedSkip: true })
    await dispatchJob(job, makeEnv())

    // checkRateLimit must have been called with the bypass reason.
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ bypassReason: "slash-command-rerun" }),
    )
    expect(ensembleMock).toHaveBeenCalledOnce()
    expect(createIssueCommentMock).not.toHaveBeenCalled()
  })

  it("mode off (allowed:true) → ensemble called, no comment", async () => {
    checkRateLimitMock.mockResolvedValue(allowed("off"))

    const job = makeJob()
    await dispatchJob(job, makeEnv({ SIGILIX_RATE_LIMIT_MODE: "off" }))

    expect(ensembleMock).toHaveBeenCalledOnce()
    expect(createIssueCommentMock).not.toHaveBeenCalled()
  })
})
