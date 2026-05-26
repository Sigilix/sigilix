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
const mockPostDraftSkipNotice = vi.fn(async () => ({ kind: "posted" as const, commentId: 1000 }))
const mockSupersedeDraftSkipNotice = vi.fn(async () => ({ kind: "not-found" as const }))
const mockLoadSigilixConfig = vi.fn()
const mockGetInstallationToken = vi.fn(async () => "fake-token")
const mockEnqueuePrReviewJob = vi.fn(async () => ({ ok: true as const }))

vi.mock("../src/lib/pr-overview-stub", () => ({
  postPrOverviewStubIfNeeded: (a: unknown) => mockPostStub(a),
}))

vi.mock("../src/lib/pr-draft-skip-notice", () => ({
  postDraftPrSkipNotice: (a: unknown) => mockPostDraftSkipNotice(a),
  supersedeDraftPrSkipNotice: (a: unknown) => mockSupersedeDraftSkipNotice(a),
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
      head: {
        sha: "a".repeat(40),
        ref: "feature/x",
        repo: { full_name: "acme/site" },
      },
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
  return postWebhookPayload(worker, env, makeWebhookPayload())
}

async function postWebhookPayload(
  worker: { fetch: (req: Request, env: unknown, ctx: unknown) => Promise<Response> },
  env: unknown,
  payload: unknown,
  waitUntilPromises: Promise<unknown>[] = [],
): Promise<Response> {
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
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => { waitUntilPromises.push(promise) },
    passThroughOnException: () => {},
  }
  const res = await worker.fetch(req, env, ctx)
  await Promise.all(waitUntilPromises)
  return res
}

beforeEach(() => {
  mockPostStub.mockClear()
  mockPostDraftSkipNotice.mockClear()
  mockSupersedeDraftSkipNotice.mockClear()
  mockLoadSigilixConfig.mockReset()
  mockGetInstallationToken.mockClear()
  mockEnqueuePrReviewJob.mockClear()
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

describe("pull_request webhook → pr-labels queue dispatch (SIG-90)", () => {
  it("enqueues pr-labels + posts the SIG-219 'Reviewing…' stub when overview.enabled = true", async () => {
    // SIG-216 dropped the pre-review stub under the theory that the
    // inline overview render inside `handlePrReviewEnsemble` was
    // enough. SIG-219 restored the stub-post — founder feedback
    // (2026-05-26) was that the CodeRabbit-style sticky-then-morph
    // UX is what's wanted. The pr-overview standalone queue
    // dispatch stays gone (overview is inlined now); pr-labels
    // still fires independently per founder direction.
    mockLoadSigilixConfig.mockResolvedValueOnce({ overview: { enabled: true } })
    const { env, sentJobs } = makeEnv()
    const worker = (await import("../src/index")).default

    const res = await postWebhook(worker, env)

    expect(res.status).toBe(202)
    const types = sentJobs.map((j) => j.type)
    expect(types).not.toContain("pr-overview")
    expect(types).toContain("pr-labels")
    // SIG-219: stub MUST post when overview is enabled and review is
    // going to run — the "Reviewing…" sticky is the first thing the
    // user sees and gets morphed in place by the inline overview path.
    expect(mockPostStub).toHaveBeenCalledTimes(1)
  })

  it("STILL enqueues pr-labels when overview.enabled = false (founder direction)", async () => {
    // SIG-90 contract: labels are independent of overview. Disabling
    // overview must NOT suppress the label-picker.
    //
    // SIG-216: no pr-overview enqueue (gone for all paths).
    // SIG-219: stub-post is gated on `overviewEnabled`, so an opt-out
    // customer doesn't get a stub either — same expectation as before.
    mockLoadSigilixConfig.mockResolvedValueOnce({ overview: { enabled: false } })
    const { env, sentJobs } = makeEnv()
    const worker = (await import("../src/index")).default

    const res = await postWebhook(worker, env)

    expect(res.status).toBe(202)
    const types = sentJobs.map((j) => j.type)
    expect(types).not.toContain("pr-overview")
    expect(types).toContain("pr-labels")
    expect(mockPostStub).not.toHaveBeenCalled()
  })

  it("posts a draft-skip notice and does NOT enqueue pr-labels for draft PR webhooks", async () => {
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
    expect(mockPostDraftSkipNotice).toHaveBeenCalledOnce()
    expect(mockPostDraftSkipNotice).toHaveBeenCalledWith(expect.objectContaining({
      owner: "acme",
      repo: "site",
      prNumber: 73,
      headSha: "a".repeat(40),
    }))
    expect(mockEnqueuePrReviewJob).not.toHaveBeenCalled()
  })

  it("posts a draft-skip notice when a PR is converted back to draft", async () => {
    const { env, sentJobs } = makeEnv()
    const worker = (await import("../src/index")).default

    const body = JSON.stringify({
      ...makeWebhookPayload(),
      action: "converted_to_draft",
      pull_request: { ...makeWebhookPayload().pull_request, draft: true },
    })
    const sig = await signBody(body)
    const req = new Request("https://example.com/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "test-delivery-converted-to-draft",
        "x-hub-signature-256": sig,
      },
      body,
    })
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} }
    const res = await worker.fetch(req, env as never, ctx as never)

    expect(res.status).toBe(200)
    expect(sentJobs).toHaveLength(0)
    expect(mockPostDraftSkipNotice).toHaveBeenCalledOnce()
    expect(mockPostDraftSkipNotice).toHaveBeenCalledWith(expect.objectContaining({
      owner: "acme",
      repo: "site",
      prNumber: 73,
      headSha: "a".repeat(40),
    }))
    expect(mockEnqueuePrReviewJob).not.toHaveBeenCalled()
  })

  it("supersedes the draft-skip notice on ready_for_review even when review dispatch is skipped", async () => {
    mockLoadSigilixConfig.mockResolvedValueOnce({ overview: { enabled: true } })
    const { env, sentJobs } = makeEnv()
    env.OPENCLAW_PR_REVIEW_SKIP_RELEASE_BRANCHES = "on"
    const worker = (await import("../src/index")).default

    const body = JSON.stringify({
      ...makeWebhookPayload(),
      action: "ready_for_review",
      pull_request: {
        ...makeWebhookPayload().pull_request,
        draft: false,
        base: { sha: "b".repeat(40), ref: "main" },
        head: { sha: "a".repeat(40), ref: "dev" },
      },
    })
    const sig = await signBody(body)
    const req = new Request("https://example.com/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "test-delivery-ready-for-review",
        "x-hub-signature-256": sig,
      },
      body,
    })
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} }
    const res = await worker.fetch(req, env as never, ctx as never)

    expect(res.status).toBe(202)
    // SIG-216: pr-overview normally runs inline from the ensemble's
    // review-post path (no separate webhook-time enqueue). SIG-216
    // CR fix-up: when the review is SKIPPED
    // (`OPENCLAW_PR_REVIEW_SKIP_RELEASE_BRANCHES=on` here →
    // `decision.review=false` while `decision.overview=true`), the
    // ensemble never fires, so we re-enqueue a standalone pr-overview
    // job so the overview still lands.
    expect(sentJobs.map((j) => j.type).sort()).toEqual(["pr-labels", "pr-overview"])
    expect(mockEnqueuePrReviewJob).not.toHaveBeenCalled()
    expect(mockSupersedeDraftSkipNotice).toHaveBeenCalledOnce()
    expect(mockSupersedeDraftSkipNotice).toHaveBeenCalledWith(expect.objectContaining({
      owner: "acme",
      repo: "site",
      prNumber: 73,
      headSha: "a".repeat(40),
    }))
  })

  it("enqueues branch indexing only when pull_request head repo is verified same-repo", async () => {
    mockLoadSigilixConfig.mockResolvedValueOnce({ overview: { enabled: false } })
    const { env, sentJobs } = makeEnv()
    env.OPENCLAW_INDEXER_ENABLED = "on"
    const worker = (await import("../src/index")).default
    const waitUntilPromises: Promise<unknown>[] = []

    const res = await postWebhookPayload(worker, env, makeWebhookPayload(), waitUntilPromises)
    await Promise.all(waitUntilPromises)

    expect(res.status).toBe(202)
    expect(sentJobs).toContainEqual(expect.objectContaining({
      type: "index-repo",
      reason: "pull-request",
      branch: "feature/x",
    }))
  })

  it("does not enqueue branch indexing for missing or forked pull_request heads", async () => {
    mockLoadSigilixConfig.mockResolvedValue({ overview: { enabled: false } })
    const { env, sentJobs } = makeEnv()
    env.OPENCLAW_INDEXER_ENABLED = "on"
    const worker = (await import("../src/index")).default

    const missingHeadRepoWaits: Promise<unknown>[] = []
    await postWebhookPayload(
      worker,
      env,
      {
        ...makeWebhookPayload(),
        pull_request: {
          ...makeWebhookPayload().pull_request,
          head: { sha: "a".repeat(40), ref: "missing-repo" },
        },
      },
      missingHeadRepoWaits,
    )
    await Promise.all(missingHeadRepoWaits)

    const forkWaits: Promise<unknown>[] = []
    await postWebhookPayload(
      worker,
      env,
      {
        ...makeWebhookPayload(),
        pull_request: {
          ...makeWebhookPayload().pull_request,
          head: {
            sha: "a".repeat(40),
            ref: "fork-branch",
            repo: { full_name: "other/site" },
          },
        },
      },
      forkWaits,
    )
    await Promise.all(forkWaits)

    expect(sentJobs.filter((job) => job.type === "index-repo")).toHaveLength(0)
  })
})
