import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import * as repositoryContextStore from "./d1-store"
import { readRepositoryContextForReview } from "./review-context-read"
import { makeGitHubRepositoryContextReviewIdentity } from "@/src/features/repository-context/domain/review-context"
import type {
  ReplaceRepositoryContextArgs,
  RepositoryContextProvider,
} from "@/src/features/repository-context/domain/types"

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0024_create_repository_context.sql", import.meta.url),
  "utf8",
)
const NOW = "2026-07-13T20:00:00.000Z"

function args(scopeId: string, currentName: string): ReplaceRepositoryContextArgs {
  return {
    provider: "github",
    scopeId,
    expectedRevision: 0,
    repositories: [
      { externalId: "101", fullName: currentName, context: `context for ${currentName}`, position: 0 },
      { externalId: "202", fullName: `${currentName}-worker`, context: "worker", position: 1 },
    ],
    relationships: [
      {
        fromExternalId: "101",
        toExternalId: "202",
        label: "publishes jobs",
        normalizedLabel: "publishes jobs",
        position: 0,
      },
    ],
    conventions: `conventions for ${currentName}`,
    nowIso: NOW,
    updatedBy: "github:111",
  }
}

function identity(scopeId: number, repoId = 101) {
  const value = makeGitHubRepositoryContextReviewIdentity(scopeId, repoId)
  if (!value) throw new Error("expected valid identity")
  return value
}

function telemetryEvents(log: ReturnType<typeof vi.spyOn>): unknown[] {
  return log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)
}

describe("readRepositoryContextForReview", () => {
  let db: D1Database
  let log: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
    log = vi.spyOn(console, "log").mockImplementation(() => undefined)
  })

  afterEach(() => {
    log.mockRestore()
  })

  it("does zero D1 reads when off, identity-less, or non-GitHub", async () => {
    const prepare = vi.fn(() => {
      throw new Error("D1 must not be touched")
    })
    const guardedDb = { prepare } as unknown as D1Database

    await expect(
      readRepositoryContextForReview({ db: guardedDb, mode: "off", identity: identity(42) }),
    ).resolves.toMatchObject({ outcome: "off", promptBlock: "" })
    await expect(readRepositoryContextForReview({ db: guardedDb, mode: "shadow" })).resolves.toMatchObject({
      outcome: "missing_identity",
      promptBlock: "",
    })
    await expect(
      readRepositoryContextForReview({
        db: guardedDb,
        mode: "shadow",
        identity: { provider: "gitlab" as RepositoryContextProvider, scopeId: "42", repositoryExternalId: "101" },
      }),
    ).resolves.toMatchObject({ outcome: "unsupported_provider", promptBlock: "" })

    expect(prepare).not.toHaveBeenCalled()
    expect(telemetryEvents(log)).toHaveLength(3)
  })

  it("fails a runtime on value closed without touching D1", async () => {
    const prepare = vi.fn(() => {
      throw new Error("a future active mode must not be enabled by this shadow reader")
    })
    const guardedDb = { prepare } as unknown as D1Database

    await expect(
      readRepositoryContextForReview({
        db: guardedDb,
        mode: "on" as never,
        identity: identity(42),
      }),
    ).resolves.toMatchObject({ outcome: "off", promptBlock: "" })
    expect(prepare).not.toHaveBeenCalled()
  })

  it("never lets telemetry interrupt the review", async () => {
    log.mockImplementationOnce(() => {
      throw new Error("console unavailable")
    })
    await expect(readRepositoryContextForReview({ mode: "off" })).resolves.toMatchObject({
      outcome: "off",
      promptBlock: "",
    })
  })

  it("fails an unexpected snapshot-integrity rejection soft", async () => {
    expect((await repositoryContextStore.replaceRepositoryContext(db, args("42", "alpha/api"))).status).toBe("updated")
    const digest = vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(new Error("digest failed"))
    try {
      await expect(
        readRepositoryContextForReview({ db, mode: "shadow", identity: identity(42) }),
      ).resolves.toMatchObject({
        outcome: "unavailable",
        promptBlock: "",
      })
    } finally {
      digest.mockRestore()
    }
  })

  it("reads the exact installation scope even when repository ids collide", async () => {
    expect((await repositoryContextStore.replaceRepositoryContext(db, args("42", "alpha/api"))).status).toBe("updated")
    const beta = args("84", "beta/api")
    beta.repositories = beta.repositories.slice(0, 1)
    beta.relationships = []
    expect((await repositoryContextStore.replaceRepositoryContext(db, beta)).status).toBe("updated")

    const result = await readRepositoryContextForReview({ db, mode: "shadow", identity: identity(84) })
    expect(result).toMatchObject({
      outcome: "shadow",
      promptBlock: "",
      repositoryCount: 1,
      relationshipCount: 0,
      truncated: false,
    })
    expect(result.renderedChars).toBeGreaterThan(0)

    const events = telemetryEvents(log)
    expect(events).toHaveLength(1)
    expect(Object.keys(events[0] as object)).toEqual([
      "event",
      "mode",
      "rendererVersion",
      "outcome",
      "elapsedMs",
      "repositoryCount",
      "relationshipCount",
      "renderedChars",
      "truncated",
    ])
    expect(events[0]).toEqual({
      event: "repository-context-review-read",
      mode: "shadow",
      rendererVersion: "r1",
      outcome: "shadow",
      elapsedMs: expect.any(Number),
      repositoryCount: 1,
      relationshipCount: 0,
      renderedChars: result.renderedChars,
      truncated: false,
    })
    expect(JSON.stringify(events[0])).not.toMatch(/alpha|beta|fullName|scopeId|repositoryExternalId|error/i)
  })

  it("renders in shadow while returning a byte-empty prompt block", async () => {
    expect((await repositoryContextStore.replaceRepositoryContext(db, args("42", "alpha/api"))).status).toBe("updated")

    const result = await readRepositoryContextForReview({ db, mode: "shadow", identity: identity(42) })
    expect(result).toMatchObject({
      outcome: "shadow",
      promptBlock: "",
      repositoryCount: 2,
      relationshipCount: 1,
      truncated: false,
    })
    expect(result.renderedChars).toBeGreaterThan(0)
    expect(telemetryEvents(log)).toEqual([
      {
        event: "repository-context-review-read",
        mode: "shadow",
        rendererVersion: "r1",
        outcome: "shadow",
        elapsedMs: expect.any(Number),
        repositoryCount: 2,
        relationshipCount: 1,
        renderedChars: result.renderedChars,
        truncated: false,
      },
    ])
  })

  it("fails soft for a missing database, absent scope, tombstone, and missing current repository", async () => {
    await expect(readRepositoryContextForReview({ mode: "shadow", identity: identity(42) })).resolves.toMatchObject({
      outcome: "unavailable",
      promptBlock: "",
    })
    await expect(readRepositoryContextForReview({ db, mode: "shadow", identity: identity(42) })).resolves.toMatchObject(
      {
        outcome: "not_found",
        promptBlock: "",
      },
    )

    expect((await repositoryContextStore.replaceRepositoryContext(db, args("42", "alpha/api"))).status).toBe("updated")
    await expect(
      readRepositoryContextForReview({ db, mode: "shadow", identity: identity(42, 999) }),
    ).resolves.toMatchObject({ outcome: "current_repository_missing", promptBlock: "" })

    expect(
      (
        await repositoryContextStore.purgeRepositoryContext(db, {
          provider: "github",
          scopeId: "42",
          expectedRevision: 1,
          nowIso: "2026-07-13T20:01:00.000Z",
          updatedBy: "system:test",
        })
      ).status,
    ).toBe("updated")
    await expect(readRepositoryContextForReview({ db, mode: "shadow", identity: identity(42) })).resolves.toMatchObject(
      {
        outcome: "tombstoned",
        promptBlock: "",
      },
    )
  })

  it("bounds a hung D1 read at the fixed 500ms deadline", async () => {
    vi.useFakeTimers()
    try {
      const statement = {
        bind() {
          return this
        },
      } as unknown as D1PreparedStatement
      const hangingDb = {
        prepare: vi.fn(() => statement),
        batch: vi.fn(() => new Promise<D1Result[]>(() => {})),
      } as unknown as D1Database

      const pending = readRepositoryContextForReview({ db: hangingDb, mode: "shadow", identity: identity(42) })
      await vi.advanceTimersByTimeAsync(499)
      let settled = false
      void pending.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await expect(pending).resolves.toMatchObject({ outcome: "unavailable", promptBlock: "", elapsedMs: 500 })
      expect(hangingDb.batch).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
