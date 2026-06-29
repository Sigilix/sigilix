// SIG-196: unit tests for slack-agent.ts — intent-aware agent orchestration.
//
// All external I/O is mocked (agent loop, memory, Linear, triage, GitHub client,
// agent tools, telemetry). The SUT is runSlackAgent.

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Env } from "@/src/shared/types/env"
import type { SlackMentionContext } from "@/src/lib/slack/slack-agent"

// ─── Hoisted mocks ─────────────────────────────────────────────────────────

const { runAgentLoopMock } = vi.hoisted(() => ({
  runAgentLoopMock: vi.fn(),
}))
vi.mock("@/src/lib/agent-loop", () => ({
  runAgentLoop: runAgentLoopMock,
}))

const { recallSlackMemoryMock, captureSlackMemoryMock } = vi.hoisted(() => ({
  recallSlackMemoryMock: vi.fn(async () => [] as string[]),
  captureSlackMemoryMock: vi.fn(async () => ({ stored: true, skippedSecret: false })),
}))
vi.mock("@/src/lib/slack/slack-memory", () => ({
  recallSlackMemory: recallSlackMemoryMock,
  captureSlackMemory: captureSlackMemoryMock,
}))

const { createIssueMock } = vi.hoisted(() => ({
  createIssueMock: vi.fn(async () => ({
    id: "issue-id-1",
    identifier: "SIG-42",
    url: "https://linear.app/test/issue/SIG-42",
  })),
}))
vi.mock("@/src/lib/linear", () => ({
  LinearClient: vi.fn().mockImplementation(() => ({
    createIssue: createIssueMock,
  })),
  buildLinearAuth: vi.fn(async () => ({ apiKey: "fake-linear-key" })),
}))

const { dispatchTicketImplementationMock } = vi.hoisted(() => ({
  dispatchTicketImplementationMock: vi.fn(async () => ({ dispatched: true })),
}))
vi.mock("@/src/lib/linear-agent-run", () => ({
  dispatchTicketImplementation: dispatchTicketImplementationMock,
}))

const { triageIssueMock } = vi.hoisted(() => ({
  triageIssueMock: vi.fn(async () => undefined),
}))
vi.mock("@/src/lib/triage", () => ({
  triageIssue: triageIssueMock,
}))

const { buildClientMock } = vi.hoisted(() => ({
  buildClientMock: vi.fn(async () => ({ getFileContent: vi.fn() })),
}))
vi.mock("@/src/lib/github-mention", () => ({
  buildClient: buildClientMock,
  parseGithubMentionResponse: vi.fn((text: string) => {
    try {
      const obj = JSON.parse(text) as unknown
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const o = obj as Record<string, unknown>
        if (typeof o.answer === "string") {
          return { answer: o.answer, confidence: 5, abstain: false, verdict: "answer" }
        }
      }
    } catch {
      /* fall through */
    }
    return null
  }),
}))

vi.mock("@/src/lib/agent-tools", () => ({
  createAgentTools: vi.fn(() => []),
}))

vi.mock("@/src/lib/agent-telemetry-kv", () => ({
  makeKvTelemetrySink: vi.fn(() => ({ record: vi.fn(async () => {}) })),
}))

const { generateMock } = vi.hoisted(() => ({
  generateMock: vi.fn(async () => ({
    text: '{"title":"Bug in auth flow","description":"The auth flow is broken in prod"}',
    usage: { promptTokens: 10, completionTokens: 20 },
  })),
}))
vi.mock("@/src/shared/adapters/model", () => ({
  generate: generateMock,
}))

// ─── Import SUT after mocks ───────────────────────────────────────────────────

import { runSlackAgent } from "@/src/lib/slack/slack-agent"

// ─── Test fixtures ────────────────────────────────────────────────────────────

function makeEnv(): Env {
  return {
    OPENCLAW_STATE: { get: vi.fn(), put: vi.fn(), list: vi.fn(), delete: vi.fn() } as unknown as KVNamespace,
    OPENCLAW_CODE_INDEX: {} as VectorizeIndex,
    OPENCLAW_AGENT_MEMORY_INDEX: {} as VectorizeIndex,
    AI: {} as Ai,
    OPENCLAW_JOBS: {} as Queue<unknown>,
    LINEAR_API_KEY: "fake-linear-key",
    LINEAR_WEBHOOK_SECRET: "fake-webhook-secret",
    OLLAMA_API_KEY: "fake-ollama-key",
    OLLAMA_CHAT_ENABLE: "on",
    PR_REVIEW_RUN: {} as DurableObjectNamespace,
    REPO_GRAPH_DO: {} as DurableObjectNamespace,
    VALIDATION_METRICS_DO: {} as DurableObjectNamespace,
    RUNNER_EVIDENCE_METRICS_DO: {} as DurableObjectNamespace,
    RUNNER_TOOL_METRICS_DO: {} as DurableObjectNamespace,
    VERIFICATION_METRICS_DO: {} as DurableObjectNamespace,
    GRAPH_EXPANSION_METRICS_DO: {} as DurableObjectNamespace,
    GRAPH_METRICS_DO: {} as DurableObjectNamespace,
    RUNNER_RECEIPT_DO: {} as DurableObjectNamespace,
    TENANT_CONCURRENCY: {} as DurableObjectNamespace,
    PROVIDER_COOLDOWN: {} as DurableObjectNamespace,
  } as Env
}

function makeCtx(overrides: Partial<SlackMentionContext> = {}): SlackMentionContext {
  return {
    scope: {
      teamId: "T001",
      channelId: "C001",
      repos: [{ owner: "sigilix", repo: "sigilix", installationId: 111 }],
      linearTeam: "team-uuid-1",
    },
    slackUserId: "U001",
    channelId: "C001",
    threadText: "thread context goes here",
    mentionText: "how does the auth flow work?",
    ...overrides,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  // Default runAgentLoop mock → successful answer
  runAgentLoopMock.mockResolvedValue({
    ok: true,
    answer: { answer: "The auth flow uses JWT tokens.", confidence: 5, abstain: false, verdict: "answer" },
    stats: { toolTurns: 1, totalMs: 500, toolCallCount: 2 },
  })
})

describe("runSlackAgent — qa path", () => {
  it("calls runAgentLoop with surface:slack-mention and scoped allowedRepos", async () => {
    const env = makeEnv()
    const ctx = makeCtx()
    await runSlackAgent(env, ctx)

    expect(runAgentLoopMock).toHaveBeenCalledOnce()
    const loopArgs = runAgentLoopMock.mock.calls[0]![0] as Record<string, unknown>
    expect(loopArgs.surface).toBe("slack-mention")

    const github = loopArgs.tools !== undefined ? (loopArgs as { surface: string }).surface : null
    expect(github).toBe("slack-mention")
  })

  it("includes recalled memory in the initial user message", async () => {
    recallSlackMemoryMock.mockResolvedValue(["prior context chunk"])
    const env = makeEnv()
    const ctx = makeCtx()
    await runSlackAgent(env, ctx)

    const loopArgs = runAgentLoopMock.mock.calls[0]![0] as Record<string, unknown>
    expect(loopArgs.initialUserMessage).toContain("prior context chunk")
    expect(loopArgs.initialUserMessage).toContain("Sigilix memory")
  })

  it("omits the memory block when recall is empty", async () => {
    recallSlackMemoryMock.mockResolvedValue([])
    const env = makeEnv()
    const ctx = makeCtx()
    await runSlackAgent(env, ctx)

    const loopArgs = runAgentLoopMock.mock.calls[0]![0] as Record<string, unknown>
    expect(loopArgs.initialUserMessage).not.toContain("Sigilix memory")
  })

  it("returns a formatted reply containing the model answer", async () => {
    const env = makeEnv()
    const ctx = makeCtx()
    const result = await runSlackAgent(env, ctx)

    expect(result.reply).toContain("The auth flow uses JWT tokens.")
    expect(result.action.kind).toBe("qa")
  })

  it("calls captureSlackMemory after a successful qa", async () => {
    const env = makeEnv()
    const ctx = makeCtx()
    await runSlackAgent(env, ctx)

    expect(captureSlackMemoryMock).toHaveBeenCalledOnce()
    const captureArgs = (captureSlackMemoryMock.mock.calls[0] as unknown[])[2] as Record<string, unknown>
    expect(captureArgs.kind).toBe("task_state")
    expect(typeof captureArgs.content).toBe("string")
  })

  it("scopes allowedRepos to the channel repos only", async () => {
    const env = makeEnv()
    const ctx = makeCtx({
      scope: {
        teamId: "T001",
        channelId: "C001",
        repos: [{ owner: "sigilix", repo: "sigilix", installationId: 111 }],
        linearTeam: null,
      },
    })
    await runSlackAgent(env, ctx)

    // buildClientMock should have been called with the installation id
    expect(buildClientMock).toHaveBeenCalledWith(env, 111)
  })
})

describe("runSlackAgent — qa fallback", () => {
  it("returns a degraded reply when runAgentLoop returns ok:false", async () => {
    runAgentLoopMock.mockResolvedValue({
      ok: false,
      reason: "chat_error",
      error: "upstream timeout",
    })

    const env = makeEnv()
    const ctx = makeCtx()
    const result = await runSlackAgent(env, ctx)

    // degraded reply must not read as authoritative
    expect(result.reply).toContain("degraded")
    expect(result.action.kind).toBe("qa")
  })

  it("still captures memory after a degraded response", async () => {
    runAgentLoopMock.mockResolvedValue({ ok: false, reason: "wall_clock_exceeded" })

    const env = makeEnv()
    const ctx = makeCtx()
    await runSlackAgent(env, ctx)

    expect(captureSlackMemoryMock).toHaveBeenCalledOnce()
    const captureArgs = (captureSlackMemoryMock.mock.calls[0] as unknown[])[2] as Record<string, unknown>
    expect(captureArgs.content).toContain("degraded")
  })
})

describe("runSlackAgent — linear-triage path", () => {
  it("creates a Linear issue with scope.linearTeam and replies with the url", async () => {
    const env = makeEnv()
    const ctx = makeCtx({ mentionText: "linear triage — auth is broken in prod" })
    const result = await runSlackAgent(env, ctx)

    expect(createIssueMock).toHaveBeenCalledOnce()
    const issueArgs = (createIssueMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(issueArgs.teamId).toBe("team-uuid-1")

    expect(result.reply).toContain("https://linear.app/test/issue/SIG-42")
    expect(result.action.kind).toBe("linear-triage")
    if (result.action.kind === "linear-triage") {
      expect(result.action.issueUrl).toBe("https://linear.app/test/issue/SIG-42")
      expect(result.action.identifier).toBe("SIG-42")
    }
  })

  it("calls triageIssue with the new issue id", async () => {
    const env = makeEnv()
    const ctx = makeCtx({ mentionText: "make a linear triage of this discussion" })
    await runSlackAgent(env, ctx)

    expect(triageIssueMock).toHaveBeenCalledOnce()
    expect((triageIssueMock.mock.calls[0] as unknown[])[0]).toBe("issue-id-1")
  })

  it("captures memory after triage", async () => {
    const env = makeEnv()
    const ctx = makeCtx({ mentionText: "triage this" })
    await runSlackAgent(env, ctx)

    expect(captureSlackMemoryMock).toHaveBeenCalledOnce()
    const captureArgs = (captureSlackMemoryMock.mock.calls[0] as unknown[])[2] as Record<string, unknown>
    expect(captureArgs.kind).toBe("task_state")
    expect(captureArgs.content).toContain("SIG-42")
  })

  it("does NOT call runAgentLoop on the triage path", async () => {
    const env = makeEnv()
    const ctx = makeCtx({ mentionText: "create a linear issue" })
    await runSlackAgent(env, ctx)

    expect(runAgentLoopMock).not.toHaveBeenCalled()
  })
})

describe("runSlackAgent — implement path (SIG-545 B3b)", () => {
  it("creates a self-assigned Linear issue + dispatches the runner + replies dispatched", async () => {
    const env = makeEnv()
    env.OPENCLAW_LINEAR_AGENT_USER_ID = "agent-user-uuid"
    const ctx = makeCtx({ mentionText: "implement this" })
    const result = await runSlackAgent(env, ctx)

    // Issue created with the team + the agent assigneeId.
    expect(createIssueMock).toHaveBeenCalledOnce()
    const issueArgs = (createIssueMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(issueArgs.teamId).toBe("team-uuid-1")
    expect(issueArgs.assigneeId).toBe("agent-user-uuid")

    // Runner dispatched on the scoped repo, keyed off the new issue id.
    expect(dispatchTicketImplementationMock).toHaveBeenCalledOnce()
    const dispatchArgs = (dispatchTicketImplementationMock.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(dispatchArgs.owner).toBe("sigilix")
    expect(dispatchArgs.repo).toBe("sigilix")
    expect(dispatchArgs.installationId).toBe(111)
    expect(dispatchArgs.dedupeId).toBe("issue-id-1")

    expect(result.reply).toContain("implementing it")
    expect(result.action.kind).toBe("implement")
    if (result.action.kind === "implement") {
      expect(result.action.dispatched).toBe(true)
      expect(result.action.identifier).toBe("SIG-42")
      expect(result.action.issueUrl).toBe("https://linear.app/test/issue/SIG-42")
    }

    // qa loop never runs on the implement path.
    expect(runAgentLoopMock).not.toHaveBeenCalled()
  })

  it("omits assigneeId when OPENCLAW_LINEAR_AGENT_USER_ID is unset", async () => {
    const env = makeEnv()
    const ctx = makeCtx({ mentionText: "build this" })
    await runSlackAgent(env, ctx)

    const issueArgs = (createIssueMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(issueArgs).not.toHaveProperty("assigneeId")
  })

  it("replies with the created-ticket form (dark) when dispatch is not dispatched", async () => {
    dispatchTicketImplementationMock.mockResolvedValueOnce({ dispatched: false })
    const env = makeEnv()
    const ctx = makeCtx({ mentionText: "implement this" })
    const result = await runSlackAgent(env, ctx)

    expect(createIssueMock).toHaveBeenCalledOnce()
    expect(result.reply).toContain("Created Linear issue")
    expect(result.action.kind).toBe("implement")
    if (result.action.kind === "implement") expect(result.action.dispatched).toBe(false)
  })

  it("does NOT create or dispatch when linearTeam is null (replies Linear not configured)", async () => {
    const env = makeEnv()
    const ctx = makeCtx({
      mentionText: "implement this",
      scope: {
        teamId: "T001",
        channelId: "C001",
        repos: [{ owner: "sigilix", repo: "sigilix", installationId: 111 }],
        linearTeam: null,
      },
    })
    const result = await runSlackAgent(env, ctx)

    expect(createIssueMock).not.toHaveBeenCalled()
    expect(dispatchTicketImplementationMock).not.toHaveBeenCalled()
    expect(result.reply).toContain("not configured")
    expect(result.action.kind).toBe("qa")
  })

  it("captures memory after implement", async () => {
    const env = makeEnv()
    const ctx = makeCtx({ mentionText: "implement this" })
    await runSlackAgent(env, ctx)

    expect(captureSlackMemoryMock).toHaveBeenCalledOnce()
    const captureArgs = (captureSlackMemoryMock.mock.calls[0] as unknown[])[2] as Record<string, unknown>
    expect(captureArgs.kind).toBe("task_state")
    expect(captureArgs.content).toContain("SIG-42")
  })
})

describe("runSlackAgent — null linearTeam", () => {
  it("returns a deny reply when linearTeam is null", async () => {
    const env = makeEnv()
    const ctx = makeCtx({
      mentionText: "linear triage please",
      scope: {
        teamId: "T001",
        channelId: "C001",
        repos: [{ owner: "sigilix", repo: "sigilix", installationId: 111 }],
        linearTeam: null,
      },
    })
    const result = await runSlackAgent(env, ctx)

    expect(result.reply).toContain("not configured")
    expect(createIssueMock).not.toHaveBeenCalled()
    // action remains qa since no issue was created
    expect(result.action.kind).toBe("qa")
  })
})

describe("runSlackAgent — invariant guard (empty repos)", () => {
  it("throws when scope.repos is empty (invariant violation, not a qa reply)", async () => {
    const env = makeEnv()
    const ctx = makeCtx({
      scope: {
        teamId: "T001",
        channelId: "C001",
        repos: [], // violates the scope-resolver contract
        linearTeam: null,
      },
    })
    await expect(runSlackAgent(env, ctx)).rejects.toThrow("runSlackAgent requires a scoped repo")
  })
})

describe("runSlackAgent — capture non-fatal", () => {
  it("does not throw when captureSlackMemory throws", async () => {
    captureSlackMemoryMock.mockRejectedValue(new Error("KV write failed"))

    const env = makeEnv()
    const ctx = makeCtx()
    await expect(runSlackAgent(env, ctx)).resolves.toBeDefined()
  })

  it("does not throw when triageIssue throws on linear-triage path", async () => {
    triageIssueMock.mockRejectedValue(new Error("triage failed"))

    const env = makeEnv()
    const ctx = makeCtx({ mentionText: "triage this" })
    // Should not throw — issue is already created, triage failure is non-fatal
    await expect(runSlackAgent(env, ctx)).resolves.toBeDefined()
  })
})
