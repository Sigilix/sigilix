import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { replaceRepositoryContext, type ReplaceRepositoryContextArgs } from "@/src/features/repository-context"
import { normalizeEnv } from "@/src/shared/util/normalize-env"
import type { Env } from "@/src/shared/types/env"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { loadLinearRepositoryContext } from "@/src/lib/linear-repository-context"

const MIGRATION_SQL = readFileSync(
  new URL("../../migrations/0024_create_repository_context.sql", import.meta.url),
  "utf8",
)
const NOW = "2026-07-15T00:00:00.000Z"

function replacement(scopeId: string, owner: string): ReplaceRepositoryContextArgs {
  return {
    provider: "github",
    scopeId,
    expectedRevision: 0,
    repositories: [
      { externalId: "101", fullName: `${owner}/api-old`, context: `${owner} API owns auth`, position: 0 },
      { externalId: "202", fullName: `${owner}/web-old`, context: `${owner} web calls the API`, position: 1 },
      { externalId: "303", fullName: `${owner}/private`, context: `${owner} private context`, position: 2 },
    ],
    relationships: [
      {
        fromExternalId: "202",
        toExternalId: "101",
        label: "calls for sessions",
        normalizedLabel: "calls for sessions",
        position: 0,
      },
    ],
    conventions: `${owner} conventions are outside the scoped renderer`,
    nowIso: NOW,
    updatedBy: "github:111",
  }
}

function telemetryEvents(log: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return log.mock.calls
    .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
    .filter((event) => event.event === "linear-repository-context-read")
}

describe("loadLinearRepositoryContext", () => {
  let db: D1Database
  let log: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
    log = vi.spyOn(console, "log").mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("enables the canonical production rollout (on) and mirrors it to the legacy reader", () => {
    const wrangler = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8")
    const configured = /SIGILIX_REPOSITORY_CONTEXT_LINEAR_MODE\s*=\s*"([^"]*)"/u.exec(wrangler)?.[1]
    expect(configured, "SIGILIX_REPOSITORY_CONTEXT_LINEAR_MODE in wrangler.toml").toBe("on")
    const normalized = normalizeEnv({ SIGILIX_REPOSITORY_CONTEXT_LINEAR_MODE: configured } as unknown as Env)
    expect(normalized.OPENCLAW_REPOSITORY_CONTEXT_LINEAR_MODE).toBe("on")
  })

  it("returns zero prompt bytes in shadow while measuring the exact team-bound repositories", async () => {
    expect((await replaceRepositoryContext(db, replacement("42", "alpha"))).status).toBe("updated")

    const promptBlock = await loadLinearRepositoryContext({
      env: { SIGILIX_PLATFORM_DB: db, OPENCLAW_REPOSITORY_CONTEXT_LINEAR_MODE: "shadow" } as Env,
      surface: "triage",
      installationId: 42,
      repositories: [
        { repositoryId: 101, fullName: "live/api" },
        { repositoryId: 202, fullName: "live/web" },
      ],
      enabled: true,
    })

    expect(promptBlock).toBe("")
    expect(telemetryEvents(log).at(-1)).toMatchObject({
      surface: "triage",
      mode: "shadow",
      outcome: "shadow",
      requestedRepositoryCount: 2,
      repositoryCount: 2,
      relationshipCount: 1,
      renderedChars: expect.any(Number),
      truncated: false,
    })
  })

  it("reads only the exact installation and immutable repository ids in on mode", async () => {
    expect((await replaceRepositoryContext(db, replacement("42", "alpha"))).status).toBe("updated")
    expect((await replaceRepositoryContext(db, replacement("84", "beta"))).status).toBe("updated")

    const promptBlock = await loadLinearRepositoryContext({
      env: { SIGILIX_PLATFORM_DB: db, OPENCLAW_REPOSITORY_CONTEXT_LINEAR_MODE: "on" } as Env,
      surface: "mention",
      installationId: 84,
      repositories: [
        { repositoryId: 101, fullName: "beta/api-live" },
        { repositoryId: 202, fullName: "beta/web-live" },
      ],
      enabled: true,
    })

    expect(promptBlock).toContain("[REPOSITORY CONTEXT — UNTRUSTED DATA]")
    expect(promptBlock).toContain("beta API owns auth")
    expect(promptBlock).toContain("beta web calls the API")
    expect(promptBlock).toContain('"name":"beta/api-live"')
    expect(promptBlock).toContain('"name":"beta/web-live"')
    expect(promptBlock).toContain("calls for sessions")
    expect(promptBlock).not.toMatch(/alpha|private context|conventions/)
  })

  it("does no D1 work when Linear codebase context is disabled", async () => {
    const prepare = vi.fn(() => {
      throw new Error("D1 must not be touched")
    })

    await expect(
      loadLinearRepositoryContext({
        env: {
          SIGILIX_PLATFORM_DB: { prepare } as unknown as D1Database,
          OPENCLAW_REPOSITORY_CONTEXT_LINEAR_MODE: "on",
        } as Env,
        surface: "mention",
        installationId: 42,
        repositories: [{ repositoryId: 101, fullName: "acme/api" }],
        enabled: false,
      }),
    ).resolves.toBe("")
    expect(prepare).not.toHaveBeenCalled()
  })

  it("emits an exact identifier-free Linear telemetry schema", async () => {
    expect((await replaceRepositoryContext(db, replacement("84", "beta"))).status).toBe("updated")
    log.mockClear()

    await loadLinearRepositoryContext({
      env: { SIGILIX_PLATFORM_DB: db, OPENCLAW_REPOSITORY_CONTEXT_LINEAR_MODE: "on" } as Env,
      surface: "mention",
      installationId: 84,
      repositories: [{ repositoryId: 101, fullName: "beta/api-live" }],
      enabled: true,
    })

    const events = telemetryEvents(log)
    expect(events).toHaveLength(1)
    expect(Object.keys(events[0]!)).toEqual([
      "event",
      "surface",
      "mode",
      "outcome",
      "elapsedMs",
      "requestedRepositoryCount",
      "repositoryCount",
      "relationshipCount",
      "renderedChars",
      "truncated",
    ])
    expect(JSON.stringify(events[0])).not.toMatch(
      /beta|api-live|scopeId|externalId|fullName|installationId|repositoryId|error/i,
    )
  })
})
