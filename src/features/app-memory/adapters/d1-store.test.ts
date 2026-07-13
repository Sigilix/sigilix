import { beforeEach, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { MAX_APP_MEMORIES_PER_SCOPE, MAX_APP_MEMORY_CONTENT_LENGTH } from "@/src/features/app-memory/domain/types"
import { createAppMemory, deleteAppMemory, listAppMemories } from "./d1-store"
import type { Env } from "@/src/shared/types/env"

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0021_create_app_memory.sql", import.meta.url),
  "utf8",
)

function env(db: D1Database): Pick<Env, "SIGILIX_PLATFORM_DB"> {
  return { SIGILIX_PLATFORM_DB: db }
}

function createArgs(over: Partial<Parameters<typeof createAppMemory>[1]> = {}) {
  return {
    installationId: 42,
    scope: "personal" as const,
    ownerUserId: "user-a",
    appId: "cli" as const,
    content: "Prefer focused pull requests.",
    nowMs: 100,
    ...over,
  }
}

describe("D1 app-memory store", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("lists only the caller's personal rows plus the selected app's organization rows", async () => {
    await createAppMemory(env(db), createArgs())
    await createAppMemory(env(db), createArgs({ ownerUserId: "user-b", content: "Other user preference." }))
    await createAppMemory(
      env(db),
      createArgs({ scope: "organization", ownerUserId: "user-admin", content: "Organization preference." }),
    )
    await createAppMemory(env(db), createArgs({ appId: "github", content: "GitHub-only preference." }))
    await createAppMemory(env(db), createArgs({ installationId: 99, content: "Other installation preference." }))

    const result = await listAppMemories(env(db), {
      installationId: 42,
      callerUserId: "user-a",
      appId: "cli",
      limit: 50,
      cursor: null,
    })
    expect(result).toEqual({
      status: "ok",
      memories: expect.arrayContaining([
        expect.objectContaining({ scope: "personal", ownerUserId: "user-a" }),
        expect.objectContaining({ scope: "organization", ownerUserId: "" }),
      ]),
      nextCursor: null,
    })
    if (result.status === "ok") {
      expect(result.memories).toHaveLength(2)
      expect(result.memories.some((memory) => memory.ownerUserId === "user-b")).toBe(false)
    }
  })

  it("makes exact duplicate creates idempotent without merging different subjects", async () => {
    const first = await createAppMemory(env(db), createArgs())
    const duplicate = await createAppMemory(env(db), createArgs({ nowMs: 200 }))
    const otherUser = await createAppMemory(env(db), createArgs({ ownerUserId: "user-b", nowMs: 200 }))
    expect(first).toEqual({ status: "ok", deduped: false, memory: expect.any(Object) })
    expect(duplicate).toEqual({
      status: "ok",
      deduped: true,
      memory: expect.objectContaining({ id: first.status === "ok" ? first.memory.id : "" }),
    })
    expect(otherUser).toEqual({ status: "ok", deduped: false, memory: expect.any(Object) })
  })

  it("enforces the per-subject cap atomically while still allowing a duplicate at capacity", async () => {
    for (let index = 0; index < MAX_APP_MEMORIES_PER_SCOPE; index++) {
      const result = await createAppMemory(env(db), createArgs({ content: `Memory ${index}` }))
      expect(result.status).toBe("ok")
    }
    expect(await createAppMemory(env(db), createArgs({ content: "One too many" }))).toEqual({
      status: "limit_reached",
    })
    expect(await createAppMemory(env(db), createArgs({ content: "Memory 0", nowMs: 200 }))).toEqual({
      status: "ok",
      deduped: true,
      memory: expect.objectContaining({ content: "Memory 0" }),
    })
  })

  it("preserves concurrent distinct inserts", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        createAppMemory(env(db), createArgs({ content: `Concurrent memory ${index}`, nowMs: 100 + index })),
      ),
    )
    expect(results.every((result) => result.status === "ok")).toBe(true)
    const count = await db.prepare("SELECT COUNT(*) AS n FROM app_memory").first<{ n: number }>()
    expect(count?.n).toBe(12)
  })

  it("serializes concurrent inserts at the capacity boundary", async () => {
    for (let index = 0; index < MAX_APP_MEMORIES_PER_SCOPE - 1; index++) {
      expect((await createAppMemory(env(db), createArgs({ content: `Existing ${index}` }))).status).toBe("ok")
    }
    const boundary = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        createAppMemory(env(db), createArgs({ content: `Boundary ${index}`, nowMs: 200 + index })),
      ),
    )
    expect(boundary.filter((result) => result.status === "ok")).toHaveLength(1)
    expect(boundary.filter((result) => result.status === "limit_reached")).toHaveLength(3)
    const count = await db.prepare("SELECT COUNT(*) AS n FROM app_memory").first<{ n: number }>()
    expect(count?.n).toBe(MAX_APP_MEMORIES_PER_SCOPE)
  })

  it("uses one scoped delete predicate for personal ownership and organization authority", async () => {
    const personal = await createAppMemory(env(db), createArgs())
    const organization = await createAppMemory(
      env(db),
      createArgs({ scope: "organization", ownerUserId: "admin", content: "Organization preference." }),
    )
    if (personal.status !== "ok" || organization.status !== "ok") throw new Error("fixture setup failed")

    expect(
      await deleteAppMemory(env(db), {
        installationId: 42,
        callerUserId: "user-b",
        appId: "cli",
        memoryId: personal.memory.id,
        canManageOrganization: true,
      }),
    ).toEqual({ status: "not_found" })
    expect(
      await deleteAppMemory(env(db), {
        installationId: 42,
        callerUserId: "user-a",
        appId: "cli",
        memoryId: organization.memory.id,
        canManageOrganization: false,
      }),
    ).toEqual({ status: "not_found" })
    expect(
      await deleteAppMemory(env(db), {
        installationId: 42,
        callerUserId: "user-a",
        appId: "cli",
        memoryId: organization.memory.id,
        canManageOrganization: true,
      }),
    ).toEqual({ status: "deleted" })
  })

  it("fails closed when storage is absent or broken", async () => {
    const broken = {
      prepare() {
        throw new Error("broken")
      },
    } as unknown as D1Database
    await expect(createAppMemory({}, createArgs())).resolves.toEqual({ status: "unavailable" })
    await expect(createAppMemory(env(broken), createArgs())).resolves.toEqual({ status: "unavailable" })
    await expect(
      listAppMemories(env(broken), {
        installationId: 42,
        callerUserId: "user-a",
        appId: "cli",
        limit: 50,
        cursor: null,
      }),
    ).resolves.toEqual({ status: "unavailable" })
  })

  it("rejects oversized content before reaching D1", async () => {
    let prepared = false
    const trackingDb = {
      prepare() {
        prepared = true
        throw new Error("should not prepare")
      },
    } as unknown as D1Database

    await expect(
      createAppMemory(env(trackingDb), createArgs({ content: "x".repeat(MAX_APP_MEMORY_CONTENT_LENGTH + 1) })),
    ).resolves.toEqual({ status: "unavailable" })
    expect(prepared).toBe(false)
  })
})
