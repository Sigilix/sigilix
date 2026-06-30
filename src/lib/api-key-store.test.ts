// #155 onboarding-backend FOUNDATION (slice 1 of 2) — api-key-store unit tests.
// Real SQLite via the d1-sqlite-shim, schema from migrations/0003_*.sql.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import {
  getApiKeyById,
  insertApiKey,
  isLinkedToInstallation,
  linkAccountTenant,
  mintApiKeyPlaintext,
  revokeApiKeyById,
  touchApiKeyLastUsed,
} from "@/src/lib/api-key-store"
import { sha256Hex } from "@/src/lib/auth-bearer"

const MIGRATION_SQL = readFileSync(
  new URL("../../migrations/0003_create_account_tenant_and_api_key.sql", import.meta.url),
  "utf8",
)

/** Throws on any operation — simulates a genuine D1 error. */
function makeBrokenDb(): D1Database {
  return {
    prepare() {
      throw new Error("simulated D1 error")
    },
  } as unknown as D1Database
}

describe("mintApiKeyPlaintext", () => {
  it("is prefixed sigilix_live_ and is not predictable", () => {
    const a = mintApiKeyPlaintext()
    const b = mintApiKeyPlaintext()
    expect(a).toMatch(/^sigilix_live_[A-Za-z0-9_-]+$/)
    expect(a).not.toBe(b)
  })
})

describe("insertApiKey + getApiKeyById", () => {
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("round-trips a freshly minted key — never stores plaintext", async () => {
    const plaintext = mintApiKeyPlaintext()
    const keyHash = await sha256Hex(plaintext)
    await insertApiKey(db, {
      id: "key-1",
      keyHash,
      installationId: 42,
      createdBy: "123",
      nowIso: "2026-01-01T00:00:00Z",
    })

    const row = await db.prepare("SELECT * FROM api_key WHERE id = ?").bind("key-1").first<Record<string, unknown>>()
    expect(row?.key_hash).toBe(keyHash)
    expect(row?.installation_id).toBe(42)
    // Confirm the plaintext itself was never persisted anywhere in the row.
    expect(JSON.stringify(row)).not.toContain(plaintext)

    const found = await getApiKeyById(db, "key-1")
    expect(found).toEqual({ installationId: 42, revokedAt: null })
  })

  it("getApiKeyById returns null for an unknown id", async () => {
    expect(await getApiKeyById(db, "nope")).toBeNull()
  })

  it("getApiKeyById returns null (not throw) on a D1 error", async () => {
    await expect(getApiKeyById(makeBrokenDb(), "key-1")).resolves.toBeNull()
  })
})

describe("revokeApiKeyById", () => {
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
    await insertApiKey(db, {
      id: "key-1",
      keyHash: await sha256Hex("x"),
      installationId: 7,
      createdBy: "123",
      nowIso: "2026-01-01T00:00:00Z",
    })
  })

  it("sets revoked_at", async () => {
    await revokeApiKeyById(db, "key-1", "2026-02-01T00:00:00Z")
    const found = await getApiKeyById(db, "key-1")
    expect(found?.revokedAt).toBe("2026-02-01T00:00:00Z")
  })
})

describe("touchApiKeyLastUsed", () => {
  it("updates last_used_at for the matching key_hash", async () => {
    const db = makeD1()
    await db.exec(MIGRATION_SQL)
    const keyHash = await sha256Hex("touch-me")
    await insertApiKey(db, { id: "key-1", keyHash, installationId: 1, createdBy: "1", nowIso: "2026-01-01T00:00:00Z" })

    await touchApiKeyLastUsed(db, keyHash, "2026-03-01T00:00:00Z")

    const row = await db
      .prepare("SELECT last_used_at FROM api_key WHERE key_hash = ?")
      .bind(keyHash)
      .first<{ last_used_at: string }>()
    expect(row?.last_used_at).toBe("2026-03-01T00:00:00Z")
  })
})

describe("linkAccountTenant + isLinkedToInstallation", () => {
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("links a user to an installation; isLinkedToInstallation returns true", async () => {
    await linkAccountTenant(db, {
      githubUserId: "123",
      installationId: 42,
      role: "owner",
      nowIso: "2026-01-01T00:00:00Z",
    })
    expect(await isLinkedToInstallation(db, "123", 42)).toBe(true)
  })

  it("returns false for an unlinked user/installation pair", async () => {
    expect(await isLinkedToInstallation(db, "999", 42)).toBe(false)
  })

  it("is idempotent — re-linking the same pair does not throw (ON CONFLICT DO NOTHING)", async () => {
    await linkAccountTenant(db, {
      githubUserId: "123",
      installationId: 42,
      role: "owner",
      nowIso: "2026-01-01T00:00:00Z",
    })
    await expect(
      linkAccountTenant(db, { githubUserId: "123", installationId: 42, role: "owner", nowIso: "2026-06-01T00:00:00Z" }),
    ).resolves.toBeUndefined()
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM account_tenant").first<{ n: number }>()
    expect(rows?.n).toBe(1)
  })

  it("isLinkedToInstallation FAILS CLOSED (returns false, never throws) on a D1 error", async () => {
    await expect(isLinkedToInstallation(makeBrokenDb(), "123", 42)).resolves.toBe(false)
  })
})
