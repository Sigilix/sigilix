import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { readRepositoryContext, replaceRepositoryContext } from "@/src/features/repository-context"
import { importOnboardingRepositoryContext } from "@/src/lib/onboarding-repository-context-import"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"

const INSTALLATION_ID = 42
const migration = readFileSync(new URL("../../migrations/0024_create_repository_context.sql", import.meta.url), "utf8")

function makeKV(): KVNamespace {
  const values = new Map<string, string>()
  return {
    get: async (key: string, type?: "json") => {
      const value = values.get(key)
      if (value === undefined) return null
      return type === "json" ? JSON.parse(value) : value
    },
    put: async (key: string, value: string) => void values.set(key, value),
    delete: async (key: string) => void values.delete(key),
  } as unknown as KVNamespace
}

async function makeDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(migration)
  return db
}

async function seedSnapshot(db: D1Database): Promise<void> {
  const result = await replaceRepositoryContext(db, {
    provider: "github",
    scopeId: String(INSTALLATION_ID),
    expectedRevision: 0,
    repositories: [
      { externalId: "101", fullName: "acme/api", context: "Public API", position: 0 },
      { externalId: "202", fullName: "acme/worker", context: "Background jobs", position: 1 },
    ],
    relationships: [],
    conventions: "",
    nowIso: "2026-07-20T10:04:00.000Z",
    updatedBy: "github:111",
  })
  expect(result.status).toBe("updated")
}

describe("onboarding repository-context import", () => {
  it("returns the concurrent canonical winner when revision zero is claimed after the import read", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await kv.put(
      "onboarding:111",
      JSON.stringify({ selectedRepos: ["acme/api"], repoDescriptions: { "acme/api": "Legacy context" } }),
    )
    let batchCount = 0
    const racingDb = {
      prepare: db.prepare.bind(db),
      batch: async (statements: D1PreparedStatement[]) => {
        batchCount += 1
        if (batchCount === 2) await seedSnapshot(db)
        return db.batch(statements)
      },
    } as unknown as D1Database

    const imported = await importOnboardingRepositoryContext({
      db: racingDb,
      kv,
      githubUserId: "111",
      installationId: INSTALLATION_ID,
      availableRepositories: [
        { repositoryId: 101, fullName: "acme/api" },
        { repositoryId: 202, fullName: "acme/worker" },
      ],
      nowIso: "2026-07-20T10:05:00.000Z",
    })

    expect(imported).toEqual({ status: "exists", currentRevision: 1 })
    const winner = await readRepositoryContext(db, "github", String(INSTALLATION_ID))
    expect(winner.status).toBe("ok")
    if (winner.status === "ok") {
      expect(winner.snapshot.updatedBy).toBe("github:111")
      expect(winner.snapshot.repositories[0]).toMatchObject({ context: "Public API" })
    }
  })
})
