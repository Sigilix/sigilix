// sig-portal-memories: GET|POST|DELETE /v1/org/:installationId/repos/:repoId/learnings —
// membership + repo-write gating, the CROSS-TENANT guard (repoId must belong to
// the installation), secret redaction, taxonomy validation, the MAX_LEARNINGS
// cap, and round-trip coverage. Session-only + per-installation membership +
// per-repo write access. The happy path + the cross-tenant case run through the
// real `handleOrgRoutes` dispatcher (regex + CORS) so the wiring is covered
// end-to-end; edge cases call the handlers directly for precision.

import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  handleCreateRepoLearning,
  handleDeleteRepoLearning,
  handleListRepoLearnings,
} from "@/src/lib/repo-learnings-route"
import { handleOrgRoutes } from "@/src/lib/org-routes"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { learningsKey } from "@/src/features/learnings"
import type { LearningEntry, LearningStore } from "@/src/features/learnings"
import { upsertTenantAndRepo } from "@/src/features/tenancy"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(9))
const CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

const INSTALL_ID = 42
const REPO_ID = 555
const REPO_FULL_NAME = "acme/widget"
const FOREIGN_INSTALL_ID = 77
const FOREIGN_REPO_ID = 999
const FOREIGN_FULL_NAME = "other/repo"

// The tenant + repo registry migration (owns the `repo` table the cross-tenant guard reads).
const MIGRATION_0001_SQL = readFileSync(
  new URL("../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url),
  "utf8",
)
const MIGRATION_0006_SQL = readFileSync(
  new URL("../../migrations/0006_create_user_identity.sql", import.meta.url),
  "utf8",
)

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
    userId: "user-111",
    login,
    githubUserId: 111,
    accessToken: "ghu_test_token",
    encryptionKeyB64url: ENC_KEY,
  })
}

interface RepoStub {
  fullName: string
  permissions?: { push?: boolean; maintain?: boolean; admin?: boolean }
}

/**
 * Stub GitHub for: `/user/installations`, `/user/memberships/orgs`, and
 * `GET /repositories/:id`. An unlisted repo id 404s (the caller can't see it).
 */
function stubGitHub(opts: {
  installations: Array<{ id: number; account: { type: string; login: string } }>
  memberships: Array<{ role: string; state: string; organization: { login: string } }>
  repos?: Record<number, RepoStub>
  expectedAccessToken?: string
}): string[] {
  const seenAuthorizations: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url === "https://github.com/login/oauth/access_token") {
        return new Response(
          JSON.stringify({
            access_token: opts.expectedAccessToken,
            refresh_token: "rotated-refresh",
            expires_in: 28_800,
            refresh_token_expires_in: 15_897_600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (opts.expectedAccessToken) {
        seenAuthorizations.push(new Headers(init?.headers).get("authorization") ?? "")
      }
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
      const repoMatch = /^https:\/\/api\.github\.com\/repositories\/(\d+)$/.exec(url)
      if (repoMatch) {
        const repo = opts.repos?.[Number(repoMatch[1])]
        if (!repo) return new Response("not found", { status: 404 })
        return new Response(JSON.stringify({ full_name: repo.fullName, permissions: repo.permissions ?? {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response("not found", { status: 404 })
    }),
  )
  return seenAuthorizations
}

/** Member of install 42 who ALSO has repo-write access to repo 555 ("acme/widget"). */
function stubMemberWithRepoWrite(): void {
  stubGitHub({
    installations: [{ id: INSTALL_ID, account: { type: "Organization", login: "acme" } }],
    memberships: [{ role: "member", state: "active", organization: { login: "acme" } }],
    repos: { [REPO_ID]: { fullName: REPO_FULL_NAME, permissions: { push: true } } },
  })
}

/** Member of install 42 with only READ access to repo 555 (no push/maintain/admin). */
function stubMemberReadOnly(): void {
  stubGitHub({
    installations: [{ id: INSTALL_ID, account: { type: "Organization", login: "acme" } }],
    memberships: [{ role: "member", state: "active", organization: { login: "acme" } }],
    repos: { [REPO_ID]: { fullName: REPO_FULL_NAME, permissions: { push: false, maintain: false, admin: false } } },
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

let db: D1Database

function baseEnv(kv: KVNamespace): Env {
  return { OPENCLAW_STATE: kv, OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY, SIGILIX_PLATFORM_DB: db } as unknown as Env
}

async function registerRepo(installationId: number, repoId: number, fullName: string): Promise<void> {
  await upsertTenantAndRepo(
    { SIGILIX_PLATFORM_DB: db },
    { installationId, repoId, fullName, nowIso: "2026-01-01T00:00:00Z" },
  )
}

function makeEntry(i: number, source: LearningEntry["source"] = { kind: "portal" }): LearningEntry {
  return {
    id: i.toString(16).padStart(16, "0"),
    rule: `existing rule ${i}`,
    polarity: "context",
    scope: "repo",
    subjectId: String(REPO_ID),
    source,
    createdTs: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    appliedCount: 0,
    type: "durable_preference",
  }
}

async function seedLearnings(kv: KVNamespace, repoId: number, entries: LearningEntry[]): Promise<void> {
  const store: LearningStore = { schemaVersion: 1, scope: "repo", subjectId: String(repoId), entries }
  await kv.put(learningsKey("repo", String(repoId)), JSON.stringify(store))
}

async function readStored(store: Map<string, string>, repoId: number): Promise<LearningStore | null> {
  const raw = store.get(learningsKey("repo", String(repoId)))
  return raw ? (JSON.parse(raw) as LearningStore) : null
}

beforeEach(async () => {
  db = makeD1()
  await db.exec(MIGRATION_0001_SQL)
  await db.exec(MIGRATION_0006_SQL)
  await db
    .prepare(
      `INSERT INTO user_identity
       (user_id, github_user_id, providers, created_at, last_login_at)
       VALUES ('user-111', '111', '["github"]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    )
    .run()
  // Repo 555 belongs to install 42; the foreign repo 999 belongs to install 77.
  await registerRepo(INSTALL_ID, REPO_ID, REPO_FULL_NAME)
  await registerRepo(FOREIGN_INSTALL_ID, FOREIGN_REPO_ID, FOREIGN_FULL_NAME)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("repo-learnings route", () => {
  it("refreshes an expired GitHub token before resolving repository access", async () => {
    const { kv } = makeKV()
    await createSession({
      kv,
      sessionId: "expired-session",
      userId: "user-111",
      login: "octocat",
      githubUserId: 111,
      accessToken: "expired-access",
      refreshToken: "old-refresh",
      accessTokenExpiresAt: Date.now() - 1_000,
      refreshTokenExpiresAt: Date.now() + 60_000,
      encryptionKeyB64url: ENC_KEY,
    })
    const seenAuthorizations = stubGitHub({
      installations: [{ id: INSTALL_ID, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "member", state: "active", organization: { login: "acme" } }],
      repos: { [REPO_ID]: { fullName: REPO_FULL_NAME, permissions: { push: false } } },
      expectedAccessToken: "rotated-access",
    })
    const env = {
      ...baseEnv(kv),
      GITHUB_OAUTH_CLIENT_ID: "client-id",
      GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
    } as Env

    const res = await handleListRepoLearnings(
      req("GET", `/v1/org/${INSTALL_ID}/repos/${REPO_ID}/learnings`, "expired-session"),
      env,
      CTX,
      INSTALL_ID,
      REPO_ID,
    )

    expect(res.status).toBe(200)
    expect(seenAuthorizations).toEqual(["Bearer rotated-access", "Bearer rotated-access", "Bearer rotated-access"])
  })

  it("401 with no session", async () => {
    const { kv } = makeKV()
    const res = await handleCreateRepoLearning(
      req("POST", `/v1/org/${INSTALL_ID}/repos/${REPO_ID}/learnings`, null, "{}"),
      baseEnv(kv),
      CTX,
      INSTALL_ID,
      REPO_ID,
    )
    expect(res.status).toBe(401)
  })

  it("400 on a non-positive repo id", async () => {
    const { kv } = makeKV()
    const res = await handleListRepoLearnings(
      req("GET", `/v1/org/${INSTALL_ID}/repos/0/learnings`, "s1"),
      baseEnv(kv),
      CTX,
      INSTALL_ID,
      0,
    )
    expect(res.status).toBe(400)
  })

  it("415 on POST without application/json (CSRF guard)", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubMemberWithRepoWrite()
    const request = new Request(`https://x/v1/org/${INSTALL_ID}/repos/${REPO_ID}/learnings`, {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=s1` }, // no content-type
      body: JSON.stringify({ rule: "x" }),
    })
    const res = await handleCreateRepoLearning(request, baseEnv(kv), CTX, INSTALL_ID, REPO_ID)
    expect(res.status).toBe(415)
  })

  it("NON-MEMBER: a caller whose token can't see the installation is 403'd", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    // Token only sees install 99, not install 42.
    stubGitHub({
      installations: [{ id: 99, account: { type: "Organization", login: "other" } }],
      memberships: [{ role: "admin", state: "active", organization: { login: "other" } }],
      repos: { [REPO_ID]: { fullName: REPO_FULL_NAME, permissions: { push: true } } },
    })
    const res = await handleOrgRoutes(
      req("POST", `/v1/org/${INSTALL_ID}/repos/${REPO_ID}/learnings`, "s1", JSON.stringify({ rule: "x" })),
      baseEnv(kv),
      CTX,
    )
    expect(res?.status).toBe(403)
    expect(await readStored(store, REPO_ID)).toBeNull()
  })

  it("REPO-WRITE GATE: a member WITHOUT repo write access is 403'd on POST and nothing is stored", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubMemberReadOnly()
    const res = await handleOrgRoutes(
      req(
        "POST",
        `/v1/org/${INSTALL_ID}/repos/${REPO_ID}/learnings`,
        "s1",
        JSON.stringify({ rule: "auth lives in src/auth" }),
      ),
      baseEnv(kv),
      CTX,
    )
    expect(res?.status).toBe(403)
    expect(await readStored(store, REPO_ID)).toBeNull()
  })

  it("CROSS-TENANT: a member+writer cannot POST to a repoId registered under another installation", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    // Caller is a member of install 42 and can even push to the foreign repo, but
    // repo 999's full_name resolves to install 77 in the registry → 403.
    stubGitHub({
      installations: [{ id: INSTALL_ID, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "member", state: "active", organization: { login: "acme" } }],
      repos: { [FOREIGN_REPO_ID]: { fullName: FOREIGN_FULL_NAME, permissions: { push: true } } },
    })
    const res = await handleOrgRoutes(
      req("POST", `/v1/org/${INSTALL_ID}/repos/${FOREIGN_REPO_ID}/learnings`, "s1", JSON.stringify({ rule: "pwn" })),
      baseEnv(kv),
      CTX,
    )
    expect(res?.status).toBe(403)
    expect(await readStored(store, FOREIGN_REPO_ID)).toBeNull()
  })

  it("UNREGISTERED REPO: a repoId with no D1 registry row is 403'd (fail-closed) on GET/POST/DELETE", async () => {
    const UNREGISTERED_ID = 31337
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    // Caller is a member of install 42 with push access, but repo 31337 is not in
    // the D1 registry at all → lookupRepoByFullName returns null → fail-closed 403.
    stubGitHub({
      installations: [{ id: INSTALL_ID, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "member", state: "active", organization: { login: "acme" } }],
      repos: { [UNREGISTERED_ID]: { fullName: "ghost/repo", permissions: { push: true } } },
    })
    const base = `/v1/org/${INSTALL_ID}/repos/${UNREGISTERED_ID}/learnings`
    const post = await handleOrgRoutes(req("POST", base, "s1", JSON.stringify({ rule: "x" })), baseEnv(kv), CTX)
    expect(post?.status).toBe(403)
    const get = await handleOrgRoutes(req("GET", base, "s1"), baseEnv(kv), CTX)
    expect(get?.status).toBe(403)
    const del = await handleOrgRoutes(req("DELETE", `${base}/00000000000000ab`, "s1"), baseEnv(kv), CTX)
    expect(del?.status).toBe(403)
    expect(await readStored(store, UNREGISTERED_ID)).toBeNull()
  })

  it("CROSS-TENANT: the guard also blocks GET and DELETE on a foreign-tenant repoId", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    // Member of install 42, push access to the foreign repo, but repo 999 is registered under install 77.
    stubGitHub({
      installations: [{ id: INSTALL_ID, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "member", state: "active", organization: { login: "acme" } }],
      repos: { [FOREIGN_REPO_ID]: { fullName: FOREIGN_FULL_NAME, permissions: { push: true } } },
    })
    const base = `/v1/org/${INSTALL_ID}/repos/${FOREIGN_REPO_ID}/learnings`
    const get = await handleOrgRoutes(req("GET", base, "s1"), baseEnv(kv), CTX)
    expect(get?.status).toBe(403)
    const del = await handleOrgRoutes(req("DELETE", `${base}/00000000000000ab`, "s1"), baseEnv(kv), CTX)
    expect(del?.status).toBe(403)
  })

  it("dev-with-repo-write can POST a learning; stored as repo/context/portal", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubMemberWithRepoWrite()
    const res = await handleOrgRoutes(
      req(
        "POST",
        `/v1/org/${INSTALL_ID}/repos/${REPO_ID}/learnings`,
        "s1",
        JSON.stringify({ rule: "auth logic lives in src/auth" }),
      ),
      baseEnv(kv),
      CTX,
    )
    expect(res?.status).toBe(201)
    const body = (await res!.json()) as {
      role: string
      canWrite: boolean
      deduped: boolean
      entry: Record<string, unknown>
    }
    expect(body.canWrite).toBe(true)
    expect(body.deduped).toBe(false)
    expect(body.entry.rule).toBe("auth logic lives in src/auth")
    // Guardrail: a manual entry is context — NEVER a suppression.
    expect(body.entry.polarity).toBe("context")

    const stored = await readStored(store, REPO_ID)
    expect(stored?.entries).toHaveLength(1)
    const entry = stored!.entries[0]!
    expect(entry.scope).toBe("repo")
    expect(entry.subjectId).toBe(String(REPO_ID))
    expect(entry.polarity).toBe("context")
    expect(entry.source.kind).toBe("portal")
    expect(entry.type).toBe("durable_preference")
    expect(entry.authorLogin).toBe("octocat")
  })

  it("defaults type to durable_preference and accepts architectural_fact + pathGlob", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubMemberWithRepoWrite()
    const res = await handleCreateRepoLearning(
      req(
        "POST",
        `/v1/org/${INSTALL_ID}/repos/${REPO_ID}/learnings`,
        "s1",
        JSON.stringify({ rule: "we use zod at the edges", type: "architectural_fact", pathGlob: "src/**" }),
      ),
      baseEnv(kv),
      CTX,
      INSTALL_ID,
      REPO_ID,
    )
    expect(res.status).toBe(201)
    const entry = (await readStored(store, REPO_ID))!.entries[0]!
    expect(entry.type).toBe("architectural_fact")
    expect(entry.pathGlob).toBe("src/**")
  })

  it("REJECTS the machine/PR-anchored taxonomy tiers", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubMemberWithRepoWrite()
    for (const type of ["ephemeral_project", "transient_feedback"]) {
      const res = await handleCreateRepoLearning(
        req("POST", `/v1/org/${INSTALL_ID}/repos/${REPO_ID}/learnings`, "s1", JSON.stringify({ rule: "x", type })),
        baseEnv(kv),
        CTX,
        INSTALL_ID,
        REPO_ID,
      )
      expect(res.status).toBe(400)
      expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid type" })
    }
    expect(await readStored(store, REPO_ID)).toBeNull()
  })

  it("REDACTS a secret in the rule before it reaches KV", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubMemberWithRepoWrite()
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    const res = await handleCreateRepoLearning(
      req(
        "POST",
        `/v1/org/${INSTALL_ID}/repos/${REPO_ID}/learnings`,
        "s1",
        JSON.stringify({ rule: `deploy token is ${secret}` }),
      ),
      baseEnv(kv),
      CTX,
      INSTALL_ID,
      REPO_ID,
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { entry: { rule: string } }
    expect(body.entry.rule).not.toContain(secret)
    expect(body.entry.rule).toContain("[redacted-token]")
    const entry = (await readStored(store, REPO_ID))!.entries[0]!
    expect(entry.rule).not.toContain(secret)
  })

  it("returns limit_reached (409) at MAX_LEARNINGS instead of silently evicting", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubMemberWithRepoWrite()
    await seedLearnings(
      kv,
      REPO_ID,
      Array.from({ length: 50 }, (_, i) => makeEntry(i + 1)),
    )
    const res = await handleCreateRepoLearning(
      req("POST", `/v1/org/${INSTALL_ID}/repos/${REPO_ID}/learnings`, "s1", JSON.stringify({ rule: "one too many" })),
      baseEnv(kv),
      CTX,
      INSTALL_ID,
      REPO_ID,
    )
    expect(res.status).toBe(409)
    expect((await res.json()) as { error: string }).toMatchObject({ error: "limit_reached", limit: 50 })
    expect((await readStored(store, REPO_ID))!.entries).toHaveLength(50)
  })

  it("GET lists entries newest-first and echoes role + canWrite (read-only member allowed)", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubMemberReadOnly() // read-only: GET is still allowed
    await seedLearnings(kv, REPO_ID, [makeEntry(1), makeEntry(2), makeEntry(3)])
    const res = await handleOrgRoutes(
      req("GET", `/v1/org/${INSTALL_ID}/repos/${REPO_ID}/learnings`, "s1"),
      baseEnv(kv),
      CTX,
    )
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { role: string; canWrite: boolean; entries: Array<{ id: string }> }
    expect(body.role).toBe("member")
    expect(body.canWrite).toBe(false)
    expect(body.entries).toHaveLength(3)
    // makeEntry(3) has the newest createdTs → first.
    expect(body.entries[0]!.id).toBe((3).toString(16).padStart(16, "0"))
  })

  it("DELETE removes an entry (repo-write required)", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubMemberWithRepoWrite()
    const entry = makeEntry(7)
    await seedLearnings(kv, REPO_ID, [entry, makeEntry(8)])
    const res = await handleDeleteRepoLearning(
      req("DELETE", `/v1/org/${INSTALL_ID}/repos/${REPO_ID}/learnings/${entry.id}`, "s1"),
      baseEnv(kv),
      CTX,
      INSTALL_ID,
      REPO_ID,
      entry.id,
    )
    expect(res.status).toBe(200)
    expect((await res.json()) as { canWrite: boolean; ok: boolean }).toMatchObject({ canWrite: true, ok: true })
    const remaining = (await readStored(store, REPO_ID))!.entries
    expect(remaining.map((e) => e.id)).toEqual([(8).toString(16).padStart(16, "0")])
  })

  it("DELETE by a read-only member (no repo write) is 403'd", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubMemberReadOnly()
    const res = await handleDeleteRepoLearning(
      req("DELETE", `/v1/org/${INSTALL_ID}/repos/${REPO_ID}/learnings/00000000000000ab`, "s1"),
      baseEnv(kv),
      CTX,
      INSTALL_ID,
      REPO_ID,
      "00000000000000ab",
    )
    expect(res.status).toBe(403)
  })

  it("DELETE of a malformed id is 404 (never reaches the store)", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubMemberWithRepoWrite()
    const res = await handleDeleteRepoLearning(
      req("DELETE", `/v1/org/${INSTALL_ID}/repos/${REPO_ID}/learnings/not-a-real-id`, "s1"),
      baseEnv(kv),
      CTX,
      INSTALL_ID,
      REPO_ID,
      "not-a-real-id",
    )
    expect(res.status).toBe(404)
  })

  it("RECALL-SAFETY: GET hides machine-captured entries and DELETE cannot remove them", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    // A machine-captured `require` guardrail in the SHARED repo store.
    const machine = makeEntry(0xdead, { kind: "qa", prNumber: 5 })
    machine.polarity = "require"
    machine.rule = "always add a test"
    await seedLearnings(kv, REPO_ID, [machine, makeEntry(1)])

    // GET surfaces only the portal entry, never the machine guardrail.
    stubMemberReadOnly()
    const list = await handleListRepoLearnings(
      req("GET", `/v1/org/${INSTALL_ID}/repos/${REPO_ID}/learnings`, "s1"),
      baseEnv(kv),
      CTX,
      INSTALL_ID,
      REPO_ID,
    )
    const listBody = (await list.json()) as { entries: Array<{ id: string; polarity: string }> }
    expect(listBody.entries.map((e) => e.id)).toEqual([(1).toString(16).padStart(16, "0")])
    expect(listBody.entries.some((e) => e.polarity === "require")).toBe(false)

    // DELETE (writer) of the machine guardrail is 404 and leaves it intact.
    stubMemberWithRepoWrite()
    const del = await handleDeleteRepoLearning(
      req("DELETE", `/v1/org/${INSTALL_ID}/repos/${REPO_ID}/learnings/${machine.id}`, "s1"),
      baseEnv(kv),
      CTX,
      INSTALL_ID,
      REPO_ID,
      machine.id,
    )
    expect(del.status).toBe(404)
    expect((await readStored(store, REPO_ID))!.entries.map((e) => e.id)).toContain(machine.id)
  })
})
