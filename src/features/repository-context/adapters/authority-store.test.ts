import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import {
  abandonGitLabRepositoryAuthorityClaim,
  activateGitLabRepositoryAuthority,
  claimGitLabRepositoryAuthority,
  makeGitLabRepositoryExternalId,
  readGitLabRepositoryAuthority,
  releaseGitLabRepositoryAuthority,
  verifyActiveGitLabRepositoryAuthorityGeneration,
} from "@/src/features/repository-context"

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0026_create_repository_context_authority.sql", import.meta.url),
  "utf8",
)

function claimArgs(scopeId: string, sourceId = 5, instanceOrigin = "https://gitlab.com") {
  return { scopeId, instanceOrigin, sourceId, fullName: `group/project-${sourceId}` }
}

function differentToken(token: string): string {
  return `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`
}

describe("GitLab repository-context D1 authority", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("keeps pending claims invisible and makes activation generation-idempotent", async () => {
    const claimed = await claimGitLabRepositoryAuthority(db, claimArgs("user-a"))
    expect(claimed).toMatchObject({ status: "claimed" })
    if (claimed.status !== "claimed") throw new Error("expected authority claim")
    expect(claimed.claimToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    await expect(
      verifyActiveGitLabRepositoryAuthorityGeneration(db, {
        scopeId: "user-a",
        externalId: claimed.repository.externalId,
        claimToken: claimed.claimToken,
      }),
    ).resolves.toEqual({ status: "inactive" })

    await expect(readGitLabRepositoryAuthority(db, "user-a")).resolves.toEqual({
      status: "ok",
      revision: 0,
      repositories: [],
    })

    const activated = await activateGitLabRepositoryAuthority(db, {
      scopeId: "user-a",
      externalId: claimed.repository.externalId,
      claimToken: claimed.claimToken,
    })
    expect(activated).toMatchObject({ status: "activated", revision: 1 })
    await expect(
      verifyActiveGitLabRepositoryAuthorityGeneration(db, {
        scopeId: "user-a",
        externalId: claimed.repository.externalId,
        claimToken: claimed.claimToken,
      }),
    ).resolves.toEqual({ status: "active" })

    // A lost HTTP response after the first D1 commit must be safely retryable:
    // the same generation is already active and must not bump scope revision.
    await expect(
      activateGitLabRepositoryAuthority(db, {
        scopeId: "user-a",
        externalId: claimed.repository.externalId,
        claimToken: claimed.claimToken,
      }),
    ).resolves.toMatchObject({ status: "already_active_same_generation", revision: 1 })
  })

  it("serializes concurrent first claims and never lets two users own one issuer-qualified project", async () => {
    const [left, right] = await Promise.all([
      claimGitLabRepositoryAuthority(db, claimArgs("user-a")),
      claimGitLabRepositoryAuthority(db, claimArgs("user-b")),
    ])
    expect([left.status, right.status].sort()).toEqual(["claimed", "owned_by_other"])
  })

  it("isolates the same numeric project id on different GitLab instances", async () => {
    const dotComId = await makeGitLabRepositoryExternalId("https://gitlab.com", 5)
    const selfManagedId = await makeGitLabRepositoryExternalId("https://gitlab.example", 5)
    expect(dotComId).toMatch(/^gl:v1:[A-Za-z0-9_-]{43}$/)
    expect(selfManagedId).toMatch(/^gl:v1:[A-Za-z0-9_-]{43}$/)
    expect(dotComId).not.toBe(selfManagedId)

    const dotCom = await claimGitLabRepositoryAuthority(db, claimArgs("user-a", 5, "https://gitlab.com/"))
    const selfManaged = await claimGitLabRepositoryAuthority(db, claimArgs("user-b", 5, "https://GITLAB.example:443"))
    expect(dotCom.status).toBe("claimed")
    expect(selfManaged.status).toBe("claimed")
  })

  it("reclaims only an expired pending generation and rejects its late activation", async () => {
    const first = await claimGitLabRepositoryAuthority(db, claimArgs("user-a"))
    if (first.status !== "claimed") throw new Error("expected first claim")
    await db
      .prepare(
        "UPDATE repository_context_authority_repository" +
          " SET claim_expires_at = '2000-01-01T00:00:00.000Z' WHERE claim_token = ?",
      )
      .bind(first.claimToken)
      .run()

    const replacement = await claimGitLabRepositoryAuthority(db, claimArgs("user-b"))
    expect(replacement).toMatchObject({ status: "claimed" })
    if (replacement.status !== "claimed") throw new Error("expected replacement claim")
    expect(replacement.claimToken).not.toBe(first.claimToken)

    await expect(
      activateGitLabRepositoryAuthority(db, {
        scopeId: "user-a",
        externalId: first.repository.externalId,
        claimToken: first.claimToken,
      }),
    ).resolves.toEqual({ status: "lost_or_expired_claim" })
    await expect(
      activateGitLabRepositoryAuthority(db, {
        scopeId: "user-b",
        externalId: replacement.repository.externalId,
        claimToken: replacement.claimToken,
      }),
    ).resolves.toMatchObject({ status: "activated", revision: 1 })
  })

  it("abandons and releases only the exact generation", async () => {
    const pending = await claimGitLabRepositoryAuthority(db, claimArgs("user-a", 5))
    if (pending.status !== "claimed") throw new Error("expected pending claim")
    await expect(
      abandonGitLabRepositoryAuthorityClaim(db, {
        scopeId: "user-a",
        externalId: pending.repository.externalId,
        claimToken: differentToken(pending.claimToken),
      }),
    ).resolves.toEqual({ status: "lost_claim" })
    await expect(
      abandonGitLabRepositoryAuthorityClaim(db, {
        scopeId: "user-a",
        externalId: pending.repository.externalId,
        claimToken: pending.claimToken,
      }),
    ).resolves.toEqual({ status: "abandoned" })

    const active = await claimGitLabRepositoryAuthority(db, claimArgs("user-a", 6))
    if (active.status !== "claimed") throw new Error("expected active claim")
    await activateGitLabRepositoryAuthority(db, {
      scopeId: "user-a",
      externalId: active.repository.externalId,
      claimToken: active.claimToken,
    })
    await expect(
      releaseGitLabRepositoryAuthority(db, {
        scopeId: "user-a",
        externalId: active.repository.externalId,
        claimToken: differentToken(active.claimToken),
      }),
    ).resolves.toEqual({ status: "lost_claim" })
    await expect(readGitLabRepositoryAuthority(db, "user-a")).resolves.toMatchObject({
      status: "ok",
      revision: 1,
      repositories: [{ externalId: active.repository.externalId }],
    })
    await expect(
      releaseGitLabRepositoryAuthority(db, {
        scopeId: "user-a",
        externalId: active.repository.externalId,
        claimToken: active.claimToken,
      }),
    ).resolves.toMatchObject({ status: "released", revision: 2 })
    await expect(readGitLabRepositoryAuthority(db, "user-a")).resolves.toEqual({
      status: "ok",
      revision: 2,
      repositories: [],
    })
  })

  it("releases an exact persisted pending generation without changing the active-set revision", async () => {
    const pending = await claimGitLabRepositoryAuthority(db, claimArgs("user-a"))
    if (pending.status !== "claimed") throw new Error("expected pending claim")

    await expect(
      releaseGitLabRepositoryAuthority(db, {
        scopeId: "user-a",
        externalId: pending.repository.externalId,
        claimToken: pending.claimToken,
      }),
    ).resolves.toEqual({ status: "released", revision: 0 })
    await expect(readGitLabRepositoryAuthority(db, "user-a")).resolves.toEqual({
      status: "ok",
      revision: 0,
      repositories: [],
    })
    await expect(
      db
        .prepare(
          "SELECT state FROM repository_context_authority_repository" +
            " WHERE provider = 'gitlab' AND external_id = ? LIMIT 1",
        )
        .bind(pending.repository.externalId)
        .first(),
    ).resolves.toBeNull()

    await expect(
      releaseGitLabRepositoryAuthority(db, {
        scopeId: "user-a",
        externalId: pending.repository.externalId,
        claimToken: pending.claimToken,
      }),
    ).resolves.toEqual({ status: "already_released", revision: 0 })
  })

  it("rejects active-set row mutations that do not carry the scope transition", async () => {
    const claim = await claimGitLabRepositoryAuthority(db, claimArgs("user-a", 6))
    if (claim.status !== "claimed") throw new Error("expected authority claim")

    await expect(
      db
        .prepare(
          `UPDATE repository_context_authority_repository
              SET state = 'active', activated_at = '2026-07-15T00:00:00.000Z'
            WHERE provider = 'gitlab' AND external_id = ?`,
        )
        .bind(claim.repository.externalId)
        .run(),
    ).rejects.toThrow("authority activation requires scope transition")

    await expect(
      activateGitLabRepositoryAuthority(db, {
        scopeId: "user-a",
        externalId: claim.repository.externalId,
        claimToken: claim.claimToken,
      }),
    ).resolves.toMatchObject({ status: "activated", revision: 1 })
    await expect(
      db
        .prepare(
          "DELETE FROM repository_context_authority_repository" + " WHERE provider = 'gitlab' AND external_id = ?",
        )
        .bind(claim.repository.externalId)
        .run(),
    ).rejects.toThrow("active authority release requires scope transition")
    await expect(readGitLabRepositoryAuthority(db, "user-a")).resolves.toMatchObject({
      status: "ok",
      revision: 1,
      repositories: [{ externalId: claim.repository.externalId }],
    })
  })

  it("never activates or releases an active repository without revision capacity", async () => {
    const pending = await claimGitLabRepositoryAuthority(db, claimArgs("user-a", 7))
    if (pending.status !== "claimed") throw new Error("expected pending claim")
    await db
      .prepare(
        "UPDATE repository_context_authority_scope SET revision = ?" +
          " WHERE provider = 'gitlab' AND scope_id = 'user-a'",
      )
      .bind(Number.MAX_SAFE_INTEGER)
      .run()

    await expect(
      activateGitLabRepositoryAuthority(db, {
        scopeId: "user-a",
        externalId: pending.repository.externalId,
        claimToken: pending.claimToken,
      }),
    ).resolves.toEqual({ status: "unavailable" })
    await expect(
      db
        .prepare(
          "SELECT state FROM repository_context_authority_repository" +
            " WHERE provider = 'gitlab' AND external_id = ? LIMIT 1",
        )
        .bind(pending.repository.externalId)
        .first("state"),
    ).resolves.toBe("pending")

    const releaseDb = makeD1()
    await releaseDb.exec(MIGRATION_SQL)
    const active = await claimGitLabRepositoryAuthority(releaseDb, claimArgs("user-a", 8))
    if (active.status !== "claimed") throw new Error("expected active claim")
    await expect(
      activateGitLabRepositoryAuthority(releaseDb, {
        scopeId: "user-a",
        externalId: active.repository.externalId,
        claimToken: active.claimToken,
      }),
    ).resolves.toMatchObject({ status: "activated", revision: 1 })
    await releaseDb
      .prepare(
        "UPDATE repository_context_authority_scope SET revision = ?" +
          " WHERE provider = 'gitlab' AND scope_id = 'user-a'",
      )
      .bind(Number.MAX_SAFE_INTEGER)
      .run()
    await expect(
      releaseGitLabRepositoryAuthority(releaseDb, {
        scopeId: "user-a",
        externalId: active.repository.externalId,
        claimToken: active.claimToken,
      }),
    ).resolves.toEqual({ status: "unavailable" })
    await expect(
      releaseDb
        .prepare(
          "SELECT state FROM repository_context_authority_repository" +
            " WHERE provider = 'gitlab' AND external_id = ? LIMIT 1",
        )
        .bind(active.repository.externalId)
        .first("state"),
    ).resolves.toBe("active")
    await expect(readGitLabRepositoryAuthority(releaseDb, "user-a")).resolves.toMatchObject({
      status: "ok",
      revision: Number.MAX_SAFE_INTEGER,
      repositories: [{ externalId: active.repository.externalId }],
    })
  })
})
