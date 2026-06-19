// VERIFIED unlock Phase 2 — POST /runner/ingest enqueues a full (non-incremental)
// re-review when a NEW PR receipt is accepted, so the receipt-join runs against
// the now-present receipt (closing the timing race where the review ran before
// the receipt landed). End-to-end through the REAL verify + provenance gate (a
// generated RSA keypair signs fixture tokens; the JWKS is served via a stubbed
// global fetch). Mocks: the receipt DO, KV, the GitHub App auth, and the client's
// `getCommit` (so the head-sha derivation runs without real network / a PEM key).
// Split out of `runner-ingest-route.test.ts` to keep each file under the 1000-line budget.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { handleRunnerIngestRoute } from "@/src/lib/runner-ingest-route"
import { __resetJwksCacheForTests } from "@/src/lib/runner-oidc/jwks-cache"
import type { GitHubOidcClaims, Jwk } from "@/src/lib/runner-oidc/types"
import type { Env } from "@/src/shared/types/env"

// The re-review enqueue path mints a GitHub App installation client + derives the
// head sha from the SIGNED merge sha. Mock the App auth + the client's `getCommit`
// so the enqueue logic is exercised without real network. The OIDC VERIFY path is
// untouched (it lives in runner-oidc, served by the global fetch stub).
let mockResolveInstallationId: number | null = 0
let mockGetCommitParents: string[] | null = null
const mockGetCommit = vi.fn(async () =>
  mockGetCommitParents === null ? null : { headSha: "merge-sha", treeSha: "tree", parents: mockGetCommitParents },
)
vi.mock("@/src/shared/adapters/github/github-app", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/github/github-app")>(
    "@/src/shared/adapters/github/github-app",
  )
  return {
    ...actual,
    resolveRepoInstallationId: vi.fn(async () => mockResolveInstallationId),
    getInstallationToken: vi.fn(async () => "inst-token"),
  }
})
vi.mock("@/src/shared/adapters/github", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/github")>("@/src/shared/adapters/github")
  class GitHubClientMock {
    getCommit = mockGetCommit
  }
  return { ...actual, GitHubClient: GitHubClientMock }
})

const ISS = "https://token.actions.githubusercontent.com"
const AUD = "sigilix-runner-ingest"
const KID = "test-kid-1"
const WORKFLOW = "sigilix/runner/.github/workflows/scan.yml"
const VALID_SARIF = JSON.stringify({ version: "2.1.0", runs: [] })

function b64url(bytes: Uint8Array): string {
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
function b64urlJson(o: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(o)))
}

let privateKey: CryptoKey
let jwk: Jwk

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair
  const j = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey
  privateKey = pair.privateKey
  jwk = { kid: KID, kty: j.kty!, n: j.n!, e: j.e!, alg: "RS256", use: "sig" }
})

async function signToken(
  claims: { [K in keyof GitHubOidcClaims]?: GitHubOidcClaims[K] | undefined },
  kid = KID,
): Promise<string> {
  const input = `${b64urlJson({ alg: "RS256", kid })}.${b64urlJson(claims)}`
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(input))
  return `${input}.${b64url(new Uint8Array(sig))}`
}

const baseClaims: GitHubOidcClaims = {
  iss: ISS,
  aud: AUD,
  exp: 2_000_000_000,
  iat: 1_700_000_000,
  repository: "Sigilix/sigilix",
  repository_id: "424242",
  sha: "deadbeef",
  run_id: "555",
  run_attempt: "1",
  job_workflow_ref: `${WORKFLOW}@v1`,
  runner_environment: "github-hosted",
}

function makeReceiptDo() {
  const store = new Map<string, { sarifSha256: string }>()
  const ns = {
    idFromName: (id: string) => ({ id }),
    get: () => ({
      async claimReceipt(args: {
        repositoryId: string
        sha: string
        runId: string
        runAttempt: string
        sarifSha256: string
      }) {
        const k = `${args.repositoryId}:${args.sha}:${args.runId}:${args.runAttempt}`
        const existing = store.get(k)
        if (existing === undefined) {
          store.set(k, { sarifSha256: args.sarifSha256 })
          return { outcome: "accepted" as const }
        }
        if (existing.sarifSha256 === args.sarifSha256) return { outcome: "duplicate" as const }
        return { outcome: "conflict" as const, existingSarifSha256: existing.sarifSha256 }
      },
    }),
  }
  return { ns }
}

function makeKv() {
  const store = new Map<string, string>()
  return {
    kv: {
      async put(k: string, v: string): Promise<void> {
        store.set(k, v)
      },
      async get(k: string): Promise<string | null> {
        return store.get(k) ?? null
      },
    },
    store,
  }
}

function makeEnv(over: Partial<Record<keyof Env, unknown>>, receiptNs: unknown, kv: unknown): Env {
  return {
    OPENCLAW_RUNNER_OIDC_AUDIENCE: AUD,
    OPENCLAW_RUNNER_WORKFLOW_REF: WORKFLOW,
    OPENCLAW_STATE: kv,
    RUNNER_RECEIPT_DO: receiptNs,
    ...over,
  } as unknown as Env
}

function stubJwksFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } }),
    ),
  )
}

function post(body: unknown, token?: string): Request {
  return new Request("https://x/runner/ingest", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

const envelope = (over: Record<string, unknown> = {}) => ({
  sarif: VALID_SARIF,
  repository: "Sigilix/sigilix",
  sha: "deadbeef",
  ...over,
})

// Captures every queue message the route raw-sends.
function makeJobsCapture(): { binding: { send: (m: unknown) => Promise<void> }; sent: unknown[] } {
  const sent: unknown[] = []
  return {
    binding: {
      async send(m: unknown): Promise<void> {
        sent.push(m)
      },
    },
    sent,
  }
}

// App config + a PR-ref token so `pullNumber > 0`; the merge commit derives a
// 2-parent head sha. `parents[1]` is the PR head the receipt was scanned at.
const APP_ENV = {
  GITHUB_APP_ID: "12345",
  GITHUB_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
}

afterEach(() => {
  __resetJwksCacheForTests()
  vi.unstubAllGlobals()
  mockResolveInstallationId = 0
  mockGetCommitParents = null
  mockGetCommit.mockClear()
})

describe("handleRunnerIngestRoute — VERIFIED unlock Phase 2 receipt re-review enqueue", () => {
  it("enqueues a non-incremental re-review on an ACCEPTED PR receipt", async () => {
    stubJwksFetch()
    const { ns } = makeReceiptDo()
    const kvWrap = makeKv()
    const jobs = makeJobsCapture()
    mockResolveInstallationId = 99
    mockGetCommitParents = ["base-tip", "pr-head-sha"]
    const tok = await signToken({ ...baseClaims, ref: "refs/pull/777/merge" })
    const env = makeEnv({ ...APP_ENV, OPENCLAW_JOBS: jobs.binding }, ns, kvWrap.kv)

    // No ctx → the route awaits the (best-effort) enqueue inline.
    const res = await handleRunnerIngestRoute(post(envelope(), tok), env)
    expect(res.status).toBe(200)
    expect(jobs.sent).toHaveLength(1)
    expect(jobs.sent[0]).toMatchObject({
      type: "pr-review",
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 777,
      headSha: "pr-head-sha", // parents[1], NOT the body / merge sha
      installationId: 99,
      triggerReason: "runner-receipt",
      forceFullCoverage: true,
      bypassClosedSkip: true,
      repoId: 424242, // from the SIGNED repository_id claim
    })
  })

  it("does NOT enqueue on a DUPLICATE receipt (idempotent CI retry — review already enqueued)", async () => {
    stubJwksFetch()
    const { ns } = makeReceiptDo()
    const kvWrap = makeKv()
    const jobs = makeJobsCapture()
    mockResolveInstallationId = 99
    mockGetCommitParents = ["base-tip", "pr-head-sha"]
    const tok = await signToken({ ...baseClaims, ref: "refs/pull/777/merge" })
    const env = makeEnv({ ...APP_ENV, OPENCLAW_JOBS: jobs.binding }, ns, kvWrap.kv)

    // First POST: accepted → 1 enqueue. Second identical POST: duplicate → none.
    await handleRunnerIngestRoute(post(envelope(), tok), env)
    expect(jobs.sent).toHaveLength(1)
    const res2 = await handleRunnerIngestRoute(post(envelope(), tok), env)
    expect(((await res2.json()) as { outcome: string }).outcome).toBe("duplicate")
    expect(jobs.sent).toHaveLength(1) // no second enqueue
  })

  it("does NOT enqueue on a CONFLICT receipt (different SARIF, same run)", async () => {
    stubJwksFetch()
    const { ns } = makeReceiptDo()
    const kvWrap = makeKv()
    const jobs = makeJobsCapture()
    mockResolveInstallationId = 99
    mockGetCommitParents = ["base-tip", "pr-head-sha"]
    const tok = await signToken({ ...baseClaims, ref: "refs/pull/777/merge" })
    const env = makeEnv({ ...APP_ENV, OPENCLAW_JOBS: jobs.binding }, ns, kvWrap.kv)

    await handleRunnerIngestRoute(post(envelope(), tok), env)
    expect(jobs.sent).toHaveLength(1)
    const res2 = await handleRunnerIngestRoute(
      post(envelope({ sarif: JSON.stringify({ version: "2.1.0", runs: [], extra: 1 }) }), tok),
      env,
    )
    expect(res2.status).toBe(409)
    expect(jobs.sent).toHaveLength(1) // conflict did not enqueue
  })

  it("does NOT enqueue on a NON-PR receipt (branch push ref, pullNumber 0)", async () => {
    stubJwksFetch()
    const { ns } = makeReceiptDo()
    const kvWrap = makeKv()
    const jobs = makeJobsCapture()
    mockResolveInstallationId = 99
    mockGetCommitParents = ["base-tip", "pr-head-sha"]
    const tok = await signToken({ ...baseClaims, ref: "refs/heads/main" })
    const env = makeEnv({ ...APP_ENV, OPENCLAW_JOBS: jobs.binding }, ns, kvWrap.kv)

    const res = await handleRunnerIngestRoute(post(envelope(), tok), env)
    expect(res.status).toBe(200)
    expect(jobs.sent).toHaveLength(0)
  })

  it("SKIPS the enqueue (never throws) when the merge commit is not a 2-parent test-merge", async () => {
    stubJwksFetch()
    const { ns } = makeReceiptDo()
    const kvWrap = makeKv()
    const jobs = makeJobsCapture()
    mockResolveInstallationId = 99
    mockGetCommitParents = ["only-one-parent"] // not a refs/pull/N/merge shape
    const tok = await signToken({ ...baseClaims, ref: "refs/pull/777/merge" })
    const env = makeEnv({ ...APP_ENV, OPENCLAW_JOBS: jobs.binding }, ns, kvWrap.kv)

    const res = await handleRunnerIngestRoute(post(envelope(), tok), env)
    expect(res.status).toBe(200) // ingest still succeeds
    expect(jobs.sent).toHaveLength(0) // no head sha derivable → no enqueue
  })

  it("does NOT enqueue (no throw) when the GitHub App is not configured", async () => {
    stubJwksFetch()
    const { ns } = makeReceiptDo()
    const kvWrap = makeKv()
    const jobs = makeJobsCapture()
    mockResolveInstallationId = 99
    mockGetCommitParents = ["base-tip", "pr-head-sha"]
    const tok = await signToken({ ...baseClaims, ref: "refs/pull/777/merge" })
    // No GITHUB_APP_ID / GITHUB_PRIVATE_KEY.
    const env = makeEnv({ OPENCLAW_JOBS: jobs.binding }, ns, kvWrap.kv)

    const res = await handleRunnerIngestRoute(post(envelope(), tok), env)
    expect(res.status).toBe(200)
    expect(jobs.sent).toHaveLength(0)
  })

  it("does NOT enqueue when the app is not installed on the repo (installationId null)", async () => {
    stubJwksFetch()
    const { ns } = makeReceiptDo()
    const kvWrap = makeKv()
    const jobs = makeJobsCapture()
    mockResolveInstallationId = null
    mockGetCommitParents = ["base-tip", "pr-head-sha"]
    const tok = await signToken({ ...baseClaims, ref: "refs/pull/777/merge" })
    const env = makeEnv({ ...APP_ENV, OPENCLAW_JOBS: jobs.binding }, ns, kvWrap.kv)

    const res = await handleRunnerIngestRoute(post(envelope(), tok), env)
    expect(res.status).toBe(200)
    expect(jobs.sent).toHaveLength(0)
  })
})
