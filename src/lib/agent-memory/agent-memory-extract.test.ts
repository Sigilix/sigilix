// SIG-483 — POST /v1/memory/extract route tests: auth gating, field validation,
// the distill→store flow (each fact lands through the SAME `storeMemoryFact` write
// path PUT uses), exact-content dedup, tenant canonicalization, and the SOFT-FAIL
// contract (no api key / a model throw / an unparseable response → `{ stored: 0,
// facts: [] }` (200), NEVER 500).
//
// The cheap extractor model is mocked at the `runWithRetryAndFallback` seam: the
// mock invokes the route's REAL `parseAnswer` on a canned model-output string, so
// the actual prompt→parse→store path runs (only the network round-trip is faked).
// KV + AI + Vectorize are the same in-memory fakes the PUT/query route test uses,
// so `storeMemoryFact` exercises its real embed→upsert→KV→dedup legs.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { insertApiKey } from "@/src/lib/api-key-store"
import { sha256Hex } from "@/src/lib/auth-bearer"
import { handleMemoryExtractRoute } from "./agent-memory-extract"
import { memoryNamespace } from "./retrieval"
import type { Env } from "@/src/shared/types/env"

// ─── Mock the model seam (everything else real) ──────────────

// Captures the messages + parseAnswer the route hands the model, and lets each
// test stage the raw model output the parser then runs over (or a throw).
let mockModelOutput: string | (() => never) = '{"memories":[]}'
let lastMessages: Array<{ role: string; content: string }> | null = null

vi.mock("@/src/lib/ensemble/adapters/model-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/ensemble/adapters/model-provider")>()
  return {
    ...actual,
    runWithRetryAndFallback: vi.fn(
      async (args: {
        messages: Array<{ role: string; content: string }>
        parseAnswer: (content: string) => unknown
      }) => {
        lastMessages = args.messages
        const staged = mockModelOutput
        const output = typeof staged === "function" ? staged() : staged // function branch throws (model down)
        const verdict = args.parseAnswer(output)
        return { verdict, elapsedMs: 1, modelUsed: "mock", attemptsUsed: 1 }
      },
    ),
  }
})

const TOKEN = "mem-secret"
const DIMS = 768

// ─── In-memory fakes for KV + AI + Vectorize (match route test) ──

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
  return {
    run: async () => ({ data: [Array.from({ length: DIMS }, () => 0.1)], shape: [1, DIMS] }),
  } as unknown as Env["AI"]
}

interface FakeVector {
  id: string
  namespace: string
  metadata: Record<string, string | number>
}

function fakeIndex() {
  const vectors: FakeVector[] = []
  const upsertCalls: FakeVector[][] = []
  const index = {
    upsert: async (records: FakeVector[]) => {
      upsertCalls.push(records)
      vectors.push(...records)
    },
    query: async () => ({ matches: [] }),
  }
  return { index: index as unknown as Env["OPENCLAW_AGENT_MEMORY_INDEX"], vectors, upsertCalls }
}

let kv: KVNamespace
let idx: ReturnType<typeof fakeIndex>
let defaultDb: D1Database

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    SIGILIX_PLATFORM_DB: defaultDb,
    OPENROUTER_API_KEY: "or-test-key", // the extractor config primary is an OpenRouter id
    OLLAMA_API_KEY: "",
    OLLAMA_CHAT_ENABLE: "on",
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
/** Throws on any operation — simulates a genuine D1 outage/fault. */
function makeBrokenDb(): D1Database {
  return {
    prepare() {
      throw new Error("simulated D1 error")
    },
  } as unknown as D1Database
}

/** Env with the static bearer UNSET (the inert-503 case). */
function unkeyedEnv(extra: Partial<Env> = {}): Env {
  return {
    OPENROUTER_API_KEY: "or-test-key",
    OLLAMA_API_KEY: "",
    OPENCLAW_STATE: kv,
    AI: fakeAi(),
    OPENCLAW_AGENT_MEMORY_INDEX: idx.index,
    ...extra,
  } as unknown as Env
}

/** Env with a valid tenant bearer but NO model api key (the fail-open case). */
function noModelKeyEnv(): Env {
  return makeEnv({ OPENROUTER_API_KEY: "", OLLAMA_API_KEY: "" })
}

async function seedIdentity(db: D1Database, userId = "user-1", githubUserId = "1"): Promise<void> {
  await db
    .prepare(
      "INSERT INTO user_identity " +
        "(user_id, github_user_id, providers, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(userId, githubUserId, '["github"]', "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
    .run()
}

async function makeTenantDb(
  args: {
    token?: string
    keyId?: string
    installationId?: number
    createdBy?: string
    userId?: string
  } = {},
): Promise<D1Database> {
  const db = makeD1()
  await db.exec(MIGRATION_SQL_API_KEY)
  await db.exec(MIGRATION_SQL_IDENTITY)
  const createdBy = args.createdBy ?? "1"
  await seedIdentity(db, args.userId ?? "user-1", createdBy)
  await insertApiKey(db, {
    id: args.keyId ?? "key-1",
    keyHash: await sha256Hex(args.token ?? TOKEN),
    installationId: args.installationId ?? 42,
    createdBy,
    nowIso: "2026-01-01T00:00:00Z",
  })
  return db
}

function extractReq(body: unknown, token: string | null = TOKEN): Request {
  return new Request("https://api.sigilix.ai/v1/memory/extract", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

const exchangeBody = {
  userId: "u1",
  repoId: "sigilix/boreas",
  userMessage: "use bun for this repo",
  assistantMessage: "Got it — I'll use bun, not node, going forward.",
}

interface ExtractResponse {
  stored: number
  facts: Array<{ kind: string; content: string; id: string; deduped: boolean }>
}

beforeEach(async () => {
  kv = fakeKV()
  idx = fakeIndex()
  mockModelOutput = '{"memories":[]}'
  lastMessages = null
  defaultDb = await makeTenantDb()
})

describe("POST /v1/memory/extract — auth + validation", () => {
  it("503 when the static API key is unset (inert)", async () => {
    expect((await handleMemoryExtractRoute(extractReq(exchangeBody), unkeyedEnv())).status).toBe(503)
  })
  it("401 on a bad bearer", async () => {
    expect((await handleMemoryExtractRoute(extractReq(exchangeBody, "nope"), makeEnv())).status).toBe(401)
  })

  // #155 slice 2: the route authenticates via a D1 api_key lookup. These pin the
  // route-level invariants (resolveApiKey's own unit suite covers the resolver).
  it("200 with a valid per-tenant api_key — NO global key configured at all", async () => {
    const plaintext = "sigilix_live_extract_test"
    const db = await makeTenantDb({ token: plaintext })
    const res = await handleMemoryExtractRoute(
      extractReq(exchangeBody, plaintext),
      unkeyedEnv({ SIGILIX_PLATFORM_DB: db }),
    )
    expect(res.status).toBe(200)
  })
  it("401 on a genuine D1 fault — fails CLOSED", async () => {
    const res = await handleMemoryExtractRoute(
      extractReq(exchangeBody, TOKEN),
      makeEnv({ SIGILIX_PLATFORM_DB: makeBrokenDb() }),
    )
    expect(res.status).toBe(401)
  })
  it("400 on invalid JSON", async () => {
    expect((await handleMemoryExtractRoute(extractReq("{nope"), makeEnv())).status).toBe(400)
  })
  it("400 on a missing userId", async () => {
    const { userId: _u, ...noUser } = exchangeBody
    expect((await handleMemoryExtractRoute(extractReq(noUser), makeEnv())).status).toBe(400)
  })
  it("400 on a missing repoId", async () => {
    const { repoId: _r, ...noRepo } = exchangeBody
    expect((await handleMemoryExtractRoute(extractReq(noRepo), makeEnv())).status).toBe(400)
  })
  it("400 on a missing userMessage", async () => {
    const { userMessage: _m, ...noMsg } = exchangeBody
    expect((await handleMemoryExtractRoute(extractReq(noMsg), makeEnv())).status).toBe(400)
  })
  it("400 on a missing assistantMessage", async () => {
    const { assistantMessage: _a, ...noAsst } = exchangeBody
    expect((await handleMemoryExtractRoute(extractReq(noAsst), makeEnv())).status).toBe(400)
  })
})

describe("POST /v1/memory/extract — distill + store", () => {
  it("extracts + stores N facts, returning { stored, facts:[{kind,content,id,deduped}] }", async () => {
    mockModelOutput = JSON.stringify({
      memories: [
        { kind: "decision", content: "Use bun, not node, for this repo." },
        { kind: "preference", content: "The user prefers bun as the package manager." },
      ],
    })
    const res = await handleMemoryExtractRoute(extractReq(exchangeBody), makeEnv())
    expect(res.status).toBe(200)
    const out = (await res.json()) as ExtractResponse
    expect(out.stored).toBe(2)
    expect(out.facts.map((f) => f.kind)).toEqual(["decision", "preference"])
    expect(out.facts[0]?.content).toBe("Use bun, not node, for this repo.")
    expect(out.facts.every((f) => /^mem_/.test(f.id))).toBe(true)
    expect(out.facts.every((f) => f.deduped === false)).toBe(true)
    // Each stored fact upserted exactly one vector through the real write path.
    expect(idx.upsertCalls.length).toBe(2)
  })

  it("passes both turns of the exchange into the model prompt", async () => {
    await handleMemoryExtractRoute(extractReq(exchangeBody), makeEnv())
    const userMsg = lastMessages?.find((m) => m.role === "user")?.content ?? ""
    expect(userMsg).toContain(exchangeBody.userMessage)
    expect(userMsg).toContain(exchangeBody.assistantMessage)
  })

  it("caps at 3 facts and drops entries with a bad kind or empty content", async () => {
    mockModelOutput = JSON.stringify({
      memories: [
        { kind: "decision", content: "first" },
        { kind: "nonsense", content: "dropped — bad kind" },
        { kind: "correction", content: "   " }, // dropped — empty after trim
        { kind: "dead_end", content: "second" },
        { kind: "preference", content: "third" },
        { kind: "task_state", content: "fourth — over the cap" },
      ],
    })
    const res = await handleMemoryExtractRoute(extractReq(exchangeBody), makeEnv())
    const out = (await res.json()) as ExtractResponse
    expect(out.stored).toBe(3)
    expect(out.facts.map((f) => f.content)).toEqual(["first", "second", "third"])
  })

  it("dedups an exact-content fact (same content → existing id, no second vector)", async () => {
    const env = makeEnv()
    mockModelOutput = JSON.stringify({ memories: [{ kind: "decision", content: "Use bun, not node." }] })
    const first = (await (await handleMemoryExtractRoute(extractReq(exchangeBody), env)).json()) as ExtractResponse
    const second = (await (await handleMemoryExtractRoute(extractReq(exchangeBody), env)).json()) as ExtractResponse
    expect(second.facts[0]?.id).toBe(first.facts[0]?.id)
    expect(second.facts[0]?.deduped).toBe(true)
    expect(second.stored).toBe(1) // still reported as stored (the fact is durable)
    expect(idx.upsertCalls.length).toBe(1) // only the first write upserted a vector
  })

  it("uses the authenticated subject and canonicalizes a mixed-case repo id", async () => {
    mockModelOutput = JSON.stringify({ memories: [{ kind: "decision", content: "x" }] })
    await handleMemoryExtractRoute(extractReq({ ...exchangeBody, userId: "U1", repoId: "Sigilix/Boreas" }), makeEnv())
    expect(idx.upsertCalls[0]?.[0]?.namespace).toBe(memoryNamespace("inst:42:user:user-1", "Sigilix/Boreas"))
    expect(idx.upsertCalls[0]?.[0]?.namespace).toBe("inst:42:user:user-1/sigilix/boreas")
  })
})

describe("POST /v1/memory/extract — SIG-494 tenant-scope isolation", () => {
  it("derives the write subject from the authenticated key creator, never a spoofed body userId", async () => {
    const db = makeD1()
    await db.exec(MIGRATION_SQL_API_KEY)
    await db.exec(MIGRATION_SQL_IDENTITY)
    await db
      .prepare(
        "INSERT INTO user_identity " +
          "(user_id, github_user_id, providers, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind("user-a", "111", '["github"]', "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
      .run()
    const plaintext = "sigilix_live_extract_member_a"
    await insertApiKey(db, {
      id: "key-member-a",
      keyHash: await sha256Hex(plaintext),
      installationId: 42,
      createdBy: "111",
      nowIso: "2026-01-01T00:00:00Z",
    })
    mockModelOutput = JSON.stringify({ memories: [{ kind: "decision", content: "x" }] })

    const res = await handleMemoryExtractRoute(
      extractReq({ ...exchangeBody, userId: "user-b" }, plaintext),
      unkeyedEnv({ SIGILIX_PLATFORM_DB: db }),
    )

    expect(res.status).toBe(200)
    expect(idx.upsertCalls[0]?.[0]?.namespace).toBe(memoryNamespace("inst:42:user:user-a", "sigilix/boreas"))
  })

  it("stores distilled facts under the installation-prefixed namespace for a per-tenant key", async () => {
    const plaintext = "sigilix_live_extract_inst42"
    const db = await makeTenantDb({ token: plaintext })
    mockModelOutput = JSON.stringify({ memories: [{ kind: "decision", content: "x" }] })
    const res = await handleMemoryExtractRoute(
      extractReq(exchangeBody, plaintext),
      unkeyedEnv({ SIGILIX_PLATFORM_DB: db }),
    )
    expect(res.status).toBe(200)
    // Confined to the caller's installation and stable internal user identity,
    // not the raw body-asserted subject.
    expect(idx.upsertCalls[0]?.[0]?.namespace).toBe(memoryNamespace("inst:42:user:user-1", "sigilix/boreas"))
  })

  it("denies the legacy global key instead of granting broad personal-memory access", async () => {
    mockModelOutput = JSON.stringify({ memories: [{ kind: "decision", content: "x" }] })
    const res = await handleMemoryExtractRoute(
      extractReq(exchangeBody),
      unkeyedEnv({ OPENCLAW_SIGILIX_API_KEY: TOKEN }),
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "memory_identity_unavailable" })
    expect(idx.upsertCalls).toHaveLength(0)
  })
})

describe("POST /v1/memory/extract — soft-fail (never 500)", () => {
  it("no model api key → { stored: 0, facts: [] } (200), no store attempted", async () => {
    const res = await handleMemoryExtractRoute(extractReq(exchangeBody), noModelKeyEnv())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ stored: 0, facts: [] })
    expect(idx.upsertCalls.length).toBe(0)
  })

  it("model throws → { stored: 0, facts: [] } (200), NOT 500", async () => {
    mockModelOutput = () => {
      throw new Error("model down")
    }
    const res = await handleMemoryExtractRoute(extractReq(exchangeBody), makeEnv())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ stored: 0, facts: [] })
    expect(idx.upsertCalls.length).toBe(0)
  })

  it("unparseable model output → { stored: 0, facts: [] } (200), NOT 500", async () => {
    mockModelOutput = "Sorry, I can't help with that."
    const res = await handleMemoryExtractRoute(extractReq(exchangeBody), makeEnv())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ stored: 0, facts: [] })
    expect(idx.upsertCalls.length).toBe(0)
  })

  it("a vector-leg failure degrades but never 500s — every fact still lands in KV", async () => {
    const env = makeEnv()
    mockModelOutput = JSON.stringify({
      memories: [
        { kind: "decision", content: "first" },
        { kind: "preference", content: "second" },
      ],
    })
    // The Vectorize upsert is down for the whole batch (the soft seam the PUT
    // route also degrades through): each fact still KV-stores and is reported.
    ;(env.OPENCLAW_AGENT_MEMORY_INDEX as unknown as { upsert: () => Promise<never> }).upsert = async () => {
      throw new Error("vectorize down")
    }
    const res = await handleMemoryExtractRoute(extractReq(exchangeBody), env)
    expect(res.status).toBe(200)
    const out = (await res.json()) as ExtractResponse
    expect(out.stored).toBe(2)
    expect(out.facts.map((f) => f.content)).toEqual(["first", "second"])
  })
})
