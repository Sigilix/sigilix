// #155 onboarding-backend FOUNDATION (slice 1 of 2) — resolveApiKey unit tests.
//
// This module is NOT wired into any endpoint yet (slice 2). These tests
// pin its standalone fail-closed behavior so the swap in slice 2 has a
// known-correct foundation to build on.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { LEGACY_TENANT_INSTALLATION_ID, resolveApiKey, requireApiTenant } from "@/src/lib/api-key-resolver"
import { insertApiKey, revokeApiKeyById } from "@/src/lib/api-key-store"
import { sha256Hex } from "@/src/lib/auth-bearer"

const API_KEY_MIGRATION_SQL = readFileSync(
  new URL("../../migrations/0003_create_account_tenant_and_api_key.sql", import.meta.url),
  "utf8",
)
const ORG_ACCESS_MIGRATION_SQL = readFileSync(
  new URL("../../migrations/0022_create_org_workspace_access.sql", import.meta.url),
  "utf8",
)

const GLOBAL_KEY = "global-shared-secret-token"

function reqWith(auth?: string): Request {
  return new Request("https://x/v1/review", auth ? { headers: { authorization: auth } } : undefined)
}

/** Throws on any operation — simulates a genuine D1 outage/fault. */
function makeBrokenDb(): D1Database {
  return {
    prepare() {
      throw new Error("simulated D1 error")
    },
  } as unknown as D1Database
}

describe("resolveApiKey", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(API_KEY_MIGRATION_SQL)
  })

  async function applyOrgAccessSchema(): Promise<void> {
    await db.exec(ORG_ACCESS_MIGRATION_SQL)
  }

  async function seedActiveAccess(installationId: number, githubUserId: string): Promise<void> {
    await db
      .prepare(
        `INSERT INTO org_workspace_access
          (installation_id, github_user_id, role, created_at, updated_at,
           revoked_at, updated_by, last_audit_id, last_action)
         VALUES (?, ?, 'member', ?, ?, NULL, ?, ?, 'member_added_or_regranted')`,
      )
      .bind(
        installationId,
        githubUserId,
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
        "test:admin",
        `audit-${installationId}-${githubUserId}`,
      )
      .run()
  }

  it("returns null when no Authorization header is present", async () => {
    expect(await resolveApiKey(reqWith(), { SIGILIX_PLATFORM_DB: db, OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY })).toBeNull()
  })

  it("D1 hit — resolves the installationId for a live, matching key", async () => {
    const plaintext = "sigilix_live_abc123"
    await insertApiKey(db, {
      id: "key-1",
      keyHash: await sha256Hex(plaintext),
      installationId: 777,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })

    const result = await resolveApiKey(reqWith(`Bearer ${plaintext}`), {
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
    })
    expect(result).toEqual({ installationId: 777, createdBy: "1" })
  })

  it("D1 hit — resolves a live key when the legacy global key is unset", async () => {
    const plaintext = "sigilix_live_without_global"
    await insertApiKey(db, {
      id: "key-without-global",
      keyHash: await sha256Hex(plaintext),
      installationId: 777,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })

    await expect(resolveApiKey(reqWith(`Bearer ${plaintext}`), { SIGILIX_PLATFORM_DB: db })).resolves.toEqual({
      installationId: 777,
      createdBy: "1",
    })
  })

  it("membership mode — resolves only when the key creator has active access to that exact installation", async () => {
    await applyOrgAccessSchema()
    const plaintext = "sigilix_live_member"
    await insertApiKey(db, {
      id: "key-member",
      keyHash: await sha256Hex(plaintext),
      installationId: 777,
      createdBy: "123",
      nowIso: "2026-01-01T00:00:00Z",
    })
    await seedActiveAccess(777, "123")

    await expect(
      resolveApiKey(reqWith(`Bearer ${plaintext}`), {
        SIGILIX_PLATFORM_DB: db,
        OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
        OPENCLAW_ORG_MEMBERSHIP_MODE: "on",
      }),
    ).resolves.toEqual({ installationId: 777, createdBy: "123" })
  })

  it("membership mode — denies a live key when its creator has no stored access", async () => {
    await applyOrgAccessSchema()
    const plaintext = "sigilix_live_missing_access"
    await insertApiKey(db, {
      id: "key-missing-access",
      keyHash: await sha256Hex(plaintext),
      installationId: 777,
      createdBy: "123",
      nowIso: "2026-01-01T00:00:00Z",
    })

    await expect(
      resolveApiKey(reqWith(`Bearer ${plaintext}`), {
        SIGILIX_PLATFORM_DB: db,
        OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
        OPENCLAW_ORG_MEMBERSHIP_MODE: "on",
      }),
    ).resolves.toBeNull()
  })

  it("membership mode — exact-installation access cannot authorize a key for another installation", async () => {
    await applyOrgAccessSchema()
    const plaintext = "sigilix_live_cross_install"
    await insertApiKey(db, {
      id: "key-cross-install",
      keyHash: await sha256Hex(plaintext),
      installationId: 777,
      createdBy: "123",
      nowIso: "2026-01-01T00:00:00Z",
    })
    await seedActiveAccess(778, "123")

    await expect(
      resolveApiKey(reqWith(`Bearer ${plaintext}`), {
        SIGILIX_PLATFORM_DB: db,
        OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
        OPENCLAW_ORG_MEMBERSHIP_MODE: "on",
      }),
    ).resolves.toBeNull()
  })

  it("membership mode — revoked stored access denies an otherwise-live key", async () => {
    await applyOrgAccessSchema()
    const plaintext = "sigilix_live_revoked_access"
    await insertApiKey(db, {
      id: "key-revoked-access",
      keyHash: await sha256Hex(plaintext),
      installationId: 777,
      createdBy: "123",
      nowIso: "2026-01-01T00:00:00Z",
    })
    await seedActiveAccess(777, "123")
    await db
      .prepare(
        `UPDATE org_workspace_access
            SET revoked_at = ?, updated_at = ?, updated_by = ?,
                last_audit_id = ?, last_action = 'access_removed'
          WHERE installation_id = ? AND github_user_id = ?`,
      )
      .bind("2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z", "test:admin", "audit-revoked-access", 777, "123")
      .run()

    await expect(
      resolveApiKey(reqWith(`Bearer ${plaintext}`), {
        SIGILIX_PLATFORM_DB: db,
        OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
        OPENCLAW_ORG_MEMBERSHIP_MODE: "on",
      }),
    ).resolves.toBeNull()
  })

  it("membership mode — a persisted denied key cannot escape through the global-key fallback", async () => {
    await applyOrgAccessSchema()
    await insertApiKey(db, {
      id: "key-global-collision",
      keyHash: await sha256Hex(GLOBAL_KEY),
      installationId: 777,
      createdBy: "123",
      nowIso: "2026-01-01T00:00:00Z",
    })

    await expect(
      resolveApiKey(reqWith(`Bearer ${GLOBAL_KEY}`), {
        SIGILIX_PLATFORM_DB: db,
        OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
        OPENCLAW_ORG_MEMBERSHIP_MODE: "on",
      }),
    ).resolves.toBeNull()
  })

  it("membership mode — the internal global key still resolves when no persisted key row matches", async () => {
    await applyOrgAccessSchema()
    await expect(
      resolveApiKey(reqWith(`Bearer ${GLOBAL_KEY}`), {
        SIGILIX_PLATFORM_DB: db,
        OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
        OPENCLAW_ORG_MEMBERSHIP_MODE: "on",
      }),
    ).resolves.toEqual({ installationId: LEGACY_TENANT_INSTALLATION_ID, createdBy: null })
  })

  it("D1 hit — best-effort updates last_used_at without affecting the result", async () => {
    const plaintext = "sigilix_live_touch"
    const keyHash = await sha256Hex(plaintext)
    await insertApiKey(db, { id: "key-1", keyHash, installationId: 5, createdBy: "1", nowIso: "2026-01-01T00:00:00Z" })

    await resolveApiKey(reqWith(`Bearer ${plaintext}`), {
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
    })

    const row = await db
      .prepare("SELECT last_used_at FROM api_key WHERE key_hash = ?")
      .bind(keyHash)
      .first<{ last_used_at: string | null }>()
    expect(row?.last_used_at).not.toBeNull()
  })

  it("D1 miss (unknown key) — falls through to the global-key compare and matches", async () => {
    const result = await resolveApiKey(reqWith(`Bearer ${GLOBAL_KEY}`), {
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
    })
    expect(result).toEqual({ installationId: LEGACY_TENANT_INSTALLATION_ID, createdBy: null })
  })

  it("D1 miss AND global-key mismatch — returns null", async () => {
    const result = await resolveApiKey(reqWith("Bearer totally-wrong"), {
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
    })
    expect(result).toBeNull()
  })

  it("a persisted revoked key never escapes through the global-key fallback", async () => {
    const plaintext = GLOBAL_KEY
    await insertApiKey(db, {
      id: "key-1",
      keyHash: await sha256Hex(plaintext),
      installationId: 9,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })
    await revokeApiKeyById(db, "key-1", "2026-02-01T00:00:00Z")

    const result = await resolveApiKey(reqWith(`Bearer ${plaintext}`), {
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
    })
    expect(result).toBeNull()
  })

  it.each([
    { installationId: -7, createdBy: "123" },
    { installationId: Number.MAX_SAFE_INTEGER + 1, createdBy: "123" },
    { installationId: 7, createdBy: "007" },
    { installationId: 7, createdBy: "not-a-github-id" },
  ])("denies a malformed persisted key identity without global fallback: %o", async ({ installationId, createdBy }) => {
    const keyHash = await sha256Hex(GLOBAL_KEY)
    await db
      .prepare("INSERT INTO api_key (id, key_hash, installation_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(`malformed-${installationId}-${createdBy}`, keyHash, installationId, createdBy, "2026-01-01T00:00:00Z")
      .run()

    await expect(
      resolveApiKey(reqWith(`Bearer ${GLOBAL_KEY}`), {
        SIGILIX_PLATFORM_DB: db,
        OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
      }),
    ).resolves.toBeNull()
  })

  it("FAILS CLOSED — a genuine D1 error during the lookup returns null and never falls through to the global key", async () => {
    const result = await resolveApiKey(reqWith(`Bearer ${GLOBAL_KEY}`), {
      SIGILIX_PLATFORM_DB: makeBrokenDb(),
      OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
    })
    // Even though the presented bearer IS the valid global key, a D1 fault
    // during the per-key lookup must short-circuit to null — proving the
    // resolver never reaches the legacy-compare branch on a DB error.
    expect(result).toBeNull()
  })

  it("D1 binding absent — skips the per-key lookup and uses the legacy global-key compare unchanged", async () => {
    const result = await resolveApiKey(reqWith(`Bearer ${GLOBAL_KEY}`), {
      OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
    })
    expect(result).toEqual({ installationId: LEGACY_TENANT_INSTALLATION_ID, createdBy: null })
  })

  it("D1 binding absent AND global key unset — returns null (matches today's unconfigured behavior)", async () => {
    const result = await resolveApiKey(reqWith(`Bearer ${GLOBAL_KEY}`), {})
    expect(result).toBeNull()
  })

  it("D1 hit — when a ctx is provided, the last_used_at touch is deferred via ctx.waitUntil", async () => {
    const plaintext = "sigilix_live_ctx"
    const keyHash = await sha256Hex(plaintext)
    await insertApiKey(db, { id: "key-1", keyHash, installationId: 5, createdBy: "1", nowIso: "2026-01-01T00:00:00Z" })

    const deferred: Promise<unknown>[] = []
    const ctx = { waitUntil: (p: Promise<unknown>) => deferred.push(p) } as unknown as ExecutionContext

    const result = await resolveApiKey(
      reqWith(`Bearer ${plaintext}`),
      {
        SIGILIX_PLATFORM_DB: db,
        OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
      },
      ctx,
    )
    expect(result).toEqual({ installationId: 5, createdBy: "1" })
    expect(deferred).toHaveLength(1)

    // The touch is deferred — drain the waitUntil promise(s) and confirm it ran.
    await Promise.all(deferred)
    const row = await db
      .prepare("SELECT last_used_at FROM api_key WHERE key_hash = ?")
      .bind(keyHash)
      .first<{ last_used_at: string | null }>()
    expect(row?.last_used_at).not.toBeNull()
  })
})

describe("requireApiTenant", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(API_KEY_MIGRATION_SQL)
  })

  it("the global key still resolves — dual-key transition, zero behavior change for existing callers", async () => {
    const auth = await requireApiTenant(reqWith(`Bearer ${GLOBAL_KEY}`), {
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
    })
    expect("caller" in auth && auth.caller).toEqual({ installationId: LEGACY_TENANT_INSTALLATION_ID, createdBy: null })
  })

  it("an issued per-installation key resolves its own installationId", async () => {
    const plaintext = "sigilix_live_requireapitenant"
    await insertApiKey(db, {
      id: "key-1",
      keyHash: await sha256Hex(plaintext),
      installationId: 4242,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })

    const auth = await requireApiTenant(reqWith(`Bearer ${plaintext}`), {
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
    })
    expect("caller" in auth && auth.caller).toEqual({ installationId: 4242, createdBy: "1" })
  })

  it("a revoked key returns the 401 unauthorized Response, never the caller", async () => {
    const plaintext = "sigilix_live_requireapitenant_revoked"
    await insertApiKey(db, {
      id: "key-1",
      keyHash: await sha256Hex(plaintext),
      installationId: 9,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })
    await revokeApiKeyById(db, "key-1", "2026-02-01T00:00:00Z")

    const auth = await requireApiTenant(reqWith(`Bearer ${plaintext}`), {
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
    })
    expect("response" in auth).toBe(true)
    if ("response" in auth) {
      expect(auth.response.status).toBe(401)
      expect(await auth.response.clone().json()).toEqual({ error: "unauthorized" })
    }
  })

  it("garbage/missing bearer returns the 401 unauthorized Response", async () => {
    const missing = await requireApiTenant(reqWith(), {
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
    })
    expect("response" in missing).toBe(true)
    if ("response" in missing) expect(missing.response.status).toBe(401)

    const garbage = await requireApiTenant(reqWith("Bearer totally-wrong"), {
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
    })
    expect("response" in garbage).toBe(true)
    if ("response" in garbage) expect(garbage.response.status).toBe(401)
  })

  it("FAILS CLOSED on a genuine D1 fault — 401, never falls through to the global key even though the bearer IS valid", async () => {
    const auth = await requireApiTenant(reqWith(`Bearer ${GLOBAL_KEY}`), {
      SIGILIX_PLATFORM_DB: makeBrokenDb(),
      OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
    })
    expect("response" in auth).toBe(true)
    if ("response" in auth) expect(auth.response.status).toBe(401)
  })
})
