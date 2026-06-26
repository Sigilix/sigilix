// SIG-543 Task 4 — POST /v1/review shadow-quota wire tests.
//
// Mode B grounded: checkShadowQuota is fired via ctx.waitUntil after the fairness
// gate closes (using the real installationId). Independent of fairness mode; never
// blocks or refuses the review.
//
// Mode A (diff): installationId is 0 / unresolvable → checkShadowQuota NOT called.
// quotaMode=off → NOT called regardless of mode.

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Env } from "@/src/shared/types/env"

vi.mock("@/src/lib/ensemble/app/orchestrator", () => ({ handlePrReviewEnsemble: vi.fn() }))
vi.mock("@/src/lib/ensemble/adapters/review-sink", () => ({
  buildClient: vi.fn(async () => ({
    getPullRequest: vi.fn(async () => ({ head: { sha: "server-resolved-sha" }, base: { sha: "base" } })),
    getPullRequestDiff: vi.fn(async () => "diff --git a/a.ts b/a.ts\n"),
  })),
}))

// Mock checkShadowQuota and the DO-backed tenancy adapters.
const { checkShadowQuotaMock } = vi.hoisted(() => ({ checkShadowQuotaMock: vi.fn(async () => {}) }))
vi.mock("@/src/features/tenancy", async (importActual) => {
  const actual = await importActual()
  return {
    ...(actual as object),
    admitTenant: vi.fn(async () => ({ granted: true, retryAfterMs: 0 })),
    releaseTenant: vi.fn(async () => {}),
    checkShadowQuota: checkShadowQuotaMock,
  }
})

import { handleReviewApiRoute } from "./api-review-route"
import { handlePrReviewEnsemble } from "@/src/lib/ensemble/app/orchestrator"

const mockEngine = vi.mocked(handlePrReviewEnsemble)

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
function makeCtx() {
  return { waitUntil: vi.fn() } as unknown as ExecutionContext
}

const diffBody = { owner: "o", repo: "r", prNumber: 1, headSha: "abc123", diff: DIFF }
const groundedBody = { mode: "grounded", owner: "o", repo: "r", prNumber: 1, headSha: "abc123" }

beforeEach(() => {
  mockEngine.mockReset()
  mockEngine.mockResolvedValue(okResult)
  checkShadowQuotaMock.mockClear()
  checkShadowQuotaMock.mockResolvedValue(undefined)
})

describe("handleReviewApiRoute — shadow quota wire (SIG-543 Task 4)", () => {
  it("Mode B + quotaMode=shadow → checkShadowQuota invoked via ctx.waitUntil, review proceeds", async () => {
    const env = groundedEnv({ SIGILIX_TENANT_QUOTA_MODE: "shadow" })
    const ctx = makeCtx()
    const res = await handleReviewApiRoute(req(groundedBody), env, ctx)

    expect(res.status).toBe(200)
    // waitUntil must have been called at least once with the quota promise
    expect(ctx.waitUntil).toHaveBeenCalled()
    // checkShadowQuota must have been called with the resolved installationId (42)
    expect(checkShadowQuotaMock).toHaveBeenCalledWith(env, 42)
    // review still ran — never blocks
    expect(mockEngine).toHaveBeenCalledTimes(1)
  })

  it("Mode B + quotaMode absent (default=shadow) → checkShadowQuota invoked", async () => {
    // resolveQuotaMode falls through to "shadow" when the flag is absent
    const env = groundedEnv({}) // no SIGILIX_TENANT_QUOTA_MODE
    const ctx = makeCtx()
    const res = await handleReviewApiRoute(req(groundedBody), env, ctx)

    expect(res.status).toBe(200)
    expect(checkShadowQuotaMock).toHaveBeenCalledWith(env, 42)
    expect(ctx.waitUntil).toHaveBeenCalled()
    expect(mockEngine).toHaveBeenCalledTimes(1)
  })

  it("Mode A (diff) → checkShadowQuota NOT invoked (no real installationId on diff path)", async () => {
    const env = baseEnv({ SIGILIX_TENANT_QUOTA_MODE: "shadow" })
    const ctx = makeCtx()
    const res = await handleReviewApiRoute(req(diffBody), env, ctx)

    expect(res.status).toBe(200)
    expect(checkShadowQuotaMock).not.toHaveBeenCalled()
    expect(mockEngine).toHaveBeenCalledTimes(1)
  })

  it("Mode B + quotaMode=off → checkShadowQuota NOT invoked", async () => {
    const env = groundedEnv({ SIGILIX_TENANT_QUOTA_MODE: "off" })
    const ctx = makeCtx()
    const res = await handleReviewApiRoute(req(groundedBody), env, ctx)

    expect(res.status).toBe(200)
    expect(checkShadowQuotaMock).not.toHaveBeenCalled()
    expect(mockEngine).toHaveBeenCalledTimes(1)
  })

  it("Mode B + quotaMode=shadow + fairness=off → checkShadowQuota still fires (independent of fairness)", async () => {
    const env = groundedEnv({ SIGILIX_TENANT_QUOTA_MODE: "shadow", SIGILIX_FAIRNESS_MODE: "off" })
    const ctx = makeCtx()
    const res = await handleReviewApiRoute(req(groundedBody), env, ctx)

    expect(res.status).toBe(200)
    expect(checkShadowQuotaMock).toHaveBeenCalledWith(env, 42)
    expect(ctx.waitUntil).toHaveBeenCalled()
  })
})
