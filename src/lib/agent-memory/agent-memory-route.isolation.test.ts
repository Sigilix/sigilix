// Seat∪Org memory layering — ISOLATION regression test.
//
// Founder invariant (see org-mirror.ts's "ISOLATION INVARIANT" comment): a
// per-user/per-seat CLI capture (this feature — `agent-memory:*` KV keys)
// must NEVER be written into the org learnings keyspace (`learnings:org:*`).
// Only a server-derived PR-review capture (review-memory/capture.ts,
// github-mention-auto-learnings.ts) may populate `learnings:org:*`, via
// `mirrorLearningToOrgScope`.
//
// This test exercises the REAL seat-write path — `storeMemoryFact` (the
// single write leg shared by PUT /v1/memory and POST /v1/memory/extract, per
// its own doc comment) and the full `handleMemoryWriteRoute` HTTP handler —
// against a real KV double, and inspects every key actually written. It would
// fail if a future change routed a CLI-supplied fact directly through
// `appendLearning(env, "org", ...)` (that writes a `learnings:org:*` key
// unconditionally, into this same fake KV, regardless of installation
// resolution — this test catches it). A future `mirrorLearningToOrgScope`
// call wired into this path would only be caught here in the branches where
// an installation actually resolves; org-mirror.test.ts covers that
// function's own resolution/fail-soft behavior in isolation. The structural
// guarantee today is stronger than either test: this feature's write path
// (storage.ts) only ever touches the `agent-memory:`/`agent-memory-hash:`
// keyspace — it has no import of, or call into, the learnings feature at all.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { insertApiKey } from "@/src/lib/api-key-store"
import { sha256Hex as bearerSha256Hex } from "@/src/lib/auth-bearer"
import { handleMemoryWriteRoute, storeMemoryFact } from "./agent-memory-route"
import { personalMemoryUserId } from "./agent-memory-personal-subject"
import type { Env } from "@/src/shared/types/env"

const DIMS = 768
// The real Sigilix/sigilix installation id from prod evidence (learnings:repo:1225209204
// has 47 real learnings; this installation owns that repo) — using it here pins the test
// to the exact tenant the founder's evidence concerns, not an arbitrary fixture id.
const SIGILIX_INSTALLATION_ID = 134_811_639

function fakeKV(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>()
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
  } as unknown as KVNamespace
  return { kv, store }
}

function fakeAi(): Env["AI"] {
  return {
    run: async () => ({ data: [Array.from({ length: DIMS }, () => 0.1)], shape: [1, DIMS] }),
  } as unknown as Env["AI"]
}

function fakeIndex(): Env["OPENCLAW_AGENT_MEMORY_INDEX"] {
  return {
    upsert: async () => undefined,
    query: async () => ({ matches: [] }),
  } as unknown as Env["OPENCLAW_AGENT_MEMORY_INDEX"]
}

/** Every key that isn't scoped to this feature's own `agent-memory:`/`agent-memory-hash:`
 *  keyspace (storage.ts's two key shapes — the record and its content-dedup pointer). */
function keysOutsideAgentMemory(store: Map<string, string>): string[] {
  return Array.from(store.keys()).filter((k) => !k.startsWith("agent-memory:") && !k.startsWith("agent-memory-hash:"))
}

describe("agent-memory seat writes NEVER land in learnings:org:* (isolation invariant)", () => {
  let kv: Map<string, string>
  let env: Env

  beforeEach(() => {
    const fake = fakeKV()
    kv = fake.store
    env = {
      OPENCLAW_STATE: fake.kv,
      AI: fakeAi(),
      OPENCLAW_AGENT_MEMORY_INDEX: fakeIndex(),
      // Org-memory-capture flag ON — proves the seat-write path ignores it
      // entirely (it has no wiring to org-mirror at all), not merely that the
      // flag happens to be off in this test.
      OPENCLAW_ORG_MEMORY_CAPTURE: "on",
    } as unknown as Env
  })

  it("storeMemoryFact (the shared PUT+extract write leg) writes ONLY agent-memory:* keys", async () => {
    const userId = personalMemoryUserId(SIGILIX_INSTALLATION_ID, "internal-user-1")
    await storeMemoryFact(env, {
      userId,
      repoId: "sigilix/sigilix",
      kind: "preference",
      content: "always use named exports",
    })

    expect(kv.size).toBeGreaterThan(0)
    expect(keysOutsideAgentMemory(kv)).toEqual([])
    expect(Array.from(kv.keys()).some((k) => k.startsWith("learnings:"))).toBe(false)
    expect(Array.from(kv.keys()).some((k) => k.startsWith("learnings:org:"))).toBe(false)
  })

  it("PUT /v1/memory (full route, real per-tenant api key auth) writes ONLY agent-memory:* keys", async () => {
    const db = makeD1()
    await db.exec(
      readFileSync(new URL("../../../migrations/0003_create_account_tenant_and_api_key.sql", import.meta.url), "utf8"),
    )
    await db.exec(readFileSync(new URL("../../../migrations/0006_create_user_identity.sql", import.meta.url), "utf8"))
    await db
      .prepare(
        "INSERT INTO user_identity " +
          "(user_id, github_user_id, providers, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind("internal-user-1", "1", '["github"]', "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
      .run()
    const plaintext = "sigilix_live_isolation_test"
    await insertApiKey(db, {
      id: "key-isolation",
      keyHash: await bearerSha256Hex(plaintext),
      installationId: SIGILIX_INSTALLATION_ID,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })
    env = { ...env, SIGILIX_PLATFORM_DB: db } as unknown as Env

    const request = new Request("https://api.sigilix.ai/v1/memory", {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({
        userId: "some-cli-user",
        repoId: "sigilix/sigilix",
        kind: "decision",
        content: "a per-user CLI decision that must stay seat-scoped",
      }),
    })
    const res = await handleMemoryWriteRoute(request, env)
    expect(res.status).toBe(200)

    expect(keysOutsideAgentMemory(kv)).toEqual([])
    expect(Array.from(kv.keys()).some((k) => k.startsWith("learnings:org:"))).toBe(false)
  })
})
