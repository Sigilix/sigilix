// SIG-343 Task 8 — webhook-enqueue: verify accountLogin/accountType are forwarded
// to upsertTenantAndRepo when present in PrReviewEnqueueArgs.
//
// The pause/ignore gate, DO stub mechanics, and the main enqueue path are NOT
// re-tested here (they belong to integration testing). This suite is focused
// solely on the account-attribution forwarding contract.

import { vi, describe, it, expect, beforeEach } from "vitest"
import type { Mock } from "vitest"

// Mock upsertTenantAndRepo BEFORE importing the module under test so the
// hoisted vi.mock replaces the real adapter throughout the module.
vi.mock("@/src/features/tenancy", () => ({
  upsertTenantAndRepo: vi.fn(async () => {}),
  appendUsage: vi.fn(async () => {}),
}))

import { enqueuePrReviewJob, type PrReviewEnqueueArgs } from "./webhook-enqueue"
import { upsertTenantAndRepo } from "@/src/features/tenancy"

const mockUpsert = upsertTenantAndRepo as Mock

/** Minimal Env stub — only the KV + DO surfaces used by enqueuePrReviewJob. */
function makeEnv() {
  return {
    OPENCLAW_STATE: {
      get: vi.fn(async () => null), // no pause, no ignore
    },
    PR_REVIEW_RUN: {
      idFromName: vi.fn(() => "stub-id"),
      get: vi.fn(() => ({
        fetch: vi.fn(async () => ({ ok: true })),
      })),
    },
    SIGILIX_PLATFORM_DB: undefined,
  } as unknown as Parameters<typeof enqueuePrReviewJob>[0]
}

const BASE_ARGS: PrReviewEnqueueArgs = {
  owner: "acme",
  repo: "widgets",
  prNumber: 7,
  headSha: "abc1234",
  baseSha: null,
  installationId: 42,
  deliveryId: "delivery-001",
  repoId: 999,
}

describe("enqueuePrReviewJob — account attribution forwarding (SIG-343 Task 8)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("forwards accountLogin and accountType to upsertTenantAndRepo when both are present", async () => {
    const env = makeEnv()
    await enqueuePrReviewJob(env, {
      ...BASE_ARGS,
      accountLogin: "acme-org",
      accountType: "Organization",
    })

    expect(mockUpsert).toHaveBeenCalledOnce()
    const upsertArgs = (mockUpsert.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(upsertArgs.accountLogin).toBe("acme-org")
    expect(upsertArgs.accountType).toBe("Organization")
  })

  it("forwards undefined accountLogin/accountType when absent (no-op in COALESCE)", async () => {
    const env = makeEnv()
    await enqueuePrReviewJob(env, BASE_ARGS)

    expect(mockUpsert).toHaveBeenCalledOnce()
    const upsertArgs = (mockUpsert.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(upsertArgs.accountLogin).toBeUndefined()
    expect(upsertArgs.accountType).toBeUndefined()
  })

  it("does NOT call upsertTenantAndRepo when repoId is absent", async () => {
    const env = makeEnv()
    const { repoId: _omit, ...argsWithoutRepoId } = BASE_ARGS
    await enqueuePrReviewJob(env, { ...argsWithoutRepoId, accountLogin: "acme-org" })

    expect(mockUpsert).not.toHaveBeenCalled()
  })
})

describe("enqueuePrReviewJob — ctx.waitUntil deferred D1 upsert (SIG-343 fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("with ctx: upsert promise is handed to ctx.waitUntil, not awaited inline", async () => {
    const env = makeEnv()
    let resolveUpsert!: () => void
    const upsertPromise = new Promise<void>((res) => {
      resolveUpsert = res
    })
    mockUpsert.mockReturnValueOnce(upsertPromise)

    const waitUntilSpy = vi.fn()
    const ctx = { waitUntil: waitUntilSpy } as unknown as ExecutionContext

    await enqueuePrReviewJob(env, BASE_ARGS, ctx)

    // waitUntil must have been called with the upsert promise
    expect(waitUntilSpy).toHaveBeenCalledOnce()
    expect(waitUntilSpy).toHaveBeenCalledWith(upsertPromise)
    // resolve so no unhandled-promise leak in test
    resolveUpsert()
  })

  it("without ctx: upsert is awaited synchronously before DO fetch", async () => {
    const env = makeEnv()
    const order: string[] = []
    mockUpsert.mockImplementation(async () => {
      order.push("upsert")
    })
    // Override the DO fetch stub to track call order
    const doFetchSpy = vi.fn(async () => ({ ok: true }))
    ;(env.PR_REVIEW_RUN.get as ReturnType<typeof vi.fn>).mockReturnValue({ fetch: doFetchSpy })

    await enqueuePrReviewJob(env, BASE_ARGS)

    expect(order).toEqual(["upsert"])
    expect(doFetchSpy).toHaveBeenCalled()
  })
})
