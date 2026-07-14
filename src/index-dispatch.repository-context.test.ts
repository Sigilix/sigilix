import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"
import type { EnsembleHandlerArgs } from "@/src/lib/triage-pr-review-ensemble"

const { ensembleMock } = vi.hoisted(() => ({
  ensembleMock: vi.fn(async (_args: EnsembleHandlerArgs) => ({
    status: "skipped" as const,
    telemetry: { fellBackToPhase3: false },
  })),
}))
vi.mock("@/src/lib/triage-pr-review-ensemble", async (importActual) => {
  const actual = await importActual()
  return { ...(actual as object), handlePrReviewEnsemble: ensembleMock }
})

vi.mock("@/src/do/consumer-wrapper", () => ({
  runPrReviewWithDoCallback: async (_job: unknown, _env: unknown, run: (reporter?: unknown) => Promise<void>) =>
    run(undefined),
}))

vi.mock("@/src/index-dispatch-rate-limit-gate", () => ({
  runRateLimitGate: async () => ({
    skipped: false,
    rateLimit: { mode: "off", footer: "" },
  }),
}))

vi.mock("@/src/lib/pr-review-check-run", async (importActual) => {
  const actual = await importActual()
  return {
    ...(actual as object),
    attachExistingCheckRun: vi.fn(async () => null),
    completeCheckRun: vi.fn(async () => undefined),
    startInProgressCheckRun: vi.fn(async () => null),
  }
})

import { dispatchJob } from "@/src/index-dispatch"

function makeJob(
  over: Partial<Extract<JobMessage, { type: "pr-review" }>> = {},
): Extract<JobMessage, { type: "pr-review" }> {
  return {
    type: "pr-review",
    owner: "Acme",
    repo: "payments",
    prNumber: 7,
    headSha: "a".repeat(40),
    installationId: 42,
    repoId: 7001,
    ...over,
  }
}

function makeEnv(): Env {
  return {
    OPENCLAW_STATE: {} as KVNamespace,
    SIGILIX_RATE_LIMIT_MODE: "off",
    SIGILIX_FAIRNESS_MODE: "off",
    SIGILIX_TENANT_QUOTA_MODE: "off",
  } as unknown as Env
}

async function dispatchedArgs(job: Extract<JobMessage, { type: "pr-review" }>): Promise<EnsembleHandlerArgs> {
  await dispatchJob(job, makeEnv())
  expect(ensembleMock).toHaveBeenCalledTimes(1)
  return ensembleMock.mock.calls[0]![0]
}

beforeEach(() => {
  ensembleMock.mockClear()
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("GitHub queue dispatch — canonical repository-context identity", () => {
  it("derives the exact immutable GitHub installation/repository tuple", async () => {
    const args = await dispatchedArgs(makeJob({ installationId: 42, repoId: 7001 }))

    expect(args.repositoryContextIdentity).toEqual({
      provider: "github",
      scopeId: "42",
      repositoryExternalId: "7001",
    })
  })

  it("accepts Number.MAX_SAFE_INTEGER for both immutable identifiers", async () => {
    const args = await dispatchedArgs(
      makeJob({ installationId: Number.MAX_SAFE_INTEGER, repoId: Number.MAX_SAFE_INTEGER }),
    )

    expect(args.repositoryContextIdentity).toEqual({
      provider: "github",
      scopeId: String(Number.MAX_SAFE_INTEGER),
      repositoryExternalId: String(Number.MAX_SAFE_INTEGER),
    })
  })

  it.each([
    ["zero repository id", { repoId: 0 }],
    ["negative repository id", { repoId: -1 }],
    ["fractional repository id", { repoId: 7.5 }],
    ["NaN repository id", { repoId: Number.NaN }],
    ["infinite repository id", { repoId: Number.POSITIVE_INFINITY }],
    ["unsafe repository id", { repoId: Number.MAX_SAFE_INTEGER + 1 }],
    ["zero installation id", { installationId: 0 }],
    ["negative installation id", { installationId: -1 }],
    ["fractional installation id", { installationId: 42.5 }],
    ["NaN installation id", { installationId: Number.NaN }],
    ["infinite installation id", { installationId: Number.POSITIVE_INFINITY }],
    ["unsafe installation id", { installationId: Number.MAX_SAFE_INTEGER + 1 }],
    ["missing installation id", { installationId: undefined as unknown as number }],
  ])("omits the identity for %s without falling back to owner/repo", async (_label, over) => {
    const args = await dispatchedArgs(makeJob(over))
    expect(args.repositoryContextIdentity).toBeUndefined()
  })

  it("omits the identity when the legacy job has no repository id", async () => {
    const job = makeJob()
    delete job.repoId

    const args = await dispatchedArgs(job)
    expect(args.repositoryContextIdentity).toBeUndefined()
  })
})
