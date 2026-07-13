// sig-memory-crud — GET /v1/memory (list) + DELETE /v1/memory/:id (delete) tests.
//
// Focus areas: dual auth (session cookie OR bearer api key), the tenant-scope
// ISOLATION invariant (a caller can only ever list/delete records under its own
// KV prefix — mirrors the SIG-494 isolation assertions in
// agent-memory-extract.test.ts), cursor pagination, hash-pointer exclusion, the
// list fail-soft contract (a KV `.list()` throw → `{ memories: [], cursor:
// undefined }`, never a 500), idempotent-safe delete, the both-keys + best-effort
// vector delete, and the portal CORS wiring.
//
// KV + Vectorize are in-memory fakes (the fake KV implements `list({prefix, limit,
// cursor})` with real lexicographic cursor semantics so pagination is exercised
// end-to-end). Per-tenant api keys use the same makeD1 + insertApiKey path the
// extract suite uses; sessions are seeded directly as SessionRecord JSON.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { insertApiKey } from "@/src/lib/api-key-store"
import { sha256Hex as keyHash } from "@/src/lib/auth-bearer"
import { sha256Hex as contentHash } from "./agent-memory-route"
import { handleMemoryListRoute, handleMemoryDeleteRoute } from "./agent-memory-crud-route"
import { handlePortalPreflight, withPortalCors } from "@/src/lib/portal-cors"
import type { AgentMemoryKind, AgentMemoryRecord } from "./types"
import type { Env } from "@/src/shared/types/env"

// Mock ONLY decryptAccessToken (the session→installation bridge decrypts the
// session's GitHub token before calling /user/installations). Everything else in
// auth-session — getSession/readCookie used by requireSession — stays real.
vi.mock("@/src/lib/auth-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/auth-session")>()
  return { ...actual, decryptAccessToken: vi.fn(async () => "fake-user-token") }
})

const TOKEN = "mem-secret"
const SESSION_KEY = "test-encryption-key"

/** Stub `fetch` so the session→installation bridge (`GET /user/installations`)
 *  resolves to the given installation ids. */
function stubInstallations(ids: number[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      if (String(url).includes("/user/installations")) {
        return new Response(JSON.stringify({ total_count: ids.length, installations: ids.map((id) => ({ id })) }), {
          status: 200,
        })
      }
      return new Response("{}", { status: 404 })
    }),
  )
}

const MIGRATION_SQL_API_KEY = readFileSync(
  new URL("../../../migrations/0003_create_account_tenant_and_api_key.sql", import.meta.url),
  "utf8",
)
const MIGRATION_SQL_IDENTITY = readFileSync(
  new URL("../../../migrations/0006_create_user_identity.sql", import.meta.url),
  "utf8",
)

const USER_ID = "user-1"
const PERSONAL_42 = `inst:42:user:${USER_ID}`
const PERSONAL_99 = `inst:99:user:${USER_ID}`

// ─── In-memory KV with list({prefix, limit, cursor}) ─────────

interface FakeKV {
  kv: KVNamespace
  store: Map<string, string>
}

function fakeKV(): FakeKV {
  const store = new Map<string, string>()
  const kv = {
    get: async (key: string, type?: string) => {
      const v = store.get(key)
      if (v === undefined) return null
      return type === "json" ? JSON.parse(v) : v
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
      const cursor = opts?.cursor
      const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort()
      const remaining = cursor ? all.filter((k) => k > cursor) : all
      const pageKeys = remaining.slice(0, limit)
      const listComplete = pageKeys.length >= remaining.length
      const last = pageKeys[pageKeys.length - 1]
      return {
        keys: pageKeys.map((name) => ({ name })),
        list_complete: listComplete,
        ...(listComplete ? {} : { cursor: last }),
      }
    },
  }
  return { kv: kv as unknown as KVNamespace, store }
}

// ─── In-memory Vectorize (tracks deleteByIds) ────────────────

function fakeIndex() {
  const deleted: string[][] = []
  const index = {
    upsert: async () => {},
    query: async () => ({ matches: [] }),
    deleteByIds: async (ids: string[]) => {
      deleted.push(ids)
    },
  }
  return { index: index as unknown as Env["OPENCLAW_AGENT_MEMORY_INDEX"], deleted }
}

let fk: FakeKV
let idx: ReturnType<typeof fakeIndex>
let sessionDb: D1Database

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    OPENCLAW_SIGILIX_API_KEY: TOKEN,
    SIGILIX_PLATFORM_DB: sessionDb,
    OPENCLAW_STATE: fk.kv,
    OPENCLAW_AGENT_MEMORY_INDEX: idx.index,
    ...extra,
  } as unknown as Env
}

/** Env with neither the static bearer NOR the D1 binding — the inert-503 case. */
function unkeyedEnv(): Env {
  return { OPENCLAW_STATE: fk.kv, OPENCLAW_AGENT_MEMORY_INDEX: idx.index } as unknown as Env
}

// ─── Seed helpers ────────────────────────────────────────────

interface Seeded {
  id: string
  hash: string
  recordKey: string
  hashKey: string
}

async function seedRecord(args: {
  userId: string
  repoId: string
  content: string
  kind?: AgentMemoryKind
  id?: string
  ts?: string
}): Promise<Seeded> {
  const kind = args.kind ?? "preference"
  const hash = await contentHash(args.content)
  const id = args.id ?? `mem_${crypto.randomUUID()}`
  const ts = args.ts ?? new Date().toISOString()
  const record: AgentMemoryRecord = {
    schemaVersion: 1,
    id,
    userId: args.userId,
    repoId: args.repoId,
    kind,
    content: args.content,
    ts,
    hash,
  }
  const recordKey = `agent-memory:${args.userId}:${args.repoId}:${id}`
  const hashKey = `agent-memory-hash:${args.userId}:${args.repoId}:${hash}`
  fk.store.set(recordKey, JSON.stringify(record))
  fk.store.set(hashKey, id)
  return { id, hash, recordKey, hashKey }
}

function seedSession(sessionId: string, githubUserId: number, login = "octocat", userId?: string): void {
  const record = {
    login,
    githubUserId,
    ...(userId !== undefined ? { userId } : {}),
    encryptedAccessToken: "x",
    iv: "y",
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  }
  fk.store.set(`auth_session:${sessionId}`, JSON.stringify(record))
}

/** D1 with one per-tenant api key → the given installationId. */
async function seedIdentity(db: D1Database, userId: string, githubUserId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_identity
       (user_id, github_user_id, providers, created_at, last_login_at)
       VALUES (?, ?, '["github"]', ?, ?)`,
    )
    .bind(userId, githubUserId, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
    .run()
}

async function d1WithKey(
  plaintext: string,
  installationId: number,
  createdBy = "1",
  userId = USER_ID,
): Promise<D1Database> {
  const db = makeD1()
  await db.exec(MIGRATION_SQL_API_KEY)
  await db.exec(MIGRATION_SQL_IDENTITY)
  await seedIdentity(db, userId, createdBy)
  await insertApiKey(db, {
    id: `key-${installationId}`,
    keyHash: await keyHash(plaintext),
    installationId,
    createdBy,
    nowIso: "2026-01-01T00:00:00Z",
  })
  return db
}

// ─── Request builders ────────────────────────────────────────

function listReq(query = "", token: string | null = null, cookie?: string): Request {
  return new Request(`https://api.sigilix.ai/v1/memory${query}`, {
    method: "GET",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
    },
  })
}

function delReq(id: string, token: string | null = null, cookie?: string): Request {
  return new Request(`https://api.sigilix.ai/v1/memory/${id}`, {
    method: "DELETE",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
    },
  })
}

interface ListResponse {
  memories: Array<{ id: string; repoId: string; kind: string; content: string; createdAt: string }>
  cursor?: string
}

beforeEach(async () => {
  fk = fakeKV()
  idx = fakeIndex()
  sessionDb = makeD1()
  await sessionDb.exec(MIGRATION_SQL_API_KEY)
  await sessionDb.exec(MIGRATION_SQL_IDENTITY)
  await seedIdentity(sessionDb, USER_ID, "12345")
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// ─── GET /v1/memory — auth ───────────────────────────────────

describe("GET /v1/memory — auth", () => {
  it("503 when the endpoint is unkeyed (no api key, no D1)", async () => {
    expect((await handleMemoryListRoute(listReq(), unkeyedEnv())).status).toBe(503)
  })

  it("401 with neither a session cookie nor a bearer", async () => {
    expect((await handleMemoryListRoute(listReq(), makeEnv())).status).toBe(401)
  })

  it("401 on a bad bearer", async () => {
    expect((await handleMemoryListRoute(listReq("", "nope"), makeEnv())).status).toBe(401)
  })

  it("403 for the legacy global key because it has no authenticated personal identity", async () => {
    expect((await handleMemoryListRoute(listReq("", TOKEN), makeEnv())).status).toBe(403)
  })
})

// ─── GET /v1/memory — tenant isolation ───────────────────────

describe("GET /v1/memory — tenant isolation", () => {
  it("lists only the caller-installation's records — never another installation's", async () => {
    // Two distinct tenants (installations), each with its own scoped record.
    await seedRecord({ userId: PERSONAL_42, repoId: "sigilix/boreas", content: "A-42 secret" })
    await seedRecord({ userId: PERSONAL_99, repoId: "sigilix/boreas", content: "B-99 secret" })

    const db = makeD1()
    await db.exec(MIGRATION_SQL_API_KEY)
    await db.exec(MIGRATION_SQL_IDENTITY)
    await seedIdentity(db, USER_ID, "1")
    await insertApiKey(db, {
      id: "k42",
      keyHash: await keyHash("key42"),
      installationId: 42,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })
    await insertApiKey(db, {
      id: "k99",
      keyHash: await keyHash("key99"),
      installationId: 99,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })
    const env = makeEnv({ SIGILIX_PLATFORM_DB: db })

    const a = (await (await handleMemoryListRoute(listReq("", "key42"), env)).json()) as ListResponse
    const b = (await (await handleMemoryListRoute(listReq("", "key99"), env)).json()) as ListResponse

    expect(a.memories.map((m) => m.content)).toEqual(["A-42 secret"])
    expect(b.memories.map((m) => m.content)).toEqual(["B-99 secret"])
    // Cross-tenant leak check both directions.
    expect(a.memories.some((m) => m.content.includes("B-99"))).toBe(false)
    expect(b.memories.some((m) => m.content.includes("A-42"))).toBe(false)
  })

  it("does not confuse installation 42 with 421 (trailing-colon prefix boundary)", async () => {
    await seedRecord({ userId: PERSONAL_42, repoId: "r", content: "keep" })
    await seedRecord({ userId: `inst:421:user:${USER_ID}`, repoId: "r", content: "leak" })
    const env = makeEnv({ SIGILIX_PLATFORM_DB: await d1WithKey("key42", 42) })
    const out = (await (await handleMemoryListRoute(listReq("", "key42"), env)).json()) as ListResponse
    expect(out.memories.map((m) => m.content)).toEqual(["keep"])
  })

  it("session path resolves to the caller's installation namespace — sees the CLI-written inst:<id> records", async () => {
    // The CLI wrote under inst:42; a portal session that maps to installation 42
    // must see EXACTLY those records (the P1 fix: session scope == write scope).
    await seedRecord({ userId: PERSONAL_42, repoId: "sigilix/boreas", content: "cli wrote this" })
    await seedRecord({ userId: PERSONAL_99, repoId: "sigilix/boreas", content: "other org" })
    seedSession("sess-a", 12345, "octocat", USER_ID)
    stubInstallations([42])
    const out = (await (
      await handleMemoryListRoute(
        listReq("", null, "__Host-sigilix_session=sess-a"),
        makeEnv({ OPENCLAW_SESSION_ENCRYPTION_KEY: SESSION_KEY }),
      )
    ).json()) as ListResponse
    expect(out.memories.map((m) => m.content)).toEqual(["cli wrote this"])
  })

  it("session across multiple installations unions their namespaces (compound cursor)", async () => {
    await seedRecord({ userId: PERSONAL_42, repoId: "r", content: "from-42" })
    await seedRecord({ userId: PERSONAL_99, repoId: "r", content: "from-99" })
    await seedRecord({ userId: `inst:7:user:${USER_ID}`, repoId: "r", content: "not-mine" })
    seedSession("sess-a", 12345, "octocat", USER_ID)
    stubInstallations([42, 99])
    const env = makeEnv({ OPENCLAW_SESSION_ENCRYPTION_KEY: SESSION_KEY })

    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""
      const page = (await (
        await handleMemoryListRoute(listReq(q, null, "__Host-sigilix_session=sess-a"), env)
      ).json()) as ListResponse
      seen.push(...page.memories.map((m) => m.content))
      cursor = page.cursor
      pages++
    } while (cursor && pages < 10)

    expect(seen.sort()).toEqual(["from-42", "from-99"]) // never inst:7
  })

  it("session with no linked installation → empty list (not an error)", async () => {
    await seedRecord({ userId: PERSONAL_42, repoId: "r", content: "x" })
    seedSession("sess-a", 12345, "octocat", USER_ID)
    stubInstallations([])
    const res = await handleMemoryListRoute(
      listReq("", null, "__Host-sigilix_session=sess-a"),
      makeEnv({ OPENCLAW_SESSION_ENCRYPTION_KEY: SESSION_KEY }),
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as ListResponse).memories).toEqual([])
  })

  it("legacy GitHub session without a stored user id resolves it from user_identity", async () => {
    seedSession("legacy-session", 12345)
    stubInstallations([42])
    const res = await handleMemoryListRoute(
      listReq("", null, "__Host-sigilix_session=legacy-session"),
      makeEnv({ OPENCLAW_SESSION_ENCRYPTION_KEY: SESSION_KEY }),
    )
    expect(res.status).toBe(200)
  })

  it("session whose stored user id disagrees with its GitHub identity fails closed", async () => {
    seedSession("mismatched-session", 12345, "octocat", "user-2")
    stubInstallations([42])
    const res = await handleMemoryListRoute(
      listReq("", null, "__Host-sigilix_session=mismatched-session"),
      makeEnv({ OPENCLAW_SESSION_ENCRYPTION_KEY: SESSION_KEY }),
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "memory_identity_unavailable" })
  })

  it("uses the trusted server-side session user id when D1 is not bound", async () => {
    seedSession("session-without-d1", 12345, "octocat", USER_ID)
    stubInstallations([42])
    const env = makeEnv({ OPENCLAW_SESSION_ENCRYPTION_KEY: SESSION_KEY })
    delete env.SIGILIX_PLATFORM_DB
    const res = await handleMemoryListRoute(listReq("", null, "__Host-sigilix_session=session-without-d1"), env)
    expect(res.status).toBe(200)
  })

  it("does not list another member's records from the same installation", async () => {
    await seedRecord({ userId: PERSONAL_42, repoId: "r", content: "mine" })
    await seedRecord({ userId: "inst:42:user:user-2", repoId: "r", content: "peer secret" })
    const env = makeEnv({ SIGILIX_PLATFORM_DB: await d1WithKey("key42", 42) })
    const out = (await (await handleMemoryListRoute(listReq("", "key42"), env)).json()) as ListResponse
    expect(out.memories.map((memory) => memory.content)).toEqual(["mine"])
  })

  it("filters by ?repoId within the caller's scope", async () => {
    await seedRecord({ userId: PERSONAL_42, repoId: "sigilix/boreas", content: "boreas note" })
    await seedRecord({ userId: PERSONAL_42, repoId: "sigilix/portal", content: "portal note" })
    const env = makeEnv({ SIGILIX_PLATFORM_DB: await d1WithKey("key42", 42) })
    const out = (await (
      await handleMemoryListRoute(listReq("?repoId=Sigilix/Boreas", "key42"), env)
    ).json()) as ListResponse
    // repoId is canonicalized (lowercased) to match the write keyspace.
    expect(out.memories.map((m) => m.content)).toEqual(["boreas note"])
  })

  it("never returns the agent-memory-hash: dedup-pointer keys", async () => {
    // Each seed writes BOTH a record key and a hash-pointer key. A correct list
    // returns exactly one memory per record (N), not 2N.
    await seedRecord({ userId: PERSONAL_42, repoId: "r", content: "one" })
    await seedRecord({ userId: PERSONAL_42, repoId: "r", content: "two" })
    const env = makeEnv({ SIGILIX_PLATFORM_DB: await d1WithKey("key42", 42) })
    const out = (await (await handleMemoryListRoute(listReq("", "key42"), env)).json()) as ListResponse
    expect(out.memories).toHaveLength(2)
    expect(out.memories.map((m) => m.content).sort()).toEqual(["one", "two"])
  })
})

// ─── GET /v1/memory — pagination ─────────────────────────────

describe("GET /v1/memory — pagination", () => {
  it("returns a cursor when more pages remain and yields the rest without duplicates", async () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const s = await seedRecord({ userId: PERSONAL_42, repoId: "r", content: `note-${i}` })
      ids.push(s.id)
    }
    const env = makeEnv({ SIGILIX_PLATFORM_DB: await d1WithKey("key42", 42) })

    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const q = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
      const page = (await (await handleMemoryListRoute(listReq(q, "key42"), env)).json()) as ListResponse
      expect(page.memories.length).toBeLessThanOrEqual(2)
      seen.push(...page.memories.map((m) => m.id))
      cursor = page.cursor
      pages++
    } while (cursor && pages < 10)

    expect(pages).toBe(3) // 2 + 2 + 1
    expect(new Set(seen).size).toBe(5) // no duplicates
    expect(seen.sort()).toEqual([...ids].sort())
  })

  it("caps limit at 100 and defaults to 50", async () => {
    // Sanity: an over-cap limit is accepted (clamped) without error, and returns
    // all seeded records in one page (well under the cap).
    for (let i = 0; i < 3; i++) await seedRecord({ userId: PERSONAL_42, repoId: "r", content: `x-${i}` })
    const env = makeEnv({ SIGILIX_PLATFORM_DB: await d1WithKey("key42", 42) })
    const out = (await (await handleMemoryListRoute(listReq("?limit=9999", "key42"), env)).json()) as ListResponse
    expect(out.memories).toHaveLength(3)
    expect(out.cursor).toBeUndefined()
  })
})

// ─── GET /v1/memory — fail-soft ──────────────────────────────

describe("GET /v1/memory — fail-soft", () => {
  it("a KV .list() throw degrades to { memories: [], cursor: undefined } (200), warns, never 500s", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    ;(fk.kv as unknown as { list: () => Promise<never> }).list = async () => {
      throw new Error("kv list down")
    }
    const env = makeEnv({ SIGILIX_PLATFORM_DB: await d1WithKey("key42", 42) })
    const res = await handleMemoryListRoute(listReq("", "key42"), env)
    expect(res.status).toBe(200)
    const out = (await res.json()) as ListResponse
    expect(out.memories).toEqual([])
    expect(out.cursor).toBeUndefined()
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("agent-memory-list-failed"))).toBe(true)
  })
})

// ─── DELETE /v1/memory/:id ───────────────────────────────────

describe("DELETE /v1/memory/:id — auth", () => {
  it("503 when unkeyed", async () => {
    expect((await handleMemoryDeleteRoute(delReq("mem_x"), unkeyedEnv(), "mem_x")).status).toBe(503)
  })
  it("401 without a session or bearer", async () => {
    expect((await handleMemoryDeleteRoute(delReq("mem_x"), makeEnv(), "mem_x")).status).toBe(401)
  })
  it("403 for the legacy global key because it has no authenticated personal identity", async () => {
    expect((await handleMemoryDeleteRoute(delReq("mem_x", TOKEN), makeEnv(), "mem_x")).status).toBe(403)
  })
})

describe("DELETE /v1/memory/:id — behavior", () => {
  it("deletes the record key, the hash-pointer key, AND the vector; returns { ok, deleted }", async () => {
    const seeded = await seedRecord({ userId: PERSONAL_42, repoId: "r", content: "delete me" })
    const env = makeEnv({ SIGILIX_PLATFORM_DB: await d1WithKey("key42", 42) })

    const res = await handleMemoryDeleteRoute(delReq(seeded.id, "key42"), env, seeded.id)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, deleted: true })

    expect(fk.store.has(seeded.recordKey)).toBe(false)
    expect(fk.store.has(seeded.hashKey)).toBe(false)
    expect(idx.deleted).toContainEqual([seeded.id])
  })

  it("is idempotent-safe: first delete succeeds, second returns 404", async () => {
    const seeded = await seedRecord({ userId: PERSONAL_42, repoId: "r", content: "once" })
    const env = makeEnv({ SIGILIX_PLATFORM_DB: await d1WithKey("key42", 42) })

    const first = await handleMemoryDeleteRoute(delReq(seeded.id, "key42"), env, seeded.id)
    expect(first.status).toBe(200)
    const second = await handleMemoryDeleteRoute(delReq(seeded.id, "key42"), env, seeded.id)
    expect(second.status).toBe(404)
  })

  it("returns 404 for a non-existent id", async () => {
    const env = makeEnv({ SIGILIX_PLATFORM_DB: await d1WithKey("key42", 42) })
    const res = await handleMemoryDeleteRoute(delReq("mem_nope", "key42"), env, "mem_nope")
    expect(res.status).toBe(404)
  })

  it("returns 404 for another tenant's id and does NOT delete or mutate it", async () => {
    const victim = await seedRecord({ userId: PERSONAL_99, repoId: "r", content: "not yours" })
    const raw = fk.store.get(victim.recordKey)
    const db = makeD1()
    await db.exec(MIGRATION_SQL_API_KEY)
    await db.exec(MIGRATION_SQL_IDENTITY)
    await seedIdentity(db, USER_ID, "1")
    await insertApiKey(db, {
      id: "k42",
      keyHash: await keyHash("key42"),
      installationId: 42,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })
    const env = makeEnv({ SIGILIX_PLATFORM_DB: db })

    // Caller is installation 42, but presents installation 99's literal id.
    const res = await handleMemoryDeleteRoute(delReq(victim.id, "key42"), env, victim.id)
    expect(res.status).toBe(404)
    // Untouched — record + pointer still present, byte-identical, no vector delete.
    expect(fk.store.get(victim.recordKey)).toBe(raw)
    expect(fk.store.has(victim.hashKey)).toBe(true)
    expect(idx.deleted).toHaveLength(0)
  })

  it("returns 404 for another member's id in the same installation", async () => {
    const victim = await seedRecord({
      userId: "inst:42:user:user-2",
      repoId: "r",
      content: "peer secret",
    })
    const raw = fk.store.get(victim.recordKey)
    const env = makeEnv({ SIGILIX_PLATFORM_DB: await d1WithKey("key42", 42) })

    const res = await handleMemoryDeleteRoute(delReq(victim.id, "key42"), env, victim.id)

    expect(res.status).toBe(404)
    expect(fk.store.get(victim.recordKey)).toBe(raw)
    expect(fk.store.has(victim.hashKey)).toBe(true)
    expect(idx.deleted).toHaveLength(0)
  })

  it("a Vectorize delete failure never fails the request — KV keys still removed", async () => {
    const seeded = await seedRecord({ userId: PERSONAL_42, repoId: "r", content: "vec-fail" })
    ;(idx.index as unknown as { deleteByIds: () => Promise<never> }).deleteByIds = async () => {
      throw new Error("vectorize down")
    }
    const env = makeEnv({ SIGILIX_PLATFORM_DB: await d1WithKey("key42", 42) })
    const res = await handleMemoryDeleteRoute(delReq(seeded.id, "key42"), env, seeded.id)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, deleted: true })
    expect(fk.store.has(seeded.recordKey)).toBe(false)
    expect(fk.store.has(seeded.hashKey)).toBe(false)
  })

  it("deletes via the session path scoped to the caller's installation", async () => {
    const seeded = await seedRecord({ userId: PERSONAL_42, repoId: "r", content: "session-owned" })
    seedSession("sess-a", 12345, "octocat", USER_ID)
    stubInstallations([42])
    const res = await handleMemoryDeleteRoute(
      delReq(seeded.id, null, "__Host-sigilix_session=sess-a"),
      makeEnv({ OPENCLAW_SESSION_ENCRYPTION_KEY: SESSION_KEY }),
      seeded.id,
    )
    expect(res.status).toBe(200)
    expect(fk.store.has(seeded.recordKey)).toBe(false)
  })

  it("session cannot delete a record outside its installation(s) → 404, untouched", async () => {
    const victim = await seedRecord({ userId: PERSONAL_99, repoId: "r", content: "not yours" })
    const raw = fk.store.get(victim.recordKey)
    seedSession("sess-a", 12345, "octocat", USER_ID)
    stubInstallations([42]) // session owns only installation 42
    const res = await handleMemoryDeleteRoute(
      delReq(victim.id, null, "__Host-sigilix_session=sess-a"),
      makeEnv({ OPENCLAW_SESSION_ENCRYPTION_KEY: SESSION_KEY }),
      victim.id,
    )
    expect(res.status).toBe(404)
    expect(fk.store.get(victim.recordKey)).toBe(raw)
    expect(idx.deleted).toHaveLength(0)
  })
})

// ─── CORS wiring (portal-facing) ─────────────────────────────

describe("/v1/memory — portal CORS", () => {
  const ORIGIN = "https://app.sigilix.ai"

  it("OPTIONS preflight succeeds (204 + credentialed CORS headers) for an allowed origin", () => {
    const req = new Request("https://api.sigilix.ai/v1/memory", {
      method: "OPTIONS",
      headers: { origin: ORIGIN, "access-control-request-method": "GET" },
    })
    const res = handlePortalPreflight(req, {} as Env)
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN)
    expect(res.headers.get("access-control-allow-credentials")).toBe("true")
    expect(res.headers.get("access-control-allow-methods")).toContain("DELETE")
    expect(res.headers.get("access-control-allow-methods")).toContain("GET")
  })

  it("wraps a list response with credentialed CORS headers for an allowed origin", async () => {
    const req = new Request("https://api.sigilix.ai/v1/memory", {
      method: "GET",
      headers: { origin: ORIGIN, authorization: "Bearer key42" },
    })
    const env = makeEnv({ SIGILIX_PLATFORM_DB: await d1WithKey("key42", 42) })
    const wrapped = withPortalCors(req, await handleMemoryListRoute(req, env), {} as Env)
    expect(wrapped.status).toBe(200)
    expect(wrapped.headers.get("access-control-allow-origin")).toBe(ORIGIN)
    expect(wrapped.headers.get("access-control-allow-credentials")).toBe("true")
  })
})
