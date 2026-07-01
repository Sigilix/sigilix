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
import { handleMemoryWriteRoute, handleMemoryQueryRoute } from "./agent-memory-route"
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

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    OPENCLAW_SIGILIX_API_KEY: TOKEN,
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

beforeEach(() => {
  kv = fakeKV()
  idx = fakeIndex()
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

  // #155 slice 2: both routes now authenticate via resolveApiKey (D1 api_key lookup,
  // falling back to the legacy global key). These pin the new invariants at the
  // route level (resolveApiKey's own unit suite covers the resolver exhaustively).
  it("200 with a valid per-tenant api_key — NO global key configured at all (both routes)", async () => {
    const db = makeD1()
    await db.exec(MIGRATION_SQL_API_KEY)
    const plaintext = "sigilix_live_memory_test"
    await insertApiKey(db, {
      id: "key-1",
      keyHash: await sha256Hex(plaintext),
      installationId: 42,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })
    const env = unkeyedEnv({ SIGILIX_PLATFORM_DB: db })
    expect((await handleMemoryWriteRoute(writeReq(writeBody, plaintext), env)).status).toBe(200)
    expect((await handleMemoryQueryRoute(queryReq({ ...writeBody, query: "x" }, plaintext), env)).status).toBe(200)
  })
  it("401 on a genuine D1 fault — fails CLOSED even though the presented bearer is the valid global key (both routes)", async () => {
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

  it("upserts to the lowercased tenant namespace `<userId>/<repoId>`", async () => {
    await handleMemoryWriteRoute(writeReq({ ...writeBody, userId: "U1", repoId: "Sigilix/Boreas" }), makeEnv())
    expect(idx.upsertCalls.length).toBe(1)
    expect(idx.upsertCalls[0]?.[0]?.namespace).toBe(memoryNamespace("U1", "Sigilix/Boreas"))
    expect(idx.upsertCalls[0]?.[0]?.namespace).toBe("u1/sigilix/boreas")
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

  it("queries the tenant namespace (isolation): another tenant sees nothing", async () => {
    const env = makeEnv()
    await handleMemoryWriteRoute(writeReq(writeBody), env) // tenant u1/sigilix/boreas
    const res = await handleMemoryQueryRoute(queryReq({ userId: "u2", repoId: "other/repo", query: "build tool" }), env)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { results: unknown[] }).results).toEqual([])
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

  it("hydrates the KV record on a case-insensitive write→query round-trip", async () => {
    const env = makeEnv()
    // Write with mixed-case tenant ids; query with a different casing of the same
    // tenant. KV keys and the Vectorize namespace must agree (both canonicalized)
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
