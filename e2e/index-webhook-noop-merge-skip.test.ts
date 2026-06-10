// SIG-89 — webhook-level integration: skip enqueuePrReviewJob on a
// byte-identical `synchronize` diff (no-op merge / no-op force-push /
// empty-commit push).
//
// Exercises the actual `default.fetch` handler in src/index.ts with
// signed `pull_request` payloads + a faked diff-fetch + KV-stashed
// prior hash. Pins the skip contract at the only place that matters:
// whether `enqueuePrReviewJob` and `pr-stale-mark` are dispatched.

import { beforeEach, describe, expect, it, vi } from "vitest"

import { computeDiffHash } from "@/src/lib/noop-merge-detect"

// ─── Module mocks ─────────────────────────────────────────────────────

const CURRENT_DIFF = "diff --git a/foo b/foo\n@@ -1 +1 @@\n-x\n+y\n"

const mockPostStub = vi.fn(async (_a?: unknown) => ({ kind: "posted" as const, commentId: 999 }))
const mockLoadSigilixConfig = vi.fn(async (..._a: unknown[]) => ({ overview: { enabled: true } }))
const mockGetInstallationToken = vi.fn(async (_a?: unknown) => "fake-token")
const mockEnqueuePrReviewJob = vi.fn(async (_env?: unknown, _args?: unknown) => ({ ok: true as const }))
const mockGetPullRequestDiff = vi.fn(
  async (_o?: string, _r?: string, _n?: number, _opts?: { signal?: AbortSignal }) => CURRENT_DIFF,
)

vi.mock("@/src/lib/pr-overview-stub", () => ({
  postPrOverviewStubIfNeeded: (a: unknown) => mockPostStub(a),
}))

vi.mock("@/src/shared/adapters/github/github-app", () => ({
  getInstallationToken: (a: unknown) => mockGetInstallationToken(a),
}))

vi.mock("@/src/shared/adapters/github", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/github")>(
    "@/src/shared/adapters/github",
  )
  return {
    ...actual,
    GitHubClient: vi.fn().mockImplementation(() => ({
      getPullRequestDiff: (
        o: string,
        r: string,
        n: number,
        opts?: { signal?: AbortSignal },
      ) => mockGetPullRequestDiff(o, r, n, opts),
    })),
  }
})

vi.mock("@/src/lib/sigilix-config", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/sigilix-config")>(
    "@/src/lib/sigilix-config",
  )
  return {
    ...actual,
    loadSigilixConfig: (...a: unknown[]) => mockLoadSigilixConfig(...a),
  }
})

vi.mock("@/src/do/webhook-enqueue", () => ({
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

// Minimal valid review-manifest V1 record. The webhook reads this in
// the `pr-stale-mark` enqueue block (src/index.ts ~1731) — without it
// `readReviewManifest` returns `{kind:"not-found"}` and the enqueue is
// skipped silently, which would make the "no pr-stale-mark" assertion
// vacuous. Schema mirrors `src/lib/review-manifest.ts::ReviewManifestV1`.
function manifestKv(): { key: string; value: string } {
  return {
    key: `pr-review-manifest:${OWNER}/${REPO}#${PR_NUMBER}`,
    value: JSON.stringify({
      v: 1,
      prNumber: PR_NUMBER,
      baseSha: "b".repeat(40),
      headSha: "0".repeat(40),
      mergeBaseSha: null,
      fileListHash: "abc",
      promptVersion: "1",
      modelId: "ensemble-synth",
      target: { kind: "review", reviewId: 12345 },
      reviewedAt: 1_700_000_000_000,
    }),
  }
}

function synchronizePayload(): Record<string, unknown> {
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

function makeEnv(
  initialKv: Record<string, string> = {},
  opts: { reviewManifestEnabled?: string } = {},
): {
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
    OPENCLAW_REVIEW_MANIFEST_ENABLED: opts.reviewManifestEnabled ?? "off",
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
  worker: { fetch: (req: Request, env: never, ctx: never) => Promise<Response> },
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
  it("SKIPS enqueuePrReviewJob + pr-stale-mark when the diff hash matches the prior reviewed hash", async () => {
    // Manifest path enabled + a valid manifest stashed in KV — this is
    // the setup where pr-stale-mark WOULD normally fire on a
    // synchronize push (see "control" test below). The SIG-89 skip
    // must suppress both `enqueuePrReviewJob` AND `pr-stale-mark`.
    const priorHash = await computeDiffHash(CURRENT_DIFF)
    const manifest = manifestKv()
    const { env, sentJobs } = makeEnv(
      {
        [`pr-review-diff-hash:${OWNER}/${REPO}#${PR_NUMBER}`]: JSON.stringify({
          diffHash: priorHash,
          reviewedHeadSha: "0".repeat(40),
          hashedAt: 1_700_000_000_000,
        }),
        [manifest.key]: manifest.value,
      },
      { reviewManifestEnabled: "on" },
    )
    const worker = (await import("@/src/index")).default

    const res = await postSynchronizeWebhook(worker, env)

    expect(res.status).toBe(202)
    expect(mockEnqueuePrReviewJob).not.toHaveBeenCalled()
    // The prior review stays authoritative — nothing to mark stale.
    expect(sentJobs.map((j) => j.type)).not.toContain("pr-stale-mark")
  })

  it("CONTROL: pr-stale-mark DOES fire on a real-content-change synchronize (proves the skip-suppresses assertion has bite)", async () => {
    // Same KV state as the skip test, but with a non-matching hash so
    // SIG-89 falls through to the normal dispatch path. With manifest
    // enabled + manifest stashed, pr-stale-mark MUST be in sentJobs.
    // This anchors the assertion in the previous test: it now means
    // "SIG-89 suppressed something that would otherwise fire",
    // not just "nothing happens to fire here".
    const manifest = manifestKv()
    const { env, sentJobs } = makeEnv(
      {
        [`pr-review-diff-hash:${OWNER}/${REPO}#${PR_NUMBER}`]: JSON.stringify({
          diffHash: "deadbeef".repeat(8),
          reviewedHeadSha: "0".repeat(40),
          hashedAt: 1_700_000_000_000,
        }),
        [manifest.key]: manifest.value,
      },
      { reviewManifestEnabled: "on" },
    )
    const worker = (await import("@/src/index")).default

    const res = await postSynchronizeWebhook(worker, env)

    expect(res.status).toBe(202)
    expect(mockEnqueuePrReviewJob).toHaveBeenCalledOnce()
    expect(sentJobs.map((j) => j.type)).toContain("pr-stale-mark")
  })

  it("DISPATCHES enqueuePrReviewJob when the diff hash differs (real content change)", async () => {
    const { env } = makeEnv({
      [`pr-review-diff-hash:${OWNER}/${REPO}#${PR_NUMBER}`]: JSON.stringify({
        diffHash: "deadbeef".repeat(8),  // 64 hex chars, won't match
        reviewedHeadSha: "0".repeat(40),
        hashedAt: 1_700_000_000_000,
      }),
    })
    const worker = (await import("@/src/index")).default

    const res = await postSynchronizeWebhook(worker, env)

    expect(res.status).toBe(202)
    expect(mockEnqueuePrReviewJob).toHaveBeenCalledOnce()
  })

  it("DISPATCHES enqueuePrReviewJob on first-review (no prior hash stashed)", async () => {
    // Empty KV — first review on the PR. No prior hash to compare
    // against, so we MUST dispatch.
    const { env } = makeEnv()
    const worker = (await import("@/src/index")).default

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
    const worker = (await import("@/src/index")).default

    const res = await postSynchronizeWebhook(worker, env)

    expect(res.status).toBe(202)
    // Fail-open: a diff-fetch error MUST fall through to the normal
    // dispatch path so the worst case is a wasted review, never a
    // missed review.
    expect(mockEnqueuePrReviewJob).toHaveBeenCalledOnce()
  })

  it("DISPATCHES enqueuePrReviewJob when the diff fetch is aborted by the 2s timeout", async () => {
    // Sigilix bot finding on PR #106: webhook can't stall on a slow
    // GitHub. The fetch is wrapped in AbortSignal.timeout(2000).
    // On abort, the catch block falls through to dispatch (fail-open).
    // We simulate an abort by rejecting with an AbortError-shaped
    // exception — equivalent to what `fetch` raises when its signal
    // aborts mid-flight.
    const priorHash = await computeDiffHash(CURRENT_DIFF)
    const { env } = makeEnv({
      [`pr-review-diff-hash:${OWNER}/${REPO}#${PR_NUMBER}`]: JSON.stringify({
        diffHash: priorHash,
        reviewedHeadSha: "0".repeat(40),
        hashedAt: 1_700_000_000_000,
      }),
    })
    mockGetPullRequestDiff.mockImplementationOnce(async (_o, _r, _n, opts) => {
      // Verify the production caller actually passed an AbortSignal —
      // without this assertion the test passes even if the timeout
      // wrapper is silently dropped.
      expect(opts?.signal).toBeInstanceOf(AbortSignal)
      const err = new Error("The operation was aborted") as Error & { name: string }
      err.name = "AbortError"
      throw err
    })
    const worker = (await import("@/src/index")).default

    const res = await postSynchronizeWebhook(worker, env)

    expect(res.status).toBe(202)
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
    const worker = (await import("@/src/index")).default

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
    const worker = (await import("@/src/index")).default

    const res = await postSynchronizeWebhook(worker, env)

    expect(res.status).toBe(202)
    // Kill-switch must prevent BOTH the skip AND the diff fetch — the
    // whole point is to avoid the latency tax + GitHub API call.
    expect(mockEnqueuePrReviewJob).toHaveBeenCalledOnce()
    expect(mockGetPullRequestDiff).not.toHaveBeenCalled()
  })

  it("does NOT touch the pr-labels dispatch + does NOT post the SIG-219 stub on noop-merge skip", async () => {
    // The noop-merge skip is review-only — the label-picker still
    // runs because labels are a separate product capability.
    //
    // SIG-216: pr-overview standalone queue dispatch is gone for ALL
    // webhook paths (the overview now runs inline from the ensemble).
    // SIG-219: the "Reviewing…" stub-post is placed AFTER the
    // noop-merge skip-short-circuit specifically so a diff-identical
    // synchronize push doesn't flash an orphan sticky that never
    // updates. This test pins that ordering: pr-labels DOES fire
    // (independent of the noop-merge skip), but the stub does NOT.
    const priorHash = await computeDiffHash(CURRENT_DIFF)
    const { env, sentJobs } = makeEnv({
      [`pr-review-diff-hash:${OWNER}/${REPO}#${PR_NUMBER}`]: JSON.stringify({
        diffHash: priorHash,
        reviewedHeadSha: "0".repeat(40),
        hashedAt: 1_700_000_000_000,
      }),
    })
    const worker = (await import("@/src/index")).default

    await postSynchronizeWebhook(worker, env)

    expect(mockPostStub).not.toHaveBeenCalled()
    expect(sentJobs.map((j) => j.type)).not.toContain("pr-overview")
    expect(sentJobs.map((j) => j.type)).toContain("pr-labels")
  })
})
