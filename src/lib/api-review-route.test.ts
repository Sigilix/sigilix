// SIG-304 Phase 2.1 — POST /v1/review (Mode A) route: auth gating, request
// validation, recall-safe status mapping, and the unified-diff parser. The engine
// is mocked (the real engine path is covered by the live CLI + e2e suites).

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/src/lib/ensemble/app/orchestrator", () => ({ handlePrReviewEnsemble: vi.fn() }))

import { handleReviewApiRoute } from "./api-review-route"
import { parseUnifiedDiff } from "./api-review-diff-client"
import { handlePrReviewEnsemble } from "@/src/lib/ensemble/app/orchestrator"
import type { Env } from "@/src/shared/types/env"

const mockEngine = vi.mocked(handlePrReviewEnsemble)
const TOKEN = "test-secret-key"
const env = (key?: string): Env => ({ OPENCLAW_SIGILIX_API_KEY: key }) as unknown as Env
const DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const x=1\n+const x=2\n"

function req(body: unknown, token: string | null = TOKEN): Request {
  return new Request("https://api.sigilix.ai/v1/review", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}
const validBody = { owner: "o", repo: "r", prNumber: 1, headSha: "abc123", diff: DIFF }

beforeEach(() => mockEngine.mockReset())

describe("handleReviewApiRoute — auth + validation", () => {
  it("503 when the API key is unset (endpoint inert)", async () => {
    const res = await handleReviewApiRoute(req(validBody), env(undefined))
    expect(res.status).toBe(503)
    expect(mockEngine).not.toHaveBeenCalled()
  })
  it("401 when the bearer is missing", async () => {
    expect((await handleReviewApiRoute(req(validBody, null), env(TOKEN))).status).toBe(401)
  })
  it("401 when the bearer is wrong", async () => {
    expect((await handleReviewApiRoute(req(validBody, "nope"), env(TOKEN))).status).toBe(401)
    expect(mockEngine).not.toHaveBeenCalled()
  })
  it("400 on invalid JSON", async () => {
    expect((await handleReviewApiRoute(req("{not json", TOKEN), env(TOKEN))).status).toBe(400)
  })
  it("400 on a missing required field", async () => {
    const { diff: _omit, ...noDiff } = validBody
    expect((await handleReviewApiRoute(req(noDiff), env(TOKEN))).status).toBe(400)
  })
  it("413 on an oversized diff", async () => {
    const huge = { ...validBody, diff: "x".repeat(1_500_001) }
    expect((await handleReviewApiRoute(req(huge), env(TOKEN))).status).toBe(413)
    expect(mockEngine).not.toHaveBeenCalled()
  })
})

describe("handleReviewApiRoute — engine status mapping (recall-safety)", () => {
  it("RECALL-SAFETY: an errored engine run → 500, NOT a 200/empty clean pass", async () => {
    mockEngine.mockResolvedValue({ status: "errored", telemetry: { internalError: "model 500" } } as never)
    const res = await handleReviewApiRoute(req(validBody), env(TOKEN))
    expect(res.status).toBe(500)
    expect(((await res.json()) as { detail?: string }).detail).toMatch(/model 500/)
  })
  it("200 with the DryRunReview verbatim on success", async () => {
    const review = { verdict: { summary: "s", confidence: 4, findings: [] }, unanchoredFindings: [] }
    mockEngine.mockResolvedValue({ status: "skipped", dryRunReview: review, telemetry: {} } as never)
    const res = await handleReviewApiRoute(req(validBody), env(TOKEN))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(review)
    // injected dry-run client + forceFullCoverage, never posts
    expect(mockEngine).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, forceFullCoverage: true, githubClient: expect.anything() }),
    )
  })
  it("RECALL-SAFETY: a no-verdict bail (total model outage) → 500, NOT 200 null", async () => {
    mockEngine.mockResolvedValue({
      status: "skipped",
      telemetry: { fellBackReason: "specialists_all_failed" },
    } as never)
    expect((await handleReviewApiRoute(req(validBody), env(TOKEN))).status).toBe(500)
  })
  it("200 null when the engine genuinely had nothing to review (no failure reason)", async () => {
    mockEngine.mockResolvedValue({ status: "skipped", telemetry: {} } as never)
    const res = await handleReviewApiRoute(req(validBody), env(TOKEN))
    expect(res.status).toBe(200)
    expect(await res.json()).toBeNull()
  })
})

describe("parseUnifiedDiff", () => {
  it("extracts filename, status, and line counts per file", () => {
    const diff =
      "diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n" +
      "diff --git a/src/old.ts b/src/old.ts\n--- a/src/old.ts\n+++ b/src/old.ts\n@@ -1,2 +1,2 @@\n const k=1\n-const y=2\n+const y=3\n"
    const files = parseUnifiedDiff(diff)
    expect(files).toHaveLength(2)
    expect(files[0]).toMatchObject({ filename: "src/new.ts", status: "added", additions: 2, deletions: 0 })
    expect(files[1]).toMatchObject({ filename: "src/old.ts", status: "modified", additions: 1, deletions: 1 })
  })
  it("does not count the --- / +++ header lines as deletions/additions", () => {
    const [f] = parseUnifiedDiff(DIFF)
    expect(f).toMatchObject({ additions: 1, deletions: 1 })
  })
  it("is CRLF-safe (does not return an empty manifest on \\r\\n diffs)", () => {
    const [f] = parseUnifiedDiff(DIFF.replace(/\n/g, "\r\n"))
    expect(f).toMatchObject({ filename: "a.ts", additions: 1, deletions: 1 })
  })
})
