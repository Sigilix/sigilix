import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  makeGitHubRepositoryContextScopedIdentity,
  parseRepositoryContextScopedMode,
} from "@/src/features/repository-context/domain/scoped-context"
import type { ReplaceRepositoryContextArgs } from "@/src/features/repository-context/domain/types"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { purgeRepositoryContext, replaceRepositoryContext } from "./d1-store"
import { readRepositoryContextForScopedRepositories } from "./scoped-context-read"

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0024_create_repository_context.sql", import.meta.url),
  "utf8",
)
const NOW = "2026-07-13T20:00:00.000Z"

function replacement(scopeId: string, owner: string): ReplaceRepositoryContextArgs {
  return {
    provider: "github",
    scopeId,
    expectedRevision: 0,
    repositories: [
      { externalId: "101", fullName: `${owner}/api-old`, context: `context for ${owner} api`, position: 0 },
      { externalId: "202", fullName: `${owner}/worker-old`, context: `context for ${owner} worker`, position: 1 },
      { externalId: "303", fullName: `${owner}/private`, context: `context for ${owner} private`, position: 2 },
    ],
    relationships: [
      {
        fromExternalId: "101",
        toExternalId: "202",
        label: "publishes jobs",
        normalizedLabel: "publishes jobs",
        position: 0,
      },
      {
        fromExternalId: "101",
        toExternalId: "303",
        label: "reads private state",
        normalizedLabel: "reads private state",
        position: 1,
      },
    ],
    conventions: `conventions for ${owner} must not enter Slack`,
    nowIso: NOW,
    updatedBy: "github:111",
  }
}

function identity(
  scopeId: number,
  repositories = [
    { repositoryId: 101, fullName: "live/api" },
    { repositoryId: 202, fullName: "live/worker" },
  ],
) {
  const value = makeGitHubRepositoryContextScopedIdentity(scopeId, repositories)
  if (!value) throw new Error("expected valid identity")
  return value
}

function telemetryEvents(log: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
}

describe("readRepositoryContextForScopedRepositories", () => {
  let db: D1Database
  let log: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
    log = vi.spyOn(console, "log").mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("does zero D1 reads while off, for unknown mode values, or without an identity", async () => {
    const prepare = vi.fn(() => {
      throw new Error("D1 must not be touched")
    })
    const guardedDb = { prepare } as unknown as D1Database

    await expect(
      readRepositoryContextForScopedRepositories({ db: guardedDb, mode: "off", identity: identity(42) }),
    ).resolves.toMatchObject({ outcome: "off", promptBlock: "" })
    await expect(
      readRepositoryContextForScopedRepositories({
        db: guardedDb,
        mode: parseRepositoryContextScopedMode("unexpected-on-value"),
        identity: identity(42),
      }),
    ).resolves.toMatchObject({ outcome: "off", promptBlock: "" })
    await expect(readRepositoryContextForScopedRepositories({ db: guardedDb, mode: "on" })).resolves.toMatchObject({
      outcome: "missing_identity",
      promptBlock: "",
    })

    expect(prepare).not.toHaveBeenCalled()
  })

  it("keeps the committed production rollout in shadow until telemetry is reviewed", () => {
    const wrangler = readFileSync(new URL("../../../../wrangler.toml", import.meta.url), "utf8")
    const configuredMode = /SIGILIX_REPOSITORY_CONTEXT_SLACK_MODE\s*=\s*"([^"]*)"/u.exec(wrangler)?.[1]
    expect(configuredMode, "SIGILIX_REPOSITORY_CONTEXT_SLACK_MODE in wrangler.toml").toBe("shadow")
    expect(parseRepositoryContextScopedMode(configuredMode)).toBe("shadow")
  })

  it("keeps shadow byte-empty but returns an active prompt only in exact on mode", async () => {
    expect((await replaceRepositoryContext(db, replacement("42", "alpha"))).status).toBe("updated")

    const shadow = await readRepositoryContextForScopedRepositories({ db, mode: "shadow", identity: identity(42) })
    expect(shadow).toMatchObject({
      outcome: "shadow",
      promptBlock: "",
      repositoryCount: 2,
      relationshipCount: 1,
      truncated: false,
    })
    expect(shadow.renderedChars).toBeGreaterThan(0)

    const active = await readRepositoryContextForScopedRepositories({ db, mode: "on", identity: identity(42) })
    expect(active).toMatchObject({
      outcome: "on",
      repositoryCount: 2,
      relationshipCount: 1,
      truncated: false,
    })
    expect(active.promptBlock.length).toBe(active.renderedChars)
    expect(active.promptBlock).toContain("context for alpha api")
    expect(active.promptBlock).toContain("context for alpha worker")
    expect(active.promptBlock).toContain('"name":"live/api"')
    expect(active.promptBlock).toContain('"name":"live/worker"')
    expect(active.promptBlock).not.toMatch(/alpha\/private|context for alpha private|reads private state|conventions/)
  })

  it("reads the exact installation scope when immutable repository ids collide", async () => {
    expect((await replaceRepositoryContext(db, replacement("42", "alpha"))).status).toBe("updated")
    expect((await replaceRepositoryContext(db, replacement("84", "beta"))).status).toBe("updated")

    const result = await readRepositoryContextForScopedRepositories({
      db,
      mode: "on",
      identity: identity(84, [{ repositoryId: 101, fullName: "beta/api-live" }]),
    })
    expect(result).toMatchObject({ outcome: "on", repositoryCount: 1, relationshipCount: 0 })
    expect(result.promptBlock).toContain("context for beta api")
    expect(result.promptBlock).toContain('"name":"beta/api-live"')
    expect(result.promptBlock).not.toMatch(/alpha|api-old|context for beta worker|context for beta private/)
  })

  it("returns a distinct timeout outcome at the fixed 500ms read deadline", async () => {
    vi.useFakeTimers()
    const statement = {
      bind() {
        return this
      },
    } as unknown as D1PreparedStatement
    const hangingDb = {
      prepare: vi.fn(() => statement),
      batch: vi.fn(() => new Promise<D1Result[]>(() => {})),
    } as unknown as D1Database

    const pending = readRepositoryContextForScopedRepositories({ db: hangingDb, mode: "on", identity: identity(42) })
    await vi.advanceTimersByTimeAsync(499)
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toMatchObject({ outcome: "timeout", promptBlock: "", elapsedMs: 500 })
    expect(telemetryEvents(log).at(-1)).toMatchObject({ outcome: "timeout" })
  })

  it("fails soft for a missing database, absent scope, tombstone, and corrupt snapshot", async () => {
    await expect(
      readRepositoryContextForScopedRepositories({ mode: "on", identity: identity(42) }),
    ).resolves.toMatchObject({ outcome: "unavailable", promptBlock: "" })
    await expect(
      readRepositoryContextForScopedRepositories({ db, mode: "on", identity: identity(42) }),
    ).resolves.toMatchObject({ outcome: "not_found", promptBlock: "" })

    expect((await replaceRepositoryContext(db, replacement("42", "alpha"))).status).toBe("updated")
    expect(
      (
        await purgeRepositoryContext(db, {
          provider: "github",
          scopeId: "42",
          expectedRevision: 1,
          nowIso: "2026-07-13T20:01:00.000Z",
          updatedBy: "system:test",
        })
      ).status,
    ).toBe("updated")
    await expect(
      readRepositoryContextForScopedRepositories({ db, mode: "on", identity: identity(42) }),
    ).resolves.toMatchObject({ outcome: "tombstoned", promptBlock: "" })

    const integrityDb = makeD1()
    await integrityDb.exec(MIGRATION_SQL)
    expect((await replaceRepositoryContext(integrityDb, replacement("77", "corrupt"))).status).toBe("updated")
    const digest = vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(new Error("digest failed"))
    await expect(
      readRepositoryContextForScopedRepositories({ db: integrityDb, mode: "on", identity: identity(77) }),
    ).resolves.toMatchObject({ outcome: "unavailable", promptBlock: "" })
    digest.mockRestore()
  })

  it("emits an exact identifier-free telemetry schema", async () => {
    expect((await replaceRepositoryContext(db, replacement("84", "beta"))).status).toBe("updated")
    log.mockClear()

    const result = await readRepositoryContextForScopedRepositories({
      db,
      mode: "on",
      identity: identity(84, [{ repositoryId: 101, fullName: "beta/api-live" }]),
    })
    const events = telemetryEvents(log)
    expect(events).toHaveLength(1)
    expect(Object.keys(events[0]!)).toEqual([
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
      event: "repository-context-scoped-read",
      mode: "on",
      rendererVersion: "s1",
      outcome: "on",
      elapsedMs: expect.any(Number),
      repositoryCount: 1,
      relationshipCount: 0,
      renderedChars: result.renderedChars,
      truncated: false,
    })
    expect(JSON.stringify(events[0])).not.toMatch(
      /beta|api-live|scopeId|externalId|fullName|installationId|repositoryId|error/i,
    )
  })
})
