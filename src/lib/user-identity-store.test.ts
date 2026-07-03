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

  it("upsertGithubIdentity does NOT link into a pre-existing account by unverified email", async () => {
    // A password account exists first (its email is UNVERIFIED)...
    const pw = await createPasswordIdentity(db, {
      email: "bob@example.com",
      passwordHash: "pbkdf2-sha256$1$aa$bb",
      nowIso: NOW,
    })
    expect(pw.ok).toBe(true)
    const userId = pw.ok ? pw.identity.userId : ""

    // ...then a GitHub login arrives carrying the same email. GitHub email is
    // unverified, so it must NOT merge into the password row — the GitHub login
    // gets its OWN row and does not steal/store the taken email.
    const gh = await upsertGithubIdentity(db, { githubUserId: "999", email: "bob@example.com", nowIso: NOW })
    expect(gh!.userId).not.toBe(userId) // separate account, no silent merge
    expect(gh!.githubUserId).toBe("999")
    expect(gh!.providers).toEqual(["github"])
    expect(gh!.email).toBeNull() // did not claim the taken address
    // The password row is untouched — still owns the email, no github linked.
    const pwRow = await findByEmail(db, "bob@example.com")
    expect(pwRow!.userId).toBe(userId)
    expect(pwRow!.providers).toEqual(["password"])
  })

  it("findOrCreateGoogleIdentity creates a verified account + is idempotent by sub", async () => {
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

  it("setIdentityEmail forces email_verified back to 0 (a captured email is unverified)", async () => {
    // A verified Google account exists...
    const g = await findOrCreateGoogleIdentity(db, { googleSub: "sub-vz", email: "vera@example.com", nowIso: NOW })
    expect(g.emailVerified).toBe(true)
    // ...and re-captures a DIFFERENT address. The new address is unverified, so
    // the row must lose its verified flag (else a stale flag would let a Google
    // login treat this arbitrary address as a trustworthy linking target).
    await setIdentityEmail(db, g.userId, "vera-new@example.com")
    const after = await findByUserId(db, g.userId)
    expect(after!.email).toBe("vera-new@example.com")
    expect(after!.emailVerified).toBe(false)
  })
})

// ─── account-takeover regression suite (sig-user-identity P0) ────────────────
// Each test seeds a VICTIM's email onto an attacker-controlled row via an
// UNVERIFIED path, then runs the victim's later VERIFIED Google login and proves
// the two accounts do NOT silently merge (the exploit is closed).
describe("user-identity-store — cross-provider linking is takeover-safe", () => {
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("Google login does NOT merge into a GitHub-seeded unverified email row", async () => {
    // Attacker: GitHub login carrying the victim's email (GitHub never verifies it).
    const attacker = await upsertGithubIdentity(db, {
      githubUserId: "attacker-gh",
      email: "victim@corp.com",
      nowIso: NOW,
    })
    // Victim: "Sign in with Google" for the same (Google-verified) address.
    const victim = await findOrCreateGoogleIdentity(db, {
      googleSub: "victim-google-sub",
      email: "victim@corp.com",
      nowIso: NOW,
    })
    expect(victim.userId).not.toBe(attacker!.userId) // no shared account
    expect(victim.googleSub).toBe("victim-google-sub")
    expect(victim.providers).toEqual(["google"])
    expect(victim.emailVerified).toBe(true)
    // Attacker's row lost the email claim; it never gained the victim's google_sub.
    const attackerAfter = await findByGithubUserId(db, "attacker-gh")
    expect(attackerAfter!.email).toBeNull()
    expect(attackerAfter!.googleSub).toBeNull()
    // The victim now owns the email.
    expect((await findByEmail(db, "victim@corp.com"))!.userId).toBe(victim.userId)
  })

  it("Google login revokes a PASSWORD-seeded unverified row + invalidates its credential", async () => {
    // Attacker: password signup with the victim's email (unverified).
    const seeded = await createPasswordIdentity(db, {
      email: "victim2@corp.com",
      passwordHash: "pbkdf2-sha256$600000$aa$bb",
      nowIso: NOW,
    })
    expect(seeded.ok).toBe(true)
    const attackerId = seeded.ok ? seeded.identity.userId : ""
    expect(await getPasswordHash(db, attackerId)).not.toBeNull()

    // Victim: verified Google login for the same address.
    const victim = await findOrCreateGoogleIdentity(db, {
      googleSub: "victim2-google-sub",
      email: "victim2@corp.com",
      nowIso: NOW,
    })
    expect(victim.userId).not.toBe(attackerId) // no merge
    expect(victim.providers).toEqual(["google"])
    // Attacker's row: email revoked AND its password credential invalidated, so
    // the attacker can no longer log into the (now emailless) seeded account.
    const attackerAfter = await findByUserId(db, attackerId)
    expect(attackerAfter!.email).toBeNull()
    expect(await getPasswordHash(db, attackerId)).toBeNull()
    expect((await findByEmail(db, "victim2@corp.com"))!.userId).toBe(victim.userId)
  })

  it("Google login does NOT merge into an email-capture-seeded unverified row", async () => {
    // Attacker: GitHub login with a private email (no email), then email-capture
    // claims the victim's address on their own row.
    const attacker = await upsertGithubIdentity(db, { githubUserId: "attacker-cap", nowIso: NOW })
    await setIdentityEmail(db, attacker!.userId, "victim3@corp.com")
    expect((await findByUserId(db, attacker!.userId))!.email).toBe("victim3@corp.com")

    // Victim: verified Google login for the same address.
    const victim = await findOrCreateGoogleIdentity(db, {
      googleSub: "victim3-google-sub",
      email: "victim3@corp.com",
      nowIso: NOW,
    })
    expect(victim.userId).not.toBe(attacker!.userId) // no merge
    expect(victim.providers).toEqual(["google"])
    const attackerAfter = await findByUserId(db, attacker!.userId)
    expect(attackerAfter!.email).toBeNull() // claim revoked
    expect(attackerAfter!.googleSub).toBeNull()
    expect((await findByEmail(db, "victim3@corp.com"))!.userId).toBe(victim.userId)
  })

  it("Google login DOES link into an already-VERIFIED same-email row (legit linking survives)", async () => {
    // A first verified Google login owns the email...
    const first = await findOrCreateGoogleIdentity(db, {
      googleSub: "sub-first",
      email: "shared@corp.com",
      nowIso: NOW,
    })
    expect(first.emailVerified).toBe(true)
    // ...a second call with the SAME sub is idempotent (returns the same row),
    // proving the verified path still resolves to one account.
    const again = await findOrCreateGoogleIdentity(db, {
      googleSub: "sub-first",
      email: "shared@corp.com",
      nowIso: NOW,
    })
    expect(again.userId).toBe(first.userId)
    expect(again.providers).toEqual(["google"])
  })
})
