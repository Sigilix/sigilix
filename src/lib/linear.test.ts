// Severity → priority and estimate → points mappings. These are pure
// functions and the most likely place for a silent regression — if the
// table drifts, every triage starts writing wrong values to Linear.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import { estimateToPoints, severityToPriority, LinearClient, buildLinearAgentClient } from "@/src/lib/linear"
import { LINEAR_AGENT_TOKEN_KEY } from "@/src/lib/linear-agent-oauth"
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

// ─── buildLinearAgentClient ─────────────────────────────────────────────────
describe("buildLinearAgentClient", () => {
  function makeKv(seed?: Record<string, string>) {
    const store = new Map<string, string>(Object.entries(seed ?? {}))
    return { get: vi.fn(async (k: string) => store.get(k) ?? null) }
  }
  function makeEnv(kv: ReturnType<typeof makeKv>): Pick<Env, "OPENCLAW_STATE"> {
    return { OPENCLAW_STATE: kv as unknown as KVNamespace }
  }

  it("returns a LinearClient when an agent token is stored", async () => {
    const env = makeEnv(makeKv({ [LINEAR_AGENT_TOKEN_KEY]: JSON.stringify({ accessToken: "tok", installedAt: 1 }) }))
    const client = await buildLinearAgentClient(env)
    expect(client).toBeInstanceOf(LinearClient)
  })

  it("returns null when no agent token is installed", async () => {
    const client = await buildLinearAgentClient(makeEnv(makeKv()))
    expect(client).toBeNull()
  })
})
