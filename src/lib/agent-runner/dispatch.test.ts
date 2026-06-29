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
}))
vi.mock("@cloudflare/containers", () => ({
  getContainer: vi.fn(),
}))

import { dispatchAgentRun, getAgentRunStatus, type AgentRunTaskInput } from "@/src/lib/agent-runner/dispatch"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import { getContainer } from "@cloudflare/containers"
import type { Env } from "@/src/shared/types/env"
import type { AgentRunRecord } from "@/src/do/agent-runner-container"

// ── typed mock handles ────────────────────────────────────────────────────────
const mockGetInstallationToken = vi.mocked(getInstallationToken)

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

function makeEnv(mode?: string): Env {
  return {
    OPENCLAW_AGENT_RUNNER_MODE: mode,
    OPENCLAW_STATE: {} as KVNamespace,
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-pem-key",
    AGENT_RUNNER: {} as DurableObjectNamespace,
  } as unknown as Env
}

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
    expect(result).toEqual({ runId: "run-abc", dispatched: false })
    expect(mockGetInstallationToken).not.toHaveBeenCalled()
    expect(mockGetContainer).not.toHaveBeenCalled()
  })

  it("mode unset → dispatched:false; getInstallationToken NOT called; getContainer NOT called", async () => {
    const result = await dispatchAgentRun(makeEnv(undefined), SAMPLE_INPUT)
    expect(result).toEqual({ runId: "run-abc", dispatched: false })
    expect(mockGetInstallationToken).not.toHaveBeenCalled()
    expect(mockGetContainer).not.toHaveBeenCalled()
  })

  it('mode "ON" (wrong case) → dispatched:false; dark guarantee', async () => {
    const result = await dispatchAgentRun(makeEnv("ON"), SAMPLE_INPUT)
    expect(result).toEqual({ runId: "run-abc", dispatched: false })
    expect(mockGetInstallationToken).not.toHaveBeenCalled()
  })

  // ── (b) mode on → token minted + correct packet ─────────────────────────────

  it('mode "on" → mints token with correct args; dispatched:true', async () => {
    const stub = makeStub()
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)

    const env = makeEnv("on")
    const result = await dispatchAgentRun(env, SAMPLE_INPUT)

    expect(result).toEqual({ runId: "run-abc", dispatched: true })
    expect(mockGetInstallationToken).toHaveBeenCalledOnce()
    expect(mockGetInstallationToken).toHaveBeenCalledWith({
      kv: env.OPENCLAW_STATE,
      appId: "12345",
      privateKey: "fake-pem-key",
      installationId: 99,
    })
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
    expect(result).toEqual({ runId: "run-abc", dispatched: false })
    expect(mockGetContainer).not.toHaveBeenCalled()
  })

  it("container fetch throws → dispatched:false, no throw-out", async () => {
    const stub = makeStub(() => Promise.reject(new Error("Container unreachable")))
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)

    const result = await dispatchAgentRun(makeEnv("on"), SAMPLE_INPUT)
    expect(result).toEqual({ runId: "run-abc", dispatched: false })
  })

  it("container fetch returns non-ok (5xx) → dispatched:false, no throw-out", async () => {
    const stub = makeStub(() => Promise.resolve(new Response("err", { status: 500 })))
    mockGetContainer.mockReturnValue(stub)
    mockGetInstallationToken.mockResolvedValue(STUB_TOKEN)

    const result = await dispatchAgentRun(makeEnv("on"), SAMPLE_INPUT)
    expect(result).toEqual({ runId: "run-abc", dispatched: false })
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

    expect(result).toEqual({ runId: "run-abc", dispatched: true })
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

    expect(result).toEqual({ runId: "run-abc", dispatched: true })

    const allOutput = [
      ...spyLog.mock.calls.flat().map(String),
      ...spyWarn.mock.calls.flat().map(String),
      ...spyError.mock.calls.flat().map(String),
    ].join("\n")

    expect(allOutput).toContain("agent-runner-status-persist-failed")
    expect(allOutput).not.toContain(STUB_TOKEN)
    expect(allOutput).not.toContain(SAMPLE_INPUT.model.key)
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
