// user-identity-store: the persistence + account-linking core. Uses the real
// SQLite D1 shim with migrations/0006 applied.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import {
  createPasswordIdentity,
  findByEmail,
  findByGithubUserId,
  findByUserId,
  findOrCreateGoogleIdentity,
  getPasswordHash,
  setIdentityEmail,
  upsertGithubIdentity,
} from "@/src/lib/user-identity-store"

const MIGRATION_SQL = readFileSync(new URL("../../migrations/0006_create_user_identity.sql", import.meta.url), "utf8")
const NOW = "2026-07-02T00:00:00.000Z"

describe("user-identity-store", () => {
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("upsertGithubIdentity inserts a new row on first login, then updates on the second", async () => {
    const first = await upsertGithubIdentity(db, {
      githubUserId: "12345",
      email: "Alice@Example.com",
      name: "Alice",
      avatarUrl: "https://avatars/1",
      nowIso: NOW,
    })
    expect(first).not.toBeNull()
    expect(first!.githubUserId).toBe("12345")
    expect(first!.email).toBe("alice@example.com") // normalized lowercase
    expect(first!.providers).toEqual(["github"])

    const second = await upsertGithubIdentity(db, {
      githubUserId: "12345",
      name: "Alice Cooper",
      avatarUrl: "https://avatars/2",
      nowIso: "2026-07-03T00:00:00.000Z",
    })
    expect(second!.userId).toBe(first!.userId) // same row, no duplicate
    expect(second!.name).toBe("Alice Cooper")
    expect(second!.lastLoginAt).toBe("2026-07-03T00:00:00.000Z")
  })

  it("upsertGithubIdentity LINKS to a pre-existing account with the same email", async () => {
    // A password account exists first...
    const pw = await createPasswordIdentity(db, {
      email: "bob@example.com",
      passwordHash: "pbkdf2-sha256$1$aa$bb",
      nowIso: NOW,
    })
    expect(pw.ok).toBe(true)
    const userId = pw.ok ? pw.identity.userId : ""

    // ...then a GitHub login arrives carrying the same email → same row, providers merged.
    const gh = await upsertGithubIdentity(db, { githubUserId: "999", email: "bob@example.com", nowIso: NOW })
    expect(gh!.userId).toBe(userId)
    expect(gh!.githubUserId).toBe("999")
    expect(gh!.providers.sort()).toEqual(["github", "password"])
  })

  it("findOrCreateGoogleIdentity creates a verified account, then links by email + is idempotent by sub", async () => {
    const created = await findOrCreateGoogleIdentity(db, {
      googleSub: "sub-abc",
      email: "carol@example.com",
      name: "Carol",
      nowIso: NOW,
    })
    expect(created.emailVerified).toBe(true)
    expect(created.providers).toEqual(["google"])

    // Same sub again → same row (idempotent).
    const again = await findOrCreateGoogleIdentity(db, {
      googleSub: "sub-abc",
      email: "carol@example.com",
      nowIso: NOW,
    })
    expect(again.userId).toBe(created.userId)

    // A GitHub account with the same email as a NEW google login → linked to one row.
    await upsertGithubIdentity(db, { githubUserId: "77", email: "dave@example.com", nowIso: NOW })
    const linked = await findOrCreateGoogleIdentity(db, {
      googleSub: "sub-dave",
      email: "dave@example.com",
      nowIso: NOW,
    })
    const byGithub = await findByGithubUserId(db, "77")
    expect(linked.userId).toBe(byGithub!.userId) // account-linking-by-email across providers
    expect(linked.providers.sort()).toEqual(["github", "google"])
  })

  it("createPasswordIdentity rejects a duplicate email (email_taken) — no silent password attach", async () => {
    await findOrCreateGoogleIdentity(db, { googleSub: "sub-e", email: "erin@example.com", nowIso: NOW })
    const dup = await createPasswordIdentity(db, {
      email: "erin@example.com",
      passwordHash: "pbkdf2-sha256$1$aa$bb",
      nowIso: NOW,
    })
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.reason).toBe("email_taken")
  })

  it("createPasswordIdentity writes a matching credential row", async () => {
    const res = await createPasswordIdentity(db, {
      email: "frank@example.com",
      passwordHash: "pbkdf2-sha256$210000$aa$bb",
      nowIso: NOW,
    })
    expect(res.ok).toBe(true)
    const userId = res.ok ? res.identity.userId : ""
    expect(await getPasswordHash(db, userId)).toBe("pbkdf2-sha256$210000$aa$bb")
  })

  it("keeps accounts isolated: a lookup only returns the matching row (tenant isolation)", async () => {
    const a = await upsertGithubIdentity(db, { githubUserId: "100", email: "a@x.com", nowIso: NOW })
    const b = await upsertGithubIdentity(db, { githubUserId: "200", email: "b@x.com", nowIso: NOW })
    expect(a!.userId).not.toBe(b!.userId)
    expect((await findByEmail(db, "a@x.com"))!.userId).toBe(a!.userId)
    expect((await findByEmail(db, "b@x.com"))!.userId).toBe(b!.userId)
    // A wrong-account credential read never leaks another user's hash.
    expect(await getPasswordHash(db, a!.userId)).toBeNull()
  })

  it("setIdentityEmail persists a captured email; a duplicate hits the UNIQUE index", async () => {
    const gh = await upsertGithubIdentity(db, { githubUserId: "300", nowIso: NOW }) // no email (private)
    expect(gh!.email).toBeNull()
    await setIdentityEmail(db, gh!.userId, "grace@example.com")
    expect((await findByUserId(db, gh!.userId))!.email).toBe("grace@example.com")

    // Another account already owns an email → the UNIQUE index rejects it.
    await upsertGithubIdentity(db, { githubUserId: "400", email: "taken@example.com", nowIso: NOW })
    await expect(setIdentityEmail(db, gh!.userId, "taken@example.com")).rejects.toThrow()
  })
})
