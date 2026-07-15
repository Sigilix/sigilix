import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import worker from "@/src/index"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import {
  activateGitLabRepositoryAuthority,
  claimGitLabRepositoryAuthority,
  readRepositoryContext,
  releaseGitLabRepositoryAuthority,
} from "@/src/features/repository-context"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"

const SESSION_ID = "gitlab-repository-context-session"
const USER_ID = "018f4f03-a7d3-7f32-8ad8-9c49c7440941"
const SESSION_COOKIE = "__Host-sigilix_session"
const PORTAL_ORIGIN = "https://app.sigilix.ai"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(53))
const CONTEXT_MIGRATION = readFileSync(
  new URL("../../../migrations/0024_create_repository_context.sql", import.meta.url),
  "utf8",
)
const AUTHORITY_MIGRATION = readFileSync(
  new URL("../../../migrations/0026_create_repository_context_authority.sql", import.meta.url),
  "utf8",
)
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

function makeKV(): KVNamespace {
  const values = new Map<string, string>()
  return {
    get: async (key: string, type?: "json") => {
      const value = values.get(key)
      if (value === undefined) return null
      return type === "json" ? JSON.parse(value) : value
    },
    put: async (key: string, value: string) => void values.set(key, value),
    delete: async (key: string) => void values.delete(key),
  } as unknown as KVNamespace
}

function request(method: "GET" | "PUT", body?: Record<string, unknown>): Request {
  const headers = new Headers({ cookie: `${SESSION_COOKIE}=${SESSION_ID}`, origin: PORTAL_ORIGIN })
  if (body) headers.set("content-type", "application/json")
  return new Request("https://api.sigilix.ai/gitlab/connect/repository-context", {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

describe("GitLab canonical repository-context route", () => {
  let db: D1Database
  let kv: KVNamespace
  let env: Env
  let claims: Array<{ externalId: string; claimToken: string }>

  beforeEach(async () => {
    db = makeD1()
    await db.exec(CONTEXT_MIGRATION)
    await db.exec(AUTHORITY_MIGRATION)
    kv = makeKV()
    await createSession({
      kv,
      sessionId: SESSION_ID,
      login: "owner",
      userId: USER_ID,
      accessToken: "",
      encryptionKeyB64url: ENC_KEY,
    })
    env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      OPENCLAW_REPOSITORY_CONTEXT_API: "on",
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    claims = []
    for (const project of [
      { sourceId: 5, fullName: "grp/api" },
      { sourceId: 6, fullName: "grp/worker" },
    ]) {
      const claim = await claimGitLabRepositoryAuthority(db, {
        scopeId: USER_ID,
        instanceOrigin: "https://gitlab.com",
        ...project,
      })
      if (claim.status !== "claimed") throw new Error("expected seeded claim")
      const active = await activateGitLabRepositoryAuthority(db, {
        scopeId: USER_ID,
        externalId: claim.repository.externalId,
        claimToken: claim.claimToken,
      })
      expect(active.status).toBe("activated")
      claims.push({ externalId: claim.repository.externalId, claimToken: claim.claimToken })
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("round-trips the exact active GitLab repository set through worker.fetch and guarded D1", async () => {
    const put = await worker.fetch(
      request("PUT", {
        revision: 0,
        authorityRevision: 2,
        repositories: [
          { repositoryId: 5, context: "Public API" },
          { repositoryId: 6, context: "Background workers" },
        ],
        relationships: [{ fromRepositoryId: 5, toRepositoryId: 6, label: "queues work" }],
        conventions: "Use conventional commits.",
      }),
      env,
      ctx,
    )
    expect(put.status).toBe(200)
    expect(put.headers.get("access-control-allow-origin")).toBe(PORTAL_ORIGIN)
    expect(put.headers.get("cache-control")).toBe("private, no-store")
    expect(await put.json()).toMatchObject({
      provider: "gitlab",
      scopeId: USER_ID,
      revision: 1,
      authorityRevision: 2,
      repositories: [
        { repositoryId: 5, fullName: "grp/api", context: "Public API" },
        { repositoryId: 6, fullName: "grp/worker", context: "Background workers" },
      ],
    })

    const stored = await readRepositoryContext(db, "gitlab", USER_ID)
    expect(stored).toMatchObject({
      status: "ok",
      snapshot: {
        revision: 1,
        repositories: [
          { externalId: claims[0]!.externalId, fullName: "grp/api", context: "Public API" },
          { externalId: claims[1]!.externalId, fullName: "grp/worker", context: "Background workers" },
        ],
      },
    })

    const get = await worker.fetch(request("GET"), env, ctx)
    expect(get.status).toBe(200)
    expect(await get.json()).toMatchObject({
      revision: 1,
      authorityRevision: 2,
      conventions: "Use conventional commits.",
    })
  })

  it("rejects a stale full replacement after disconnect and preserves the prior context revision", async () => {
    const first = await worker.fetch(
      request("PUT", {
        revision: 0,
        authorityRevision: 2,
        repositories: [
          { repositoryId: 5, context: "Public API" },
          { repositoryId: 6, context: "Worker" },
        ],
        relationships: [],
        conventions: "",
      }),
      env,
      ctx,
    )
    expect(first.status).toBe(200)
    await releaseGitLabRepositoryAuthority(db, {
      scopeId: USER_ID,
      externalId: claims[1]!.externalId,
      claimToken: claims[1]!.claimToken,
    })

    const stale = await worker.fetch(
      request("PUT", {
        revision: 1,
        authorityRevision: 2,
        repositories: [
          { repositoryId: 5, context: "Changed" },
          { repositoryId: 6, context: "Changed" },
        ],
        relationships: [],
        conventions: "changed",
      }),
      env,
      ctx,
    )
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: "repository_scope_changed" })
    await expect(readRepositoryContext(db, "gitlab", USER_ID)).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 1, conventions: "" },
    })
  })

  it("does not return a repository disconnected between the authority and context reads", async () => {
    const first = await worker.fetch(
      request("PUT", {
        revision: 0,
        authorityRevision: 2,
        repositories: [
          { repositoryId: 5, context: "Public API" },
          { repositoryId: 6, context: "Worker" },
        ],
        relationships: [],
        conventions: "",
      }),
      env,
      ctx,
    )
    expect(first.status).toBe(200)

    let batchCalls = 0
    const racingDb = {
      prepare: db.prepare.bind(db),
      batch: async (statements: D1PreparedStatement[]) => {
        const results = await db.batch(statements)
        batchCalls += 1
        if (batchCalls === 1) {
          await releaseGitLabRepositoryAuthority(db, {
            scopeId: USER_ID,
            externalId: claims[1]!.externalId,
            claimToken: claims[1]!.claimToken,
          })
        }
        return results
      },
    } as unknown as D1Database

    const get = await worker.fetch(request("GET"), { ...env, SIGILIX_PLATFORM_DB: racingDb }, ctx)
    expect(get.status).toBe(409)
    expect(await get.json()).toEqual({ error: "repository_scope_changed" })
  })

  it("rejects a stale authority revision even when the submitted repository ids still match", async () => {
    const stale = await worker.fetch(
      request("PUT", {
        revision: 0,
        authorityRevision: 1,
        repositories: [
          { repositoryId: 5, context: "Public API" },
          { repositoryId: 6, context: "Worker" },
        ],
        relationships: [],
        conventions: "",
      }),
      env,
      ctx,
    )
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: "repository_scope_changed" })
    await expect(readRepositoryContext(db, "gitlab", USER_ID)).resolves.toEqual({ status: "not_found" })
  })

  it("does not treat pre-activation connector KV as repository-context authority", async () => {
    const isolatedDb = makeD1()
    await isolatedDb.exec(CONTEXT_MIGRATION)
    await isolatedDb.exec(AUTHORITY_MIGRATION)
    await kv.put("gitlab-project-token:99", "glpat-not-authority")
    await kv.put("gitlab-webhook-secret:99", "not-authority")
    await kv.put(
      "gitlab-connection:99",
      JSON.stringify({ userId: USER_ID, projectPath: "grp/forged", name: "forged", hookId: 1, connectedAt: "t" }),
    )
    const response = await worker.fetch(request("GET"), { ...env, SIGILIX_PLATFORM_DB: isolatedDb }, ctx)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ authorityRevision: 0, repositories: [] })
  })
})
