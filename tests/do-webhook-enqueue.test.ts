// ARC-190 Task 8 — webhook → DO enqueue helper tests.
//
// `enqueuePrReviewJob` gates on `OPENCLAW_PR_REVIEW_MODE`:
//   - off    → existing direct OPENCLAW_JOBS.send only
//   - shadow → DO /enqueue + existing direct send (DO is observation-only)
//   - post   → DO /enqueue only; webhook does NOT call OPENCLAW_JOBS.send
//              directly. The DO emits the queue message internally with
//              runId populated.
//
// On DO transport / non-OK response in post → caller gets {ok: false}
// and returns 503 (GitHub redelivers). In shadow → swallow + log;
// existing path keeps running.

import { describe, it, expect, vi } from "vitest"
import { enqueuePrReviewJob } from "../src/do/webhook-enqueue"
import type { Env } from "../src/index"
import type { EnqueueRequest, PrReviewMode } from "../src/do/types"

interface DoCall {
  url: string
  method: string
  body: unknown
}

interface MakeEnvArgs {
  mode?: PrReviewMode
  doResponse?:
    | { kind: "200"; body?: unknown }
    | { kind: "non-ok"; status: number }
    | { kind: "throw" }
}

function makeEnv(args: MakeEnvArgs = {}): {
  env: Env
  doCalls: DoCall[]
  queueSend: ReturnType<typeof vi.fn>
  idFromName: ReturnType<typeof vi.fn>
} {
  const doCalls: DoCall[] = []
  const fetchMock = vi.fn(async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url
    const method = (init?.method ?? "GET").toUpperCase()
    let body: unknown = undefined
    if (init?.body && typeof init.body === "string") {
      try {
        body = JSON.parse(init.body)
      } catch { body = init.body }
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
  const env = {
    PR_REVIEW_RUN: { idFromName, get } as unknown as DurableObjectNamespace,
    OPENCLAW_JOBS: { send: queueSend } as unknown as Queue<unknown>,
    OPENCLAW_PR_REVIEW_MODE: args.mode,
  } as unknown as Env
  return { env, doCalls, queueSend, idFromName }
}

const baseArgs = {
  owner: "Arc-and-Anchor",
  repo: "sigilix",
  prNumber: 7,
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  installationId: 99,
  deliveryId: "delivery-abc-123",
}

describe("enqueuePrReviewJob — mode=off (legacy path)", () => {
  it("calls OPENCLAW_JOBS.send only; no DO call", async () => {
    const { env, doCalls, queueSend, idFromName } = makeEnv({ mode: "off" })
    const result = await enqueuePrReviewJob(env, baseArgs)
    expect(result).toEqual({ ok: true, mode: "off" })
    expect(doCalls).toHaveLength(0)
    expect(idFromName).not.toHaveBeenCalled()
    expect(queueSend).toHaveBeenCalledOnce()
    const sent = queueSend.mock.calls[0]?.[0] as { type: string; runId?: unknown }
    expect(sent.type).toBe("pr-review")
    // Off-mode messages MUST NOT carry a runId.
    expect(sent.runId).toBeUndefined()
  })

  it("treats absent OPENCLAW_PR_REVIEW_MODE as off", async () => {
    const { env, doCalls, queueSend } = makeEnv({})
    const result = await enqueuePrReviewJob(env, baseArgs)
    expect(result.ok).toBe(true)
    expect(result.mode).toBe("off")
    expect(doCalls).toHaveLength(0)
    expect(queueSend).toHaveBeenCalledOnce()
  })
})

describe("enqueuePrReviewJob — mode=shadow", () => {
  it("calls BOTH DO /enqueue and OPENCLAW_JOBS.send", async () => {
    const { env, doCalls, queueSend } = makeEnv({ mode: "shadow" })
    const result = await enqueuePrReviewJob(env, baseArgs)
    expect(result).toEqual({ ok: true, mode: "shadow" })
    expect(doCalls).toHaveLength(1)
    expect(doCalls[0]?.url).toContain("/enqueue")
    expect((doCalls[0]?.body as EnqueueRequest).mode).toBe("shadow")
    expect((doCalls[0]?.body as EnqueueRequest).deliveryId).toBe("delivery-abc-123")
    expect(queueSend).toHaveBeenCalledOnce()
    const sent = queueSend.mock.calls[0]?.[0] as { runId?: unknown }
    // Shadow-mode existing-path send MUST NOT carry runId; the DO does
    // not enqueue a queue message in shadow.
    expect(sent.runId).toBeUndefined()
  })

  it("DO transport throw → continue, log, existing-path still runs, return ok", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { env, queueSend } = makeEnv({ mode: "shadow", doResponse: { kind: "throw" } })
    const result = await enqueuePrReviewJob(env, baseArgs)
    expect(result.ok).toBe(true)
    expect(queueSend).toHaveBeenCalledOnce()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("DO 5xx → continue, log, existing-path still runs, return ok", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { env, queueSend } = makeEnv({ mode: "shadow", doResponse: { kind: "non-ok", status: 503 } })
    const result = await enqueuePrReviewJob(env, baseArgs)
    expect(result.ok).toBe(true)
    expect(queueSend).toHaveBeenCalledOnce()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("idFromName / get throw → existing-path still runs, return ok (Codex MAJOR T8 v1)", async () => {
    // Spec §4.4 invariant 5: shadow-mode DO failures must NEVER reject
    // the GitHub webhook. A misbound binding or any thrown error in
    // stub acquisition has to fall through to the legacy send below.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const idFromName = vi.fn(() => {
      throw new Error("PR_REVIEW_RUN binding misconfigured")
    })
    const get = vi.fn(() => ({}) as DurableObjectStub)
    const queueSend = vi.fn(async (_message: unknown) => {})
    const env = {
      PR_REVIEW_RUN: { idFromName, get } as unknown as DurableObjectNamespace,
      OPENCLAW_JOBS: { send: queueSend } as unknown as Queue<unknown>,
      OPENCLAW_PR_REVIEW_MODE: "shadow",
    } as unknown as Env
    const result = await enqueuePrReviewJob(env, baseArgs)
    expect(result.ok).toBe(true)
    expect(queueSend).toHaveBeenCalledOnce()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe("enqueuePrReviewJob — post-mode idFromName / get throws → 503", () => {
  it("idFromName throw in post mode returns {ok: false, reason: 'do-transport'}", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const idFromName = vi.fn(() => {
      throw new Error("PR_REVIEW_RUN binding misconfigured")
    })
    const get = vi.fn(() => ({}) as DurableObjectStub)
    const queueSend = vi.fn(async (_message: unknown) => {})
    const env = {
      PR_REVIEW_RUN: { idFromName, get } as unknown as DurableObjectNamespace,
      OPENCLAW_JOBS: { send: queueSend } as unknown as Queue<unknown>,
      OPENCLAW_PR_REVIEW_MODE: "post",
    } as unknown as Env
    const result = await enqueuePrReviewJob(env, baseArgs)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.mode).toBe("post")
      expect(result.reason).toBe("do-transport")
    }
    expect(queueSend).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe("enqueuePrReviewJob — mode=post", () => {
  it("calls DO /enqueue only; webhook does NOT call OPENCLAW_JOBS.send", async () => {
    // Codex MAJOR on plan v1: explicit assertion that post-mode webhook
    // never touches OPENCLAW_JOBS directly. The DO owns the queue
    // dispatch with runId populated.
    const { env, doCalls, queueSend } = makeEnv({ mode: "post" })
    const result = await enqueuePrReviewJob(env, baseArgs)
    expect(result).toEqual({ ok: true, mode: "post" })
    expect(doCalls).toHaveLength(1)
    expect(doCalls[0]?.url).toContain("/enqueue")
    expect((doCalls[0]?.body as EnqueueRequest).mode).toBe("post")
    expect(queueSend).not.toHaveBeenCalled()
  })

  it("DO transport throw → {ok: false, mode: 'post'}", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { env, queueSend } = makeEnv({ mode: "post", doResponse: { kind: "throw" } })
    const result = await enqueuePrReviewJob(env, baseArgs)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.mode).toBe("post")
      expect(result.reason).toBe("do-transport")
    }
    expect(queueSend).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("DO 4xx → {ok: false, reason: 'do-status'}", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { env, queueSend } = makeEnv({ mode: "post", doResponse: { kind: "non-ok", status: 400 } })
    const result = await enqueuePrReviewJob(env, baseArgs)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("do-status")
      expect(result.status).toBe(400)
    }
    expect(queueSend).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("DO 5xx → {ok: false, reason: 'do-status'}", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { env, queueSend } = makeEnv({ mode: "post", doResponse: { kind: "non-ok", status: 503 } })
    const result = await enqueuePrReviewJob(env, baseArgs)
    expect(result.ok).toBe(false)
    expect(queueSend).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe("enqueuePrReviewJob — DO request payload", () => {
  it("includes owner/repo/prNumber/headSha/baseSha/installationId/deliveryId/mode", async () => {
    const { env, doCalls } = makeEnv({ mode: "post" })
    await enqueuePrReviewJob(env, baseArgs)
    const body = doCalls[0]?.body as EnqueueRequest
    expect(body).toEqual({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 7,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      installationId: 99,
      deliveryId: "delivery-abc-123",
      mode: "post",
    })
  })

  it("propagates null baseSha (e.g., a missing base.sha)", async () => {
    const { env, doCalls } = makeEnv({ mode: "post" })
    await enqueuePrReviewJob(env, { ...baseArgs, baseSha: null })
    expect((doCalls[0]?.body as EnqueueRequest).baseSha).toBeNull()
  })

  it("propagates null deliveryId (header missing)", async () => {
    const { env, doCalls } = makeEnv({ mode: "post" })
    await enqueuePrReviewJob(env, { ...baseArgs, deliveryId: null })
    expect((doCalls[0]?.body as EnqueueRequest).deliveryId).toBeNull()
  })

  it("uses ${owner}/${repo}#${prNumber} as DO instance name", async () => {
    const { env, idFromName } = makeEnv({ mode: "post" })
    await enqueuePrReviewJob(env, baseArgs)
    expect(idFromName).toHaveBeenCalledWith("Arc-and-Anchor/sigilix#7")
  })
})
