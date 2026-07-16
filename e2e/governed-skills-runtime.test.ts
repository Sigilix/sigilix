import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { handleResearchCreate, handleResearchStream } from "@/src/do/deep-research/routes"
import { DeepResearchDO } from "@/src/do/deep-research/deep-research-do"
import { configureSkillPolicy, disabledSkillSurfaces, revokeSkillPolicy } from "@/src/features/skills"
import type { ResearchModelFn } from "@/src/do/deep-research/model"
import type { ChatMessage, ChatToolDef } from "@/src/shared/ports/model"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(9))
const MIGRATIONS = [
  "0001_create_tenant_repo_usage.sql",
  "0006_create_user_identity.sql",
  "0011_add_tenant_subscription_status.sql",
  "0017_create_org_skill_policy.sql",
].map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"))

function kv(): KVNamespace {
  const values = new Map<string, string>()
  return {
    get: async (key: string, type?: "json") => {
      const raw = values.get(key)
      return raw === undefined ? null : type === "json" ? JSON.parse(raw) : raw
    },
    put: async (key: string, value: string) => void values.set(key, value),
    delete: async (key: string) => void values.delete(key),
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace
}

function doState(id: string): DurableObjectState {
  const values = new Map<string, unknown>()
  return {
    id: { toString: () => id },
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

function namespace(
  env: Env,
  model: ResearchModelFn,
): {
  binding: DurableObjectNamespace
  instances: Map<string, DeepResearchDO>
} {
  const instances = new Map<string, DeepResearchDO>()
  let nextId = 0
  const id = (value: string): DurableObjectId => ({ toString: () => value }) as unknown as DurableObjectId
  const binding = {
    newUniqueId: () => id(`skill-route-e2e-${++nextId}`),
    idFromString: (value: string) => {
      if (!/^skill-route-e2e-\d+$/.test(value)) throw new Error("invalid id")
      return id(value)
    },
    get: (objectId: DurableObjectId) => {
      const key = objectId.toString()
      let instance = instances.get(key)
      if (!instance) {
        instance = new DeepResearchDO(doState(key), env)
        instance.setTestHooks({
          model,
          search: async () => ({ ok: false, reason: "disabled" }),
          fetchPage: async () => ({ ok: false, reason: "disabled" }),
        })
        instances.set(key, instance)
      }
      return { fetch: (input: RequestInfo | URL, init?: RequestInit) => instance!.fetch(new Request(input, init)) }
    },
  } as unknown as DurableObjectNamespace
  return { binding, instances }
}

function portalRequest(path: string, method = "GET", body?: unknown): Request {
  const headers = new Headers({ cookie: `${SESSION_COOKIE}=sess-1` })
  if (body !== undefined) headers.set("content-type", "application/json")
  return new Request(`https://api.sigilix.ai${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function streamEvents(response: Response): Promise<Array<Record<string, unknown>>> {
  return (await response.text())
    .split("\n\n")
    .map((frame) => frame.replace(/^data: /, "").trim())
    .filter(Boolean)
    .map((frame) => JSON.parse(frame) as Record<string, unknown>)
}

describe("governed skill route → D1 → run DO → model", () => {
  let db: D1Database
  let state: KVNamespace

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    db = makeD1()
    for (const migration of MIGRATIONS) await db.exec(migration)
    await db
      .prepare("INSERT INTO tenant (installation_id, tier, created_at, updated_at) VALUES (42, 'pro', 't', 't')")
      .run()
    await db
      .prepare(
        "INSERT INTO user_identity (user_id, github_user_id, providers, created_at, last_login_at)" +
          " VALUES ('user-111', '111', '[\"github\"]', 't', 't')",
      )
      .run()
    state = kv()
    await createSession({
      kv: state,
      sessionId: "sess-1",
      login: "octocat",
      githubUserId: 111,
      userId: "user-111",
      accessToken: "ghu_111",
      encryptionKeyB64url: ENC_KEY,
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        if (url.startsWith("https://api.github.com/user/installations?")) {
          return Response.json({ installations: [{ id: 42 }] })
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("changes model behavior only while the exact tenant policy is enabled", async () => {
    expect(
      (
        await configureSkillPolicy(
          { SIGILIX_PLATFORM_DB: db },
          {
            installationId: 42,
            skillId: "supabase-postgres-best-practices",
            expectedVersion: 0,
            enabled: true,
            surfaces: { ...disabledSkillSurfaces(), chat: true },
            updatedBy: "user:111",
            nowMs: 100,
          },
        )
      ).status,
    ).toBe("ok")

    const modelCalls: Array<{ messages: ChatMessage[]; tools?: ChatToolDef[] }> = []
    const model: ResearchModelFn = async (_role, messages, tools) => {
      modelCalls.push({ messages, ...(tools ? { tools } : {}) })
      const governed = messages[0]?.content.includes("<sigilix_organization_skill") ?? false
      return { text: governed ? "Used governed Postgres guidance." : "Generic answer.", tokens: 5 }
    }
    const env = {
      OPENCLAW_STATE: state,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
      SIGILIX_USAGE_METER_MODE: "off",
      SIGILIX_SKILLS_MODE: "on",
    } as unknown as Env
    const runs = namespace(env, model)
    ;(env as { DEEP_RESEARCH: DurableObjectNamespace }).DEEP_RESEARCH = runs.binding
    const ctx = { waitUntil: () => undefined } as unknown as ExecutionContext

    const create = await handleResearchCreate(
      portalRequest("/v1/research", "POST", {
        question: "Optimize this Postgres SQL query using database indexes",
        mode: "chat",
        installationId: 42,
      }),
      env,
      ctx,
    )
    expect(create.status).toBe(200)
    const { id } = (await create.json()) as { id: string }
    const run = runs.instances.get(id)!
    await (run as unknown as { driveDone: Promise<void> | null }).driveDone
    const firstEvents = await streamEvents(await handleResearchStream(portalRequest("/stream"), env, ctx, id))
    expect(firstEvents.find((event) => event.type === "final")?.markdown).toBe("Used governed Postgres guidance.")
    expect(
      firstEvents.some((event) => event.type === "note" && String(event.text).startsWith("Organization skill:")),
    ).toBe(true)
    expect(modelCalls.at(-1)?.tools).toBeUndefined()

    expect(
      (
        await revokeSkillPolicy(
          { SIGILIX_PLATFORM_DB: db },
          {
            installationId: 42,
            skillId: "supabase-postgres-best-practices",
            updatedBy: "user:111",
            nowMs: 200,
          },
        )
      ).status,
    ).toBe("ok")
    const second = await handleResearchCreate(
      portalRequest("/v1/research", "POST", {
        question: "Optimize this Postgres SQL query using database indexes",
        mode: "chat",
        installationId: 42,
      }),
      env,
      ctx,
    )
    const secondId = ((await second.json()) as { id: string }).id
    const secondRun = runs.instances.get(secondId)!
    await (secondRun as unknown as { driveDone: Promise<void> | null }).driveDone
    const secondEvents = await streamEvents(await handleResearchStream(portalRequest("/stream"), env, ctx, secondId))
    expect(secondEvents.find((event) => event.type === "final")?.markdown).toBe("Generic answer.")
    expect(
      secondEvents.some((event) => event.type === "note" && String(event.text).startsWith("Organization skill:")),
    ).toBe(false)
  })
})
