// SIG-545 B1: dispatchAgentRun + getAgentRunStatus tests.
//
// Mocks:
//   @/src/shared/adapters/github/github-app — stubs getInstallationToken
//   @cloudflare/containers                  — stubs getContainer
//
// Assertions:
//   (a) mode off/unset  → dispatched:false, getInstallationToken NOT called, getContainer NOT called (dark)
//   (b) mode on         → token minted, getContainer.fetch called with the right packet
//   (c) the minted token + model.key NEVER appear in console output
//   (d) mint/dispatch throw → dispatched:false, no throw-out (fail-safe)
//   (e) getAgentRunStatus → DO record (null on fault)

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"

// ── mocks must be declared before the module-under-test is imported ──────────
vi.mock("@/src/shared/adapters/github/github-app", () => ({
  getInstallationToken: vi.fn(),
  resolveRepoInstallationId: vi.fn(),
}))
vi.mock("@cloudflare/containers", () => ({
  getContainer: vi.fn(),
}))

import { dispatchAgentRun, getAgentRunStatus, type AgentRunTaskInput } from "@/src/lib/agent-runner/dispatch"
import { getInstallationToken, resolveRepoInstallationId } from "@/src/shared/adapters/github/github-app"
import { getContainer } from "@cloudflare/containers"
import type { Env } from "@/src/shared/types/env"
import type { AgentRunRecord } from "@/src/do/agent-runner-container"
import { sha256Hex } from "@/src/lib/auth-bearer"
import type { AgentMcpCapabilityRecord } from "@/src/do/agent-mcp-capability"

// ── typed mock handles ────────────────────────────────────────────────────────
const mockGetInstallationToken = vi.mocked(getInstallationToken)
const mockResolveRepoInstallationId = vi.mocked(resolveRepoInstallationId)

// getContainer is mocked via vi.mock — treat it as a generic spy.
// We avoid inferring its generic return type (DurableObjectStub<Container>)
// so we can return plain test stubs without fighting the Rpc.Provider machinery.

const mockGetContainer = vi.mocked(getContainer) as unknown as MockInstance<(...args: any[]) => ContainerStub>

// ── ContainerStub: test double for the DO stub ────────────────────────────────
// Reflects the surface dispatchAgentRun + getAgentRunStatus actually use:
//   .fetch(req)         — send the task packet
//   .getRunRecord()     — read the durable run record
//   .setRunRecord(r)    — persist the durable run record

type SpyFn = MockInstance<(...args: any[]) => any>
interface ContainerStub {
  fetch: SpyFn
  getRunRecord: SpyFn
  setRunRecord: SpyFn
}

// ── constants ─────────────────────────────────────────────────────────────────
const STUB_TOKEN = "ghs_stub_installation_token_for_test_12345"
const STUB_RECORD: AgentRunRecord = { runId: "run-abc", status: "started" }
const MCP_RUN_ID = "11111111-1111-4111-8111-111111111111"

const SAMPLE_INPUT: AgentRunTaskInput = {
  runId: "run-abc",
  owner: "Sigilix",
  repo: "sigilix",
  baseBranch: "main",
  installationId: 99,
  ticket: {
    identifier: "SIG-123",
    title: "Fix the bug",
    body: "Details here",
    url: "https://linear.app/sigilix/issue/SIG-123",
  },
  grounding: "some grounding context",
  model: { id: "z-ai/glm-5.2", key: "sk-openrouter-secret-key" },
  caps: { maxModelCalls: 20, maxTokens: 1_500_000, timeoutMs: 1_200_000 },
}

function makeEnv(mode?: string, extra?: Record<string, unknown>): Env {
  return {
    OPENCLAW_AGENT_RUNNER_MODE: mode,
    OPENCLAW_STATE: {} as KVNamespace,
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-pem-key",
    AGENT_RUNNER: {} as DurableObjectNamespace,
    ...extra,
  } as unknown as Env
}

const GROUNDING_API_KEY = "sk-sigilix-grounding-secret"

function makeStub(
  fetchImpl?: () => Promise<Response>,
  getRunRecordImpl?: () => Promise<AgentRunRecord | null>,
): ContainerStub {
  return {
    fetch: vi.fn(fetchImpl ?? (() => Promise.resolve(new Response('{"status":"started"}', { status: 200 })))),
    getRunRecord: vi.fn(getRunRecordImpl ?? (() => Promise.resolve(null))),
    setRunRecord: vi.fn(() => Promise.resolve(undefined)),
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("dispatchAgentRun", () => {
  let spyLog: MockInstance
  let spyWarn: MockInstance
  let spyError: MockInstance

  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveRepoInstallationId.mockResolvedValue(99)
    spyLog = vi.spyOn(console, "log").mockImplementation(() => undefined)
    spyWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    spyError = vi.spyOn(console, "error").mockImplementation(() => undefined)
  })

  afterEach(() => {
    spyLog.mockRestore()
    spyWarn.mockRestore()
    spyError.mockRestore()
  })

  // ── (a) dark guarantee ──────────────────────────────────────────────────────

  it('mode "off" → dispatched:false; getInstallationToken NOT called; getContainer NOT called', async () => {
    const result = await dispatchAgentRun(makeEnv("off"), SAMPLE_INPUT)
    expect(result).toEqual({ runId: "run-abc", dispatched: false, reason: "runner-dark: mode=off" })
    expect(mockGetInstallationToken).not.toHaveBeenCalled()
    expect(mockGetContainer).not.toHaveBeenCalled()
  })

  it("mode unset → dispatched:false; getInstallationToken NOT called; getContainer NOT called", async () => {
    const result = await dispatchAgentRun(makeEnv(undefined), SAMPLE_INPUT)
    expect(result).toEqual({ runId: "run-abc", dispatched: false, reason: "runner-dark: mode=unset" })
    expect(mockGetInstallationToken).not.toHaveBeenCalled()
    expect(mockGetContainer).not.toHaveBeenCalled()
  })

  it('mode "ON" (wrong case) → dispatched:false; dark guarantee', async () => {
    const result = await dispatchAgentRun(makeEnv("ON"), SAMPLE_INPUT)
    expect(result).toEqual({ runId: "run-abc", dispatched: false, reason: "runner-dark: mode=ON" })
    expect(mockGetInstallationToken).not.toHaveBeenCalled()
  })

  // ── (b) mode on → token minted + correct packet ─────────────────────────────

  it('mode "on" → mints token with correct args; dispatched:true', async () => {
    const stub = makeStub()
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)

    const env = makeEnv("on")
    const result = await dispatchAgentRun(env, SAMPLE_INPUT)

    // SIG-145: the parsed container outcome is surfaced to the caller (the default
    // stub responds {"status":"started"}).
    expect(result).toEqual({ runId: "run-abc", dispatched: true, outcome: { status: "started" } })
    expect(mockGetInstallationToken).toHaveBeenCalledOnce()
    expect(mockGetInstallationToken).toHaveBeenCalledWith({
      kv: env.OPENCLAW_STATE,
      appId: "12345",
      privateKey: "fake-pem-key",
      installationId: 99,
    })
  })

  it("fails closed before token mint when GitHub resolves the repo to another installation", async () => {
    mockResolveRepoInstallationId.mockResolvedValue(100)

    const result = await dispatchAgentRun(makeEnv("on"), SAMPLE_INPUT)

    expect(result).toMatchObject({ runId: "run-abc", dispatched: false })
    expect(result.reason).toBe("dispatch-failed: repository installation authorization failed")
    expect(mockGetInstallationToken).not.toHaveBeenCalled()
    expect(mockGetContainer).not.toHaveBeenCalled()
  })

  it("mints a hash-at-rest MCP capability after authorization, sends only opaque endpoint+bearer, and revokes in finally", async () => {
    const stub = makeStub()
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)
    let persisted: AgentMcpCapabilityRecord | undefined
    const revoke = vi.fn(() => Promise.resolve())
    const capabilityStub = {
      initialize: vi.fn((record: AgentMcpCapabilityRecord) => {
        persisted = structuredClone(record)
        return Promise.resolve(true)
      }),
      revoke,
    }
    const mcpStub = {
      fetch: vi.fn(() =>
        Promise.resolve(
          Response.json({
            tools: [
              {
                serverId: "grant-1",
                vendor: "linear",
                name: "list_comments",
                inputSchema: { type: "object" },
              },
            ],
            // A degraded provider must not erase the healthy provider's exact
            // read grant from this run's capability.
            partial: true,
          }),
        ),
      ),
    }
    const env = makeEnv("on", {
      SIGILIX_AGENT_MCP_ENDPOINT: "https://api.sigilix.ai",
      MCP_CONNECTIONS: { idFromName: vi.fn((name: string) => name), get: vi.fn(() => mcpStub) },
      AGENT_MCP_CAPABILITY: { idFromName: vi.fn((name: string) => name), get: vi.fn(() => capabilityStub) },
    })

    await dispatchAgentRun(env, { ...SAMPLE_INPUT, runId: MCP_RUN_ID })

    const request = stub.fetch.mock.calls[0]![0]!
    const body = (await request.json()) as { mcp: { endpoint: string; capability: string } }
    expect(body.mcp.endpoint).toBe(`https://api.sigilix.ai/internal/agent-runs/${MCP_RUN_ID}/mcp`)
    expect(body.mcp.capability).toMatch(/^[a-f0-9]{64}$/)
    expect(persisted).toMatchObject({
      runId: MCP_RUN_ID,
      installationId: 99,
      owner: "Sigilix",
      repo: "sigilix",
      surface: "agent",
      tools: [{ localName: "mcp_0", grantId: "grant-1", toolName: "list_comments" }],
    })
    expect(persisted?.capabilityHash).toBe(await sha256Hex(body.mcp.capability))
    expect(JSON.stringify(persisted)).not.toContain(body.mcp.capability)
    expect(revoke).toHaveBeenCalledOnce()
    const allOutput = [...spyLog.mock.calls, ...spyWarn.mock.calls, ...spyError.mock.calls]
      .flat()
      .map(String)
      .join("\n")
    expect(allOutput).not.toContain(body.mcp.capability)
  })

  it("revokes the MCP capability in finally when the container dispatch fails", async () => {
    const stub = makeStub(() => Promise.reject(new Error("Container unreachable")))
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)
    const revoke = vi.fn(() => Promise.resolve())
    const capabilityStub = { initialize: vi.fn(() => Promise.resolve(true)), revoke }
    const mcpStub = {
      fetch: vi.fn(() =>
        Promise.resolve(
          Response.json({
            tools: [
              {
                serverId: "grant-1",
                vendor: "linear",
                name: "list_comments",
                inputSchema: { type: "object" },
              },
            ],
            partial: false,
          }),
        ),
      ),
    }
    const env = makeEnv("on", {
      SIGILIX_AGENT_MCP_ENDPOINT: "https://api.sigilix.ai",
      MCP_CONNECTIONS: { idFromName: vi.fn((name: string) => name), get: vi.fn(() => mcpStub) },
      AGENT_MCP_CAPABILITY: { idFromName: vi.fn((name: string) => name), get: vi.fn(() => capabilityStub) },
    })

    const result = await dispatchAgentRun(env, { ...SAMPLE_INPUT, runId: MCP_RUN_ID })

    expect(result).toMatchObject({ dispatched: false })
    expect(capabilityStub.initialize).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledOnce()
  })

  it("omits MCP without touching the broker for a non-UUID run id or a sub-30-second run", async () => {
    const stub = makeStub()
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)
    const mcpFetch = vi.fn()
    const env = makeEnv("on", {
      SIGILIX_AGENT_MCP_ENDPOINT: "https://api.sigilix.ai",
      MCP_CONNECTIONS: { idFromName: vi.fn(), get: vi.fn(() => ({ fetch: mcpFetch })) },
      AGENT_MCP_CAPABILITY: { idFromName: vi.fn(), get: vi.fn() },
    })

    await dispatchAgentRun(env, SAMPLE_INPUT)
    await dispatchAgentRun(env, {
      ...SAMPLE_INPUT,
      runId: MCP_RUN_ID,
      caps: { ...SAMPLE_INPUT.caps, timeoutMs: 29_999 },
    })

    for (const call of stub.fetch.mock.calls) {
      const body = (await call[0]!.json()) as Record<string, unknown>
      expect(body.mcp).toBeUndefined()
    }
    expect(mcpFetch).not.toHaveBeenCalled()
  })

  it('mode "on" → calls getContainer with (binding, runId) and invokes fetch with the task packet', async () => {
    const stub = makeStub()
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)

    const env = makeEnv("on")
    await dispatchAgentRun(env, SAMPLE_INPUT)

    expect(mockGetContainer).toHaveBeenCalledWith(env.AGENT_RUNNER, "run-abc")
    expect(stub.fetch).toHaveBeenCalledOnce()

    // Inspect the task packet body
    const req = stub.fetch.mock.calls[0]![0]!
    expect(req.method).toBe("POST")
    expect(req.headers.get("content-type")).toBe("application/json")

    const body = (await req.json()) as Record<string, unknown>
    expect(body.runId).toBe("run-abc")
    expect((body.repo as Record<string, unknown>).owner).toBe("Sigilix")
    expect((body.repo as Record<string, unknown>).name).toBe("sigilix")
    expect((body.repo as Record<string, unknown>).installationToken).toBe(STUB_TOKEN)
    expect((body.repo as Record<string, unknown>).baseBranch).toBe("main")
    expect((body.model as Record<string, unknown>).id).toBe("z-ai/glm-5.2")
    expect(body.ticket).toEqual(SAMPLE_INPUT.ticket)
    expect(body.caps).toEqual(SAMPLE_INPUT.caps)
    expect(body.grounding).toBe("some grounding context")
  })

  // ── SIG-545 B2: pre-fetch grounding from /v1/context ────────────────────────

  it('mode "on": pre-fetches grounding from /v1/context when configured and none supplied', async () => {
    const stub = makeStub()
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ context: "PREFETCHED GROUNDING" }), { status: 200 }))
    try {
      const env = makeEnv("on", {
        OPENCLAW_AGENT_GROUNDING_ENDPOINT: "https://api.sigilix.ai",
        OPENCLAW_SIGILIX_API_KEY: GROUNDING_API_KEY,
      })
      const { grounding: _drop, ...noGrounding } = SAMPLE_INPUT
      await dispatchAgentRun(env, noGrounding as AgentRunTaskInput)

      // the /v1/context prefetch fired against the configured endpoint with the
      // bearer + {owner, repo, query} contract the route expects
      const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit]
      expect(url).toBe("https://api.sigilix.ai/v1/context")
      expect(init.method).toBe("POST")
      expect(init.headers).toMatchObject({
        authorization: `Bearer ${GROUNDING_API_KEY}`,
        "content-type": "application/json",
      })
      const sentBody = JSON.parse(String(init.body)) as Record<string, unknown>
      expect(sentBody).toMatchObject({ owner: "Sigilix", repo: "sigilix" })
      expect(typeof sentBody.query).toBe("string")
      // and the pre-fetched slice landed in the container packet (was undefined before this fix)
      const req = stub.fetch.mock.calls[0]![0]!
      const body = (await req.json()) as Record<string, unknown>
      expect(body.grounding).toBe("PREFETCHED GROUNDING")
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('mode "on": no /v1/context pre-fetch when grounding is unconfigured (agent stays blind, unchanged)', async () => {
    const stub = makeStub()
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    try {
      const { grounding: _drop, ...noGrounding } = SAMPLE_INPUT
      await dispatchAgentRun(makeEnv("on"), noGrounding as AgentRunTaskInput) // no endpoint/key
      expect(fetchSpy).not.toHaveBeenCalled()
      const req = stub.fetch.mock.calls[0]![0]!
      const body = (await req.json()) as Record<string, unknown>
      expect(body.grounding).toBeUndefined()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  // ── (b2) model.baseUrl threading (Ollama-Turbo vs OpenRouter default) ────────

  it('mode "on": forwards model.baseUrl into the task packet when present', async () => {
    const stub = makeStub()
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)

    const input: AgentRunTaskInput = {
      ...SAMPLE_INPUT,
      model: { id: "glm-5.2:cloud", key: "sk-ollama-secret-key", baseUrl: "https://ollama.com/v1" },
    }
    await dispatchAgentRun(makeEnv("on"), input)

    const req = stub.fetch.mock.calls[0]![0]!
    const body = (await req.json()) as Record<string, unknown>
    const model = body.model as Record<string, unknown>
    expect(model.id).toBe("glm-5.2:cloud")
    expect(model.baseUrl).toBe("https://ollama.com/v1")
  })

  it('mode "on": omits baseUrl from the packet when absent (container applies the OpenRouter default)', async () => {
    const stub = makeStub()
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)

    await dispatchAgentRun(makeEnv("on"), SAMPLE_INPUT)

    const req = stub.fetch.mock.calls[0]![0]!
    const body = (await req.json()) as Record<string, unknown>
    const model = body.model as Record<string, unknown>
    expect(model.baseUrl).toBeUndefined()
  })

  // ── (b3) engine selector (SIG-545 B2) ───────────────────────────────────────

  it('mode "on": defaults the packet engine to "minimal" when the input omits it', async () => {
    const stub = makeStub()
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)

    await dispatchAgentRun(makeEnv("on"), SAMPLE_INPUT)

    const req = stub.fetch.mock.calls[0]![0]!
    const body = (await req.json()) as Record<string, unknown>
    expect(body.engine).toBe("minimal")
  })

  it('mode "on": forwards engine "full" into the packet', async () => {
    const stub = makeStub()
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)

    await dispatchAgentRun(makeEnv("on"), { ...SAMPLE_INPUT, engine: "full" })

    const req = stub.fetch.mock.calls[0]![0]!
    const body = (await req.json()) as Record<string, unknown>
    expect(body.engine).toBe("full")
  })

  // ── (b4) grounding wiring (SIG-545 B2) — resolved from env, not the caller ───

  it('mode "on": packet has NO sigilix block when grounding env is unset', async () => {
    const stub = makeStub()
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)

    await dispatchAgentRun(makeEnv("on"), SAMPLE_INPUT)

    const req = stub.fetch.mock.calls[0]![0]!
    const body = (await req.json()) as Record<string, unknown>
    expect(body.sigilix).toBeUndefined()
  })

  it('mode "on": builds sigilix {endpoint, apiKey, repoSlug} from env when both are set', async () => {
    const stub = makeStub()
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)

    const env = makeEnv("on", {
      OPENCLAW_AGENT_GROUNDING_ENDPOINT: "https://sigilix.example.workers.dev",
      OPENCLAW_SIGILIX_API_KEY: GROUNDING_API_KEY,
    })
    await dispatchAgentRun(env, SAMPLE_INPUT)

    const req = stub.fetch.mock.calls[0]![0]!
    const body = (await req.json()) as Record<string, unknown>
    expect(body.sigilix).toEqual({
      endpoint: "https://sigilix.example.workers.dev",
      apiKey: GROUNDING_API_KEY,
      repoSlug: "Sigilix/sigilix",
    })
  })

  it('mode "on": omits sigilix when only the endpoint is set (no bearer)', async () => {
    const stub = makeStub()
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)

    const env = makeEnv("on", { OPENCLAW_AGENT_GROUNDING_ENDPOINT: "https://sigilix.example.workers.dev" })
    await dispatchAgentRun(env, SAMPLE_INPUT)

    const req = stub.fetch.mock.calls[0]![0]!
    const body = (await req.json()) as Record<string, unknown>
    expect(body.sigilix).toBeUndefined()
  })

  it('mode "on": omits sigilix when only the bearer is set (no endpoint) — the prod-likely partial state', async () => {
    const stub = makeStub()
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)

    // OPENCLAW_SIGILIX_API_KEY is already set in prod for /v1/review; the grounding
    // endpoint may not be set yet — must fail closed (no half-wired grounding).
    const env = makeEnv("on", { OPENCLAW_SIGILIX_API_KEY: GROUNDING_API_KEY })
    await dispatchAgentRun(env, SAMPLE_INPUT)

    const req = stub.fetch.mock.calls[0]![0]!
    const body = (await req.json()) as Record<string, unknown>
    expect(body.sigilix).toBeUndefined()
  })

  it("the grounding apiKey never appears in any console output", async () => {
    const stub = makeStub()
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)

    const env = makeEnv("on", {
      OPENCLAW_AGENT_GROUNDING_ENDPOINT: "https://sigilix.example.workers.dev",
      OPENCLAW_SIGILIX_API_KEY: GROUNDING_API_KEY,
    })
    await dispatchAgentRun(env, SAMPLE_INPUT)

    const allOutput = [
      ...spyLog.mock.calls.flat().map(String),
      ...spyWarn.mock.calls.flat().map(String),
      ...spyError.mock.calls.flat().map(String),
    ].join("\n")
    expect(allOutput).not.toContain(GROUNDING_API_KEY)
  })

  // ── (c) secrets never appear in console output ───────────────────────────────

  it("minted token and model.key never appear in any console output", async () => {
    const stub = makeStub()
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)

    await dispatchAgentRun(makeEnv("on"), SAMPLE_INPUT)

    const allOutput = [
      ...spyLog.mock.calls.flat().map(String),
      ...spyWarn.mock.calls.flat().map(String),
      ...spyError.mock.calls.flat().map(String),
    ].join("\n")

    expect(allOutput).not.toContain(STUB_TOKEN)
    expect(allOutput).not.toContain(SAMPLE_INPUT.model.key)
  })

  it("dark path logs agent-runner-skipped event (no token)", async () => {
    await dispatchAgentRun(makeEnv("off"), SAMPLE_INPUT)

    const allOutput = [...spyLog.mock.calls.flat().map(String), ...spyWarn.mock.calls.flat().map(String)].join("\n")

    expect(allOutput).toContain("agent-runner-skipped")
    expect(allOutput).not.toContain(STUB_TOKEN)
  })

  // ── (d) fail-safe: throw → dispatched:false, no throw-out ───────────────────

  it("mint throws → dispatched:false, no throw-out, getContainer NOT called", async () => {
    mockGetInstallationToken.mockRejectedValue(new Error("GitHub API unavailable"))

    const result = await dispatchAgentRun(makeEnv("on"), SAMPLE_INPUT)
    // The error path surfaces WHY it failed (the diagnostic reason), not just a bare false.
    expect(result).toMatchObject({ runId: "run-abc", dispatched: false })
    expect(result.reason).toBe("dispatch-failed: GitHub API unavailable")
    expect(mockGetContainer).not.toHaveBeenCalled()
  })

  it("container fetch throws → dispatched:false, no throw-out", async () => {
    const stub = makeStub(() => Promise.reject(new Error("Container unreachable")))
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)

    const result = await dispatchAgentRun(makeEnv("on"), SAMPLE_INPUT)
    expect(result).toMatchObject({ runId: "run-abc", dispatched: false })
    expect(result.reason).toBe("dispatch-failed: Container unreachable")
  })

  it("container fetch returns non-ok (5xx) → dispatched:false, no throw-out", async () => {
    const stub = makeStub(() => Promise.resolve(new Response("err", { status: 500 })))
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)

    const result = await dispatchAgentRun(makeEnv("on"), SAMPLE_INPUT)
    expect(result).toMatchObject({ runId: "run-abc", dispatched: false })
    expect(result.reason).toMatch(/^dispatch-failed:/)
  })

  it("dispatch failure logs agent-runner-dispatch-failed (without token or key)", async () => {
    mockGetInstallationToken.mockRejectedValue(new Error("network error"))

    await dispatchAgentRun(makeEnv("on"), SAMPLE_INPUT)

    const allOutput = [
      ...spyLog.mock.calls.flat().map(String),
      ...spyWarn.mock.calls.flat().map(String),
      ...spyError.mock.calls.flat().map(String),
    ].join("\n")

    expect(allOutput).toContain("agent-runner-dispatch-failed")
    expect(allOutput).not.toContain(STUB_TOKEN)
    expect(allOutput).not.toContain(SAMPLE_INPUT.model.key)
  })

  // ── (f) status persist — container response parsed + setRunRecord called ─────

  it('mode "on": parses the container RunResult and calls setRunRecord with the mapped record', async () => {
    const runResult = {
      runId: "run-abc",
      status: "opened",
      prUrl: "https://github.com/Sigilix/sigilix/pull/7",
      modelCalls: 5,
      tokens: 1000,
      stoppedReason: "done",
    }
    const stub = makeStub(() => Promise.resolve(new Response(JSON.stringify(runResult), { status: 200 })))
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)

    const result = await dispatchAgentRun(makeEnv("on"), SAMPLE_INPUT)

    // SIG-145: the same parsed outcome persisted to the DO is also handed back so the
    // caller can post the terminal Linear agent-session activity with the PR link.
    expect(result).toEqual({
      runId: "run-abc",
      dispatched: true,
      outcome: { status: "opened", prUrl: "https://github.com/Sigilix/sigilix/pull/7" },
    })
    expect(stub.setRunRecord).toHaveBeenCalledWith({
      runId: "run-abc",
      status: "opened",
      prUrl: "https://github.com/Sigilix/sigilix/pull/7",
    })
  })

  it('mode "on": setRunRecord failure logs agent-runner-status-persist-failed but still returns dispatched:true', async () => {
    const stub = makeStub()
    stub.setRunRecord.mockRejectedValue(new Error("DO storage unavailable"))
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)

    const result = await dispatchAgentRun(makeEnv("on"), SAMPLE_INPUT)

    // The outcome was parsed before the DO persist threw, so it's still surfaced
    // (the caller can post the completion even when the DO write failed).
    expect(result).toEqual({ runId: "run-abc", dispatched: true, outcome: { status: "started" } })

    const allOutput = [
      ...spyLog.mock.calls.flat().map(String),
      ...spyWarn.mock.calls.flat().map(String),
      ...spyError.mock.calls.flat().map(String),
    ].join("\n")

    expect(allOutput).toContain("agent-runner-status-persist-failed")
    expect(allOutput).not.toContain(STUB_TOKEN)
    expect(allOutput).not.toContain(SAMPLE_INPUT.model.key)
  })

  it('mode "on": a malformed (non-JSON) container body → dispatched:true with NO outcome (caller falls back)', async () => {
    const stub = makeStub(() => Promise.resolve(new Response("not json", { status: 200 })))
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)

    const result = await dispatchAgentRun(makeEnv("on"), SAMPLE_INPUT)

    // The run completed (HTTP 200) but the body couldn't be parsed — surface no outcome
    // so the caller posts a neutral resolving activity rather than a wrong one.
    expect(result).toEqual({ runId: "run-abc", dispatched: true })
  })
})

describe("getAgentRunStatus", () => {
  beforeEach(() => vi.clearAllMocks())

  // ── (e) reads DO record ───────────────────────────────────────────────────────

  it("returns the run record from the container DO", async () => {
    const stub = makeStub(undefined, () => Promise.resolve(STUB_RECORD))
    mockGetContainer.mockReturnValue(stub)

    const env = makeEnv()
    const record = await getAgentRunStatus(env, "run-abc")

    expect(record).toEqual(STUB_RECORD)
    expect(mockGetContainer).toHaveBeenCalledWith(env.AGENT_RUNNER, "run-abc")
    expect(stub.getRunRecord).toHaveBeenCalled()
  })

  it("returns null when getRunRecord returns null (pre-dispatch state)", async () => {
    const stub = makeStub(undefined, () => Promise.resolve(null))
    mockGetContainer.mockReturnValue(stub)

    const env = makeEnv()
    const record = await getAgentRunStatus(env, "run-abc")
    expect(record).toBeNull()
  })

  it("returns null when getRunRecord throws (fault-tolerant)", async () => {
    const stub = makeStub(undefined, () => Promise.reject(new Error("DO unavailable")))
    mockGetContainer.mockReturnValue(stub)

    const env = makeEnv()
    const record = await getAgentRunStatus(env, "run-abc")
    expect(record).toBeNull()
  })

  it("returns null when getContainer itself throws (fault-tolerant)", async () => {
    mockGetContainer.mockImplementation(() => {
      throw new Error("Binding unavailable")
    })

    const env = makeEnv()
    const record = await getAgentRunStatus(env, "run-abc")
    expect(record).toBeNull()
  })

  it("returns the record that dispatchAgentRun persisted via setRunRecord", async () => {
    const prUrl = "https://github.com/Sigilix/sigilix/pull/7"
    const runResult = { runId: "run-abc", status: "opened", prUrl, modelCalls: 5, tokens: 1000, stoppedReason: "done" }
    const persistedRecord: AgentRunRecord = { runId: "run-abc", status: "opened", prUrl }

    const stub = makeStub(
      () => Promise.resolve(new Response(JSON.stringify(runResult), { status: 200 })),
      () => Promise.resolve(persistedRecord),
    )
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)

    // dispatchAgentRun parses the container response and calls setRunRecord
    await dispatchAgentRun(makeEnv("on"), SAMPLE_INPUT)
    expect(stub.setRunRecord).toHaveBeenCalledWith({
      runId: "run-abc",
      status: "opened",
      prUrl,
    })

    // getAgentRunStatus reads via getRunRecord — returns the persisted outcome
    const record = await getAgentRunStatus(makeEnv("on"), "run-abc")
    expect(record).toEqual(persistedRecord)
  })
})
