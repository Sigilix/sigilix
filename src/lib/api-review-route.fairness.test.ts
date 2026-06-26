// SIG-455 Task 6 — tenant fairness gate for POST /v1/review.
// Tests that the same admitTenant/releaseTenant primitive (Task 4) is wired
// into the hosted route so the CLI surface shares per-tenant concurrency
// fairness with the webhook queue path (Task 5).

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/src/lib/ensemble/app/orchestrator", () => ({ handlePrReviewEnsemble: vi.fn() }))
// Mode B resolves the installation's headSha via a real GitHub client — mock it
// so grounded tests don't need real GitHub App credentials.
vi.mock("@/src/lib/ensemble/adapters/review-sink", () => ({
  buildClient: vi.fn(async () => ({
    getPullRequest: vi.fn(async () => ({ head: { sha: "server-resolved-sha" }, base: { sha: "base" } })),
    getPullRequestDiff: vi.fn(async () => "diff --git a/a.ts b/a.ts\n"),
  })),
}))
// Tenancy primitives mocked so the tests drive the decision directly without
// needing a real Durable Object binding.
vi.mock("@/src/features/tenancy", () => ({
  admitTenant: vi.fn(),
  releaseTenant: vi.fn(),
}))

import { handleReviewApiRoute } from "./api-review-route"
import { handlePrReviewEnsemble } from "@/src/lib/ensemble/app/orchestrator"
import { admitTenant, releaseTenant } from "@/src/features/tenancy"
import type { Env } from "@/src/shared/types/env"

const mockEngine = vi.mocked(handlePrReviewEnsemble)
const mockAdmit = vi.mocked(admitTenant)
const mockRelease = vi.mocked(releaseTenant)

const TOKEN = "test-secret-key"
const DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const x=1\n+const x=2\n"
const okReview = { verdict: { summary: "s", confidence: 4, findings: [] }, unanchoredFindings: [] }
const okResult = { status: "skipped", dryRunReview: okReview, telemetry: {} } as never

function makeEnv(extra: Partial<Env> = {}): Env {
  return { OPENCLAW_SIGILIX_API_KEY: TOKEN, ...extra } as unknown as Env
}
function groundedEnv(extra: Partial<Env> = {}): Env {
  return makeEnv({
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

/** A minimal KVNamespace mock that simulates a given counter value. */
function kvMock(getVal: string | null = null): Env["OPENCLAW_STATE"] {
  return {
    get: vi.fn(async () => getVal),
    put: vi.fn(async () => undefined),
  } as unknown as Env["OPENCLAW_STATE"]
}

beforeEach(() => {
  mockEngine.mockReset()
  mockAdmit.mockReset()
  mockRelease.mockReset()
  mockEngine.mockResolvedValue(okResult)
  mockRelease.mockResolvedValue(undefined)
})

describe("handleReviewApiRoute — tenant fairness, Mode A (diff)", () => {
  it("enforce + DENY → 429 with Retry-After header, ensemble NOT called", async () => {
    mockAdmit.mockResolvedValue({ granted: false, retryAfterMs: 5000 })
    const e = makeEnv({ SIGILIX_FAIRNESS_MODE: "enforce" })
    const res = await handleReviewApiRoute(req(diffBody), e)
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("5")
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe("tenant_busy")
    expect(mockEngine).not.toHaveBeenCalled()
  })

  it("enforce + GRANT → ensemble runs and releaseTenant called in finally", async () => {
    mockAdmit.mockResolvedValue({ granted: true, retryAfterMs: 0 })
    const e = makeEnv({ SIGILIX_FAIRNESS_MODE: "enforce" })
    const res = await handleReviewApiRoute(req(diffBody), e)
    expect(res.status).toBe(200)
    expect(mockEngine).toHaveBeenCalled()
    // releaseTenant must be called with the owner/repo tenantId
    expect(mockRelease).toHaveBeenCalledWith(expect.anything(), "o/r", expect.any(String))
  })

  it("enforce + GRANT → releaseTenant is called even when ensemble throws (finally)", async () => {
    mockAdmit.mockResolvedValue({ granted: true, retryAfterMs: 0 })
    mockEngine.mockRejectedValue(new Error("model down"))
    const e = makeEnv({ SIGILIX_FAIRNESS_MODE: "enforce" })
    const res = await handleReviewApiRoute(req(diffBody), e)
    expect(res.status).toBe(500)
    expect(mockRelease).toHaveBeenCalled()
  })

  it("shadow + DENY → ensemble STILL runs (measurement only, no block)", async () => {
    mockAdmit.mockResolvedValue({ granted: false, retryAfterMs: 5000 })
    const e = makeEnv({ SIGILIX_FAIRNESS_MODE: "shadow" })
    const res = await handleReviewApiRoute(req(diffBody), e)
    expect(res.status).toBe(200)
    expect(mockEngine).toHaveBeenCalled()
  })

  it("shadow + DENY → releaseTenant NOT called (no lease acquired on a shadow deny)", async () => {
    mockAdmit.mockResolvedValue({ granted: false, retryAfterMs: 5000 })
    const e = makeEnv({ SIGILIX_FAIRNESS_MODE: "shadow" })
    await handleReviewApiRoute(req(diffBody), e)
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it("mode=off → admitTenant never called", async () => {
    const e = makeEnv({ SIGILIX_FAIRNESS_MODE: "off" })
    await handleReviewApiRoute(req(diffBody), e)
    expect(mockAdmit).not.toHaveBeenCalled()
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it("retryAfterMs rounds UP to the nearest second in the Retry-After header", async () => {
    mockAdmit.mockResolvedValue({ granted: false, retryAfterMs: 1001 })
    const e = makeEnv({ SIGILIX_FAIRNESS_MODE: "enforce" })
    const res = await handleReviewApiRoute(req(diffBody), e)
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("2")
  })
})

describe("handleReviewApiRoute — tenant fairness, Mode B (grounded)", () => {
  it("enforce + DENY → 429 with Retry-After, ensemble NOT called", async () => {
    mockAdmit.mockResolvedValue({ granted: false, retryAfterMs: 10000 })
    const e = groundedEnv({ SIGILIX_FAIRNESS_MODE: "enforce" })
    const res = await handleReviewApiRoute(req(groundedBody), e)
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("10")
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe("tenant_busy")
    expect(mockEngine).not.toHaveBeenCalled()
  })

  it("enforce + GRANT → ensemble runs with installationId as tenantId", async () => {
    mockAdmit.mockResolvedValue({ granted: true, retryAfterMs: 0 })
    const e = groundedEnv({ SIGILIX_FAIRNESS_MODE: "enforce" })
    const res = await handleReviewApiRoute(req(groundedBody), e)
    expect(res.status).toBe(200)
    expect(mockEngine).toHaveBeenCalled()
    // tenantId for Mode B is the resolved installationId ("42" from the map)
    expect(mockRelease).toHaveBeenCalledWith(expect.anything(), "42", expect.any(String))
  })

  it("shadow + DENY → ensemble STILL runs (measurement only)", async () => {
    mockAdmit.mockResolvedValue({ granted: false, retryAfterMs: 5000 })
    const e = groundedEnv({ SIGILIX_FAIRNESS_MODE: "shadow" })
    const res = await handleReviewApiRoute(req(groundedBody), e)
    expect(res.status).toBe(200)
    expect(mockEngine).toHaveBeenCalled()
  })
})

describe("handleReviewApiRoute — daily ceiling and fairness are independent", () => {
  it("daily ceiling fires first in Mode A — 429 daily_limit_exceeded, admitTenant never called", async () => {
    // KV returning "200" triggers the global daily ceiling before the fairness gate
    const e = makeEnv({ SIGILIX_FAIRNESS_MODE: "enforce", OPENCLAW_STATE: kvMock("200") })
    const res = await handleReviewApiRoute(req(diffBody), e)
    expect(res.status).toBe(429)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe("daily_limit_exceeded")
    expect(mockAdmit).not.toHaveBeenCalled()
  })

  it("daily ceiling fires first in Mode B — 429 daily_limit_exceeded, admitTenant never called", async () => {
    const e = groundedEnv({ SIGILIX_FAIRNESS_MODE: "enforce", OPENCLAW_STATE: kvMock("200") })
    const res = await handleReviewApiRoute(req(groundedBody), e)
    expect(res.status).toBe(429)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe("daily_limit_exceeded")
    expect(mockAdmit).not.toHaveBeenCalled()
  })

  it("fairness 429 and daily ceiling 429 are distinct errors (both present → ceiling wins)", async () => {
    // Ceiling is hit first, fairness deny is never evaluated
    mockAdmit.mockResolvedValue({ granted: false, retryAfterMs: 5000 })
    const e = makeEnv({ SIGILIX_FAIRNESS_MODE: "enforce", OPENCLAW_STATE: kvMock("200") })
    const res = await handleReviewApiRoute(req(diffBody), e)
    expect(res.status).toBe(429)
    expect(((await res.json()) as { error?: string }).error).toBe("daily_limit_exceeded")
  })
})
