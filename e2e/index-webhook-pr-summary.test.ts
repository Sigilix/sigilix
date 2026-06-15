// SIG-437 — `@sigilix summary` webhook trigger.
//
// Exercises the real `default.fetch` handler from src/index.ts with a signed
// `pull_request` payload and asserts the `pr-summary` queue-dispatch contract at
// the only place that matters — the webhook handler's trigger gate:
//
//   - flag on + `@sigilix summary` in the body            → pr-summary enqueued
//   - flag off (default)                                  → NOT enqueued
//   - flag on but no marker                               → NOT enqueued
//   - flag on + marker, but a non-body-bearing action     → NOT enqueued
//   - the enqueue runs BEFORE the overview/review early return (summary-only
//     event with no overview/review still fires)
//   - a failing OPENCLAW_JOBS.send for the summary job does NOT fail the webhook
//
// Mirrors the index-webhook-pr-labels.test.ts harness.

import { beforeEach, describe, expect, it, vi } from "vitest"

const mockPostStub = vi.fn(async (_a?: unknown) => ({ kind: "posted" as const, commentId: 999 }))
const mockPostDraftSkipNotice = vi.fn(async (_a?: unknown) => ({ kind: "posted" as const, commentId: 1000 }))
const mockSupersedeDraftSkipNotice = vi.fn(async (_a?: unknown) => ({ kind: "not-found" as const }))
const mockLoadSigilixConfig = vi.fn()
const mockGetInstallationToken = vi.fn(async (_a?: unknown) => "fake-token")
const mockEnqueuePrReviewJob = vi.fn(async (_env?: unknown, _args?: unknown) => ({ ok: true as const }))

vi.mock("@/src/lib/pr-overview-stub", () => ({
  postPrOverviewStubIfNeeded: (a: unknown) => mockPostStub(a),
}))

vi.mock("@/src/lib/pr-draft-skip-notice", () => ({
  postDraftPrSkipNotice: (a: unknown) => mockPostDraftSkipNotice(a),
  supersedeDraftPrSkipNotice: (a: unknown) => mockSupersedeDraftSkipNotice(a),
}))

vi.mock("@/src/shared/adapters/github/github-app", () => ({
  getInstallationToken: (a: unknown) => mockGetInstallationToken(a),
}))

vi.mock("@/src/shared/adapters/github", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/github")>("@/src/shared/adapters/github")
  return {
    ...actual,
    GitHubClient: vi.fn().mockImplementation(() => ({})),
  }
})

vi.mock("@/src/lib/sigilix-config", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/sigilix-config")>("@/src/lib/sigilix-config")
  return {
    ...actual,
    loadSigilixConfig: (...a: unknown[]) => mockLoadSigilixConfig(...a),
  }
})

vi.mock("@/src/do/webhook-enqueue", () => ({
  enqueuePrReviewJob: (env: unknown, args: unknown) => mockEnqueuePrReviewJob(env, args),
}))

// ─── HMAC signer mirroring GitHub's X-Hub-Signature-256 ────────────

const SECRET = "test-webhook-secret"
const encoder = new TextEncoder()

async function signBody(body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(body))
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  return `sha256=${hex}`
}

// ─── Fixtures ────────────────────────────────────────────────────────

function makeWebhookPayload(overrides?: { action?: string; body?: string | null; headSha?: string }) {
  return {
    action: overrides?.action ?? "opened",
    installation: { id: 12345 },
    repository: { name: "site", owner: { login: "acme" }, full_name: "acme/site" },
    pull_request: {
      number: 73,
      draft: false,
      body: overrides?.body ?? null,
      head: {
        sha: overrides?.headSha ?? "a".repeat(40),
        ref: "sig-437-feature",
        repo: { full_name: "acme/site" },
      },
      base: { sha: "b".repeat(40), ref: "main" },
    },
  }
}

function makeEnv(overrides?: Record<string, unknown>): {
  env: Record<string, unknown>
  sentJobs: Array<{ type: string; [k: string]: unknown }>
} {
  const sentJobs: Array<{ type: string; [k: string]: unknown }> = []
  const env = {
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
    GITHUB_WEBHOOK_SECRET: SECRET,
    OPENCLAW_REVIEW_MANIFEST_ENABLED: "off",
    OPENCLAW_JOBS: {
      send: async (msg: { type: string; [k: string]: unknown }) => {
        sentJobs.push(msg)
      },
    },
    OPENCLAW_STATE: {
      get: async (_k: string) => null,
      put: async (_k: string, _v: string) => {},
      delete: async (_k: string) => {},
    },
    ...overrides,
  }
  return { env, sentJobs }
}

async function postWebhookPayload(
  worker: { fetch: (req: Request, env: never, ctx: never) => Promise<Response> },
  env: unknown,
  payload: unknown,
): Promise<{ res: Response; sent: Promise<unknown>[] }> {
  const body = JSON.stringify(payload)
  const sig = await signBody(body)
  const req = new Request("https://example.com/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": "test-delivery-id",
      "x-hub-signature-256": sig,
    },
    body,
  })
  const waitUntilPromises: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      waitUntilPromises.push(promise)
    },
    passThroughOnException: () => {},
  }
  const res = await worker.fetch(req, env as never, ctx as never)
  await Promise.all(waitUntilPromises)
  return { res, sent: waitUntilPromises }
}

beforeEach(() => {
  mockPostStub.mockClear()
  mockPostDraftSkipNotice.mockClear()
  mockSupersedeDraftSkipNotice.mockClear()
  mockLoadSigilixConfig.mockReset().mockResolvedValue({ overview: { enabled: false } })
  mockGetInstallationToken.mockClear()
  mockEnqueuePrReviewJob.mockClear()
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

describe("pull_request webhook → pr-summary trigger (SIG-437)", () => {
  it("enqueues pr-summary when the flag is ON and the body carries @sigilix summary", async () => {
    const { env, sentJobs } = makeEnv({ OPENCLAW_PR_SUMMARY_MODE: "on" })
    const worker = (await import("@/src/index")).default

    const { res } = await postWebhookPayload(
      worker,
      env,
      makeWebhookPayload({ body: "## Context\n\n@sigilix summary\n\n## Footer" }),
    )

    expect(res.status).toBe(202)
    const summaryJobs = sentJobs.filter((j) => j.type === "pr-summary")
    expect(summaryJobs).toHaveLength(1)
    expect(summaryJobs[0]).toMatchObject({
      type: "pr-summary",
      owner: "acme",
      repo: "site",
      prNumber: 73,
      headSha: "a".repeat(40),
      installationId: 12345,
    })
  })

  it("does NOT enqueue pr-summary when the flag is OFF (default), even with the marker", async () => {
    const { env, sentJobs } = makeEnv() // no OPENCLAW_PR_SUMMARY_MODE → off
    const worker = (await import("@/src/index")).default

    await postWebhookPayload(worker, env, makeWebhookPayload({ body: "@sigilix summary" }))

    expect(sentJobs.some((j) => j.type === "pr-summary")).toBe(false)
  })

  it("does NOT enqueue pr-summary when the flag is ON but the marker is absent", async () => {
    const { env, sentJobs } = makeEnv({ OPENCLAW_PR_SUMMARY_MODE: "on" })
    const worker = (await import("@/src/index")).default

    await postWebhookPayload(worker, env, makeWebhookPayload({ body: "a normal PR description" }))

    expect(sentJobs.some((j) => j.type === "pr-summary")).toBe(false)
  })

  it("fires on a summary-only `edited` event (no overview/review) — enqueue is before the early return", async () => {
    const { env, sentJobs } = makeEnv({ OPENCLAW_PR_SUMMARY_MODE: "on" })
    const worker = (await import("@/src/index")).default

    // `edited` is not in the overview/review action set → decidePullRequestJobs
    // returns {overview:false, review:false}. The summary trigger must still
    // fire because it is enqueued BEFORE that early return.
    const { res } = await postWebhookPayload(
      worker,
      env,
      makeWebhookPayload({ action: "edited", body: "@sigilix summary" }),
    )

    expect(res.status).toBe(200) // "skip pr action" — but summary already enqueued
    expect(sentJobs.filter((j) => j.type === "pr-summary")).toHaveLength(1)
  })

  it("does NOT fire on a non-body-bearing action (e.g. `synchronize`)", async () => {
    const { env, sentJobs } = makeEnv({ OPENCLAW_PR_SUMMARY_MODE: "on" })
    const worker = (await import("@/src/index")).default

    await postWebhookPayload(worker, env, makeWebhookPayload({ action: "synchronize", body: "@sigilix summary" }))

    expect(sentJobs.some((j) => j.type === "pr-summary")).toBe(false)
  })

  it("a failing summary enqueue does NOT fail the webhook (best-effort)", async () => {
    const { env } = makeEnv({ OPENCLAW_PR_SUMMARY_MODE: "on" })
    // make the summary send throw; the other sends (pr-labels) should be
    // unaffected because each call is independent.
    ;(env.OPENCLAW_JOBS as { send: (m: { type: string }) => Promise<void> }).send = async (m) => {
      if (m.type === "pr-summary") throw new Error("queue unavailable")
    }
    const worker = (await import("@/src/index")).default

    const { res } = await postWebhookPayload(worker, env, makeWebhookPayload({ body: "@sigilix summary" }))

    // webhook still returns a success status despite the summary enqueue failure
    expect(res.status).toBe(202)
  })
})
