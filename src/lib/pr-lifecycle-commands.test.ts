// SIG-98 — `/sigilix pause / resume / ignore / resolve` lifecycle
// handler tests. Mocks the GitHub installation token + GitHubClient
// fetch surface; verifies KV round-trip, ack-comment posting, and the
// resolve-thread filtering (Sigilix-rooted only).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  handlePrPause,
  handlePrResume,
  handlePrIgnore,
  handlePrResolveThreads,
  handlePrCancel,
  buildPausedKey,
  buildIgnoredKey,
  PR_PAUSE_TTL_SECONDS,
} from "@/src/lib/pr-lifecycle-commands"
import type { Env } from "@/src/shared/types/env"

// Test PKCS#8 RSA-2048 key — same one used in tests/github-app.test.ts.
// Round-trip-only; not a real credential.
const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDPU6dL7pYqPYf2
ihBoPf5DzpBUS8q1CHDcEKt/2W/bCOGpItIS/5hkBgGwvR6Mhzj3fgYg0LOctJVS
RITY5KxVxtWcM2DCcRMpPp3Dd9vIfL2uzBjv4HUFPXzHGZbE9spoBPiRtT9eaALP
UbqXZcv2idz/V5L3Zd6BcK/iE71HE6WG7DsnPJQgUjWl9wUgIzPe7PSHkBEMPB7g
AIwhOIgxBL/UWv/BWAajCLSa0mDqq7Tg0SO1jCsutJv33sGKb/uVzs2tlSEBs9b6
PyT74ihbhPATzyCD+nfDzg/8b7P6EDTKDBVTOgC+fizSnpDLpc3eS0wsBQKNeyRu
6oIKBIDTAgMBAAECggEAJPXL4O9bDrzlh+BwK5yEZVe9XyZvsHmSdghlb5C1NFmd
8gIOWY9QNh7G6CSffUlrcM83A5N0agT+e8Lax6KjIs8tTZc/+6yi3qpJyjmTm+aN
y4ynoUdvkB4UVy5K0CuU6qoRmigMpyeDzFFGT6qAvFmLLNgbIc0wrWJlLU2g5j3w
WWXKgGuwm78W9tu2spKSi70uXTuxTCO4yZH2kPsFUF5DzNL7S0K+9MwMlOOmgs9I
XmeWHpcsfaxqcNTmNKJxSZUIHXGyXFOOGnCT/EcLSO4r8O4zBCbE5oCeEtrt3tSD
HeAmwKpvWkKr2ekTbvzu7NAXYeKidTnZxfmaQjW4MQKBgQD5gaG0eevtVeqAvmFV
HDVVsXmrxaOKHwoeJDYxJKB8/YQE5QsKt3pQzQ8AcLoTeB4uRrMBZWG0mc15rEUl
NtnMEcwo2MTS0JEAvfrUMbMcR2KjuKkXHOhCGkA1bGJ45a6dWJK3tbSU3epLFP2+
ZOg3aZKkIQR0d36C8iY1Yh7H8wKBgQDUuTWHDGSvBzcSNRGsfUK+sXGB1m/pZAjg
Z21PCbTAJ87GsWICmpbtv2QwOzTLOL4vmIuPoTfuIRHSMzgncXf29jxDU9kFKnJq
J6Fa28UGLTvIQs3nUKWpeQmO6ms2MWBHsOoKpUdlkVMdR6S1tYsZIJjsIThs9uNR
RfDJn28EYQKBgFLSVNqYRiufEQWrVeyW/NNuU1G4bRC9ulXJsqxr06lDJU3XutIO
lcBtuVwJOCPMtgwHL9WrK9IS2dVcm04agnSwiK0nVc4rUTxHhxr7sttQhE5QEmFW
H9D63iN0a0GvB28GTlpAH+xtN64ad6QOGcVYS8XSCQfXsqVaDRSFFzBLAoGAdj4d
JG8l9rB/HojlvsM3OLYK7aA7y+KXUXNlw84cM3Fk5QVwfxaZJg2wRC+jl+FX8aD9
NVDIrTqQXhZA89EEQg5bDr/r5FPfLFLZ7ksoOFi+aIrNOHM9amNmbaArfdACVoPH
K2eTOsiHkrbT+kEQwdFJhi8jzMRuiGeIpHRQ0aECgYEAvOZfcF3cVEqEOXXgsybr
Z/Q0FEJU+R0jZfiRq0J+7MS5I7NU/SnK8InhTzDPaPWpc6dD7nhyf0GbxsmdzSDP
CGqDb+pJeS0+t3ToB7Ql8q4n7FlafZmW8R7q40RJn0RqKaG2YyCoIPjnRf1mqXQO
VJ2u1IhcD24WrhOpFGFtUbY=
-----END PRIVATE KEY-----`

interface MockKv {
  store: Map<string, { value: string; ttl?: number }>
  putCalls: Array<{ key: string; value: string; ttl?: number }>
  deleteCalls: string[]
  asEnv: KVNamespace
}

function makeKv(): MockKv {
  const store = new Map<string, { value: string; ttl?: number }>()
  const putCalls: Array<{ key: string; value: string; ttl?: number }> = []
  const deleteCalls: string[] = []
  const asEnv = {
    get: async (key: string): Promise<string | null> => store.get(key)?.value ?? null,
    put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(key, { value, ttl: opts?.expirationTtl })
      putCalls.push({ key, value, ttl: opts?.expirationTtl })
    },
    delete: async (key: string) => {
      store.delete(key)
      deleteCalls.push(key)
    },
  } as unknown as KVNamespace
  return { store, putCalls, deleteCalls, asEnv }
}

interface FetchCall {
  url: string
  method: string
  body: unknown
  headers: Record<string, string>
}

interface MockResponseConfig {
  body: unknown
  status?: number
}

function makeEnv(kv: MockKv): { env: Env; fetches: FetchCall[]; responses: MockResponseConfig[] } {
  const fetches: FetchCall[] = []
  const responses: MockResponseConfig[] = []
  // Default response: 200 with empty json. Tests push specific
  // responses in order; first matching URL pattern wins.
  globalThis.fetch = vi.fn(async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url
    const method = (init?.method ?? "GET").toUpperCase()
    let body: unknown = undefined
    if (init?.body && typeof init.body === "string") {
      try { body = JSON.parse(init.body) } catch { body = init.body }
    }
    const headersRecord: Record<string, string> = {}
    const h = init?.headers
    if (h && typeof h === "object") {
      for (const [k, v] of Object.entries(h)) {
        if (typeof v === "string") headersRecord[k.toLowerCase()] = v
      }
    }
    fetches.push({ url, method, body, headers: headersRecord })
    // Installation-token endpoint always returns a fake token so the
    // GitHubClient bootstrap succeeds.
    if (url.includes("/access_tokens")) {
      return new Response(JSON.stringify({
        token: "ghs_fake",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    // GraphQL + REST responses come from the response queue. Each
    // test push exhausts one slot.
    const next = responses.shift()
    if (next) {
      return new Response(JSON.stringify(next.body), {
        status: next.status ?? 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch

  const env = {
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: TEST_PRIVATE_KEY,
    OPENCLAW_STATE: kv.asEnv,
  } as unknown as Env
  return { env, fetches, responses }
}

const args = {
  owner: "Arc-and-Anchor",
  repo: "sigilix",
  prNumber: 7,
  installationId: 99,
}

describe("handlePrPause", () => {
  let kv: MockKv
  let envBundle: ReturnType<typeof makeEnv>

  beforeEach(() => {
    kv = makeKv()
    envBundle = makeEnv(kv)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("writes the pause KV key with a 24h TTL and posts the ack comment", async () => {
    await handlePrPause({ env: envBundle.env, ...args })
    // `getInstallationToken` also writes to KV (token caching); filter
    // to just the lifecycle-key write to keep the assertion focused.
    const pauseWrites = kv.putCalls.filter((c) => c.key.startsWith("pr-paused:"))
    expect(pauseWrites).toHaveLength(1)
    expect(pauseWrites[0]?.key).toBe(buildPausedKey(args.owner, args.repo, args.prNumber))
    expect(pauseWrites[0]?.ttl).toBe(PR_PAUSE_TTL_SECONDS)
    // The ack comment is a POST to /issues/N/comments.
    const ackPost = envBundle.fetches.find(
      (f) => f.method === "POST" && f.url.endsWith("/issues/7/comments"),
    )
    expect(ackPost).toBeDefined()
    const ackBody = ackPost?.body as { body?: string }
    expect(ackBody.body?.toLowerCase()).toContain("paused")
  })

  it("uses the documented KV key shape", () => {
    expect(buildPausedKey("foo", "bar", 42)).toBe("pr-paused:foo/bar#42")
  })
})

describe("handlePrResume", () => {
  let kv: MockKv
  let envBundle: ReturnType<typeof makeEnv>

  beforeEach(() => {
    kv = makeKv()
    envBundle = makeEnv(kv)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("deletes BOTH pause and ignore keys, posts ack", async () => {
    // Pre-seed both keys.
    await kv.asEnv.put(buildPausedKey(args.owner, args.repo, args.prNumber), "1700000000000")
    await kv.asEnv.put(buildIgnoredKey(args.owner, args.repo, args.prNumber), "1700000000000")
    kv.deleteCalls.length = 0
    await handlePrResume({ env: envBundle.env, ...args })
    expect(kv.deleteCalls).toContain(buildPausedKey(args.owner, args.repo, args.prNumber))
    expect(kv.deleteCalls).toContain(buildIgnoredKey(args.owner, args.repo, args.prNumber))
    const ackPost = envBundle.fetches.find(
      (f) => f.method === "POST" && f.url.endsWith("/issues/7/comments"),
    )
    expect(ackPost).toBeDefined()
  })

  it("is idempotent on empty KV state (no throw)", async () => {
    await expect(handlePrResume({ env: envBundle.env, ...args })).resolves.toBeUndefined()
  })
})

describe("handlePrIgnore", () => {
  let kv: MockKv
  let envBundle: ReturnType<typeof makeEnv>

  beforeEach(() => {
    kv = makeKv()
    envBundle = makeEnv(kv)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("writes ignore KV key with NO TTL (permanent until resume)", async () => {
    await handlePrIgnore({ env: envBundle.env, ...args })
    // Filter past the token-cache write (see handlePrPause comment).
    const ignoreWrites = kv.putCalls.filter((c) => c.key.startsWith("pr-ignored:"))
    expect(ignoreWrites).toHaveLength(1)
    expect(ignoreWrites[0]?.key).toBe(buildIgnoredKey(args.owner, args.repo, args.prNumber))
    expect(ignoreWrites[0]?.ttl).toBeUndefined()
  })

  it("uses the documented KV key shape", () => {
    expect(buildIgnoredKey("foo", "bar", 42)).toBe("pr-ignored:foo/bar#42")
  })
})

describe("handlePrResolveThreads", () => {
  let kv: MockKv
  let envBundle: ReturnType<typeof makeEnv>

  beforeEach(() => {
    kv = makeKv()
    envBundle = makeEnv(kv)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("resolves ONLY Sigilix-rooted unresolved threads via GraphQL mutation", async () => {
    // Push: 1) listThreads query response with mixed thread sources.
    envBundle.responses.push({
      body: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "T1",
                    isResolved: false,
                    comments: { nodes: [{ author: { login: "sigilix[bot]" } }] },
                  },
                  {
                    id: "T2",
                    isResolved: false,
                    comments: { nodes: [{ author: { login: "human-reviewer" } }] },
                  },
                  {
                    id: "T3",
                    isResolved: true,
                    comments: { nodes: [{ author: { login: "sigilix[bot]" } }] },
                  },
                  {
                    id: "T4",
                    isResolved: false,
                    comments: { nodes: [{ author: { login: "sigilix[bot]" } }] },
                  },
                ],
              },
            },
          },
        },
      },
    })
    // Then: 2 resolve mutations (T1 and T4) + ack comment POST.
    envBundle.responses.push({ body: { data: { resolveReviewThread: { thread: { id: "T1", isResolved: true } } } } })
    envBundle.responses.push({ body: { data: { resolveReviewThread: { thread: { id: "T4", isResolved: true } } } } })

    await handlePrResolveThreads({ env: envBundle.env, ...args })

    // Count GraphQL calls that were resolveReviewThread mutations.
    const graphqlCalls = envBundle.fetches.filter((f) => f.url.endsWith("/graphql"))
    const mutationCalls = graphqlCalls.filter((f) => {
      const q = (f.body as { query?: string })?.query ?? ""
      return q.includes("mutation ResolveReviewThread")
    })
    expect(mutationCalls).toHaveLength(2)
    const resolvedThreadIds = mutationCalls
      .map((f) => (f.body as { variables?: { threadId?: string } })?.variables?.threadId)
      .sort()
    expect(resolvedThreadIds).toEqual(["T1", "T4"])
    // Ack comment posted at the end.
    const ackPost = envBundle.fetches.find(
      (f) => f.method === "POST" && f.url.endsWith("/issues/7/comments"),
    )
    expect(ackPost).toBeDefined()
  })

  it("no-ops cleanly when the PR has no review threads", async () => {
    envBundle.responses.push({
      body: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        },
      },
    })
    await handlePrResolveThreads({ env: envBundle.env, ...args })
    const graphqlMutations = envBundle.fetches.filter((f) => {
      const q = (f.body as { query?: string })?.query ?? ""
      return q.includes("mutation ResolveReviewThread")
    })
    expect(graphqlMutations).toHaveLength(0)
    // Ack still posts so the user knows we tried.
    const ackPost = envBundle.fetches.find(
      (f) => f.method === "POST" && f.url.endsWith("/issues/7/comments"),
    )
    expect(ackPost).toBeDefined()
  })

  it("posts ack even when GraphQL listing fails (best-effort)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    // Listing fails with a non-OK status; ack post should still happen.
    envBundle.responses.push({ body: { errors: [{ message: "FORBIDDEN" }] }, status: 200 })
    await handlePrResolveThreads({ env: envBundle.env, ...args })
    const ackPost = envBundle.fetches.find(
      (f) => f.method === "POST" && f.url.endsWith("/issues/7/comments"),
    )
    expect(ackPost).toBeDefined()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

// ─── SIG-329 — `/sigilix cancel` ─────────────────────────────

describe("handlePrCancel", () => {
  let kv: MockKv
  let envBundle: ReturnType<typeof makeEnv>

  // Records the DO-instance name + the /cancel POSTs the handler makes.
  function withDoStub(
    base: Env,
    opts: { status?: number; body?: unknown } = {},
  ): { env: Env; names: string[]; cancelCalls: number } {
    const names: string[] = []
    let cancelCalls = 0
    const stub = {
      fetch: vi.fn(async (input: string | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.url
        if (url.endsWith("/cancel")) cancelCalls++
        void (init?.method)
        return new Response(JSON.stringify(opts.body ?? { cancelled: true, runId: "r" }), {
          status: opts.status ?? 200,
          headers: { "content-type": "application/json" },
        })
      }),
    } as unknown as DurableObjectStub
    const env = {
      ...base,
      PR_REVIEW_RUN: {
        idFromName: vi.fn((name: string) => { names.push(name); return { name } as unknown as DurableObjectId }),
        get: vi.fn(() => stub),
      } as unknown as DurableObjectNamespace,
    } as unknown as Env
    return { env, get names() { return names }, get cancelCalls() { return cancelCalls } } as {
      env: Env; names: string[]; cancelCalls: number
    }
  }

  beforeEach(() => {
    kv = makeKv()
    envBundle = makeEnv(kv)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("POSTs /cancel to the PR's DO instance and posts the ack comment", async () => {
    const stubbed = withDoStub(envBundle.env)
    await handlePrCancel({ env: stubbed.env, ...args })

    expect(stubbed.cancelCalls).toBe(1)
    expect(stubbed.names).toContain("Arc-and-Anchor/sigilix#7")
    const ackPost = envBundle.fetches.find(
      (f) => f.method === "POST" && f.url.endsWith("/issues/7/comments"),
    )
    expect(ackPost).toBeDefined()
    const ackBody = ackPost?.body as { body?: string }
    expect(ackBody.body?.toLowerCase()).toContain("cancel")
  })

  it("throws on a 5xx from the DO /cancel route (queue redelivers; cancel is idempotent)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const stubbed = withDoStub(envBundle.env, { status: 503, body: { error: "boom" } })
    await expect(handlePrCancel({ env: stubbed.env, ...args })).rejects.toThrow(/cancel-failed/)
    errSpy.mockRestore()
  })

  it("still acks when the DO reports a no-op (no in-flight run)", async () => {
    const stubbed = withDoStub(envBundle.env, { body: { cancelled: false, reason: "no-state" } })
    await handlePrCancel({ env: stubbed.env, ...args })
    const ackPost = envBundle.fetches.find(
      (f) => f.method === "POST" && f.url.endsWith("/issues/7/comments"),
    )
    expect(ackPost).toBeDefined()
  })
})
