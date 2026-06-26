// SIG-455 Task 6 — POST /v1/review Mode B provider-cooldown read-before-fire tests.
//
// When SIGILIX_PROVIDER_COOLDOWN_MODE="enforce" and the provider has a live
// cooldown, Mode B must return 429 + Retry-After BEFORE calling the ensemble.
// shadow/off → proceed. get→0 → proceed. Mode A is unaffected.

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Env } from "@/src/shared/types/env"

vi.mock("@/src/lib/ensemble/app/orchestrator", () => ({ handlePrReviewEnsemble: vi.fn() }))
vi.mock("@/src/lib/ensemble/adapters/review-sink", () => ({
  buildClient: vi.fn(async () => ({
    getPullRequest: vi.fn(async () => ({ head: { sha: "server-resolved-sha" }, base: { sha: "base" } })),
    getPullRequestDiff: vi.fn(async () => "diff --git a/a.ts b/a.ts\n"),
  })),
}))
vi.mock("@/src/features/tenancy", async (importActual) => {
  const actual = await importActual()
  return {
    ...(actual as object),
    admitTenant: vi.fn(),
    releaseTenant: vi.fn(),
  }
})

// Mock the cooldown client so remaining-ms is deterministic.
// Default → 0 (no cooldown). Override per test.
const { getCooldownMock } = vi.hoisted(() => ({ getCooldownMock: vi.fn(async () => 0) }))
vi.mock("@/src/shared/adapters/model/provider-cooldown-client", () => ({
  getProviderCooldownRemainingMs: getCooldownMock,
  setProviderCooldown: vi.fn(),
}))

import { handleReviewApiRoute } from "./api-review-route"
import { handlePrReviewEnsemble } from "@/src/lib/ensemble/app/orchestrator"
import { admitTenant, releaseTenant } from "@/src/features/tenancy"

const mockEngine = vi.mocked(handlePrReviewEnsemble)
const mockAdmit = vi.mocked(admitTenant)
const mockRelease = vi.mocked(releaseTenant)

const TOKEN = "test-secret-key"
const DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const x=1\n+const x=2\n"
const okReview = { verdict: { summary: "s", confidence: 4, findings: [] }, unanchoredFindings: [] }
const okResult = { status: "skipped", dryRunReview: okReview, telemetry: {} } as never

function baseEnv(extra: Partial<Env> = {}): Env {
  return { OPENCLAW_SIGILIX_API_KEY: TOKEN, ...extra } as unknown as Env
}
function groundedEnv(extra: Partial<Env> = {}): Env {
  return baseEnv({
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "pk",
    OPENCLAW_GITHUB_INSTALLATION_MAP: '{"o/r":"42"}',
    ...extra,
  })
}
function req(body: unknown): Request {
  return new Request("https://api.sigilix.ai/v1/review", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  })
}

const diffBody = { owner: "o", repo: "r", prNumber: 1, headSha: "abc123", diff: DIFF }
const groundedBody = { mode: "grounded", owner: "o", repo: "r", prNumber: 1, headSha: "abc123" }

beforeEach(() => {
  mockEngine.mockReset()
  mockAdmit.mockReset()
  mockRelease.mockReset()
  getCooldownMock.mockClear()
  getCooldownMock.mockResolvedValue(0) // default: no cooldown
  mockEngine.mockResolvedValue(okResult)
  mockAdmit.mockResolvedValue({ granted: true, retryAfterMs: 0 })
  mockRelease.mockResolvedValue(undefined)
})

describe("handleReviewApiRoute — provider-cooldown gate, Mode B (grounded)", () => {
  it("enforce + remaining>0 → 429 + Retry-After, ensemble NOT called", async () => {
    const REMAINING = 15_000
    getCooldownMock.mockResolvedValue(REMAINING)
    const e = groundedEnv({ SIGILIX_PROVIDER_COOLDOWN_MODE: "enforce" })
    const res = await handleReviewApiRoute(req(groundedBody), e)

    expect(res.status).toBe(429)
    const retryAfter = res.headers.get("retry-after")
    expect(retryAfter).toBe("15") // ceil(15000/1000)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe("provider_busy")
    expect(mockEngine).not.toHaveBeenCalled()
  })

  it("enforce + remaining>0 → Retry-After rounds up (ceiling math)", async () => {
    getCooldownMock.mockResolvedValue(5_500)
    const e = groundedEnv({ SIGILIX_PROVIDER_COOLDOWN_MODE: "enforce" })
    const res = await handleReviewApiRoute(req(groundedBody), e)

    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("6") // ceil(5500/1000) = 6
  })

  it("shadow + remaining>0 → skip entirely: no cooldown read, ensemble runs", async () => {
    getCooldownMock.mockResolvedValue(15_000)
    const e = groundedEnv({ SIGILIX_PROVIDER_COOLDOWN_MODE: "shadow" })
    const res = await handleReviewApiRoute(req(groundedBody), e)

    // shadow → entire cooldown check skipped
    expect(getCooldownMock).not.toHaveBeenCalled()
    expect(res.status).toBe(200)
    expect(mockEngine).toHaveBeenCalled()
  })

  it("off → no cooldown read at all, ensemble runs", async () => {
    getCooldownMock.mockResolvedValue(15_000)
    const e = groundedEnv({ SIGILIX_PROVIDER_COOLDOWN_MODE: "off" })
    const res = await handleReviewApiRoute(req(groundedBody), e)

    expect(getCooldownMock).not.toHaveBeenCalled()
    expect(res.status).toBe(200)
    expect(mockEngine).toHaveBeenCalled()
  })

  it("enforce + remaining=0 → no cooldown: ensemble runs", async () => {
    getCooldownMock.mockResolvedValue(0)
    const e = groundedEnv({ SIGILIX_PROVIDER_COOLDOWN_MODE: "enforce" })
    const res = await handleReviewApiRoute(req(groundedBody), e)

    expect(res.status).toBe(200)
    expect(mockEngine).toHaveBeenCalled()
  })

  it("enforce + cooldown 429 fires BEFORE fairness (admitTenant not called on 429)", async () => {
    getCooldownMock.mockResolvedValue(10_000)
    const e = groundedEnv({
      SIGILIX_PROVIDER_COOLDOWN_MODE: "enforce",
      SIGILIX_FAIRNESS_MODE: "enforce",
    })
    const res = await handleReviewApiRoute(req(groundedBody), e)

    expect(res.status).toBe(429)
    expect(((await res.json()) as { error?: string }).error).toBe("provider_busy")
    // admitTenant must NOT be called — cooldown short-circuited before fairness
    expect(mockAdmit).not.toHaveBeenCalled()
    expect(mockRelease).not.toHaveBeenCalled()
  })
})

describe("handleReviewApiRoute — provider-cooldown gate, Mode A (diff)", () => {
  it("enforce + remaining>0 → Mode A UNAFFECTED: ensemble runs (cooldown check is Mode B only)", async () => {
    getCooldownMock.mockResolvedValue(30_000)
    const e = baseEnv({ SIGILIX_PROVIDER_COOLDOWN_MODE: "enforce" })
    const res = await handleReviewApiRoute(req(diffBody), e)

    expect(res.status).toBe(200)
    expect(mockEngine).toHaveBeenCalled()
    // The cooldown client must NOT be called for Mode A
    expect(getCooldownMock).not.toHaveBeenCalled()
  })
})
