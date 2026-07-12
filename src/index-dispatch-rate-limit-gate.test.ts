// SIG-38 — unit tests for runRateLimitGate (the gate extracted from index-dispatch.ts).
//
// Tests exercise runRateLimitGate DIRECTLY (no dispatchJob overhead), covering:
//   1. allowed decision      → {skipped:false}, no comment, no check-close.
//   2. denied + comment ok   → {skipped:true}, comment posted once, check closed "skipped".
//   3. denied + comment THROWS → {skipped:false} (FAIL-OPEN), rate-limit-comment-failed warn.
//   4. denied + comment ok, check-close THROWS → still {skipped:true}, rate-limit-check-close-failed.
//   5. missing GitHub app creds (env check throws) → {skipped:false} (fail-open).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"
import type { RateLimitDecision } from "@/src/features/tenancy"

// ─── hoisted mocks ────────────────────────────────────────────────────────────

const { checkRateLimitMock, readTenantSubscriptionStatusMock } = vi.hoisted(() => ({
  checkRateLimitMock: vi.fn<() => Promise<RateLimitDecision>>(),
  readTenantSubscriptionStatusMock: vi.fn<() => Promise<string | null>>(),
}))
vi.mock("@/src/features/tenancy", async (importActual) => {
  const actual = await importActual()
  return {
    ...(actual as object),
    checkRateLimit: checkRateLimitMock,
    readTenantSubscriptionStatus: readTenantSubscriptionStatusMock,
    // isFullPaidStatus stays REAL (spread from actual) — the gate's trialing decision
    // is exercised through the genuine domain helper.
  }
})

const { readInstallationPlanMock } = vi.hoisted(() => ({
  readInstallationPlanMock: vi.fn<() => Promise<string | null>>(),
}))
vi.mock("@/src/features/entitlements", async (importActual) => {
  const actual = await importActual()
  return { ...(actual as object), readInstallationPlan: readInstallationPlanMock }
})

// NOTE: vi.mock for @/src/shared/adapters/github/github-app is omitted intentionally.
// Instead, makeEnv() provides a KV stub whose get() returns a pre-cached token so
// the real getInstallationToken short-circuits the cache path without any HTTP call.
// This avoids relying on module-level mock hoisting for a deeply-nested import.

const { createIssueCommentMock, listIssueCommentsMock, GitHubClientMock } = vi.hoisted(() => ({
  createIssueCommentMock: vi.fn<(owner: string, repo: string, prNumber: number, body: string) => Promise<void>>(
    async () => undefined,
  ),
  // The gate dedupes its over-cap notice by scanning existing PR comments for a marker.
  listIssueCommentsMock: vi.fn<() => Promise<Array<{ body: string }>>>(async () => []),
  // Hoisted so we can re-establish mockImplementation in beforeEach after
  // vi.restoreAllMocks() clears it (restoreAllMocks resets ALL tracked vi.fn
  // implementations, not just spies).
  GitHubClientMock: vi.fn(),
}))
vi.mock("@/src/shared/adapters/github", () => ({
  GitHubClient: GitHubClientMock,
  GitHubHttpError: class GitHubHttpError extends Error {},
}))

const { attachExistingCheckRunMock, completeCheckRunMock } = vi.hoisted(() => ({
  attachExistingCheckRunMock: vi.fn(async () => ({ _tag: "fake-handle" })),
  completeCheckRunMock: vi.fn(async () => undefined),
}))
vi.mock("@/src/lib/pr-review-check-run", async (importActual) => {
  const actual = await importActual()
  return {
    ...(actual as object),
    attachExistingCheckRun: attachExistingCheckRunMock,
    completeCheckRun: completeCheckRunMock,
  }
})

// ─── import SUT after mocks ───────────────────────────────────────────────────

import { runRateLimitGate } from "@/src/index-dispatch-rate-limit-gate"

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeEnv(over: Record<string, unknown> = {}): Env {
  return {
    GITHUB_APP_ID: "app-123",
    GITHUB_PRIVATE_KEY: "fake-private-key",
    // KV stub with a pre-cached installation token so the real getInstallationToken
    // short-circuits via the cache path without any network call or JWT signing.
    OPENCLAW_STATE: {
      get: async () => ({ token: "fake-gh-token", expiresAt: Date.now() + 3_600_000 }),
      put: async () => undefined,
    } as unknown as KVNamespace,
    ...over,
  } as unknown as Env
}

function makeArgs(
  over: Partial<{
    installationId: number
    authorLogin: string | undefined
    bypassClosedSkip: boolean | undefined
    owner: string
    repo: string
    prNumber: number
    checkRunId: number | undefined
  }> = {},
) {
  return {
    installationId: 42,
    authorLogin: "alice" as string | undefined,
    bypassClosedSkip: undefined as boolean | undefined,
    owner: "Sigilix",
    repo: "sigilix",
    prNumber: 7,
    checkRunId: undefined as number | undefined,
    ...over,
  }
}

/** Denied rate-limit decision (enforce, over-cap). */
function denied(): RateLimitDecision {
  return {
    allowed: false,
    mode: "enforce",
    used: 3,
    cap: 3,
    resetMs: 45_000,
    usedCostUsd: 0,
    costBudgetUsd: null,
    costRemainingUsd: null,
    footer: "",
    limitedBy: "count",
  }
}

/** Allowed rate-limit decision. */
function allowed(): RateLimitDecision {
  return {
    allowed: true,
    mode: "enforce",
    used: 1,
    cap: 3,
    resetMs: 0,
    usedCostUsd: 0,
    costBudgetUsd: null,
    costRemainingUsd: null,
    footer: "",
    limitedBy: "count",
  }
}

// ─── console spies ────────────────────────────────────────────────────────────

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  checkRateLimitMock.mockClear()
  readInstallationPlanMock.mockClear()
  readTenantSubscriptionStatusMock.mockClear()
  // Default: the tenant has no plan row yet (null) unless a test overrides it.
  readInstallationPlanMock.mockResolvedValue(null)
  // Default: no recorded subscription status (null) → fail-safe trialing unless overridden.
  readTenantSubscriptionStatusMock.mockResolvedValue(null)
  createIssueCommentMock.mockClear()
  listIssueCommentsMock.mockClear()
  attachExistingCheckRunMock.mockClear()
  completeCheckRunMock.mockClear()
  GitHubClientMock.mockClear()
  // Re-establish defaults after mockClear/restoreAllMocks clear implementations.
  createIssueCommentMock.mockResolvedValue(undefined)
  listIssueCommentsMock.mockResolvedValue([])
  attachExistingCheckRunMock.mockResolvedValue({ _tag: "fake-handle" })
  completeCheckRunMock.mockResolvedValue(undefined)
  // Re-establish GitHubClient constructor — vi.restoreAllMocks() (called in
  // afterEach) clears mockImplementation on all tracked vi.fn mocks, so we
  // must restore it here for every test.
  GitHubClientMock.mockImplementation(() => ({
    createIssueComment: createIssueCommentMock,
    listIssueComments: listIssueCommentsMock,
  }))
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function warnEvents(): Array<Record<string, unknown>> {
  return warnSpy.mock.calls.map((c) => JSON.parse(c[0] as string) as Record<string, unknown>)
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("runRateLimitGate", () => {
  it("allowed decision → {skipped:false}, no comment, no check-close", async () => {
    checkRateLimitMock.mockResolvedValue(allowed())

    const result = await runRateLimitGate(makeEnv(), makeArgs({ checkRunId: 99 }))

    expect(result.skipped).toBe(false)
    expect(createIssueCommentMock).not.toHaveBeenCalled()
    expect(completeCheckRunMock).not.toHaveBeenCalled()
    expect(attachExistingCheckRunMock).not.toHaveBeenCalled()
  })

  it("denied + createIssueComment succeeds → {skipped:true}, comment posted once, check closed skipped", async () => {
    checkRateLimitMock.mockResolvedValue(denied())

    const result = await runRateLimitGate(makeEnv(), makeArgs({ checkRunId: 99 }))

    expect(result.skipped).toBe(true)
    expect(createIssueCommentMock).toHaveBeenCalledOnce()
    expect(createIssueCommentMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      7,
      expect.stringMatching(/Rate limit reached/),
    )
    // Check run must have been closed as skipped.
    expect(attachExistingCheckRunMock).toHaveBeenCalledWith(expect.objectContaining({ checkRunId: 99 }))
    expect(completeCheckRunMock).toHaveBeenCalledWith(expect.objectContaining({ conclusion: "skipped" }))
  })

  it("denied + createIssueComment THROWS → {skipped:false} (fail-open), rate-limit-comment-failed warn", async () => {
    checkRateLimitMock.mockResolvedValue(denied())
    createIssueCommentMock.mockRejectedValue(new Error("network error"))

    const result = await runRateLimitGate(makeEnv(), makeArgs())

    expect(result.skipped).toBe(false)
    expect(completeCheckRunMock).not.toHaveBeenCalledWith(expect.objectContaining({ conclusion: "skipped" }))
    const events = warnEvents()
    expect(events.some((e) => e["event"] === "rate-limit-comment-failed")).toBe(true)
  })

  it("denied + comment ok + check-close THROWS → still {skipped:true}, rate-limit-check-close-failed logged", async () => {
    checkRateLimitMock.mockResolvedValue(denied())
    completeCheckRunMock.mockRejectedValue(new Error("github 500"))

    const result = await runRateLimitGate(makeEnv(), makeArgs({ checkRunId: 99 }))

    // The comment was posted so the decision is still skipped — check-close failure is best-effort.
    expect(result.skipped).toBe(true)
    expect(createIssueCommentMock).toHaveBeenCalledOnce()
    const events = warnEvents()
    expect(events.some((e) => e["event"] === "rate-limit-check-close-failed")).toBe(true)
  })

  it("missing GitHub app creds → {skipped:false} (fail-open), rate-limit-comment-failed warn", async () => {
    checkRateLimitMock.mockResolvedValue(denied())
    // env without app credentials — the gate's explicit guard throws before
    // getInstallationToken is ever reached, so the catch fires with
    // rate-limit-comment-failed and the gate fails open (skipped:false).
    const result = await runRateLimitGate(
      makeEnv({ GITHUB_APP_ID: undefined, GITHUB_PRIVATE_KEY: undefined }),
      makeArgs(),
    )

    expect(result.skipped).toBe(false)
    const events = warnEvents()
    expect(events.some((e) => e["event"] === "rate-limit-comment-failed")).toBe(true)
  })

  it("threads the installation's tier from readInstallationPlan into checkRateLimit", async () => {
    // Regression: the gate must pass the tenant's real tier so an `ultra` org is
    // NOT free-capped at 2 by resolveRateLimitCap(undefined).
    readInstallationPlanMock.mockResolvedValue("ultra")
    checkRateLimitMock.mockResolvedValue(allowed())

    await runRateLimitGate(makeEnv(), makeArgs({ installationId: 42 }))

    expect(readInstallationPlanMock).toHaveBeenCalledWith(expect.anything(), 42)
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tier: "ultra", installationId: 42 }),
    )
  })

  it("sig-trial-cap: an 'active' subscription threads trialing:false (full volume)", async () => {
    readInstallationPlanMock.mockResolvedValue("pro")
    readTenantSubscriptionStatusMock.mockResolvedValue("active")
    checkRateLimitMock.mockResolvedValue(allowed())

    await runRateLimitGate(makeEnv(), makeArgs({ installationId: 42 }))

    expect(readTenantSubscriptionStatusMock).toHaveBeenCalledWith(expect.anything(), 42)
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tier: "pro", trialing: false }),
    )
  })

  it("sig-trial-cap: a 'trialing' subscription threads trialing:true (half volume)", async () => {
    readInstallationPlanMock.mockResolvedValue("pro")
    readTenantSubscriptionStatusMock.mockResolvedValue("trialing")
    checkRateLimitMock.mockResolvedValue(allowed())

    await runRateLimitGate(makeEnv(), makeArgs({ installationId: 42 }))

    expect(checkRateLimitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tier: "pro", trialing: true }),
    )
  })

  it("sig-trial-cap FAIL-SAFE: a null/unknown status threads trialing:true (never full paid without an active sub)", async () => {
    readInstallationPlanMock.mockResolvedValue("ultra")
    readTenantSubscriptionStatusMock.mockResolvedValue(null)
    checkRateLimitMock.mockResolvedValue(allowed())

    await runRateLimitGate(makeEnv(), makeArgs({ installationId: 42 }))

    expect(checkRateLimitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tier: "ultra", trialing: true }),
    )
  })

  it("fails open on a tier-read fault → tier null (free cap) + rate-limit-tier-read-failed warn", async () => {
    // readInstallationPlan THROWS on a D1 fault; the gate must swallow it, warn, and
    // fall back to the default (free) cap rather than block or widen the cap silently.
    readInstallationPlanMock.mockRejectedValue(new Error("d1 down"))
    checkRateLimitMock.mockResolvedValue(allowed())

    await runRateLimitGate(makeEnv(), makeArgs())

    expect(checkRateLimitMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tier: null }))
    const events = warnEvents()
    expect(events.some((e) => e["event"] === "rate-limit-tier-read-failed")).toBe(true)
  })
})

// ─── sig-cost-primary: fail-open + truthful notice ───────────────────────────
//
// These pin the two P0s found reviewing the shadow→enforce flip. Both were latent
// while the gate ran in shadow (nothing blocked, so nothing could block WRONGLY);
// enforcing the cost budget is what made them reachable.

describe("runRateLimitGate — tier-read fault must FAIL OPEN (never downgrade to Free)", () => {
  it("readInstallationPlan THROWS → gate is BYPASSED, review runs, no comment posted", async () => {
    // The trap: catching the throw and passing tier=null does NOT disable the gate —
    // null normalizes to the FREE tier on BOTH dimensions (free count cap AND the
    // $0.375 free USD budget). The usage read is a SEPARATE D1 statement that can
    // still succeed, so a Max customer mid-window would be measured against Free's
    // budget and BLOCKED. An unknown tier is an infra fault, not a free plan.
    readInstallationPlanMock.mockRejectedValue(new Error("D1_ERROR: network"))
    // checkRateLimit is mocked here, so it cannot honour the bypass itself; the real
    // one short-circuits to allowed:true on any bypassReason. We assert the gate ASKS
    // for the bypass (below) and that it lets the review through.
    checkRateLimitMock.mockResolvedValue(allowed())

    const res = await runRateLimitGate(makeEnv(), makeArgs())

    expect(res.skipped).toBe(false) // review RUNS
    expect(createIssueCommentMock).not.toHaveBeenCalled()
    // The bypass must be requested explicitly — that is what short-circuits
    // checkRateLimit to allowed:true BEFORE it ever reads usage or compares a budget.
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ bypassReason: "tier-read-failed" }),
    )
  })

  it("readInstallationPlan RESOLVES null (genuinely no plan row) → gate still applies, NOT bypassed", async () => {
    // Guards the fix from over-reaching: a real free tenant must still be gated.
    readInstallationPlanMock.mockResolvedValue(null)
    checkRateLimitMock.mockResolvedValue(allowed())

    await runRateLimitGate(makeEnv(), makeArgs())

    expect(checkRateLimitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ bypassReason: "tier-read-failed" }),
    )
  })
})

describe("runRateLimitGate — the over-cap notice must be TRUE and posted ONCE", () => {
  it("limitedBy=cost → explains the BUDGET; never claims a count cap or a ~1m reset", async () => {
    // resetMs is COUNT-based and is 0 when cost binds (cost is designed to bind first,
    // so the count is still under cap). Rendering the count numbers there would claim
    // "3 of 3 reviews used ... next slot in ~1m" — all three parts false.
    checkRateLimitMock.mockResolvedValue({
      ...denied(),
      limitedBy: "cost",
      used: 15,
      cap: 20,
      resetMs: 0,
      usedCostUsd: 3.9,
      costBudgetUsd: 3.75,
      costRemainingUsd: 0,
    })

    const res = await runRateLimitGate(makeEnv(), makeArgs())

    expect(res.skipped).toBe(true)
    const body = createIssueCommentMock.mock.calls[0]?.[3] as string
    expect(body).toContain("Usage budget reached")
    expect(body).toContain("model spend, not PR count")
    expect(body).not.toContain("15 of 20")
    expect(body).not.toContain("~1m")
  })

  it("limitedBy=count → still reports the real count numbers", async () => {
    checkRateLimitMock.mockResolvedValue({ ...denied(), limitedBy: "count", used: 8, cap: 8, resetMs: 600_000 })

    await runRateLimitGate(makeEnv(), makeArgs())

    const body = createIssueCommentMock.mock.calls[0]?.[3] as string
    expect(body).toContain("Rate limit reached")
    expect(body).toContain("8 of 8 reviews used")
  })

  it("a notice already exists on the PR → does NOT post a second one, but still skips the review", async () => {
    // A blocked author keeps pushing; every push re-enters this gate. Without the
    // dedupe each push stacks another "budget reached" comment on the PR.
    listIssueCommentsMock.mockResolvedValue([{ body: "<!-- sigilix:rate-limit-notice -->\n**Sigilix · ...**" }])
    checkRateLimitMock.mockResolvedValue({ ...denied(), limitedBy: "cost" })

    const res = await runRateLimitGate(makeEnv(), makeArgs())

    expect(createIssueCommentMock).not.toHaveBeenCalled()
    expect(res.skipped).toBe(true) // already told → still enforce the skip
  })
})
