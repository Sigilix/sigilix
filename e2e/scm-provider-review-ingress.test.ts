// SCM-provider abstraction (foundation for GitLab): the PR-review INGRESS now
// routes through the `ScmProvider` seam — signature verify, the event→trigger
// decision, and the per-installation review-client build. This suite pins the
// seam two ways:
//
//   1. INTEGRATION — drive a real signed `pull_request.opened` delivery through
//      the actual `default.fetch` handler (src/index.ts) and assert the SAME
//      observable I/O as before the seam: 202 ack, review job enqueued, the
//      "Reviewing…" stub posted, and the review-client build delegated (the App
//      token mint fires). A tampered signature is rejected (the verify gate).
//      This would FAIL if the seam dropped or changed any ingress behavior.
//
//   2. DELEGATION PARITY — the GitHub provider's methods are byte-for-byte the
//      existing GitHub functions (`verifyGitHubWebhook` / `decidePullRequestJobs`).
//
// Harness mirrors e2e/index-webhook-pr-labels.test.ts (the same webhook path).

import { beforeEach, describe, expect, it, vi } from "vitest"

// ─── Module mocks (kept above the dynamic import below) ─────────────

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

function makeWebhookPayload() {
  return {
    action: "opened",
    installation: { id: 12345 },
    repository: { name: "site", owner: { login: "acme" }, full_name: "acme/site" },
    pull_request: {
      number: 73,
      draft: false,
      head: { sha: "a".repeat(40), ref: "feature/x", repo: { full_name: "acme/site" } },
      base: { sha: "b".repeat(40), ref: "main" },
    },
  }
}

function makeBillableWebhookPayload() {
  const payload = makeWebhookPayload()
  return {
    ...payload,
    repository: { ...payload.repository, id: 67890 },
    pull_request: {
      ...payload.pull_request,
      user: { id: 111, login: "author" },
      author_association: "MEMBER",
    },
    sender: { id: 222, login: "sender" },
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

async function postSignedWebhook(
  worker: { fetch: (req: Request, env: never, ctx: never) => Promise<Response> },
  env: unknown,
  payload: unknown,
  signature?: string,
  deliveryId = "test-delivery-scm",
): Promise<Response> {
  const body = JSON.stringify(payload)
  const sig = signature ?? (await signBody(body))
  const req = new Request("https://example.com/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": sig,
    },
    body,
  })
  const waits: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      waits.push(p)
    },
    passThroughOnException: () => {},
  }
  const res = await worker.fetch(req, env as never, ctx as never)
  await Promise.all(waits)
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

describe("pull_request review ingress through the ScmProvider seam", () => {
  it("verifies, decides review, enqueues the review job, posts the stub, and builds the client via the provider", async () => {
    mockLoadSigilixConfig.mockResolvedValueOnce({ overview: { enabled: true } })
    const { env, sentJobs } = makeEnv()
    const worker = (await import("@/src/index")).default

    const res = await postSignedWebhook(worker, env, makeWebhookPayload())

    // Same ack as the pre-seam path.
    expect(res.status).toBe(202)
    // parseReviewEvent → { overview: true, review: true } flowed through: the
    // review job is enqueued (proves the seam's decision reached dispatch).
    expect(mockEnqueuePrReviewJob).toHaveBeenCalledOnce()
    expect(mockEnqueuePrReviewJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ owner: "acme", repo: "site", prNumber: 73, headSha: "a".repeat(40) }),
    )
    // Overview side-effects unchanged: labels enqueued, "Reviewing…" stub posted.
    expect(sentJobs.map((j) => j.type)).toContain("pr-labels")
    expect(mockPostStub).toHaveBeenCalledOnce()
    // buildReviewClient delegated to the App-token mint (the client build).
    expect(mockGetInstallationToken).toHaveBeenCalledOnce()
  })

  it("threads exact signed activity-seat evidence into an accepted automatic review", async () => {
    mockLoadSigilixConfig.mockResolvedValueOnce({ overview: { enabled: false } })
    const { env } = makeEnv()
    const worker = (await import("@/src/index")).default

    const res = await postSignedWebhook(worker, env, makeBillableWebhookPayload())

    expect(res.status).toBe(202)
    expect(mockEnqueuePrReviewJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        activitySeatEvidence: {
          deliveryId: "test-delivery-scm",
          payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
          installationId: 12345,
          repositoryId: 67890,
          prNumber: 73,
          headSha: "a".repeat(40),
          action: "opened",
          targetGithubUserId: "111",
          targetLogin: "author",
          actorGithubUserId: "222",
          actorLogin: "sender",
          authorAssociation: "MEMBER",
          receivedAtMs: expect.any(Number),
        },
      }),
    )
  })

  it("routes a release-promotion skip through the real handler (overview only, no review job)", async () => {
    // Exercises baseRef/headRef/skipReleasePromotions flowing through
    // parseReviewEvent in the actual webhook path: dev→main with the skip flag
    // on decides { overview: true, review: false } — the ensemble review is
    // skipped but the standalone overview still fires.
    mockLoadSigilixConfig.mockResolvedValueOnce({ overview: { enabled: true } })
    const { env, sentJobs } = makeEnv()
    env.OPENCLAW_PR_REVIEW_SKIP_RELEASE_BRANCHES = "on"
    const worker = (await import("@/src/index")).default

    const payload = {
      ...makeWebhookPayload(),
      pull_request: {
        ...makeWebhookPayload().pull_request,
        base: { sha: "b".repeat(40), ref: "main" },
        head: { sha: "a".repeat(40), ref: "dev", repo: { full_name: "acme/site" } },
      },
    }
    const res = await postSignedWebhook(worker, env, payload)

    expect(res.status).toBe(202)
    expect(mockEnqueuePrReviewJob).not.toHaveBeenCalled()
    expect(sentJobs.map((j) => j.type).sort()).toEqual(["pr-labels", "pr-overview"])
  })

  it("honors an @sigilix ignore PR body through the real handler (skip, nothing enqueued)", async () => {
    // Exercises prBody flowing through parseReviewEvent in the actual path: the
    // ignore directive decides { overview: false, review: false }.
    const { env, sentJobs } = makeEnv()
    const worker = (await import("@/src/index")).default

    const payload = {
      ...makeWebhookPayload(),
      pull_request: { ...makeWebhookPayload().pull_request, body: "@sigilix ignore" },
    }
    const res = await postSignedWebhook(worker, env, payload)

    expect(res.status).toBe(200)
    expect(sentJobs.map((j) => j.type)).not.toContain("pr-labels")
    expect(mockEnqueuePrReviewJob).not.toHaveBeenCalled()
    expect(mockPostStub).not.toHaveBeenCalled()
  })

  it("rejects a tampered signature at the provider verify gate (401, nothing enqueued)", async () => {
    const { env, sentJobs } = makeEnv()
    const worker = (await import("@/src/index")).default

    const res = await postSignedWebhook(worker, env, makeWebhookPayload(), "sha256=deadbeef")

    expect(res.status).toBe(401)
    expect(sentJobs).toHaveLength(0)
    expect(mockEnqueuePrReviewJob).not.toHaveBeenCalled()
    expect(mockGetInstallationToken).not.toHaveBeenCalled()
  })
})

describe("GitHubScmProvider delegation parity", () => {
  it("verifyWebhook matches verifyGitHubWebhook (accept valid, reject tampered)", async () => {
    const { selectScmProvider } = await import("@/src/index-scm-provider")
    const { verifyGitHubWebhook } = await import("@/src/shared/adapters/github/github-webhook-verify")
    const provider = selectScmProvider("github")
    expect(provider.kind).toBe("github")

    const body = JSON.stringify(makeWebhookPayload())
    const goodSig = await signBody(body)

    const viaProviderGood = await provider.verifyWebhook({ rawBody: body, signature: goodSig, secret: SECRET })
    const viaDirectGood = await verifyGitHubWebhook(body, goodSig, SECRET)
    expect(viaProviderGood).toBe(true)
    expect(viaProviderGood).toBe(viaDirectGood)

    const viaProviderBad = await provider.verifyWebhook({ rawBody: body, signature: "sha256=00", secret: SECRET })
    const viaDirectBad = await verifyGitHubWebhook(body, "sha256=00", SECRET)
    expect(viaProviderBad).toBe(false)
    expect(viaProviderBad).toBe(viaDirectBad)
  })

  it("parseReviewEvent matches decidePullRequestJobs across the action matrix", async () => {
    const { selectScmProvider } = await import("@/src/index-scm-provider")
    const { decidePullRequestJobs } = await import("@/src/index-internals")
    const provider = selectScmProvider("github")

    const cases = [
      { action: "opened", draft: false },
      { action: "synchronize", draft: false },
      { action: "reopened", draft: false },
      { action: "ready_for_review", draft: false },
      { action: "closed", draft: false },
      { action: "opened", draft: true },
      { action: "opened", draft: false, baseRef: "main", headRef: "dev", skipReleasePromotions: true },
      { action: "opened", draft: false, prBody: "@sigilix ignore" },
    ] as const

    for (const c of cases) {
      expect(provider.parseReviewEvent({ ...c })).toEqual(decidePullRequestJobs({ ...c }))
    }
  })
})
