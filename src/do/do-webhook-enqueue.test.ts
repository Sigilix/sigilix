// ARC-190 Task 8 + SIG-174 — webhook → DO enqueue helper tests.
//
// Automatic PR-review webhooks now always route through the
// authoritative DO. The helper never sends directly to OPENCLAW_JOBS;
// the DO owns queue dispatch with runId populated.

import { describe, it, expect, vi } from "vitest"
import { enqueuePrReviewJob } from "@/src/do/webhook-enqueue"
import type { Env } from "@/src/shared/types/env"
import type { EnqueueRequest } from "@/src/do/types"

interface DoCall {
  url: string
  method: string
  body: unknown
}

interface MakeEnvArgs {
  doResponse?: { kind: "200"; body?: unknown } | { kind: "non-ok"; status: number } | { kind: "throw" }
  /**
   * SIG-98: pre-seeded KV state for the pause/ignore gate. Any key
   * present here will be returned by `OPENCLAW_STATE.get`; unset keys
   * return null.
   */
  kvState?: Record<string, string>
  /** SIG-343: optional platform DB binding for lazy tenant+repo registration tests. */
  platformDb?: D1Database
}

function makeEnv(args: MakeEnvArgs = {}): {
  env: Env
  doCalls: DoCall[]
  queueSend: ReturnType<typeof vi.fn>
  idFromName: ReturnType<typeof vi.fn>
  kv: Map<string, string>
} {
  const doCalls: DoCall[] = []
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
    doCalls.push({ url, method, body })
    const r = args.doResponse ?? { kind: "200" as const }
    if (r.kind === "throw") throw new Error("DO transport failed")
    if (r.kind === "non-ok") {
      return new Response(JSON.stringify({ error: "boom" }), {
        status: r.status,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response(JSON.stringify(r.body ?? { deduped: false, runId: "rid", action: "create" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })
  const stub = { fetch: fetchMock } as unknown as DurableObjectStub
  const idFromName = vi.fn((name: string) => ({ name }) as unknown as DurableObjectId)
  const get = vi.fn(() => stub) as unknown as DurableObjectNamespace["get"]
  const queueSend = vi.fn(async (_message: unknown) => {})
  const kv = new Map<string, string>(Object.entries(args.kvState ?? {}))
  const env = {
    PR_REVIEW_RUN: { idFromName, get } as unknown as DurableObjectNamespace,
    OPENCLAW_JOBS: { send: queueSend } as unknown as Queue<unknown>,
    OPENCLAW_STATE: {
      get: async (key: string): Promise<string | null> => kv.get(key) ?? null,
      put: async (key: string, value: string) => {
        kv.set(key, value)
      },
      delete: async (key: string) => {
        kv.delete(key)
      },
    } as unknown as KVNamespace,
    ...(args.platformDb !== undefined ? { SIGILIX_PLATFORM_DB: args.platformDb } : {}),
  } as unknown as Env
  return { env, doCalls, queueSend, idFromName, kv }
}

const baseArgs = {
  owner: "Sigilix",
  repo: "sigilix",
  prNumber: 7,
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  installationId: 99,
  deliveryId: "delivery-abc-123",
}

describe("enqueuePrReviewJob — authoritative DO path", () => {
  it("calls DO /enqueue only; webhook does not call OPENCLAW_JOBS.send", async () => {
    const { env, doCalls, queueSend } = makeEnv()
    const result = await enqueuePrReviewJob(env, baseArgs)
    expect(result).toEqual({ ok: true, route: "do" })
    expect(doCalls).toHaveLength(1)
    expect(doCalls[0]?.url).toContain("/enqueue")
    expect(queueSend).not.toHaveBeenCalled()
  })

  it("DO transport throw returns a redeliverable failure", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { env, queueSend } = makeEnv({ doResponse: { kind: "throw" } })
    const result = await enqueuePrReviewJob(env, baseArgs)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.route).toBe("do")
      expect(result.reason).toBe("do-transport")
    }
    expect(queueSend).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("DO non-OK returns a redeliverable status failure", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { env, queueSend } = makeEnv({ doResponse: { kind: "non-ok", status: 503 } })
    const result = await enqueuePrReviewJob(env, baseArgs)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.route).toBe("do")
      expect(result.reason).toBe("do-status")
      expect(result.status).toBe(503)
    }
    expect(queueSend).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("idFromName throw returns do-transport", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const idFromName = vi.fn(() => {
      throw new Error("PR_REVIEW_RUN binding misconfigured")
    })
    const get = vi.fn(() => ({}) as DurableObjectStub)
    const queueSend = vi.fn(async (_message: unknown) => {})
    const env = {
      PR_REVIEW_RUN: { idFromName, get } as unknown as DurableObjectNamespace,
      OPENCLAW_JOBS: { send: queueSend } as unknown as Queue<unknown>,
      OPENCLAW_STATE: {
        get: async (): Promise<string | null> => null,
        put: async () => {},
        delete: async () => {},
      } as unknown as KVNamespace,
    } as unknown as Env
    const result = await enqueuePrReviewJob(env, baseArgs)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.route).toBe("do")
      expect(result.reason).toBe("do-transport")
    }
    expect(queueSend).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("get throw returns do-transport", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const idFromName = vi.fn(() => ({ name: "Sigilix/sigilix#7" }) as unknown as DurableObjectId)
    const get = vi.fn(() => {
      throw new Error("PR_REVIEW_RUN get misconfigured")
    })
    const queueSend = vi.fn(async (_message: unknown) => {})
    const env = {
      PR_REVIEW_RUN: { idFromName, get } as unknown as DurableObjectNamespace,
      OPENCLAW_JOBS: { send: queueSend } as unknown as Queue<unknown>,
      OPENCLAW_STATE: {
        get: async (): Promise<string | null> => null,
        put: async () => {},
        delete: async () => {},
      } as unknown as KVNamespace,
    } as unknown as Env
    const result = await enqueuePrReviewJob(env, baseArgs)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.route).toBe("do")
      expect(result.reason).toBe("do-transport")
    }
    expect(idFromName).toHaveBeenCalledOnce()
    expect(get).toHaveBeenCalledOnce()
    expect(queueSend).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe("enqueuePrReviewJob — DO request payload", () => {
  it("includes owner/repo/prNumber/headSha/baseSha/installationId/deliveryId", async () => {
    const { env, doCalls } = makeEnv()
    await enqueuePrReviewJob(env, baseArgs)
    const body = doCalls[0]?.body as EnqueueRequest
    expect(body).toEqual({
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 7,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      installationId: 99,
      deliveryId: "delivery-abc-123",
    })
  })

  it("propagates null baseSha and deliveryId", async () => {
    const { env, doCalls } = makeEnv()
    await enqueuePrReviewJob(env, { ...baseArgs, baseSha: null, deliveryId: null })
    const body = doCalls[0]?.body as EnqueueRequest
    expect(body.baseSha).toBeNull()
    expect(body.deliveryId).toBeNull()
  })

  it("uses ${owner}/${repo}#${prNumber} as DO instance name", async () => {
    const { env, idFromName } = makeEnv()
    await enqueuePrReviewJob(env, baseArgs)
    expect(idFromName).toHaveBeenCalledWith("Sigilix/sigilix#7")
  })
})

describe("enqueuePrReviewJob — SIG-98 pause/ignore gate", () => {
  it("returns skipped-paused when pr-paused KV flag is set; no DO call, no queue send", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const { env, doCalls, queueSend, idFromName } = makeEnv({
      kvState: { "pr-paused:Sigilix/sigilix#7": "1700000000000" },
    })
    const result = await enqueuePrReviewJob(env, baseArgs)
    expect(result).toEqual({ ok: true, route: "skipped-paused" })
    expect(doCalls).toHaveLength(0)
    expect(queueSend).not.toHaveBeenCalled()
    expect(idFromName).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it("returns skipped-ignored when pr-ignored KV flag is set", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const { env, doCalls, queueSend } = makeEnv({
      kvState: { "pr-ignored:Sigilix/sigilix#7": "1700000000000" },
    })
    const result = await enqueuePrReviewJob(env, baseArgs)
    expect(result).toEqual({ ok: true, route: "skipped-ignored" })
    expect(doCalls).toHaveLength(0)
    expect(queueSend).not.toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it("ignore wins over pause when both flags are present", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const { env, doCalls, queueSend, idFromName } = makeEnv({
      kvState: {
        "pr-paused:Sigilix/sigilix#7": "1700000000000",
        "pr-ignored:Sigilix/sigilix#7": "1700000000000",
      },
    })
    const result = await enqueuePrReviewJob(env, baseArgs)
    expect(result.ok).toBe(true)
    expect(result.route).toBe("skipped-ignored")
    expect(doCalls).toHaveLength(0)
    expect(idFromName).not.toHaveBeenCalled()
    expect(queueSend).not.toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it("falls through to DO enqueue when neither flag is set", async () => {
    const { env, doCalls, queueSend } = makeEnv()
    const result = await enqueuePrReviewJob(env, baseArgs)
    expect(result).toEqual({ ok: true, route: "do" })
    expect(doCalls).toHaveLength(1)
    expect(queueSend).not.toHaveBeenCalled()
  })
})

// SIG-343 — helper to build a minimal D1 spy for platform-DB tests.
function makeD1Spy(opts: { batchRejects?: boolean } = {}): {
  db: D1Database
  batchMock: ReturnType<typeof vi.fn>
  bindMock: ReturnType<typeof vi.fn>
} {
  const batchMock = opts.batchRejects
    ? vi.fn().mockRejectedValue(new Error("D1 unavailable"))
    : vi.fn().mockResolvedValue([])
  const bindMock = vi.fn(() => ({}))
  const prepareMock = vi.fn(() => ({ bind: bindMock }))
  return {
    db: { prepare: prepareMock, batch: batchMock } as unknown as D1Database,
    batchMock,
    bindMock,
  }
}

describe("enqueuePrReviewJob — SIG-343 lazy tenant+repo registration", () => {
  it("calls upsertTenantAndRepo with correct args when repoId is provided; enqueue proceeds", async () => {
    const { db, batchMock, bindMock } = makeD1Spy()
    const { env, doCalls } = makeEnv({ platformDb: db })
    const result = await enqueuePrReviewJob(env, { ...baseArgs, repoId: 42 })
    expect(result).toEqual({ ok: true, route: "do" })
    expect(doCalls).toHaveLength(1)
    expect(batchMock).toHaveBeenCalledOnce()
    // tenant bind: (installationId, accountLogin, accountType, created_at, updated_at)
    expect(bindMock).toHaveBeenCalledWith(99, null, null, expect.any(String), expect.any(String))
    // repo bind: (repoId, installationId, fullName, updated_at)
    expect(bindMock).toHaveBeenCalledWith(42, 99, "Sigilix/sigilix", expect.any(String))
  })

  it("skips upsertTenantAndRepo when repoId is undefined; enqueue unaffected", async () => {
    const { db, batchMock } = makeD1Spy()
    const { env, doCalls } = makeEnv({ platformDb: db })
    const result = await enqueuePrReviewJob(env, baseArgs) // no repoId
    expect(result).toEqual({ ok: true, route: "do" })
    expect(doCalls).toHaveLength(1)
    expect(batchMock).not.toHaveBeenCalled()
  })

  it("returns enqueue result unchanged when D1 batch throws (fail-open)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { db, batchMock } = makeD1Spy({ batchRejects: true })
    const { env, doCalls } = makeEnv({ platformDb: db })
    const result = await enqueuePrReviewJob(env, { ...baseArgs, repoId: 42 })
    expect(result).toEqual({ ok: true, route: "do" })
    expect(doCalls).toHaveLength(1)
    expect(batchMock).toHaveBeenCalledOnce()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
