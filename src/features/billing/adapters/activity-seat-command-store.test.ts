import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"
import { persistActivitySeatCommand, type ActivitySeatEvidence } from "./activity-seat-command-store"

function migration(name: string): string {
  return readFileSync(new URL(`../../../../migrations/${name}`, import.meta.url), "utf8")
}

function dbEnv(db: D1Database): Pick<Env, "SIGILIX_PLATFORM_DB"> {
  return { SIGILIX_PLATFORM_DB: db }
}

async function seedDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(migration("0001_create_tenant_repo_usage.sql"))
  await db.exec(migration("0034_create_org_activity_seat_command.sql"))
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, tier, created_at, updated_at)" +
        " VALUES (42, 'pro', 't', 't'), (43, 'pro', 't', 't')",
    )
    .run()
  return db
}

const baseEvidence: ActivitySeatEvidence = {
  deliveryId: "delivery-1",
  payloadSha256: "a".repeat(64),
  installationId: 42,
  repositoryId: 9001,
  prNumber: 7,
  headSha: "b".repeat(40),
  action: "opened",
  targetGithubUserId: "111",
  targetLogin: "target",
  actorGithubUserId: "222",
  actorLogin: "actor",
  authorAssociation: "MEMBER",
  receivedAtMs: 1_000,
}

function storedRow(evidence: ActivitySeatEvidence): Record<string, unknown> {
  return {
    delivery_id: evidence.deliveryId,
    payload_sha256: evidence.payloadSha256,
    installation_id: evidence.installationId,
    repository_id: evidence.repositoryId,
    pr_number: evidence.prNumber,
    head_sha: evidence.headSha,
    action: evidence.action,
    target_github_user_id: evidence.targetGithubUserId,
    target_login: evidence.targetLogin ?? null,
    actor_github_user_id: evidence.actorGithubUserId,
    actor_login: evidence.actorLogin ?? null,
    author_association: evidence.authorAssociation,
    received_at_ms: evidence.receivedAtMs,
    created_at: "2026-07-16 00:00:00",
  }
}

function racingDb(row: Record<string, unknown>): { db: D1Database; withSession: ReturnType<typeof vi.fn> } {
  let insertAttempted = false
  const statement = (sql: string) => {
    const bound = {
      run: async () => {
        expect(sql).toContain("INSERT INTO org_activity_seat_command")
        insertAttempted = true
        throw new Error("concurrent immutable insert won")
      },
      first: async () => {
        expect(insertAttempted).toBe(true)
        return row
      },
    }
    return { bind: () => bound }
  }
  const session = { prepare: (sql: string) => statement(sql) }
  const withSession = vi.fn(() => session)
  return { db: { withSession } as unknown as D1Database, withSession }
}

describe("activity seat command store", () => {
  let db: D1Database

  beforeEach(async () => {
    db = await seedDb()
  })

  it("creates one exact immutable activity event", async () => {
    await expect(persistActivitySeatCommand(dbEnv(db), baseEvidence)).resolves.toEqual({
      kind: "created",
      evidence: baseEvidence,
    })
    await expect(
      db
        .prepare(
          `SELECT delivery_id, payload_sha256, installation_id, repository_id, pr_number,
                  head_sha, action, target_github_user_id, target_login,
                  actor_github_user_id, actor_login, author_association, received_at_ms
             FROM org_activity_seat_command`,
        )
        .first(),
    ).resolves.toEqual({
      delivery_id: "delivery-1",
      payload_sha256: "a".repeat(64),
      installation_id: 42,
      repository_id: 9001,
      pr_number: 7,
      head_sha: "b".repeat(40),
      action: "opened",
      target_github_user_id: "111",
      target_login: "target",
      actor_github_user_id: "222",
      actor_login: "actor",
      author_association: "MEMBER",
      received_at_ms: 1_000,
    })
  })

  it("replays identical evidence and preserves the first receipt time", async () => {
    await persistActivitySeatCommand(dbEnv(db), baseEvidence)

    const replay = await persistActivitySeatCommand(dbEnv(db), { ...baseEvidence, receivedAtMs: 9_999 })

    expect(replay).toEqual({ kind: "existing", evidence: baseEvidence })
    await expect(
      db.prepare("SELECT COUNT(*) AS count, received_at_ms FROM org_activity_seat_command").first(),
    ).resolves.toEqual({ count: 1, received_at_ms: 1_000 })
  })

  it("deduplicates the same verified body even when the delivery header changes", async () => {
    await persistActivitySeatCommand(dbEnv(db), baseEvidence)

    const replay = await persistActivitySeatCommand(dbEnv(db), {
      ...baseEvidence,
      deliveryId: "delivery-manual-redelivery",
      receivedAtMs: 2_000,
    })

    expect(replay).toEqual({ kind: "existing", evidence: baseEvidence })
    await expect(db.prepare("SELECT COUNT(*) AS count FROM org_activity_seat_command").first()).resolves.toEqual({
      count: 1,
    })
  })

  it("fails closed when one delivery id is reused with different immutable evidence", async () => {
    await persistActivitySeatCommand(dbEnv(db), baseEvidence)

    await expect(
      persistActivitySeatCommand(dbEnv(db), {
        ...baseEvidence,
        payloadSha256: "c".repeat(64),
        targetGithubUserId: "333",
      }),
    ).resolves.toEqual({ kind: "conflict" })
    await expect(db.prepare("SELECT target_github_user_id FROM org_activity_seat_command").first()).resolves.toEqual({
      target_github_user_id: "111",
    })
  })

  it("gives delivery ownership precedence when its body hash matches another row", async () => {
    await persistActivitySeatCommand(dbEnv(db), baseEvidence)
    await persistActivitySeatCommand(dbEnv(db), {
      ...baseEvidence,
      deliveryId: "delivery-2",
      payloadSha256: "c".repeat(64),
      targetGithubUserId: "333",
    })

    await expect(
      persistActivitySeatCommand(dbEnv(db), {
        ...baseEvidence,
        payloadSha256: "c".repeat(64),
        targetGithubUserId: "333",
      }),
    ).resolves.toEqual({ kind: "conflict" })
  })

  it("recovers a concurrent identical insert through the primary session", async () => {
    const race = racingDb(storedRow(baseEvidence))

    await expect(persistActivitySeatCommand(dbEnv(race.db), baseEvidence)).resolves.toEqual({
      kind: "existing",
      evidence: baseEvidence,
    })
    expect(race.withSession).toHaveBeenCalledWith("first-primary")
  })

  it("fails closed when a concurrent insert owns the delivery with different evidence", async () => {
    const conflicting = {
      ...baseEvidence,
      payloadSha256: "f".repeat(64),
      targetGithubUserId: "333",
    }
    const race = racingDb(storedRow(conflicting))

    await expect(persistActivitySeatCommand(dbEnv(race.db), baseEvidence)).resolves.toEqual({ kind: "conflict" })
    expect(race.withSession).toHaveBeenCalledWith("first-primary")
  })

  it("keeps matching repository and user ids isolated by exact installation", async () => {
    await expect(persistActivitySeatCommand(dbEnv(db), baseEvidence)).resolves.toMatchObject({ kind: "created" })
    await expect(
      persistActivitySeatCommand(dbEnv(db), {
        ...baseEvidence,
        deliveryId: "delivery-2",
        payloadSha256: "d".repeat(64),
        installationId: 43,
      }),
    ).resolves.toMatchObject({ kind: "created" })
    await expect(
      db.prepare("SELECT installation_id FROM org_activity_seat_command ORDER BY installation_id").all(),
    ).resolves.toMatchObject({ results: [{ installation_id: 42 }, { installation_id: 43 }] })
  })

  it("rejects malformed immutable identity and unsupported authority", async () => {
    await expect(persistActivitySeatCommand(dbEnv(db), { ...baseEvidence, targetGithubUserId: "01" })).resolves.toEqual(
      { kind: "error", reason: "invalid_input" },
    )
    await expect(
      persistActivitySeatCommand(dbEnv(db), {
        ...baseEvidence,
        authorAssociation: "COLLABORATOR" as ActivitySeatEvidence["authorAssociation"],
      }),
    ).resolves.toEqual({ kind: "error", reason: "invalid_input" })
    await expect(
      persistActivitySeatCommand(dbEnv(db), {
        ...baseEvidence,
        action: "reopened" as ActivitySeatEvidence["action"],
      }),
    ).resolves.toEqual({ kind: "error", reason: "invalid_input" })
    await expect(db.prepare("SELECT COUNT(*) AS count FROM org_activity_seat_command").first()).resolves.toEqual({
      count: 0,
    })
  })

  it("fails unavailable without a usable D1 binding", async () => {
    await expect(persistActivitySeatCommand({}, baseEvidence)).resolves.toEqual({
      kind: "error",
      reason: "unavailable",
    })
    const broken = {
      withSession: () => {
        throw new Error("D1 unavailable")
      },
    } as unknown as D1Database
    await expect(persistActivitySeatCommand(dbEnv(broken), baseEvidence)).resolves.toEqual({
      kind: "error",
      reason: "unavailable",
    })
  })
})
