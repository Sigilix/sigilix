// Governed org skills on the Linear triage pipeline ("agent" surface) — proves
// an installed, enabled, agent-surface skill actually changes the triage prompt
// through the REAL triageIssue path (real D1 policy store + tenant scope guard),
// and that every no-skill path stays BYTE-IDENTICAL to today's prompt.
//
// Mocks mirror triage.cross-repo.test.ts (Linear client, model, dedupe,
// retrieval); the skill store is real (makeD1 + migration 0017).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"

const BASE_SQL = readFileSync(new URL("../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url), "utf8")
const TRIAGE_LEDGER_SQL = readFileSync(
  new URL("../../migrations/0002_create_triage_usage_ledger.sql", import.meta.url),
  "utf8",
)
const LINEAR_SQL = readFileSync(new URL("../../migrations/0016_create_linear_integration.sql", import.meta.url), "utf8")
const SKILLS_SQL = readFileSync(new URL("../../migrations/0017_create_org_skill_policy.sql", import.meta.url), "utf8")
const TEAM_REPO_SQL = readFileSync(
  new URL("../../migrations/0018_create_linear_team_repo.sql", import.meta.url),
  "utf8",
)

// ─── hoisted mocks ────────────────────────────────────────────────────────────

const { generateMock } = vi.hoisted(() => ({
  generateMock: vi.fn(async () => ({
    text: JSON.stringify({ headline: "Headline", severity: "P2", estimate: "S", labels: [], body: "Body text." }),
  })),
}))
vi.mock("@/src/shared/adapters/model", () => ({ generate: generateMock }))

const ISSUE = {
  id: "issue-abc",
  identifier: "SIG-1",
  title: "Checkout throws a stack trace after the deploy",
  description: "Users hit a stack trace on checkout; started after yesterday's deploy.",
  url: "https://linear.app/sigilix/issue/SIG-1",
  team: { id: "team-a", key: "TEAM-A" },
  creator: { name: "bob", displayName: "Bob" },
  labels: { nodes: [] },
  comments: { nodes: [] },
}

const { getIssueMock, createCommentMock, updateCommentMock, resolveLabelsMock, updateIssueMock, LinearClientMock } =
  vi.hoisted(() => ({
    getIssueMock: vi.fn(async () => ISSUE),
    createCommentMock: vi.fn(async (_id: string, _body: string) => "comment-1"),
    updateCommentMock: vi.fn(async () => undefined),
    resolveLabelsMock: vi.fn(async () => [] as string[]),
    updateIssueMock: vi.fn(async () => undefined),
    LinearClientMock: vi.fn(),
  }))
vi.mock("@/src/lib/linear", async (importActual) => {
  const actual = await importActual<typeof import("@/src/lib/linear")>()
  return {
    ...actual,
    buildLinearAuth: vi.fn(async () => ({ apiKey: "fake-key" })),
    LinearClient: LinearClientMock,
    buildLinearClient: vi.fn(async () => LinearClientMock()),
  }
})

const { getMarkerMock, setMarkerMock } = vi.hoisted(() => ({
  getMarkerMock: vi.fn(async () => null),
  setMarkerMock: vi.fn(async () => undefined),
}))
vi.mock("@/src/shared/util/dedupe", () => ({ getMarker: getMarkerMock, setMarker: setMarkerMock }))

const { markBotAuthoredCommentMock } = vi.hoisted(() => ({
  markBotAuthoredCommentMock: vi.fn(async () => undefined),
}))
vi.mock("@/src/lib/bot-authored-comments", () => ({ markBotAuthoredComment: markBotAuthoredCommentMock }))

const { retrieveChunksMock, formatChunksMock } = vi.hoisted(() => ({
  retrieveChunksMock: vi.fn(async () => [] as unknown[]),
  formatChunksMock: vi.fn(() => null),
}))
vi.mock("@/src/lib/retrieval", () => ({
  retrieveChunks: retrieveChunksMock,
  formatChunksForPrompt: formatChunksMock,
}))

// ─── import SUT after mocks ───────────────────────────────────────────────────

import { triageIssue } from "@/src/lib/triage"
import { configureSkillPolicy, disabledSkillSurfaces } from "@/src/features/skills"
import { connectLinearOrganization, updateLinearConfig } from "@/src/features/linear-integration"

const NOW_ISO = "2026-07-12T00:00:00.000Z"
const TENANT = { organizationId: "org-a", installationId: 42, teamId: "team-a" }

async function makeDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(BASE_SQL)
  await db.exec(TRIAGE_LEDGER_SQL)
  await db.exec(LINEAR_SQL)
  await db.exec(SKILLS_SQL)
  await db.exec(TEAM_REPO_SQL)
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
        " VALUES (42, 'acme', 'Organization', ?, ?)",
    )
    .bind(NOW_ISO, NOW_ISO)
    .run()
  await db
    .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (101, 42, 'acme/api', ?)")
    .bind(NOW_ISO)
    .run()
  await connectLinearOrganization(
    { SIGILIX_PLATFORM_DB: db },
    {
      installationId: 42,
      organizationId: "org-a",
      organizationName: "Acme",
      appUserId: "app-a",
      source: "oauth",
      grantedScopes: ["read", "write"],
      canAccessAllPublicTeams: false,
      installedByUserId: "u",
      installedByLogin: "admin",
      teams: [{ id: "team-a", key: "TEAM-A", name: "Team A", githubRepoId: 101, githubRepoFullName: "acme/api" }],
      nowIso: NOW_ISO,
    },
  )
  const result = await updateLinearConfig(
    { SIGILIX_PLATFORM_DB: db },
    {
      installationId: 42,
      input: {
        revision: 1,
        contextMode: "auto",
        scope: { mode: "auto", teamIds: [] },
        prValidation: false,
        createIssue: "manual",
        planning: true,
        writeback: { comments: true, status: false, labels: true },
      },
      bindings: [
        { teamId: "team-a", repos: [{ githubRepoId: 101, githubRepoFullName: "acme/api" }], useAllRepos: false },
      ],
      updatedBy: "admin",
      nowIso: NOW_ISO,
    },
  )
  expect(result.ok).toBe(true)
  return db
}

async function install(
  db: D1Database,
  surfaces: Partial<Record<"chat" | "agent", boolean>> = { agent: true },
): Promise<void> {
  const result = await configureSkillPolicy(
    { SIGILIX_PLATFORM_DB: db },
    {
      installationId: 42,
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

function makeEnv(db: D1Database, skillsMode: string | null = "on"): Env {
  return {
    SIGILIX_PLATFORM_DB: db,
    ...(skillsMode ? { SIGILIX_SKILLS_MODE: skillsMode } : {}),
    SIGILIX_USAGE_METER_MODE: "off",
    OPENCLAW_STATE: {} as unknown as KVNamespace,
    OLLAMA_API_KEY: "fake-ollama-key",
  } as unknown as Env
}

function capturedPrompt(): string {
  expect(generateMock).toHaveBeenCalledOnce()
  const arg = (generateMock.mock.calls[0] as unknown[])[0] as { prompt: string }
  return arg.prompt
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  LinearClientMock.mockReset().mockImplementation(() => ({
    getIssue: getIssueMock,
    createComment: createCommentMock,
    updateComment: updateCommentMock,
    resolveLabels: resolveLabelsMock,
    updateIssue: updateIssueMock,
  }))
  generateMock.mockClear()
  getIssueMock.mockClear()
  createCommentMock.mockClear()
  retrieveChunksMock.mockClear()
  formatChunksMock.mockClear().mockReturnValue(null)
  getMarkerMock.mockClear().mockResolvedValue(null)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("triageIssue — governed skill guidance (agent surface)", () => {
  it("folds an installed agent-surface skill into the [SYSTEM INSTRUCTIONS] section and logs provenance", async () => {
    const db = await makeDb()
    await install(db)

    await triageIssue("issue-abc", makeEnv(db), TENANT)

    const prompt = capturedPrompt()
    expect(prompt).toContain('<sigilix_organization_skill id="anthropic-debugging-workflow"')
    expect(prompt).toContain("Establish expected versus actual behavior")
    // The guidance lands in the system section — BEFORE the issue metadata.
    expect(prompt.indexOf("<sigilix_organization_skill")).toBeLessThan(prompt.indexOf("[ISSUE METADATA]"))
    const provenanceLog = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes("linear-triage-skill-applied"))
    expect(provenanceLog).toContain("Organization skill: Systematic debugging (anthropic-debugging-workflow)")
  })

  it("keeps the prompt byte-identical to today's when no skill is installed", async () => {
    const dbToday = await makeDb()
    // Today's behavior: the global skills mode is not set at all.
    await triageIssue("issue-abc", makeEnv(dbToday, null), TENANT)
    const todaysPrompt = capturedPrompt()
    expect(todaysPrompt).not.toContain("<sigilix_organization_skill")

    generateMock.mockClear()
    const dbNoInstall = await makeDb()
    await triageIssue("issue-abc", makeEnv(dbNoInstall), TENANT)

    expect(capturedPrompt()).toBe(todaysPrompt)
  })

  it("does not inject a skill whose policy enables only the chat surface", async () => {
    const db = await makeDb()
    await install(db, { chat: true, agent: false })

    await triageIssue("issue-abc", makeEnv(db), TENANT)

    expect(capturedPrompt()).not.toContain("<sigilix_organization_skill")
  })

  it("never injects on the legacy no-tenant path, even with a policy installed", async () => {
    const db = await makeDb()
    await install(db)

    await triageIssue("issue-abc", makeEnv(db))

    expect(capturedPrompt()).not.toContain("<sigilix_organization_skill")
  })
})
