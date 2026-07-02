import { describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { upsertTenantAndRepo } from "@/src/features/tenancy"
import { mirrorLearningToOrgScope } from "@/src/features/learnings/adapters/org-mirror"
import { learningsKey } from "@/src/features/learnings/domain/store-ops"
import type { LearningEntry } from "@/src/features/learnings/domain/types"
import type { Env } from "@/src/shared/types/env"

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url),
  "utf8",
)

const CREATED_TS = "2026-06-15T12:00:00.000Z"

const ENTRY: LearningEntry = {
  id: "abc123",
  rule: "prefer named exports",
  polarity: "require",
  category: "style",
  pathGlob: null,
  scope: "repo",
  subjectId: "555000",
  source: { kind: "inline-reply", prNumber: 7, commentId: 100 },
  createdTs: CREATED_TS,
  appliedCount: 0,
  authorLogin: "octocat",
  type: "durable_preference",
  lifespanAnchor: { kind: "durable" },
}

function makeEnv(over: Partial<Env> = {}): { env: Env; store: Map<string, string> } {
  const store = new Map<string, string>()
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value)
    },
  }
  const env = {
    OPENCLAW_STATE: kv,
    ...over,
  } as unknown as Env
  return { env, store }
}

describe("mirrorLearningToOrgScope (Seat∪Org memory layering, Phase 1)", () => {
  it("flag off (default/unset) — no installation resolution, no KV write at all", async () => {
    const { env, store } = makeEnv({
      OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ "octo/repo": 42 }),
    })
    await mirrorLearningToOrgScope({ env, owner: "octo", repo: "repo", entry: ENTRY })
    expect(store.size).toBe(0)
  })

  it("flag on + resolvable installation — writes an org-scope entry with taxonomy fields preserved", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const { env, store } = makeEnv({
      OPENCLAW_ORG_MEMORY_CAPTURE: "on",
      OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ "octo/repo": 42 }),
    })
    await mirrorLearningToOrgScope({ env, owner: "octo", repo: "repo", entry: ENTRY })

    const orgKey = learningsKey("org", "42")
    expect(store.has(orgKey)).toBe(true)
    const orgStore = JSON.parse(store.get(orgKey)!)
    expect(orgStore.scope).toBe("org")
    expect(orgStore.subjectId).toBe("42")
    expect(orgStore.entries).toHaveLength(1)
    const mirrored = orgStore.entries[0]
    expect(mirrored.id).toBe(ENTRY.id)
    expect(mirrored.scope).toBe("org")
    expect(mirrored.subjectId).toBe("42")
    expect(mirrored.rule).toBe(ENTRY.rule)
    expect(mirrored.type).toBe(ENTRY.type)
    expect(mirrored.lifespanAnchor).toEqual(ENTRY.lifespanAnchor)
    expect(mirrored.polarity).toBe(ENTRY.polarity)

    // Never touches the repo-scope keyspace — this write is purely additive.
    expect(store.has(learningsKey("repo", ENTRY.subjectId))).toBe(false)
    consoleSpy.mockRestore()
  })

  it("flag on + owner-only installation-map fallback also resolves", async () => {
    const { env, store } = makeEnv({
      OPENCLAW_ORG_MEMORY_CAPTURE: "on",
      OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ octo: 99 }),
    })
    await mirrorLearningToOrgScope({ env, owner: "octo", repo: "repo", entry: ENTRY })
    expect(store.has(learningsKey("org", "99"))).toBe(true)
  })

  it("flag on + unresolvable installation (no map entry) — skips silently, never throws", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const { env, store } = makeEnv({
      OPENCLAW_ORG_MEMORY_CAPTURE: "on",
      OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ "some-other/repo": 42 }),
    })
    await expect(mirrorLearningToOrgScope({ env, owner: "octo", repo: "repo", entry: ENTRY })).resolves.toBeUndefined()
    expect(store.size).toBe(0)
    consoleSpy.mockRestore()
  })

  it("flag on + missing/malformed OPENCLAW_GITHUB_INSTALLATION_MAP — skips silently, never throws", async () => {
    const { env, store } = makeEnv({ OPENCLAW_ORG_MEMORY_CAPTURE: "on" })
    await expect(mirrorLearningToOrgScope({ env, owner: "octo", repo: "repo", entry: ENTRY })).resolves.toBeUndefined()
    expect(store.size).toBe(0)
  })

  it("flag on + KV put throws — swallowed, never propagates", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const kv = {
      async get(): Promise<string | null> {
        return null
      },
      async put(): Promise<void> {
        throw new Error("kv unavailable")
      },
    }
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_ORG_MEMORY_CAPTURE: "on",
      OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ "octo/repo": 42 }),
    } as unknown as Env
    await expect(mirrorLearningToOrgScope({ env, owner: "octo", repo: "repo", entry: ENTRY })).resolves.toBeUndefined()
    consoleSpy.mockRestore()
  })

  // ── D1-first installation resolution (the prod bug fix) ────────────────
  // Prod had OPENCLAW_ORG_MEMORY_CAPTURE="on" but NO OPENCLAW_GITHUB_INSTALLATION_MAP
  // entries at all — so the old env-var-only lookup always returned `no_installation`
  // and `learnings:org:*` stayed at 0 keys forever, even with 47 real repo-scope
  // learnings captured. The live D1 `repo` registry (populated by every real PR
  // webhook via `upsertTenantAndRepo`) is the fix: it is authoritative for any repo
  // this mirror ever fires for.
  describe("D1-first installation resolution", () => {
    async function makeDbWithRepo(installationId: number, fullName: string): Promise<D1Database> {
      const db = makeD1()
      await db.exec(MIGRATION_SQL)
      await upsertTenantAndRepo(
        { SIGILIX_PLATFORM_DB: db },
        { installationId, repoId: 1225209204, fullName, nowIso: "2026-01-01T00:00:00Z" },
      )
      return db
    }

    it("D1 repo row resolves the installation — writes org-scope entry with NO installation-map entry at all (the prod fix)", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
      const db = await makeDbWithRepo(134_811_639, "octo/repo")
      const { env, store } = makeEnv({
        OPENCLAW_ORG_MEMORY_CAPTURE: "on",
        SIGILIX_PLATFORM_DB: db,
        // No OPENCLAW_GITHUB_INSTALLATION_MAP at all — matches prod.
      })
      await mirrorLearningToOrgScope({ env, owner: "octo", repo: "repo", entry: ENTRY })

      const orgKey = learningsKey("org", "134811639")
      expect(store.has(orgKey)).toBe(true)
      const orgStore = JSON.parse(store.get(orgKey)!)
      expect(orgStore.entries).toHaveLength(1)
      consoleSpy.mockRestore()
    })

    it("D1 row takes precedence over a conflicting OPENCLAW_GITHUB_INSTALLATION_MAP entry", async () => {
      const db = await makeDbWithRepo(42, "octo/repo")
      const { env, store } = makeEnv({
        OPENCLAW_ORG_MEMORY_CAPTURE: "on",
        SIGILIX_PLATFORM_DB: db,
        OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ "octo/repo": 999 }),
      })
      await mirrorLearningToOrgScope({ env, owner: "octo", repo: "repo", entry: ENTRY })
      expect(store.has(learningsKey("org", "42"))).toBe(true)
      expect(store.has(learningsKey("org", "999"))).toBe(false)
    })

    it("D1 binding present but repo not yet registered (no row) — falls back to the env-var map", async () => {
      const db = makeD1()
      await db.exec(MIGRATION_SQL)
      const { env, store } = makeEnv({
        OPENCLAW_ORG_MEMORY_CAPTURE: "on",
        SIGILIX_PLATFORM_DB: db,
        OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ "octo/repo": 42 }),
      })
      await mirrorLearningToOrgScope({ env, owner: "octo", repo: "repo", entry: ENTRY })
      expect(store.has(learningsKey("org", "42"))).toBe(true)
    })

    it("D1 query throws (genuine outage) — fails soft, falls back to the env-var map, never throws", async () => {
      const brokenDb = {
        prepare() {
          throw new Error("simulated D1 error")
        },
      } as unknown as D1Database
      const { env, store } = makeEnv({
        OPENCLAW_ORG_MEMORY_CAPTURE: "on",
        SIGILIX_PLATFORM_DB: brokenDb,
        OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ "octo/repo": 42 }),
      })
      await expect(
        mirrorLearningToOrgScope({ env, owner: "octo", repo: "repo", entry: ENTRY }),
      ).resolves.toBeUndefined()
      expect(store.has(learningsKey("org", "42"))).toBe(true)
    })

    it("D1 query throws AND no env-var map — skips silently, never throws", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
      const brokenDb = {
        prepare() {
          throw new Error("simulated D1 error")
        },
      } as unknown as D1Database
      const { env, store } = makeEnv({ OPENCLAW_ORG_MEMORY_CAPTURE: "on", SIGILIX_PLATFORM_DB: brokenDb })
      await expect(
        mirrorLearningToOrgScope({ env, owner: "octo", repo: "repo", entry: ENTRY }),
      ).resolves.toBeUndefined()
      expect(store.size).toBe(0)
      consoleSpy.mockRestore()
    })
  })
})
