// SIG-89 — webhook-level integration: skip enqueuePrReviewJob on a
// byte-identical `synchronize` diff (no-op merge / no-op force-push /
// empty-commit push).
//
// Exercises the actual `default.fetch` handler in src/index.ts with
// signed `pull_request` payloads + a faked diff-fetch + KV-stashed
// prior hash. Pins the skip contract at the only place that matters:
// whether `enqueuePrReviewJob` and `pr-stale-mark` are dispatched.

import { beforeEach, describe, expect, it, vi } from "vitest"

import { computeDiffHash } from "../src/lib/noop-merge-detect"

// ─── Module mocks ─────────────────────────────────────────────────────

const CURRENT_DIFF = "diff --git a/foo b/foo\n@@ -1 +1 @@\n-x\n+y\n"

const mockPostStub = vi.fn(async () => ({ kind: "posted" as const, commentId: 999 }))
const mockLoadSigilixConfig = vi.fn(async () => ({ overview: { enabled: true } }))
const mockGetInstallationToken = vi.fn(async () => "fake-token")
const mockEnqueuePrReviewJob = vi.fn(async () => ({ ok: true as const }))
const mockGetPullRequestDiff = vi.fn(async () => CURRENT_DIFF)

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
    GitHubClient: vi.fn().mockImplementation(() => ({
      getPullRequestDiff: (o: string, r: string, n: number) =>
        mockGetPullRequestDiff(o, r, n),
    })),
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

// ─── HMAC signer ──────────────────────────────────────────────────────

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

// ─── Fixtures ─────────────────────────────────────────────────────────

const OWNER = "acme"
const REPO = "site"
const PR_NUMBER = 73

function synchronizePayload(): unknown {
  return {
    action: "synchronize",
    installation: { id: 12345 },
    repository: {
      name: REPO,
      owner: { login: OWNER },
      full_name: `${OWNER}/${REPO}`,
    },
    pull_request: {
      number: PR_NUMBER,
      draft: false,
      head: { sha: "a".repeat(40), ref: "feature/x" },
      base: { sha: "b".repeat(40), ref: "main" },
    },
  }
}

function makeEnv(initialKv: Record<string, string> = {}): {
  env: Record<string, unknown>
  sentJobs: Array<{ type: string; [k: string]: unknown }>
  kvStore: Record<string, string>
} {
  const sentJobs: Array<{ type: string; [k: string]: unknown }> = []
  const kvStore = { ...initialKv }
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
      get: async (k: string) => kvStore[k] ?? null,
      put: async (k: string, v: string) => {
        kvStore[k] = v
      },
      delete: async (k: string) => {
        delete kvStore[k]
      },
    },
  }
  return { env, sentJobs, kvStore }
}

async function postSynchronizeWebhook(
  worker: { fetch: (req: Request, env: unknown, ctx: unknown) => Promise<Response> },
  env: unknown,
  payload: unknown = synchronizePayload(),
): Promise<Response> {
  const body = JSON.stringify(payload)
  const sig = await signBody(body)
  const req = new Request("https://example.com/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": "test-delivery-sig89",
      "x-hub-signature-256": sig,
    },
    body,
  })
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} }
  return worker.fetch(req, env as never, ctx as never)
}

beforeEach(() => {
  mockPostStub.mockClear()
  mockLoadSigilixConfig.mockClear()
  mockGetInstallationToken.mockClear()
  mockEnqueuePrReviewJob.mockClear()
  mockGetPullRequestDiff.mockClear()
  mockGetPullRequestDiff.mockResolvedValue(CURRENT_DIFF)
  mockLoadSigilixConfig.mockResolvedValue({ overview: { enabled: true } })
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

describe("synchronize webhook → noop-merge skip (SIG-89)", () => {
  it("SKIPS enqueuePrReviewJob when the diff hash matches the prior reviewed hash", async () => {
    const priorHash = await computeDiffHash(CURRENT_DIFF)
    const { env, sentJobs } = makeEnv({
      [`pr-review-diff-hash:${OWNER}/${REPO}#${PR_NUMBER}`]: JSON.stringify({
        diffHash: priorHash,
        reviewedHeadSha: "0".repeat(40),
        hashedAt: 1_700_000_000_000,
      }),
    })
    const worker = (await import("../src/index")).default

    const res = await postSynchronizeWebhook(worker, env)

    expect(res.status).toBe(202)
    expect(mockEnqueuePrReviewJob).not.toHaveBeenCalled()
    // pr-stale-mark MUST NOT fire either — the prior review stays
    // authoritative, nothing to dismiss.
    expect(sentJobs.map((j) => j.type)).not.toContain("pr-stale-mark")
  })

  it("DISPATCHES enqueuePrReviewJob when the diff hash differs (real content change)", async () => {
    const { env } = makeEnv({
      [`pr-review-diff-hash:${OWNER}/${REPO}#${PR_NUMBER}`]: JSON.stringify({
        diffHash: "deadbeef".repeat(8),  // 64 hex chars, won't match
        reviewedHeadSha: "0".repeat(40),
        hashedAt: 1_700_000_000_000,
      }),
    })
    const worker = (await import("../src/index")).default

    const res = await postSynchronizeWebhook(worker, env)

    expect(res.status).toBe(202)
    expect(mockEnqueuePrReviewJob).toHaveBeenCalledOnce()
  })

  it("DISPATCHES enqueuePrReviewJob on first-review (no prior hash stashed)", async () => {
    // Empty KV — first review on the PR. No prior hash to compare
    // against, so we MUST dispatch.
    const { env } = makeEnv()
    const worker = (await import("../src/index")).default

    const res = await postSynchronizeWebhook(worker, env)

    expect(res.status).toBe(202)
    expect(mockEnqueuePrReviewJob).toHaveBeenCalledOnce()
    // The skip path should not even fetch the diff when no prior hash
    // exists — saves the GitHub API round-trip on first-review.
    expect(mockGetPullRequestDiff).not.toHaveBeenCalled()
  })

  it("DISPATCHES enqueuePrReviewJob when the diff fetch fails (fail-open)", async () => {
    const priorHash = await computeDiffHash(CURRENT_DIFF)
    const { env } = makeEnv({
      [`pr-review-diff-hash:${OWNER}/${REPO}#${PR_NUMBER}`]: JSON.stringify({
        diffHash: priorHash,
        reviewedHeadSha: "0".repeat(40),
        hashedAt: 1_700_000_000_000,
      }),
    })
    mockGetPullRequestDiff.mockRejectedValueOnce(new Error("github 503"))
    const worker = (await import("../src/index")).default

    const res = await postSynchronizeWebhook(worker, env)

    expect(res.status).toBe(202)
    // Fail-open: a diff-fetch error MUST fall through to the normal
    // dispatch path so the worst case is a wasted review, never a
    // missed review.
    expect(mockEnqueuePrReviewJob).toHaveBeenCalledOnce()
  })

  it("DISPATCHES on `opened` action even when a prior hash exists (skip is synchronize-only)", async () => {
    const priorHash = await computeDiffHash(CURRENT_DIFF)
    const { env } = makeEnv({
      [`pr-review-diff-hash:${OWNER}/${REPO}#${PR_NUMBER}`]: JSON.stringify({
        diffHash: priorHash,
        reviewedHeadSha: "0".repeat(40),
        hashedAt: 1_700_000_000_000,
      }),
    })
    const worker = (await import("../src/index")).default

    const openedPayload = { ...synchronizePayload(), action: "opened" } as Record<string, unknown>
    const res = await postSynchronizeWebhook(worker, env, openedPayload)

    expect(res.status).toBe(202)
    expect(mockEnqueuePrReviewJob).toHaveBeenCalledOnce()
    // pr-review-skipped-noop-merge is gated on action=synchronize.
    // `opened` actions shouldn't even consult KV / fetch the diff.
    expect(mockGetPullRequestDiff).not.toHaveBeenCalled()
  })

  it("DISPATCHES when OPENCLAW_NOOP_MERGE_SKIP_ENABLED=off (kill-switch)", async () => {
    const priorHash = await computeDiffHash(CURRENT_DIFF)
    const { env } = makeEnv({
      [`pr-review-diff-hash:${OWNER}/${REPO}#${PR_NUMBER}`]: JSON.stringify({
        diffHash: priorHash,
        reviewedHeadSha: "0".repeat(40),
        hashedAt: 1_700_000_000_000,
      }),
    })
    env.OPENCLAW_NOOP_MERGE_SKIP_ENABLED = "off"
    const worker = (await import("../src/index")).default

    const res = await postSynchronizeWebhook(worker, env)

    expect(res.status).toBe(202)
    // Kill-switch must prevent BOTH the skip AND the diff fetch — the
    // whole point is to avoid the latency tax + GitHub API call.
    expect(mockEnqueuePrReviewJob).toHaveBeenCalledOnce()
    expect(mockGetPullRequestDiff).not.toHaveBeenCalled()
  })

  it("does NOT touch pr-overview path (still dispatches stub + queue)", async () => {
    // The skip is review-only. pr-overview is cheap + a no-op merge
    // is still a meaningful timeline event worth a fresh sticky.
    const priorHash = await computeDiffHash(CURRENT_DIFF)
    const { env, sentJobs } = makeEnv({
      [`pr-review-diff-hash:${OWNER}/${REPO}#${PR_NUMBER}`]: JSON.stringify({
        diffHash: priorHash,
        reviewedHeadSha: "0".repeat(40),
        hashedAt: 1_700_000_000_000,
      }),
    })
    const worker = (await import("../src/index")).default

    await postSynchronizeWebhook(worker, env)

    // Both the stub-post helper + the pr-overview queue dispatch
    // still fire on the no-op-merge skip path.
    expect(mockPostStub).toHaveBeenCalledOnce()
    expect(sentJobs.map((j) => j.type)).toContain("pr-overview")
    expect(sentJobs.map((j) => j.type)).toContain("pr-labels")
  })
})
