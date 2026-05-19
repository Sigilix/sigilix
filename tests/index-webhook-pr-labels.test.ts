// SIG-90 — pr-labels queue send is INDEPENDENT of overview.enabled.
//
// Founder direction (PR #104 cleanup): labels are a separate product
// capability and should fire even when a customer has opted out of
// pr-overview via `sigilix.overview.enabled = false`. Before SIG-90 the
// `pr-labels` send lived inside the `if (overviewEnabled) { ... }`
// block — so opting out of overview silently disabled labels too.
//
// This test exercises the actual `default.fetch` handler from
// src/index.ts with a signed `pull_request` payload + the two
// overview-enabled states (true / false). It pins the SIG-90 contract
// at the only place that matters: the webhook handler's queue dispatch.

import { beforeEach, describe, expect, it, vi } from "vitest"

// ─── Module mocks (kept above the dynamic import below) ─────────────

const mockPostStub = vi.fn(async () => ({ kind: "posted" as const, commentId: 999 }))
const mockLoadSigilixConfig = vi.fn()
const mockGetInstallationToken = vi.fn(async () => "fake-token")
const mockEnqueuePrReviewJob = vi.fn(async () => ({ ok: true as const }))

vi.mock("../src/lib/pr-overview-stub", () => ({
  postPrOverviewStubIfNeeded: (a: unknown) => mockPostStub(a),
}))

vi.mock("../src/lib/github-app", () => ({
  getInstallationToken: (a: unknown) => mockGetInstallationToken(a),
}))

vi.mock("../src/lib/github", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/github")>(
    "../src/lib/github",
  )
  return {
    ...actual,
    GitHubClient: vi.fn().mockImplementation(() => ({})),
  }
})

vi.mock("../src/lib/sigilix-config", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/sigilix-config")>(
    "../src/lib/sigilix-config",
  )
  return {
    ...actual,
    loadSigilixConfig: (...a: unknown[]) => mockLoadSigilixConfig(...a),
  }
})

vi.mock("../src/do/webhook-enqueue", () => ({
  enqueuePrReviewJob: (env: unknown, args: unknown) => mockEnqueuePrReviewJob(env, args),
}))

// ─── HMAC signer mirroring GitHub's X-Hub-Signature-256 ────────────

const SECRET = "test-webhook-secret"
const encoder = new TextEncoder()

async function signBody(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(body))
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  return `sha256=${hex}`
}

// ─── Fixtures ────────────────────────────────────────────────────────

function makeWebhookPayload() {
  return {
    action: "opened",
    installation: { id: 12345 },
    repository: { name: "site", owner: { login: "acme" }, full_name: "acme/site" },
    pull_request: {
      number: 73,
      draft: false,
      head: { sha: "a".repeat(40), ref: "feature/x" },
      base: { sha: "b".repeat(40), ref: "main" },
    },
  }
}

function makeEnv(): {
  env: Record<string, unknown>
  sentJobs: Array<{ type: string; [k: string]: unknown }>
} {
  const sentJobs: Array<{ type: string; [k: string]: unknown }> = []
  const env = {
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
    GITHUB_WEBHOOK_SECRET: SECRET,
    OPENCLAW_PR_REVIEW_MODE: "off",
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
  }
  return { env, sentJobs }
}

async function postWebhook(
  worker: { fetch: (req: Request, env: unknown, ctx: unknown) => Promise<Response> },
  env: unknown,
): Promise<Response> {
  const body = JSON.stringify(makeWebhookPayload())
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
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} }
  return worker.fetch(req, env, ctx)
}

beforeEach(() => {
  mockPostStub.mockClear()
  mockLoadSigilixConfig.mockClear()
  mockGetInstallationToken.mockClear()
  mockEnqueuePrReviewJob.mockClear()
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

describe("pull_request webhook → pr-labels queue dispatch (SIG-90)", () => {
  it("enqueues pr-labels alongside pr-overview when overview.enabled = true", async () => {
    mockLoadSigilixConfig.mockResolvedValueOnce({ overview: { enabled: true } })
    const { env, sentJobs } = makeEnv()
    const worker = (await import("../src/index")).default

    const res = await postWebhook(worker, env)

    expect(res.status).toBe(202)
    const types = sentJobs.map((j) => j.type)
    expect(types).toContain("pr-overview")
    expect(types).toContain("pr-labels")
    expect(mockPostStub).toHaveBeenCalledOnce()
  })

  it("STILL enqueues pr-labels when overview.enabled = false (founder direction)", async () => {
    // SIG-90 contract: labels are independent of overview. Disabling
    // overview must NOT suppress the label-picker.
    mockLoadSigilixConfig.mockResolvedValueOnce({ overview: { enabled: false } })
    const { env, sentJobs } = makeEnv()
    const worker = (await import("../src/index")).default

    const res = await postWebhook(worker, env)

    expect(res.status).toBe(202)
    const types = sentJobs.map((j) => j.type)
    // Overview is OFF — the heavy pr-overview job + the stub-post both
    // skip. But pr-labels still fires.
    expect(types).not.toContain("pr-overview")
    expect(types).toContain("pr-labels")
    expect(mockPostStub).not.toHaveBeenCalled()
  })

  it("does NOT enqueue pr-labels when the action would skip overview entirely (e.g. draft)", async () => {
    // pr-labels rides on the same decision gate as pr-overview. When
    // `decision.overview === false` (e.g. draft PR, irrelevant action),
    // labels also shouldn't fire. SIG-90 only decoupled labels from
    // `overview.enabled`, NOT from `decision.overview`.
    mockLoadSigilixConfig.mockResolvedValue({ overview: { enabled: true } })
    const { env, sentJobs } = makeEnv()
    const worker = (await import("../src/index")).default

    // Send a draft-PR payload (decidePullRequestJobs returns
    // `{ overview: false, review: false }` for drafts).
    const body = JSON.stringify({
      ...makeWebhookPayload(),
      pull_request: { ...makeWebhookPayload().pull_request, draft: true },
    })
    const sig = await signBody(body)
    const req = new Request("https://example.com/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "test-delivery-draft",
        "x-hub-signature-256": sig,
      },
      body,
    })
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} }
    const res = await worker.fetch(req, env as never, ctx as never)

    expect(res.status).toBe(200)
    expect(sentJobs.map((j) => j.type)).not.toContain("pr-labels")
  })
})
