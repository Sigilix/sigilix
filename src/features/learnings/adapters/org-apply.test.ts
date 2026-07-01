import { afterEach, describe, expect, it, vi } from "vitest"
import { loadEffectiveLearnings } from "@/src/features/learnings/adapters/org-apply"
import { appendLearning, loadLearnings } from "@/src/features/learnings/adapters/store"
import { learningsKey } from "@/src/features/learnings/domain/store-ops"
import type { LearningEntry } from "@/src/features/learnings/domain/types"
import type { Env } from "@/src/shared/types/env"

const REPO_ID = 555000
const INSTALL_ID = 42
const MAP = JSON.stringify({ "octo/repo": INSTALL_ID })
const TS = Date.parse("2026-06-15T12:00:00.000Z")
const REPO_KEY = learningsKey("repo", String(REPO_ID))
const ORG_KEY = learningsKey("org", String(INSTALL_ID))

function makeEntry(id: string, over: Partial<LearningEntry> = {}): LearningEntry {
  return {
    id,
    rule: `rule-${id}`,
    polarity: "suppress",
    category: "style",
    pathGlob: null,
    scope: "repo",
    subjectId: String(REPO_ID),
    source: { kind: "command", prNumber: 1, commentId: 1 },
    createdTs: new Date(TS).toISOString(),
    appliedCount: 0,
    ...over,
  }
}

function makeEnv(over: Partial<Env> = {}): { env: Env; store: Map<string, string>; getCalls: string[] } {
  const store = new Map<string, string>()
  const getCalls: string[] = []
  const kv = {
    async get(key: string): Promise<string | null> {
      getCalls.push(key)
      return store.get(key) ?? null
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value)
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
  }
  const env = { OPENCLAW_STATE: kv, ...over } as unknown as Env
  return { env, store, getCalls }
}

// Entry A is mirrored into BOTH scopes (same id, as mirrorLearningToOrgScope
// produces). Entry B lives only in the org scope.
const ENTRY_A = makeEntry("aaa111", { rule: "repo + org rule", category: "style" })
const ENTRY_B = makeEntry("bbb222", { rule: "org-only rule", category: "performance" })

afterEach(() => vi.restoreAllMocks())

describe("loadEffectiveLearnings (Seat∪Org memory layering, Phase 2)", () => {
  it("flag OFF (default/unset) — repo-only, and NEVER reads the org keyspace", async () => {
    const { env, getCalls } = makeEnv({ OPENCLAW_GITHUB_INSTALLATION_MAP: MAP })
    // Populate BOTH stores with a resolvable installation, so an off-mode leak
    // would be observable.
    await appendLearning(env, "repo", String(REPO_ID), ENTRY_A, TS)
    await appendLearning(env, "org", String(INSTALL_ID), ENTRY_A, TS)
    await appendLearning(env, "org", String(INSTALL_ID), ENTRY_B, TS)

    getCalls.length = 0
    const out = await loadEffectiveLearnings({ env, owner: "octo", repo: "repo", repoId: REPO_ID, prNumber: 7 })

    // repo-only output, byte-identical to reading the repo store directly.
    const direct = await loadLearnings(env, "repo", String(REPO_ID))
    expect(out).toEqual(direct?.entries ?? [])
    expect(out.map((e) => e.id)).toEqual([ENTRY_A.id])
    // The org key was NEVER requested (no installation resolution, no org read).
    expect(getCalls).toContain(REPO_KEY)
    expect(getCalls).not.toContain(ORG_KEY)
  })

  it("flag OFF with empty repo store — returns [] and never touches the org key", async () => {
    const { env, getCalls } = makeEnv({ OPENCLAW_GITHUB_INSTALLATION_MAP: MAP })
    const out = await loadEffectiveLearnings({ env, owner: "octo", repo: "repo", repoId: REPO_ID })
    expect(out).toEqual([])
    expect(getCalls).not.toContain(ORG_KEY)
  })

  it("flag SHADOW — returns repo-only, logs the would-add delta (org-only id, not the dedup no-op)", async () => {
    const { env } = makeEnv({ OPENCLAW_ORG_MEMORY_APPLY: "shadow", OPENCLAW_GITHUB_INSTALLATION_MAP: MAP })
    await appendLearning(env, "repo", String(REPO_ID), ENTRY_A, TS)
    await appendLearning(env, "org", String(INSTALL_ID), ENTRY_A, TS) // dedup no-op
    await appendLearning(env, "org", String(INSTALL_ID), ENTRY_B, TS) // the real addition
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)

    const out = await loadEffectiveLearnings({ env, owner: "octo", repo: "repo", repoId: REPO_ID, prNumber: 7 })

    // Applied set is repo-only in shadow.
    expect(out.map((e) => e.id)).toEqual([ENTRY_A.id])
    const shadow = logSpy.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .find((e) => e.event === "org-learnings-apply-shadow")
    expect(shadow).toMatchObject({ mode: "shadow", orgSubjectId: INSTALL_ID, wouldAdd: 1 })
    expect(shadow.addedIds).toEqual([ENTRY_B.id]) // B only — A is a dedup no-op
    expect(shadow.addedIds).not.toContain(ENTRY_A.id)
    expect(shadow.addedCategories).toContain("performance")
  })

  it("flag ON — returns repo ∪ org deduped by id (repo copy wins, org-only appended)", async () => {
    const { env } = makeEnv({ OPENCLAW_ORG_MEMORY_APPLY: "on", OPENCLAW_GITHUB_INSTALLATION_MAP: MAP })
    await appendLearning(env, "repo", String(REPO_ID), ENTRY_A, TS)
    await appendLearning(env, "org", String(INSTALL_ID), ENTRY_A, TS)
    await appendLearning(env, "org", String(INSTALL_ID), ENTRY_B, TS)
    vi.spyOn(console, "log").mockImplementation(() => undefined)

    const out = await loadEffectiveLearnings({ env, owner: "octo", repo: "repo", repoId: REPO_ID, prNumber: 7 })

    // Order: repo entries first, then org-only additions. A appears exactly once.
    expect(out.map((e) => e.id)).toEqual([ENTRY_A.id, ENTRY_B.id])
    expect(out.filter((e) => e.id === ENTRY_A.id)).toHaveLength(1)
    // The surviving A copy is the REPO one (repo wins a collision).
    expect(out[0]?.scope).toBe("repo")
    expect(out[1]?.scope).toBe("org")
  })

  it("flag ON + unresolvable installation (no map entry) — falls back to repo-only, logs a skip, no throw", async () => {
    const { env } = makeEnv({
      OPENCLAW_ORG_MEMORY_APPLY: "on",
      OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ "some-other/repo": 99 }),
    })
    await appendLearning(env, "repo", String(REPO_ID), ENTRY_A, TS)
    // Org corpus exists but is unreachable without a resolvable installation.
    await appendLearning(env, "org", String(INSTALL_ID), ENTRY_B, TS)
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)

    const out = await loadEffectiveLearnings({ env, owner: "octo", repo: "repo", repoId: REPO_ID, prNumber: 7 })

    expect(out.map((e) => e.id)).toEqual([ENTRY_A.id]) // repo-only, B never merged
    const skip = logSpy.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .find((e) => e.event === "org-learnings-apply-skipped")
    expect(skip).toMatchObject({ mode: "on", reason: "no_installation" })
  })

  it("flag ON + org store read throwing — degrades to repo-only, never throws", async () => {
    const store = new Map<string, string>()
    const kv = {
      async get(key: string): Promise<string | null> {
        if (key === ORG_KEY) throw new Error("org kv down")
        return store.get(key) ?? null
      },
      async put(key: string, value: string): Promise<void> {
        store.set(key, value)
      },
      async delete(key: string): Promise<void> {
        store.delete(key)
      },
    }
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_ORG_MEMORY_APPLY: "on",
      OPENCLAW_GITHUB_INSTALLATION_MAP: MAP,
    } as unknown as Env
    await appendLearning(env, "repo", String(REPO_ID), ENTRY_A, TS)
    vi.spyOn(console, "log").mockImplementation(() => undefined)

    const out = await loadEffectiveLearnings({ env, owner: "octo", repo: "repo", repoId: REPO_ID, prNumber: 7 })
    expect(out.map((e) => e.id)).toEqual([ENTRY_A.id]) // repo-only, no throw
  })

  it("flag ON + an unexpected throw in the org path — caught, logs -failed, returns repo-only", async () => {
    const { env } = makeEnv({ OPENCLAW_ORG_MEMORY_APPLY: "on" })
    await appendLearning(env, "repo", String(REPO_ID), ENTRY_A, TS)
    // Force the outer try/catch: reading the installation map throws.
    Object.defineProperty(env, "OPENCLAW_GITHUB_INSTALLATION_MAP", {
      get() {
        throw new Error("boom")
      },
    })
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)

    const out = await loadEffectiveLearnings({ env, owner: "octo", repo: "repo", repoId: REPO_ID, prNumber: 7 })
    expect(out.map((e) => e.id)).toEqual([ENTRY_A.id])
    const failed = logSpy.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .find((e) => e.event === "org-learnings-apply-failed")
    expect(failed).toMatchObject({ mode: "on" })
  })

  it("flag ON + empty repo AND empty org — returns [], no throw", async () => {
    const { env } = makeEnv({ OPENCLAW_ORG_MEMORY_APPLY: "on", OPENCLAW_GITHUB_INSTALLATION_MAP: MAP })
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const out = await loadEffectiveLearnings({ env, owner: "octo", repo: "repo", repoId: REPO_ID })
    expect(out).toEqual([])
  })
})
