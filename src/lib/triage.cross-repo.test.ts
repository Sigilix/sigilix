// Cross-repo Linear triage — proves the multi-repo binding drives retrieval
// fan-out end-to-end through the REAL triageIssue path (D1 store + scope guard),
// mocking only the genuinely-external IO (Linear client, model, dedupe) and
// spying on retrieveChunks to capture the namespace fan-out it receives.
//
// A team bound to TWO repos must query the first as the PRIMARY namespace and
// fold the rest in as crossRepoNamespaces (the same multi-namespace retrieval
// the PR-review path uses). A team bound to ZERO repos must fail closed — no
// model call — exactly as the SIG-242 missing-single-binding guard did.

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
  title: "Test issue",
  description: "A description",
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
  retrieveChunksMock: vi.fn(async (_ctx: { namespace?: string; crossRepoNamespaces?: string[] }) => [] as unknown[]),
  formatChunksMock: vi.fn(() => null),
}))
vi.mock("@/src/lib/retrieval", () => ({
  retrieveChunks: retrieveChunksMock,
  formatChunksForPrompt: formatChunksMock,
}))

// ─── import SUT after mocks ───────────────────────────────────────────────────

import { triageIssue } from "@/src/lib/triage"
import { connectLinearOrganization, updateLinearConfig } from "@/src/features/linear-integration"

const NOW_ISO = "2026-07-10T00:00:00.000Z"

async function makeDb(repoIds: number[]): Promise<D1Database> {
  const db = makeD1()
  await db.exec(BASE_SQL)
  await db.exec(TRIAGE_LEDGER_SQL)
  await db.exec(LINEAR_SQL)
  await db.exec(TEAM_REPO_SQL)
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
        " VALUES (42, 'acme', 'Organization', ?, ?)",
    )
    .bind(NOW_ISO, NOW_ISO)
    .run()
  for (const [id, name] of [
    [101, "acme/api"],
    [102, "acme/web"],
  ] as const) {
    await db
      .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (?, 42, ?, ?)")
      .bind(id, name, NOW_ISO)
      .run()
  }
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
  const repos = repoIds.map((id) => ({
    githubRepoId: id,
    githubRepoFullName: id === 101 ? "acme/api" : "acme/web",
  }))
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
      bindings: [{ teamId: "team-a", repos, useAllRepos: false }],
      updatedBy: "admin",
      nowIso: NOW_ISO,
    },
  )
  expect(result.ok).toBe(true)
  return db
}

function makeEnv(db: D1Database): Env {
  return {
    SIGILIX_PLATFORM_DB: db,
    SIGILIX_USAGE_METER_MODE: "off",
    OPENCLAW_STATE: {} as unknown as KVNamespace,
    OLLAMA_API_KEY: "fake-ollama-key",
  } as unknown as Env
}

const TENANT = { organizationId: "org-a", installationId: 42, teamId: "team-a" }

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
  generateMock.mockReset().mockResolvedValue({
    text: JSON.stringify({ headline: "Headline", severity: "P2", estimate: "S", labels: [], body: "Body text." }),
  })
  getIssueMock.mockReset().mockResolvedValue(ISSUE)
  createCommentMock.mockReset().mockResolvedValue("comment-1")
  updateCommentMock.mockReset().mockResolvedValue(undefined)
  resolveLabelsMock.mockReset().mockResolvedValue([])
  updateIssueMock.mockReset().mockResolvedValue(undefined)
  getMarkerMock.mockReset().mockResolvedValue(null)
  setMarkerMock.mockReset().mockResolvedValue(undefined)
  markBotAuthoredCommentMock.mockReset().mockResolvedValue(undefined)
  retrieveChunksMock.mockReset().mockResolvedValue([])
  formatChunksMock.mockReset().mockReturnValue(null)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("triageIssue — Linear cross-repo retrieval fan-out", () => {
  it("fans retrieval out across a team's full repo set (primary + cross-repo siblings)", async () => {
    const db = await makeDb([101, 102])

    await triageIssue("issue-abc", makeEnv(db), TENANT)

    expect(retrieveChunksMock).toHaveBeenCalledOnce()
    const arg = retrieveChunksMock.mock.calls[0]![0]
    expect(arg.namespace).toBe("acme/api")
    expect(arg.crossRepoNamespaces).toEqual(["acme/web"])
    // The real triage ran to completion.
    expect(generateMock).toHaveBeenCalledOnce()
  })

  it("still retrieves for a single-repo team (no cross-repo siblings)", async () => {
    const db = await makeDb([101])

    await triageIssue("issue-abc", makeEnv(db), TENANT)

    expect(retrieveChunksMock).toHaveBeenCalledOnce()
    const arg = retrieveChunksMock.mock.calls[0]![0]
    expect(arg.namespace).toBe("acme/api")
    expect(arg.crossRepoNamespaces).toBeUndefined()
  })

  it("fails closed when the team is bound to ZERO repositories (no model, no retrieval)", async () => {
    const db = await makeDb([101])
    // Revoke the binding's repos: clear the join table and the primary column so
    // the effective set resolves empty.
    await db.prepare("DELETE FROM linear_team_repo WHERE installation_id = 42").run()
    await db
      .prepare(
        "UPDATE linear_team_binding SET github_repo_id = 0, github_repo_full_name = '' WHERE installation_id = 42",
      )
      .run()

    await triageIssue("issue-abc", makeEnv(db), TENANT)

    expect(retrieveChunksMock).not.toHaveBeenCalled()
    expect(generateMock).not.toHaveBeenCalled()
    // Fails closed VISIBLY — a configuration-warning comment, not a silent skip.
    expect(createCommentMock).toHaveBeenCalledOnce()
    expect(createCommentMock.mock.calls[0]![1]).toMatch(/not bound to an accessible repository/)
  })
})
