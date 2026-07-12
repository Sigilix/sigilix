// sig-public-demo — POST /v1/demo/review, the PUBLIC no-auth demo endpoint.
//
// This suite exists because the endpoint SPENDS REAL MONEY WITH NO AUTH. Every test
// below pins a guard that stands between a stranger's HTTP request and the founder's
// card: the fail-closed kill switch, the public-repos-only check, the per-IP cap, the
// global daily USD budget, the diff-size cap, the result cache, and the invariant that
// NOTHING is ever written to GitHub.
//
// The engine and the GitHub API are both mocked — the real engine path is covered by
// the /v1/review + CLI suites; what is under test here is the gauntlet around it.

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"

vi.mock("@/src/lib/ensemble/app/orchestrator", () => ({ handlePrReviewEnsemble: vi.fn() }))

import { handleDemoReviewRoute } from "./api-demo-review-route"
import { handlePrReviewEnsemble } from "@/src/lib/ensemble/app/orchestrator"
import type { Env } from "@/src/shared/types/env"
import type { DemoEnv } from "@/src/lib/demo-review-guards"
import type { EnsembleHandlerArgs } from "@/src/lib/ensemble/app/orchestrator-types"

const mockEngine = vi.mocked(handlePrReviewEnsemble)

const PR_URL = "https://github.com/acme/widgets/pull/42"
const HEAD_SHA = "d34db33f"
const DIFF = [
  "diff --git a/src/pay.ts b/src/pay.ts",
  "--- a/src/pay.ts",
  "+++ b/src/pay.ts",
  "@@ -1,2 +1,3 @@",
  " const total = items.length",
  "+const fee = total * rate",
  " export { total }",
  "",
].join("\n")

interface KvSpy {
  namespace: KVNamespace
  store: Map<string, string>
  puts: string[]
}

function kv(seed: Record<string, string> = {}): KvSpy {
  const store = new Map<string, string>(Object.entries(seed))
  const puts: string[] = []
  const namespace = {
    get: async (key: string, type?: "json") => {
      const raw = store.get(key)
      if (raw === undefined) return null
      return type === "json" ? JSON.parse(raw) : raw
    },
    put: async (key: string, value: string) => {
      puts.push(key)
      store.set(key, value)
    },
  } as unknown as KVNamespace
  return { namespace, store, puts }
}

function env(extra: Partial<DemoEnv> = {}, namespace: KVNamespace = kv().namespace): Env {
  return { SIGILIX_DEMO_MODE: "on", OPENCLAW_STATE: namespace, ...extra } as unknown as Env
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://api.sigilix.ai/v1/demo/review", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", ...headers },
    body: JSON.stringify(body),
  })
}

/** Records every outbound HTTP call so a test can prove we never WROTE to GitHub. */
interface GithubStub {
  calls: Array<{ url: string; method: string }>
}

function stubGithub(
  options: {
    repo?: { status?: number; body?: Record<string, unknown> }
    pull?: { status?: number; body?: Record<string, unknown> }
    diff?: { status?: number; text?: string }
  } = {},
): GithubStub {
  const stub: GithubStub = { calls: [] }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? "GET"
      stub.calls.push({ url, method })
      const accept = String((init?.headers as Record<string, string> | undefined)?.accept ?? "")
      if (url.endsWith("/repos/acme/widgets")) {
        const repo = options.repo ?? {}
        return new Response(JSON.stringify(repo.body ?? { private: false, visibility: "public" }), {
          status: repo.status ?? 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.endsWith("/repos/acme/widgets/pulls/42") && accept.includes("diff")) {
        const diff = options.diff ?? {}
        return new Response(diff.text ?? DIFF, { status: diff.status ?? 200 })
      }
      if (url.endsWith("/repos/acme/widgets/pulls/42")) {
        const pull = options.pull ?? {}
        return new Response(
          JSON.stringify(
            pull.body ?? {
              title: "Add processing fee",
              head: { sha: HEAD_SHA },
              base: { sha: "cafe" },
              changed_files: 1,
              additions: 1,
              deletions: 0,
            },
          ),
          { status: pull.status ?? 200, headers: { "content-type": "application/json" } },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
  return stub
}

/** A successful dry-run engine result carrying one finding and a $0.30 token bill. */
function engineOk(overrides: { costUsd?: number; findings?: unknown[]; incomplete?: { rolesMissing: string[] } } = {}) {
  return {
    status: "skipped",
    telemetry: {
      tokenUsageByModel: { "openai/o3": { inputTokens: 10, outputTokens: 5, costUsd: overrides.costUsd ?? 0.3 } },
    },
    dryRunReview: {
      verdict: {
        summary: "One issue found.",
        confidence: 4,
        confidenceReason: "grounded",
        findings: overrides.findings ?? [
          {
            path: "src/pay.ts",
            line: 2,
            score: 4,
            category: "logic",
            headline: "Fee is computed before the rate is validated",
            body: "`rate` may be undefined here.",
            trust: { tier: "grounded-model" },
          },
        ],
      },
      unanchoredFindings: [],
      ...(overrides.incomplete ? { incomplete: overrides.incomplete } : {}),
    },
  } as unknown as Awaited<ReturnType<typeof handlePrReviewEnsemble>>
}

beforeEach(() => {
  mockEngine.mockReset()
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("kill switch — FAIL CLOSED", () => {
  it("is DISABLED when SIGILIX_DEMO_MODE is unset (the default must never spend)", async () => {
    const github = stubGithub()
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), {
      OPENCLAW_STATE: kv().namespace,
    } as unknown as Env)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: "demo_disabled" })
    // Nothing was reviewed and GitHub was never touched.
    expect(mockEngine).not.toHaveBeenCalled()
    expect(github.calls).toHaveLength(0)
  })

  it.each(["off", "ON", "true", "1"])("is DISABLED for the near-miss value %j", async (value) => {
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env({ SIGILIX_DEMO_MODE: value }))
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: "demo_disabled" })
    expect(mockEngine).not.toHaveBeenCalled()
  })

  it("is DISABLED when the KV binding (where every counter lives) is missing", async () => {
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), {
      SIGILIX_DEMO_MODE: "on",
    } as unknown as Env)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: "demo_disabled" })
    expect(mockEngine).not.toHaveBeenCalled()
  })
})

describe("request validation", () => {
  it.each([
    ["a non-GitHub host", "https://gitlab.com/o/r/pull/1"],
    ["an issue URL", "https://github.com/o/r/issues/1"],
    ["garbage", "hello"],
  ])("rejects %s with invalid_url and spends nothing", async (_label, prUrl) => {
    const github = stubGithub()
    const response = await handleDemoReviewRoute(post({ prUrl }), env())
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: "invalid_url" })
    expect(github.calls).toHaveLength(0)
    expect(mockEngine).not.toHaveBeenCalled()
  })

  it("rejects a missing prUrl", async () => {
    const response = await handleDemoReviewRoute(post({}), env())
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: "invalid_url" })
  })
})

describe("public repos only", () => {
  it("REFUSES a private repo (200 from GitHub, private:true) — never reviews private code", async () => {
    stubGithub({ repo: { body: { private: true, visibility: "private" } } })
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env())
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: "not_public" })
    expect(mockEngine).not.toHaveBeenCalled()
  })

  it("REFUSES a repo GitHub hides from us (404 — private or nonexistent, indistinguishable)", async () => {
    stubGithub({ repo: { status: 404, body: { message: "Not Found" } } })
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env())
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: "not_public" })
    expect(mockEngine).not.toHaveBeenCalled()
  })

  it("checks the repo BEFORE fetching the PR or the diff", async () => {
    const github = stubGithub({ repo: { body: { private: true } } })
    await handleDemoReviewRoute(post({ prUrl: PR_URL }), env())
    expect(github.calls).toHaveLength(1)
    expect(github.calls[0]!.url).toContain("/repos/acme/widgets")
    expect(github.calls[0]!.url).not.toContain("/pulls/")
  })

  it("never forwards a caller-supplied token to GitHub (there is no request field for one)", async () => {
    const github = stubGithub()
    mockEngine.mockResolvedValue(engineOk())
    await handleDemoReviewRoute(
      post({ prUrl: PR_URL, token: "ghp_attacker", installationId: 1 }, { authorization: "Bearer ghp_attacker" }),
      env(),
    )
    const fetchMock = vi.mocked(fetch)
    for (const call of fetchMock.mock.calls) {
      const headers = (call[1]?.headers ?? {}) as Record<string, string>
      expect(headers.authorization).toBeUndefined()
    }
    expect(github.calls.every((c) => c.method === "GET")).toBe(true)
  })
})

describe("diff-size cap", () => {
  it("REFUSES an oversize PR by line count before any model spend", async () => {
    stubGithub({
      pull: {
        body: {
          title: "big",
          head: { sha: HEAD_SHA },
          base: { sha: "b" },
          changed_files: 3,
          additions: 1600,
          deletions: 0,
        },
      },
    })
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env())
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: "too_large" })
    expect(mockEngine).not.toHaveBeenCalled()
  })

  it("REFUSES an oversize PR by file count", async () => {
    stubGithub({
      pull: {
        body: {
          title: "big",
          head: { sha: HEAD_SHA },
          base: { sha: "b" },
          changed_files: 41,
          additions: 10,
          deletions: 0,
        },
      },
    })
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env())
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: "too_large" })
    expect(mockEngine).not.toHaveBeenCalled()
  })

  it("honours an env-tuned cap that is TIGHTER than the default", async () => {
    stubGithub()
    mockEngine.mockResolvedValue(engineOk())
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env({ SIGILIX_DEMO_MAX_LINES: "0" }))
    // "0" is not a positive integer → falls back to the 1500 default rather than
    // silently disabling the cap, so this 1-line PR is still reviewed.
    expect(response.status).toBe(200)

    const tightened = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env({ SIGILIX_DEMO_MAX_FILES: "1" }))
    expect(tightened.status).toBe(200) // exactly at the cap — allowed

    stubGithub({
      pull: {
        body: { title: "t", head: { sha: HEAD_SHA }, base: { sha: "b" }, changed_files: 2, additions: 2, deletions: 0 },
      },
    })
    const overCap = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env({ SIGILIX_DEMO_MAX_FILES: "1" }))
    expect(overCap.status).toBe(400)
    expect(await overCap.json()).toMatchObject({ error: "too_large" })
  })

  it("REFUSES a diff GitHub itself calls too large (406)", async () => {
    stubGithub({ diff: { status: 406, text: "" } })
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env())
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: "too_large" })
    expect(mockEngine).not.toHaveBeenCalled()
  })
})

describe("per-IP rate limit", () => {
  it("allows the first N reviews from an IP and then 429s with retryAfterSec", async () => {
    const store = kv()
    stubGithub()
    mockEngine.mockResolvedValue(engineOk())
    const demoEnv = env({ SIGILIX_DEMO_IP_LIMIT: "2" }, store.namespace)

    // Two DIFFERENT PRs so the cache never masks the quota consumption.
    const first = await handleDemoReviewRoute(post({ prUrl: PR_URL }), demoEnv)
    expect(first.status).toBe(200)
    vi.mocked(fetch).mockClear()

    const store2 = store
    void store2
    // Same URL but a NEW head sha → a cache miss → a second real review.
    stubGithub({
      pull: {
        body: { title: "t", head: { sha: "newsha" }, base: { sha: "b" }, changed_files: 1, additions: 1, deletions: 0 },
      },
    })
    const second = await handleDemoReviewRoute(post({ prUrl: PR_URL }), demoEnv)
    expect(second.status).toBe(200)

    stubGithub({
      pull: {
        body: { title: "t", head: { sha: "third" }, base: { sha: "b" }, changed_files: 1, additions: 1, deletions: 0 },
      },
    })
    const third = await handleDemoReviewRoute(post({ prUrl: PR_URL }), demoEnv)
    expect(third.status).toBe(429)
    const body = (await third.json()) as { error: string; retryAfterSec: number }
    expect(body.error).toBe("rate_limited")
    expect(body.retryAfterSec).toBeGreaterThan(0)
    expect(third.headers.get("retry-after")).toBe(String(body.retryAfterSec))
    // The third request never reached the engine.
    expect(mockEngine).toHaveBeenCalledTimes(2)
  })

  it("rejects a rate-limited IP BEFORE touching GitHub (an exhausted IP costs us nothing)", async () => {
    const store = kv()
    const demoEnv = env({ SIGILIX_DEMO_IP_LIMIT: "1" }, store.namespace)
    stubGithub()
    mockEngine.mockResolvedValue(engineOk())
    await handleDemoReviewRoute(post({ prUrl: PR_URL }), demoEnv)

    const github = stubGithub()
    const blocked = await handleDemoReviewRoute(post({ prUrl: "https://github.com/acme/widgets/pull/42" }), demoEnv)
    expect(blocked.status).toBe(429)
    expect(github.calls).toHaveLength(0)
  })

  it("caps each IP independently", async () => {
    const store = kv()
    const demoEnv = env({ SIGILIX_DEMO_IP_LIMIT: "1" }, store.namespace)
    stubGithub()
    mockEngine.mockResolvedValue(engineOk())
    await handleDemoReviewRoute(post({ prUrl: PR_URL }, { "cf-connecting-ip": "1.1.1.1" }), demoEnv)
    const other = await handleDemoReviewRoute(post({ prUrl: PR_URL }, { "cf-connecting-ip": "2.2.2.2" }), demoEnv)
    // A different IP is not blocked (it is served from cache here — same PR, same sha).
    expect(other.status).toBe(200)
  })

  it("refuses a request with no CF-Connecting-IP (the cap would be unenforceable)", async () => {
    const request = new Request("https://api.sigilix.ai/v1/demo/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prUrl: PR_URL }),
    })
    const github = stubGithub()
    const response = await handleDemoReviewRoute(request, env())
    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({ error: "rate_limited" })
    expect(github.calls).toHaveLength(0)
    expect(mockEngine).not.toHaveBeenCalled()
  })
})

describe("global daily USD budget", () => {
  it("503s at_capacity once the day's REAL spend has exhausted the budget", async () => {
    const day = new Date().toISOString().slice(0, 10)
    const store = kv({ [`demo:spend:${day}`]: "20.000000" })
    const github = stubGithub()
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env({}, store.namespace))
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: "at_capacity" })
    // The backstop fires before GitHub and before the engine.
    expect(github.calls).toHaveLength(0)
    expect(mockEngine).not.toHaveBeenCalled()
  })

  it("charges the REAL ensemble cost against the budget, reconciling the reservation", async () => {
    const day = new Date().toISOString().slice(0, 10)
    const store = kv()
    stubGithub()
    mockEngine.mockResolvedValue(engineOk({ costUsd: 0.83 }))
    await handleDemoReviewRoute(post({ prUrl: PR_URL }), env({}, store.namespace))
    expect(Number(store.store.get(`demo:spend:${day}`))).toBeCloseTo(0.83, 5)
  })

  it("still charges when the engine THROWS (a crashed review has already burned tokens)", async () => {
    const day = new Date().toISOString().slice(0, 10)
    const store = kv()
    stubGithub()
    mockEngine.mockRejectedValue(new Error("provider exploded"))
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env({}, store.namespace))
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: "review_failed" })
    expect(Number(store.store.get(`demo:spend:${day}`))).toBeCloseTo(0.25, 5)
  })

  it("reserves the assumed cost BEFORE the engine runs (a concurrent burst can't all pass the check)", async () => {
    const day = new Date().toISOString().slice(0, 10)
    const store = kv()
    stubGithub()
    let spendAtEngineTime = "0"
    mockEngine.mockImplementation(async () => {
      spendAtEngineTime = store.store.get(`demo:spend:${day}`) ?? "0"
      return engineOk()
    })
    await handleDemoReviewRoute(post({ prUrl: PR_URL }), env({}, store.namespace))
    expect(Number(spendAtEngineTime)).toBeCloseTo(0.25, 5)
  })
})

describe("result cache", () => {
  it("serves a repeat request for the same PR@sha from cache: cached:true, no engine, no spend, no quota", async () => {
    const day = new Date().toISOString().slice(0, 10)
    const store = kv()
    const demoEnv = env({ SIGILIX_DEMO_IP_LIMIT: "1" }, store.namespace)
    stubGithub()
    mockEngine.mockResolvedValue(engineOk({ costUsd: 0.4 }))

    const first = await handleDemoReviewRoute(post({ prUrl: PR_URL }), demoEnv)
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ cached: false, repo: "acme/widgets", prNumber: 42 })
    const spendAfterFirst = Number(store.store.get(`demo:spend:${day}`))
    expect(spendAfterFirst).toBeCloseTo(0.4, 5)

    mockEngine.mockClear()
    // A DIFFERENT IP (the first one is already at its limit of 1) — an HN crowd.
    const second = await handleDemoReviewRoute(post({ prUrl: PR_URL }, { "cf-connecting-ip": "198.51.100.4" }), demoEnv)
    expect(second.status).toBe(200)
    const body = (await second.json()) as { cached: boolean; findings: unknown[] }
    expect(body.cached).toBe(true)
    expect(body.findings).toHaveLength(1)
    // The second call cost NOTHING: no engine run, no additional spend.
    expect(mockEngine).not.toHaveBeenCalled()
    expect(Number(store.store.get(`demo:spend:${day}`))).toBeCloseTo(spendAfterFirst, 5)
    // …and consumed no IP quota (nothing new was written for the second IP).
    expect(store.puts.filter((k) => k.startsWith("demo:ip:"))).toHaveLength(1)
  })

  it("does NOT serve a cached review when the PR has a new head sha", async () => {
    const store = kv()
    const demoEnv = env({}, store.namespace)
    stubGithub()
    mockEngine.mockResolvedValue(engineOk())
    await handleDemoReviewRoute(post({ prUrl: PR_URL }), demoEnv)

    mockEngine.mockClear()
    mockEngine.mockResolvedValue(engineOk())
    stubGithub({
      pull: {
        body: {
          title: "t",
          head: { sha: "brand-new" },
          base: { sha: "b" },
          changed_files: 1,
          additions: 1,
          deletions: 0,
        },
      },
    })
    const second = await handleDemoReviewRoute(post({ prUrl: PR_URL }), demoEnv)
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({ cached: false })
    expect(mockEngine).toHaveBeenCalledTimes(1)
  })
})

describe("the review itself is READ-ONLY", () => {
  it("runs the engine in dryRun with no installation, and NEVER writes to GitHub", async () => {
    const github = stubGithub()
    mockEngine.mockResolvedValue(engineOk())
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env())
    expect(response.status).toBe(200)

    const args = mockEngine.mock.calls[0]![0] as EnsembleHandlerArgs
    expect(args.dryRun).toBe(true) // → the orchestrator returns before publishReviewSubmission
    expect(args.installationId).toBe(0) // → no usage_ledger row, no App token
    expect(args.owner).toBe("acme")
    expect(args.repo).toBe("widgets")
    expect(args.prNumber).toBe(42)
    expect(args.headSha).toBe(HEAD_SHA)

    // Every GitHub call we made was a READ.
    expect(github.calls).not.toHaveLength(0)
    for (const call of github.calls) {
      expect(call.method).toBe("GET")
      expect(call.url.startsWith("https://api.github.com/")).toBe(true)
    }
  })

  it("injects a client whose every WRITE method throws (a post attempt is loud, not silent)", async () => {
    stubGithub()
    mockEngine.mockResolvedValue(engineOk())
    await handleDemoReviewRoute(post({ prUrl: PR_URL }), env())
    const client = (mockEngine.mock.calls[0]![0] as EnsembleHandlerArgs).githubClient as unknown as {
      submitReview: () => Promise<unknown>
      createIssueComment: () => Promise<unknown>
      updateIssueComment: () => Promise<unknown>
      deleteIssueComment: () => Promise<unknown>
    }
    await expect(client.submitReview()).rejects.toThrow(/unavailable/)
    await expect(client.createIssueComment()).rejects.toThrow(/unavailable/)
    await expect(client.updateIssueComment()).rejects.toThrow(/unavailable/)
    await expect(client.deleteIssueComment()).rejects.toThrow(/unavailable/)
  })

  it("stubs retrieval inert — a stranger's PR can never read another tenant's indexed code", async () => {
    stubGithub()
    mockEngine.mockResolvedValue(engineOk())
    await handleDemoReviewRoute(post({ prUrl: PR_URL }), env())
    const injected = (mockEngine.mock.calls[0]![0] as EnsembleHandlerArgs).env
    const index = injected.OPENCLAW_CODE_INDEX as unknown as { query: () => Promise<{ matches: unknown[] }> }
    expect(await index.query()).toEqual({ matches: [] })
  })
})

describe("the success contract (the marketing site is built against this)", () => {
  it("returns the documented shape", async () => {
    stubGithub()
    mockEngine.mockResolvedValue(engineOk())
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env())
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/json")
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      repo: "acme/widgets",
      prNumber: 42,
      title: "Add processing fee",
      cached: false,
      summary: "One issue found.",
    })
    expect(body.stats).toMatchObject({ filesReviewed: 1, findingsCount: 1 })
    expect((body.stats as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0)
    expect(body.findings).toEqual([
      {
        severity: "P1",
        title: "Fee is computed before the rate is validated",
        body: "`rate` may be undefined here.",
        file: "src/pay.ts",
        line: 2,
        confidence: "grounded",
        evidence: expect.stringContaining("const fee = total * rate"),
      },
    ])
  })

  it("returns an empty, honest result when the engine found nothing", async () => {
    stubGithub()
    mockEngine.mockResolvedValue(engineOk({ findings: [] }))
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ stats: { findingsCount: 0 }, findings: [] })
  })
})

describe("recall-safety — a broken review never reads as a clean pass", () => {
  it("500s when the engine errored (NEVER a 200 with an empty findings array)", async () => {
    stubGithub()
    mockEngine.mockResolvedValue({
      status: "errored",
      telemetry: { tokenUsageByModel: {}, internalError: "synth exploded" },
    } as unknown as Awaited<ReturnType<typeof handlePrReviewEnsemble>>)
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env())
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: "review_failed" })
  })

  it("500s on a no-verdict bail (total model outage)", async () => {
    stubGithub()
    mockEngine.mockResolvedValue({
      status: "skipped",
      telemetry: { tokenUsageByModel: {}, fellBackReason: "specialists_all_failed" },
    } as unknown as Awaited<ReturnType<typeof handlePrReviewEnsemble>>)
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env())
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: "review_failed" })
  })

  it("never caches a failed review (the next caller gets a real attempt)", async () => {
    const store = kv()
    stubGithub()
    mockEngine.mockResolvedValue({
      status: "errored",
      telemetry: { tokenUsageByModel: {}, internalError: "boom" },
    } as unknown as Awaited<ReturnType<typeof handlePrReviewEnsemble>>)
    await handleDemoReviewRoute(post({ prUrl: PR_URL }), env({}, store.namespace))
    expect(store.puts.filter((k) => k.startsWith("demo:review:"))).toHaveLength(0)
  })

  it("surfaces DEGRADED coverage (a partial review is not a confident pass)", async () => {
    stubGithub()
    mockEngine.mockResolvedValue(engineOk({ findings: [], incomplete: { rolesMissing: ["logic"] } }))
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env())
    expect(response.status).toBe(200)
    const body = (await response.json()) as { summary: string; incomplete?: { rolesMissing: string[] } }
    expect(body.incomplete).toEqual({ rolesMissing: ["logic"] })
    expect(body.summary).toContain("Partial coverage")
  })
})

describe("GitHub unavailability", () => {
  it("502s (not a clean 200) when the GitHub API is down", async () => {
    stubGithub({ repo: { status: 500, body: {} } })
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env())
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: "github_unavailable" })
    expect(mockEngine).not.toHaveBeenCalled()
  })
})
