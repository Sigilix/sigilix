// SIG-483 — PUT /v1/memory + POST /v1/memory/query route tests: auth gating,
// tenant-scope validation, the write/dedup flow, semantic retrieval ordering, and
// the SOFT-FAIL contract (a Vectorize/embed/KV failure → degraded 200, never
// 500). The AI + Vectorize bindings are real fakes here (the route runs its full
// embed → upsert → KV → query → hydrate path through them), so the test exercises
// the actual seams rather than mocking the feature's own modules.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { insertApiKey } from "@/src/lib/api-key-store"
import { sha256Hex } from "@/src/lib/auth-bearer"
import { appendLearning } from "@/src/features/learnings"
import type { LearningEntry } from "@/src/features/learnings"
import { handleMemoryWriteRoute, handleMemoryQueryRoute, scopeMemoryUserId } from "./agent-memory-route"
import { personalMemoryUserId } from "./agent-memory-personal-subject"
import { LEGACY_TENANT_INSTALLATION_ID } from "@/src/lib/api-key-resolver"
import { memoryNamespace } from "./retrieval"
import type { Env } from "@/src/shared/types/env"

const TOKEN = "mem-secret"
const DIMS = 768

// ─── In-memory fakes for KV + AI + Vectorize ─────────────────

function fakeKV(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
  } as unknown as KVNamespace
}

function fakeAi(): Env["AI"] {
  // Deterministic non-zero 768-dim vector (content-insensitive — retrieval order
  // in the fake index is insertion order, which is enough to test the route's
  // ts-sort + hydrate, not embedding quality).
  return {
    run: async () => ({ data: [Array.from({ length: DIMS }, () => 0.1)], shape: [1, DIMS] }),
  } as unknown as Env["AI"]
}

interface FakeVector {
  id: string
  namespace: string
  metadata: Record<string, string | number>
}

/** Captures every upsert (so we can assert the tenant namespace) and answers
 *  queries by returning the vectors written to the queried namespace (newest
 *  insertion last → reversed so the route's own ts-sort is what orders output). */
function fakeIndex() {
  const vectors: FakeVector[] = []
  const upsertCalls: FakeVector[][] = []
  const queryCalls: Array<{ topK?: number; namespace?: string }> = []
  const index = {
    upsert: async (records: FakeVector[]) => {
      upsertCalls.push(records)
      vectors.push(...records)
    },
    query: async (_vector: number[], options: { topK?: number; namespace?: string }) => {
      queryCalls.push(options)
      const matched = vectors
        .filter((v) => v.namespace === options.namespace)
        .slice(0, options.topK ?? 8)
        .map((v) => ({ id: v.id, score: 0.9, metadata: { kind: v.metadata.kind, ts: v.metadata.ts } }))
      return { matches: matched }
    },
  }
  return { index: index as unknown as Env["OPENCLAW_AGENT_MEMORY_INDEX"], vectors, upsertCalls, queryCalls }
}

let kv: KVNamespace
let idx: ReturnType<typeof fakeIndex>
let db: D1Database

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    SIGILIX_PLATFORM_DB: db,
    OPENCLAW_STATE: kv,
    AI: fakeAi(),
    OPENCLAW_AGENT_MEMORY_INDEX: idx.index,
    ...extra,
  } as unknown as Env
}
const MIGRATION_SQL_API_KEY = readFileSync(
  new URL("../../../migrations/0003_create_account_tenant_and_api_key.sql", import.meta.url),
  "utf8",
)
const MIGRATION_SQL_IDENTITY = readFileSync(
  new URL("../../../migrations/0006_create_user_identity.sql", import.meta.url),
  "utf8",
)

async function seedIdentity(database: D1Database, userId: string, githubUserId: string): Promise<void> {
  await database
    .prepare(
      "INSERT INTO user_identity " +
        "(user_id, github_user_id, providers, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(userId, githubUserId, '["github"]', "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
    .run()
}

async function applyAuthMigrations(database: D1Database): Promise<void> {
  await database.exec(MIGRATION_SQL_API_KEY)
  await database.exec(MIGRATION_SQL_IDENTITY)
}

function legacyEnv(extra: Partial<Env> = {}): Env {
  return {
    OPENCLAW_SIGILIX_API_KEY: TOKEN,
    OPENCLAW_STATE: kv,
    AI: fakeAi(),
    OPENCLAW_AGENT_MEMORY_INDEX: idx.index,
    ...extra,
  } as unknown as Env
}
/** Throws on any operation — simulates a genuine D1 outage/fault. */
function makeBrokenDb(): D1Database {
  return {
    prepare() {
      throw new Error("simulated D1 error")
    },
  } as unknown as D1Database
}

/** Env with the API key UNSET (the inert-503 case). */
function unkeyedEnv(extra: Partial<Env> = {}): Env {
  return {
    OPENCLAW_STATE: kv,
    AI: fakeAi(),
    OPENCLAW_AGENT_MEMORY_INDEX: idx.index,
    ...extra,
  } as unknown as Env
}

function writeReq(body: unknown, token: string | null = TOKEN): Request {
  return new Request("https://api.sigilix.ai/v1/memory", {
    method: "PUT",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function queryReq(body: unknown, token: string | null = TOKEN): Request {
  return new Request("https://api.sigilix.ai/v1/memory/query", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

const writeBody = { userId: "u1", repoId: "sigilix/boreas", kind: "decision", content: "use bun, not node" }

beforeEach(async () => {
  kv = fakeKV()
  idx = fakeIndex()
  db = makeD1()
  await applyAuthMigrations(db)
  await seedIdentity(db, "user-1", "1")
  await insertApiKey(db, {
    id: "key-default",
    keyHash: await sha256Hex(TOKEN),
    installationId: 42,
    createdBy: "1",
    nowIso: "2026-01-01T00:00:00Z",
  })
})

afterEach(() => {
  // The sort test installs fake timers; always restore real ones so the clock
  // never leaks into a later test (in this file or the next).
  vi.useRealTimers()
})

describe("agent-memory routes — auth + validation", () => {
  it("503 when the API key is unset (inert)", async () => {
    expect((await handleMemoryWriteRoute(writeReq(writeBody), unkeyedEnv())).status).toBe(503)
    expect((await handleMemoryQueryRoute(queryReq(writeBody), unkeyedEnv())).status).toBe(503)
  })
  it("401 on a bad bearer (both routes)", async () => {
    expect((await handleMemoryWriteRoute(writeReq(writeBody, "nope"), makeEnv())).status).toBe(401)
    expect((await handleMemoryQueryRoute(queryReq({ ...writeBody, query: "x" }, "nope"), makeEnv())).status).toBe(401)
  })

  // Both routes authenticate via the D1 api_key lookup and resolve the key
  // creator through user_identity before accepting personal-memory access.
  it("200 with a valid per-tenant api_key — NO global key configured at all (both routes)", async () => {
    const tenantDb = makeD1()
    await applyAuthMigrations(tenantDb)
    await seedIdentity(tenantDb, "user-tenant", "11")
    const plaintext = "sigilix_live_memory_test"
    await insertApiKey(tenantDb, {
      id: "key-1",
      keyHash: await sha256Hex(plaintext),
      installationId: 42,
      createdBy: "11",
      nowIso: "2026-01-01T00:00:00Z",
    })
    const env = unkeyedEnv({ SIGILIX_PLATFORM_DB: tenantDb })
    expect((await handleMemoryWriteRoute(writeReq(writeBody, plaintext), env)).status).toBe(200)
    expect((await handleMemoryQueryRoute(queryReq({ ...writeBody, query: "x" }, plaintext), env)).status).toBe(200)
  })
  it("401 on a genuine D1 fault — API-key authentication fails CLOSED (both routes)", async () => {
    const env = makeEnv({ SIGILIX_PLATFORM_DB: makeBrokenDb() })
    expect((await handleMemoryWriteRoute(writeReq(writeBody, TOKEN), env)).status).toBe(401)
    expect((await handleMemoryQueryRoute(queryReq({ ...writeBody, query: "x" }, TOKEN), env)).status).toBe(401)
  })
  it("400 on invalid JSON", async () => {
    expect((await handleMemoryWriteRoute(writeReq("{nope"), makeEnv())).status).toBe(400)
  })
  it("400 on a missing userId (write)", async () => {
    const { userId: _u, ...noUser } = writeBody
    expect((await handleMemoryWriteRoute(writeReq(noUser), makeEnv())).status).toBe(400)
  })
  it("400 on a missing repoId (write)", async () => {
    const { repoId: _r, ...noRepo } = writeBody
    expect((await handleMemoryWriteRoute(writeReq(noRepo), makeEnv())).status).toBe(400)
  })
  it("400 on an invalid kind (write)", async () => {
    expect((await handleMemoryWriteRoute(writeReq({ ...writeBody, kind: "nonsense" }), makeEnv())).status).toBe(400)
  })
  it("400 on a missing userId (query)", async () => {
    expect((await handleMemoryQueryRoute(queryReq({ repoId: "r", query: "x" }), makeEnv())).status).toBe(400)
  })
  it("400 on a missing repoId (query)", async () => {
    expect((await handleMemoryQueryRoute(queryReq({ userId: "u", query: "x" }), makeEnv())).status).toBe(400)
  })
  it("400 on a missing query (query)", async () => {
    expect((await handleMemoryQueryRoute(queryReq({ userId: "u", repoId: "r" }), makeEnv())).status).toBe(400)
  })
})

describe("PUT /v1/memory — write", () => {
  it("200 returns a generated id + stored flags", async () => {
    const res = await handleMemoryWriteRoute(writeReq(writeBody), makeEnv())
    expect(res.status).toBe(200)
    const out = (await res.json()) as { id: string; stored: boolean; vectorStored: boolean }
    expect(out.id).toMatch(/^mem_/)
    expect(out.stored).toBe(true)
    expect(out.vectorStored).toBe(true)
  })

  it("upserts under the authenticated internal user and lowercased repo namespace", async () => {
    await handleMemoryWriteRoute(writeReq({ ...writeBody, userId: "U1", repoId: "Sigilix/Boreas" }), makeEnv())
    expect(idx.upsertCalls.length).toBe(1)
    expect(idx.upsertCalls[0]?.[0]?.namespace).toBe(memoryNamespace("inst:42:user:user-1", "Sigilix/Boreas"))
    expect(idx.upsertCalls[0]?.[0]?.namespace).toBe("inst:42:user:user-1/sigilix/boreas")
  })

  it("puts { kind, ts } in the vector metadata", async () => {
    await handleMemoryWriteRoute(writeReq(writeBody), makeEnv())
    const meta = idx.upsertCalls[0]?.[0]?.metadata
    expect(meta?.kind).toBe("decision")
    expect(typeof meta?.ts).toBe("string")
  })

  it("dedups exact-duplicate content (returns the existing id, no second vector)", async () => {
    const env = makeEnv()
    const first = (await (await handleMemoryWriteRoute(writeReq(writeBody), env)).json()) as { id: string }
    const second = (await (await handleMemoryWriteRoute(writeReq(writeBody), env)).json()) as {
      id: string
      deduped?: boolean
    }
    expect(second.id).toBe(first.id)
    expect(second.deduped).toBe(true)
    expect(idx.upsertCalls.length).toBe(1) // only the first write upserted a vector
  })

  it("soft-fails the vector leg: still KV-stores + returns 200 with vectorStored=false", async () => {
    const env = makeEnv()
    // Make the Vectorize upsert throw; the KV write must still happen.
    ;(env.OPENCLAW_AGENT_MEMORY_INDEX as unknown as { upsert: () => Promise<never> }).upsert = async () => {
      throw new Error("vectorize down")
    }
    const res = await handleMemoryWriteRoute(writeReq(writeBody), env)
    expect(res.status).toBe(200)
    const out = (await res.json()) as { stored: boolean; vectorStored: boolean }
    expect(out.stored).toBe(true)
    expect(out.vectorStored).toBe(false)
  })

  it("does NOT dedup a write whose vector leg failed — a retry re-attempts the upsert", async () => {
    const env = makeEnv()
    // First write: vector upsert throws → record stored, but NO dedup pointer.
    const realUpsert = (env.OPENCLAW_AGENT_MEMORY_INDEX as unknown as { upsert: typeof idx.index.upsert }).upsert
    ;(env.OPENCLAW_AGENT_MEMORY_INDEX as unknown as { upsert: () => Promise<never> }).upsert = async () => {
      throw new Error("vectorize down")
    }
    const first = (await (await handleMemoryWriteRoute(writeReq(writeBody), env)).json()) as { vectorStored: boolean }
    expect(first.vectorStored).toBe(false)
    expect(idx.upsertCalls.length).toBe(0)
    // Backend recovers; the same content must NOT be deduped away — it re-upserts.
    ;(env.OPENCLAW_AGENT_MEMORY_INDEX as unknown as { upsert: typeof realUpsert }).upsert = realUpsert
    const second = (await (await handleMemoryWriteRoute(writeReq(writeBody), env)).json()) as {
      vectorStored: boolean
      deduped?: boolean
    }
    expect(second.deduped).toBeUndefined()
    expect(second.vectorStored).toBe(true)
    expect(idx.upsertCalls.length).toBe(1) // the recovered retry finally landed the vector
  })
})

describe("POST /v1/memory/query — retrieve", () => {
  it("200 returns a results array shaped { id, kind, content, ts, score }", async () => {
    const env = makeEnv()
    await handleMemoryWriteRoute(writeReq(writeBody), env)
    const res = await handleMemoryQueryRoute(queryReq({ ...writeBody, query: "build tool" }), env)
    expect(res.status).toBe(200)
    const out = (await res.json()) as { results: Array<Record<string, unknown>> }
    expect(Array.isArray(out.results)).toBe(true)
    expect(out.results.length).toBe(1)
    expect(out.results[0]).toEqual({
      id: expect.stringMatching(/^mem_/),
      kind: "decision",
      content: "use bun, not node",
      ts: expect.any(String),
      score: 0.9,
    })
  })

  it("ignores a spoofed body userId and queries the authenticated user's namespace", async () => {
    const env = makeEnv()
    await handleMemoryWriteRoute(writeReq(writeBody), env)
    const res = await handleMemoryQueryRoute(
      queryReq({ userId: "spoofed-other-user", repoId: writeBody.repoId, query: "build tool" }),
      env,
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { results: Array<{ content: string }> }).results).toEqual([
      expect.objectContaining({ content: writeBody.content }),
    ])
  })

  it("sorts newest-first and honors `limit` (capped)", async () => {
    const env = makeEnv()
    // Advance the clock between writes so each record gets a distinct ts — the
    // route stamps ts at write time and sorts ts-desc, so this isolates the sort
    // from sub-millisecond write timing.
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-22T00:00:00.000Z"))
    await handleMemoryWriteRoute(writeReq({ ...writeBody, content: "oldest" }), env)
    vi.setSystemTime(new Date("2026-06-22T00:00:01.000Z"))
    await handleMemoryWriteRoute(writeReq({ ...writeBody, content: "middle" }), env)
    vi.setSystemTime(new Date("2026-06-22T00:00:02.000Z"))
    await handleMemoryWriteRoute(writeReq({ ...writeBody, content: "newest" }), env)
    const res = await handleMemoryQueryRoute(queryReq({ ...writeBody, query: "anything", limit: 2 }), env)
    const out = (await res.json()) as { results: Array<{ content: string }> }
    expect(out.results.length).toBe(2) // limit honored
    // ts is stamped at write time; the route's ts-desc sort puts the latest first.
    expect(out.results.map((r) => r.content)).toEqual(["newest", "middle"])
  })

  it("SOFT-FAIL: a Vectorize query throw → { results: [] } (200), NOT 500", async () => {
    const env = makeEnv()
    await handleMemoryWriteRoute(writeReq(writeBody), env)
    ;(env.OPENCLAW_AGENT_MEMORY_INDEX as unknown as { query: () => Promise<never> }).query = async () => {
      throw new Error("vectorize query down")
    }
    const res = await handleMemoryQueryRoute(queryReq({ ...writeBody, query: "build tool" }), env)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { results: unknown[] }).results).toEqual([])
  })

  it("SOFT-FAIL: an embed throw → { results: [] } (200), NOT 500", async () => {
    const env = makeEnv()
    await handleMemoryWriteRoute(writeReq(writeBody), env)
    ;(env.AI as unknown as { run: () => Promise<never> }).run = async () => {
      throw new Error("embed down")
    }
    const res = await handleMemoryQueryRoute(queryReq({ ...writeBody, query: "build tool" }), env)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { results: unknown[] }).results).toEqual([])
  })

  it("hydrates the KV record on a case-insensitive repo write→query round-trip", async () => {
    const env = makeEnv()
    // Write with a mixed-case repo; query with a different casing of the same
    // repo. KV keys and the Vectorize namespace must agree (both canonicalized)
    // so the matched vector hydrates its record rather than missing it.
    await handleMemoryWriteRoute(writeReq({ ...writeBody, userId: "U1", repoId: "Sigilix/Boreas" }), env)
    const res = await handleMemoryQueryRoute(
      queryReq({ userId: "u1", repoId: "sigilix/boreas", query: "build tool" }),
      env,
    )
    expect(res.status).toBe(200)
    const out = (await res.json()) as { results: Array<{ content: string }> }
    expect(out.results.length).toBe(1)
    expect(out.results[0]?.content).toBe("use bun, not node")
  })

  it("fetches at least `limit` vector hits (topK is not starved by the default)", async () => {
    const env = makeEnv()
    await handleMemoryWriteRoute(writeReq(writeBody), env)
    await handleMemoryQueryRoute(queryReq({ ...writeBody, query: "x", limit: 15 }), env)
    expect(idx.queryCalls[0]?.topK).toBe(15) // not the DEFAULT_TOP_K of 8
  })
})

// Personal memory is owned by the authenticated, provider-independent user id.
// The wire-level body userId is intentionally absent from these subjects.
describe("personal memory subject", () => {
  it("combines the installation with the canonical internal user id", () => {
    expect(personalMemoryUserId(42, " User-ABC ")).toBe("inst:42:user:user-abc")
  })
  it("preserves the generic helper's legacy contract while personal subjects stay installation-scoped", () => {
    expect(scopeMemoryUserId("user:user-1", LEGACY_TENANT_INSTALLATION_ID)).toBe("user:user-1")
    expect(personalMemoryUserId(LEGACY_TENANT_INSTALLATION_ID, "user-1")).toBe("inst:-1:user:user-1")
  })
  it("cannot be forged out of the caller's namespace — a spoofed inst: prefix is only ever nested under the real one", () => {
    // A caller with a key for installation 7 who names `userId: "inst:42:victim"`
    // still lands under inst:7:… , never inside installation 42's namespace.
    expect(scopeMemoryUserId("inst:42:victim", 7)).toBe("inst:7:inst:42:victim")
  })
})

describe("agent-memory routes — SIG-494 tenant-scope isolation", () => {
  async function twoTenantEnv(): Promise<{ env: Env; tokenA: string; tokenB: string }> {
    const tenantDb = makeD1()
    await applyAuthMigrations(tenantDb)
    await seedIdentity(tenantDb, "user-1", "1")
    const tokenA = "sigilix_live_mem_inst42"
    const tokenB = "sigilix_live_mem_inst999"
    await insertApiKey(tenantDb, {
      id: "key-a",
      keyHash: await sha256Hex(tokenA),
      installationId: 42,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })
    await insertApiKey(tenantDb, {
      id: "key-b",
      keyHash: await sha256Hex(tokenB),
      installationId: 999,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })
    // No global key configured → force the per-tenant D1 path for both bearers.
    return { env: unkeyedEnv({ SIGILIX_PLATFORM_DB: tenantDb }), tokenA, tokenB }
  }

  it("a per-tenant key CANNOT read another installation's memory written under the SAME userId/repoId (the read leak + write poison, closed)", async () => {
    const { env, tokenA, tokenB } = await twoTenantEnv()
    // Installation 42 writes a memory.
    expect((await handleMemoryWriteRoute(writeReq(writeBody, tokenA), env)).status).toBe(200)
    // Installation 999 queries the EXACT SAME userId/repoId — must see nothing.
    const other = await handleMemoryQueryRoute(queryReq({ ...writeBody, query: "build tool" }, tokenB), env)
    expect(other.status).toBe(200)
    expect(((await other.json()) as { results: unknown[] }).results).toEqual([])
    // Installation 42 (the owner) queries the same subject — sees its OWN memory.
    const own = await handleMemoryQueryRoute(queryReq({ ...writeBody, query: "build tool" }, tokenA), env)
    expect(((await own.json()) as { results: Array<{ content: string }> }).results.length).toBe(1)
  })

  it("upserts under the installation-prefixed internal-user namespace for a per-tenant key", async () => {
    const { env, tokenA } = await twoTenantEnv()
    await handleMemoryWriteRoute(writeReq(writeBody, tokenA), env)
    expect(idx.upsertCalls[0]?.[0]?.namespace).toBe(memoryNamespace("inst:42:user:user-1", "sigilix/boreas"))
  })

  it("denies the legacy global key on personal-memory routes", async () => {
    const legacyDb = makeD1()
    await applyAuthMigrations(legacyDb)
    const env = legacyEnv({ SIGILIX_PLATFORM_DB: legacyDb })
    const write = await handleMemoryWriteRoute(writeReq(writeBody), env)
    const query = await handleMemoryQueryRoute(queryReq({ ...writeBody, query: "x" }), env)
    expect(write.status).toBe(403)
    expect(query.status).toBe(403)
    expect(await write.json()).toEqual({ error: "memory_identity_unavailable" })
    expect(await query.json()).toEqual({ error: "memory_identity_unavailable" })
    expect(idx.upsertCalls).toEqual([])
  })

  it("denies a per-tenant key whose creator has no user_identity row", async () => {
    const tenantDb = makeD1()
    await applyAuthMigrations(tenantDb)
    const perTenant = "sigilix_live_mem_inst7"
    await insertApiKey(tenantDb, {
      id: "key-7",
      keyHash: await sha256Hex(perTenant),
      installationId: 7,
      createdBy: "999999",
      nowIso: "2026-01-01T00:00:00Z",
    })
    const env = unkeyedEnv({ SIGILIX_PLATFORM_DB: tenantDb })
    const res = await handleMemoryQueryRoute(queryReq({ ...writeBody, query: "build tool" }, perTenant), env)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "memory_identity_unavailable" })
  })
})

// Seat∪Org memory layering — Phase 3 (CLI read side): POST /v1/memory/query
// additionally unions the caller-installation's org-scope review learnings
// when OPENCLAW_CLI_ORG_MEMORY is "shadow"/"on" (resolveCliOrgMemoryMode).
// Default ("off", unset) MUST stay byte-identical to the seat-only behavior
// pinned in the "POST /v1/memory/query — retrieve" describe above.
describe("POST /v1/memory/query — Seat∪Org memory layering (Phase 3)", () => {
  const ORG_INSTALL_ID = 42

  function orgEntry(id: string, over: Partial<LearningEntry> = {}): LearningEntry {
    return {
      id,
      rule: `org-rule-${id}`,
      polarity: "require",
      category: null,
      pathGlob: null,
      scope: "org",
      subjectId: String(ORG_INSTALL_ID),
      source: { kind: "command", prNumber: 1, commentId: 1 },
      createdTs: "2026-06-01T00:00:00.000Z",
      appliedCount: 0,
      ...over,
    }
  }

  async function perTenantEnv(extra: Partial<Env> = {}): Promise<{ env: Env; token: string }> {
    const tenantDb = makeD1()
    await applyAuthMigrations(tenantDb)
    await seedIdentity(tenantDb, "user-1", "1")
    const token = "sigilix_live_cli_org_memory"
    await insertApiKey(tenantDb, {
      id: "key-cli",
      keyHash: await sha256Hex(token),
      installationId: ORG_INSTALL_ID,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })
    // No global key configured → force the per-tenant D1 path.
    return { env: unkeyedEnv({ SIGILIX_PLATFORM_DB: tenantDb, ...extra }), token }
  }

  const seatBody = { userId: "u1", repoId: "sigilix/boreas", kind: "decision" as const, content: "seat fact" }

  it("flag OFF (default, unset) — org learnings exist but never surface, org KV key never read", async () => {
    const { env, token } = await perTenantEnv()
    await handleMemoryWriteRoute(writeReq(seatBody, token), env)
    await appendLearning(env, "org", String(ORG_INSTALL_ID), orgEntry("a"))

    const orgKey = `learnings:org:${ORG_INSTALL_ID}`
    const getCalls: string[] = []
    const loose = kv as unknown as { get: (k: string) => Promise<string | null> }
    const realGet = loose.get.bind(loose)
    loose.get = async (key: string) => {
      getCalls.push(key)
      return realGet(key)
    }

    const res = await handleMemoryQueryRoute(queryReq({ ...seatBody, query: "seat" }, token), env)
    expect(res.status).toBe(200)
    const out = (await res.json()) as { results: Array<{ id: string; content: string }> }
    expect(out.results.length).toBe(1)
    expect(out.results[0]?.content).toBe("seat fact")
    expect(out.results.some((r) => r.id.startsWith("org:"))).toBe(false)
    // The byte-identical-to-before-slice-3 property: no installation check, no
    // `learnings:org:*` KV read at all when the flag is off.
    expect(getCalls).not.toContain(orgKey)
  })

  it("flag OFF explicitly set — same seat-only behavior", async () => {
    const { env, token } = await perTenantEnv({ OPENCLAW_CLI_ORG_MEMORY: "off" })
    await appendLearning(env, "org", String(ORG_INSTALL_ID), orgEntry("a"))
    const res = await handleMemoryQueryRoute(
      queryReq({ userId: "u1", repoId: "sigilix/boreas", query: "x" }, token),
      env,
    )
    expect(((await res.json()) as { results: unknown[] }).results).toEqual([])
  })

  it("flag SHADOW — loads + logs the org corpus but the returned results stay seat-only", async () => {
    const { env, token } = await perTenantEnv({ OPENCLAW_CLI_ORG_MEMORY: "shadow" })
    await handleMemoryWriteRoute(writeReq(seatBody, token), env)
    await appendLearning(env, "org", String(ORG_INSTALL_ID), orgEntry("a"))
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)

    const res = await handleMemoryQueryRoute(queryReq({ ...seatBody, query: "seat" }, token), env)
    expect(res.status).toBe(200)
    const out = (await res.json()) as { results: Array<{ content: string }> }
    expect(out.results.map((r) => r.content)).toEqual(["seat fact"]) // seat-only, unchanged by shadow

    const shadow = logSpy.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .find((e) => e.event === "cli-org-memory-shadow")
    expect(shadow).toMatchObject({ installationId: ORG_INSTALL_ID, count: 1, ids: ["org:a"] })
  })

  it("flag ON — response is seat ∪ org, org rendered in the AgentMemoryQueryResult shape, seat first", async () => {
    const { env, token } = await perTenantEnv({ OPENCLAW_CLI_ORG_MEMORY: "on" })
    await handleMemoryWriteRoute(writeReq(seatBody, token), env)
    await appendLearning(
      env,
      "org",
      String(ORG_INSTALL_ID),
      orgEntry("a", { rule: "always use @/ imports", polarity: "require" }),
    )
    vi.spyOn(console, "log").mockImplementation(() => undefined)

    const res = await handleMemoryQueryRoute(queryReq({ ...seatBody, query: "seat" }, token), env)
    expect(res.status).toBe(200)
    const out = (await res.json()) as { results: Array<Record<string, unknown>> }
    expect(out.results.length).toBe(2)
    expect(out.results[0]).toMatchObject({ content: "seat fact", kind: "decision" })
    expect(out.results[1]).toEqual({
      id: "org:a",
      kind: "preference",
      content: "[required] always use @/ imports",
      ts: "2026-06-01T00:00:00.000Z",
      score: 1,
    })
  })

  it("flag ON + no seat memory yet — response is org-only (a brand-new CLI session still inherits the org's rules)", async () => {
    const { env, token } = await perTenantEnv({ OPENCLAW_CLI_ORG_MEMORY: "on" })
    await appendLearning(env, "org", String(ORG_INSTALL_ID), orgEntry("a"))
    vi.spyOn(console, "log").mockImplementation(() => undefined)

    const res = await handleMemoryQueryRoute(
      queryReq({ userId: "u1", repoId: "sigilix/boreas", query: "x" }, token),
      env,
    )
    const out = (await res.json()) as { results: Array<{ id: string }> }
    expect(out.results.map((r) => r.id)).toEqual(["org:a"])
  })

  it("flag ON + the LEGACY global key — personal memory remains denied", async () => {
    const env = legacyEnv({ OPENCLAW_CLI_ORG_MEMORY: "on" })
    expect((await handleMemoryWriteRoute(writeReq(seatBody), env)).status).toBe(403)
    const res = await handleMemoryQueryRoute(queryReq({ ...seatBody, query: "seat" }), env)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "memory_identity_unavailable" })
  })

  it("flag ON + an org-store read throwing — degrades to seat-only, logs, never throws", async () => {
    const { env, token } = await perTenantEnv({ OPENCLAW_CLI_ORG_MEMORY: "on" })
    await handleMemoryWriteRoute(writeReq(seatBody, token), env)
    // Break the KV leg for the org key specifically (seat reads/writes above
    // already completed through the working KV).
    const orgKey = "learnings:org:42"
    const loose = kv as unknown as { get: (k: string) => Promise<string | null> }
    const realGet = loose.get.bind(loose)
    loose.get = async (key: string) => {
      if (key === orgKey) throw new Error("org kv down")
      return realGet(key)
    }
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)

    const res = await handleMemoryQueryRoute(queryReq({ ...seatBody, query: "seat" }, token), env)
    expect(res.status).toBe(200)
    const out = (await res.json()) as { results: Array<{ content: string }> }
    expect(out.results.map((r) => r.content)).toEqual(["seat fact"]) // seat preserved, no throw
    // loadLearnings' own soft-fail logs the KV read failure.
    const failed = logSpy.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .find((e) => e.event === "learnings-load-failed")
    expect(failed).toBeDefined()
  })

  it("flag ON — caps org additions and logs a truncation when the org corpus exceeds the budget", async () => {
    const { env, token } = await perTenantEnv({ OPENCLAW_CLI_ORG_MEMORY: "on" })
    await handleMemoryWriteRoute(writeReq(seatBody, token), env)
    for (let i = 0; i < 25; i++) {
      await appendLearning(
        env,
        "org",
        String(ORG_INSTALL_ID),
        orgEntry(`e${i}`, { createdTs: new Date(Date.parse("2026-06-01T00:00:00.000Z") + i * 1000).toISOString() }),
      )
    }
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)

    const res = await handleMemoryQueryRoute(queryReq({ ...seatBody, query: "seat" }, token), env)
    const out = (await res.json()) as { results: unknown[] }
    expect(out.results.length).toBe(1 + 20) // 1 seat + MAX_ORG_MEMORY_ENTRIES (20)

    const truncated = logSpy.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .find((e) => e.event === "cli-org-memory-truncated")
    expect(truncated).toMatchObject({ installationId: ORG_INSTALL_ID, kept: 20 })
  })
})
