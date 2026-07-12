import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { disabledSkillSurfaces } from "@/src/features/skills"
import type { Env } from "@/src/shared/types/env"
import { tryHandleSkillRoute } from "./skills-route"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(7))
const ORIGIN = "https://app.sigilix.ai"
const MIGRATION_SQL = readFileSync(
  new URL("../../migrations/0017_create_org_skill_policy.sql", import.meta.url),
  "utf8",
)

function kv(): KVNamespace {
  const values = new Map<string, string>()
  return {
    get: async (key: string, type?: "json") => {
      const raw = values.get(key)
      return raw === undefined ? null : type === "json" ? JSON.parse(raw) : raw
    },
    put: async (key: string, value: string) => void values.set(key, value),
    delete: async (key: string) => void values.delete(key),
  } as unknown as KVNamespace
}

function environment(state: KVNamespace, db: D1Database): Env {
  return {
    OPENCLAW_STATE: state,
    OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
    SIGILIX_PLATFORM_DB: db,
    OPENCLAW_PORTAL_ORIGINS: ORIGIN,
  } as unknown as Env
}

async function session(state: KVNamespace): Promise<void> {
  await createSession({
    kv: state,
    sessionId: "sess-1",
    login: "octocat",
    githubUserId: 111,
    accessToken: "ghu_111",
    encryptionKeyB64url: ENC_KEY,
  })
}

function adminFor(installationId: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith("https://api.github.com/user/installations?")) {
        return Response.json({
          total_count: 1,
          installations: [{ id: installationId, account: { type: "Organization", login: "acme" } }],
        })
      }
      if (url.startsWith("https://api.github.com/user/memberships/orgs?")) {
        return Response.json([{ role: "admin", state: "active", organization: { login: "acme" } }])
      }
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
}

function request(method: string, path: string, body?: unknown): Request {
  const headers = new Headers({ origin: ORIGIN })
  headers.set("cookie", `${SESSION_COOKIE}=sess-1`)
  if (body !== undefined) headers.set("content-type", "application/json")
  return new Request(`https://api.sigilix.ai${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function dispatch(req: Request, env: Env): Promise<Response> {
  const response = await tryHandleSkillRoute(
    req,
    env,
    { waitUntil: () => undefined } as unknown as ExecutionContext,
    new URL(req.url),
  )
  if (!response) throw new Error("route did not match")
  return response
}

describe("skills route", () => {
  let state: KVNamespace
  let db: D1Database
  let env: Env

  beforeEach(async () => {
    state = kv()
    db = makeD1()
    await db.exec(MIGRATION_SQL)
    env = environment(state, db)
    await session(state)
    adminFor(42)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("publishes audited metadata without exposing instruction bodies", async () => {
    const response = await dispatch(request("GET", "/v1/skills/catalog"), env)
    const body = (await response.json()) as { skills: Array<Record<string, unknown>> }
    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN)
    expect(body.skills).toHaveLength(26)
    expect(body.skills[0]).toHaveProperty("instructionSha256")
    expect(body.skills[0]).toHaveProperty("category")
    expect(body.skills[0]).toHaveProperty("explanation")
    expect(body.skills[0]).not.toHaveProperty("instructions")
    expect(body.skills.find((skill) => skill.id === "openai-sentry-investigation")).toMatchObject({
      appIds: ["sentry"],
      dataSensitivity: "public-guidance",
    })
  })

  it("requires exact installation admin proof before reading policy", async () => {
    const response = await dispatch(request("GET", "/v1/org/99/skills"), env)
    expect(response.status).toBe(403)
  })

  it("configures, lists, and revokes one default-off installation policy", async () => {
    const skillPath = "/v1/org/42/skills/supabase-postgres-best-practices"
    const configured = await dispatch(
      request("PUT", skillPath, {
        version: 0,
        enabled: true,
        surfaces: { ...disabledSkillSurfaces(), chat: true },
      }),
      env,
    )
    expect(configured.status).toBe(200)
    expect(await configured.json()).toEqual({
      policy: expect.objectContaining({ version: 1, status: "installed", enabled: true }),
    })

    const list = await dispatch(request("GET", "/v1/org/42/skills"), env)
    const listed = (await list.json()) as { skills: Array<{ id: string; policy: Record<string, unknown> | null }> }
    expect(listed.skills.find((skill) => skill.id === "supabase-postgres-best-practices")?.policy).toMatchObject({
      version: 1,
      enabled: true,
      surfaces: { chat: true, "deep-research": false, cli: false, "pr-review": false, agent: false },
    })
    expect(listed.skills.find((skill) => skill.id === "cloudflare-durable-objects")?.policy).toBeNull()

    const revoked = await dispatch(request("DELETE", skillPath), env)
    expect(await revoked.json()).toEqual({
      policy: expect.objectContaining({
        version: 2,
        status: "revoked",
        enabled: false,
        surfaces: disabledSkillSurfaces(),
      }),
    })
  })

  it("rejects stale writes and surfaces the compiled eligibility ceiling", async () => {
    const path = "/v1/org/42/skills/openai-security-best-practices"
    expect(
      (
        await dispatch(
          request("PUT", path, {
            version: 0,
            enabled: true,
            surfaces: { ...disabledSkillSurfaces(), cli: true },
          }),
          env,
        )
      ).status,
    ).toBe(400)
    expect(
      (
        await dispatch(
          request("PUT", path, {
            version: 1,
            enabled: true,
            surfaces: { ...disabledSkillSurfaces(), chat: true },
          }),
          env,
        )
      ).status,
    ).toBe(409)
  })
})
