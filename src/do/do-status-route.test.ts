// ARC-190 Task 4 — public status route tests.

import { describe, it, expect, vi } from "vitest"
import { handleReviewStatusRoute } from "@/src/do/status-route"
import type { Env } from "@/src/shared/types/env"
import type { StatusResponse } from "@/src/do/types"

interface DoStubArgs {
  response: StatusResponse | "throw"
  expectedName?: string
}

function makeEnv(args: DoStubArgs): Env {
  const fetchMock = vi.fn(async (_req: Request) => {
    if (args.response === "throw") {
      throw new Error("DO transport failed")
    }
    return new Response(JSON.stringify(args.response), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })
  const stub = { fetch: fetchMock }
  const idFromName = vi.fn((name: string) => {
    if (args.expectedName) {
      expect(name).toBe(args.expectedName)
    }
    return { name } as unknown as DurableObjectId
  })
  const get = vi.fn(() => stub) as unknown as DurableObjectNamespace["get"]
  return {
    PR_REVIEW_RUN: { idFromName, get } as unknown as DurableObjectNamespace,
  } as unknown as Env
}

describe("handleReviewStatusRoute — happy path", () => {
  it("200 with full found JSON when DO returns kind=found", async () => {
    const found: StatusResponse = {
      kind: "found",
      current: {
        runId: "11111111-1111-4111-8111-111111111111",
        headSha: "a".repeat(40),
        state: "running",
        attempts: 1,
        startedAt: "2026-05-07T06:00:00.000Z",
        pickedUpAt: "2026-05-07T06:00:05.000Z",
      },
      history: [],
    }
    const env = makeEnv({ response: found, expectedName: "Sigilix/sigilix#7" })
    const res = await handleReviewStatusRoute(env, "Sigilix", "sigilix", 7)
    expect(res.status).toBe(200)
    const body = (await res.json()) as StatusResponse
    expect(body).toEqual(found)
  })
})

describe("handleReviewStatusRoute — 404 paths", () => {
  it("404 when DO returns kind=no-state", async () => {
    const env = makeEnv({ response: { kind: "no-state" } })
    const res = await handleReviewStatusRoute(env, "Sigilix", "sigilix", 7)
    expect(res.status).toBe(404)
  })
})

describe("handleReviewStatusRoute — input validation (400)", () => {
  it("400 on empty owner", async () => {
    const env = makeEnv({ response: { kind: "no-state" } })
    const res = await handleReviewStatusRoute(env, "", "sigilix", 7)
    expect(res.status).toBe(400)
  })

  it("400 on empty repo", async () => {
    const env = makeEnv({ response: { kind: "no-state" } })
    const res = await handleReviewStatusRoute(env, "Sigilix", "", 7)
    expect(res.status).toBe(400)
  })

  it("400 on slash-containing owner", async () => {
    const env = makeEnv({ response: { kind: "no-state" } })
    const res = await handleReviewStatusRoute(env, "evil/path", "sigilix", 7)
    expect(res.status).toBe(400)
  })

  it("400 on slash-containing repo (decoded)", async () => {
    const env = makeEnv({ response: { kind: "no-state" } })
    // Caller passes URL-decoded path segments; if a real route
    // handler decoded `%2F` and the result contains a slash, reject.
    const res = await handleReviewStatusRoute(env, "Sigilix", "a/b", 7)
    expect(res.status).toBe(400)
  })

  it("400 on non-positive prNumber (0)", async () => {
    const env = makeEnv({ response: { kind: "no-state" } })
    const res = await handleReviewStatusRoute(env, "Sigilix", "sigilix", 0)
    expect(res.status).toBe(400)
  })

  it("400 on negative prNumber", async () => {
    const env = makeEnv({ response: { kind: "no-state" } })
    const res = await handleReviewStatusRoute(env, "Sigilix", "sigilix", -3)
    expect(res.status).toBe(400)
  })

  it("400 on non-integer prNumber", async () => {
    const env = makeEnv({ response: { kind: "no-state" } })
    const res = await handleReviewStatusRoute(env, "Sigilix", "sigilix", 1.5)
    expect(res.status).toBe(400)
  })
})

describe("handleReviewStatusRoute — DO transport failure", () => {
  it("503 when DO fetch throws", async () => {
    const env = makeEnv({ response: "throw" })
    const res = await handleReviewStatusRoute(env, "Sigilix", "sigilix", 7)
    expect(res.status).toBe(503)
  })

  it("503 when DO returns non-2xx", async () => {
    const fetchMock = vi.fn(
      async () => new Response("oops", { status: 500 }),
    )
    const stub = { fetch: fetchMock }
    const env = {
      PR_REVIEW_RUN: {
        idFromName: () => ({ name: "x" }),
        get: () => stub,
      },
    } as unknown as Env
    const res = await handleReviewStatusRoute(env, "Sigilix", "sigilix", 7)
    expect(res.status).toBe(503)
  })
})

describe("handleReviewStatusRoute — DO instance ID", () => {
  it("instance ID is `${owner}/${repo}#${prNumber}`", async () => {
    const env = makeEnv({
      response: { kind: "no-state" },
      expectedName: "Sigilix/sigilix#42",
    })
    await handleReviewStatusRoute(env, "Sigilix", "sigilix", 42)
  })
})

describe("handleReviewStatusRoute — response-shape validation (CR PR #70)", () => {
  // CodeRabbit MAJOR on PR #70: previously the route trusted any
  // parsed JSON as a StatusResponse, so a malformed payload could
  // bubble out as 200. Now: validate via type-narrowing predicate;
  // return 503 for shapes that don't match the spec.
  function makeMalformedEnv(payload: unknown): Env {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200, headers: { "content-type": "application/json" },
    }))
    const stub = { fetch: fetchMock }
    return {
      PR_REVIEW_RUN: {
        idFromName: () => ({ name: "x" }),
        get: () => stub,
      },
    } as unknown as Env
  }

  it("503 when DO returns kind=found without current", async () => {
    const env = makeMalformedEnv({ kind: "found", history: [] })
    const res = await handleReviewStatusRoute(env, "Sigilix", "sigilix", 7)
    expect(res.status).toBe(503)
  })

  it("503 when DO returns kind=found with malformed current", async () => {
    const env = makeMalformedEnv({ kind: "found", current: "not-an-object", history: [] })
    const res = await handleReviewStatusRoute(env, "Sigilix", "sigilix", 7)
    expect(res.status).toBe(503)
  })

  it("503 when DO returns kind=found without history", async () => {
    const env = makeMalformedEnv({
      kind: "found",
      current: { runId: "r", headSha: "a".repeat(40), state: "queued", attempts: 1, startedAt: "x" },
    })
    const res = await handleReviewStatusRoute(env, "Sigilix", "sigilix", 7)
    expect(res.status).toBe(503)
  })

  it("503 when DO returns kind=garbage", async () => {
    const env = makeMalformedEnv({ kind: "garbage" })
    const res = await handleReviewStatusRoute(env, "Sigilix", "sigilix", 7)
    expect(res.status).toBe(503)
  })

  it("503 when DO returns null", async () => {
    const env = makeMalformedEnv(null)
    const res = await handleReviewStatusRoute(env, "Sigilix", "sigilix", 7)
    expect(res.status).toBe(503)
  })

  it("503 when current.state is not a RunStateLifecycle literal", async () => {
    const env = makeMalformedEnv({
      kind: "found",
      current: {
        runId: "r", headSha: "a".repeat(40),
        state: "bogus-state-label",
        attempts: 1, startedAt: "2026-05-07T06:00:00.000Z",
      },
      history: [],
    })
    const res = await handleReviewStatusRoute(env, "Sigilix", "sigilix", 7)
    expect(res.status).toBe(503)
  })

  it("transport-error response body does NOT leak the underlying error message", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("internal-secret-leak: kv://node-3-internal") })
    const stub = { fetch: fetchMock }
    const env = {
      PR_REVIEW_RUN: {
        idFromName: () => ({ name: "x" }),
        get: () => stub,
      },
    } as unknown as Env
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const res = await handleReviewStatusRoute(env, "Sigilix", "sigilix", 7)
    expect(res.status).toBe(503)
    const body = await res.text()
    expect(body).not.toContain("internal-secret-leak")
    expect(body).not.toContain("kv://node-3-internal")
    // The detail does land in server-side logs.
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe("handleReviewStatusRoute — state shapes", () => {
  for (const stateLabel of [
    "idle", "queued", "running", "done", "failed-transient", "failed",
  ] as const) {
    it(`returns 200 with state=${stateLabel}`, async () => {
      const env = makeEnv({
        response: {
          kind: "found",
          current: {
            runId: "r",
            headSha: "a".repeat(40),
            state: stateLabel,
            attempts: 1,
            startedAt: "2026-05-07T06:00:00.000Z",
          },
          history: [],
        },
      })
      const res = await handleReviewStatusRoute(env, "Sigilix", "sigilix", 7)
      expect(res.status).toBe(200)
      const body = (await res.json()) as StatusResponse
      if (body.kind !== "found") throw new Error("expected found")
      expect(body.current.state).toBe(stateLabel)
    })
  }
})
