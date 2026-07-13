// Personal agent-memory authorization — full HTTP ingress regression.
//
// Drives the real Worker fetch handler with real D1 API-key rows and encrypted
// portal sessions. Two members share one installation, which is the boundary
// the old implementation got wrong: it confined records to the installation
// but trusted body userId for writes/queries and let list/delete span every seat.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import worker from "@/src/index"
import { insertApiKey } from "@/src/lib/api-key-store"
import { sha256Hex } from "@/src/lib/auth-bearer"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"

const INSTALLATION_ID = 42
const TOKEN_A = "sigilix_live_memory_member_a"
const TOKEN_B = "sigilix_live_memory_member_b"
const GLOBAL_TOKEN = "legacy-global-memory-key"
const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(7))
const DIMS = 768

const API_KEY_MIGRATION = readFileSync(
  new URL("../migrations/0003_create_account_tenant_and_api_key.sql", import.meta.url),
  "utf8",
)
const IDENTITY_MIGRATION = readFileSync(new URL("../migrations/0006_create_user_identity.sql", import.meta.url), "utf8")

interface FakeKV {
  kv: KVNamespace
  store: Map<string, string>
}

function fakeKV(): FakeKV {
  const store = new Map<string, string>()
  const kv = {
    get: async (key: string, type?: string) => {
      const raw = store.get(key)
      if (raw === undefined) return null
      return type === "json" ? JSON.parse(raw) : raw
    },
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
    list: async (opts?: { prefix?: string; limit?: number; cursor?: string }) => {
      const prefix = opts?.prefix ?? ""
      const limit = opts?.limit ?? 1000
      const all = [...store.keys()].filter((key) => key.startsWith(prefix)).sort()
      const remaining = opts?.cursor ? all.filter((key) => key > opts.cursor!) : all
      const keys = remaining.slice(0, limit)
      const listComplete = keys.length >= remaining.length
      const cursor = keys[keys.length - 1]
      return {
        keys: keys.map((name) => ({ name })),
        list_complete: listComplete,
        ...(listComplete || cursor === undefined ? {} : { cursor }),
      }
    },
  }
  return { kv: kv as unknown as KVNamespace, store }
}

interface StoredVector {
  id: string
  namespace: string
  metadata?: Record<string, string | number>
}

function fakeIndex(): Env["OPENCLAW_AGENT_MEMORY_INDEX"] {
  const vectors: StoredVector[] = []
  return {
    upsert: async (records: StoredVector[]) => {
      vectors.push(...records)
    },
    query: async (_vector: number[], options: { namespace?: string; topK?: number }) => ({
      matches: vectors
        .filter((vector) => vector.namespace === options.namespace)
        .slice(0, options.topK ?? 8)
        .map((vector) => ({ id: vector.id, score: 0.9, metadata: vector.metadata ?? {} })),
    }),
    deleteByIds: async (ids: string[]) => {
      for (const id of ids) {
        const index = vectors.findIndex((vector) => vector.id === id)
        if (index >= 0) vectors.splice(index, 1)
      }
    },
  } as unknown as Env["OPENCLAW_AGENT_MEMORY_INDEX"]
}

function fakeAi(): Env["AI"] {
  return {
    run: async () => ({ data: [Array.from({ length: DIMS }, () => 0.1)], shape: [1, DIMS] }),
  } as unknown as Env["AI"]
}

function ctx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext
}

async function seedIdentity(db: D1Database, userId: string, githubUserId: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO user_identity " +
        "(user_id, github_user_id, providers, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(userId, githubUserId, '["github"]', "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
    .run()
}

async function seedKey(
  db: D1Database,
  args: { token: string; id: string; installationId: number; createdBy: string },
): Promise<void> {
  await insertApiKey(db, {
    id: args.id,
    keyHash: await sha256Hex(args.token),
    installationId: args.installationId,
    createdBy: args.createdBy,
    nowIso: "2026-01-01T00:00:00Z",
  })
}

function apiRequest(method: string, path: string, token: string, body?: unknown): Request {
  return new Request(`https://worker.example${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function sessionRequest(method: string, path: string, sessionId: string): Request {
  return new Request(`https://worker.example${path}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
  })
}

const writeBody = (userId: string, content: string) => ({
  userId,
  repoId: "sigilix/api",
  kind: "preference",
  content,
})

let env: Env
let kv: FakeKV

beforeEach(async () => {
  kv = fakeKV()
  const db = makeD1()
  await db.exec(API_KEY_MIGRATION)
  await db.exec(IDENTITY_MIGRATION)
  await seedIdentity(db, "user-a", "111")
  await seedIdentity(db, "user-b", "222")
  await seedKey(db, { token: TOKEN_A, id: "key-a", installationId: INSTALLATION_ID, createdBy: "111" })
  await seedKey(db, { token: TOKEN_B, id: "key-b", installationId: INSTALLATION_ID, createdBy: "222" })

  env = {
    SIGILIX_PLATFORM_DB: db,
    OPENCLAW_SIGILIX_API_KEY: GLOBAL_TOKEN,
    OPENCLAW_STATE: kv.kv,
    OPENCLAW_AGENT_MEMORY_INDEX: fakeIndex(),
    OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
    AI: fakeAi(),
  } as unknown as Env

  await createSession({
    kv: kv.kv,
    sessionId: "session-a",
    login: "alice",
    githubUserId: 111,
    userId: "user-a",
    accessToken: "ghu_alice",
    encryptionKeyB64url: ENC_KEY,
  })
  await createSession({
    kv: kv.kv,
    sessionId: "session-forged",
    login: "alice",
    githubUserId: 111,
    userId: "user-b",
    accessToken: "ghu_alice",
    encryptionKeyB64url: ENC_KEY,
  })
  await createSession({
    kv: kv.kv,
    sessionId: "session-b",
    login: "bob",
    githubUserId: 222,
    userId: "user-b",
    accessToken: "ghu_bob",
    encryptionKeyB64url: ENC_KEY,
  })

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/user/installations")) {
        return new Response(JSON.stringify({ total_count: 1, installations: [{ id: INSTALLATION_ID }] }), {
          status: 200,
        })
      }
      return new Response("{}", { status: 404 })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("agent memory personal authorization (real worker.fetch)", () => {
  it("ignores a spoofed body userId for writes and queries within one installation", async () => {
    const written = await worker.fetch(
      apiRequest("PUT", "/v1/memory", TOKEN_A, writeBody("user-b", "Alice private preference")),
      env,
      ctx(),
    )
    expect(written.status).toBe(200)

    const bobQuery = await worker.fetch(
      apiRequest("POST", "/v1/memory/query", TOKEN_B, {
        userId: "user-b",
        repoId: "sigilix/api",
        query: "preference",
      }),
      env,
      ctx(),
    )
    expect(bobQuery.status).toBe(200)
    expect(((await bobQuery.json()) as { results: unknown[] }).results).toEqual([])

    const aliceQuery = await worker.fetch(
      apiRequest("POST", "/v1/memory/query", TOKEN_A, {
        userId: "user-b",
        repoId: "sigilix/api",
        query: "preference",
      }),
      env,
      ctx(),
    )
    expect(
      ((await aliceQuery.json()) as { results: Array<{ content: string }> }).results.map((result) => result.content),
    ).toEqual(["Alice private preference"])
  })

  it("lets a portal session manage only its own member records, never a same-org peer's", async () => {
    const aliceWrite = await worker.fetch(
      apiRequest("PUT", "/v1/memory", TOKEN_A, writeBody("user-b", "Alice memory")),
      env,
      ctx(),
    )
    const bobWrite = await worker.fetch(
      apiRequest("PUT", "/v1/memory", TOKEN_B, writeBody("user-a", "Bob memory")),
      env,
      ctx(),
    )
    const aliceId = ((await aliceWrite.json()) as { id: string }).id
    const bobId = ((await bobWrite.json()) as { id: string }).id

    const listed = await worker.fetch(sessionRequest("GET", "/v1/memory", "session-a"), env, ctx())
    expect(listed.status).toBe(200)
    expect(
      ((await listed.json()) as { memories: Array<{ content: string }> }).memories.map((memory) => memory.content),
    ).toEqual(["Alice memory"])

    const crossDelete = await worker.fetch(sessionRequest("DELETE", `/v1/memory/${bobId}`, "session-a"), env, ctx())
    expect(crossDelete.status).toBe(404)

    const bobList = await worker.fetch(sessionRequest("GET", "/v1/memory", "session-b"), env, ctx())
    expect(((await bobList.json()) as { memories: Array<{ id: string }> }).memories.map((memory) => memory.id)).toEqual(
      [bobId],
    )

    const ownDelete = await worker.fetch(sessionRequest("DELETE", `/v1/memory/${aliceId}`, "session-a"), env, ctx())
    expect(ownDelete.status).toBe(200)
  })

  it("denies the legacy global key on personal-memory routes", async () => {
    const response = await worker.fetch(
      apiRequest("PUT", "/v1/memory", GLOBAL_TOKEN, writeBody("user-a", "global write")),
      env,
      ctx(),
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "memory_identity_unavailable" })
  })

  it("rejects a session whose stored user id disagrees with its authenticated GitHub identity", async () => {
    const response = await worker.fetch(sessionRequest("GET", "/v1/memory", "session-forged"), env, ctx())
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "memory_identity_unavailable" })
  })
})
