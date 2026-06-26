// SIG-455 Task 6 — tenant fairness gate for POST /v1/review.
// Mode A (diff): semaphore is bypassed entirely — owner/repo is asserted by the caller
// with a shared key and is therefore spoofable; admitTenant must never be called on
// the diff path. admitUnderDailyCeiling remains Mode A's sole guard.
// Mode B (grounded): the fairness semaphore IS wired — installationId is resolved by
// the server (not spoofable), so per-tenant concurrency limits are safe to enforce.

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
// needing a real Durable Object binding. resolveFairnessConfig is pure so we
// use the real implementation; only the DO-backed adapters need stubs.
vi.mock("@/src/features/tenancy", async (importActual) => {
  const actual = await importActual()
  return {
    ...(actual as object),
    admitTenant: vi.fn(),
    releaseTenant: vi.fn(),
  }
})

import { handleReviewApiRoute } from "./api-review-route"
import { handlePrReviewEnsemble } from "@/src/lib/ensemble/app/orchestrator"
import { admitTenant, releaseTenant } from "@/src/features/tenancy"
import { buildClient } from "@/src/lib/ensemble/adapters/review-sink"
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
  // Mode A bypasses the per-tenant semaphore entirely — the shared bearer key + asserted
  // owner/repo is spoofable, so admitTenant must never be called regardless of
  // SIGILIX_FAIRNESS_MODE. The daily ceiling (admitUnderDailyCeiling) is the only gate.

  it("enforce + would-deny → still runs; admitTenant NOT called (semaphore bypassed for Mode A)", async () => {
    mockAdmit.mockResolvedValue({ granted: false, retryAfterMs: 5000 })
    const e = makeEnv({ SIGILIX_FAIRNESS_MODE: "enforce" })
    const res = await handleReviewApiRoute(req(diffBody), e)
    expect(res.status).toBe(200)
    expect(mockEngine).toHaveBeenCalled()
    expect(mockAdmit).not.toHaveBeenCalled()
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it("shadow mode → admitTenant NOT called (Mode A is semaphore-free in all fairness modes)", async () => {
    const e = makeEnv({ SIGILIX_FAIRNESS_MODE: "shadow" })
    await handleReviewApiRoute(req(diffBody), e)
    expect(mockAdmit).not.toHaveBeenCalled()
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it("mode=off → admitTenant NOT called", async () => {
    const e = makeEnv({ SIGILIX_FAIRNESS_MODE: "off" })
    await handleReviewApiRoute(req(diffBody), e)
    expect(mockAdmit).not.toHaveBeenCalled()
    expect(mockRelease).not.toHaveBeenCalled()
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

  // Regression: SIG-455 Task 6 lease-leak fix. Before the fix, the buildClient catch block
  // returned 502 BEFORE entering the outer try/finally, so releaseTenant was never called and
  // the lease leaked until the 35-min TTL reaper. This test must FAIL against the old code.
  it("enforce + GRANT + buildClient REJECTS → 502 and releaseTenant still called (lease-leak fix)", async () => {
    mockAdmit.mockResolvedValue({ granted: true, retryAfterMs: 0 })
    vi.mocked(buildClient).mockRejectedValueOnce(new Error("github down"))
    const e = groundedEnv({ SIGILIX_FAIRNESS_MODE: "enforce" })
    const res = await handleReviewApiRoute(req(groundedBody), e)
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe("pr_unavailable")
    // The critical assertion: the lease must be released even though GitHub auth failed.
    expect(mockRelease).toHaveBeenCalledWith(expect.anything(), "42", expect.any(String))
    expect(mockEngine).not.toHaveBeenCalled()
  })

  it("mode=off → admitTenant never called", async () => {
    const e = groundedEnv({ SIGILIX_FAIRNESS_MODE: "off" })
    await handleReviewApiRoute(req(groundedBody), e)
    expect(mockAdmit).not.toHaveBeenCalled()
    expect(mockRelease).not.toHaveBeenCalled()
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

  it("Mode B: fairness 429 and daily ceiling 429 are distinct — ceiling fires first (admitTenant not reached)", async () => {
    // In Mode B both ceiling AND fairness would deny; ceiling fires first so admitTenant
    // is never called and the error is daily_limit_exceeded, not tenant_busy.
    mockAdmit.mockResolvedValue({ granted: false, retryAfterMs: 5000 })
    const e = groundedEnv({ SIGILIX_FAIRNESS_MODE: "enforce", OPENCLAW_STATE: kvMock("200") })
    const res = await handleReviewApiRoute(req(groundedBody), e)
    expect(res.status).toBe(429)
    expect(((await res.json()) as { error?: string }).error).toBe("daily_limit_exceeded")
    expect(mockAdmit).not.toHaveBeenCalled()
  })
})
