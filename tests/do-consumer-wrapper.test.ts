// ARC-190 Task 7 — consumer wrapper integration tests.
//
// `runPrReviewWithDoCallback` wraps the queue consumer's pr-review
// branch with /pickup → ensemble → /run-result. The DO becomes the
// retry source-of-truth; the queue acks on every flow except
// pickup-5xx, where the throw lets Cloudflare redeliver.

import { describe, it, expect, vi } from "vitest"
import { runPrReviewWithDoCallback } from "../src/do/consumer-wrapper"
import type { Env, JobMessage } from "../src/index"
import type { PickupResponse, RunResultRequest } from "../src/do/types"
import { GitHubHttpError } from "../src/lib/github"

type PrReviewJob = Extract<JobMessage, { type: "pr-review" }>

const SAMPLE_RUN_ID = "11111111-1111-4111-8111-111111111111"
const SAMPLE_HEAD_SHA = "a".repeat(40)

function makeJob(over: Partial<PrReviewJob> = {}): PrReviewJob {
  return {
    type: "pr-review",
    owner: "Arc-and-Anchor",
    repo: "sigilix",
    prNumber: 7,
    headSha: SAMPLE_HEAD_SHA,
    installationId: 99,
    runId: SAMPLE_RUN_ID,
    ...over,
  }
}

interface DoCall {
  url: string
  method: string
  body: unknown
}

interface MakeStubArgs {
  pickup?:
    | { kind: "ok" }
    | { kind: "duplicate-409"; reason?: string }
    | { kind: "supersede-410"; reason?: string }
    | { kind: "terminal-410"; reason?: string }
    | { kind: "stale-410"; reason?: string }
    | { kind: "server-error"; status?: number }
    | { kind: "transport-throw" }
  /** When set, /run-result throws (post failure swallow path). */
  runResultThrows?: boolean
  /** When set, /run-result returns this status. */
  runResultStatus?: number
  /** Records names handed to idFromName. */
  expectedName?: string
}

function makeEnv(args: MakeStubArgs = {}): { env: Env; calls: DoCall[]; idFromName: ReturnType<typeof vi.fn> } {
  const calls: DoCall[] = []
  const fetchMock = vi.fn(async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url
    const method = (init?.method ?? "GET").toUpperCase()
    let body: unknown = undefined
    if (init?.body && typeof init.body === "string") {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    calls.push({ url, method, body })

    if (url.endsWith("/pickup")) {
      const p = args.pickup ?? { kind: "ok" }
      if (p.kind === "transport-throw") {
        throw new Error("DO transport failed")
      }
      if (p.kind === "ok") {
        return new Response(JSON.stringify({ picked: true } as PickupResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (p.kind === "duplicate-409") {
        return new Response(JSON.stringify({ reason: p.reason ?? "duplicate-409" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        })
      }
      if (p.kind === "server-error") {
        return new Response(JSON.stringify({ error: "boom" }), {
          status: p.status ?? 500,
          headers: { "content-type": "application/json" },
        })
      }
      // Any 410 variant
      const reason = p.reason ?? p.kind
      return new Response(JSON.stringify({ reason }), {
        status: 410,
        headers: { "content-type": "application/json" },
      })
    }
    if (url.endsWith("/run-result")) {
      if (args.runResultThrows) throw new Error("DO transport failed for /run-result")
      return new Response(JSON.stringify({ recorded: "state" }), {
        status: args.runResultStatus ?? 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response("not found", { status: 404 })
  })
  const stub = { fetch: fetchMock } as unknown as DurableObjectStub
  const idFromName = vi.fn((name: string) => {
    if (args.expectedName) {
      expect(name).toBe(args.expectedName)
    }
    return { name } as unknown as DurableObjectId
  })
  const get = vi.fn((_id: DurableObjectId) => stub) as unknown as DurableObjectNamespace["get"]
  const env = {
    PR_REVIEW_RUN: { idFromName, get } as unknown as DurableObjectNamespace,
    OPENCLAW_PR_REVIEW_MODE: "post",
  } as unknown as Env
  return { env, calls, idFromName }
}

describe("runPrReviewWithDoCallback — legacy passthrough", () => {
  it("bypasses DO when message.runId is missing", async () => {
    const { env, calls, idFromName } = makeEnv()
    const runEnsemble = vi.fn(async () => {})
    const job = makeJob({ runId: undefined })
    await runPrReviewWithDoCallback(job, env, runEnsemble)
    expect(runEnsemble).toHaveBeenCalledOnce()
    expect(idFromName).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it("bypasses DO when message.runId is numeric (Codex B2 regression — ci-triage carries numeric runId)", async () => {
    // Codex BLOCKING B2 on plan v1: a generic `if (message.runId)`
    // guard would falsely match the unrelated `ci-triage` JobMessage
    // variant, whose `runId: number` field is a GitHub Actions run id,
    // not a DO-routed UUID. The wrapper MUST gate on
    // `typeof job.runId === "string"`. This test passes a numeric
    // runId and asserts the wrapper bypasses cleanly.
    const { env, calls } = makeEnv()
    const runEnsemble = vi.fn(async () => {})
    const job = { ...makeJob(), runId: 42 as unknown as string }
    await runPrReviewWithDoCallback(job as PrReviewJob, env, runEnsemble)
    expect(runEnsemble).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(0)
  })
})

describe("runPrReviewWithDoCallback — happy path", () => {
  it("pickup 200 → run ensemble → /run-result success", async () => {
    const { env, calls } = makeEnv({ expectedName: "Arc-and-Anchor/sigilix#7" })
    const runEnsemble = vi.fn(async () => {})
    await runPrReviewWithDoCallback(makeJob(), env, runEnsemble)
    expect(runEnsemble).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toContain("/pickup")
    expect(calls[0]?.body).toMatchObject({ runId: SAMPLE_RUN_ID })
    expect((calls[0]?.body as { consumerId: string }).consumerId).toMatch(/[0-9a-f-]{8,}/)
    expect(calls[1]?.url).toContain("/run-result")
    expect(calls[1]?.body).toMatchObject({
      runId: SAMPLE_RUN_ID,
      status: "success",
    })
    // Same consumerId on both calls.
    expect((calls[1]?.body as { consumerId: string }).consumerId).toBe(
      (calls[0]?.body as { consumerId: string }).consumerId,
    )
  })

  it("does not include error field on success", async () => {
    const { env, calls } = makeEnv()
    await runPrReviewWithDoCallback(makeJob(), env, async () => {})
    const rr = calls[1]?.body as RunResultRequest
    expect(rr.error).toBeUndefined()
  })
})

describe("runPrReviewWithDoCallback — pickup blocked (ack + exit)", () => {
  for (const variant of ["duplicate-409", "supersede-410", "terminal-410", "stale-410"] as const) {
    it(`pickup ${variant} → ensemble NOT invoked, /run-result NOT posted, returns cleanly`, async () => {
      const { env, calls } = makeEnv({ pickup: { kind: variant } })
      const runEnsemble = vi.fn(async () => {})
      await runPrReviewWithDoCallback(makeJob(), env, runEnsemble)
      expect(runEnsemble).not.toHaveBeenCalled()
      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toContain("/pickup")
    })
  }
})

describe("runPrReviewWithDoCallback — pickup transport / 5xx (queue redelivers)", () => {
  it("pickup 5xx → throws (queue redelivers)", async () => {
    const { env, calls } = makeEnv({ pickup: { kind: "server-error", status: 503 } })
    const runEnsemble = vi.fn(async () => {})
    await expect(runPrReviewWithDoCallback(makeJob(), env, runEnsemble)).rejects.toThrow()
    expect(runEnsemble).not.toHaveBeenCalled()
    // Only the pickup attempt was made; no /run-result follow-up.
    expect(calls).toHaveLength(1)
  })

  it("pickup 500 → throws", async () => {
    const { env } = makeEnv({ pickup: { kind: "server-error", status: 500 } })
    await expect(
      runPrReviewWithDoCallback(makeJob(), env, async () => {}),
    ).rejects.toThrow()
  })

  it("pickup transport throw → propagates raw error (queue redelivers)", async () => {
    const { env } = makeEnv({ pickup: { kind: "transport-throw" } })
    const runEnsemble = vi.fn(async () => {})
    await expect(runPrReviewWithDoCallback(makeJob(), env, runEnsemble)).rejects.toThrow(/DO transport failed/)
    expect(runEnsemble).not.toHaveBeenCalled()
  })
})

describe("runPrReviewWithDoCallback — pickup unexpected 4xx (ack + log, no throw)", () => {
  // Codex BLOCKING on review v1: a 4xx other than 409/410 indicates a
  // deploy mismatch or schema bug. Redelivery wouldn't fix it; the DO
  // watchdog will catch the missing /run-result and recover the run.
  it("pickup 400 → ack + log (no throw, no ensemble)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { env, calls } = makeEnv({ pickup: { kind: "server-error", status: 400 } })
    const runEnsemble = vi.fn(async () => {})
    await expect(
      runPrReviewWithDoCallback(makeJob(), env, runEnsemble),
    ).resolves.toBeUndefined()
    expect(runEnsemble).not.toHaveBeenCalled()
    // Only pickup; no /run-result post since we never had a claim.
    expect(calls).toHaveLength(1)
    expect(errSpy).toHaveBeenCalled()
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n")
    expect(logged).toContain("do-review-consumer-pickup-unexpected-status")
    errSpy.mockRestore()
  })

  it("pickup 404 → ack + log (no throw, no ensemble)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { env, calls } = makeEnv({ pickup: { kind: "server-error", status: 404 } })
    await expect(
      runPrReviewWithDoCallback(makeJob(), env, async () => {}),
    ).resolves.toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe("runPrReviewWithDoCallback — error classification on /run-result", () => {
  it("transient throw → /run-result transient with stage + message", async () => {
    const { env, calls } = makeEnv()
    const transientErr = new GitHubHttpError(502, "upstream 502")
    const runEnsemble = vi.fn(async () => {
      throw transientErr
    })
    await runPrReviewWithDoCallback(makeJob(), env, runEnsemble)
    expect(calls).toHaveLength(2)
    const rr = calls[1]?.body as RunResultRequest
    expect(rr.status).toBe("transient")
    expect(rr.error?.stage).toBe("github-http-502")
    expect(rr.error?.message).toContain("502")
  })

  it("terminal throw → /run-result terminal", async () => {
    const { env, calls } = makeEnv()
    const terminalErr = new GitHubHttpError(422, "submit invalid")
    const runEnsemble = vi.fn(async () => {
      throw terminalErr
    })
    await runPrReviewWithDoCallback(makeJob(), env, runEnsemble)
    const rr = calls[1]?.body as RunResultRequest
    expect(rr.status).toBe("terminal")
    expect(rr.error?.stage).toBe("github-http-422")
  })

  it("does NOT re-throw ensemble errors — the DO owns retry decisions", async () => {
    // The wrapper must return cleanly so the queue acks; the DO
    // decides whether to schedule a retry alarm based on the
    // /run-result status.
    const { env } = makeEnv()
    const runEnsemble = async () => {
      throw new GitHubHttpError(500, "upstream 500")
    }
    await expect(runPrReviewWithDoCallback(makeJob(), env, runEnsemble)).resolves.toBeUndefined()
  })
})

describe("runPrReviewWithDoCallback — /run-result post failure (watchdog safety net)", () => {
  it("swallow + log when /run-result throws (success path)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { env } = makeEnv({ runResultThrows: true })
    await expect(runPrReviewWithDoCallback(makeJob(), env, async () => {})).resolves.toBeUndefined()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("swallow + log when /run-result throws (failure path)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { env } = makeEnv({ runResultThrows: true })
    await expect(
      runPrReviewWithDoCallback(makeJob(), env, async () => {
        throw new GitHubHttpError(500, "upstream 500")
      }),
    ).resolves.toBeUndefined()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("swallow when /run-result returns non-2xx", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { env } = makeEnv({ runResultStatus: 503 })
    await expect(runPrReviewWithDoCallback(makeJob(), env, async () => {})).resolves.toBeUndefined()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe("runPrReviewWithDoCallback — DO instance scoping", () => {
  it("calls idFromName with `${owner}/${repo}#${prNumber}` shape", async () => {
    const { env, idFromName } = makeEnv()
    await runPrReviewWithDoCallback(makeJob(), env, async () => {})
    expect(idFromName).toHaveBeenCalledWith("Arc-and-Anchor/sigilix#7")
  })
})

describe("runPrReviewWithDoCallback — /run-result bounded retry (CR PR #70)", () => {
  // CodeRabbit MAJOR on PR #70: a single /run-result POST failure on
  // the success path used to log + return, leaving the DO non-
  // terminal. Bounded retry shrinks the watchdog-driven re-run window.
  function makeRetryEnv(runResultBehavior: () => Response | "throw"): {
    env: Env
    runResultCalls: number
  } {
    let pickupCalls = 0
    let runResultCalls = 0
    const fetchMock = vi.fn(async (input: string | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url
      if (url.endsWith("/pickup")) {
        pickupCalls++
        return new Response(JSON.stringify({ picked: true }), {
          status: 200, headers: { "content-type": "application/json" },
        })
      }
      if (url.endsWith("/run-result")) {
        runResultCalls++
        const r = runResultBehavior()
        if (r === "throw") throw new Error(`run-result transport flake #${runResultCalls}`)
        return r
      }
      return new Response("not found", { status: 404 })
    })
    const stub = { fetch: fetchMock } as unknown as DurableObjectStub
    const idFromName = vi.fn(() => ({ name: "test" }) as unknown as DurableObjectId)
    const get = vi.fn(() => stub) as unknown as DurableObjectNamespace["get"]
    const env = {
      PR_REVIEW_RUN: { idFromName, get } as unknown as DurableObjectNamespace,
      OPENCLAW_PR_REVIEW_MODE: "post",
    } as unknown as Env
    void pickupCalls
    return { env, get runResultCalls() { return runResultCalls } } as { env: Env; runResultCalls: number }
  }

  it("succeeds on attempt 2 → no error log, /run-result called twice", async () => {
    let n = 0
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const harness = makeRetryEnv(() => {
      n++
      if (n === 1) return "throw"
      return new Response(JSON.stringify({ recorded: "state" }), {
        status: 200, headers: { "content-type": "application/json" },
      })
    })
    await runPrReviewWithDoCallback(makeJob(), harness.env, async () => {})
    expect(harness.runResultCalls).toBe(2)
    expect(errSpy).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("3 transport failures → 3 attempts then log + return (watchdog safety net)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const harness = makeRetryEnv(() => "throw")
    await runPrReviewWithDoCallback(makeJob(), harness.env, async () => {})
    expect(harness.runResultCalls).toBe(3)
    expect(errSpy).toHaveBeenCalled()
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n")
    expect(logged).toContain("do-review-consumer-run-result-failed")
    expect(logged).toContain('"attempts":3')
    errSpy.mockRestore()
  })

  it("3 non-OK responses → 3 attempts then log + return", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const harness = makeRetryEnv(() => new Response(JSON.stringify({ error: "boom" }), {
      status: 503, headers: { "content-type": "application/json" },
    }))
    await runPrReviewWithDoCallback(makeJob(), harness.env, async () => {})
    expect(harness.runResultCalls).toBe(3)
    expect(errSpy).toHaveBeenCalled()
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n")
    expect(logged).toContain("do-review-consumer-run-result-non-ok")
    expect(logged).toContain('"attempts":3')
    errSpy.mockRestore()
  })
})
