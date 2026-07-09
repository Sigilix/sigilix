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
  // SIG-144 slice 4: the triage/implement/offer-confirm paths now build their
  // client via buildLinearClient instead of `new LinearClient(await buildLinearAuth(env))`.
  buildLinearClient: vi.fn(async () => ({ createIssue: createIssueMock })),
}))

const { dispatchTicketImplementationMock } = vi.hoisted(() => ({
  dispatchTicketImplementationMock: vi.fn(async () => ({ dispatched: true })),
}))
vi.mock("@/src/lib/linear-agent-run", () => ({
  dispatchTicketImplementation: dispatchTicketImplementationMock,
}))

// B3c offer state: mock the KV-backed accessors so each test drives the pending
// offer + asserts set/clear; keep the real classifyOfferReply (the regex is the SUT
// of slack-implement-offer.test.ts and routes confirm/revise here).
const { getImplementOfferMock, setImplementOfferMock, clearImplementOfferMock } = vi.hoisted(() => ({
  getImplementOfferMock: vi.fn(async () => null as { plan: string; title: string } | null),
  setImplementOfferMock: vi.fn(async () => {}),
  clearImplementOfferMock: vi.fn(async () => {}),
}))
vi.mock("@/src/lib/slack/slack-implement-offer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/slack/slack-implement-offer")>()
  return {
    ...actual,
    getImplementOffer: getImplementOfferMock,
    setImplementOffer: setImplementOfferMock,
    clearImplementOffer: clearImplementOfferMock,
  }
})

const { triageIssueMock } = vi.hoisted(() => ({
  triageIssueMock: vi.fn(async () => undefined),
}))
vi.mock("@/src/lib/triage", () => ({
  triageIssue: triageIssueMock,
}))

const { buildClientMock, parseGithubMentionResponseMock } = vi.hoisted(() => ({
  buildClientMock: vi.fn(async () => ({ getFileContent: vi.fn() })),
  // Hoisted so a test can drive abstain via mockReturnValueOnce; the default
  // parses the answer with abstain:false.
  parseGithubMentionResponseMock: vi.fn((text: string) => {
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
vi.mock("@/src/lib/github-mention", () => ({
  buildClient: buildClientMock,
  parseGithubMentionResponse: parseGithubMentionResponseMock,
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

// Unified learnings capture — mock ONLY the LLM extractor (the quality gate) so
// the real captureInstructiveLearning → appendLearning → KV path runs against a
// real in-memory store. Default declines (nothing instructive) so the pre-existing
// qa/triage/implement tests keep byte-identical behavior.
const { extractLearningMock } = vi.hoisted(() => ({
  extractLearningMock: vi.fn(async () => null as { rule: string; polarity: "require" } | null),
}))
vi.mock("@/src/features/learnings/adapters/extractor-model", () => ({
  extractLearning: extractLearningMock,
}))

// ─── Import SUT after mocks ───────────────────────────────────────────────────

import { runSlackAgent } from "@/src/lib/slack/slack-agent"
import { learningsKey } from "@/src/features/learnings/domain/store-ops"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { applyCostMigrations } from "@/src/test-shims/apply-cost-migrations"
import { readUsageEventCount } from "@/src/features/tenancy"

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

// B3c ships DARK behind OPENCLAW_LINEAR_AGENT_RUN_MODE. The offer UX (and the
// pending-offer follow-up routing) only runs with the mode "on"; makeEnv leaves it
// unset (off) so the qa/triage/implement tests above exercise byte-identical
// behavior. Tests that drive the offer flow use this variant.
function makeEnvRunnerOn(): Env {
  const env = makeEnv()
  env.OPENCLAW_LINEAR_AGENT_RUN_MODE = "on"
  return env
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
    threadTs: "1700000000.000100",
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
  // Default: no pending offer → qa/triage/implement routing is byte-identical.
  getImplementOfferMock.mockResolvedValue(null)
  setImplementOfferMock.mockResolvedValue(undefined)
  clearImplementOfferMock.mockResolvedValue(undefined)
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

// ─── B3c: offer generation (qa path) ────────────────────────────────────────────

describe("runSlackAgent — B3c offer generation", () => {
  it("appends an offer block + stores the offer when the model emits one", async () => {
    // The offer-classifier single-shot step returns an implementable offer.
    generateMock.mockResolvedValueOnce({
      text: '{"shouldOffer":true,"title":"Add fetch retry","plan":"1. add retry wrapper\\n2. wire it in\\n3. add a test"}',
      usage: { promptTokens: 1, completionTokens: 1 },
    })

    const env = makeEnvRunnerOn()
    const ctx = makeCtx({ mentionText: "we should retry failed fetches" })
    const result = await runSlackAgent(env, ctx)

    expect(result.reply).toContain("The auth flow uses JWT tokens.")
    expect(result.reply).toContain("I can open a PR for this")
    expect(result.reply).toContain("add retry wrapper")
    expect(result.reply).toContain("@Sigilix yes")
    expect(result.action.kind).toBe("implement-offer")

    // The offer is remembered for the thread.
    expect(setImplementOfferMock).toHaveBeenCalledTimes(1)
    const setArgs = setImplementOfferMock.mock.calls[0] as unknown[]
    expect(setArgs[1]).toBe("C001")
    expect(setArgs[2]).toBe("1700000000.000100")
    expect(setArgs[3]).toMatchObject({ title: "Add fetch retry" })
  })

  it("returns a normal qa reply + stores nothing when the model declines to offer", async () => {
    // Default generateMock returns the triage JSON (no shouldOffer) → no offer.
    const env = makeEnvRunnerOn()
    const ctx = makeCtx()
    const result = await runSlackAgent(env, ctx)

    expect(result.reply).toContain("The auth flow uses JWT tokens.")
    expect(result.reply).not.toContain("I can open a PR for this")
    expect(result.action.kind).toBe("qa")
    expect(setImplementOfferMock).not.toHaveBeenCalled()
  })

  it("does not offer on a degraded (loop ok:false) answer", async () => {
    runAgentLoopMock.mockResolvedValue({ ok: false, reason: "chat_error" })
    const env = makeEnvRunnerOn()
    const ctx = makeCtx()
    const result = await runSlackAgent(env, ctx)

    expect(result.reply).toContain("degraded")
    expect(result.action.kind).toBe("qa")
    expect(setImplementOfferMock).not.toHaveBeenCalled()
    // No offer-classifier call on a degraded answer.
    expect(generateMock).not.toHaveBeenCalled()
  })

  it("is fully inert with the runner mode OFF: plain qa reply, no offer, no extra model call", async () => {
    // Same input the model WOULD offer on — but the runner mode is off (makeEnv
    // leaves OPENCLAW_LINEAR_AGENT_RUN_MODE unset), so B3c never engages and the
    // offer single-shot generate() is never reached.
    const env = makeEnv()
    const ctx = makeCtx({ mentionText: "we should retry failed fetches" })
    const result = await runSlackAgent(env, ctx)

    expect(result.reply).toContain("The auth flow uses JWT tokens.")
    expect(result.reply).not.toContain("I can open a PR for this")
    expect(result.action.kind).toBe("qa")
    // No offer state, and critically NO extra offer-classifier generate() call.
    expect(setImplementOfferMock).not.toHaveBeenCalled()
    expect(generateMock).not.toHaveBeenCalled()
  })

  it("does NOT offer when the grounded verdict abstains (mode on)", async () => {
    // Mode is on, but the answer is an abstain ("I don't know") → never offer a PR.
    parseGithubMentionResponseMock.mockReturnValueOnce({
      answer: "I'm not sure how the auth flow works.",
      confidence: 2,
      abstain: true,
      verdict: "answer",
    })

    const env = makeEnvRunnerOn()
    const ctx = makeCtx({ mentionText: "we should retry failed fetches" })
    const result = await runSlackAgent(env, ctx)

    expect(result.reply).toContain("I'm not sure how the auth flow works.")
    expect(result.reply).not.toContain("I can open a PR for this")
    expect(result.action.kind).toBe("qa")
    // The offer single-shot must be skipped on an abstain.
    expect(generateMock).not.toHaveBeenCalled()
    expect(setImplementOfferMock).not.toHaveBeenCalled()
  })
})

// ─── B3c: follow-up confirm ─────────────────────────────────────────────────────

describe("runSlackAgent — B3c confirm", () => {
  it("affirmative → creates a self-assigned ticket, dispatches, clears the offer", async () => {
    getImplementOfferMock.mockResolvedValueOnce({ plan: "the agreed plan", title: "the agreed title" })
    const env = makeEnvRunnerOn()
    env.OPENCLAW_LINEAR_AGENT_USER_ID = "agent-user-uuid"
    const ctx = makeCtx({ mentionText: "yes" })
    const result = await runSlackAgent(env, ctx)

    // Ticket created with the offer's title/plan, self-assigned.
    expect(createIssueMock).toHaveBeenCalledOnce()
    const issueArgs = (createIssueMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(issueArgs.teamId).toBe("team-uuid-1")
    expect(issueArgs.title).toBe("the agreed title")
    expect(issueArgs.description).toBe("the agreed plan")
    expect(issueArgs.assigneeId).toBe("agent-user-uuid")

    // Runner dispatched on the scoped repo with the agreed plan as the body.
    expect(dispatchTicketImplementationMock).toHaveBeenCalledOnce()
    const dispatchArgs = (dispatchTicketImplementationMock.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(dispatchArgs.owner).toBe("sigilix")
    expect(dispatchArgs.repo).toBe("sigilix")
    expect(dispatchArgs.dedupeId).toBe("issue-id-1")
    expect(dispatchArgs.ticket).toMatchObject({ body: "the agreed plan", title: "the agreed title" })

    expect(result.reply).toContain("On it")
    expect(result.action.kind).toBe("implement-confirm")
    if (result.action.kind === "implement-confirm") {
      expect(result.action.dispatched).toBe(true)
      expect(result.action.identifier).toBe("SIG-42")
    }

    // Offer cleared; the revise loop never runs on a confirm.
    expect(clearImplementOfferMock).toHaveBeenCalledTimes(1)
    expect(runAgentLoopMock).not.toHaveBeenCalled()
  })

  it("affirmative + dark dispatch → reply degrades to 'queued'", async () => {
    getImplementOfferMock.mockResolvedValueOnce({ plan: "p", title: "t" })
    dispatchTicketImplementationMock.mockResolvedValueOnce({ dispatched: false })
    const env = makeEnvRunnerOn()
    const ctx = makeCtx({ mentionText: "go ahead" })
    const result = await runSlackAgent(env, ctx)

    expect(createIssueMock).toHaveBeenCalledOnce()
    expect(result.reply).toContain("queued")
    expect(result.action.kind).toBe("implement-confirm")
    if (result.action.kind === "implement-confirm") expect(result.action.dispatched).toBe(false)
  })

  it("affirmative but no linearTeam → not-configured reply, no create/dispatch, offer cleared", async () => {
    getImplementOfferMock.mockResolvedValueOnce({ plan: "p", title: "t" })
    const env = makeEnvRunnerOn()
    const ctx = makeCtx({
      mentionText: "do it",
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
    expect(clearImplementOfferMock).toHaveBeenCalledTimes(1)
  })
})

// ─── B3c: follow-up routing is dark when the runner mode is OFF ──────────────────

describe("runSlackAgent — B3c follow-up gated off", () => {
  it("with the mode OFF, the pending-offer KV is never read: 'yes' falls through to qa", async () => {
    // The mode being off means the precedence check never runs — getImplementOffer
    // is not even consulted, so a "yes" routes to plain qa (no confirm, no dispatch)
    // exactly as it did before B3c.
    const env = makeEnv()
    const ctx = makeCtx({ mentionText: "yes" })
    const result = await runSlackAgent(env, ctx)

    expect(getImplementOfferMock).not.toHaveBeenCalled()
    expect(clearImplementOfferMock).not.toHaveBeenCalled()
    expect(createIssueMock).not.toHaveBeenCalled()
    expect(dispatchTicketImplementationMock).not.toHaveBeenCalled()
    expect(result.action.kind).toBe("qa")
  })
})

// ─── B3c: follow-up decline ─────────────────────────────────────────────────────

describe("runSlackAgent — B3c decline", () => {
  it.each(["no", "never mind", "cancel"])(
    "%j → clears the offer, no dispatch, no re-plan, action=implement-decline",
    async (text) => {
      getImplementOfferMock.mockResolvedValueOnce({ plan: "old plan", title: "old title" })
      const env = makeEnvRunnerOn()
      const ctx = makeCtx({ mentionText: text })
      const result = await runSlackAgent(env, ctx)

      // Offer dropped; nothing created or dispatched; no re-plan loop.
      expect(clearImplementOfferMock).toHaveBeenCalledTimes(1)
      expect(createIssueMock).not.toHaveBeenCalled()
      expect(dispatchTicketImplementationMock).not.toHaveBeenCalled()
      expect(runAgentLoopMock).not.toHaveBeenCalled()
      expect(setImplementOfferMock).not.toHaveBeenCalled()

      expect(result.action.kind).toBe("implement-decline")
      expect(result.reply).toContain("I'll leave it")
    },
  )
})

// ─── B3c: follow-up revise ──────────────────────────────────────────────────────

describe("runSlackAgent — B3c revise", () => {
  it("counter-proposal → re-plans, updates the stored offer, does NOT dispatch", async () => {
    getImplementOfferMock.mockResolvedValueOnce({ plan: "old plan", title: "old title" })
    runAgentLoopMock.mockResolvedValueOnce({
      ok: true,
      answer: { reply: "good call — I'll use a queue", plan: "1. add queue\n2. consumer", title: "Use a queue" },
      stats: { toolTurns: 1, totalMs: 500, toolCallCount: 1 },
    })
    const env = makeEnvRunnerOn()
    const ctx = makeCtx({ mentionText: "do it this way instead — use a queue" })
    const result = await runSlackAgent(env, ctx)

    // Grounded re-plan loop ran; no ticket created, no dispatch.
    expect(runAgentLoopMock).toHaveBeenCalledOnce()
    expect(createIssueMock).not.toHaveBeenCalled()
    expect(dispatchTicketImplementationMock).not.toHaveBeenCalled()

    // The stored offer is updated to the revised plan/title.
    expect(setImplementOfferMock).toHaveBeenCalledTimes(1)
    const setArgs = setImplementOfferMock.mock.calls[0] as unknown[]
    expect(setArgs[3]).toEqual({ plan: "1. add queue\n2. consumer", title: "Use a queue" })

    expect(result.reply).toContain("good call")
    expect(result.reply).toContain("@Sigilix yes")
    expect(result.action.kind).toBe("implement-revise")
    expect(clearImplementOfferMock).not.toHaveBeenCalled()
  })

  it("keeps the prior plan when the re-plan loop fails to parse", async () => {
    getImplementOfferMock.mockResolvedValueOnce({ plan: "old plan", title: "old title" })
    runAgentLoopMock.mockResolvedValueOnce({ ok: false, reason: "chat_error" })
    const env = makeEnvRunnerOn()
    const ctx = makeCtx({ mentionText: "tweak it: rename the flag" })
    const result = await runSlackAgent(env, ctx)

    expect(setImplementOfferMock).toHaveBeenCalledTimes(1)
    const setArgs = setImplementOfferMock.mock.calls[0] as unknown[]
    expect(setArgs[3]).toEqual({ plan: "old plan", title: "old title" })
    expect(dispatchTicketImplementationMock).not.toHaveBeenCalled()
    // Degraded — must not claim an update that didn't happen.
    expect(result.reply).toContain("degraded")
    expect(result.reply).toContain("unchanged")
    expect(result.reply).not.toContain("Updated the plan")
    expect(result.action.kind).toBe("implement-revise")
  })

  it("does NOT claim 'Updated the plan' on an ok-but-empty re-plan (plan unchanged)", async () => {
    // loop ok:true but the model returns no reply AND no new plan → newPlan falls
    // back to the old plan. Must read as unchanged, never as an update.
    getImplementOfferMock.mockResolvedValueOnce({ plan: "old plan", title: "old title" })
    runAgentLoopMock.mockResolvedValueOnce({
      ok: true,
      answer: { reply: "", plan: "", title: "" },
      stats: { toolTurns: 1, totalMs: 1, toolCallCount: 0 },
    })
    const env = makeEnvRunnerOn()
    const ctx = makeCtx({ mentionText: "tweak it: rename the flag" })
    const result = await runSlackAgent(env, ctx)

    // The offer is persisted unchanged (fallback to the prior plan/title).
    expect(setImplementOfferMock).toHaveBeenCalledTimes(1)
    const setArgs = setImplementOfferMock.mock.calls[0] as unknown[]
    expect(setArgs[3]).toEqual({ plan: "old plan", title: "old title" })

    expect(dispatchTicketImplementationMock).not.toHaveBeenCalled()
    expect(result.reply).not.toContain("Updated the plan")
    expect(result.reply).toContain("unchanged")
    expect(result.action.kind).toBe("implement-revise")
  })

  it("a pending offer takes precedence over a fresh implement-shaped follow-up", async () => {
    // "implement this" would normally route to runImplement; a pending offer wins
    // and (not being affirmative) routes to revise — detectSlackIntent is bypassed.
    getImplementOfferMock.mockResolvedValueOnce({ plan: "old plan", title: "old title" })
    runAgentLoopMock.mockResolvedValueOnce({
      ok: true,
      answer: { reply: "sure", plan: "revised plan", title: "revised title" },
      stats: { toolTurns: 1, totalMs: 1, toolCallCount: 0 },
    })
    const env = makeEnvRunnerOn()
    const ctx = makeCtx({ mentionText: "implement this" })
    const result = await runSlackAgent(env, ctx)

    expect(result.action.kind).toBe("implement-revise")
    expect(runAgentLoopMock).toHaveBeenCalledOnce()
    // The B3b implement path (create + immediate dispatch) must NOT run.
    expect(createIssueMock).not.toHaveBeenCalled()
    expect(dispatchTicketImplementationMock).not.toHaveBeenCalled()
  })
})

// ─── SIG-303: ORG-pool (slack) metering write-path ──────────────────────────────
describe("runSlackAgent — SIG-303 slack ORG-pool metering", () => {
  const M1 = readFileSync(new URL("../../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url), "utf8")
  const M4 = readFileSync(new URL("../../../migrations/0004_create_usage_events.sql", import.meta.url), "utf8")

  async function envWithDb(): Promise<{ env: Env; db: D1Database }> {
    const db = makeD1()
    await db.exec(M1)
    await db.exec(M4)
    await applyCostMigrations(db)
    const env = makeEnv()
    env.SIGILIX_PLATFORM_DB = db
    return { env, db }
  }

  it("records one slack ORG event (keyed to the installation, attributed to the slack user) per mention", async () => {
    const { env, db } = await envWithDb()
    await runSlackAgent(env, makeCtx()) // installationId 111, slackUserId U001
    const org = await readUsageEventCount(
      { SIGILIX_PLATFORM_DB: db },
      {
        meter: "slack",
        installationId: 111,
        sinceIso: "2000-01-01T00:00:00.000Z",
      },
    )
    expect(org).toEqual({ ok: true, count: 1 })
    const byUser = await readUsageEventCount(
      { SIGILIX_PLATFORM_DB: db },
      {
        meter: "slack",
        installationId: 111,
        userKey: "slack:U001",
        sinceIso: "2000-01-01T00:00:00.000Z",
      },
    )
    expect(byUser).toEqual({ ok: true, count: 1 })
  })

  it("enforce + over the org cap → a friendly limit reply, and NO extra event is recorded", async () => {
    const { env, db } = await envWithDb()
    env.SIGILIX_USAGE_METER_MODE = "enforce"
    env.SIGILIX_USAGE_CAP_ORG_SESSION = "1"
    env.SIGILIX_USAGE_CAP_ORG_WEEKLY = "-1"
    // Pre-fill the org pool to the cap so the NEXT mention is blocked (grace policy).
    await db
      .prepare(
        "INSERT INTO usage_events (meter, installation_id, user_key, surface, event_id, created_at) VALUES ('slack', 111, 'slack:prev', 'slack', NULL, ?)",
      )
      .bind(new Date().toISOString())
      .run()

    const result = await runSlackAgent(env, makeCtx())
    expect(result.reply).toContain("usage limit")
    // The blocked mention did not run the agent loop nor record another event.
    expect(runAgentLoopMock).not.toHaveBeenCalled()
    const org = await readUsageEventCount(
      { SIGILIX_PLATFORM_DB: db },
      {
        meter: "slack",
        installationId: 111,
        sinceIso: "2000-01-01T00:00:00.000Z",
      },
    )
    expect(org).toEqual({ ok: true, count: 1 }) // only the pre-filled row
  })
})

describe("runSlackAgent — unified learnings capture", () => {
  function makeLearningEnv(): { env: Env; store: Map<string, string> } {
    const store = new Map<string, string>()
    const kv = {
      get: async (key: string): Promise<string | null> => store.get(key) ?? null,
      put: async (key: string, value: string): Promise<void> => {
        store.set(key, value)
      },
      delete: async (key: string): Promise<void> => {
        store.delete(key)
      },
      list: async () => ({ keys: [], list_complete: true }),
    } as unknown as KVNamespace
    const env = makeEnv()
    env.OPENCLAW_STATE = kv
    env.OPENCLAW_LEARNINGS_MODE = "on"
    env.OPENCLAW_ORG_MEMORY_CAPTURE = "on"
    return { env, store }
  }

  it("captures an INSTRUCTIVE Slack message as an org-scope learning keyed to the installation", async () => {
    extractLearningMock.mockResolvedValueOnce({ rule: "always use named exports", polarity: "require" })
    const { env, store } = makeLearningEnv()
    await runSlackAgent(env, makeCtx({ mentionText: "@sigilix from now on always use named exports" }))

    // installationId 111 (makeCtx default scope) → learnings:org:111
    const orgKey = learningsKey("org", "111")
    expect(store.has(orgKey)).toBe(true)
    const orgStore = JSON.parse(store.get(orgKey)!)
    expect(orgStore.scope).toBe("org")
    expect(orgStore.subjectId).toBe("111")
    expect(orgStore.entries[0].rule).toBe("always use named exports")
    expect(orgStore.entries[0].source.kind).toBe("chat")
  })

  it("QUALITY GATE — an ordinary question writes NO learning", async () => {
    extractLearningMock.mockResolvedValueOnce(null)
    const { env, store } = makeLearningEnv()
    await runSlackAgent(env, makeCtx({ mentionText: "how does the auth flow work?" }))

    expect(Array.from(store.keys()).filter((k) => k.startsWith("learnings:"))).toHaveLength(0)
  })
})
