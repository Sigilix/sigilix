// runMemoryDecayPass — the bounded, cron-facing Gardener orchestrator. Verifies:
// default-OFF = zero side effects; shadow logs but archives nothing; enforce
// tombstones ONLY eligible ephemerals (durable/legacy untouched); PR-lookup
// memoization + the two per-tick caps; and fail-soft repo-unknown handling.
//
// Only the GitHub network primitives are mocked (house style, cf.
// index-reconciliation.test.ts); the learnings store, archive adapter,
// repo-tenant resolution, and the pure decay gate all run for real against a
// fake KV.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { resolveRepoInstallationIdMock, getInstallationTokenMock, getPullRequestMock } = vi.hoisted(() => ({
  resolveRepoInstallationIdMock: vi.fn(),
  getInstallationTokenMock: vi.fn(),
  getPullRequestMock: vi.fn(),
}))

vi.mock("@/src/shared/adapters/github/github-app", () => ({
  resolveRepoInstallationId: resolveRepoInstallationIdMock,
  getInstallationToken: getInstallationTokenMock,
}))

vi.mock("@/src/shared/adapters/github", async (importActual) => {
  const actual = await importActual<typeof import("@/src/shared/adapters/github")>()
  class FakeGitHubClient {
    getPullRequest = getPullRequestMock
  }
  return { ...actual, GitHubClient: FakeGitHubClient }
})

import { MAX_PR_LOOKUPS_PER_TICK, MAX_LEARNINGS_KEYS_PER_TICK, runMemoryDecayPass } from "@/src/lib/memory-decay"
import { loadArchivedLearnings } from "@/src/features/learnings"
import { learningsKey } from "@/src/features/learnings/domain/store-ops"
import type { LearningEntry, LearningStore } from "@/src/features/learnings/domain/types"
import { repoTenantKey } from "@/src/lib/repo-index-manifest"
import type { Env } from "@/src/shared/types/env"

const NOW = Date.parse("2026-06-30T12:00:00.000Z")
const DAY_MS = 24 * 60 * 60 * 1000
const closedDaysAgo = (d: number) => new Date(NOW - d * DAY_MS).toISOString()

function entry(overrides: Partial<LearningEntry> = {}): LearningEntry {
  return {
    id: overrides.id ?? "l1",
    rule: overrides.rule ?? "rule text",
    polarity: overrides.polarity ?? "context",
    category: overrides.category ?? null,
    pathGlob: overrides.pathGlob ?? null,
    scope: overrides.scope ?? "repo",
    subjectId: overrides.subjectId ?? "123",
    source: overrides.source ?? { kind: "top-level", prNumber: 7 },
    createdTs: overrides.createdTs ?? "2026-05-01T00:00:00.000Z",
    appliedCount: overrides.appliedCount ?? 0,
    ...(overrides.type !== undefined ? { type: overrides.type } : {}),
    ...(overrides.lifespanAnchor !== undefined ? { lifespanAnchor: overrides.lifespanAnchor } : {}),
  }
}

function repoStore(subjectId: string, entries: LearningEntry[]): LearningStore {
  return { schemaVersion: 1, scope: "repo", subjectId, entries }
}

function manifestJson(owner: string, repo: string): string {
  return JSON.stringify({
    v: 1,
    repo,
    owner,
    headSha: "h",
    runId: "run",
    fileCount: 0,
    chunkCount: 0,
    shardCount: 1,
    indexedAt: "2026-05-22T00:00:00Z",
    modelId: "m",
    embeddingDim: 768,
    chunkerVersion: 1,
    windowLines: 80,
    overlapLines: 16,
  })
}

/** Fake KV with call counters + prefix-aware list truncation. */
function makeEnv(mode?: string) {
  const values = new Map<string, string>()
  const counts = { list: 0, get: 0, put: 0 }
  const kv = {
    async get(key: string): Promise<string | null> {
      counts.get += 1
      return values.get(key) ?? null
    },
    async put(key: string, value: string): Promise<void> {
      counts.put += 1
      values.set(key, value)
    },
    async delete(key: string): Promise<void> {
      values.delete(key)
    },
    async list(options: { prefix?: string; limit?: number }): Promise<{
      keys: Array<{ name: string }>
      list_complete: boolean
      cursor?: string
    }> {
      counts.list += 1
      const prefix = options.prefix ?? ""
      const limit = options.limit ?? 1000
      const matched = [...values.keys()].filter((k) => k.startsWith(prefix)).sort()
      const page = matched.slice(0, limit)
      return { keys: page.map((name) => ({ name })), list_complete: page.length === matched.length }
    },
  }
  const env = {
    OPENCLAW_STATE: kv,
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "k",
    ...(mode !== undefined ? { OPENCLAW_MEMORY_DECAY_MODE: mode } : {}),
  } as unknown as Env
  return { env, values, counts }
}

function logEvents(spy: ReturnType<typeof vi.spyOn>, event: string): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((c) => {
      try {
        return JSON.parse(c[0] as string) as Record<string, unknown>
      } catch {
        return {}
      }
    })
    .filter((o) => o.event === event)
}

beforeEach(() => {
  resolveRepoInstallationIdMock.mockReset().mockResolvedValue(555)
  getInstallationTokenMock.mockReset().mockResolvedValue("tok")
  getPullRequestMock.mockReset()
})
afterEach(() => vi.restoreAllMocks())

describe("runMemoryDecayPass", () => {
  it("default OFF (env unset): returns instantly with ZERO side effects", async () => {
    const { env, counts } = makeEnv(undefined)
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)

    const summary = await runMemoryDecayPass(env, { nowMs: NOW })

    expect(summary.mode).toBe("off")
    expect(summary).toMatchObject({ keysScanned: 0, entriesScanned: 0, eligible: 0, archived: 0, prLookupsUsed: 0 })
    // No KV touch, no GitHub call, no logs.
    expect(counts.list).toBe(0)
    expect(counts.get).toBe(0)
    expect(counts.put).toBe(0)
    expect(getPullRequestMock).not.toHaveBeenCalled()
    expect(resolveRepoInstallationIdMock).not.toHaveBeenCalled()
    expect(logSpy).not.toHaveBeenCalled()
  })

  it("shadow: logs each would-reap but archives NOTHING; durable + legacy untouched", async () => {
    const { env, values } = makeEnv("shadow")
    values.set(repoTenantKey(123), manifestJson("Sigilix", "boreas"))
    const durable = entry({ id: "durable", type: "durable_preference", lifespanAnchor: { kind: "durable" } })
    const legacy = entry({ id: "legacy" }) // no type/anchor
    const openPr = entry({ id: "open", type: "transient_feedback", lifespanAnchor: { kind: "pr", prNumber: 8 } })
    const stale = entry({ id: "stale", type: "ephemeral_project", lifespanAnchor: { kind: "pr", prNumber: 7 } })
    values.set(learningsKey("repo", "123"), JSON.stringify(repoStore("123", [durable, legacy, openPr, stale])))
    getPullRequestMock.mockImplementation(async (_o: string, _r: string, n: number) => ({
      number: n,
      title: "t",
      body: null,
      user: null,
      head: { sha: "h", ref: "r" },
      base: { sha: "b", ref: "main" },
      state: n === 7 ? "closed" : "open",
      closed_at: n === 7 ? closedDaysAgo(30) : null,
    }))
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)

    const summary = await runMemoryDecayPass(env, { nowMs: NOW })

    expect(summary.eligible).toBe(1)
    expect(summary.archived).toBe(0)
    // Only the stale ephemeral is a would-reap; durable/legacy never even looked up.
    const shadow = logEvents(logSpy, "memory-decay-shadow")
    expect(shadow).toHaveLength(1)
    expect(shadow[0]).toMatchObject({ learningId: "stale", type: "ephemeral_project", prNumber: 7 })
    // Active store byte-unchanged; no tombstone written.
    expect(await loadArchivedLearnings(env, "repo", "123")).toBeNull()
    const active = JSON.parse(values.get(learningsKey("repo", "123")) as string) as LearningStore
    expect(active.entries.map((e) => e.id)).toEqual(["durable", "legacy", "open", "stale"])
  })

  it("enforce: tombstones ONLY the eligible ephemeral; durable/legacy/open stay active", async () => {
    const { env, values } = makeEnv("enforce")
    values.set(repoTenantKey(123), manifestJson("Sigilix", "boreas"))
    const durable = entry({ id: "durable", type: "durable_preference", lifespanAnchor: { kind: "durable" } })
    const legacy = entry({ id: "legacy" })
    const openPr = entry({ id: "open", type: "ephemeral_project", lifespanAnchor: { kind: "pr", prNumber: 8 } })
    const stale = entry({ id: "stale", type: "ephemeral_project", lifespanAnchor: { kind: "pr", prNumber: 7 } })
    values.set(learningsKey("repo", "123"), JSON.stringify(repoStore("123", [durable, legacy, openPr, stale])))
    getPullRequestMock.mockImplementation(async (_o: string, _r: string, n: number) => ({
      number: n,
      title: "t",
      body: null,
      user: null,
      head: { sha: "h", ref: "r" },
      base: { sha: "b", ref: "main" },
      state: n === 7 ? "closed" : "open",
      closed_at: n === 7 ? closedDaysAgo(30) : null,
    }))
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)

    const summary = await runMemoryDecayPass(env, { nowMs: NOW })

    expect(summary).toMatchObject({ eligible: 1, archived: 1, archiveFailed: 0 })
    // Active store: the reaped ephemeral is gone; everything else remains.
    const active = JSON.parse(values.get(learningsKey("repo", "123")) as string) as LearningStore
    expect(active.entries.map((e) => e.id)).toEqual(["durable", "legacy", "open"])
    // Tombstone holds the reaped entry, stamped + readable.
    const archived = await loadArchivedLearnings(env, "repo", "123")
    expect(archived?.entries.map((e) => e.id)).toEqual(["stale"])
    expect(typeof archived?.entries[0]?.archivedTs).toBe("string")
    // One auditable archived event carrying the id.
    const archivedEvents = logEvents(logSpy, "memory-decay-archived")
    expect(archivedEvents).toHaveLength(1)
    expect(archivedEvents[0]).toMatchObject({ learningId: "stale", prNumber: 7 })
  })

  it("memoizes the PR lookup: two ephemerals on the SAME pr → ONE getPullRequest call", async () => {
    const { env, values } = makeEnv("shadow")
    values.set(repoTenantKey(123), manifestJson("Sigilix", "boreas"))
    values.set(
      learningsKey("repo", "123"),
      JSON.stringify(
        repoStore("123", [
          entry({ id: "a", type: "ephemeral_project", lifespanAnchor: { kind: "pr", prNumber: 7 } }),
          entry({ id: "b", type: "transient_feedback", lifespanAnchor: { kind: "pr", prNumber: 7 } }),
        ]),
      ),
    )
    getPullRequestMock.mockResolvedValue({
      number: 7,
      title: "t",
      body: null,
      user: null,
      head: { sha: "h", ref: "r" },
      base: { sha: "b", ref: "main" },
      state: "closed",
      closed_at: closedDaysAgo(30),
    })
    vi.spyOn(console, "log").mockImplementation(() => undefined)

    const summary = await runMemoryDecayPass(env, { nowMs: NOW })

    expect(summary.eligible).toBe(2)
    expect(summary.prLookupsUsed).toBe(1)
    expect(getPullRequestMock).toHaveBeenCalledTimes(1)
  })

  it("repo unknown (no repo-tenant manifest): candidate kept, NO lookup, not counted against the cap", async () => {
    const { env, values } = makeEnv("enforce")
    // NOTE: no repoTenantKey(123) seeded → owner/repo unresolvable.
    values.set(
      learningsKey("repo", "123"),
      JSON.stringify(
        repoStore("123", [entry({ id: "x", type: "ephemeral_project", lifespanAnchor: { kind: "pr", prNumber: 7 } })]),
      ),
    )
    vi.spyOn(console, "log").mockImplementation(() => undefined)

    const summary = await runMemoryDecayPass(env, { nowMs: NOW })

    expect(summary.candidates).toBe(1)
    expect(summary.prLookupsUsed).toBe(0)
    expect(summary.eligible).toBe(0)
    expect(summary.archived).toBe(0)
    expect(getPullRequestMock).not.toHaveBeenCalled()
  })

  it("malformed pr anchor (missing / non-positive prNumber): pre-filtered out, NO candidate, NO lookup", async () => {
    // The store loader does NOT shape-validate lifespanAnchor, so a persisted
    // `{kind:"pr"}` with a missing / zero / negative prNumber can load. It must
    // skip WITHOUT a lookup (not burn a slot on `/pulls/undefined`) and never reap.
    const { env, values } = makeEnv("enforce")
    values.set(repoTenantKey(123), manifestJson("Sigilix", "boreas"))
    values.set(
      learningsKey("repo", "123"),
      JSON.stringify(
        repoStore("123", [
          // Missing prNumber (bypass the compile-time type — models a corrupt record).
          entry({ id: "no-num", type: "ephemeral_project", lifespanAnchor: { kind: "pr" } as never }),
          entry({ id: "zero", type: "ephemeral_project", lifespanAnchor: { kind: "pr", prNumber: 0 } }),
          entry({ id: "neg", type: "ephemeral_project", lifespanAnchor: { kind: "pr", prNumber: -3 } }),
        ]),
      ),
    )
    vi.spyOn(console, "log").mockImplementation(() => undefined)

    const summary = await runMemoryDecayPass(env, { nowMs: NOW })

    expect(summary.candidates).toBe(0)
    expect(summary.prLookupsUsed).toBe(0)
    expect(summary.eligible).toBe(0)
    expect(summary.archived).toBe(0)
    expect(getPullRequestMock).not.toHaveBeenCalled()
  })

  it("enforces the PR-lookup cap: skips past MAX_PR_LOOKUPS_PER_TICK, logs one truncation event", async () => {
    const { env, values } = makeEnv("shadow")
    values.set(repoTenantKey(123), manifestJson("Sigilix", "boreas"))
    const overCap = MAX_PR_LOOKUPS_PER_TICK + 10
    const entries = Array.from({ length: overCap }, (_, i) =>
      entry({ id: `e${i}`, type: "ephemeral_project", lifespanAnchor: { kind: "pr", prNumber: 1000 + i } }),
    )
    values.set(learningsKey("repo", "123"), JSON.stringify(repoStore("123", entries)))
    getPullRequestMock.mockImplementation(async (_o: string, _r: string, n: number) => ({
      number: n,
      title: "t",
      body: null,
      user: null,
      head: { sha: "h", ref: "r" },
      base: { sha: "b", ref: "main" },
      state: "closed",
      closed_at: closedDaysAgo(30),
    }))
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)

    const summary = await runMemoryDecayPass(env, { nowMs: NOW })

    expect(summary.prLookupsUsed).toBe(MAX_PR_LOOKUPS_PER_TICK)
    expect(summary.eligible).toBe(MAX_PR_LOOKUPS_PER_TICK)
    expect(summary.prLookupCapReached).toBe(true)
    const trunc = logEvents(logSpy, "memory-decay-tick-truncated").filter((o) => o.reason === "pr-lookup-cap")
    expect(trunc).toHaveLength(1)
    expect(trunc[0]).toMatchObject({ entriesSkipped: 10, cap: MAX_PR_LOOKUPS_PER_TICK })
  })

  it("enforces the key-list cap: truncated scan is flagged + logged", async () => {
    const { env, values } = makeEnv("shadow")
    const overCap = MAX_LEARNINGS_KEYS_PER_TICK + 1
    for (let i = 0; i < overCap; i++) {
      values.set(learningsKey("repo", String(i)), JSON.stringify(repoStore(String(i), [])))
    }
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)

    const summary = await runMemoryDecayPass(env, { nowMs: NOW })

    expect(summary.keyListTruncated).toBe(true)
    expect(summary.keysScanned).toBe(MAX_LEARNINGS_KEYS_PER_TICK)
    const trunc = logEvents(logSpy, "memory-decay-tick-truncated").filter((o) => o.reason === "key-list")
    expect(trunc).toHaveLength(1)
  })

  it("ignores non-repo scopes and archive keys, and skips a below-window ephemeral", async () => {
    const { env, values } = makeEnv("enforce")
    values.set(repoTenantKey(123), manifestJson("Sigilix", "boreas"))
    // An org-scope store (no githubRepoId resolution path) — must be skipped, no lookup.
    values.set(
      learningsKey("org", "sigilix"),
      JSON.stringify({
        schemaVersion: 1,
        scope: "org",
        subjectId: "sigilix",
        entries: [
          entry({
            id: "o",
            scope: "org",
            subjectId: "sigilix",
            type: "ephemeral_project",
            lifespanAnchor: { kind: "pr", prNumber: 7 },
          }),
        ],
      }),
    )
    // A pre-existing tombstone must NOT be re-scanned as an active store.
    values.set("learnings-archive:repo:123", JSON.stringify(repoStore("123", [])))
    // A fresh (< window) ephemeral → kept.
    values.set(
      learningsKey("repo", "123"),
      JSON.stringify(
        repoStore("123", [
          entry({ id: "fresh", type: "ephemeral_project", lifespanAnchor: { kind: "pr", prNumber: 7 } }),
        ]),
      ),
    )
    getPullRequestMock.mockResolvedValue({
      number: 7,
      title: "t",
      body: null,
      user: null,
      head: { sha: "h", ref: "r" },
      base: { sha: "b", ref: "main" },
      state: "closed",
      closed_at: closedDaysAgo(5),
    })
    vi.spyOn(console, "log").mockImplementation(() => undefined)

    const summary = await runMemoryDecayPass(env, { nowMs: NOW })

    // Two active learnings: keys (org + repo). The archive key is NOT a learnings: key.
    expect(summary.keysScanned).toBe(2)
    // org candidate is pre-filtered out (no lookup); repo candidate looked up but kept (5d < 21d).
    expect(summary.prLookupsUsed).toBe(1)
    expect(summary.eligible).toBe(0)
    expect(summary.archived).toBe(0)
  })
})
