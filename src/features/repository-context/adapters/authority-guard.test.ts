import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import {
  activateGitLabRepositoryAuthority,
  claimGitLabRepositoryAuthority,
  readRepositoryContext,
  releaseGitLabRepositoryAuthority,
  replaceRepositoryContext,
} from "@/src/features/repository-context"

const CONTEXT_MIGRATION = readFileSync(
  new URL("../../../../migrations/0024_create_repository_context.sql", import.meta.url),
  "utf8",
)
const AUTHORITY_MIGRATION = readFileSync(
  new URL("../../../../migrations/0026_create_repository_context_authority.sql", import.meta.url),
  "utf8",
)

describe("repository-context strong authority guard", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(CONTEXT_MIGRATION)
    await db.exec(AUTHORITY_MIGRATION)
  })

  it("accepts the logical empty revision-zero authority set before a scope row exists", async () => {
    const result = await replaceRepositoryContext(db, {
      provider: "gitlab",
      scopeId: "user-empty",
      expectedRevision: 0,
      repositories: [],
      relationships: [],
      conventions: "",
      nowIso: "2026-07-14T12:00:00.000Z",
      updatedBy: "gitlab:user-empty",
      authorityGuard: { revision: 0, externalIds: [] },
    })

    expect(result).toMatchObject({ status: "updated", snapshot: { revision: 1, repositories: [] } })
  })

  it("guards the maximum active set without exceeding D1's per-statement bind limit", async () => {
    const scopeId = "user-max"
    const now = "2026-07-14T12:00:00.000Z"
    const repositories = Array.from({ length: 100 }, (_, index) => {
      const suffix = index.toString(36).padStart(43, "A")
      return {
        externalId: `gl:v1:${suffix}`,
        fullName: `group/project-${index}`,
        context: `Project ${index}`,
        position: index,
      }
    })
    await db
      .prepare(
        `INSERT INTO repository_context_authority_scope
          (provider, scope_id, revision, created_at, updated_at)
         VALUES ('gitlab', ?, 100, ?, ?)`,
      )
      .bind(scopeId, now, now)
      .run()
    await db.batch(
      repositories.map((repository, index) =>
        db
          .prepare(
            `INSERT INTO repository_context_authority_repository
              (provider, scope_id, instance_origin, source_id, external_id, full_name,
               state, claim_token, claimed_at, claim_expires_at, activated_at)
             VALUES ('gitlab', ?, 'https://gitlab.com', ?, ?, ?, 'active', ?, ?, ?, ?)`,
          )
          .bind(
            scopeId,
            index + 1,
            repository.externalId,
            repository.fullName,
            index.toString(36).padStart(43, "B"),
            now,
            now,
            now,
          ),
      ),
    )

    const bindCounts: number[] = []
    const trackedDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql)
            return new Proxy(statement, {
              get(statementTarget, statementProperty, statementReceiver) {
                if (statementProperty === "bind") {
                  return (...values: unknown[]) => {
                    bindCounts.push(values.length)
                    return statementTarget.bind(...values)
                  }
                }
                return Reflect.get(statementTarget, statementProperty, statementReceiver)
              },
            })
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === "function" ? value.bind(target) : value
      },
    }) as D1Database

    const first = await replaceRepositoryContext(trackedDb, {
      provider: "gitlab",
      scopeId,
      expectedRevision: 0,
      repositories,
      relationships: [],
      conventions: "",
      nowIso: now,
      updatedBy: `gitlab:${scopeId}`,
      authorityGuard: { revision: 100, externalIds: repositories.map((repository) => repository.externalId) },
    })
    expect(first).toMatchObject({ status: "updated", snapshot: { revision: 1 } })
    expect(Math.max(...bindCounts)).toBeLessThanOrEqual(100)

    const stale = await replaceRepositoryContext(trackedDb, {
      provider: "gitlab",
      scopeId,
      expectedRevision: 1,
      repositories,
      relationships: [],
      conventions: "must not commit",
      nowIso: "2026-07-14T12:01:00.000Z",
      updatedBy: `gitlab:${scopeId}`,
      authorityGuard: { revision: 99, externalIds: repositories.map((repository) => repository.externalId) },
    })
    expect(stale).toEqual({ status: "scope_changed" })
  })

  it("linearizes the exact active-set check inside the replacement batch", async () => {
    const scopeId = "user-a"
    const claim = await claimGitLabRepositoryAuthority(db, {
      scopeId,
      instanceOrigin: "https://gitlab.com",
      sourceId: 5,
      fullName: "grp/api",
    })
    if (claim.status !== "claimed") throw new Error("expected authority claim")
    await expect(
      activateGitLabRepositoryAuthority(db, {
        scopeId,
        externalId: claim.repository.externalId,
        claimToken: claim.claimToken,
      }),
    ).resolves.toMatchObject({ status: "activated", revision: 1 })

    const first = await replaceRepositoryContext(db, {
      provider: "gitlab",
      scopeId,
      expectedRevision: 0,
      repositories: [{ ...claim.repository, context: "Public API", position: 0 }],
      relationships: [],
      conventions: "",
      nowIso: "2026-07-14T12:00:00.000Z",
      updatedBy: `gitlab:${scopeId}`,
      authorityGuard: { revision: 1, externalIds: [claim.repository.externalId] },
    })
    expect(first).toMatchObject({ status: "updated", snapshot: { revision: 1 } })

    await expect(
      releaseGitLabRepositoryAuthority(db, {
        scopeId,
        externalId: claim.repository.externalId,
        claimToken: claim.claimToken,
      }),
    ).resolves.toMatchObject({ status: "released", revision: 2 })

    const stale = await replaceRepositoryContext(db, {
      provider: "gitlab",
      scopeId,
      expectedRevision: 1,
      repositories: [{ ...claim.repository, context: "must not commit", position: 0 }],
      relationships: [],
      conventions: "changed",
      nowIso: "2026-07-14T12:01:00.000Z",
      updatedBy: `gitlab:${scopeId}`,
      authorityGuard: { revision: 1, externalIds: [claim.repository.externalId] },
    })
    expect(stale).toEqual({ status: "scope_changed" })
    await expect(readRepositoryContext(db, "gitlab", scopeId)).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 1, conventions: "", repositories: [{ context: "Public API" }] },
    })
  })
})
