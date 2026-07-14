// Personal-convention read (CLI dual-namespace union) — unit tests for the
// sentinel-namespace query + hydrate (loadPersonalConventionMemoryForCli) and
// the additive seat∪convention merge (mergeSeatAndConventionMemory). The route
// wiring (flag gating, org precedence over a convention) is pinned in
// agent-memory-route.test.ts.

import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  loadPersonalConventionMemoryForCli,
  mergeSeatAndConventionMemory,
  MAX_PERSONAL_CONVENTION_ENTRIES,
} from "./agent-memory-convention-read"
import { PERSONAL_CONVENTION_REPO_ID } from "./agent-memory-personal-subject"
import { recordKey } from "./storage"
import { memoryNamespace } from "./retrieval"
import type { AgentMemoryQueryResult, AgentMemoryRecord } from "./types"
import type { Env } from "@/src/shared/types/env"

const DIMS = 768
const USER_ID = "inst:42:user:user-1"
const SENTINEL_NS = memoryNamespace(USER_ID, PERSONAL_CONVENTION_REPO_ID)

// ─── In-memory fakes (mirrors agent-memory-route.test.ts) ────

function fakeKV(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>()
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
  } as unknown as KVNamespace
  return { kv, store }
}

function fakeAi(): Env["AI"] {
  return {
    run: async () => ({ data: [Array.from({ length: DIMS }, () => 0.1)], shape: [1, DIMS] }),
  } as unknown as Env["AI"]
}

interface FakeVector {
  id: string
  namespace: string
  metadata: Record<string, string | number>
}

function fakeIndex() {
  const vectors: FakeVector[] = []
  const queryCalls: Array<{ topK?: number; namespace?: string }> = []
  const index = {
    upsert: async (records: FakeVector[]) => {
      vectors.push(...records)
    },
    query: async (_vector: number[], options: { topK?: number; namespace?: string }) => {
      queryCalls.push(options)
      const matched = vectors
        .filter((v) => v.namespace === options.namespace)
        .slice(0, options.topK ?? 8)
        .map((v) => ({ id: v.id, score: 0.9, metadata: { kind: v.metadata.kind, ts: v.metadata.ts } }))
      return { matches: matched }
    },
  }
  return { index: index as unknown as Env["OPENCLAW_AGENT_MEMORY_INDEX"], vectors, queryCalls }
}

let fk: ReturnType<typeof fakeKV>
let idx: ReturnType<typeof fakeIndex>

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    OPENCLAW_STATE: fk.kv,
    AI: fakeAi(),
    OPENCLAW_AGENT_MEMORY_INDEX: idx.index,
    ...extra,
  } as unknown as Env
}

/** Seed one sentinel-bucket convention: vector under `<userId>/*` + KV record. */
function seedConvention(id: string, content: string, ts: string, userId: string = USER_ID): void {
  idx.vectors.push({
    id,
    namespace: memoryNamespace(userId, PERSONAL_CONVENTION_REPO_ID),
    metadata: { kind: "preference", ts },
  })
  const record: AgentMemoryRecord = {
    schemaVersion: 1,
    id,
    userId,
    repoId: PERSONAL_CONVENTION_REPO_ID,
    kind: "preference",
    content,
    ts,
    hash: `h-${id}`,
  }
  fk.store.set(recordKey(userId, PERSONAL_CONVENTION_REPO_ID, id), JSON.stringify(record))
}

beforeEach(() => {
  fk = fakeKV()
  idx = fakeIndex()
})

describe("loadPersonalConventionMemoryForCli", () => {
  it("queries the SENTINEL namespace and returns hydrated conventions newest-first", async () => {
    seedConvention("mem_old", "older convention", "2026-01-01T00:00:00.000Z")
    seedConvention("mem_new", "newer convention", "2026-06-01T00:00:00.000Z")

    const out = await loadPersonalConventionMemoryForCli(makeEnv(), { userId: USER_ID, query: "conventions", topK: 8 })

    expect(idx.queryCalls.map((c) => c.namespace)).toEqual([SENTINEL_NS])
    expect(out.truncated).toBe(false)
    expect(out.entries.map((e) => e.id)).toEqual(["mem_new", "mem_old"])
    expect(out.entries[0]).toMatchObject({ kind: "preference", content: "newer convention", score: 0.9 })
  })

  it("never surfaces another user's conventions — the namespace is the isolation boundary", async () => {
    seedConvention("mem_peer", "peer convention", "2026-06-01T00:00:00.000Z", "inst:42:user:user-2")

    const out = await loadPersonalConventionMemoryForCli(makeEnv(), { userId: USER_ID, query: "x", topK: 8 })
    expect(out.entries).toEqual([])
  })

  it("caps at MAX_PERSONAL_CONVENTION_ENTRIES and reports truncation", async () => {
    for (let i = 0; i < MAX_PERSONAL_CONVENTION_ENTRIES + 5; i++) {
      seedConvention(`mem_${i}`, `c${i}`, new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 1000).toISOString())
    }
    const out = await loadPersonalConventionMemoryForCli(makeEnv(), {
      userId: USER_ID,
      query: "x",
      topK: MAX_PERSONAL_CONVENTION_ENTRIES + 5,
    })
    expect(out.entries.length).toBe(MAX_PERSONAL_CONVENTION_ENTRIES)
    expect(out.truncated).toBe(true)
  })

  it("a hydrate miss (vector hit with no KV record) is skipped, not fatal", async () => {
    seedConvention("mem_ok", "kept", "2026-06-01T00:00:00.000Z")
    // Orphan vector: present in the index, but its KV record is gone (deleted).
    idx.vectors.push({
      id: "mem_gone",
      namespace: SENTINEL_NS,
      metadata: { kind: "preference", ts: "2026-06-02T00:00:00.000Z" },
    })

    const out = await loadPersonalConventionMemoryForCli(makeEnv(), { userId: USER_ID, query: "x", topK: 8 })
    expect(out.entries.map((e) => e.id)).toEqual(["mem_ok"])
  })

  it("fail-soft: a Vectorize query throw degrades to no conventions, never throws", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const broken = {
      query: async () => {
        throw new Error("vectorize down")
      },
    } as unknown as Env["OPENCLAW_AGENT_MEMORY_INDEX"]

    const out = await loadPersonalConventionMemoryForCli(makeEnv({ OPENCLAW_AGENT_MEMORY_INDEX: broken }), {
      userId: USER_ID,
      query: "x",
      topK: 8,
    })
    expect(out).toEqual({ entries: [], truncated: false })
  })
})

describe("mergeSeatAndConventionMemory", () => {
  const r = (id: string, content: string): AgentMemoryQueryResult => ({
    id,
    kind: "preference",
    content,
    ts: "2026-06-01T00:00:00.000Z",
    score: 0.9,
  })

  it("is additive: seat results stay first in order, conventions appended", () => {
    const merged = mergeSeatAndConventionMemory([r("mem_s1", "seat 1"), r("mem_s2", "seat 2")], [r("mem_c1", "conv 1")])
    expect(merged.map((x) => x.id)).toEqual(["mem_s1", "mem_s2", "mem_c1"])
  })

  it("a seat result wins an id collision (defense-in-depth; ids are disjoint uuids in practice)", () => {
    const merged = mergeSeatAndConventionMemory(
      [r("mem_a", "seat copy")],
      [r("mem_a", "conv copy"), r("mem_b", "conv b")],
    )
    expect(merged.map((x) => x.content)).toEqual(["seat copy", "conv b"])
  })

  it("empty seat → conventions alone; empty conventions → seat unchanged", () => {
    expect(mergeSeatAndConventionMemory([], [r("mem_c", "c")]).map((x) => x.id)).toEqual(["mem_c"])
    const seat = [r("mem_s", "s")]
    expect(mergeSeatAndConventionMemory(seat, [])).toEqual(seat)
  })
})
