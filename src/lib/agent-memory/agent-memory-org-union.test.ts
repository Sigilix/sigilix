// Seat∪Org memory layering — Phase 3 (CLI read side) unit tests for the pure
// load+render helper. The route-level integration (mode gating, telemetry,
// seat-preserving fail-soft) is covered in agent-memory-route.test.ts.

import { describe, expect, it } from "vitest"
import { appendLearning } from "@/src/features/learnings/adapters/store"
import type { LearningEntry } from "@/src/features/learnings/domain/types"
import { LEGACY_TENANT_INSTALLATION_ID } from "@/src/lib/api-key-resolver"
import type { Env } from "@/src/shared/types/env"
import type { AgentMemoryQueryResult } from "./types"
import { MAX_ORG_MEMORY_ENTRIES, loadOrgMemoryForCli, unionSeatAndOrgMemory } from "./agent-memory-org-union"

const INSTALL_ID = 42
const TS = Date.parse("2026-06-15T12:00:00.000Z")

function makeEntry(id: string, over: Partial<LearningEntry> = {}): LearningEntry {
  return {
    id,
    rule: `rule-${id}`,
    polarity: "require",
    category: null,
    pathGlob: null,
    scope: "org",
    subjectId: String(INSTALL_ID),
    source: { kind: "command", prNumber: 1, commentId: 1 },
    createdTs: new Date(TS).toISOString(),
    appliedCount: 0,
    ...over,
  }
}

function makeEnv(over: Partial<Env> = {}): Env {
  const store = new Map<string, string>()
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value)
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
  }
  return { OPENCLAW_STATE: kv, ...over } as unknown as Env
}

describe("loadOrgMemoryForCli", () => {
  it("returns empty for the LEGACY global key — no single org to scope to, no KV read", async () => {
    const env = makeEnv()
    const out = await loadOrgMemoryForCli(env, LEGACY_TENANT_INSTALLATION_ID)
    expect(out).toEqual({ entries: [], truncated: false })
  })

  it("returns empty when the org store is empty/unset", async () => {
    const env = makeEnv()
    const out = await loadOrgMemoryForCli(env, INSTALL_ID)
    expect(out).toEqual({ entries: [], truncated: false })
  })

  it("renders LearningEntry rows into AgentMemoryQueryResult shape, newest-first", async () => {
    const env = makeEnv()
    await appendLearning(env, "org", String(INSTALL_ID), makeEntry("a", { createdTs: "2026-01-01T00:00:00.000Z" }))
    await appendLearning(env, "org", String(INSTALL_ID), makeEntry("b", { createdTs: "2026-06-01T00:00:00.000Z" }))
    const out = await loadOrgMemoryForCli(env, INSTALL_ID)
    expect(out.truncated).toBe(false)
    expect(out.entries.map((e) => e.id)).toEqual(["org:b", "org:a"])
    expect(out.entries[0]).toEqual({
      id: "org:b",
      kind: "preference",
      content: "[required] rule-b",
      ts: "2026-06-01T00:00:00.000Z",
      score: 1,
    })
  })

  it("formats a suppress-polarity rule with a [dismissed] tag + category", async () => {
    const env = makeEnv()
    await appendLearning(
      env,
      "org",
      String(INSTALL_ID),
      makeEntry("c", { polarity: "suppress", category: "style", rule: "don't flag trailing commas" }),
    )
    const out = await loadOrgMemoryForCli(env, INSTALL_ID)
    expect(out.entries[0]?.content).toBe("[dismissed] don't flag trailing commas (style)")
  })

  it("formats a require-polarity rule with a [required] tag", async () => {
    const env = makeEnv()
    await appendLearning(
      env,
      "org",
      String(INSTALL_ID),
      makeEntry("d", { polarity: "require", rule: "always use @/ imports" }),
    )
    const out = await loadOrgMemoryForCli(env, INSTALL_ID)
    expect(out.entries[0]?.content).toBe("[required] always use @/ imports")
  })

  it("caps at MAX_ORG_MEMORY_ENTRIES and reports truncated:true", async () => {
    const env = makeEnv()
    for (let i = 0; i < MAX_ORG_MEMORY_ENTRIES + 5; i++) {
      await appendLearning(
        env,
        "org",
        String(INSTALL_ID),
        makeEntry(`e${i}`, { createdTs: new Date(TS + i * 1000).toISOString() }),
      )
    }
    const out = await loadOrgMemoryForCli(env, INSTALL_ID)
    expect(out.entries.length).toBe(MAX_ORG_MEMORY_ENTRIES)
    expect(out.truncated).toBe(true)
    // Newest-first: the highest index (latest ts) survives the cap.
    expect(out.entries[0]?.id).toBe(`org:e${MAX_ORG_MEMORY_ENTRIES + 4}`)
  })

  it("degrades to empty on a KV read error — never throws", async () => {
    const kv = {
      async get(): Promise<string | null> {
        throw new Error("kv down")
      },
      async put(): Promise<void> {},
      async delete(): Promise<void> {},
    }
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    const out = await loadOrgMemoryForCli(env, INSTALL_ID)
    expect(out).toEqual({ entries: [], truncated: false })
  })
})

function seatResult(id: string, content = "seat"): AgentMemoryQueryResult {
  return { id, kind: "decision", content, ts: "2026-01-01T00:00:00.000Z", score: 0.9 }
}

function orgResult(id: string, content = "org"): AgentMemoryQueryResult {
  return { id, kind: "preference", content, ts: "2026-01-01T00:00:00.000Z", score: 1 }
}

describe("unionSeatAndOrgMemory", () => {
  it("appends org entries after seat entries, seat first", () => {
    const out = unionSeatAndOrgMemory([seatResult("mem_1")], [orgResult("org:a")])
    expect(out.map((r) => r.id)).toEqual(["mem_1", "org:a"])
  })

  it("dedups by id — a seat entry wins any collision with an org entry", () => {
    // A real collision cannot occur via the production id schemes (mem_<uuid>
    // vs org:<learningId>), but the merge's dedup guard must still hold if it
    // ever did — this proves the guard, not just the happy path.
    const out = unionSeatAndOrgMemory([seatResult("dup", "seat wins")], [orgResult("dup", "org loses")])
    expect(out).toEqual([seatResult("dup", "seat wins")])
  })

  it("passes through seat-only unchanged when org is empty", () => {
    const seat = [seatResult("mem_1"), seatResult("mem_2")]
    expect(unionSeatAndOrgMemory(seat, [])).toEqual(seat)
  })

  it("passes through org-only when seat is empty", () => {
    const org = [orgResult("org:a")]
    expect(unionSeatAndOrgMemory([], org)).toEqual(org)
  })
})
