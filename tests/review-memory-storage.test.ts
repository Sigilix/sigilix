// ARC-189 — KV storage tests (Task 4).

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import {
  buildKey,
  readMemory,
  appendSignal,
  pruneStaleSignals,
} from "../src/lib/review-memory/storage"
import type {
  ReviewMemoryRecord,
  ReviewMemorySignal,
  ReviewMemoryStorageScope,
} from "../src/lib/review-memory/types"
import type { Env } from "../src/index"

// ─── KV stub matching the existing project convention ─────────

interface KvStub {
  kv: Env["OPENCLAW_STATE"]
  store: Map<string, string>
  putOpts: Map<string, unknown>
  failGet: { value: boolean }
  failPut: { value: boolean }
}

function makeKvStub(): KvStub {
  const store = new Map<string, string>()
  const putOpts = new Map<string, unknown>()
  const failGet = { value: false }
  const failPut = { value: false }
  const kv = {
    async get(key: string): Promise<string | null> {
      if (failGet.value) throw new Error("kv-get failed")
      return store.get(key) ?? null
    },
    async put(key: string, value: string, opts?: unknown): Promise<void> {
      if (failPut.value) throw new Error("kv-put failed")
      store.set(key, value)
      if (opts) putOpts.set(key, opts)
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store, putOpts, failGet, failPut }
}

function makeEnv(kv: Env["OPENCLAW_STATE"]): Env {
  return { OPENCLAW_STATE: kv } as unknown as Env
}

const SAMPLE_SHA256 =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"

function makeSignal(over: Partial<ReviewMemorySignal> = {}): ReviewMemorySignal {
  return {
    ts: new Date().toISOString(),
    prNumber: 1,
    commentId: 100,
    fid: "abc1234567890def",
    kind: "dismissed-textual",
    ...over,
  }
}

// ─── buildKey ────────────────────────────────────────────────

describe("buildKey", () => {
  it("category scope: review-memory:<owner>/<repo>:cat:<category>", () => {
    expect(
      buildKey("acme", "site", { kind: "category", category: "performance" }),
    ).toBe("review-memory:acme/site:cat:performance")
  })

  it("path-category scope: review-memory:<owner>/<repo>:path:<sha256>:cat:<category>", () => {
    expect(
      buildKey("acme", "site", {
        kind: "path-category",
        category: "tests",
        pathSha256: SAMPLE_SHA256,
      }),
    ).toBe(`review-memory:acme/site:path:${SAMPLE_SHA256}:cat:tests`)
  })

  it("accepts the SIG-247 Phase 0 'architecture' category in both scopes", () => {
    // The literal-union extension to ReviewMemoryCategory was the
    // smallest possible v0 change; verify it threads through buildKey
    // without runtime drift. Today's specialist over-fires include
    // architectural-misunderstanding patterns (PR #202 "tenant
    // isolation", PR #203 "ownership validation") — the dismissals
    // need a category to land under, and "architecture" is it.
    expect(
      buildKey("acme", "site", { kind: "category", category: "architecture" }),
    ).toBe("review-memory:acme/site:cat:architecture")
    expect(
      buildKey("acme", "site", {
        kind: "path-category",
        category: "architecture",
        pathSha256: SAMPLE_SHA256,
      }),
    ).toBe(`review-memory:acme/site:path:${SAMPLE_SHA256}:cat:architecture`)
  })
})

// ─── readMemory ──────────────────────────────────────────────

describe("readMemory", () => {
  const owner = "acme"
  const repo = "site"
  const scope: ReviewMemoryStorageScope = {
    kind: "category",
    category: "logic",
  }

  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  })
  afterEach(() => {
    consoleSpy.mockRestore()
  })

  it("returns null on missing key", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    const r = await readMemory(env, owner, repo, scope)
    expect(r).toBeNull()
  })

  it("parses a present record", async () => {
    const { kv, store } = makeKvStub()
    const record: ReviewMemoryRecord = {
      schemaVersion: 1,
      category: "logic",
      signals: [makeSignal()],
      lastUpdatedTs: new Date().toISOString(),
    }
    store.set(buildKey(owner, repo, scope), JSON.stringify(record))
    const env = makeEnv(kv)
    const r = await readMemory(env, owner, repo, scope)
    expect(r).not.toBeNull()
    expect(r?.signals.length).toBe(1)
  })

  it("returns null on corrupt JSON + emits review-memory-corrupt-record telemetry", async () => {
    const { kv, store } = makeKvStub()
    store.set(buildKey(owner, repo, scope), "not json {")
    const env = makeEnv(kv)
    const r = await readMemory(env, owner, repo, scope)
    expect(r).toBeNull()
    const events = consoleSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((s) => s.includes("review-memory-corrupt-record"))
    expect(events.length).toBeGreaterThan(0)
  })

  it("returns null on schema-version mismatch + emits corrupt-record telemetry", async () => {
    const { kv, store } = makeKvStub()
    store.set(
      buildKey(owner, repo, scope),
      JSON.stringify({
        schemaVersion: 99,
        category: "logic",
        signals: [],
        lastUpdatedTs: new Date().toISOString(),
      }),
    )
    const env = makeEnv(kv)
    const r = await readMemory(env, owner, repo, scope)
    expect(r).toBeNull()
    const events = consoleSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((s) => s.includes("review-memory-corrupt-record"))
    expect(events.length).toBeGreaterThan(0)
  })

  it("returns null on KV get failure + emits review-memory-lookup-failed (no throw)", async () => {
    const { kv, failGet } = makeKvStub()
    failGet.value = true
    const env = makeEnv(kv)
    await expect(readMemory(env, owner, repo, scope)).resolves.toBeNull()
    const events = consoleSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((s) => s.includes("review-memory-lookup-failed"))
    expect(events.length).toBeGreaterThan(0)
  })
})

// ─── appendSignal ────────────────────────────────────────────

describe("appendSignal", () => {
  const owner = "acme"
  const repo = "site"
  const scope: ReviewMemoryStorageScope = {
    kind: "category",
    category: "logic",
  }

  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  })
  afterEach(() => {
    consoleSpy.mockRestore()
  })

  it("creates a new record on first signal", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv)
    const signal = makeSignal()
    const out = await appendSignal(env, owner, repo, scope, signal)
    expect(out.written).toBe(true)
    expect(out.signalCount).toBe(1)
    const stored = JSON.parse(store.get(buildKey(owner, repo, scope))!)
    expect(stored.signals.length).toBe(1)
    expect(stored.schemaVersion).toBe(1)
    expect(stored.category).toBe("logic")
    expect(stored.lastUpdatedTs).toBeDefined()
  })

  it("round-trips a signal with SIG-247 Phase 0 claims field (forward-compat)", async () => {
    // SIG-247 Phase 0 added `claims?: ReviewMemoryClaim[]` to the
    // ReviewMemorySignal schema. Phase 2 will ship the extractor that
    // produces these claims; for now the storage layer must accept and
    // round-trip them so Phase 2 writers don't have to coordinate a
    // schema migration. Test verifies: write a signal with claims,
    // read it back, claims are present + identical.
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv)
    const signal: ReviewMemorySignal = {
      ts: new Date().toISOString(),
      prNumber: 203,
      commentId: 3314239053,
      fid: "f00fa1234567890b",
      kind: "dismissed-textual",
      claims: [
        {
          id: "cl_abc123",
          type: "auth-gate-is-boundary",
          confidence: 0.9,
          extractorVersion: 1,
        },
      ],
    }
    await appendSignal(env, owner, repo, scope, signal)
    const stored = JSON.parse(store.get(buildKey(owner, repo, scope))!)
    expect(stored.signals).toHaveLength(1)
    expect(stored.signals[0].claims).toEqual(signal.claims)
  })

  it("round-trips a signal WITHOUT claims (legacy + Phase 0 capture path)", async () => {
    // Until Phase 2 ships the extractor, all signals written by the
    // existing capture path will have NO `claims` field. The storage
    // layer must not reject or default-populate them — `claims`
    // remains undefined on read.
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv)
    await appendSignal(env, owner, repo, scope, makeSignal())
    const stored = JSON.parse(store.get(buildKey(owner, repo, scope))!)
    expect(stored.signals[0].claims).toBeUndefined()
  })

  it("path-scope record carries pathSha256 in the value (full digest, not truncated)", async () => {
    const { kv, store } = makeKvStub()
    const pathScope: ReviewMemoryStorageScope = {
      kind: "path-category",
      category: "tests",
      pathSha256: SAMPLE_SHA256,
    }
    const env = makeEnv(kv)
    await appendSignal(env, owner, repo, pathScope, makeSignal())
    const stored = JSON.parse(store.get(buildKey(owner, repo, pathScope))!)
    expect(stored.pathSha256).toBe(SAMPLE_SHA256)
  })

  it("appends to existing record + refreshes TTL on every write", async () => {
    const { kv, store, putOpts } = makeKvStub()
    const env = makeEnv(kv)
    await appendSignal(env, owner, repo, scope, makeSignal({ commentId: 1 }))
    await appendSignal(env, owner, repo, scope, makeSignal({ commentId: 2 }))
    const stored = JSON.parse(store.get(buildKey(owner, repo, scope))!)
    expect(stored.signals.length).toBe(2)
    expect(stored.signals.map((s: ReviewMemorySignal) => s.commentId).sort()).toEqual([1, 2])
    const opts = putOpts.get(buildKey(owner, repo, scope)) as { expirationTtl?: number }
    expect(opts.expirationTtl).toBe(90 * 24 * 60 * 60)
  })

  it("prunes signals older than 180 days at write-time", async () => {
    const { kv, store } = makeKvStub()
    const oldTs = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString()
    const recent = new Date().toISOString()
    const seed: ReviewMemoryRecord = {
      schemaVersion: 1,
      category: "logic",
      signals: [
        makeSignal({ ts: oldTs, commentId: 1 }),
        makeSignal({ ts: recent, commentId: 2 }),
      ],
      lastUpdatedTs: oldTs,
    }
    store.set(buildKey(owner, repo, scope), JSON.stringify(seed))
    const env = makeEnv(kv)
    await appendSignal(env, owner, repo, scope, makeSignal({ commentId: 3 }))
    const stored = JSON.parse(store.get(buildKey(owner, repo, scope))!)
    expect(stored.signals.length).toBe(2)  // 200d-old pruned, kept #2 + #3
    expect(stored.signals.map((s: ReviewMemorySignal) => s.commentId).sort())
      .toEqual([2, 3])
  })

  it("FIFO-caps at 50 signals — 51st write evicts the oldest", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv)
    // Pre-seed 50 sorted-by-ts signals
    const baseMs = Date.now() - 60 * 24 * 60 * 60 * 1000  // 60 days ago
    const signals: ReviewMemorySignal[] = []
    for (let i = 0; i < 50; i++) {
      signals.push(makeSignal({
        ts: new Date(baseMs + i * 60_000).toISOString(),
        commentId: 1000 + i,
      }))
    }
    const seed: ReviewMemoryRecord = {
      schemaVersion: 1,
      category: "logic",
      signals,
      lastUpdatedTs: signals[49]!.ts,
    }
    store.set(buildKey(owner, repo, scope), JSON.stringify(seed))

    // 51st append
    await appendSignal(env, owner, repo, scope, makeSignal({
      ts: new Date().toISOString(),
      commentId: 9999,
    }))
    const stored = JSON.parse(store.get(buildKey(owner, repo, scope))!)
    expect(stored.signals.length).toBe(50)
    // oldest (commentId 1000) dropped
    expect(stored.signals.find((s: ReviewMemorySignal) => s.commentId === 1000)).toBeUndefined()
    expect(stored.signals.find((s: ReviewMemorySignal) => s.commentId === 9999)).toBeDefined()
  })

  it("does NOT throw on KV write failure; emits capture-failed { stage: kv-write }", async () => {
    const { kv, failPut } = makeKvStub()
    failPut.value = true
    const env = makeEnv(kv)
    const out = await appendSignal(env, owner, repo, scope, makeSignal())
    expect(out.written).toBe(false)
    const events = consoleSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((s) => s.includes("review-memory-capture-failed"))
    expect(events.length).toBeGreaterThan(0)
    const event = events.find((s) => s.includes("kv-write"))
    expect(event).toBeDefined()
  })

  it("treats corrupt existing record as missing (re-creates fresh)", async () => {
    const { kv, store } = makeKvStub()
    store.set(buildKey(owner, repo, scope), "not valid json")
    const env = makeEnv(kv)
    const out = await appendSignal(env, owner, repo, scope, makeSignal())
    expect(out.written).toBe(true)
    const stored = JSON.parse(store.get(buildKey(owner, repo, scope))!)
    expect(stored.signals.length).toBe(1)
  })
})

// ─── pruneStaleSignals (pure) ─────────────────────────────────

describe("pruneStaleSignals (pure)", () => {
  function rec(signals: ReviewMemorySignal[]): ReviewMemoryRecord {
    return {
      schemaVersion: 1,
      category: "logic",
      signals,
      lastUpdatedTs: new Date().toISOString(),
    }
  }

  it("returns the input record unchanged when nothing is stale", () => {
    const now = Date.now()
    const recent = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
    const r = rec([makeSignal({ ts: recent })])
    const out = pruneStaleSignals(r, now)
    expect(out.signals.length).toBe(1)
  })

  it("drops signals older than 180 days", () => {
    const now = Date.now()
    const old = new Date(now - 200 * 24 * 60 * 60 * 1000).toISOString()
    const recent = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
    const r = rec([
      makeSignal({ ts: old, commentId: 1 }),
      makeSignal({ ts: recent, commentId: 2 }),
    ])
    const out = pruneStaleSignals(r, now)
    expect(out.signals.length).toBe(1)
    expect(out.signals[0]?.commentId).toBe(2)
  })

  it("is pure — same input twice yields same output, no mutation", () => {
    const now = Date.now()
    const old = new Date(now - 200 * 24 * 60 * 60 * 1000).toISOString()
    const recent = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
    const r = rec([
      makeSignal({ ts: old, commentId: 1 }),
      makeSignal({ ts: recent, commentId: 2 }),
    ])
    const inputBefore = JSON.stringify(r)
    const a = pruneStaleSignals(r, now)
    const b = pruneStaleSignals(r, now)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(r)).toBe(inputBefore)  // input not mutated
  })

  it("handles empty signals array", () => {
    const out = pruneStaleSignals(rec([]), Date.now())
    expect(out.signals.length).toBe(0)
  })

  it("custom retentionDaysHard arg", () => {
    const now = Date.now()
    const sixtyOneDaysOld = new Date(now - 61 * 24 * 60 * 60 * 1000).toISOString()
    const r = rec([makeSignal({ ts: sixtyOneDaysOld })])
    const out = pruneStaleSignals(r, now, 60)  // hard 60d retention
    expect(out.signals.length).toBe(0)
  })
})
