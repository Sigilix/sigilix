// sig-public-demo — POST /v1/demo/review (start) + GET /v1/demo/review?jobId= (poll),
// the PUBLIC no-auth demo endpoint.
//
// This suite exists because the endpoint SPENDS REAL MONEY WITH NO AUTH. Every test
// below pins a guard that stands between a stranger's HTTP request and the founder's
// card: the fail-closed kill switch, the public-repos-only check, the per-IP cap, the
// global daily USD budget, the diff-size cap, and the PR@SHA result cache — PLUS the
// async contract itself: a cache miss ENQUEUES the review (the ~2-min ensemble can't
// run inside a Worker request) and returns 202 + jobId; GET polls the KV job record.
//
// The engine run itself is NOT exercised here — after the async split it runs in the
// queue consumer, covered by demo-review-job.test.ts. What is under test here is the
// gauntlet around it and the start/poll HTTP contract.

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"

import { handleDemoReviewRoute, handleDemoReviewPoll } from "./api-demo-review-route"
import type { DemoJobRecord, DemoReviewResponse } from "./api-demo-review-route"
import type { Env } from "@/src/shared/types/env"
import type { DemoEnv } from "@/src/lib/demo-review-guards"
import type { JobMessage } from "@/src/shared/types/job"

const PR_URL = "https://github.com/acme/widgets/pull/42"
const HEAD_SHA = "d34db33f"

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

interface QueueSpy {
  queue: Queue<JobMessage>
  sent: JobMessage[]
}

function queue(opts: { throws?: boolean } = {}): QueueSpy {
  const sent: JobMessage[] = []
  const q = {
    send: async (msg: JobMessage) => {
      if (opts.throws) throw new Error("queue unavailable")
      sent.push(msg)
    },
  } as unknown as Queue<JobMessage>
  return { queue: q, sent }
}

function env(
  extra: Partial<DemoEnv> = {},
  namespace: KVNamespace = kv().namespace,
  jobs: Queue<JobMessage> = queue().queue,
): Env {
  return { SIGILIX_DEMO_MODE: "on", OPENCLAW_STATE: namespace, OPENCLAW_JOBS: jobs, ...extra } as unknown as Env
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://api.sigilix.ai/v1/demo/review", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", ...headers },
    body: JSON.stringify(body),
  })
}

function get(jobId?: string): Request {
  const url = jobId
    ? `https://api.sigilix.ai/v1/demo/review?jobId=${encodeURIComponent(jobId)}`
    : "https://api.sigilix.ai/v1/demo/review"
  return new Request(url, { method: "GET" })
}

/** Records every outbound HTTP call so a test can prove we never WROTE to GitHub, and
 *  that the diff is NEVER fetched on the request path (it belongs to the consumer). */
interface GithubStub {
  calls: Array<{ url: string; method: string }>
}

function stubGithub(
  options: {
    repo?: { status?: number; body?: Record<string, unknown> }
    pull?: { status?: number; body?: Record<string, unknown> }
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
        // A diff fetch on the REQUEST path is a bug post-async-split — fail loudly.
        throw new Error("diff must not be fetched synchronously")
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

/** A cached review body, as the async consumer would have written it via writeDemoCache. */
function cachedReview(overrides: Partial<DemoReviewResponse> = {}): DemoReviewResponse {
  return {
    repo: "acme/widgets",
    prNumber: 42,
    title: "Add processing fee",
    cached: false,
    summary: "One issue found.",
    stats: { filesReviewed: 1, findingsCount: 1, durationMs: 1200 },
    findings: [
      {
        severity: "P1",
        title: "Fee is computed before the rate is validated",
        body: "`rate` may be undefined here.",
        file: "src/pay.ts",
        line: 2,
        confidence: "grounded",
      },
    ],
    ...overrides,
  }
}

function cacheKeyFor(headSha: string): string {
  return `demo:review:acme/widgets/pr/42/${headSha}`
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("cross-origin drive-by guard (content-type + origin)", () => {
  it("415s a POST whose Content-Type is not application/json (blocks the no-preflight simple request)", async () => {
    const github = stubGithub()
    const request = new Request("https://api.sigilix.ai/v1/demo/review", {
      method: "POST",
      headers: { "content-type": "text/plain", "cf-connecting-ip": "203.0.113.9" },
      body: JSON.stringify({ prUrl: PR_URL }),
    })
    const response = await handleDemoReviewRoute(request, env())
    expect(response.status).toBe(415)
    expect(github.calls).toHaveLength(0)
  })

  it("403s a POST from a present-but-disallowed Origin (before spending anything)", async () => {
    const github = stubGithub()
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }, { origin: "https://evil.example" }), env())
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: "forbidden" })
    expect(github.calls).toHaveLength(0)
  })

  it("allows an allowlisted Origin (enqueues, 202 pending)", async () => {
    stubGithub()
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }, { origin: "https://sigilix.ai" }), env())
    expect(response.status).toBe(202)
  })

  it("allows a no-Origin caller (curl / same-origin) — the IP + budget caps bound it", async () => {
    stubGithub()
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env())
    expect(response.status).toBe(202)
  })
})

describe("kill switch — FAIL CLOSED", () => {
  it("is DISABLED when SIGILIX_DEMO_MODE is unset (the default must never spend)", async () => {
    const github = stubGithub()
    const spy = queue()
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), {
      OPENCLAW_STATE: kv().namespace,
      OPENCLAW_JOBS: spy.queue,
    } as unknown as Env)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: "demo_disabled" })
    // Nothing was reviewed, GitHub was never touched, nothing was enqueued.
    expect(github.calls).toHaveLength(0)
    expect(spy.sent).toHaveLength(0)
  })

  it.each(["off", "ON", "true", "1"])("is DISABLED for the near-miss value %j", async (value) => {
    const spy = queue()
    const response = await handleDemoReviewRoute(
      post({ prUrl: PR_URL }),
      env({ SIGILIX_DEMO_MODE: value }, kv().namespace, spy.queue),
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: "demo_disabled" })
    expect(spy.sent).toHaveLength(0)
  })

  it("is DISABLED when the KV binding (where every counter lives) is missing", async () => {
    const spy = queue()
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), {
      SIGILIX_DEMO_MODE: "on",
      OPENCLAW_JOBS: spy.queue,
    } as unknown as Env)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: "demo_disabled" })
    expect(spy.sent).toHaveLength(0)
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
  })

  it("rejects a missing prUrl", async () => {
    const response = await handleDemoReviewRoute(post({}), env())
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: "invalid_url" })
  })
})

describe("public repos only", () => {
  it("REFUSES a private repo (200 from GitHub, private:true) — never reviews private code", async () => {
    const spy = queue()
    stubGithub({ repo: { body: { private: true, visibility: "private" } } })
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env({}, kv().namespace, spy.queue))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: "not_public" })
    expect(spy.sent).toHaveLength(0)
  })

  it("REFUSES a repo GitHub hides from us (404 — private or nonexistent, indistinguishable)", async () => {
    stubGithub({ repo: { status: 404, body: { message: "Not Found" } } })
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env())
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: "not_public" })
  })

  it("checks the repo BEFORE fetching the PR meta", async () => {
    const github = stubGithub({ repo: { body: { private: true } } })
    await handleDemoReviewRoute(post({ prUrl: PR_URL }), env())
    expect(github.calls).toHaveLength(1)
    expect(github.calls[0]!.url).toContain("/repos/acme/widgets")
    expect(github.calls[0]!.url).not.toContain("/pulls/")
  })

  it("never forwards a caller-supplied token to GitHub (there is no request field for one)", async () => {
    const github = stubGithub()
    await handleDemoReviewRoute(
      post({ prUrl: PR_URL, token: "ghp_attacker", installationId: 1 }, { authorization: "Bearer ghp_attacker" }),
      env(),
    )
    const fetchMock = vi.mocked(fetch)
    for (const call of fetchMock.mock.calls) {
      const headers = (call[1]?.headers ?? {}) as Record<string, string>
      expect(headers.authorization).toBeUndefined()
    }
    // Only repo + PR-meta READs happen on the request path (no diff, no writes).
    expect(github.calls.every((c) => c.method === "GET")).toBe(true)
  })
})

describe("diff-size cap (synchronous, from PR meta)", () => {
  it("REFUSES an oversize PR by line count before enqueueing", async () => {
    const spy = queue()
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
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env({}, kv().namespace, spy.queue))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: "too_large" })
    expect(spy.sent).toHaveLength(0)
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
  })

  it("honours an env-tuned cap that is TIGHTER than the default", async () => {
    stubGithub()
    const ok = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env({ SIGILIX_DEMO_MAX_LINES: "0" }))
    // "0" is not a positive integer → falls back to the 1500 default rather than
    // silently disabling the cap, so this 1-line PR is still enqueued.
    expect(ok.status).toBe(202)

    const atCap = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env({ SIGILIX_DEMO_MAX_FILES: "1" }))
    expect(atCap.status).toBe(202) // exactly at the cap — allowed

    stubGithub({
      pull: {
        body: { title: "t", head: { sha: HEAD_SHA }, base: { sha: "b" }, changed_files: 2, additions: 2, deletions: 0 },
      },
    })
    const overCap = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env({ SIGILIX_DEMO_MAX_FILES: "1" }))
    expect(overCap.status).toBe(400)
    expect(await overCap.json()).toMatchObject({ error: "too_large" })
  })
})

describe("per-IP rate limit", () => {
  it("allows the first N reviews from an IP and then 429s with retryAfterSec", async () => {
    const store = kv()
    const spy = queue()
    stubGithub()
    const demoEnv = env({ SIGILIX_DEMO_IP_LIMIT: "2" }, store.namespace, spy.queue)

    const first = await handleDemoReviewRoute(post({ prUrl: PR_URL }), demoEnv)
    expect(first.status).toBe(202)

    // A NEW head sha → a cache miss → a second real (enqueued) review.
    stubGithub({
      pull: {
        body: { title: "t", head: { sha: "newsha" }, base: { sha: "b" }, changed_files: 1, additions: 1, deletions: 0 },
      },
    })
    const second = await handleDemoReviewRoute(post({ prUrl: PR_URL }), demoEnv)
    expect(second.status).toBe(202)

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
    // Only the first two admitted reviews were enqueued.
    expect(spy.sent).toHaveLength(2)
  })

  it("rejects a rate-limited IP BEFORE touching GitHub (an exhausted IP costs us nothing)", async () => {
    const store = kv()
    const demoEnv = env({ SIGILIX_DEMO_IP_LIMIT: "1" }, store.namespace)
    stubGithub()
    await handleDemoReviewRoute(post({ prUrl: PR_URL }), demoEnv)

    const github = stubGithub()
    const blocked = await handleDemoReviewRoute(post({ prUrl: "https://github.com/acme/widgets/pull/42" }), demoEnv)
    expect(blocked.status).toBe(429)
    expect(github.calls).toHaveLength(0)
  })

  it("refuses a request with no CF-Connecting-IP (the cap would be unenforceable)", async () => {
    const request = new Request("https://api.sigilix.ai/v1/demo/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prUrl: PR_URL }),
    })
    const github = stubGithub()
    const spy = queue()
    const response = await handleDemoReviewRoute(request, env({}, kv().namespace, spy.queue))
    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({ error: "rate_limited" })
    expect(github.calls).toHaveLength(0)
    expect(spy.sent).toHaveLength(0)
  })
})

describe("global daily USD budget", () => {
  it("503s at_capacity once the day's REAL spend has exhausted the budget", async () => {
    const day = new Date().toISOString().slice(0, 10)
    const store = kv({ [`demo:spend:${day}`]: "20.000000" })
    const github = stubGithub()
    const spy = queue()
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env({}, store.namespace, spy.queue))
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: "at_capacity" })
    // The backstop fires before GitHub and before the enqueue.
    expect(github.calls).toHaveLength(0)
    expect(spy.sent).toHaveLength(0)
  })

  it("RESERVES the assumed cost before enqueueing (a concurrent burst can't all pass the check)", async () => {
    const day = new Date().toISOString().slice(0, 10)
    const store = kv()
    stubGithub()
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env({}, store.namespace))
    expect(response.status).toBe(202)
    expect(Number(store.store.get(`demo:spend:${day}`))).toBeCloseTo(0.25, 5)
  })
})

describe("the START contract (POST — enqueue then poll)", () => {
  it("returns 202 {status:'pending', jobId} and enqueues a demo-review job pinned to the validated head", async () => {
    const store = kv()
    const spy = queue()
    stubGithub()
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env({}, store.namespace, spy.queue))
    expect(response.status).toBe(202)
    const body = (await response.json()) as { status: string; jobId: string }
    expect(body.status).toBe("pending")
    expect(body.jobId).toMatch(/[0-9a-f-]{36}/)

    // The enqueued job carries the PR@SHA meta the guards validated.
    expect(spy.sent).toHaveLength(1)
    const job = spy.sent[0]!
    expect(job).toMatchObject({
      type: "demo-review",
      jobId: body.jobId,
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
      headSha: HEAD_SHA,
      baseSha: "cafe",
      title: "Add processing fee",
      changedFiles: 1,
    })
    if (job.type === "demo-review") expect(typeof job.reservedAtMs).toBe("number")

    // A pending record is written under the jobId so an immediate poll resolves.
    expect(store.puts).toContain(`demo:job:${body.jobId}`)
    expect(JSON.parse(store.store.get(`demo:job:${body.jobId}`)!)).toEqual({ status: "pending" })
  })

  it("returns a cache HIT inline as {status:'done', ...review, cached:true} — no quota, no spend, no enqueue", async () => {
    const day = new Date().toISOString().slice(0, 10)
    const store = kv({ [cacheKeyFor(HEAD_SHA)]: JSON.stringify(cachedReview()) })
    const spy = queue()
    stubGithub()
    const response = await handleDemoReviewRoute(
      post({ prUrl: PR_URL }),
      env({ SIGILIX_DEMO_IP_LIMIT: "1" }, store.namespace, spy.queue),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as DemoJobRecord
    expect(body).toMatchObject({ status: "done", repo: "acme/widgets", prNumber: 42, cached: true })

    // A cache hit costs nothing: no enqueue, no spend, no IP quota consumed.
    expect(spy.sent).toHaveLength(0)
    expect(store.store.get(`demo:spend:${day}`)).toBeUndefined()
    expect(store.puts.filter((k) => k.startsWith("demo:ip:"))).toHaveLength(0)
  })

  it("500s and resolves the job to error when the enqueue itself fails", async () => {
    const store = kv()
    const spy = queue({ throws: true })
    stubGithub()
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env({}, store.namespace, spy.queue))
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: "review_failed" })
    // The pending record was overwritten with an error so a poll surfaces the failure.
    const jobKey = store.puts.find((k) => k.startsWith("demo:job:"))!
    expect(JSON.parse(store.store.get(jobKey)!)).toMatchObject({ status: "error", error: "review_failed" })
  })
})

describe("GitHub unavailability", () => {
  it("502s (not a clean 202) when the GitHub API is down", async () => {
    const spy = queue()
    stubGithub({ repo: { status: 500, body: {} } })
    const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env({}, kv().namespace, spy.queue))
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: "github_unavailable" })
    expect(spy.sent).toHaveLength(0)
  })

  it.each([401, 403])(
    "maps a GitHub %d (bad token / rate-limit) to github_unavailable, NOT not_public",
    async (status) => {
      // A public repo must never be accused of being private because OUR token expired
      // or OUR shared egress IP hit GitHub's rate limit.
      stubGithub({ repo: { status, body: { message: "rate limited" } } })
      const response = await handleDemoReviewRoute(post({ prUrl: PR_URL }), env())
      expect(response.status).toBe(502)
      expect(await response.json()).toMatchObject({ error: "github_unavailable" })
    },
  )
})

describe("the POLL contract (GET ?jobId=)", () => {
  it("400s when jobId is missing", async () => {
    const response = await handleDemoReviewPoll(get(), env())
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: "invalid_request" })
  })

  it("404s for an unknown / expired jobId", async () => {
    const response = await handleDemoReviewPoll(get("does-not-exist"), env())
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: "not_found" })
  })

  it("returns {status:'pending'} while the async run is in flight", async () => {
    const store = kv({ "demo:job:job-1": JSON.stringify({ status: "pending" }) })
    const response = await handleDemoReviewPoll(get("job-1"), env({}, store.namespace))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "pending" })
  })

  it("returns {status:'done', ...review} once the run wrote its result", async () => {
    const record: DemoJobRecord = { status: "done", ...cachedReview({ cached: false }) }
    const store = kv({ "demo:job:job-2": JSON.stringify(record) })
    const response = await handleDemoReviewPoll(get("job-2"), env({}, store.namespace))
    expect(response.status).toBe(200)
    const body = (await response.json()) as DemoJobRecord
    expect(body).toMatchObject({ status: "done", repo: "acme/widgets", prNumber: 42 })
    if (body.status === "done") expect(body.findings).toHaveLength(1)
  })

  it("returns {status:'error', ...} for a failed run (never a clean pass)", async () => {
    const record: DemoJobRecord = {
      status: "error",
      error: "review_failed",
      message: "The review could not be completed. Please try again.",
    }
    const store = kv({ "demo:job:job-3": JSON.stringify(record) })
    const response = await handleDemoReviewPoll(get("job-3"), env({}, store.namespace))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: "error", error: "review_failed" })
  })

  it("503s when the KV binding is missing", async () => {
    const response = await handleDemoReviewPoll(get("job-1"), { SIGILIX_DEMO_MODE: "on" } as unknown as Env)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: "demo_disabled" })
  })
})
