import { beforeEach, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { purgeRepositoryContext, readRepositoryContext, replaceRepositoryContext } from "./d1-store"
import type {
  ReplaceRepositoryContextArgs,
  RepositoryContextRelationship,
  RepositoryContextRepository,
} from "@/src/features/repository-context/domain/types"

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0024_create_repository_context.sql", import.meta.url),
  "utf8",
)
const NOW = "2026-07-13T20:00:00.000Z"

function repository(
  externalId: string,
  fullName: string,
  context: string,
  position: number,
): RepositoryContextRepository {
  return { externalId, fullName, context, position }
}

function relationship(
  fromExternalId: string,
  toExternalId: string,
  label: string,
  position: number,
): RepositoryContextRelationship {
  return { fromExternalId, toExternalId, label, normalizedLabel: label.toLowerCase(), position }
}

function args(overrides: Partial<ReplaceRepositoryContextArgs> = {}): ReplaceRepositoryContextArgs {
  return {
    provider: "github",
    scopeId: "42",
    expectedRevision: 0,
    repositories: [
      repository("101", "acme/api", "Public API", 0),
      repository("202", "acme/worker", "Background jobs", 1),
    ],
    relationships: [relationship("101", "202", "publishes jobs", 0)],
    conventions: "Use conventional commits.",
    nowIso: NOW,
    updatedBy: "github:111",
    ...overrides,
  }
}

describe("D1 repository-context store and schema", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("round-trips one normalized snapshot and writes content-free immutable audit metadata", async () => {
    const result = await replaceRepositoryContext(db, args())
    expect(result).toMatchObject({
      status: "updated",
      snapshot: {
        provider: "github",
        scopeId: "42",
        revision: 1,
        repositories: args().repositories,
        relationships: args().relationships,
        conventions: "Use conventional commits.",
        deletedAt: null,
      },
    })
    const read = await readRepositoryContext(db, "github", "42")
    expect(read).toEqual(result.status === "updated" ? { status: "ok", snapshot: result.snapshot } : read)

    const scope = await db
      .prepare(
        "SELECT write_token, snapshot_format, snapshot_sha256" +
          " FROM repository_context_scope WHERE provider = ? AND scope_id = ?",
      )
      .bind("github", "42")
      .first<{ write_token: string; snapshot_format: number; snapshot_sha256: string }>()
    expect(scope?.write_token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(scope?.snapshot_format).toBe(1)
    expect(scope?.snapshot_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(result)).not.toContain(scope?.write_token)

    const audit = await db
      .prepare(
        "SELECT action, previous_revision, next_revision, previous_snapshot_format, next_snapshot_format," +
          " previous_repo_count, next_repo_count," +
          " previous_relationship_count, next_relationship_count, actor_id" +
          " FROM repository_context_audit WHERE provider = ? AND scope_id = ?",
      )
      .bind("github", "42")
      .first<Record<string, unknown>>()
    expect(audit).toEqual({
      action: "replaced",
      previous_revision: null,
      next_revision: 1,
      previous_snapshot_format: null,
      next_snapshot_format: 1,
      previous_repo_count: null,
      next_repo_count: 2,
      previous_relationship_count: null,
      next_relationship_count: 1,
      actor_id: "github:111",
    })
    const auditColumns = await db.prepare("PRAGMA table_info(repository_context_audit)").all<{ name: string }>()
    expect(auditColumns.results.map((column) => column.name)).not.toEqual(
      expect.arrayContaining(["conventions", "context", "label", "full_name", "write_token"]),
    )
    await expect(db.prepare("UPDATE repository_context_audit SET actor_id = 'forged'").run()).rejects.toThrow(
      /immutable/i,
    )
    await expect(
      db.prepare("DELETE FROM repository_context_audit WHERE provider = 'github' AND scope_id = '42'").run(),
    ).rejects.toThrow(/immutable/i)
    await expect(
      db.prepare("DELETE FROM repository_context_scope WHERE provider = 'github' AND scope_id = '42'").run(),
    ).rejects.toThrow(/tombstoned/i)
  })

  it("returns conflict for every stale CAS, including an identical payload, and never creates absent nonzero revisions", async () => {
    expect(await replaceRepositoryContext(db, args({ expectedRevision: 4 }))).toEqual({
      status: "conflict",
      currentRevision: 0,
    })
    expect(await readRepositoryContext(db, "github", "42")).toEqual({ status: "not_found" })

    expect((await replaceRepositoryContext(db, args())).status).toBe("updated")
    expect(await replaceRepositoryContext(db, args())).toEqual({ status: "conflict", currentRevision: 1 })
    await expect(
      db.prepare("SELECT COUNT(*) AS n FROM repository_context_audit").first<{ n: number }>(),
    ).resolves.toEqual({ n: 1 })
  })

  it("enforces revision one for every newly inserted scope at the schema boundary", async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO repository_context_scope
            (provider, scope_id, revision, snapshot_format, conventions, snapshot_sha256, repo_count,
             relationship_count, write_token, created_at, updated_at, updated_by,
             last_action, last_audit_id, deleted_at)
           VALUES ('github', '77', 2, 1, '', ?, 0, 0, ?, ?, ?, 'system:test', 'replaced', 'audit-77', NULL)`,
        )
        .bind("a".repeat(64), "A".repeat(43), NOW, NOW)
        .run(),
    ).rejects.toThrow(/initial revision must be one/i)
    await expect(
      db.prepare("SELECT COUNT(*) AS n FROM repository_context_scope WHERE scope_id = '77'").first<{ n: number }>(),
    ).resolves.toEqual({ n: 0 })
  })

  it("serializes concurrent writers at one revision so one complete snapshot wins", async () => {
    const first = args({ conventions: "winner A" })
    const second = args({ conventions: "winner B" })
    const results = await Promise.all([replaceRepositoryContext(db, first), replaceRepositoryContext(db, second)])
    expect(results.filter((result) => result.status === "updated")).toHaveLength(1)
    expect(results.filter((result) => result.status === "conflict")).toHaveLength(1)
    const read = await readRepositoryContext(db, "github", "42")
    expect(read.status).toBe("ok")
    if (read.status === "ok") expect(["winner A", "winner B"]).toContain(read.snapshot.conventions)
    await expect(
      db.prepare("SELECT COUNT(*) AS n FROM repository_context_audit").first<{ n: number }>(),
    ).resolves.toEqual({ n: 1 })
  })

  it("rolls a winning scope CAS and every child mutation back when the final trigger guard sees a count mismatch", async () => {
    expect((await replaceRepositoryContext(db, args())).status).toBe("updated")
    const before = await readRepositoryContext(db, "github", "42")
    const token = "B".repeat(43)
    const badBatch = [
      db
        .prepare(
          `UPDATE repository_context_scope
              SET revision = 2, conventions = 'bad', snapshot_sha256 = ?, repo_count = 2,
                  relationship_count = 0, write_token = ?, updated_at = ?, updated_by = ?,
                  last_action = 'replaced', last_audit_id = ?, deleted_at = NULL
            WHERE provider = 'github' AND scope_id = '42' AND revision = 1`,
        )
        .bind("b".repeat(64), token, "2026-07-13T20:01:00.000Z", "github:111", "bad-audit"),
      db.prepare("DELETE FROM repository_context_relationship WHERE provider = 'github' AND scope_id = '42'"),
      db.prepare("DELETE FROM repository_context_repository WHERE provider = 'github' AND scope_id = '42'"),
      db.prepare(
        `INSERT INTO repository_context_repository
            (provider, scope_id, external_id, full_name, context, position)
           VALUES ('github', '42', '101', 'acme/api', 'only one', 0)`,
      ),
      db
        .prepare(
          `INSERT INTO repository_context_commit_guard (provider, scope_id, write_token)
           SELECT 'github', '42', ?
           WHERE EXISTS (
             SELECT 1 FROM repository_context_scope
              WHERE provider = 'github' AND scope_id = '42' AND write_token = ?
           )`,
        )
        .bind(token, token),
    ]
    await expect(db.batch(badBatch)).rejects.toThrow(/count mismatch/i)
    expect(await readRepositoryContext(db, "github", "42")).toEqual(before)
    await expect(
      db.prepare("SELECT COUNT(*) AS n FROM repository_context_audit").first<{ n: number }>(),
    ).resolves.toEqual({ n: 1 })
  })

  it("keeps provider and scope rows isolated and enforces same-scope relationship endpoints", async () => {
    expect((await replaceRepositoryContext(db, args())).status).toBe("updated")
    expect(
      (
        await replaceRepositoryContext(
          db,
          args({
            provider: "github",
            scopeId: "99",
            repositories: [repository("101", "other/api", "other", 0)],
            relationships: [],
          }),
        )
      ).status,
    ).toBe("updated")
    expect(
      (
        await replaceRepositoryContext(
          db,
          args({
            provider: "gitlab",
            scopeId: "user_01J00000000000000000000000",
            repositories: [repository("project-101", "group/api", "gitlab", 0)],
            relationships: [],
          }),
        )
      ).status,
    ).toBe("updated")

    await expect(
      db
        .prepare(
          `INSERT INTO repository_context_relationship
            (provider, scope_id, from_external_id, to_external_id, label, normalized_label, position)
           VALUES ('github', '99', '101', '202', 'cross scope', 'cross scope', 0)`,
        )
        .run(),
    ).rejects.toThrow(/foreign key/i)
    await expect(
      db
        .prepare(
          `INSERT INTO repository_context_relationship
            (provider, scope_id, from_external_id, to_external_id, label, normalized_label, position)
           VALUES ('gitlab', 'user_01J00000000000000000000000', 'project-101', '202',
                   'cross provider', 'cross provider', 0)`,
        )
        .run(),
    ).rejects.toThrow(/foreign key/i)
    await expect(readRepositoryContext(db, "github", "42")).resolves.toMatchObject({ status: "ok" })
    await expect(readRepositoryContext(db, "github", "99")).resolves.toMatchObject({ status: "ok" })
    await expect(readRepositoryContext(db, "gitlab", "user_01J00000000000000000000000")).resolves.toMatchObject({
      status: "ok",
    })
  })

  it("exactly replaces children, deleting omitted repositories and their incident relationships", async () => {
    expect((await replaceRepositoryContext(db, args())).status).toBe("updated")
    const replacement = await replaceRepositoryContext(
      db,
      args({
        expectedRevision: 1,
        repositories: [repository("101", "acme/api", "Public API", 0)],
        relationships: [],
        nowIso: "2026-07-13T20:01:00.000Z",
      }),
    )
    expect(replacement).toMatchObject({
      status: "updated",
      snapshot: { revision: 2, repositories: [{ externalId: "101" }], relationships: [] },
    })
    await expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM repository_context_repository WHERE provider = 'github' AND scope_id = '42'",
        )
        .first<{ n: number }>(),
    ).resolves.toEqual({ n: 1 })
    await expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM repository_context_relationship WHERE provider = 'github' AND scope_id = '42'",
        )
        .first<{ n: number }>(),
    ).resolves.toEqual({ n: 0 })
  })

  it("uses deterministic codepoint ordering so request order cannot change the snapshot hash", async () => {
    const repositories = [
      repository("project-ä", "group/ä", "umlaut", 0),
      repository("project-z", "group/z", "zed", 1),
      repository("project-a", "group/a", "aye", 2),
    ]
    const relationships = [
      relationship("project-ä", "project-a", "Second", 0),
      relationship("project-z", "project-a", "First", 1),
    ]
    const first = await replaceRepositoryContext(
      db,
      args({
        provider: "gitlab",
        scopeId: "user_a",
        repositories,
        relationships,
      }),
    )
    const second = await replaceRepositoryContext(
      db,
      args({
        provider: "gitlab",
        scopeId: "user_b",
        repositories: [...repositories].reverse(),
        relationships: [...relationships].reverse(),
      }),
    )
    expect(first.status).toBe("updated")
    expect(second.status).toBe("updated")
    if (first.status === "updated" && second.status === "updated") {
      expect(first.snapshot.snapshotSha256).toBe(second.snapshot.snapshotSha256)
      expect(first.snapshot.repositories.map((item) => item.externalId)).toEqual([
        "project-a",
        "project-z",
        "project-ä",
      ])
      expect(first.snapshot.relationships.map((item) => item.fromExternalId)).toEqual(["project-z", "project-ä"])
    }
  })

  it("supports an audited empty purge tombstone and a later exact-revision restore", async () => {
    expect((await replaceRepositoryContext(db, args())).status).toBe("updated")
    const purged = await purgeRepositoryContext(db, {
      provider: "github",
      scopeId: "42",
      expectedRevision: 1,
      nowIso: "2026-07-13T20:02:00.000Z",
      updatedBy: "system:installation-removed",
    })
    expect(purged).toMatchObject({
      status: "updated",
      snapshot: { revision: 2, repositories: [], relationships: [], conventions: "" },
    })
    if (purged.status === "updated") expect(purged.snapshot.deletedAt).toBe("2026-07-13T20:02:00.000Z")
    await expect(
      db
        .prepare(
          "SELECT action, previous_snapshot_format, next_snapshot_format," +
            " next_repo_count, next_relationship_count FROM repository_context_audit ORDER BY next_revision",
        )
        .all(),
    ).resolves.toMatchObject({
      results: [
        {
          action: "replaced",
          previous_snapshot_format: null,
          next_snapshot_format: 1,
          next_repo_count: 2,
          next_relationship_count: 1,
        },
        {
          action: "purged",
          previous_snapshot_format: 1,
          next_snapshot_format: 1,
          next_repo_count: 0,
          next_relationship_count: 0,
        },
      ],
    })
    expect(await purgeRepositoryContext(db, { ...args(), expectedRevision: 1 })).toEqual({
      status: "conflict",
      currentRevision: 2,
    })
    const restored = await replaceRepositoryContext(
      db,
      args({ expectedRevision: 2, nowIso: "2026-07-13T20:03:00.000Z" }),
    )
    expect(restored).toMatchObject({ status: "updated", snapshot: { revision: 3, deletedAt: null } })
  })

  it("domain-separates active-empty and purged-empty snapshots in the format-one hash", async () => {
    const active = await replaceRepositoryContext(db, args({ repositories: [], relationships: [], conventions: "" }))
    expect(active).toMatchObject({ status: "updated", snapshot: { revision: 1, deletedAt: null } })
    if (active.status !== "updated") throw new Error("expected active snapshot")

    const purged = await purgeRepositoryContext(db, {
      provider: "github",
      scopeId: "42",
      expectedRevision: 1,
      nowIso: "2026-07-13T20:02:00.000Z",
      updatedBy: "system:installation-removed",
    })
    expect(purged).toMatchObject({
      status: "updated",
      snapshot: { revision: 2, deletedAt: "2026-07-13T20:02:00.000Z" },
    })
    if (purged.status !== "updated") throw new Error("expected purged snapshot")

    expect(purged.snapshot.snapshotSha256).not.toBe(active.snapshot.snapshotSha256)
  })

  it("chunks maximum snapshots within D1 statement and bind limits", async () => {
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
    const repositories = Array.from({ length: 100 }, (_, index) =>
      repository(String(index + 1), `acme/repo-${index + 1}`, `context ${index + 1}`, index),
    )
    const relationships = Array.from({ length: 200 }, (_, index) =>
      relationship(String((index % 100) + 1), String(((index + 1) % 100) + 1), `edge ${index}`, index),
    )
    const result = await replaceRepositoryContext(trackedDb, args({ repositories, relationships }))
    expect(result).toMatchObject({ status: "updated", snapshot: { revision: 1 } })
    if (result.status === "updated") {
      expect(result.snapshot.repositories).toHaveLength(100)
      expect(result.snapshot.relationships).toHaveLength(200)
    }
    expect(Math.max(...bindCounts)).toBeLessThanOrEqual(99)
  })

  it("reads scope, repositories, and relationships in one transactional D1 batch", async () => {
    expect((await replaceRepositoryContext(db, args())).status).toBe("updated")
    let batchCalls = 0
    const trackedDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "batch") {
          return (statements: D1PreparedStatement[]) => {
            batchCalls += 1
            expect(statements).toHaveLength(3)
            return target.batch(statements)
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === "function" ? value.bind(target) : value
      },
    }) as D1Database
    await expect(readRepositoryContext(trackedDb, "github", "42")).resolves.toMatchObject({ status: "ok" })
    expect(batchCalls).toBe(1)
  })

  it("returns the winning snapshot from the mutation batch without a follow-up read transaction", async () => {
    let batchCalls = 0
    const trackedDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "batch") {
          return (statements: D1PreparedStatement[]) => {
            batchCalls += 1
            expect(statements).toHaveLength(9)
            return target.batch(statements)
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === "function" ? value.bind(target) : value
      },
    }) as D1Database
    await expect(replaceRepositoryContext(trackedDb, args())).resolves.toMatchObject({
      status: "updated",
      snapshot: { revision: 1 },
    })
    expect(batchCalls).toBe(1)
  })

  it("fails closed when child positions are no longer canonical even though positions are excluded from the hash", async () => {
    expect((await replaceRepositoryContext(db, args())).status).toBe("updated")
    await db
      .prepare(
        "UPDATE repository_context_repository SET position = 2" +
          " WHERE provider = 'github' AND scope_id = '42' AND external_id = '202'",
      )
      .run()
    await expect(readRepositoryContext(db, "github", "42")).resolves.toEqual({ status: "unavailable" })
  })

  it("fails closed on a missing migration or inconsistent bounded read", async () => {
    const unmigrated = makeD1()
    await expect(readRepositoryContext(unmigrated, "github", "42")).resolves.toEqual({ status: "unavailable" })
    await expect(replaceRepositoryContext(unmigrated, args())).resolves.toEqual({ status: "unavailable" })

    await db
      .prepare(
        `INSERT INTO repository_context_scope
          (provider, scope_id, revision, snapshot_format, conventions, snapshot_sha256, repo_count,
           relationship_count, write_token, created_at, updated_at, updated_by,
           last_action, last_audit_id, deleted_at)
         VALUES ('github', '77', 1, 1, '', ?, 1, 0, ?, ?, ?, 'system:test', 'replaced', 'audit-77', NULL)`,
      )
      .bind("a".repeat(64), "A".repeat(43), NOW, NOW)
      .run()
    await expect(readRepositoryContext(db, "github", "77")).resolves.toEqual({ status: "unavailable" })
  })

  it("fails closed on ill-formed Unicode before snapshot hashing or D1 writes", async () => {
    await expect(
      replaceRepositoryContext(
        db,
        args({ repositories: [repository("101", "acme/api", "lone surrogate \ud800", 0)], relationships: [] }),
      ),
    ).resolves.toEqual({ status: "unavailable" })
    await expect(readRepositoryContext(db, "github", "42")).resolves.toEqual({ status: "not_found" })
  })
})
