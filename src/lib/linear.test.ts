// Severity → priority and estimate → points mappings. These are pure
// functions and the most likely place for a silent regression — if the
// table drifts, every triage starts writing wrong values to Linear.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import {
  estimateToPoints,
  severityToPriority,
  LinearClient,
  buildLinearAgentClient,
  buildLinearAuth,
  buildLinearClient,
  resolveLinearUnifiedMode,
  type LinearAuthEnv,
} from "@/src/lib/linear"
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
    getValidToken: (args: {
      organizationId?: string
      installationId?: number
      readOnly: boolean
    }) => Promise<BrokerTokenResult>,
    forceRefresh?: () => Promise<BrokerTokenResult>,
  ): Env {
    return {
      LINEAR_TOKEN_BROKER: {
        idFromName: (n: string) => ({ toString: () => n }),
        get: () => ({
          getValidTenantToken: getValidToken,
          forceRefreshTenant:
            forceRefresh ?? (async (): Promise<BrokerTokenResult> => ({ ok: false, reason: "not-installed" })),
        }),
      },
      OPENCLAW_LINEAR_ALLOWED_ORG_ID: "org-test",
      OPENCLAW_LINEAR_LEGACY_INSTALLATION_ID: "42",
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

  it("calls the explicitly configured dogfood tenant shard with readOnly: true", async () => {
    let captured: { organizationId?: string; installationId?: number; readOnly: boolean } | undefined
    const env = makeEnv(async (args) => {
      captured = args
      return { ok: true, accessToken: "tok" }
    })
    await buildLinearAgentClient(env)
    expect(captured).toEqual({ organizationId: "org-test", installationId: 42, readOnly: true })
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
    const again = await getValidAgentTokenViaBroker(
      env,
      { organizationId: "org-test", installationId: 42 },
      { readOnly: true },
    )
    expect(again).toBe("fresh-token")
    expect(getValidTokenCalls).toBe(callsBefore)
  })

  // ── SIG-145: allowRefresh:false (the webhook ACK hot path) ──
  it("allowRefresh:false → still reads readOnly, but a 401 does NOT force a broker refresh or retry (the ACK must stay bounded)", async () => {
    let forceRefreshCalls = 0
    let captured: { organizationId?: string; installationId?: number; readOnly: boolean } | undefined
    const env = makeEnv(
      async (args) => {
        captured = args
        return { ok: true, accessToken: "stale-token" }
      },
      async () => {
        forceRefreshCalls++
        return { ok: true, accessToken: "fresh-token" }
      },
    )

    const client = await buildLinearAgentClient(env, { allowRefresh: false })
    expect(client).not.toBeNull()
    // The token READ is still the cached readOnly path (one DO read, never a refresh POST).
    expect(captured).toEqual({ organizationId: "org-test", installationId: 42, readOnly: true })

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ message: "Unauthorized" }] }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    )

    // A 401 surfaces (no onUnauthorized hook) — NOT a blocking forceRefresh that could
    // overrun Linear's ~10s ack window. Exactly ONE fetch, ZERO broker refreshes.
    await expect(client!.createAgentActivity("session-x", "On it", "thought")).rejects.toThrow()
    expect(forceRefreshCalls).toBe(0)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
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

// ─── SIG-144 slice 4: resolveLinearUnifiedMode + buildLinearAuth flag gate ──
describe("resolveLinearUnifiedMode", () => {
  it("unset → off", () => {
    expect(resolveLinearUnifiedMode({})).toBe("off")
  })

  it.each([
    ["off", "off"],
    ["ON", "off"],
    [" on", "off"],
    ["on ", "off"],
    ["unknown", "off"],
    ["", "off"],
    ["on", "on"],
  ])("OPENCLAW_LINEAR_UNIFIED=%j → %s", (raw, expected) => {
    expect(resolveLinearUnifiedMode({ OPENCLAW_LINEAR_UNIFIED: raw })).toBe(expected)
  })
})

/** Minimal LinearAuthEnv with a fake LINEAR_TOKEN_BROKER DO stub — mirrors the
 *  buildLinearAgentClient `makeEnv` helper above. `forceRefresh` defaults to a
 *  not-installed failure so a test that never exercises the 401-retry path
 *  doesn't need to supply one. */
function makeUnifiedAuthEnv(
  getValidToken: (args: { readOnly: boolean }) => Promise<BrokerTokenResult>,
  opts?: { forceRefresh?: () => Promise<BrokerTokenResult>; extra?: Partial<LinearAuthEnv> },
): LinearAuthEnv {
  return {
    LINEAR_API_KEY: "human-key-must-never-be-used",
    OPENCLAW_LINEAR_UNIFIED: "on",
    LINEAR_TOKEN_BROKER: {
      idFromName: (n: string) => ({ toString: () => n }),
      get: () => ({
        getValidToken,
        getValidTenantToken: getValidToken,
        forceRefresh:
          opts?.forceRefresh ?? (async (): Promise<BrokerTokenResult> => ({ ok: false, reason: "not-installed" })),
        forceRefreshTenant:
          opts?.forceRefresh ?? (async (): Promise<BrokerTokenResult> => ({ ok: false, reason: "not-installed" })),
      }),
    },
    ...opts?.extra,
  } as unknown as LinearAuthEnv
}

const LINEAR_TENANT = { organizationId: "org-test", installationId: 42 }

describe("buildLinearAuth — SIG-144 slice 4 flag gate", () => {
  beforeEach(() => {
    __resetBrokerClientCacheForTests()
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── flag OFF: byte-for-byte the pre-slice-4 behavior ──
  it("flag off (unset): falls back to the human LINEAR_API_KEY exactly as before", async () => {
    const auth = await buildLinearAuth({ LINEAR_API_KEY: "human-key" })
    expect(auth).toEqual({ apiKey: "human-key" })
  })

  it('flag off explicitly ("off") with no tenant: same human-key fallback, unaffected by an unrelated broker binding', async () => {
    const brokerTouched = vi.fn()
    const env = {
      LINEAR_API_KEY: "human-key",
      OPENCLAW_LINEAR_UNIFIED: "off",
      LINEAR_TOKEN_BROKER: { idFromName: brokerTouched },
    } as unknown as LinearAuthEnv
    const auth = await buildLinearAuth(env)
    expect(auth).toEqual({ apiKey: "human-key" })
    expect(brokerTouched).not.toHaveBeenCalled()
  })

  it('a tenant tuple ignores OPENCLAW_LINEAR_UNIFIED="off" and uses only its exact broker shard', async () => {
    let captured: { organizationId?: string; installationId?: number; readOnly: boolean } | undefined
    const env = makeUnifiedAuthEnv(
      async (args) => {
        captured = args
        return { ok: true, accessToken: "tenant-agent-token" }
      },
      {
        extra: {
          OPENCLAW_LINEAR_UNIFIED: "off",
          LINEAR_OAUTH_CLIENT_ID: "must-not-be-used",
          LINEAR_OAUTH_CLIENT_SECRET: "must-not-be-used",
        },
      },
    )

    await expect(buildLinearAuth(env, LINEAR_TENANT)).resolves.toEqual({ oauthToken: "tenant-agent-token" })
    expect(captured).toEqual({ ...LINEAR_TENANT, readOnly: false })
  })

  it("flag off: OAuth client_credentials still wins over the API key when configured (unchanged precedence)", async () => {
    const kv = {
      // KVNamespace.get(key, "json") returns the PARSED value, not a JSON
      // string — return the object directly (not JSON.stringify'd) so the
      // cached-token short-circuit in getAppActorToken actually fires and
      // this test never makes a real network call to Linear's OAuth endpoint.
      get: vi.fn(async () => ({ accessToken: "cached-actor-token", expiresAt: Date.now() + 9e9 })),
    } as unknown as KVNamespace
    const auth = await buildLinearAuth({
      LINEAR_API_KEY: "human-key",
      LINEAR_OAUTH_CLIENT_ID: "client-id",
      LINEAR_OAUTH_CLIENT_SECRET: "client-secret",
      OPENCLAW_STATE: kv,
    })
    expect(auth).toEqual({ oauthToken: "cached-actor-token" })
  })

  // ── flag ON: the SIG-144 slice 4 cutover path ──
  it("flag on: returns the broker AGENT token via getValidAgentTokenViaBroker(readOnly:false) — the active mutation path, not the 10s-ACK hot path", async () => {
    let captured: { readOnly: boolean } | undefined
    const env = makeUnifiedAuthEnv(async (args) => {
      captured = args
      return { ok: true, accessToken: "agent-token-1" }
    })
    const auth = await buildLinearAuth(env, LINEAR_TENANT)
    expect(auth).toEqual({ oauthToken: "agent-token-1" })
    expect(captured).toEqual({ ...LINEAR_TENANT, readOnly: false })
  })

  it("flag on + broker reports not-installed: THROWS — never falls back to the human LINEAR_API_KEY", async () => {
    const env = makeUnifiedAuthEnv(async () => ({ ok: false, reason: "not-installed" }))
    await expect(buildLinearAuth(env, LINEAR_TENANT)).rejects.toThrow(/no agent token is available/)
  })

  it("flag on + broker DO RPC throws (e.g. DO fault): THROWS — never falls back to the human LINEAR_API_KEY", async () => {
    const env = makeUnifiedAuthEnv(async () => {
      throw new Error("DO unreachable")
    })
    await expect(buildLinearAuth(env, LINEAR_TENANT)).rejects.toThrow(/no agent token is available/)
  })

  it("flag on + LINEAR_TOKEN_BROKER unbound: THROWS exactly like a broker miss — never guesses, never falls back", async () => {
    const env = {
      LINEAR_API_KEY: "human-key-must-never-be-used",
      OPENCLAW_LINEAR_UNIFIED: "on",
    } as unknown as LinearAuthEnv
    await expect(buildLinearAuth(env, LINEAR_TENANT)).rejects.toThrow(/no agent token is available/)
  })

  it("legacy unified auth requires both dogfood ids and never reads the old singleton directly", async () => {
    const idFromName = vi.fn()
    const env = {
      LINEAR_API_KEY: "human-key-must-never-be-used",
      OPENCLAW_LINEAR_UNIFIED: "on",
      LINEAR_TOKEN_BROKER: { idFromName },
    } as unknown as LinearAuthEnv

    await expect(buildLinearAuth(env)).rejects.toThrow(/no agent token is available/)
    expect(idFromName).not.toHaveBeenCalled()
  })

  it("legacy unified auth uses the explicitly configured dogfood tenant shard", async () => {
    const idFromName = vi.fn((name: string) => ({ toString: () => name }))
    const env = {
      LINEAR_API_KEY: "human-key-must-never-be-used",
      OPENCLAW_LINEAR_UNIFIED: "on",
      OPENCLAW_LINEAR_ALLOWED_ORG_ID: "org-dogfood",
      OPENCLAW_LINEAR_LEGACY_INSTALLATION_ID: "77",
      LINEAR_TOKEN_BROKER: {
        idFromName,
        get: () => ({
          getValidTenantToken: async () => ({ ok: true as const, accessToken: "dogfood-token" }),
        }),
      },
    } as unknown as LinearAuthEnv

    await expect(buildLinearAuth(env)).resolves.toEqual({ oauthToken: "dogfood-token" })
    expect(idFromName).toHaveBeenCalledWith("linear-org:v1:org-dogfood")
  })

  it("flag on: the thrown error never carries token material", async () => {
    const env = makeUnifiedAuthEnv(async () => ({ ok: false, reason: "not-installed" }), {
      extra: { LINEAR_API_KEY: "super-secret-human-key" },
    })
    await expect(buildLinearAuth(env, LINEAR_TENANT)).rejects.not.toThrow(/super-secret-human-key/)
  })

  it("flag on: NEVER reads LINEAR_API_KEY even when a valid agent token is returned — proven via a throwing getter", async () => {
    let touched = false
    const env = makeUnifiedAuthEnv(async () => ({ ok: true, accessToken: "agent-token-2" }))
    Object.defineProperty(env, "LINEAR_API_KEY", {
      get() {
        touched = true
        return "human-key"
      },
    })
    await buildLinearAuth(env, LINEAR_TENANT)
    expect(touched).toBe(false)
  })

  it("flag on + broker miss: NEVER reads LINEAR_API_KEY before throwing — proven via a throwing getter", async () => {
    let touched = false
    const env = makeUnifiedAuthEnv(async () => ({ ok: false, reason: "not-installed" }))
    Object.defineProperty(env, "LINEAR_API_KEY", {
      get() {
        touched = true
        return "human-key"
      },
    })
    await expect(buildLinearAuth(env, LINEAR_TENANT)).rejects.toThrow()
    expect(touched).toBe(false)
  })
})

// ─── SIG-144 slice 4: buildLinearClient — the single helper callers use ────
describe("buildLinearClient — SIG-144 slice 4 single helper", () => {
  beforeEach(() => {
    __resetBrokerClientCacheForTests()
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("flag off: builds a client with the human apiKey and NO onUnauthorized hook — a 401 gets no retry (matches the pre-slice-4 `new LinearClient(await buildLinearAuth(env))` call-site pattern byte-for-byte)", async () => {
    const client = await buildLinearClient({ LINEAR_API_KEY: "human-key" })
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ message: "Unauthorized" }] }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    )

    await expect(client.createAgentActivity("session-off", "x", "thought")).rejects.toThrow(/Linear HTTP 401/)

    expect(fetchSpy).toHaveBeenCalledTimes(1) // no retry plumbing engaged
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).authorization).toBe("human-key")
  })

  it("broker-bound with no tenant fails closed before reading global credentials when dogfood scope is absent", async () => {
    let humanKeyRead = false
    let oauthClientIdRead = false
    const idFromName = vi.fn()
    const env = {
      OPENCLAW_LINEAR_UNIFIED: "off",
      LINEAR_TOKEN_BROKER: { idFromName },
      get LINEAR_API_KEY() {
        humanKeyRead = true
        return "human-key-must-never-be-used"
      },
      get LINEAR_OAUTH_CLIENT_ID() {
        oauthClientIdRead = true
        return "client-id-must-never-be-used"
      },
      LINEAR_OAUTH_CLIENT_SECRET: "client-secret-must-never-be-used",
    } as unknown as LinearAuthEnv

    await expect(buildLinearClient(env)).rejects.toThrow(/explicit dogfood tenant token/)
    expect(humanKeyRead).toBe(false)
    expect(oauthClientIdRead).toBe(false)
    expect(idFromName).not.toHaveBeenCalled()
  })

  it("broker-bound with no tenant uses only the exact dogfood shard even when unified mode is off", async () => {
    const tokenArgs: Array<{ organizationId: string; installationId: number; readOnly: boolean }> = []
    const refreshArgs: Array<{ organizationId: string; installationId: number }> = []
    const idFromName = vi.fn((name: string) => ({ toString: () => name }))
    const env = {
      LINEAR_API_KEY: "human-key-must-never-be-used",
      LINEAR_OAUTH_CLIENT_ID: "client-id-must-never-be-used",
      LINEAR_OAUTH_CLIENT_SECRET: "client-secret-must-never-be-used",
      OPENCLAW_LINEAR_UNIFIED: "off",
      OPENCLAW_LINEAR_ALLOWED_ORG_ID: "org-dogfood",
      OPENCLAW_LINEAR_LEGACY_INSTALLATION_ID: "77",
      LINEAR_TOKEN_BROKER: {
        idFromName,
        get: () => ({
          getValidTenantToken: async (args: { organizationId: string; installationId: number; readOnly: boolean }) => {
            tokenArgs.push(args)
            return { ok: true as const, accessToken: "dogfood-token" }
          },
          forceRefreshTenant: async (args: { organizationId: string; installationId: number }) => {
            refreshArgs.push(args)
            return { ok: true as const, accessToken: "dogfood-token-refreshed" }
          },
        }),
      },
    } as unknown as LinearAuthEnv
    const client = await buildLinearClient(env)
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { agentActivityCreate: { success: true } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )

    await client.createAgentActivity("session-dogfood", "x", "thought")

    expect(idFromName).toHaveBeenCalledWith("linear-org:v1:org-dogfood")
    expect(tokenArgs).toEqual([{ organizationId: "org-dogfood", installationId: 77, readOnly: false }])
    expect(refreshArgs).toEqual([{ organizationId: "org-dogfood", installationId: 77 }])
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const [, firstInit] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const [, secondInit] = fetchSpy.mock.calls[1] as [string, RequestInit]
    expect((firstInit.headers as Record<string, string>).authorization).toBe("Bearer dogfood-token")
    expect((secondInit.headers as Record<string, string>).authorization).toBe("Bearer dogfood-token-refreshed")
  })

  it("a tenant client carries the exact-shard refresh hook even with the legacy unified flag off", async () => {
    let forceRefreshCalls = 0
    const env = makeUnifiedAuthEnv(async () => ({ ok: true, accessToken: "stale-agent-token" }), {
      forceRefresh: async () => {
        forceRefreshCalls++
        return { ok: true, accessToken: "fresh-agent-token" }
      },
      extra: { OPENCLAW_LINEAR_UNIFIED: "off" },
    })

    const client = await buildLinearClient(env, LINEAR_TENANT)

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

    await client.createAgentActivity("session-on", "x", "thought")

    expect(forceRefreshCalls).toBe(1)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const [, firstInit] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect((firstInit.headers as Record<string, string>).authorization).toBe("Bearer stale-agent-token")
    const [, secondInit] = fetchSpy.mock.calls[1] as [string, RequestInit]
    expect((secondInit.headers as Record<string, string>).authorization).toBe("Bearer fresh-agent-token")
  })

  it("flag on + broker miss: rejects (buildLinearAuth's throw) rather than returning a client — no client is ever built on the human key", async () => {
    const env = makeUnifiedAuthEnv(async () => ({ ok: false, reason: "not-installed" }))
    await expect(buildLinearClient(env, LINEAR_TENANT)).rejects.toThrow(/no agent token is available/)
  })
})
