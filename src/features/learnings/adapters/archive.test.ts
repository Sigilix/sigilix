import { describe, expect, it, vi } from "vitest"

import { archiveLearningEntries, loadArchivedLearnings } from "./archive"
import { learningsArchiveKey, learningsKey } from "@/src/features/learnings/domain/store-ops"
import type { LearningEntry, LearningStore } from "@/src/features/learnings/domain/types"
import type { Env } from "@/src/shared/types/env"

const TS = "2026-06-30T12:00:00.000Z"
const ARCHIVED_TS = "2026-06-30T18:00:00.000Z"

function entry(overrides: Partial<LearningEntry> = {}): LearningEntry {
  return {
    id: overrides.id ?? "l1",
    rule: overrides.rule ?? "Prefer service-layer database access.",
    polarity: overrides.polarity ?? "context",
    category: overrides.category ?? null,
    pathGlob: overrides.pathGlob ?? null,
    scope: overrides.scope ?? "repo",
    subjectId: overrides.subjectId ?? "123",
    source: overrides.source ?? { kind: "top-level", prNumber: 7 },
    createdTs: overrides.createdTs ?? TS,
    appliedCount: overrides.appliedCount ?? 0,
    ...(overrides.type !== undefined ? { type: overrides.type } : {}),
    ...(overrides.lifespanAnchor !== undefined ? { lifespanAnchor: overrides.lifespanAnchor } : {}),
  }
}

function store(entries: LearningEntry[]): LearningStore {
  return { schemaVersion: 1, scope: "repo", subjectId: "123", entries }
}

/** Fake KV backed by a Map; `throwOnPut` fails puts whose key includes a token. */
function makeEnv(opts: { throwOnPut?: string } = {}) {
  const values = new Map<string, string>()
  const kv = {
    async get(key: string): Promise<string | null> {
      return values.get(key) ?? null
    },
    async put(key: string, value: string): Promise<void> {
      if (opts.throwOnPut !== undefined && key.includes(opts.throwOnPut)) {
        throw new Error(`kv put blocked for ${key}`)
      }
      values.set(key, value)
    },
    async delete(key: string): Promise<void> {
      values.delete(key)
    },
  }
  return { env: { OPENCLAW_STATE: kv } as unknown as Env, values }
}

describe("archiveLearningEntries", () => {
  it("tombstones an entry then removes it from the active store (round-trip readable)", async () => {
    const { env, values } = makeEnv()
    const keep = entry({ id: "keep", rule: "keep me" })
    const reap = entry({
      id: "reap",
      rule: "reap me",
      type: "ephemeral_project",
      lifespanAnchor: { kind: "pr", prNumber: 7 },
    })
    values.set(learningsKey("repo", "123"), JSON.stringify(store([keep, reap])))

    const ok = await archiveLearningEntries(env, "repo", "123", [reap], ARCHIVED_TS)
    expect(ok).toBe(true)

    // Active store no longer holds the reaped entry (keeps the other).
    const active = JSON.parse(values.get(learningsKey("repo", "123")) as string) as LearningStore
    expect(active.entries.map((e) => e.id)).toEqual(["keep"])

    // Tombstone is present, readable, and stamped with archivedTs.
    const archived = await loadArchivedLearnings(env, "repo", "123")
    expect(archived?.entries).toHaveLength(1)
    expect(archived?.entries[0]).toMatchObject({ id: "reap", rule: "reap me", archivedTs: ARCHIVED_TS })
  })

  it("appends to an existing tombstone across calls (never a hard delete, no TTL)", async () => {
    const { env, values } = makeEnv()
    values.set(learningsKey("repo", "123"), JSON.stringify(store([entry({ id: "a" }), entry({ id: "b" })])))
    await archiveLearningEntries(env, "repo", "123", [entry({ id: "a" })], ARCHIVED_TS)
    await archiveLearningEntries(env, "repo", "123", [entry({ id: "b" })], ARCHIVED_TS)
    const archived = await loadArchivedLearnings(env, "repo", "123")
    expect(archived?.entries.map((e) => e.id)).toEqual(["a", "b"])
    // The active store is now empty; the tombstone holds both.
    expect((JSON.parse(values.get(learningsKey("repo", "123")) as string) as LearningStore).entries).toHaveLength(0)
  })

  it("archive-FIRST ordering: an archive-write failure leaves the entry in the ACTIVE store (returns false)", async () => {
    const { env, values } = makeEnv({ throwOnPut: "learnings-archive:" })
    const reap = entry({ id: "reap" })
    values.set(learningsKey("repo", "123"), JSON.stringify(store([reap])))

    const ok = await archiveLearningEntries(env, "repo", "123", [reap], ARCHIVED_TS)
    expect(ok).toBe(false)
    // Active store UNTOUCHED (entry not removed) — no archive, no removal.
    const active = JSON.parse(values.get(learningsKey("repo", "123")) as string) as LearningStore
    expect(active.entries.map((e) => e.id)).toEqual(["reap"])
    // No tombstone was written.
    expect(values.has(learningsArchiveKey("repo", "123"))).toBe(false)
  })

  it("a removal failure AFTER a successful archive leaves the entry in BOTH places (returns false, recoverable)", async () => {
    const { env, values } = makeEnv({ throwOnPut: "learnings:repo" })
    const reap = entry({ id: "reap" })
    values.set(learningsKey("repo", "123"), JSON.stringify(store([reap])))

    const ok = await archiveLearningEntries(env, "repo", "123", [reap], ARCHIVED_TS)
    expect(ok).toBe(false)
    // Tombstone LANDED (archive is first + succeeded)...
    const archived = await loadArchivedLearnings(env, "repo", "123")
    expect(archived?.entries.map((e) => e.id)).toEqual(["reap"])
    // ...and the active store still holds it (removal put was blocked) — safe.
    const active = JSON.parse(values.get(learningsKey("repo", "123")) as string) as LearningStore
    expect(active.entries.map((e) => e.id)).toEqual(["reap"])
  })

  it("returns true and writes nothing for an empty batch", async () => {
    const { env, values } = makeEnv()
    expect(await archiveLearningEntries(env, "repo", "123", [], ARCHIVED_TS)).toBe(true)
    expect(values.size).toBe(0)
  })

  it("loadArchivedLearnings returns null when no tombstone exists", async () => {
    const { env } = makeEnv()
    expect(await loadArchivedLearnings(env, "repo", "123")).toBeNull()
  })

  it("dedups by id on re-archive: the tombstone never accumulates duplicates (last-write-wins)", async () => {
    const { env } = makeEnv()
    await archiveLearningEntries(env, "repo", "123", [entry({ id: "dup", rule: "v1" })], ARCHIVED_TS)
    // Re-archive the SAME id (the retry path) with updated content + a later stamp.
    const laterTs = "2026-07-01T00:00:00.000Z"
    await archiveLearningEntries(env, "repo", "123", [entry({ id: "dup", rule: "v2" })], laterTs)
    const archived = await loadArchivedLearnings(env, "repo", "123")
    expect(archived?.entries).toHaveLength(1)
    expect(archived?.entries[0]).toMatchObject({ id: "dup", rule: "v2", archivedTs: laterTs })
  })

  it("logs learnings-archive-corrupt when an existing tombstone is unparseable, then overwrites it", async () => {
    const { env, values } = makeEnv()
    values.set(learningsArchiveKey("repo", "123"), "{not valid json")
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)

    const ok = await archiveLearningEntries(env, "repo", "123", [entry({ id: "z" })], ARCHIVED_TS)
    expect(ok).toBe(true)
    const corrupt = logSpy.mock.calls
      .map((c) => JSON.parse(c[0] as string) as Record<string, unknown>)
      .filter((o) => o.event === "learnings-archive-corrupt")
    expect(corrupt).toHaveLength(1)
    expect(corrupt[0]).toMatchObject({ reason: "json-parse" })
    logSpy.mockRestore()

    // The corrupt store was overwritten by the fresh entry (signal logged, not lost silently).
    const archived = await loadArchivedLearnings(env, "repo", "123")
    expect(archived?.entries.map((e) => e.id)).toEqual(["z"])
  })
})
