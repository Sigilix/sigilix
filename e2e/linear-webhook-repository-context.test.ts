import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { connectLinearOrganization, updateLinearConfig } from "@/src/features/linear-integration"
import { replaceRepositoryContext } from "@/src/features/repository-context"

const { generateMock } = vi.hoisted(() => ({
  generateMock: vi.fn(async () => ({
    text: JSON.stringify({ headline: "Headline", severity: "P2", estimate: "S", labels: [], body: "Body" }),
  })),
}))
vi.mock("@/src/shared/adapters/model", () => ({ generate: generateMock }))

const ISSUE = {
  id: "issue-a",
  identifier: "SIG-900",
  title: "Add session UI",
  description: "Connect the web app to the session API.",
  url: "https://linear.app/acme/issue/SIG-900",
  team: { id: "team-a", key: "TEAM-A" },
  creator: { name: "daniel", displayName: "Daniel" },
  labels: { nodes: [] },
  comments: { nodes: [] },
}
const { LinearClientMock } = vi.hoisted(() => ({ LinearClientMock: vi.fn() }))
vi.mock("@/src/lib/linear", async (importActual) => {
  const actual = await importActual<typeof import("@/src/lib/linear")>()
  return {
    ...actual,
    buildLinearAuth: vi.fn(async () => ({ apiKey: "fake-key" })),
    LinearClient: LinearClientMock,
    buildLinearClient: vi.fn(async () => LinearClientMock()),
  }
})

const { retrieveChunksMock, formatChunksMock } = vi.hoisted(() => ({
  retrieveChunksMock: vi.fn(async () => [] as unknown[]),
  formatChunksMock: vi.fn(() => null),
}))
vi.mock("@/src/lib/retrieval", () => ({
  retrieveChunks: retrieveChunksMock,
  formatChunksForPrompt: formatChunksMock,
}))
vi.mock("@/src/shared/util/dedupe", () => ({
  getMarker: vi.fn(async () => null),
  setMarker: vi.fn(async () => undefined),
}))
vi.mock("@/src/lib/bot-authored-comments", async (importActual) => {
  const actual = await importActual<typeof import("@/src/lib/bot-authored-comments")>()
  return { ...actual, markBotAuthoredComment: vi.fn(async () => undefined) }
})

import worker from "@/src/index"

const SECRET = "linear-repository-context-e2e-secret"
const NOW = "2026-07-15T00:00:00.000Z"
const MIGRATION_SQL = [
  "0001_create_tenant_repo_usage.sql",
  "0002_create_triage_usage_ledger.sql",
  "0016_create_linear_integration.sql",
  "0018_create_linear_team_repo.sql",
  "0024_create_repository_context.sql",
]
  .map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"))
  .join("\n")

async function makeDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(MIGRATION_SQL)
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
        " VALUES (11, 'acme', 'Organization', ?, ?)",
    )
    .bind(NOW, NOW)
    .run()
  for (const [id, name] of [
    [101, "acme/api"],
    [102, "acme/web"],
    [103, "acme/infra"],
  ] as const) {
    await db
      .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (?, 11, ?, ?)")
      .bind(id, name, NOW)
      .run()
  }
  expect(
    await connectLinearOrganization(
      { SIGILIX_PLATFORM_DB: db },
      {
        installationId: 11,
        organizationId: "org-a",
        organizationName: "Acme",
        appUserId: "app-a",
        source: "oauth",
        grantedScopes: ["read", "write"],
        canAccessAllPublicTeams: false,
        installedByUserId: "u",
        installedByLogin: "admin",
        teams: [{ id: "team-a", key: "TEAM-A", name: "Team A", githubRepoId: 101, githubRepoFullName: "acme/api" }],
        nowIso: NOW,
      },
    ),
  ).toEqual({ ok: true })
  expect(
    (
      await updateLinearConfig(
        { SIGILIX_PLATFORM_DB: db },
        {
          installationId: 11,
          input: {
            revision: 1,
            contextMode: "auto",
            scope: { mode: "explicit", teamIds: ["team-a"] },
            prValidation: false,
            createIssue: "manual",
            planning: true,
            writeback: { comments: true, status: false, labels: true },
          },
          bindings: [
            {
              teamId: "team-a",
              repos: [
                { githubRepoId: 101, githubRepoFullName: "acme/api" },
                { githubRepoId: 102, githubRepoFullName: "acme/web" },
              ],
              useAllRepos: false,
            },
          ],
          updatedBy: "admin",
          nowIso: NOW,
        },
      )
    ).ok,
  ).toBe(true)
  for (const [scopeId, owner] of [
    ["11", "acme"],
    ["22", "foreign"],
  ] as const) {
    expect(
      (
        await replaceRepositoryContext(db, {
          provider: "github",
          scopeId,
          expectedRevision: 0,
          repositories: [
            { externalId: "101", fullName: `${owner}/api-stale`, context: `${owner} API owns sessions`, position: 0 },
            { externalId: "102", fullName: `${owner}/web-stale`, context: `${owner} web calls the API`, position: 1 },
            { externalId: "103", fullName: `${owner}/infra`, context: `${owner} unbound infrastructure`, position: 2 },
          ],
          relationships: [
            {
              fromExternalId: "102",
              toExternalId: "101",
              label: "calls for sessions",
              normalizedLabel: "calls for sessions",
              position: 0,
            },
          ],
          conventions: `${owner} conventions are out of scope`,
          nowIso: NOW,
          updatedBy: "github:111",
        })
      ).status,
    ).toBe("updated")
  }
  return db
}

function makeEnv(db: D1Database, mode: "off" | "shadow" | "on") {
  const jobs: JobMessage[] = []
  const env = {
    SIGILIX_PLATFORM_DB: db,
    SIGILIX_REPOSITORY_CONTEXT_LINEAR_MODE: mode,
    SIGILIX_USAGE_METER_MODE: "off",
    SIGILIX_FAIRNESS_MODE: "off",
    SIGILIX_PROVIDER_COOLDOWN_MODE: "off",
    LINEAR_WEBHOOK_SECRET: SECRET,
    OLLAMA_API_KEY: "fake-ollama-key",
    OPENCLAW_STATE: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ keys: [], list_complete: true })),
    } as unknown as KVNamespace,
    OPENCLAW_JOBS: { send: vi.fn(async (job: JobMessage) => void jobs.push(job)) },
  } as unknown as Env
  return { env, jobs }
}

async function sign(raw: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

async function enqueue(env: Env, deliveryId: string): Promise<JobMessage> {
  const raw = JSON.stringify({
    action: "create",
    type: "Issue",
    organizationId: "org-a",
    webhookTimestamp: Date.now(),
    data: { id: ISSUE.id, team: ISSUE.team },
  })
  const response = await worker.fetch(
    new Request("https://api.sigilix.ai/linear/webhook", {
      method: "POST",
      headers: { "linear-signature": await sign(raw), "linear-delivery": deliveryId },
      body: raw,
    }),
    env,
    { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
  )
  expect(response.status).toBe(200)
  const jobs = (env.OPENCLAW_JOBS.send as ReturnType<typeof vi.fn>).mock.calls.map(([job]) => job as JobMessage)
  expect(jobs).toHaveLength(1)
  return jobs[0]!
}

async function dispatch(env: Env, job: JobMessage) {
  const message = {
    body: job,
    attempts: 1,
    id: "message-a",
    timestamp: new Date(),
    ack: vi.fn(),
    retry: vi.fn(),
  }
  await worker.queue({ queue: "jobs", messages: [message] } as unknown as MessageBatch<JobMessage>, env, {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext)
  return message
}

function capturedPrompt(): string {
  expect(generateMock).toHaveBeenCalled()
  const call = generateMock.mock.calls.at(-1) as unknown[]
  return (call[0] as { prompt: string }).prompt
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  LinearClientMock.mockReset().mockImplementation(() => ({
    getIssue: vi.fn(async () => ISSUE),
    createComment: vi.fn(async () => "comment-a"),
    updateComment: vi.fn(async () => undefined),
    resolveLabels: vi.fn(async () => []),
    updateIssue: vi.fn(async () => undefined),
  }))
  generateMock.mockClear()
  retrieveChunksMock.mockClear().mockResolvedValue([])
  formatChunksMock.mockClear().mockReturnValue(null)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("signed Linear webhook canonical repository context", () => {
  it("injects only the signed tenant team's exact bound repository context in on mode", async () => {
    const db = await makeDb()
    const { env } = makeEnv(db, "on")
    const job = await enqueue(env, "delivery-on")

    const message = await dispatch(env, job)
    const prompt = capturedPrompt()

    expect(prompt).toContain("[REPOSITORY CONTEXT — UNTRUSTED DATA]")
    expect(prompt).toContain("acme API owns sessions")
    expect(prompt).toContain("acme web calls the API")
    expect(prompt).toContain('"name":"acme/api"')
    expect(prompt).toContain('"name":"acme/web"')
    expect(prompt).toContain("calls for sessions")
    expect(prompt).not.toMatch(/unbound infrastructure|foreign|api-stale|web-stale|conventions/)
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
  })

  it("keeps shadow prompt bytes identical to off through signed ingress and the real queue", async () => {
    const db = await makeDb()
    const { env: offEnv } = makeEnv(db, "off")
    const job = await enqueue(offEnv, "delivery-shadow-parity")

    await dispatch(offEnv, job)
    const baseline = capturedPrompt()
    const { env: shadowEnv } = makeEnv(db, "shadow")
    await dispatch(shadowEnv, job)
    const shadow = capturedPrompt()

    expect(shadow).toBe(baseline)
    expect(shadow).not.toContain("[REPOSITORY CONTEXT — UNTRUSTED DATA]")
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/"event":"linear-repository-context-read".*"mode":"shadow".*"repositoryCount":2/u),
    )
  })
})
