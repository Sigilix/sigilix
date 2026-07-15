import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import * as repositoryContextStore from "./d1-store"
import { readRepositoryContextForReview } from "./review-context-read"
import {
  makeGitHubRepositoryContextReviewIdentity,
  makeGitLabRepositoryContextReviewIdentity,
  parseRepositoryContextReviewMode,
} from "@/src/features/repository-context/domain/review-context"
import {
  activateGitLabRepositoryAuthority,
  claimGitLabRepositoryAuthority,
  releaseGitLabRepositoryAuthority,
} from "./authority-store"
import type { ReplaceRepositoryContextArgs } from "@/src/features/repository-context/domain/types"
import { normalizeEnv } from "@/src/shared/util/normalize-env"
import type { Env } from "@/src/shared/types/env"

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0024_create_repository_context.sql", import.meta.url),
  "utf8",
)
const AUTHORITY_MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0026_create_repository_context_authority.sql", import.meta.url),
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

async function activeGitLabIdentity(db: D1Database, scopeId: string, sourceId: number, fullName: string) {
  const claim = await claimGitLabRepositoryAuthority(db, {
    scopeId,
    instanceOrigin: "https://gitlab.com",
    sourceId,
    fullName,
  })
  if (claim.status !== "claimed") throw new Error("expected GitLab authority claim")
  const activated = await activateGitLabRepositoryAuthority(db, {
    scopeId,
    externalId: claim.repository.externalId,
    claimToken: claim.claimToken,
  })
  if (activated.status !== "activated") throw new Error("expected GitLab authority activation")
  const reviewIdentity = makeGitLabRepositoryContextReviewIdentity(
    scopeId,
    claim.repository.externalId,
    claim.claimToken,
  )
  if (!reviewIdentity) throw new Error("expected valid GitLab review identity")
  return { claim, reviewIdentity }
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

  it("does zero D1 reads when off, identity-less, unsupported, or malformed", async () => {
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
        identity: { provider: "bitbucket", scopeId: "42", repositoryExternalId: "101" } as never,
      }),
    ).resolves.toMatchObject({ outcome: "unsupported_provider", promptBlock: "" })
    await expect(
      readRepositoryContextForReview({
        db: guardedDb,
        mode: "shadow",
        identity: {
          provider: "gitlab",
          scopeId: "user-42",
          repositoryExternalId: `gl:v1:${"a".repeat(43)}`,
          authorityClaimToken: "short",
        } as never,
      }),
    ).resolves.toMatchObject({ outcome: "invalid_identity", promptBlock: "" })

    expect(prepare).not.toHaveBeenCalled()
    expect(telemetryEvents(log)).toHaveLength(4)
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

  it("returns rendered context only in exact post mode", async () => {
    expect((await repositoryContextStore.replaceRepositoryContext(db, args("42", "alpha/api"))).status).toBe("updated")

    const result = await readRepositoryContextForReview({ db, mode: "post", identity: identity(42) })
    expect(result).toMatchObject({
      outcome: "post",
      repositoryCount: 2,
      relationshipCount: 1,
      truncated: false,
    })
    expect(result.promptBlock.length).toBe(result.renderedChars)
    expect(result.promptBlock).toContain("[REPOSITORY CONTEXT — UNTRUSTED DATA]")
    expect(result.promptBlock).toContain("context for alpha/api")
    expect(result.promptBlock).toContain("alpha/api-worker")
  })

  it("reads only the exact active GitLab authority scope and provider", async () => {
    await db.exec(AUTHORITY_MIGRATION_SQL)
    const current = await activeGitLabIdentity(db, "42", 101, "group/api")
    const related = await activeGitLabIdentity(db, "42", 202, "group/worker")
    const unrelated = await activeGitLabIdentity(db, "42", 303, "group/private")

    expect(
      (
        await repositoryContextStore.replaceRepositoryContext(db, {
          provider: "gitlab",
          scopeId: "42",
          expectedRevision: 0,
          repositories: [
            { ...current.claim.repository, context: "GitLab API context", position: 0 },
            { ...related.claim.repository, context: "GitLab worker context", position: 1 },
            { ...unrelated.claim.repository, context: "GitLab private context", position: 2 },
          ],
          relationships: [
            {
              fromExternalId: current.claim.repository.externalId,
              toExternalId: related.claim.repository.externalId,
              label: "publishes jobs",
              normalizedLabel: "publishes jobs",
              position: 0,
            },
          ],
          conventions: "GitLab conventions",
          nowIso: NOW,
          updatedBy: "gitlab:42",
        })
      ).status,
    ).toBe("updated")
    expect((await repositoryContextStore.replaceRepositoryContext(db, args("42", "github/sentinel"))).status).toBe(
      "updated",
    )

    const shadow = await readRepositoryContextForReview({
      db,
      mode: "shadow",
      identity: current.reviewIdentity,
    })
    expect(shadow).toMatchObject({ outcome: "shadow", promptBlock: "", repositoryCount: 2 })

    const post = await readRepositoryContextForReview({ db, mode: "post", identity: current.reviewIdentity })
    expect(post).toMatchObject({ outcome: "post", repositoryCount: 2, relationshipCount: 1 })
    expect(post.promptBlock).toContain("GitLab API context")
    expect(post.promptBlock).toContain("GitLab worker context")
    expect(post.promptBlock).toContain("GitLab conventions")
    expect(post.promptBlock).not.toMatch(/GitLab private context|github\/sentinel|context for github/)

    await expect(
      releaseGitLabRepositoryAuthority(db, {
        scopeId: "42",
        externalId: current.claim.repository.externalId,
        claimToken: current.claim.claimToken,
      }),
    ).resolves.toMatchObject({ status: "released" })
    let inactiveBatchCalls = 0
    const inactiveDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "prepare") return (query: string) => target.prepare(query)
        if (property === "batch") {
          return (statements: D1PreparedStatement[]) => {
            inactiveBatchCalls += 1
            return target.batch(statements)
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === "function" ? value.bind(target) : value
      },
    }) as D1Database
    await expect(
      readRepositoryContextForReview({ db: inactiveDb, mode: "post", identity: current.reviewIdentity }),
    ).resolves.toMatchObject({ outcome: "authority_inactive", promptBlock: "" })
    expect(inactiveBatchCalls).toBe(1)
  })

  it("returns no prompt when the exact GitLab generation is revoked between read and post-check", async () => {
    await db.exec(AUTHORITY_MIGRATION_SQL)
    const current = await activeGitLabIdentity(db, "user-race", 404, "group/race")
    expect(
      (
        await repositoryContextStore.replaceRepositoryContext(db, {
          provider: "gitlab",
          scopeId: "user-race",
          expectedRevision: 0,
          repositories: [{ ...current.claim.repository, context: "must never escape", position: 0 }],
          relationships: [],
          conventions: "",
          nowIso: NOW,
          updatedBy: "gitlab:user-race",
        })
      ).status,
    ).toBe("updated")

    let batchCall = 0
    const racedDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "prepare") return (query: string) => target.prepare(query)
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            batchCall += 1
            const result = await target.batch(statements)
            if (batchCall === 2) {
              await releaseGitLabRepositoryAuthority(target, {
                scopeId: "user-race",
                externalId: current.claim.repository.externalId,
                claimToken: current.claim.claimToken,
              })
            }
            return result
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === "function" ? value.bind(target) : value
      },
    }) as D1Database

    const result = await readRepositoryContextForReview({
      db: racedDb,
      mode: "post",
      identity: current.reviewIdentity,
    })
    expect(result).toMatchObject({ outcome: "authority_inactive", promptBlock: "", renderedChars: 0 })
    expect(batchCall).toBe(3)
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

  it("bounds the whole GitLab authority and context sequence at the fixed 500ms deadline", async () => {
    vi.useFakeTimers()
    try {
      const reviewIdentity = makeGitLabRepositoryContextReviewIdentity(
        "user-timeout",
        `gl:v1:${"a".repeat(43)}`,
        "b".repeat(43),
      )
      if (!reviewIdentity) throw new Error("expected valid GitLab identity")
      const statement = {
        bind() {
          return this
        },
      } as unknown as D1PreparedStatement
      const hangingDb = {
        prepare: vi.fn(() => statement),
        batch: vi.fn(() => new Promise<D1Result[]>(() => {})),
      } as unknown as D1Database

      const pending = readRepositoryContextForReview({ db: hangingDb, mode: "post", identity: reviewIdentity })
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

  it("keeps the committed production rollout on exact post mode", () => {
    const wrangler = readFileSync(new URL("../../../../wrangler.toml", import.meta.url), "utf8")
    const configuredMode = /SIGILIX_REPOSITORY_CONTEXT_REVIEW_MODE\s*=\s*"([^"]*)"/u.exec(wrangler)?.[1]
    expect(configuredMode, "SIGILIX_REPOSITORY_CONTEXT_REVIEW_MODE in wrangler.toml").toBe("post")
    const normalized = normalizeEnv({ SIGILIX_REPOSITORY_CONTEXT_REVIEW_MODE: configuredMode } as unknown as Env)
    expect(parseRepositoryContextReviewMode(normalized.OPENCLAW_REPOSITORY_CONTEXT_REVIEW_MODE)).toBe("post")
  })
})
