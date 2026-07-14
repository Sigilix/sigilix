// sig-portal-memories: GET|POST|DELETE /v1/org/:installationId/learnings —
// admin-gating, tenant isolation, secret redaction, taxonomy validation, the
// MAX_LEARNINGS cap, and round-trip coverage. Session-only + per-installation
// admin gate (mirrors review-config-route.test.ts). The happy path + the
// cross-tenant case run through the real `handleOrgRoutes` dispatcher (regex +
// CORS) so the wiring is covered end-to-end; edge cases call the handlers
// directly for precision.

import { afterEach, describe, expect, it, vi } from "vitest"
import { handleCreateOrgLearning, handleDeleteOrgLearning, handleListOrgLearnings } from "@/src/lib/org-learnings-route"
import { handleOrgRoutes } from "@/src/lib/org-routes"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { learningsKey } from "@/src/features/learnings"
import type { LearningEntry, LearningStore } from "@/src/features/learnings"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(9))
const CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

function makeKV(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>()
  const kv = {
    get: async (key: string, type?: "json") => {
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
  } as unknown as KVNamespace
  return { kv, store }
}

async function seedSession(kv: KVNamespace, sessionId: string, login: string): Promise<void> {
  await createSession({
    kv,
    sessionId,
    login,
    githubUserId: 111,
    accessToken: "ghu_test_token",
    encryptionKeyB64url: ENC_KEY,
  })
}

/** Stub GitHub so the per-installation role helpers see the given installation + membership role. */
function stubGitHub(opts: {
  installations: Array<{ id: number; account: { type: string; login: string } }>
  memberships: Array<{ role: string; state: string; organization: { login: string } }>
}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("https://api.github.com/user/installations")) {
        return new Response(
          JSON.stringify({ total_count: opts.installations.length, installations: opts.installations }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.startsWith("https://api.github.com/user/memberships/orgs")) {
        return new Response(JSON.stringify(opts.memberships), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response("not found", { status: 404 })
    }),
  )
}

function stubOrgAdmin(): void {
  stubGitHub({
    installations: [{ id: 42, account: { type: "Organization", login: "acme" } }],
    memberships: [{ role: "admin", state: "active", organization: { login: "acme" } }],
  })
}

function stubOrgMember(): void {
  stubGitHub({
    installations: [{ id: 42, account: { type: "Organization", login: "acme" } }],
    memberships: [{ role: "member", state: "active", organization: { login: "acme" } }],
  })
}

function req(method: string, path: string, sessionId: string | null, body?: string): Request {
  const headers = new Headers()
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`)
  if (body !== undefined) headers.set("content-type", "application/json")
  const init: RequestInit = { method, headers }
  if (body !== undefined) init.body = body
  return new Request(`https://x${path}`, init)
}

function baseEnv(kv: KVNamespace): Env {
  return { OPENCLAW_STATE: kv, OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY } as unknown as Env
}

function makeEntry(i: number): LearningEntry {
  return {
    id: i.toString(16).padStart(16, "0"),
    rule: `existing rule ${i}`,
    polarity: "context",
    scope: "org",
    subjectId: "42",
    source: { kind: "portal" },
    createdTs: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    appliedCount: 0,
    type: "durable_preference",
  }
}

async function seedLearnings(kv: KVNamespace, installationId: number, entries: LearningEntry[]): Promise<void> {
  const store: LearningStore = { schemaVersion: 1, scope: "org", subjectId: String(installationId), entries }
  await kv.put(learningsKey("org", String(installationId)), JSON.stringify(store))
}

async function readStored(store: Map<string, string>, installationId: number): Promise<LearningStore | null> {
  const raw = store.get(learningsKey("org", String(installationId)))
  return raw ? (JSON.parse(raw) as LearningStore) : null
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("org-learnings route", () => {
  it("401 with no session", async () => {
    const { kv } = makeKV()
    const res = await handleCreateOrgLearning(req("POST", "/v1/org/42/learnings", null, "{}"), baseEnv(kv), CTX, 42)
    expect(res.status).toBe(401)
  })

  it("400 on a non-positive installation id", async () => {
    const { kv } = makeKV()
    const res = await handleListOrgLearnings(req("GET", "/v1/org/0/learnings", "s1"), baseEnv(kv), CTX, 0)
    expect(res.status).toBe(400)
  })

  it("415 on POST without application/json (CSRF guard)", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubOrgAdmin()
    const request = new Request("https://x/v1/org/42/learnings", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=s1` }, // no content-type
      body: JSON.stringify({ rule: "x" }),
    })
    const res = await handleCreateOrgLearning(request, baseEnv(kv), CTX, 42)
    expect(res.status).toBe(415)
  })

  it("ADMIN-GATE: a member (non-admin) is 403'd on POST and nothing is stored", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubOrgMember()
    const res = await handleOrgRoutes(
      req("POST", "/v1/org/42/learnings", "s1", JSON.stringify({ rule: "auth lives in src/auth" })),
      baseEnv(kv),
      CTX,
    )
    expect(res?.status).toBe(403)
    expect(await readStored(store, 42)).toBeNull()
  })

  it("TENANT ISOLATION: an admin of org A cannot POST to an install they can't see", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubOrgAdmin() // token only sees install 42
    const res = await handleOrgRoutes(
      req("POST", "/v1/org/999/learnings", "s1", JSON.stringify({ rule: "pwn org B" })),
      baseEnv(kv),
      CTX,
    )
    expect(res?.status).toBe(403)
    expect(await readStored(store, 999)).toBeNull()
  })

  it("admin-of-this-org can POST a learning; it is stored as org/context/portal", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubOrgAdmin()
    const res = await handleOrgRoutes(
      req("POST", "/v1/org/42/learnings", "s1", JSON.stringify({ rule: "auth logic lives in src/auth" })),
      baseEnv(kv),
      CTX,
    )
    expect(res?.status).toBe(201)
    const body = (await res!.json()) as { role: string; deduped: boolean; entry: Record<string, unknown> }
    expect(body.role).toBe("admin")
    expect(body.deduped).toBe(false)
    expect(body.entry.rule).toBe("auth logic lives in src/auth")
    // Guardrail: a manual entry is context — NEVER a suppression.
    expect(body.entry.polarity).toBe("context")

    const stored = await readStored(store, 42)
    expect(stored?.entries).toHaveLength(1)
    const entry = stored!.entries[0]!
    expect(entry.scope).toBe("org")
    expect(entry.subjectId).toBe("42")
    expect(entry.polarity).toBe("context")
    expect(entry.source.kind).toBe("portal")
    expect(entry.type).toBe("durable_preference")
    expect(entry.authorLogin).toBe("octocat")
  })

  it("defaults type to durable_preference and accepts architectural_fact + pathGlob", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubOrgAdmin()
    const res = await handleCreateOrgLearning(
      req(
        "POST",
        "/v1/org/42/learnings",
        "s1",
        JSON.stringify({ rule: "we use zod at the edges", type: "architectural_fact", pathGlob: "src/**" }),
      ),
      baseEnv(kv),
      CTX,
      42,
    )
    expect(res.status).toBe(201)
    const entry = (await readStored(store, 42))!.entries[0]!
    expect(entry.type).toBe("architectural_fact")
    expect(entry.pathGlob).toBe("src/**")
  })

  it("REJECTS the machine/PR-anchored taxonomy tiers", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubOrgAdmin()
    for (const type of ["ephemeral_project", "transient_feedback"]) {
      const res = await handleCreateOrgLearning(
        req("POST", "/v1/org/42/learnings", "s1", JSON.stringify({ rule: "x", type })),
        baseEnv(kv),
        CTX,
        42,
      )
      expect(res.status).toBe(400)
      expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid type" })
    }
    expect(await readStored(store, 42)).toBeNull()
  })

  it("REDACTS a secret in the rule before it reaches KV", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubOrgAdmin()
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    const res = await handleCreateOrgLearning(
      req("POST", "/v1/org/42/learnings", "s1", JSON.stringify({ rule: `deploy token is ${secret}` })),
      baseEnv(kv),
      CTX,
      42,
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { entry: { rule: string } }
    expect(body.entry.rule).not.toContain(secret)
    expect(body.entry.rule).toContain("[redacted-token]")
    const entry = (await readStored(store, 42))!.entries[0]!
    expect(entry.rule).not.toContain(secret)
  })

  it("returns limit_reached (409) at MAX_LEARNINGS instead of silently evicting", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubOrgAdmin()
    await seedLearnings(
      kv,
      42,
      Array.from({ length: 50 }, (_, i) => makeEntry(i + 1)),
    )
    const res = await handleCreateOrgLearning(
      req("POST", "/v1/org/42/learnings", "s1", JSON.stringify({ rule: "one rule too many" })),
      baseEnv(kv),
      CTX,
      42,
    )
    expect(res.status).toBe(409)
    expect((await res.json()) as { error: string }).toMatchObject({ error: "limit_reached", limit: 50 })
    // Nothing evicted, nothing added — still exactly 50.
    expect((await readStored(store, 42))!.entries).toHaveLength(50)
  })

  it("GET lists entries newest-first and echoes the member role", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubOrgMember()
    await seedLearnings(kv, 42, [makeEntry(1), makeEntry(2), makeEntry(3)])
    const res = await handleOrgRoutes(req("GET", "/v1/org/42/learnings", "s1"), baseEnv(kv), CTX)
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { role: string; entries: Array<{ id: string }> }
    expect(body.role).toBe("member")
    expect(body.entries).toHaveLength(3)
    // makeEntry(3) has the newest createdTs → first.
    expect(body.entries[0]!.id).toBe((3).toString(16).padStart(16, "0"))
  })

  it("DELETE removes an entry (admin only)", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubOrgAdmin()
    const entry = makeEntry(7)
    await seedLearnings(kv, 42, [entry, makeEntry(8)])
    const res = await handleDeleteOrgLearning(
      req("DELETE", `/v1/org/42/learnings/${entry.id}`, "s1"),
      baseEnv(kv),
      CTX,
      42,
      entry.id,
    )
    expect(res.status).toBe(200)
    expect((await res.json()) as { role: string; ok: boolean }).toMatchObject({ role: "admin", ok: true })
    const remaining = (await readStored(store, 42))!.entries
    expect(remaining.map((e) => e.id)).toEqual([(8).toString(16).padStart(16, "0")])
  })

  it("DELETE by a member (non-admin) is 403'd", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubOrgMember()
    const res = await handleDeleteOrgLearning(
      req("DELETE", "/v1/org/42/learnings/00000000000000ab", "s1"),
      baseEnv(kv),
      CTX,
      42,
      "00000000000000ab",
    )
    expect(res.status).toBe(403)
  })

  it("DELETE of a malformed id is 404 (never reaches the store)", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubOrgAdmin()
    const res = await handleDeleteOrgLearning(
      req("DELETE", "/v1/org/42/learnings/not-a-real-id", "s1"),
      baseEnv(kv),
      CTX,
      42,
      "not-a-real-id",
    )
    expect(res.status).toBe(404)
  })

  it("RECALL-SAFETY: GET hides machine-captured entries and DELETE cannot remove them", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    // A machine-captured `require` guardrail in the SHARED org store.
    const machine: LearningEntry = {
      id: "00000000deadbeef",
      rule: "always add a test",
      polarity: "require",
      scope: "org",
      subjectId: "42",
      source: { kind: "qa", prNumber: 5 },
      createdTs: new Date(1_700_000_500_000).toISOString(),
      appliedCount: 3,
      type: "durable_preference",
    }
    await seedLearnings(kv, 42, [machine, makeEntry(1)])

    // GET (member) surfaces only the portal entry, never the machine guardrail.
    stubOrgMember()
    const list = await handleListOrgLearnings(req("GET", "/v1/org/42/learnings", "s1"), baseEnv(kv), CTX, 42)
    const listBody = (await list.json()) as { entries: Array<{ id: string; polarity: string }> }
    expect(listBody.entries.map((e) => e.id)).toEqual([(1).toString(16).padStart(16, "0")])
    expect(listBody.entries.some((e) => e.polarity === "require")).toBe(false)

    // DELETE (admin) of the machine guardrail is 404 and leaves it intact.
    stubOrgAdmin()
    const del = await handleDeleteOrgLearning(
      req("DELETE", `/v1/org/42/learnings/${machine.id}`, "s1"),
      baseEnv(kv),
      CTX,
      42,
      machine.id,
    )
    expect(del.status).toBe(404)
    expect((await readStored(store, 42))!.entries.map((e) => e.id)).toContain(machine.id)
  })
})
