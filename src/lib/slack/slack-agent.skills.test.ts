// Governed org skills on the Slack agent ("agent" surface) — proves an
// installed, enabled, agent-surface skill actually changes the agent loop's
// system prompt through the REAL runSlackAgent path (real D1 policy store),
// and that every no-skill path stays BYTE-IDENTICAL to today's prompt.
//
// External IO is mocked exactly as in slack-agent.test.ts; the skill store is
// real (makeD1 + migration 0017 + configureSkillPolicy).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"
import type { SlackMentionContext } from "@/src/lib/slack/slack-agent"

const SKILLS_SQL = readFileSync(
  new URL("../../../migrations/0017_create_org_skill_policy.sql", import.meta.url),
  "utf8",
)

// ─── Hoisted mocks (external IO only) ─────────────────────────────────────────

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

const { buildClientMock, parseGithubMentionResponseMock } = vi.hoisted(() => ({
  buildClientMock: vi.fn(async () => ({ getFileContent: vi.fn() })),
  parseGithubMentionResponseMock: vi.fn(() => ({
    answer: "The checkout error comes from the retry loop.",
    confidence: 5,
    abstain: false,
    verdict: "answer",
  })),
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

// B3c offer state: drive the pending offer so the revise path (the SECOND
// injection site) is exercised; keep the real classifyOfferReply.
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

const { extractLearningMock } = vi.hoisted(() => ({
  extractLearningMock: vi.fn(async () => null),
}))
vi.mock("@/src/features/learnings/adapters/extractor-model", () => ({
  extractLearning: extractLearningMock,
}))

// ─── Import SUT after mocks ───────────────────────────────────────────────────

import { runSlackAgent } from "@/src/lib/slack/slack-agent"
import { AGENT_SYSTEM_PROMPT } from "@/src/prompts/agent-system"
import { configureSkillPolicy, disabledSkillSurfaces } from "@/src/features/skills"

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const INSTALLATION_ID = 111

async function makeSkillDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(SKILLS_SQL)
  return db
}

async function install(
  db: D1Database,
  surfaces: Partial<Record<"chat" | "agent", boolean>> = { agent: true },
): Promise<void> {
  const result = await configureSkillPolicy(
    { SIGILIX_PLATFORM_DB: db },
    {
      installationId: INSTALLATION_ID,
      skillId: "anthropic-debugging-workflow",
      expectedVersion: 0,
      enabled: true,
      surfaces: { ...disabledSkillSurfaces(), ...surfaces },
      updatedBy: "user:111",
      nowMs: 100,
    },
  )
  expect(result.status).toBe("ok")
}

function makeEnv(db?: D1Database, skillsMode: string | null = "on"): Env {
  return {
    ...(db ? { SIGILIX_PLATFORM_DB: db } : {}),
    ...(skillsMode ? { SIGILIX_SKILLS_MODE: skillsMode } : {}),
    SIGILIX_USAGE_METER_MODE: "off",
    OPENCLAW_STATE: { get: vi.fn(), put: vi.fn(), list: vi.fn(), delete: vi.fn() } as unknown as KVNamespace,
    OLLAMA_API_KEY: "fake-ollama-key",
  } as unknown as Env
}

function makeCtx(overrides: Partial<SlackMentionContext> = {}): SlackMentionContext {
  return {
    // linearTeam null: the qa path under test never touches the Linear tables.
    scope: {
      teamId: "T001",
      channelId: "C001",
      installationId: INSTALLATION_ID,
      repos: [{ githubRepoId: 101, owner: "sigilix", repo: "sigilix" }],
      linearTeam: null,
    },
    slackUserId: "U001",
    channelId: "C001",
    threadTs: "1700000000.000100",
    threadText: "",
    mentionText: "we hit a stack trace in checkout after the deploy — can you find the root cause?",
    ...overrides,
  }
}

function capturedSystemPrompt(): string {
  expect(runAgentLoopMock).toHaveBeenCalledOnce()
  const loopArgs = runAgentLoopMock.mock.calls[0]![0] as { systemPrompt: string }
  return loopArgs.systemPrompt
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  getImplementOfferMock.mockResolvedValue(null)
  runAgentLoopMock.mockResolvedValue({
    ok: true,
    answer: {
      answer: "The checkout error comes from the retry loop.",
      confidence: 5,
      abstain: false,
      verdict: "answer",
    },
    stats: { toolTurns: 1, totalMs: 500, toolCallCount: 2 },
  })
})

afterEach(() => vi.restoreAllMocks())

describe("runSlackAgent — governed skill guidance (agent surface)", () => {
  it("appends an installed agent-surface skill to the agent loop's system prompt and logs provenance", async () => {
    const db = await makeSkillDb()
    await install(db)

    await runSlackAgent(makeEnv(db), makeCtx())

    const systemPrompt = capturedSystemPrompt()
    expect(systemPrompt.startsWith(AGENT_SYSTEM_PROMPT)).toBe(true)
    expect(systemPrompt).toContain('<sigilix_organization_skill id="anthropic-debugging-workflow"')
    expect(systemPrompt).toContain("Establish expected versus actual behavior")
    // Provenance is logged via renderSkillProvenanceNote — auditable, never posted.
    const provenanceLog = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes("slack-agent-skill-applied"))
    expect(provenanceLog).toContain("Organization skill: Systematic debugging (anthropic-debugging-workflow)")
  })

  it("keeps the system prompt byte-identical to today's when no skill is installed", async () => {
    const db = await makeSkillDb()

    await runSlackAgent(makeEnv(db), makeCtx())

    expect(capturedSystemPrompt()).toBe(AGENT_SYSTEM_PROMPT)
  })

  it.each([
    { name: "unset", mode: null },
    { name: "off", mode: "off" },
    // Fail-closed: a case-shifted value must never turn guidance on.
    { name: "case-shifted On", mode: "On" },
    { name: "case-shifted ON", mode: "ON" },
  ])("keeps the system prompt byte-identical when the global skills mode is $name", async ({ mode }) => {
    const db = await makeSkillDb()
    await install(db)

    await runSlackAgent(makeEnv(db, mode), makeCtx())

    expect(capturedSystemPrompt()).toBe(AGENT_SYSTEM_PROMPT)
  })

  it("does not inject a skill whose policy enables only the chat surface", async () => {
    const db = await makeSkillDb()
    await install(db, { chat: true, agent: false })

    await runSlackAgent(makeEnv(db), makeCtx())

    expect(capturedSystemPrompt()).toBe(AGENT_SYSTEM_PROMPT)
  })

  it("does not inject on a trigger miss", async () => {
    const db = await makeSkillDb()
    await install(db)

    await runSlackAgent(makeEnv(db), makeCtx({ mentionText: "how does the auth flow work?" }))

    expect(capturedSystemPrompt()).toBe(AGENT_SYSTEM_PROMPT)
  })

  it("applies the skill on the offer-revise path too (the second injection site)", async () => {
    const db = await makeSkillDb()
    await install(db)
    getImplementOfferMock.mockResolvedValue({ plan: "1. patch the retry loop", title: "Fix checkout retry" })
    const env = makeEnv(db)
    env.OPENCLAW_LINEAR_AGENT_RUN_MODE = "on"
    runAgentLoopMock.mockResolvedValue({
      ok: true,
      answer: { reply: "Good call.", plan: "1. reproduce, 2. patch", title: "Fix checkout retry" },
      stats: { toolTurns: 1, totalMs: 500, toolCallCount: 1 },
    })

    const result = await runSlackAgent(env, makeCtx({ mentionText: "please reproduce the bug before patching" }))

    expect(result.action.kind).toBe("implement-revise")
    const systemPrompt = capturedSystemPrompt()
    expect(systemPrompt.startsWith(AGENT_SYSTEM_PROMPT)).toBe(true)
    expect(systemPrompt).toContain('<sigilix_organization_skill id="anthropic-debugging-workflow"')
  })

  it("keeps the offer-revise prompt byte-identical when no skill is installed", async () => {
    const db = await makeSkillDb()
    getImplementOfferMock.mockResolvedValue({ plan: "1. patch the retry loop", title: "Fix checkout retry" })
    const env = makeEnv(db)
    env.OPENCLAW_LINEAR_AGENT_RUN_MODE = "on"

    await runSlackAgent(env, makeCtx({ mentionText: "please reproduce the bug before patching" }))

    expect(capturedSystemPrompt()).toBe(AGENT_SYSTEM_PROMPT)
  })

  it("fails soft to the unmodified prompt when the policy store is unavailable", async () => {
    // D1 bound but the skills migration was never applied → store_unavailable.
    await runSlackAgent(makeEnv(makeD1()), makeCtx())

    expect(capturedSystemPrompt()).toBe(AGENT_SYSTEM_PROMPT)
  })
})
