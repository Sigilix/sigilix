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

  it("password-first then Google on the same email: BOTH accounts survive, nothing is destroyed", async () => {
    // Honest user signs up with email/password FIRST (its email is UNVERIFIED).
    const pw = await createPasswordIdentity(db, {
      email: "dana@example.com",
      passwordHash: "pbkdf2-sha256$600000$aa$bb",
      nowIso: NOW,
    })
    expect(pw.ok).toBe(true)
    const pwUserId = pw.ok ? pw.identity.userId : ""

    // Later they click "Sign in with Google" on the SAME address. Cross-provider
    // linking is DEFERRED (not destructive): a SEPARATE Google account is created
    // with email=NULL; the password account is left completely intact.
    const g = await findOrCreateGoogleIdentity(db, {
      googleSub: "dana-google-sub",
      email: "dana@example.com",
      nowIso: NOW,
    })
    expect(g.userId).not.toBe(pwUserId) // separate account, no silent merge
    expect(g.providers).toEqual(["google"])
    expect(g.emailVerified).toBe(true)
    expect(g.email).toBeNull() // deferred — the Google row resolves by google_sub

    // The password account is fully intact: same userId, still owns the email,
    // and its password credential was NOT deleted (the user can still log in).
    const pwAfter = await findByUserId(db, pwUserId)
    expect(pwAfter!.email).toBe("dana@example.com")
    expect(pwAfter!.providers).toEqual(["password"])
    expect(await getPasswordHash(db, pwUserId)).toBe("pbkdf2-sha256$600000$aa$bb")
    // The email still resolves to the (surviving) password account.
    expect((await findByEmail(db, "dana@example.com"))!.userId).toBe(pwUserId)
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

  it("a returning Google login does NOT stamp a DIFFERENT captured (unverified) email as verified", async () => {
    // Google login owns its address (verified)...
    const g = await findOrCreateGoogleIdentity(db, { googleSub: "sub-gv", email: "gv@example.com", nowIso: NOW })
    expect(g.emailVerified).toBe(true)
    // ...then the row captures a DIFFERENT address (unverified — forces verified=0).
    await setIdentityEmail(db, g.userId, "gv-alt@example.com")
    const mid = await findByUserId(db, g.userId)
    expect(mid!.email).toBe("gv-alt@example.com")
    expect(mid!.emailVerified).toBe(false)
    // The SAME Google sub logs in again (Google returns its own address). The row
    // keeps the captured address, and its verified flag must stay 0 — Google
    // verified gv@example.com, NOT gv-alt@example.com; stamping the captured
    // address verified would make it a cross-provider linking target (takeover).
    const again = await findOrCreateGoogleIdentity(db, { googleSub: "sub-gv", email: "gv@example.com", nowIso: NOW })
    expect(again.userId).toBe(g.userId)
    expect(again.email).toBe("gv-alt@example.com") // captured address retained
    expect(again.emailVerified).toBe(false) // NOT re-stamped verified
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
// the two accounts do NOT silently merge (the P0 exploit stays closed). Linking
// is deferred NON-DESTRUCTIVELY: the pre-existing row keeps its email + password
// credential, and the Google login gets its own separate row (email=NULL) — no
// account is revoked or orphaned (the P1 footgun that destroyed an honest
// password-first user's credential is gone).
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
    expect(victim.email).toBeNull() // deferred — the Google row resolves by google_sub
    // Non-destructive: the attacker's row is untouched (keeps its seeded email)
    // and, crucially, never gained the victim's google_sub — so it cannot resolve
    // the victim's Google login (no takeover).
    const attackerAfter = await findByGithubUserId(db, "attacker-gh")
    expect(attackerAfter!.email).toBe("victim@corp.com")
    expect(attackerAfter!.googleSub).toBeNull()
  })

  it("Google login does NOT merge into (or destroy) a PASSWORD-seeded unverified row", async () => {
    // A password account already holds this email (unverified). NB: from the
    // store's view this is indistinguishable from an HONEST password-first user —
    // which is exactly why the fix must be non-destructive (see the P1 footgun).
    const seeded = await createPasswordIdentity(db, {
      email: "victim2@corp.com",
      passwordHash: "pbkdf2-sha256$600000$aa$bb",
      nowIso: NOW,
    })
    expect(seeded.ok).toBe(true)
    const seededId = seeded.ok ? seeded.identity.userId : ""
    expect(await getPasswordHash(db, seededId)).not.toBeNull()

    // A verified Google login arrives for the same address.
    const victim = await findOrCreateGoogleIdentity(db, {
      googleSub: "victim2-google-sub",
      email: "victim2@corp.com",
      nowIso: NOW,
    })
    expect(victim.userId).not.toBe(seededId) // no merge — separate Google account
    expect(victim.providers).toEqual(["google"])
    expect(victim.email).toBeNull() // deferred — Google row resolves by google_sub
    // Non-destructive: the pre-existing row keeps its email AND its password
    // credential (the P0 no-merge holds without destroying anyone's account).
    const seededAfter = await findByUserId(db, seededId)
    expect(seededAfter!.email).toBe("victim2@corp.com")
    expect(await getPasswordHash(db, seededId)).not.toBeNull()
    expect((await findByEmail(db, "victim2@corp.com"))!.userId).toBe(seededId)
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
    expect(victim.email).toBeNull() // deferred — Google row resolves by google_sub
    // Non-destructive: the attacker's row keeps its captured email and never
    // gains the victim's google_sub, so it can't resolve the Google login.
    const attackerAfter = await findByUserId(db, attacker!.userId)
    expect(attackerAfter!.email).toBe("victim3@corp.com")
    expect(attackerAfter!.googleSub).toBeNull()
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

  it("Google login LINKS into a VERIFIED same-email row that has no rival Google link (legit linking survives, non-destructively)", async () => {
    // A password account exists, and a (future) email-verification flow marked its
    // email verified — a verified row with NO google_sub yet.
    const pw = await createPasswordIdentity(db, {
      email: "linkme@corp.com",
      passwordHash: "pbkdf2-sha256$600000$aa$bb",
      nowIso: NOW,
    })
    const uid = pw.ok ? pw.identity.userId : ""
    await db.prepare("UPDATE user_identity SET email_verified = 1 WHERE user_id = ?").bind(uid).run()

    // Google login for the same, now-verified address → LINKS into the SAME
    // account (sets google_sub, adds "google"), non-destructively.
    const linked = await findOrCreateGoogleIdentity(db, {
      googleSub: "sub-link",
      email: "linkme@corp.com",
      nowIso: NOW,
    })
    expect(linked.userId).toBe(uid) // linked, not a new account
    expect(linked.googleSub).toBe("sub-link")
    expect(linked.providers).toEqual(["password", "google"])
    expect(linked.email).toBe("linkme@corp.com")
    expect(await getPasswordHash(db, uid)).not.toBeNull() // credential intact
  })

  it("two distinct Google subs on the same VERIFIED email: the second gets a NEW account, not a silent login", async () => {
    // First Google login owns the verified email (google_sub = sub-A).
    const first = await findOrCreateGoogleIdentity(db, {
      googleSub: "sub-A",
      email: "twins@corp.com",
      nowIso: NOW,
    })
    expect(first.googleSub).toBe("sub-A")

    // A DIFFERENT Google sub presents the SAME verified email. The old
    // `google_sub = COALESCE(google_sub, ?)` would have silently logged sub-B into
    // sub-A's account; a differing existing google_sub is now a CONFLICT → a new,
    // separate account (email=NULL), never a silent takeover.
    const second = await findOrCreateGoogleIdentity(db, {
      googleSub: "sub-B",
      email: "twins@corp.com",
      nowIso: NOW,
    })
    expect(second.userId).not.toBe(first.userId) // new account
    expect(second.googleSub).toBe("sub-B")
    expect(second.email).toBeNull() // deferred — email stays with the first row

    // The first account is untouched: still owns sub-A and the email.
    const firstAfter = await findByUserId(db, first.userId)
    expect(firstAfter!.googleSub).toBe("sub-A")
    expect(firstAfter!.email).toBe("twins@corp.com")
  })
})
