import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { sha256Hex } from "@/src/lib/auth-bearer"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { handleResearchCreate } from "@/src/do/deep-research/routes"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(7))
const MIGRATION_0001 = readFileSync(
  new URL("../../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url),
  "utf8",
)
const MIGRATION_0003 = readFileSync(
  new URL("../../../migrations/0003_create_account_tenant_and_api_key.sql", import.meta.url),
  "utf8",
)
const MIGRATION_0004 = readFileSync(
  new URL("../../../migrations/0004_create_usage_events.sql", import.meta.url),
  "utf8",
)

function makeKv(seed: Record<string, string> = {}): KVNamespace {
  const store = new Map(Object.entries(seed))
  return {
    get: async (key: string, type?: "json") => {
      const value = store.get(key)
      return value === undefined ? null : type === "json" ? JSON.parse(value) : value
    },
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
    list: async (opts?: { prefix?: string }) => ({
      keys: [...store.keys()]
        .filter((key) => !opts?.prefix || key.startsWith(opts.prefix))
        .sort()
        .map((name) => ({ name })),
      list_complete: true,
    }),
  } as unknown as KVNamespace
}

function request(body: unknown): Request {
  return new Request("https://api.sigilix.ai/v1/research", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=session-1` },
    body: JSON.stringify(body),
  })
}

function apiRequest(body: unknown, token: string): Request {
  return new Request("https://api.sigilix.ai/v1/research", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

function deepResearchNamespace(onStart: (body: Record<string, unknown>) => void): Env["DEEP_RESEARCH"] {
  return {
    newUniqueId: () => ({ toString: () => "run-1" }),
    get: () => ({
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        onStart(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response("{}")
      },
    }),
  } as unknown as Env["DEEP_RESEARCH"]
}

const ctx = {
  waitUntil(promise: Promise<unknown>) {
    void promise
  },
  passThroughOnException() {},
} as unknown as ExecutionContext

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("handleResearchCreate — session org repo grounding", () => {
  it("resolves the configured indexed org repo from the session's exact GitHub installation scope", async () => {
    const kv = makeKv({
      "repo-index-manifest:sigilix/.github": "{}",
      "repo-index-manifest:sigilix/sigilix": "{}",
      "deep-research-default-repo:134811639": "Sigilix/sigilix",
    })
    await createSession({
      kv,
      sessionId: "session-1",
      login: "founder",
      githubUserId: 42,
      accessToken: "github-user-token",
      encryptionKeyB64url: ENC_KEY,
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString()
        if (url.includes("/user/installations?")) {
          return new Response(
            JSON.stringify({ total_count: 1, installations: [{ id: 134811639, account: { login: "Sigilix" } }] }),
            { headers: { "content-type": "application/json" } },
          )
        }
        if (url.includes("/user/installations/134811639/repositories?")) {
          return new Response(
            JSON.stringify({
              total_count: 2,
              repositories: [{ full_name: "Sigilix/.github" }, { full_name: "Sigilix/sigilix" }],
            }),
            { headers: { "content-type": "application/json" } },
          )
        }
        return new Response("unexpected", { status: 404 })
      }),
    )
    let startBody: Record<string, unknown> | null = null
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      DEEP_RESEARCH: deepResearchNamespace((body) => {
        startBody = body
      }),
    } as unknown as Env

    const response = await handleResearchCreate(
      request({
        question: "Where does the per-tier rate-limit cap get computed, and what are the multipliers?",
        mode: "chat",
      }),
      env,
      ctx,
    )

    expect(response.status).toBe(200)
    expect(startBody).toMatchObject({ owner: "Sigilix", repo: "sigilix", hasIndexedRepo: true })
  })

  it("logs and fails closed when the exact GitHub repo scope cannot be listed", async () => {
    const kv = makeKv({ "repo-index-manifest:victim/secret": "{}" })
    await createSession({
      kv,
      sessionId: "session-1",
      login: "founder",
      githubUserId: 42,
      accessToken: "github-user-token",
      encryptionKeyB64url: ENC_KEY,
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503 })),
    )
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    let startBody: Record<string, unknown> | null = null
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      DEEP_RESEARCH: deepResearchNamespace((body) => {
        startBody = body
      }),
    } as unknown as Env

    const response = await handleResearchCreate(
      request({ question: "where does the auth handler get implemented?", mode: "chat" }),
      env,
      ctx,
    )

    expect(response.status).toBe(200)
    expect(startBody).not.toHaveProperty("owner")
    expect(startBody).not.toHaveProperty("repo")
    expect(error).toHaveBeenCalledWith(expect.stringContaining("deep-research-repo-scope-failed"))
  })

  it("does not call GitHub for ordinary non-codebase chat", async () => {
    const kv = makeKv({ "repo-index-manifest:victim/secret": "{}" })
    await createSession({
      kv,
      sessionId: "session-1",
      login: "victim",
      githubUserId: 42,
      accessToken: "github-user-token",
      encryptionKeyB64url: ENC_KEY,
    })
    const githubFetch = vi.fn(async () => new Response("unexpected", { status: 500 }))
    vi.stubGlobal("fetch", githubFetch)
    let startBody: Record<string, unknown> | null = null
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      DEEP_RESEARCH: deepResearchNamespace((body) => {
        startBody = body
      }),
    } as unknown as Env

    const response = await handleResearchCreate(
      request({ question: "what is the capital of France?", mode: "chat" }),
      env,
      ctx,
    )

    expect(response.status).toBe(200)
    expect(githubFetch).not.toHaveBeenCalled()
    expect(startBody).not.toHaveProperty("owner")
    expect(startBody).not.toHaveProperty("repo")
  })

  it("never falls back from a failed live scope to a matching indexed owner in deep mode", async () => {
    const kv = makeKv({ "repo-index-manifest:victim/secret": "{}" })
    await createSession({
      kv,
      sessionId: "session-1",
      login: "victim",
      githubUserId: 42,
      accessToken: "github-user-token",
      encryptionKeyB64url: ENC_KEY,
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("scope unavailable", { status: 503 })),
    )
    vi.spyOn(console, "error").mockImplementation(() => {})
    let startBody: Record<string, unknown> | null = null
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      DEEP_RESEARCH: deepResearchNamespace((body) => {
        startBody = body
      }),
    } as unknown as Env

    const response = await handleResearchCreate(
      request({ question: "what is the capital of France?", mode: "deep" }),
      env,
      ctx,
    )

    expect(response.status).toBe(200)
    expect(startBody).not.toHaveProperty("owner")
    expect(startBody).not.toHaveProperty("repo")
    expect(startBody).toMatchObject({ hasIndexedRepo: false })
  })

  it("resolves an installation-bound API key through D1 without a static installation map", async () => {
    const token = "sigilix_live_route-test"
    const db = makeD1()
    await db.exec(MIGRATION_0001)
    await db.exec(MIGRATION_0003)
    await db.exec(MIGRATION_0004)
    await db.prepare("INSERT INTO tenant (installation_id, created_at, updated_at) VALUES (134811639, 't', 't')").run()
    await db
      .prepare(
        "INSERT INTO repo (repo_id, installation_id, full_name, updated_at)" +
          " VALUES (1225209204, 134811639, 'Sigilix/sigilix', 't')",
      )
      .run()
    await db
      .prepare(
        "INSERT INTO api_key (id, key_hash, installation_id, created_by, created_at) VALUES ('k1', ?, 134811639, '42', 't')",
      )
      .bind(await sha256Hex(token))
      .run()
    const kv = makeKv({
      "repo-index-manifest:sigilix/sigilix": "{}",
      "deep-research-default-repo:134811639": "Sigilix/sigilix",
    })
    let startBody: Record<string, unknown> | null = null
    const env = {
      OPENCLAW_STATE: kv,
      SIGILIX_PLATFORM_DB: db,
      DEEP_RESEARCH: deepResearchNamespace((body) => {
        startBody = body
      }),
    } as unknown as Env

    const response = await handleResearchCreate(
      apiRequest(
        {
          question: "Where does the per-tier rate-limit cap get computed, and what are the multipliers?",
          mode: "chat",
        },
        token,
      ),
      env,
      ctx,
    )

    expect(response.status).toBe(200)
    expect(startBody).toMatchObject({ owner: "Sigilix", repo: "sigilix", hasIndexedRepo: true })
  })
})
