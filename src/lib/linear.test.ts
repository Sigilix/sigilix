// Severity → priority and estimate → points mappings. These are pure
// functions and the most likely place for a silent regression — if the
// table drifts, every triage starts writing wrong values to Linear.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import { estimateToPoints, severityToPriority, LinearClient, buildLinearAgentClient } from "@/src/lib/linear"
import { getValidAgentTokenViaBroker, __resetBrokerClientCacheForTests } from "@/src/lib/linear-token-broker-client"
import type { BrokerTokenResult } from "@/src/do/linear-token-broker"
import type { Env } from "@/src/shared/types/env"

describe("severityToPriority", () => {
  it.each([
    ["P0", 1], // Urgent
    ["P1", 2], // High
    ["P2", 3], // Normal
    ["P3", 4], // Low
  ])("%s → %i", (severity, expected) => {
    expect(severityToPriority(severity)).toBe(expected)
  })

  it("returns 0 (None) for unknown severities", () => {
    expect(severityToPriority("UNKNOWN")).toBe(0)
    expect(severityToPriority("")).toBe(0)
  })

  it("is case-insensitive", () => {
    expect(severityToPriority("p1")).toBe(2)
  })
})

describe("estimateToPoints", () => {
  it.each([
    ["trivial", 1],
    ["S", 2],
    ["M", 3],
    ["L", 5],
    ["XL", 8],
  ])("%s → %i points", (estimate, expected) => {
    expect(estimateToPoints(estimate)).toBe(expected)
  })

  it("returns undefined for unknown estimates (operator sizes by hand)", () => {
    expect(estimateToPoints("XXL")).toBeUndefined()
    expect(estimateToPoints("epic")).toBeUndefined()
    expect(estimateToPoints("")).toBeUndefined()
  })

  it("never auto-assigns 13 — that's a true epic the operator should size", () => {
    // 13 is intentionally absent from the mapping. Verify by checking that
    // no input produces 13.
    const allInputs = ["trivial", "S", "M", "L", "XL", "XXL", "epic", ""]
    for (const input of allInputs) {
      expect(estimateToPoints(input)).not.toBe(13)
    }
  })
})

// ─── LinearClient.createAgentActivity (Agents API) ──────────────────────────
describe("LinearClient.createAgentActivity", () => {
  let fetchSpy: MockInstance

  function mockGqlOk(data: unknown) {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } }),
      )
  }

  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("posts the agentActivityCreate mutation with a body-bearing content for a thought", async () => {
    mockGqlOk({ agentActivityCreate: { success: true } })
    const client = new LinearClient({ oauthToken: "agent-token-abc" })

    await client.createAgentActivity("session-1", "On it", "thought")

    const [endpoint, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(endpoint).toBe("https://api.linear.app/graphql")
    // Agent token goes through with the Bearer prefix.
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer agent-token-abc")
    const sent = JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> }
    expect(sent.query).toContain("agentActivityCreate")
    expect(sent.variables).toEqual({
      input: { agentSessionId: "session-1", content: { type: "thought", body: "On it" } },
    })
  })

  it("maps a response activity to content.body too", async () => {
    mockGqlOk({ agentActivityCreate: { success: true } })
    const client = new LinearClient({ oauthToken: "agent-token-abc" })

    await client.createAgentActivity("session-2", "Opened a PR", "response")

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const sent = JSON.parse(init.body as string) as { variables: { input: { content: unknown } } }
    expect(sent.variables.input.content).toEqual({ type: "response", body: "Opened a PR" })
  })

  it("maps an action activity to content.action", async () => {
    mockGqlOk({ agentActivityCreate: { success: true } })
    const client = new LinearClient({ oauthToken: "agent-token-abc" })

    await client.createAgentActivity("session-3", "ran the build", "action")

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const sent = JSON.parse(init.body as string) as { variables: { input: { content: unknown } } }
    expect(sent.variables.input.content).toEqual({ type: "action", action: "ran the build" })
  })

  it("throws when the mutation reports success=false", async () => {
    mockGqlOk({ agentActivityCreate: { success: false } })
    const client = new LinearClient({ oauthToken: "agent-token-abc" })
    await expect(client.createAgentActivity("session-4", "x", "thought")).rejects.toThrow(/success=false/)
  })

  it("forwards opts.signal to the underlying fetch (bounded ack)", async () => {
    mockGqlOk({ agentActivityCreate: { success: true } })
    const client = new LinearClient({ oauthToken: "agent-token-abc" })
    const signal = AbortSignal.timeout(2000)

    await client.createAgentActivity("session-5", "On it", "thought", { signal })

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(init.signal).toBe(signal)
  })
})

// ─── buildLinearAgentClient (SIG-144 slice 2: broker-backed) ────────────────
describe("buildLinearAgentClient", () => {
  // Minimal fake LINEAR_TOKEN_BROKER DO stub — mirrors repo-graph-client.test.ts /
  // provider-cooldown-client.test.ts: a hand-built namespace exposing only
  // idFromName/get, returning a stub whose getValidToken (and, for the SIG-144
  // slice 3 401-retry tests, forceRefresh) are the test's mocks. `forceRefresh`
  // defaults to a not-installed failure so existing one-arg callers are unaffected.
  function makeEnv(
    getValidToken: (args: { readOnly: boolean }) => Promise<BrokerTokenResult>,
    forceRefresh?: () => Promise<BrokerTokenResult>,
  ): Env {
    return {
      LINEAR_TOKEN_BROKER: {
        idFromName: (n: string) => ({ toString: () => n }),
        get: () => ({
          getValidToken,
          forceRefresh:
            forceRefresh ?? (async (): Promise<BrokerTokenResult> => ({ ok: false, reason: "not-installed" })),
        }),
      },
    } as unknown as Env
  }

  beforeEach(() => {
    // The broker client's isolate-level read cache is module-level (persists
    // across tests in this file) — reset it so one test's cached token can't
    // leak into the next.
    __resetBrokerClientCacheForTests()
    // The broker client logs a neutral breadcrumb on the no-token/RPC-error
    // paths — silence it here (asserted in linear-token-broker-client.test.ts).
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("returns a LinearClient when the broker reports a valid token", async () => {
    const env = makeEnv(async () => ({ ok: true, accessToken: "tok" }))
    const client = await buildLinearAgentClient(env)
    expect(client).toBeInstanceOf(LinearClient)
  })

  it("returns null when the broker reports not-installed", async () => {
    const env = makeEnv(async () => ({ ok: false, reason: "not-installed" }))
    const client = await buildLinearAgentClient(env)
    expect(client).toBeNull()
  })

  it("returns null (never throws) when the broker DO call itself throws", async () => {
    const env = makeEnv(async () => {
      throw new Error("DO unreachable")
    })
    await expect(buildLinearAgentClient(env)).resolves.toBeNull()
  })

  it("calls getValidToken with readOnly: true — this hot path must never trigger a refresh", async () => {
    let captured: { readOnly: boolean } | undefined
    const env = makeEnv(async (args) => {
      captured = args
      return { ok: true, accessToken: "tok" }
    })
    await buildLinearAgentClient(env)
    expect(captured).toEqual({ readOnly: true })
  })

  // ── SIG-144 slice 3: the broker-agent client's 401-retry wiring ──
  it("wires onUnauthorized to forceRefreshViaBroker: a 401 forces a broker refresh, rebuilds the header, retries once, and warms the isolate cache", async () => {
    let getValidTokenCalls = 0
    let forceRefreshCalls = 0
    const env = makeEnv(
      async () => {
        getValidTokenCalls++
        return { ok: true, accessToken: "stale-token" }
      },
      async () => {
        forceRefreshCalls++
        return { ok: true, accessToken: "fresh-token" }
      },
    )

    const client = await buildLinearAgentClient(env)
    expect(client).not.toBeNull()

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [{ message: "Unauthorized" }] }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { agentActivityCreate: { success: true } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )

    await client!.createAgentActivity("session-x", "On it", "thought")

    expect(forceRefreshCalls).toBe(1)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const [, secondInit] = fetchSpy.mock.calls[1] as [string, RequestInit]
    expect((secondInit.headers as Record<string, string>).authorization).toBe("Bearer fresh-token")

    // forceRefreshViaBroker (slice 2) already warms the isolate read cache with the
    // forced token — a subsequent readOnly broker read must be served from cache,
    // not re-hit the DO, and must reflect the NEW token, not the stale one.
    const callsBefore = getValidTokenCalls
    const again = await getValidAgentTokenViaBroker(env, { readOnly: true })
    expect(again).toBe("fresh-token")
    expect(getValidTokenCalls).toBe(callsBefore)
  })
})

// ─── LinearClient — 401-retry via the onUnauthorized hook (SIG-144 slice 3) ─
describe("LinearClient — 401-retry via onUnauthorized hook", () => {
  function response(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }

  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("401 once: calls onUnauthorized, rebuilds the Authorization header, retries once, and succeeds", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(401, { errors: [{ message: "Unauthorized" }] }))
      .mockResolvedValueOnce(response(200, { data: { agentActivityCreate: { success: true } } }))
    const onUnauthorized = vi.fn(async () => "fresh-token")
    const client = new LinearClient({ oauthToken: "stale-token" }, { onUnauthorized })

    await client.createAgentActivity("session-1", "On it", "thought")

    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const [, firstInit] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect((firstInit.headers as Record<string, string>).authorization).toBe("Bearer stale-token")
    const [, secondInit] = fetchSpy.mock.calls[1] as [string, RequestInit]
    expect((secondInit.headers as Record<string, string>).authorization).toBe("Bearer fresh-token")
  })

  it("401 twice: refreshes once, retries once, the retry still 401s → fails loudly, no loop (exactly one retry)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(401, { errors: [{ message: "Unauthorized" }] }))
      .mockResolvedValueOnce(response(401, { errors: [{ message: "Unauthorized" }] }))
    const onUnauthorized = vi.fn(async () => "fresh-token")
    const client = new LinearClient({ oauthToken: "stale-token" }, { onUnauthorized })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)

    await expect(client.createAgentActivity("session-2", "On it", "thought")).rejects.toThrow(/Linear HTTP 401/)

    expect(onUnauthorized).toHaveBeenCalledTimes(1) // never called again — no loop
    expect(fetchSpy).toHaveBeenCalledTimes(2) // exactly one retry attempt, not more
    const logged = errorSpy.mock.calls.flat().map(String).join("\n")
    expect(logged).toContain("linear-gql-401-retry-failed")
    expect(logged).not.toMatch(/fresh-token|stale-token/) // no token material
  })

  it("onUnauthorized returns null (broker forceRefresh failed): fails loudly with no second fetch call", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(401, { errors: [{ message: "Unauthorized" }] }))
    const onUnauthorized = vi.fn(async () => null)
    const client = new LinearClient({ oauthToken: "stale-token" }, { onUnauthorized })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)

    await expect(client.createAgentActivity("session-3", "On it", "thought")).rejects.toThrow(/Linear HTTP 401/)

    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledTimes(1) // no fresh token → no retry attempted
    const logged = errorSpy.mock.calls.flat().map(String).join("\n")
    expect(logged).toContain("linear-gql-401-refresh-failed")
    expect(logged).not.toContain("stale-token")
  })

  it("a non-401 error is unchanged: no refresh hook call, no retry, error propagates as before", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("internal error", { status: 500 }))
    const onUnauthorized = vi.fn(async () => "fresh-token")
    const client = new LinearClient({ oauthToken: "stale-token" }, { onUnauthorized })

    await expect(client.createAgentActivity("session-4", "On it", "thought")).rejects.toThrow(/Linear HTTP 500/)

    expect(onUnauthorized).not.toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("the client_credentials/human path (no onUnauthorized hook) gets NO retry on 401 — unchanged behavior", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(401, { errors: [{ message: "Unauthorized" }] }))
    // Matches buildLinearAuth's construction: `new LinearClient(auth)`, no options.
    const client = new LinearClient({ apiKey: "human-api-key" })

    await expect(client.createAgentActivity("session-5", "On it", "thought")).rejects.toThrow(/Linear HTTP 401/)

    expect(fetchSpy).toHaveBeenCalledTimes(1) // single attempt — no retry plumbing engaged
  })
})
