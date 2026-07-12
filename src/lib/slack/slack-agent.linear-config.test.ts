import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import type { Env } from "@/src/shared/types/env"
import type { SlackMentionContext } from "@/src/lib/slack/slack-agent"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"

const { createIssueMock, buildLinearClientMock } = vi.hoisted(() => ({
  createIssueMock: vi.fn(async () => ({
    id: "issue-id-1",
    identifier: "SIG-42",
    url: "https://linear.app/test/issue/SIG-42",
  })),
  buildLinearClientMock: vi.fn(),
}))
vi.mock("@/src/lib/linear", () => ({ buildLinearClient: buildLinearClientMock }))

const { dispatchMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(async () => ({ dispatched: true })),
}))
vi.mock("@/src/lib/linear-agent-run", () => ({ dispatchTicketImplementation: dispatchMock }))

const { triageIssueMock } = vi.hoisted(() => ({
  triageIssueMock: vi.fn(async () => undefined),
}))
vi.mock("@/src/lib/triage", () => ({ triageIssue: triageIssueMock }))

const { generateMock } = vi.hoisted(() => ({
  generateMock: vi.fn(async () => ({
    text: '{"title":"Auth failure","description":"Production auth is failing"}',
    usage: { promptTokens: 1, completionTokens: 1 },
  })),
}))
vi.mock("@/src/shared/adapters/model", () => ({ generate: generateMock }))

vi.mock("@/src/features/tenancy", () => ({
  checkUsagePool: vi.fn(async () => ({ allowed: true, mode: "off" })),
  appendUsageEvent: vi.fn(async () => undefined),
}))
vi.mock("@/src/features/learnings", () => ({
  captureInstructiveLearning: vi.fn(async () => undefined),
}))
vi.mock("@/src/lib/slack/slack-memory", () => ({
  recallSlackMemory: vi.fn(async () => []),
  captureSlackMemory: vi.fn(async () => ({ stored: true, skippedSecret: false })),
}))
vi.mock("@/src/lib/agent-loop", () => ({ runAgentLoop: vi.fn() }))
vi.mock("@/src/lib/agent-tools", () => ({ createAgentTools: vi.fn(() => []) }))
vi.mock("@/src/lib/agent-telemetry-kv", () => ({
  makeKvTelemetrySink: vi.fn(() => ({ record: vi.fn() })),
}))
vi.mock("@/src/lib/github-mention", () => ({
  buildClient: vi.fn(),
  parseGithubMentionResponse: vi.fn(),
}))

import { runSlackAgent } from "@/src/lib/slack/slack-agent"
import {
  connectLinearOrganization,
  DEFAULT_LINEAR_CONFIG,
  updateLinearConfig,
  type LinearConfig,
} from "@/src/features/linear-integration"

function makeEnv(): Env {
  return {
    OPENCLAW_STATE: {} as KVNamespace,
    OLLAMA_API_KEY: "test-key",
    OLLAMA_CHAT_ENABLE: "on",
  } as Env
}

function makeCtx(mentionText: string): SlackMentionContext {
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
    threadText: "thread context",
    mentionText,
  }
}

async function makeLinearDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(readFileSync(new URL("../../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url), "utf8"))
  await db.exec(
    readFileSync(new URL("../../../migrations/0016_create_linear_integration.sql", import.meta.url), "utf8"),
  )
  await db.exec(readFileSync(new URL("../../../migrations/0018_create_linear_team_repo.sql", import.meta.url), "utf8"))
  return db
}

async function makeConnectedEnv(overrides: Partial<LinearConfig> = {}): Promise<Env> {
  const db = await makeLinearDb()
  const nowIso = "2026-07-10T00:00:00.000Z"
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
        " VALUES (?, ?, 'Organization', ?, ?)",
    )
    .bind(111, "sigilix", nowIso, nowIso)
    .run()
  await db
    .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (?, ?, ?, ?)")
    .bind(101, 111, "sigilix/sigilix", nowIso)
    .run()
  const connected = await connectLinearOrganization(
    { SIGILIX_PLATFORM_DB: db },
    {
      installationId: 111,
      organizationId: "org-sigilix",
      organizationName: "Sigilix",
      appUserId: "app-sigilix",
      source: "oauth",
      grantedScopes: ["read", "write"],
      canAccessAllPublicTeams: false,
      installedByUserId: "user-1",
      installedByLogin: "admin",
      teams: [
        {
          id: "team-uuid-1",
          key: "SIG",
          name: "Sigilix",
          githubRepoId: 101,
          githubRepoFullName: "sigilix/sigilix",
        },
      ],
      nowIso,
    },
  )
  expect(connected.ok).toBe(true)
  if (Object.keys(overrides).length > 0) {
    const updated = await updateLinearConfig(
      { SIGILIX_PLATFORM_DB: db },
      {
        installationId: 111,
        input: {
          ...DEFAULT_LINEAR_CONFIG,
          ...overrides,
          revision: 1,
          scope: overrides.scope ?? DEFAULT_LINEAR_CONFIG.scope,
          writeback: overrides.writeback ?? DEFAULT_LINEAR_CONFIG.writeback,
        },
        bindings: [
          {
            teamId: "team-uuid-1",
            repos: [{ githubRepoId: 101, githubRepoFullName: "sigilix/sigilix" }],
            useAllRepos: false,
          },
        ],
        updatedBy: "admin",
        nowIso: "2026-07-10T00:01:00.000Z",
      },
    )
    expect(updated.ok).toBe(true)
  }
  return Object.assign(makeEnv(), { SIGILIX_PLATFORM_DB: db })
}

beforeEach(() => {
  vi.clearAllMocks()
  buildLinearClientMock.mockResolvedValue({ createIssue: createIssueMock })
  createIssueMock.mockResolvedValue({
    id: "issue-id-1",
    identifier: "SIG-42",
    url: "https://linear.app/test/issue/SIG-42",
  })
  dispatchMock.mockResolvedValue({ dispatched: true })
})

describe("runSlackAgent tenant Linear policy", () => {
  it("uses the active connection's exact tenant for issue creation and triage", async () => {
    const env = await makeConnectedEnv()
    await runSlackAgent(env, makeCtx("linear triage — auth is broken in prod"))

    const tenant = { organizationId: "org-sigilix", installationId: 111, teamId: "team-uuid-1" }
    expect(buildLinearClientMock).toHaveBeenCalledWith(env, tenant)
    expect(triageIssueMock).toHaveBeenCalledWith("issue-id-1", env, tenant)
  })

  it("honors disabled issue creation before model or Linear writes", async () => {
    const env = await makeConnectedEnv({ createIssue: "disabled" })
    const result = await runSlackAgent(env, makeCtx("linear triage — auth is broken in prod"))

    expect(result.action.kind).toBe("qa")
    expect(result.reply).toContain("issue creation is disabled")
    expect(generateMock).not.toHaveBeenCalled()
    expect(createIssueMock).not.toHaveBeenCalled()
    expect(triageIssueMock).not.toHaveBeenCalled()
  })

  it("creates the explicit ticket but does not dispatch repo work when context is off", async () => {
    const env = await makeConnectedEnv({ contextMode: "disabled" })
    const result = await runSlackAgent(env, makeCtx("implement this"))

    expect(createIssueMock).toHaveBeenCalledOnce()
    expect(dispatchMock).not.toHaveBeenCalled()
    expect(result.action).toMatchObject({ kind: "implement", dispatched: false })
  })

  it("fails closed with D1 present when no active connection proves the team binding", async () => {
    const env = Object.assign(makeEnv(), { SIGILIX_PLATFORM_DB: await makeLinearDb() })
    const result = await runSlackAgent(env, makeCtx("implement this"))

    expect(result.action.kind).toBe("qa")
    expect(createIssueMock).not.toHaveBeenCalled()
    expect(dispatchMock).not.toHaveBeenCalled()
  })
})
