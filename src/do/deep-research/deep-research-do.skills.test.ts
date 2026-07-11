import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { configureSkillPolicy, disabledSkillSurfaces, revokeSkillPolicy } from "@/src/features/skills"
import type { Env } from "@/src/shared/types/env"
import type { ChatMessage, ChatToolDef } from "@/src/shared/ports/model"
import type { ResearchModelFn } from "./model"
import type { ResearchEvent, ResearchModelRole } from "./types"
import { CREATOR_HEADER, DeepResearchDO } from "./deep-research-do"

const MIGRATION_SQL = readFileSync(
  new URL("../../../migrations/0017_create_org_skill_policy.sql", import.meta.url),
  "utf8",
)

function state(): DurableObjectState {
  const values = new Map<string, unknown>()
  return {
    id: { toString: () => "skill-e2e-run-1" },
    waitUntil: () => undefined,
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => void values.set(key, value),
      delete: async (key: string) => values.delete(key),
      deleteAll: async () => void values.clear(),
      setAlarm: async () => undefined,
      list: async <T>(options?: { prefix?: string }) =>
        new Map([...values.entries()].filter(([key]) => key.startsWith(options?.prefix ?? "")) as Array<[string, T]>),
    },
  } as unknown as DurableObjectState
}

function startRequest(skillInstallationId: number): Request {
  return new Request("https://deep-research.do/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      question: "Give me a security best practices review for this TypeScript API",
      mode: "chat",
      creator: "session:111",
      mcpTenantScope: `tenant:${skillInstallationId}`,
    }),
  })
}

async function drive(instance: DeepResearchDO): Promise<void> {
  await (instance as unknown as { driveDone: Promise<void> | null }).driveDone
}

async function events(instance: DeepResearchDO): Promise<ResearchEvent[]> {
  const response = await instance.fetch(
    new Request("https://deep-research.do/stream", {
      headers: { [CREATOR_HEADER]: "session:111" },
    }),
  )
  const text = await response.text()
  return text
    .split("\n\n")
    .map((frame) => frame.replace(/^data: /, "").trim())
    .filter(Boolean)
    .map((frame) => JSON.parse(frame) as ResearchEvent)
}

async function install(db: D1Database, enabled = true): Promise<void> {
  const result = await configureSkillPolicy(
    { SIGILIX_PLATFORM_DB: db },
    {
      installationId: 42,
      skillId: "openai-security-best-practices",
      expectedVersion: 0,
      enabled,
      surfaces: { ...disabledSkillSurfaces(), chat: true },
      updatedBy: "user:111",
      nowMs: 100,
    },
  )
  expect(result.status).toBe("ok")
}

function instance(
  db: D1Database | undefined,
  captured: Array<{ role: ResearchModelRole; messages: ChatMessage[]; tools?: ChatToolDef[] }>,
  extra: Partial<Env> = {},
  skillsMode: string | null = "on",
): DeepResearchDO {
  const model: ResearchModelFn = async (role, messages, tools) => {
    captured.push({ role, messages, ...(tools ? { tools } : {}) })
    return { text: "# Security review\n\nUse secure defaults.", tokens: 10 }
  }
  const env = {
    ...(db ? { SIGILIX_PLATFORM_DB: db } : {}),
    ...(skillsMode ? { SIGILIX_SKILLS_MODE: skillsMode } : {}),
    ...extra,
  } as unknown as Env
  const doInstance = new DeepResearchDO(state(), env)
  doInstance.setTestHooks({
    model,
    search: async () => ({ ok: false, reason: "disabled" }),
    fetchPage: async () => ({ ok: false, reason: "disabled" }),
  })
  return doInstance
}

describe("DeepResearchDO governed skill runtime e2e", () => {
  let db: D1Database

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  afterEach(() => vi.restoreAllMocks())

  it("injects enabled tenant guidance into a no-tools answer and persists exact provenance", async () => {
    await install(db)
    const captured: Array<{ role: ResearchModelRole; messages: ChatMessage[]; tools?: ChatToolDef[] }> = []
    const run = instance(db, captured)
    expect((await run.fetch(startRequest(42))).status).toBe(200)
    await drive(run)

    const finalCall = captured.find((call) => call.role === "finalReport")!
    expect(finalCall.tools).toBeUndefined()
    expect(finalCall.messages[0]?.content).toContain("<sigilix_organization_skill")
    expect(finalCall.messages[0]?.content).toContain("Identify every in-scope language")
    const transcript = await events(run)
    const provenance = transcript.find((event) => event.type === "note" && event.text.startsWith("Organization skill:"))
    expect(provenance).toMatchObject({ type: "note" })
    expect(JSON.stringify(provenance)).toContain("797e16c333c05341a1494aadf7c615a0ea630595fc6d7b88a995a0410fb377ff")
    expect(transcript.at(-1)).toEqual({ type: "done" })
  })

  it("never exposes skill text to the independent MCP tool selector", async () => {
    await install(db)
    const namespace = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({
        fetch: async (request: Request) => {
          expect(new URL(request.url).pathname).toBe("/broker/runtime/chat/catalog")
          return Response.json({
            tools: [
              {
                serverId: "linear-1",
                vendor: "linear",
                name: "list_comments",
                description: "Read Linear comments visible to the connected account.",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          })
        },
      }),
    } as unknown as DurableObjectNamespace
    const captured: Array<{ role: ResearchModelRole; messages: ChatMessage[]; tools?: ChatToolDef[] }> = []
    const run = instance(db, captured, { MCP_CONNECTIONS: namespace })
    await run.fetch(
      new Request("https://deep-research.do/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: "Give me security best practices using the connected Linear context",
          mode: "chat",
          creator: "session:111",
          mcpTenantScope: "tenant:42",
        }),
      }),
    )
    await drive(run)

    const selector = captured.find((call) => call.tools?.length)
    expect(selector).toBeTruthy()
    expect(selector?.messages.map((message) => message.content).join("\n")).not.toContain("<sigilix_organization_skill")
    const finalCall = captured.find((call) => call.role === "finalReport" && !call.tools)
    expect(finalCall?.messages[0]?.content).toContain("<sigilix_organization_skill")
    expect(finalCall?.tools).toBeUndefined()
  })

  it.each([
    { name: "disabled", prepare: async (database: D1Database) => install(database, false), installationId: 42 },
    { name: "other tenant", prepare: async (database: D1Database) => install(database), installationId: 43 },
    {
      name: "revoked",
      prepare: async (database: D1Database) => {
        await install(database)
        expect(
          (
            await revokeSkillPolicy(
              { SIGILIX_PLATFORM_DB: database },
              {
                installationId: 42,
                skillId: "openai-security-best-practices",
                updatedBy: "user:111",
                nowMs: 200,
              },
            )
          ).status,
        ).toBe("ok")
      },
      installationId: 42,
    },
  ])("does not inject $name policy", async ({ prepare, installationId }) => {
    await prepare(db)
    const captured: Array<{ role: ResearchModelRole; messages: ChatMessage[]; tools?: ChatToolDef[] }> = []
    const run = instance(db, captured)
    await run.fetch(startRequest(installationId))
    await drive(run)
    expect(captured.find((call) => call.role === "finalReport")?.messages[0]?.content).not.toContain(
      "<sigilix_organization_skill",
    )
    expect(
      (await events(run)).some((event) => event.type === "note" && event.text.startsWith("Organization skill:")),
    ).toBe(false)
  })

  it("fails soft to no guidance when the store is unavailable or the global switch is not exactly on", async () => {
    await install(db)
    for (const scenario of [
      { database: undefined, extra: {} },
      { database: db, extra: { SIGILIX_SKILLS_MODE: "off" } },
      { database: db, extra: {}, skillsMode: null },
      { database: db, extra: { SIGILIX_SKILLS_MODE: "ON" } },
    ]) {
      const captured: Array<{ role: ResearchModelRole; messages: ChatMessage[]; tools?: ChatToolDef[] }> = []
      const run = instance(scenario.database, captured, scenario.extra, scenario.skillsMode)
      await run.fetch(startRequest(42))
      await drive(run)
      expect(captured.find((call) => call.role === "finalReport")?.messages[0]?.content).not.toContain(
        "<sigilix_organization_skill",
      )
      expect((await events(run)).some((event) => event.type === "error")).toBe(false)
    }
  })
})
