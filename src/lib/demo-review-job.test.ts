// sig-public-demo (async) — the OFF-REQUEST-PATH review run (`runDemoReviewJob`), the
// half of POST /v1/demo/review that the queue consumer executes.
//
// This is where the engine actually runs after the async split, so this suite owns the
// invariants the old synchronous route test used to pin: the review is READ-ONLY (dryRun,
// write-throwing client, retrieval + memory + learnings off), the reservation is always
// reconciled (real cost on success, assumed cost on failure), a broken review resolves to
// `error` and is NEVER cached, a degraded review is not a confident pass, and body-only
// findings are not dropped. The engine and the GitHub diff API are both mocked.

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"

vi.mock("@/src/lib/ensemble/app/orchestrator", () => ({ handlePrReviewEnsemble: vi.fn() }))

import { runDemoReviewJob, type DemoReviewJob } from "./demo-review-job"
import { handlePrReviewEnsemble } from "@/src/lib/ensemble/app/orchestrator"
import type { Env } from "@/src/shared/types/env"
import type { DemoEnv } from "@/src/lib/demo-review-guards"
import type { DemoJobRecord } from "@/src/lib/api-demo-review-route"
import type { EnsembleHandlerArgs } from "@/src/lib/ensemble/app/orchestrator-types"

const mockEngine = vi.mocked(handlePrReviewEnsemble)

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

function env(extra: Partial<DemoEnv> = {}, namespace: KVNamespace = kv().namespace): DemoEnv {
  return { SIGILIX_DEMO_MODE: "on", OPENCLAW_STATE: namespace, ...extra } as unknown as Env
}

function job(overrides: Partial<DemoReviewJob> = {}): DemoReviewJob {
  return {
    jobId: "job-abc",
    owner: "acme",
    repo: "widgets",
    prNumber: 42,
    headSha: HEAD_SHA,
    baseSha: "cafe",
    title: "Add processing fee",
    changedFiles: 1,
    reservedAtMs: Date.now(),
    ...overrides,
  }
}

/** Records every outbound HTTP call so a test can prove we never WROTE to GitHub. */
interface GithubStub {
  calls: Array<{ url: string; method: string }>
}

function stubGithub(options: { diff?: { status?: number; text?: string } } = {}): GithubStub {
  const stub: GithubStub = { calls: [] }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? "GET"
      stub.calls.push({ url, method })
      if (url.endsWith("/repos/acme/widgets/pulls/42")) {
        const diff = options.diff ?? {}
        return new Response(diff.text ?? DIFF, { status: diff.status ?? 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
  return stub
}

/** A successful dry-run engine result carrying one finding and a $0.30 token bill. */
function engineOk(
  overrides: {
    costUsd?: number
    findings?: unknown[]
    unanchoredFindings?: unknown[]
    incomplete?: { rolesMissing: string[] }
  } = {},
) {
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
      unanchoredFindings: overrides.unanchoredFindings ?? [],
      ...(overrides.incomplete ? { incomplete: overrides.incomplete } : {}),
    },
  } as unknown as Awaited<ReturnType<typeof handlePrReviewEnsemble>>
}

function readJob(store: KvSpy, jobId = "job-abc"): DemoJobRecord {
  return JSON.parse(store.store.get(`demo:job:${jobId}`)!) as DemoJobRecord
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

describe("the review itself is READ-ONLY", () => {
  it("runs the engine in dryRun with no installation, pinned to the job's head sha", async () => {
    const github = stubGithub()
    mockEngine.mockResolvedValue(engineOk())
    await runDemoReviewJob(job(), env())

    const args = mockEngine.mock.calls[0]![0] as EnsembleHandlerArgs
    expect(args.dryRun).toBe(true) // → the orchestrator returns before publishReviewSubmission
    expect(args.installationId).toBe(0) // → no usage_ledger row, no App token
    expect(args.owner).toBe("acme")
    expect(args.repo).toBe("widgets")
    expect(args.prNumber).toBe(42)
    expect(args.headSha).toBe(HEAD_SHA)
    expect(args.forceFullCoverage).toBe(true)

    // Every GitHub call we made was a READ (only the diff fetch happens here).
    expect(github.calls).not.toHaveLength(0)
    for (const call of github.calls) {
      expect(call.method).toBe("GET")
      expect(call.url.startsWith("https://api.github.com/")).toBe(true)
    }
  })

  it("injects a client whose every WRITE method throws (a post attempt is loud, not silent)", async () => {
    stubGithub()
    mockEngine.mockResolvedValue(engineOk())
    await runDemoReviewJob(job(), env())
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

  it("stubs retrieval inert, and forces review-memory + learnings OFF", async () => {
    stubGithub()
    mockEngine.mockResolvedValue(engineOk())
    await runDemoReviewJob(job(), env())
    const injected = (mockEngine.mock.calls[0]![0] as EnsembleHandlerArgs).env
    const index = injected.OPENCLAW_CODE_INDEX as unknown as { query: () => Promise<{ matches: unknown[] }> }
    expect(await index.query()).toEqual({ matches: [] })
    const injectedRecord = injected as unknown as Record<string, string>
    expect(injectedRecord.OPENCLAW_REVIEW_MEMORY_ENABLED).toBe("off")
    expect(injectedRecord.OPENCLAW_LEARNINGS_MODE).toBe("off")
  })
})

describe("spend reconciliation", () => {
  it("charges the REAL ensemble cost against the budget, reconciling the reservation", async () => {
    const day = new Date().toISOString().slice(0, 10)
    // The reservation was already made by the POST — seed it here.
    const store = kv({ [`demo:spend:${day}`]: "0.250000" })
    stubGithub()
    mockEngine.mockResolvedValue(engineOk({ costUsd: 0.83 }))
    await runDemoReviewJob(job(), env({}, store.namespace))
    expect(Number(store.store.get(`demo:spend:${day}`))).toBeCloseTo(0.83, 5)
  })

  it("still charges when the engine THROWS (a crashed review has already burned tokens)", async () => {
    const day = new Date().toISOString().slice(0, 10)
    const store = kv({ [`demo:spend:${day}`]: "0.250000" })
    stubGithub()
    mockEngine.mockRejectedValue(new Error("provider exploded"))
    await runDemoReviewJob(job(), env({}, store.namespace))
    // Reservation kept (assumed cost), not refunded.
    expect(Number(store.store.get(`demo:spend:${day}`))).toBeCloseTo(0.25, 5)
    expect(readJob(store)).toMatchObject({ status: "error", error: "review_failed" })
  })
})

describe("the DONE result", () => {
  it("writes the review to the PR@SHA cache AND resolves the job to done", async () => {
    const store = kv()
    stubGithub()
    mockEngine.mockResolvedValue(engineOk())
    await runDemoReviewJob(job(), env({}, store.namespace))

    // Cached by PR@SHA for the next identical request.
    const cacheKey = `demo:review:acme/widgets/pr/42/${HEAD_SHA}`
    expect(store.puts).toContain(cacheKey)

    // The poll record is a resolved `done` carrying the full review.
    const record = readJob(store)
    expect(record.status).toBe("done")
    if (record.status === "done") {
      expect(record).toMatchObject({ repo: "acme/widgets", prNumber: 42, title: "Add processing fee", cached: false })
      expect(record.stats).toMatchObject({ filesReviewed: 1, findingsCount: 1 })
      expect(record.findings).toEqual([
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
    }
  })

  it("resolves an honest empty done when the engine found nothing", async () => {
    const store = kv()
    stubGithub()
    mockEngine.mockResolvedValue(engineOk({ findings: [] }))
    await runDemoReviewJob(job(), env({}, store.namespace))
    const record = readJob(store)
    expect(record).toMatchObject({ status: "done", stats: { findingsCount: 0 }, findings: [] })
  })
})

describe("recall-safety", () => {
  it("includes UNANCHORED findings (a body-only issue must not resolve as 0 findings)", async () => {
    const store = kv()
    stubGithub()
    mockEngine.mockResolvedValue(
      engineOk({
        findings: [],
        unanchoredFindings: [
          {
            path: "src/pay.ts",
            line: 1,
            score: 5,
            category: "security",
            headline: "Unbounded fee multiplier",
            body: "This can overflow.",
            trust: { tier: "grounded-model" },
          },
        ],
      }),
    )
    await runDemoReviewJob(job(), env({}, store.namespace))
    const record = readJob(store)
    expect(record.status).toBe("done")
    if (record.status === "done") {
      expect(record.stats.findingsCount).toBe(1)
      expect(record.findings[0]!.severity).toBe("P0")
    }
  })

  it("resolves to ERROR when the engine errored (NEVER done with empty findings) and does NOT cache", async () => {
    const store = kv()
    stubGithub()
    mockEngine.mockResolvedValue({
      status: "errored",
      telemetry: { tokenUsageByModel: {}, internalError: "synth exploded" },
    } as unknown as Awaited<ReturnType<typeof handlePrReviewEnsemble>>)
    await runDemoReviewJob(job(), env({}, store.namespace))
    expect(readJob(store)).toMatchObject({ status: "error", error: "review_failed" })
    // A failed review is never cached — the next caller gets a real attempt.
    expect(store.puts.filter((k) => k.startsWith("demo:review:"))).toHaveLength(0)
  })

  it("resolves to ERROR on a no-verdict bail (total model outage)", async () => {
    const store = kv()
    stubGithub()
    mockEngine.mockResolvedValue({
      status: "skipped",
      telemetry: { tokenUsageByModel: {}, fellBackReason: "specialists_all_failed" },
    } as unknown as Awaited<ReturnType<typeof handlePrReviewEnsemble>>)
    await runDemoReviewJob(job(), env({}, store.namespace))
    expect(readJob(store)).toMatchObject({ status: "error", error: "review_failed" })
  })

  it("surfaces DEGRADED coverage in the done record (a partial review is not a confident pass)", async () => {
    const store = kv()
    stubGithub()
    mockEngine.mockResolvedValue(engineOk({ findings: [], incomplete: { rolesMissing: ["logic"] } }))
    await runDemoReviewJob(job(), env({}, store.namespace))
    const record = readJob(store)
    expect(record.status).toBe("done")
    if (record.status === "done") {
      expect(record.incomplete).toEqual({ rolesMissing: ["logic"] })
      expect(record.summary).toContain("Partial coverage")
    }
  })
})

describe("never throws (a throw would make the queue retry and double-spend)", () => {
  it("converts an unexpected post-engine error into a resolved error record", async () => {
    const day = new Date().toISOString().slice(0, 10)
    const store = kv({ [`demo:spend:${day}`]: "0.250000" })
    stubGithub()
    // A result whose `.telemetry` access throws — an unforeseen shape that would escape
    // the inner engine try/catch and reach the outer guard.
    mockEngine.mockResolvedValue(
      new Proxy(
        {},
        {
          get() {
            throw new Error("malformed engine result")
          },
        },
      ) as unknown as Awaited<ReturnType<typeof handlePrReviewEnsemble>>,
    )
    // Must NOT reject — the queue would otherwise retry and re-spend.
    await expect(runDemoReviewJob(job(), env({}, store.namespace))).resolves.toBeUndefined()
    expect(readJob(store)).toMatchObject({ status: "error", error: "review_failed" })
    // Reservation kept (cost-safe), not silently dropped.
    expect(Number(store.store.get(`demo:spend:${day}`))).toBeCloseTo(0.25, 5)
  })
})

describe("diff fetch failure (in the consumer)", () => {
  it("resolves to error and keeps the reservation when GitHub can't serve the diff", async () => {
    const day = new Date().toISOString().slice(0, 10)
    const store = kv({ [`demo:spend:${day}`]: "0.250000" })
    stubGithub({ diff: { status: 502, text: "" } })
    await runDemoReviewJob(job(), env({}, store.namespace))
    expect(mockEngine).not.toHaveBeenCalled()
    expect(readJob(store)).toMatchObject({ status: "error", error: "github_unavailable" })
    expect(Number(store.store.get(`demo:spend:${day}`))).toBeCloseTo(0.25, 5)
  })

  it("maps a diff GitHub itself calls too large (406) to a too_large error", async () => {
    const store = kv()
    stubGithub({ diff: { status: 406, text: "" } })
    await runDemoReviewJob(job(), env({}, store.namespace))
    expect(mockEngine).not.toHaveBeenCalled()
    expect(readJob(store)).toMatchObject({ status: "error", error: "too_large" })
  })
})
