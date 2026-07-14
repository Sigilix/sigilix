// runMemoryConsolidatePass (the cron tick) + handleConsolidateClusterJob (the
// Queue consumer). The tick's embed batch is scripted (vector-per-rule) and the
// consumer's Gardener LLM call is scripted; the learnings store + archive
// adapters run for real against a fake KV.
//
// Verifies: default-OFF = zero side effects; shadow enqueues clusters but the
// consumer writes NOTHING; enforce (>= threshold) appends ONE canonical + archives
// the originals; the suppress+require + suppression-backdoor + below-threshold
// guards; legacy (untyped) records are never clustered; and the per-tick bounds.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { embedTextsMock, runConsolidationMock } = vi.hoisted(() => ({
  embedTextsMock: vi.fn(),
  runConsolidationMock: vi.fn(),
}))

vi.mock("@/src/shared/adapters/model", async (importActual) => {
  const actual = await importActual<typeof import("@/src/shared/adapters/model")>()
  return { ...actual, embedTexts: embedTextsMock }
})

vi.mock("@/src/features/learnings/adapters/consolidator-model", () => ({
  runConsolidation: runConsolidationMock,
}))

import {
  MAX_EMBED_STORES_PER_TICK,
  MAX_CONSOLIDATE_KEYS_PER_TICK,
  runMemoryConsolidatePass,
} from "@/src/lib/memory-consolidate"
import { handleConsolidateClusterJob } from "@/src/lib/memory-consolidate-cluster"
import { MAX_LEARNINGS, loadArchivedLearnings, loadLearnings } from "@/src/features/learnings"
import { learningsKey } from "@/src/features/learnings/domain/store-ops"
import type { LearningEntry, LearningStore } from "@/src/features/learnings/domain/types"
import type { Env } from "@/src/shared/types/env"

function entry(overrides: Partial<LearningEntry> = {}): LearningEntry {
  return {
    id: overrides.id ?? "l1",
    rule: overrides.rule ?? "rule text",
    polarity: overrides.polarity ?? "context",
    category: overrides.category ?? null,
    pathGlob: overrides.pathGlob ?? null,
    scope: overrides.scope ?? "repo",
    subjectId: overrides.subjectId ?? "123",
    source: overrides.source ?? { kind: "top-level" },
    createdTs: overrides.createdTs ?? "2026-05-01T00:00:00.000Z",
    appliedCount: overrides.appliedCount ?? 0,
    ...(overrides.type !== undefined ? { type: overrides.type } : {}),
    ...(overrides.lifespanAnchor !== undefined ? { lifespanAnchor: overrides.lifespanAnchor } : {}),
  }
}

function repoStore(subjectId: string, entries: LearningEntry[]): LearningStore {
  return { schemaVersion: 1, scope: "repo", subjectId, entries }
}

/** Fake KV + queue with call counters. */
function makeEnv(mode?: string) {
  const values = new Map<string, string>()
  const counts = { list: 0, get: 0, put: 0 }
  const sent: unknown[] = []
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
    AI: { run: vi.fn() },
    OPENCLAW_JOBS: { send: async (m: unknown) => void sent.push(m) },
    ...(mode !== undefined ? { OPENCLAW_MEMORY_CONSOLIDATE: mode } : {}),
  } as unknown as Env
  return { env, values, counts, sent }
}

/** Vector for a rule keyed by its leading token: "A ..." → [1,0,0], "B ..." → [0,1,0]. */
function vectorForRule(rule: string): number[] {
  const head = rule.trim()[0]?.toUpperCase() ?? "?"
  if (head === "A") return [1, 0, 0]
  if (head === "B") return [0, 1, 0]
  return [0, 0, 1]
}

beforeEach(() => {
  embedTextsMock.mockReset().mockImplementation(async (_ai: unknown, texts: string[]) => texts.map(vectorForRule))
  runConsolidationMock.mockReset()
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

describe("runMemoryConsolidatePass (tick)", () => {
  it("default OFF: zero side effects (no KV scan, no embed, no enqueue)", async () => {
    const { env, counts, sent } = makeEnv(undefined)
    const summary = await runMemoryConsolidatePass(env)
    expect(summary.mode).toBe("off")
    expect(counts.list).toBe(0)
    expect(counts.get).toBe(0)
    expect(counts.put).toBe(0)
    expect(embedTextsMock).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)
  })

  it("shadow: clusters 3 near-duplicate typed rules and enqueues ONE consolidate-cluster job", async () => {
    const { env, values, sent } = makeEnv("shadow")
    values.set(
      learningsKey("repo", "123"),
      JSON.stringify(
        repoStore("123", [
          entry({ id: "a1", rule: "Always wrap db calls", type: "durable_preference" }),
          entry({ id: "a2", rule: "Also wrap db calls", type: "durable_preference" }),
          entry({ id: "a3", rule: "And wrap db calls", type: "durable_preference" }),
          entry({ id: "b1", rule: "Be sure to test", type: "durable_preference" }),
        ]),
      ),
    )
    const summary = await runMemoryConsolidatePass(env)
    expect(summary.storesEmbedded).toBe(1)
    expect(summary.clustersFound).toBe(1)
    expect(summary.clustersEnqueued).toBe(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: "consolidate-cluster", scope: "repo", subjectId: "123" })
    expect((sent[0] as { memberIds: string[] }).memberIds.sort()).toEqual(["a1", "a2", "a3"])
  })

  it("rejects a suppress+require cluster deterministically (never enqueued)", async () => {
    const { env, values, sent } = makeEnv("enforce")
    values.set(
      learningsKey("repo", "123"),
      JSON.stringify(
        repoStore("123", [
          entry({ id: "a1", rule: "Always flag X", type: "durable_preference", polarity: "require" }),
          entry({ id: "a2", rule: "Also flag X", type: "durable_preference", polarity: "suppress" }),
          entry({ id: "a3", rule: "And flag X", type: "durable_preference", polarity: "context" }),
        ]),
      ),
    )
    const summary = await runMemoryConsolidatePass(env)
    expect(summary.clustersFound).toBe(1)
    expect(summary.clustersConflicted).toBe(1)
    expect(summary.clustersEnqueued).toBe(0)
    expect(sent).toHaveLength(0)
  })

  it("never clusters legacy (untyped) records — a store of 3 untyped rules is skipped", async () => {
    const { env, values, sent } = makeEnv("shadow")
    values.set(
      learningsKey("repo", "123"),
      JSON.stringify(
        repoStore("123", [
          entry({ id: "a1", rule: "Always wrap" }),
          entry({ id: "a2", rule: "Also wrap" }),
          entry({ id: "a3", rule: "And wrap" }),
        ]),
      ),
    )
    const summary = await runMemoryConsolidatePass(env)
    expect(summary.storesEmbedded).toBe(0)
    expect(summary.clustersEnqueued).toBe(0)
    expect(embedTextsMock).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)
  })

  it("never clusters EPHEMERAL-tier records — 3 near-duplicate ephemerals are skipped", async () => {
    const { env, values, sent } = makeEnv("shadow")
    values.set(
      learningsKey("repo", "123"),
      JSON.stringify(
        repoStore("123", [
          entry({ id: "a1", rule: "Always wrap", type: "ephemeral_project" }),
          entry({ id: "a2", rule: "Also wrap", type: "transient_feedback" }),
          entry({ id: "a3", rule: "And wrap", type: "ephemeral_project" }),
        ]),
      ),
    )
    const summary = await runMemoryConsolidatePass(env)
    expect(summary.storesEmbedded).toBe(0)
    expect(summary.clustersEnqueued).toBe(0)
    expect(embedTextsMock).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)
  })

  it("enforces the embed cap: only MAX_EMBED_STORES_PER_TICK stores are embedded", async () => {
    const { env, values } = makeEnv("shadow")
    const overCap = MAX_EMBED_STORES_PER_TICK + 3
    for (let i = 0; i < overCap; i++) {
      values.set(
        learningsKey("repo", `s${i}`),
        JSON.stringify(
          repoStore(`s${i}`, [
            entry({ id: `${i}-a1`, rule: "Always wrap", type: "durable_preference" }),
            entry({ id: `${i}-a2`, rule: "Also wrap", type: "durable_preference" }),
            entry({ id: `${i}-a3`, rule: "And wrap", type: "durable_preference" }),
          ]),
        ),
      )
    }
    const summary = await runMemoryConsolidatePass(env)
    expect(summary.storesEmbedded).toBe(MAX_EMBED_STORES_PER_TICK)
    expect(summary.embedCapReached).toBe(true)
  })

  it("flags a truncated key-list scan", async () => {
    const { env, values } = makeEnv("shadow")
    const overCap = MAX_CONSOLIDATE_KEYS_PER_TICK + 1
    for (let i = 0; i < overCap; i++) {
      values.set(learningsKey("repo", `k${i}`), JSON.stringify(repoStore(`k${i}`, [])))
    }
    const summary = await runMemoryConsolidatePass(env)
    expect(summary.keyListTruncated).toBe(true)
    expect(summary.keysScanned).toBe(MAX_CONSOLIDATE_KEYS_PER_TICK)
  })
})

describe("handleConsolidateClusterJob (consumer)", () => {
  const members = [
    entry({ id: "a1", rule: "Always wrap db calls", type: "durable_preference", polarity: "require" }),
    entry({ id: "a2", rule: "Also wrap db calls", type: "durable_preference", polarity: "require" }),
    entry({ id: "a3", rule: "And wrap db calls", type: "durable_preference", polarity: "context" }),
  ]

  function seedStore(values: Map<string, string>) {
    values.set(learningsKey("repo", "123"), JSON.stringify(repoStore("123", [...members])))
  }

  it("OFF: inert (no store read, no model call, no write)", async () => {
    const { env, values, counts } = makeEnv(undefined)
    seedStore(values)
    counts.get = 0
    counts.put = 0
    await handleConsolidateClusterJob({ scope: "repo", subjectId: "123", memberIds: ["a1", "a2", "a3"] }, env)
    expect(runConsolidationMock).not.toHaveBeenCalled()
    expect(counts.put).toBe(0)
  })

  it("shadow: runs the model but writes NO canonical and archives NOTHING", async () => {
    const { env, values } = makeEnv("shadow")
    seedStore(values)
    runConsolidationMock.mockResolvedValue({
      canonicalRule: "Always wrap DB calls in a service layer",
      polarity: "require",
      category: null,
      pathGlob: null,
      confidence: 0.95,
      mergedIds: ["a1", "a2", "a3"],
    })
    await handleConsolidateClusterJob({ scope: "repo", subjectId: "123", memberIds: ["a1", "a2", "a3"] }, env)
    expect(runConsolidationMock).toHaveBeenCalledTimes(1)
    const store = await loadLearnings(env, "repo", "123")
    expect(store?.entries.map((e) => e.id).sort()).toEqual(["a1", "a2", "a3"])
    expect(await loadArchivedLearnings(env, "repo", "123")).toBeNull()
  })

  it("enforce (>= threshold): appends ONE canonical FIRST, then tombstones the 3 originals", async () => {
    const { env, values } = makeEnv("enforce")
    seedStore(values)
    runConsolidationMock.mockResolvedValue({
      canonicalRule: "Always wrap DB calls in a service layer",
      polarity: "require",
      category: "logic",
      pathGlob: "src/**",
      confidence: 0.9,
      mergedIds: ["a1", "a2", "a3"],
    })
    await handleConsolidateClusterJob({ scope: "repo", subjectId: "123", memberIds: ["a1", "a2", "a3"] }, env)
    const store = await loadLearnings(env, "repo", "123")
    // Originals gone; exactly one canonical remains.
    expect(store?.entries).toHaveLength(1)
    const canonical = store!.entries[0]!
    expect(canonical.rule).toContain("wrap DB calls")
    expect(canonical.polarity).toBe("require")
    expect(canonical.type).toBe("durable_preference")
    expect(canonical.lifespanAnchor).toEqual({ kind: "durable" })
    // The 3 originals are recoverable in the tombstone.
    const archived = await loadArchivedLearnings(env, "repo", "123")
    expect(archived?.entries.map((e) => e.id).sort()).toEqual(["a1", "a2", "a3"])
  })

  it("enforce below threshold: writes NOTHING (proposal-only)", async () => {
    const { env, values } = makeEnv("enforce")
    seedStore(values)
    runConsolidationMock.mockResolvedValue({
      canonicalRule: "Always wrap DB calls",
      polarity: "require",
      category: null,
      pathGlob: null,
      confidence: 0.5,
      mergedIds: ["a1", "a2", "a3"],
    })
    await handleConsolidateClusterJob({ scope: "repo", subjectId: "123", memberIds: ["a1", "a2", "a3"] }, env)
    const store = await loadLearnings(env, "repo", "123")
    expect(store?.entries.map((e) => e.id).sort()).toEqual(["a1", "a2", "a3"])
    expect(await loadArchivedLearnings(env, "repo", "123")).toBeNull()
  })

  it("suppression-backdoor guard: a NEW suppress canonical over a non-suppress cluster is refused", async () => {
    const { env, values } = makeEnv("enforce")
    seedStore(values) // members are require/context — no suppress
    runConsolidationMock.mockResolvedValue({
      canonicalRule: "Do not flag db calls",
      polarity: "suppress",
      category: null,
      pathGlob: null,
      confidence: 0.99,
      mergedIds: ["a1", "a2", "a3"],
    })
    await handleConsolidateClusterJob({ scope: "repo", subjectId: "123", memberIds: ["a1", "a2", "a3"] }, env)
    const store = await loadLearnings(env, "repo", "123")
    expect(store?.entries.map((e) => e.id).sort()).toEqual(["a1", "a2", "a3"])
    expect(await loadArchivedLearnings(env, "repo", "123")).toBeNull()
  })

  it("polarity-conflict guard: a suppress+require member set never reaches the model", async () => {
    const { env, values } = makeEnv("enforce")
    values.set(
      learningsKey("repo", "123"),
      JSON.stringify(
        repoStore("123", [
          entry({ id: "a1", rule: "flag", type: "durable_preference", polarity: "require" }),
          entry({ id: "a2", rule: "flag", type: "durable_preference", polarity: "suppress" }),
          entry({ id: "a3", rule: "flag", type: "durable_preference", polarity: "context" }),
        ]),
      ),
    )
    await handleConsolidateClusterJob({ scope: "repo", subjectId: "123", memberIds: ["a1", "a2", "a3"] }, env)
    expect(runConsolidationMock).not.toHaveBeenCalled()
    expect(await loadArchivedLearnings(env, "repo", "123")).toBeNull()
  })

  it("too-few-present: skips when the cluster ids no longer resolve to >= 3 entries", async () => {
    const { env, values } = makeEnv("enforce")
    values.set(
      learningsKey("repo", "123"),
      JSON.stringify(repoStore("123", [entry({ id: "a1", type: "durable_preference" })])),
    )
    await handleConsolidateClusterJob({ scope: "repo", subjectId: "123", memberIds: ["a1", "gone1", "gone2"] }, env)
    expect(runConsolidationMock).not.toHaveBeenCalled()
  })

  it("at the store cap: enforce collapses WITHOUT hard-evicting an unrelated LRU memory", async () => {
    const { env, values } = makeEnv("enforce")
    // A full store (MAX_LEARNINGS). 3 are the merge members; one non-member
    // ("victim") is the least-recently-applied → the entry a naive append-first
    // at cap would silently hard-delete.
    const victim = entry({ id: "victim", type: "durable_preference", createdTs: "2020-01-01T00:00:00.000Z" })
    const membersAtCap = [
      entry({
        id: "a1",
        rule: "Always wrap db calls",
        type: "durable_preference",
        createdTs: "2026-06-01T00:00:00.000Z",
      }),
      entry({
        id: "a2",
        rule: "Also wrap db calls",
        type: "durable_preference",
        createdTs: "2026-06-01T00:00:00.000Z",
      }),
      entry({ id: "a3", rule: "And wrap db calls", type: "durable_preference", createdTs: "2026-06-01T00:00:00.000Z" }),
    ]
    const fillers = Array.from({ length: MAX_LEARNINGS - 4 }, (_, i) =>
      entry({ id: `f${i}`, rule: `filler ${i}`, type: "durable_preference", createdTs: "2026-05-15T00:00:00.000Z" }),
    )
    const all = [victim, ...membersAtCap, ...fillers]
    expect(all).toHaveLength(MAX_LEARNINGS)
    values.set(learningsKey("repo", "123"), JSON.stringify(repoStore("123", all)))
    runConsolidationMock.mockResolvedValue({
      canonicalRule: "Always wrap DB calls in a service layer",
      polarity: "context",
      category: null,
      pathGlob: null,
      confidence: 0.95,
      mergedIds: ["a1", "a2", "a3"],
    })

    await handleConsolidateClusterJob({ scope: "repo", subjectId: "123", memberIds: ["a1", "a2", "a3"] }, env)

    const store = await loadLearnings(env, "repo", "123")
    const ids = store!.entries.map((e) => e.id)
    // The 3 members are gone; the unrelated LRU "victim" SURVIVES; a canonical was added.
    expect(ids).not.toContain("a1")
    expect(ids).toContain("victim")
    expect(store!.entries.some((e) => e.rule.includes("wrap DB calls"))).toBe(true)
    expect(store!.entries).toHaveLength(MAX_LEARNINGS - 2) // 50 - 3 members + 1 canonical
    const archived = await loadArchivedLearnings(env, "repo", "123")
    expect(archived?.entries.map((e) => e.id).sort()).toEqual(["a1", "a2", "a3"])
  })
})
