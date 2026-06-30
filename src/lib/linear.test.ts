// Severity → priority and estimate → points mappings. These are pure
// functions and the most likely place for a silent regression — if the
// table drifts, every triage starts writing wrong values to Linear.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import { estimateToPoints, severityToPriority, LinearClient, buildLinearAgentClient } from "@/src/lib/linear"
import { __resetBrokerClientCacheForTests } from "@/src/lib/linear-token-broker-client"
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
  // idFromName/get, returning a stub whose getValidToken is the test's mock.
  function makeEnv(getValidToken: (args: { readOnly: boolean }) => Promise<BrokerTokenResult>): Env {
    return {
      LINEAR_TOKEN_BROKER: {
        idFromName: (n: string) => ({ toString: () => n }),
        get: () => ({ getValidToken }),
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
})
