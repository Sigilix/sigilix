// SIG-545 B3: runLinearAgentRun tests.
//
// Mocks:
//   @/src/lib/linear                  — stubs LinearClient (getIssue/createComment) + buildLinearAuth
//   @/src/lib/agent-runner/dispatch   — stubs dispatchAgentRun
//
// github-installation (listTeamRepoMappings / resolveInstallation) is NOT mocked —
// the real resolution runs against JSON env vars so the gate logic is exercised.
//
// Coverage:
//   (a) happy path → builds the correct AgentRunTaskInput (owner/repo/installationId/
//       ticket/engine:"minimal"/model.id) + posts the Linear ack
//   (b) no team→repo mapping → no dispatch
//   (c) no installation → no dispatch
//   (d) no OLLAMA_API_KEY → no dispatch
//   (e) issue not found → no dispatch
//   (f) the model key NEVER appears in any console output

import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from "vitest"

// ── mocks must be declared before the module-under-test is imported ──────────
vi.mock("@/src/lib/linear", () => ({
  LinearClient: vi.fn(),
  buildLinearAuth: vi.fn(),
  buildLinearAgentClient: vi.fn(),
}))
vi.mock("@/src/lib/agent-runner/dispatch", () => ({
  dispatchAgentRun: vi.fn(),
}))

import { runLinearAgentRun, dispatchTicketImplementation } from "@/src/lib/linear-agent-run"
import { LinearClient, buildLinearAuth, buildLinearAgentClient, type LinearIssue } from "@/src/lib/linear"
import { dispatchAgentRun, type AgentRunTaskInput } from "@/src/lib/agent-runner/dispatch"
import type { Env } from "@/src/shared/types/env"

// ── typed mock handles ────────────────────────────────────────────────────────
const mockBuildLinearAuth = vi.mocked(buildLinearAuth)
const mockBuildLinearAgentClient = vi.mocked(buildLinearAgentClient)
const mockDispatchAgentRun = vi.mocked(dispatchAgentRun)
const MockLinearClient = vi.mocked(LinearClient)

// ── per-test instance method spies ──────────────────────────────────────────
let mockGetIssue: Mock<(id: string) => Promise<LinearIssue | null>>
let mockCreateComment: Mock<(issueId: string, body: string, parentId?: string) => Promise<string>>
let mockCreateAgentActivity: Mock<(sessionId: string, content: string, type: string) => Promise<void>>

// ── constants ─────────────────────────────────────────────────────────────────
const OLLAMA_KEY = "sk-ollama-secret-key-do-not-log"
const ISSUE_ID = "issue-uuid-1"

const ISSUE: LinearIssue = {
  id: ISSUE_ID,
  identifier: "SIG-545",
  title: "Implement the thing",
  description: "Do the thing carefully",
  url: "https://linear.app/sigilix/issue/SIG-545",
  team: { id: "team-uuid", key: "SIG" },
  creator: null,
  labels: { nodes: [] },
  comments: { nodes: [] },
}

/** In-memory KV stub backing the per-ticket idempotency marker (get/put/delete). */
function makeKv(seed?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(seed ?? {}))
  return {
    store,
    get: vi.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    put: vi.fn((k: string, v: string) => {
      store.set(k, v)
      return Promise.resolve(undefined)
    }),
    delete: vi.fn((k: string) => {
      store.delete(k)
      return Promise.resolve(undefined)
    }),
  }
}

function makeEnv(extra?: Record<string, unknown>): Env {
  return {
    OPENCLAW_TEAM_GITHUB_REPO_MAP: JSON.stringify({ SIG: { owner: "Sigilix", repo: "sigilix" } }),
    OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ "Sigilix/sigilix": "99" }),
    OLLAMA_API_KEY: OLLAMA_KEY,
    LINEAR_API_KEY: "linear-key",
    OPENCLAW_STATE: makeKv(),
    ...extra,
  } as unknown as Env
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("runLinearAgentRun", () => {
  let spyLog: MockInstance
  let spyWarn: MockInstance
  let spyError: MockInstance

  beforeEach(() => {
    vi.clearAllMocks()
    spyLog = vi.spyOn(console, "log").mockImplementation(() => undefined)
    spyWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    spyError = vi.spyOn(console, "error").mockImplementation(() => undefined)

    mockGetIssue = vi.fn<(id: string) => Promise<LinearIssue | null>>(() => Promise.resolve(ISSUE))
    mockCreateComment = vi.fn<(issueId: string, body: string, parentId?: string) => Promise<string>>(() =>
      Promise.resolve("comment-id"),
    )
    MockLinearClient.mockImplementation(
      () => ({ getIssue: mockGetIssue, createComment: mockCreateComment }) as unknown as LinearClient,
    )
    mockCreateAgentActivity = vi.fn<(sessionId: string, content: string, type: string) => Promise<void>>(() =>
      Promise.resolve(undefined),
    )
    mockBuildLinearAgentClient.mockResolvedValue({
      createAgentActivity: mockCreateAgentActivity,
    } as unknown as LinearClient)
    mockBuildLinearAuth.mockResolvedValue({ apiKey: "linear-key" })
    mockDispatchAgentRun.mockResolvedValue({ runId: "run-1", dispatched: true })
  })

  afterEach(() => {
    spyLog.mockRestore()
    spyWarn.mockRestore()
    spyError.mockRestore()
  })

  // ── (a) happy path ────────────────────────────────────────────────────────

  it("dispatches the agent-runner with the correct minimal-engine input + posts the ack", async () => {
    await runLinearAgentRun(ISSUE_ID, makeEnv())

    expect(mockDispatchAgentRun).toHaveBeenCalledOnce()
    const input = mockDispatchAgentRun.mock.calls[0]![1] as AgentRunTaskInput
    expect(input.owner).toBe("Sigilix")
    expect(input.repo).toBe("sigilix")
    expect(input.baseBranch).toBe("main")
    expect(input.installationId).toBe(99)
    expect(input.engine).toBe("minimal")
    expect(input.model.id).toBe("glm-5.2:cloud")
    expect(input.model.baseUrl).toBe("https://ollama.com/v1")
    expect(input.model.key).toBe(OLLAMA_KEY)
    expect(input.ticket).toEqual({
      identifier: "SIG-545",
      title: "Implement the thing",
      body: "Do the thing carefully",
      url: "https://linear.app/sigilix/issue/SIG-545",
    })
    expect(input.caps).toEqual({ maxModelCalls: 12, maxTokens: 800_000, timeoutMs: 600_000 })

    // Best-effort Linear ack on the issue.
    expect(mockCreateComment).toHaveBeenCalledOnce()
    expect(mockCreateComment.mock.calls[0]![0]).toBe(ISSUE_ID)
  })

  it("AgentSession path (sessionId present) → posts a NON-terminal `action` activity, NOT a comment", async () => {
    await runLinearAgentRun(ISSUE_ID, makeEnv(), "agent-session-1")

    expect(mockDispatchAgentRun).toHaveBeenCalledOnce()
    expect(mockCreateAgentActivity).toHaveBeenCalledOnce()
    // NON-terminal `action` — a terminal `response` would close the session turn at
    // dispatch time, before the container has opened the PR.
    expect(mockCreateAgentActivity).toHaveBeenCalledWith("agent-session-1", expect.any(String), "action")
    expect(mockCreateAgentActivity).not.toHaveBeenCalledWith("agent-session-1", expect.any(String), "response")
    // No plain comment ack on the agent-session path.
    expect(mockCreateComment).not.toHaveBeenCalled()
  })

  it("AgentSession path swallows an activity-post failure (never throws; still dispatched)", async () => {
    mockCreateAgentActivity.mockRejectedValue(new Error("Linear API down"))
    await expect(runLinearAgentRun(ISSUE_ID, makeEnv(), "agent-session-1")).resolves.toBeUndefined()
    expect(mockDispatchAgentRun).toHaveBeenCalledOnce()
  })

  it('engine is ALWAYS "minimal" (untrusted input path — never "full")', async () => {
    await runLinearAgentRun(ISSUE_ID, makeEnv())
    const input = mockDispatchAgentRun.mock.calls[0]![1] as AgentRunTaskInput
    expect(input.engine).toBe("minimal")
    expect(input.engine).not.toBe("full")
  })

  it("falls back to an empty ticket body when the issue has no description", async () => {
    mockGetIssue.mockResolvedValue({ ...ISSUE, description: null })
    await runLinearAgentRun(ISSUE_ID, makeEnv())
    const input = mockDispatchAgentRun.mock.calls[0]![1] as AgentRunTaskInput
    expect(input.ticket.body).toBe("")
  })

  it("does NOT post an ack when dispatch reports dispatched:false", async () => {
    mockDispatchAgentRun.mockResolvedValue({ runId: "run-1", dispatched: false })
    await runLinearAgentRun(ISSUE_ID, makeEnv())
    expect(mockCreateComment).not.toHaveBeenCalled()
  })

  it("swallows an ack failure (never throws; still counts as dispatched)", async () => {
    mockCreateComment.mockRejectedValue(new Error("Linear API down"))
    await expect(runLinearAgentRun(ISSUE_ID, makeEnv())).resolves.toBeUndefined()
    expect(mockDispatchAgentRun).toHaveBeenCalledOnce()
  })

  // ── per-ticket idempotency (SIG-545 B3) ─────────────────────────────────────

  it("dedupes a repeat run for the same issue (marker present → no dispatch)", async () => {
    const kv = makeKv({ "linear-agent-run:issue-uuid-1": "1" })
    await runLinearAgentRun(ISSUE_ID, makeEnv({ OPENCLAW_STATE: kv }))
    expect(mockDispatchAgentRun).not.toHaveBeenCalled()
    expect(spyLog.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-run-deduped")
  })

  it("sets the idempotency marker (1h TTL) before dispatching", async () => {
    const kv = makeKv()
    await runLinearAgentRun(ISSUE_ID, makeEnv({ OPENCLAW_STATE: kv }))
    expect(kv.put).toHaveBeenCalledWith("linear-agent-run:issue-uuid-1", "1", { expirationTtl: 3600 })
    expect(mockDispatchAgentRun).toHaveBeenCalledOnce()
  })

  it("releases the marker on a no-op dispatch (dispatched:false) so retries aren't suppressed", async () => {
    mockDispatchAgentRun.mockResolvedValue({ runId: "run-1", dispatched: false })
    const kv = makeKv()
    await runLinearAgentRun(ISSUE_ID, makeEnv({ OPENCLAW_STATE: kv }))
    expect(kv.delete).toHaveBeenCalledWith("linear-agent-run:issue-uuid-1")
    expect(kv.store.has("linear-agent-run:issue-uuid-1")).toBe(false)
  })

  // ── (b) no team→repo mapping ────────────────────────────────────────────────

  it("does NOT dispatch when the issue's team has no repo mapping", async () => {
    const env = makeEnv({ OPENCLAW_TEAM_GITHUB_REPO_MAP: JSON.stringify({ OTHER: { owner: "x", repo: "y" } }) })
    await runLinearAgentRun(ISSUE_ID, env)
    expect(mockDispatchAgentRun).not.toHaveBeenCalled()
    expect(spyWarn.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-run-no-repo-mapping")
  })

  // ── (c) no installation ─────────────────────────────────────────────────────

  it("does NOT dispatch when no installation resolves for the repo", async () => {
    const env = makeEnv({ OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ "other/repo": "1" }) })
    await runLinearAgentRun(ISSUE_ID, env)
    expect(mockDispatchAgentRun).not.toHaveBeenCalled()
    expect(spyWarn.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-run-no-installation")
  })

  // ── (d) no OLLAMA_API_KEY ───────────────────────────────────────────────────

  it("does NOT dispatch when OLLAMA_API_KEY is unset", async () => {
    const env = makeEnv({ OLLAMA_API_KEY: undefined })
    await runLinearAgentRun(ISSUE_ID, env)
    expect(mockDispatchAgentRun).not.toHaveBeenCalled()
    expect(spyWarn.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-run-no-model-key")
  })

  // ── (e) issue not found ─────────────────────────────────────────────────────

  it("does NOT dispatch when the issue is not found", async () => {
    mockGetIssue.mockResolvedValue(null)
    await runLinearAgentRun(ISSUE_ID, makeEnv())
    expect(mockDispatchAgentRun).not.toHaveBeenCalled()
    expect(spyWarn.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-run-issue-not-found")
  })

  // ── (f) secrets never logged ────────────────────────────────────────────────

  it("never logs the model key in any console output", async () => {
    await runLinearAgentRun(ISSUE_ID, makeEnv())
    const allOutput = [
      ...spyLog.mock.calls.flat().map(String),
      ...spyWarn.mock.calls.flat().map(String),
      ...spyError.mock.calls.flat().map(String),
    ].join("\n")
    expect(allOutput).toContain("linear-agent-run-dispatched")
    expect(allOutput).not.toContain(OLLAMA_KEY)
  })

  it("never throws out (a thrown getIssue is logged + swallowed)", async () => {
    mockGetIssue.mockRejectedValue(new Error("Linear unreachable"))
    await expect(runLinearAgentRun(ISSUE_ID, makeEnv())).resolves.toBeUndefined()
    expect(spyError.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-run-failed")
  })
})

// ── dispatchTicketImplementation (SIG-545 B3b shared core) ──────────────────────

describe("dispatchTicketImplementation", () => {
  let spyLog: MockInstance
  let spyWarn: MockInstance
  let spyError: MockInstance

  const TICKET = {
    identifier: "SIG-545",
    title: "Implement the thing",
    body: "Do the thing carefully",
    url: "https://linear.app/sigilix/issue/SIG-545",
  }
  const DEDUPE_ID = "issue-uuid-1"
  const DEDUPE_KEY = `linear-agent-run:${DEDUPE_ID}`

  function args() {
    return { owner: "Sigilix", repo: "sigilix", installationId: 99, ticket: TICKET, dedupeId: DEDUPE_ID }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    spyLog = vi.spyOn(console, "log").mockImplementation(() => undefined)
    spyWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    spyError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    mockDispatchAgentRun.mockResolvedValue({ runId: "run-1", dispatched: true })
  })

  afterEach(() => {
    spyLog.mockRestore()
    spyWarn.mockRestore()
    spyError.mockRestore()
  })

  it("happy path → dispatched:true + correct minimal-engine AgentRunTaskInput + sets the marker", async () => {
    const kv = makeKv()
    const result = await dispatchTicketImplementation(makeEnv({ OPENCLAW_STATE: kv }), args())

    expect(result).toEqual({ dispatched: true })
    expect(mockDispatchAgentRun).toHaveBeenCalledOnce()
    const input = mockDispatchAgentRun.mock.calls[0]![1] as AgentRunTaskInput
    expect(input.owner).toBe("Sigilix")
    expect(input.repo).toBe("sigilix")
    expect(input.baseBranch).toBe("main")
    expect(input.installationId).toBe(99)
    expect(input.engine).toBe("minimal")
    expect(input.model.id).toBe("glm-5.2:cloud")
    expect(input.model.baseUrl).toBe("https://ollama.com/v1")
    expect(input.model.key).toBe(OLLAMA_KEY)
    expect(input.ticket).toEqual(TICKET)
    expect(input.caps).toEqual({ maxModelCalls: 12, maxTokens: 800_000, timeoutMs: 600_000 })
    expect(kv.put).toHaveBeenCalledWith(DEDUPE_KEY, "1", { expirationTtl: 3600 })
  })

  it("dedupes when the marker is already present (no dispatch)", async () => {
    const kv = makeKv({ [DEDUPE_KEY]: "1" })
    const result = await dispatchTicketImplementation(makeEnv({ OPENCLAW_STATE: kv }), args())

    expect(result).toEqual({ dispatched: false })
    expect(mockDispatchAgentRun).not.toHaveBeenCalled()
    expect(spyLog.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-run-deduped")
  })

  it("returns dispatched:false (no dispatch, no marker) when OLLAMA_API_KEY is unset", async () => {
    const kv = makeKv()
    const result = await dispatchTicketImplementation(
      makeEnv({ OPENCLAW_STATE: kv, OLLAMA_API_KEY: undefined }),
      args(),
    )

    expect(result).toEqual({ dispatched: false })
    expect(mockDispatchAgentRun).not.toHaveBeenCalled()
    expect(kv.put).not.toHaveBeenCalled()
    expect(spyWarn.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-run-no-model-key")
  })

  it("releases the marker when dispatch reports dispatched:false", async () => {
    mockDispatchAgentRun.mockResolvedValue({ runId: "run-1", dispatched: false })
    const kv = makeKv()
    const result = await dispatchTicketImplementation(makeEnv({ OPENCLAW_STATE: kv }), args())

    expect(result).toEqual({ dispatched: false })
    expect(kv.delete).toHaveBeenCalledWith(DEDUPE_KEY)
    expect(kv.store.has(DEDUPE_KEY)).toBe(false)
  })

  it("never logs the model key", async () => {
    await dispatchTicketImplementation(makeEnv(), args())
    const allOutput = [
      ...spyLog.mock.calls.flat().map(String),
      ...spyWarn.mock.calls.flat().map(String),
      ...spyError.mock.calls.flat().map(String),
    ].join("\n")
    expect(allOutput).not.toContain(OLLAMA_KEY)
  })
})
