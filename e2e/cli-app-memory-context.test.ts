// Managed app-memory consumption through the real POST /v1/memory/query ingress.
//
// The API-key creator is mapped through user_identity to the durable personal
// subject. The request body userId is wire compatibility only and never selects
// a D1 row. Organization rows are installation-scoped and remain available when
// a valid exact-installation key has no durable identity yet.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import worker from "@/src/index"
import { sha256Hex } from "@/src/lib/auth-bearer"
import { insertApiKey } from "@/src/lib/api-key-store"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"

const INSTALLATION_ID = 42
const OTHER_INSTALLATION_ID = 99
const TOKEN_A = "sigilix_live_cli_context_a"
const TOKEN_B = "sigilix_live_cli_context_b"
const TOKEN_OTHER = "sigilix_live_cli_context_other"
const TOKEN_MISSING_IDENTITY = "sigilix_live_cli_context_missing_identity"
const GLOBAL_TOKEN = "legacy-global-cli-context"
const DIMS = 768

const MIGRATIONS = [
  "../migrations/0003_create_account_tenant_and_api_key.sql",
  "../migrations/0006_create_user_identity.sql",
  "../migrations/0021_create_app_memory.sql",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))

interface ManagedMemory {
  id: string
  scope: "personal" | "organization"
  content: string
  source: "managed-app"
}

interface QueryResponse {
  results: Array<{ id: string; content: string }>
  appMemories?: ManagedMemory[]
}

function executionContext(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext
}

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
    deleteByIds: async () => undefined,
  } as unknown as Env["OPENCLAW_AGENT_MEMORY_INDEX"]
}

function fakeAi(): Env["AI"] {
  return {
    run: async () => ({ data: [Array.from({ length: DIMS }, () => 0.1)], shape: [1, DIMS] }),
  } as unknown as Env["AI"]
}

async function makeDatabase(): Promise<D1Database> {
  const db = makeD1()
  for (const migration of MIGRATIONS) await db.exec(migration)
  for (const [userId, githubUserId] of [
    ["user-a", "111"],
    ["user-b", "222"],
    ["user-other", "333"],
  ] as const) {
    await db
      .prepare(
        `INSERT INTO user_identity
          (user_id, github_user_id, providers, created_at, last_login_at)
         VALUES (?, ?, '["github"]', ?, ?)`,
      )
      .bind(userId, githubUserId, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
      .run()
  }
  for (const key of [
    { token: TOKEN_A, id: "key-a", installationId: INSTALLATION_ID, createdBy: "111" },
    { token: TOKEN_B, id: "key-b", installationId: INSTALLATION_ID, createdBy: "222" },
    { token: TOKEN_OTHER, id: "key-other", installationId: OTHER_INSTALLATION_ID, createdBy: "333" },
    {
      token: TOKEN_MISSING_IDENTITY,
      id: "key-missing",
      installationId: INSTALLATION_ID,
      createdBy: "444",
    },
  ]) {
    await insertApiKey(db, {
      id: key.id,
      keyHash: await sha256Hex(key.token),
      installationId: key.installationId,
      createdBy: key.createdBy,
      nowIso: "2026-01-01T00:00:00Z",
    })
  }
  return db
}

let nextHash = 1
async function seedAppMemory(
  db: D1Database,
  args: {
    id: string
    installationId?: number
    scope: "personal" | "organization"
    ownerUserId?: string
    appId?: "cli" | "slack"
    content: string
    createdAtMs: number
  },
): Promise<void> {
  const ownerUserId = args.scope === "organization" ? "" : (args.ownerUserId ?? "user-a")
  const contentHash = (nextHash++).toString(16).padStart(64, "0")
  await db
    .prepare(
      `INSERT INTO app_memory
        (id, installation_id, scope, owner_user_id, app_id, content, content_hash, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      args.id,
      args.installationId ?? INSTALLATION_ID,
      args.scope,
      ownerUserId,
      args.appId ?? "cli",
      args.content,
      contentHash,
      args.createdAtMs,
    )
    .run()
}

function environment(
  database: D1Database,
  mode: "off" | "shadow" | "on" | "unknown" = "on",
  extra: Partial<Env> = {},
): Env {
  return {
    SIGILIX_PLATFORM_DB: database,
    OPENCLAW_SIGILIX_API_KEY: GLOBAL_TOKEN,
    OPENCLAW_STATE: fakeKV(),
    OPENCLAW_AGENT_MEMORY_INDEX: fakeIndex(),
    OPENCLAW_APP_MEMORY_CLI_MODE: mode,
    AI: fakeAi(),
    ...extra,
  } as unknown as Env
}

function request(token: string, overrides: Record<string, unknown> = {}): Request {
  return new Request("https://worker.example/v1/memory/query", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      userId: "wire-user",
      repoId: "sigilix/sigilix",
      query: "project rules",
      includeManagedAppContext: true,
      ...overrides,
    }),
  })
}

async function query(env: Env, token: string, overrides: Record<string, unknown> = {}): Promise<Response> {
  return worker.fetch(request(token, overrides), env, executionContext())
}

function failAppMemoryReads(db: D1Database): D1Database {
  const prepare = db.prepare.bind(db)
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (sql: string) => {
          if (/\bFROM\s+app_memory\b/i.test(sql)) throw new Error("simulated app-memory D1 failure")
          return prepare(sql)
        }
      }
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

beforeEach(() => {
  nextHash = 1
  vi.restoreAllMocks()
})

describe("CLI managed app context through the real Worker", () => {
  it("returns the key creator's personal rows plus org rows, never a same-install peer or another installation", async () => {
    const db = await makeDatabase()
    await seedAppMemory(db, {
      id: "appmem_personal_a",
      scope: "personal",
      ownerUserId: "user-a",
      content: "Alice personal rule",
      createdAtMs: 500,
    })
    await seedAppMemory(db, {
      id: "appmem_personal_b",
      scope: "personal",
      ownerUserId: "user-b",
      content: "Bob personal rule",
      createdAtMs: 600,
    })
    await seedAppMemory(db, {
      id: "appmem_org",
      scope: "organization",
      content: "Organization rule",
      createdAtMs: 700,
    })
    const env = environment(db)

    const alice = (await (await query(env, TOKEN_A)).json()) as QueryResponse
    expect(alice.appMemories).toEqual([
      { id: "appmem_personal_a", scope: "personal", content: "Alice personal rule", source: "managed-app" },
      { id: "appmem_org", scope: "organization", content: "Organization rule", source: "managed-app" },
    ])

    const bob = (await (await query(env, TOKEN_B)).json()) as QueryResponse
    expect(bob.appMemories).toEqual([
      { id: "appmem_personal_b", scope: "personal", content: "Bob personal rule", source: "managed-app" },
      { id: "appmem_org", scope: "organization", content: "Organization rule", source: "managed-app" },
    ])

    const other = (await (await query(env, TOKEN_OTHER)).json()) as QueryResponse
    expect(other.appMemories).toEqual([])
  })

  it("ignores a forged body userId for D1 personal selection", async () => {
    const db = await makeDatabase()
    await seedAppMemory(db, {
      id: "appmem_personal_a",
      scope: "personal",
      ownerUserId: "user-a",
      content: "Alice only",
      createdAtMs: 100,
    })
    await seedAppMemory(db, {
      id: "appmem_personal_b",
      scope: "personal",
      ownerUserId: "user-b",
      content: "Bob only",
      createdAtMs: 200,
    })

    const body = (await (await query(environment(db), TOKEN_A, { userId: "user-b" })).json()) as QueryResponse
    expect(body.appMemories?.map((memory) => memory.content)).toEqual(["Alice only"])
  })

  it("keeps the same stable user in another installation and non-CLI app rows isolated", async () => {
    const db = await makeDatabase()
    await seedAppMemory(db, {
      id: "appmem_cli_personal_here",
      scope: "personal",
      ownerUserId: "user-a",
      content: "CLI context for this installation",
      createdAtMs: 500,
    })
    await seedAppMemory(db, {
      id: "appmem_cli_personal_elsewhere",
      installationId: OTHER_INSTALLATION_ID,
      scope: "personal",
      ownerUserId: "user-a",
      content: "Same user in another installation",
      createdAtMs: 900,
    })
    await seedAppMemory(db, {
      id: "appmem_cli_org_elsewhere",
      installationId: OTHER_INSTALLATION_ID,
      scope: "organization",
      content: "Another installation organization rule",
      createdAtMs: 800,
    })
    await seedAppMemory(db, {
      id: "appmem_slack_personal",
      scope: "personal",
      ownerUserId: "user-a",
      appId: "slack",
      content: "Slack personal context",
      createdAtMs: 700,
    })
    await seedAppMemory(db, {
      id: "appmem_slack_org",
      scope: "organization",
      appId: "slack",
      content: "Slack organization context",
      createdAtMs: 600,
    })

    const body = (await (await query(environment(db), TOKEN_A)).json()) as QueryResponse
    expect(body.appMemories).toEqual([
      {
        id: "appmem_cli_personal_here",
        scope: "personal",
        content: "CLI context for this installation",
        source: "managed-app",
      },
    ])
  })

  it("returns organization-only context when an exact-installation key has no durable identity", async () => {
    const db = await makeDatabase()
    await seedAppMemory(db, {
      id: "appmem_org",
      scope: "organization",
      content: "Organization rule",
      createdAtMs: 100,
    })
    await seedAppMemory(db, {
      id: "appmem_personal_a",
      scope: "personal",
      ownerUserId: "user-a",
      content: "Alice only",
      createdAtMs: 200,
    })

    const response = await query(environment(db), TOKEN_MISSING_IDENTITY)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      results: [],
      appMemories: [{ id: "appmem_org", scope: "organization", content: "Organization rule", source: "managed-app" }],
    })
  })

  for (const mode of ["off", "shadow"] as const) {
    for (const [label, body] of [
      ["malformed JSON", "{not-json"],
      ["an invalid request shape", JSON.stringify({ userId: "wire-user", repoId: "sigilix/sigilix" })],
      [
        "an oversized body",
        JSON.stringify({
          userId: "wire-user",
          repoId: "sigilix/sigilix",
          query: "x".repeat(70_000),
          includeManagedAppContext: true,
        }),
      ],
    ] as const) {
      it(`keeps the legacy missing-identity response in ${mode} mode for ${label}`, async () => {
        const db = await makeDatabase()
        const response = await worker.fetch(
          new Request("https://worker.example/v1/memory/query", {
            method: "POST",
            headers: { authorization: `Bearer ${TOKEN_MISSING_IDENTITY}`, "content-type": "application/json" },
            body,
          }),
          environment(db, mode),
          executionContext(),
        )

        expect(response.status).toBe(403)
        expect(await response.text()).toBe('{"error":"memory_identity_unavailable"}')
      })
    }
  }

  it("never gives the legacy global key managed context", async () => {
    const db = await makeDatabase()
    await seedAppMemory(db, {
      id: "appmem_org",
      scope: "organization",
      content: "Organization rule",
      createdAtMs: 100,
    })
    const response = await query(environment(db), GLOBAL_TOKEN)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "memory_identity_unavailable" })
  })

  it("does not read or return managed context unless the request opts in", async () => {
    const db = await makeDatabase()
    await seedAppMemory(db, {
      id: "appmem_org",
      scope: "organization",
      content: "Organization rule",
      createdAtMs: 100,
    })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const response = await query(environment(failAppMemoryReads(db)), TOKEN_A, {
      includeManagedAppContext: undefined,
    })
    expect(await response.text()).toBe('{"results":[]}')
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("cli-app-memory-context"))).toBe(false)
  })

  it("keeps shadow and managed-read failures byte-identical to the legacy result response", async () => {
    const db = await makeDatabase()
    await seedAppMemory(db, {
      id: "appmem_org",
      scope: "organization",
      content: "Organization rule",
      createdAtMs: 100,
    })
    const kv = fakeKV()
    const index = fakeIndex()
    const shared = { OPENCLAW_STATE: kv, OPENCLAW_AGENT_MEMORY_INDEX: index, AI: fakeAi() } as Partial<Env>
    const offEnv = environment(db, "off", shared)
    const written = await worker.fetch(
      new Request("https://worker.example/v1/memory", {
        method: "PUT",
        headers: { authorization: `Bearer ${TOKEN_A}`, "content-type": "application/json" },
        body: JSON.stringify({
          userId: "wire-user",
          repoId: "sigilix/sigilix",
          kind: "preference",
          content: "Legacy seat result",
        }),
      }),
      offEnv,
      executionContext(),
    )
    expect(written.status).toBe(200)

    const legacyText = await (await query(offEnv, TOKEN_A)).text()
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const shadowText = await (await query(environment(db, "shadow", shared), TOKEN_A)).text()
    expect(shadowText).toBe(legacyText)
    const shadowLog = logSpy.mock.calls
      .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .find((entry) => entry.event === "cli-app-memory-context-shadow")
    expect(shadowLog).toMatchObject({ available: true, personalSelected: 0, organizationSelected: 1 })
    expect(shadowLog).not.toHaveProperty("ids")
    expect(shadowLog).not.toHaveProperty("content")

    const failedText = await (await query(environment(failAppMemoryReads(db), "on", shared), TOKEN_A)).text()
    expect(failedText).toBe(legacyText)
  })

  it("applies deterministic per-scope candidate, count, budget, and dedupe bounds", async () => {
    const db = await makeDatabase()
    for (const row of [
      ["p-new", "personal-new", 900],
      ["p-shared", "  Shared\nRULE  ", 800],
      ["p-2000", "p".repeat(2_000), 700],
      ["p-too-large", "x".repeat(1_500), 600],
      ["p-backfill", "b".repeat(900), 500],
      ["p-fifth", "personal-fifth", 400],
      ["p-sixth", "personal-sixth", 300],
      ["p-seventh", "personal-seventh", 200],
      ["p-beyond-candidate-cap", "must-not-surface", 100],
    ] as const) {
      await seedAppMemory(db, {
        id: `appmem_${row[0]}`,
        scope: "personal",
        ownerUserId: "user-a",
        content: row[1],
        createdAtMs: row[2],
      })
    }
    for (const row of [
      ["o-shared", "shared   rule", 900],
      ["o-new", "org-new", 800],
      ["o-2000", "o".repeat(2_000), 700],
      ["o-too-large", "y".repeat(1_500), 600],
      ["o-backfill", "c".repeat(900), 500],
      ["o-fourth", "org-fourth", 400],
      ["o-fifth", "org-fifth", 300],
      ["o-sixth", "org-sixth", 200],
    ] as const) {
      await seedAppMemory(db, {
        id: `appmem_${row[0]}`,
        scope: "organization",
        content: row[1],
        createdAtMs: row[2],
      })
    }

    const body = (await (await query(environment(db), TOKEN_A)).json()) as QueryResponse
    expect(body.appMemories?.map((memory) => memory.id)).toEqual([
      "appmem_p-new",
      "appmem_p-shared",
      "appmem_p-2000",
      "appmem_p-backfill",
      "appmem_o-new",
      "appmem_o-2000",
      "appmem_o-backfill",
      "appmem_o-fourth",
    ])
    const personalChars = body.appMemories
      ?.filter((memory) => memory.scope === "personal")
      .reduce((sum, memory) => sum + memory.content.length, 0)
    const orgChars = body.appMemories
      ?.filter((memory) => memory.scope === "organization")
      .reduce((sum, memory) => sum + memory.content.length, 0)
    expect(personalChars).toBeLessThanOrEqual(3_000)
    expect(orgChars).toBeLessThanOrEqual(3_000)
  })
})
