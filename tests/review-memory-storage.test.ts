// ARC-189 — KV storage tests (Task 4).

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import {
  buildKey,
  buildRepoIdKey,
  readMemory,
  appendSignal,
  pruneStaleSignals,
  unionRecords,
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

// ─── SIG-247 Phase 1 — buildRepoIdKey ─────────────────────────

describe("buildRepoIdKey (SIG-247 Phase 1)", () => {
  it("category scope: review-memory:repo:<id>:cat:<category>", () => {
    expect(
      buildRepoIdKey(42, { kind: "category", category: "performance" }),
    ).toBe("review-memory:repo:42:cat:performance")
  })

  it("path-category scope carries the full sha256 in the key", () => {
    expect(
      buildRepoIdKey(42, {
        kind: "path-category",
        category: "tests",
        pathSha256: SAMPLE_SHA256,
      }),
    ).toBe(`review-memory:repo:42:path:${SAMPLE_SHA256}:cat:tests`)
  })

  it("accepts the SIG-247 Phase 0 'architecture' category", () => {
    expect(
      buildRepoIdKey(42, { kind: "category", category: "architecture" }),
    ).toBe("review-memory:repo:42:cat:architecture")
  })
})

// ─── SIG-247 Phase 1 — unionRecords (pure) ───────────────────

describe("unionRecords (pure, SIG-247 Phase 1)", () => {
  const scope: ReviewMemoryStorageScope = {
    kind: "category",
    category: "logic",
  }

  function rec(signals: ReviewMemorySignal[]): ReviewMemoryRecord {
    return {
      schemaVersion: 1,
      category: "logic",
      signals,
      lastUpdatedTs: signals[signals.length - 1]?.ts
        ?? new Date().toISOString(),
    }
  }

  it("null + null → null", () => {
    expect(unionRecords(null, null, scope)).toBeNull()
  })

  it("null + record → record", () => {
    const r = rec([makeSignal({ commentId: 1 })])
    expect(unionRecords(null, r, scope)).toEqual(r)
  })

  it("record + null → record", () => {
    const r = rec([makeSignal({ commentId: 1 })])
    expect(unionRecords(r, null, scope)).toEqual(r)
  })

  it("disjoint signal sets are concatenated + sorted ts desc", () => {
    const tsA = new Date(Date.now() - 1000).toISOString()
    const tsB = new Date(Date.now() - 500).toISOString()
    const a = rec([makeSignal({ commentId: 1, ts: tsA })])
    const b = rec([makeSignal({ commentId: 2, ts: tsB })])
    const out = unionRecords(a, b, scope)
    expect(out?.signals.map((s) => s.commentId)).toEqual([2, 1])
  })

  it("overlapping commentId: latest ts wins (deduped)", () => {
    const olderTs = new Date(Date.now() - 1000).toISOString()
    const newerTs = new Date(Date.now() - 500).toISOString()
    const a = rec([makeSignal({ commentId: 7, ts: olderTs, prNumber: 1 })])
    const b = rec([makeSignal({ commentId: 7, ts: newerTs, prNumber: 2 })])
    const out = unionRecords(a, b, scope)
    expect(out?.signals).toHaveLength(1)
    expect(out?.signals[0]?.prNumber).toBe(2)
    expect(out?.signals[0]?.ts).toBe(newerTs)
  })

  it("final sort is NaN-safe — malformed-ts signals pushed to end (CR-2)", () => {
    // unionRecords' final .sort() must not return NaN, or
    // Array.prototype.sort yields engine-defined ordering. Push
    // malformed-ts signals to the end so the FIFO cap evicts them
    // first when overflow happens.
    const validNewer = new Date(Date.now() - 500).toISOString()
    const validOlder = new Date(Date.now() - 5000).toISOString()
    const a = rec([
      makeSignal({ commentId: 1, ts: validOlder }),
      makeSignal({ commentId: 2, ts: "garbage" }),
    ])
    const b = rec([
      makeSignal({ commentId: 3, ts: validNewer }),
    ])
    const out = unionRecords(a, b, scope)
    expect(out?.signals).toHaveLength(3)
    // Order: validNewer (3), validOlder (1), garbage (2)
    expect(out?.signals.map((s) => s.commentId)).toEqual([3, 1, 2])
  })

  it("overlapping commentId: NaN-existing-ts loses to valid candidate (code-reviewer M2)", () => {
    // If an existing signal has a malformed ts (Date.parse → NaN),
    // the prior `candidateTs > existingTs` always evaluates false,
    // so the malformed signal would stick. Phase 1 prefers any
    // candidate with a finite ts over a NaN existing.
    const validTs = new Date().toISOString()
    const a = rec([makeSignal({ commentId: 7, ts: "not-a-date", prNumber: 1 })])
    const b = rec([makeSignal({ commentId: 7, ts: validTs, prNumber: 2 })])
    const out = unionRecords(a, b, scope)
    expect(out?.signals).toHaveLength(1)
    expect(out?.signals[0]?.prNumber).toBe(2)
    expect(out?.signals[0]?.ts).toBe(validTs)
  })

  it("caps to 50 newest after union", () => {
    const baseMs = Date.now() - 60_000
    const aSignals: ReviewMemorySignal[] = []
    const bSignals: ReviewMemorySignal[] = []
    for (let i = 0; i < 30; i++) {
      aSignals.push(makeSignal({
        commentId: 1000 + i,
        ts: new Date(baseMs + i * 1000).toISOString(),
      }))
      bSignals.push(makeSignal({
        commentId: 2000 + i,
        ts: new Date(baseMs + (i + 30) * 1000).toISOString(),
      }))
    }
    const out = unionRecords(rec(aSignals), rec(bSignals), scope)
    expect(out?.signals).toHaveLength(50)
    // Oldest 10 of aSignals (commentId 1000-1009) evicted.
    expect(out?.signals.find((s) => s.commentId === 1000)).toBeUndefined()
    expect(out?.signals.find((s) => s.commentId === 2029)).toBeDefined()
  })

  it("path-category scope: pathSha256 from scope wins on output", () => {
    const pathScope: ReviewMemoryStorageScope = {
      kind: "path-category",
      category: "tests",
      pathSha256: SAMPLE_SHA256,
    }
    const a: ReviewMemoryRecord = {
      schemaVersion: 1,
      category: "tests",
      pathSha256: SAMPLE_SHA256,
      signals: [makeSignal()],
      lastUpdatedTs: new Date().toISOString(),
    }
    const out = unionRecords(a, null, pathScope)
    expect(out?.pathSha256).toBe(SAMPLE_SHA256)
  })

  it("picks the most-recent lastUpdatedTs across inputs", () => {
    const older = new Date(Date.now() - 1000).toISOString()
    const newer = new Date(Date.now()).toISOString()
    const a: ReviewMemoryRecord = {
      schemaVersion: 1,
      category: "logic",
      signals: [],
      lastUpdatedTs: older,
    }
    const b: ReviewMemoryRecord = {
      schemaVersion: 1,
      category: "logic",
      signals: [],
      lastUpdatedTs: newer,
    }
    expect(unionRecords(a, b, scope)?.lastUpdatedTs).toBe(newer)
  })
})

// ─── SIG-247 Phase 1 — dual-write appendSignal ─────────────

describe("appendSignal — SIG-247 Phase 1 dual-write", () => {
  const owner = "acme"
  const repo = "site"
  const repoId = 12345
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

  it("writes BOTH legacy and repo-id keys when repoId is positive-integer", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv)
    const out = await appendSignal(
      env, owner, repo, scope, makeSignal(), repoId,
    )
    expect(out.written).toBe(true)
    expect(out.repoIdPresent).toBe(true)
    expect(out.legacyWritten).toBe(true)
    expect(out.newWritten).toBe(true)
    expect(out.partialDualWrite).toBe(false)
    expect(store.has(buildKey(owner, repo, scope))).toBe(true)
    expect(store.has(buildRepoIdKey(repoId, scope))).toBe(true)
  })

  it("emits review-memory-dual-write-succeeded telemetry on both-write success", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    await appendSignal(env, owner, repo, scope, makeSignal(), repoId)
    const events = consoleSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((s) => s.includes("review-memory-dual-write-succeeded"))
    expect(events.length).toBeGreaterThan(0)
  })

  it("emits review-memory-dual-write-failed (NOT -succeeded) when BOTH keys fail", async () => {
    // Code-reviewer M1: if both writes fail, partialDualWrite is
    // false (false !== false), so the prior implementation emitted
    // -succeeded with legacy_written=false, new_written=false. Any
    // dashboard counting -succeeded as a positive metric would
    // overcount. Three-way event split makes both-fail explicit.
    const { kv, failPut } = makeKvStub()
    failPut.value = true
    const env = makeEnv(kv)
    const out = await appendSignal(env, owner, repo, scope, makeSignal(), repoId)
    expect(out.written).toBe(false)
    expect(out.legacyWritten).toBe(false)
    expect(out.newWritten).toBe(false)
    const all = consoleSpy.mock.calls.map((args) => String(args[0]))
    expect(all.some((s) => s.includes("review-memory-dual-write-failed"))).toBe(true)
    expect(all.some((s) => s.includes("review-memory-dual-write-succeeded"))).toBe(false)
    expect(all.some((s) => s.includes("review-memory-dual-write-partial"))).toBe(false)
  })

  it("repoId=0 → legacy-only path, no dual-write telemetry", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv)
    const out = await appendSignal(env, owner, repo, scope, makeSignal(), 0)
    expect(out.repoIdPresent).toBe(false)
    expect(out.newWritten).toBe(false)
    expect(out.legacyWritten).toBe(true)
    expect(store.has(buildKey(owner, repo, scope))).toBe(true)
    expect(store.has(buildRepoIdKey(0, scope))).toBe(false)
    const events = consoleSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((s) => s.includes("review-memory-dual-write"))
    expect(events.length).toBe(0)
  })

  it("repoId=undefined → legacy-only path (back-compat)", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv)
    const out = await appendSignal(env, owner, repo, scope, makeSignal())
    expect(out.repoIdPresent).toBe(false)
    expect(store.has(buildKey(owner, repo, scope))).toBe(true)
  })

  it("repoId=-1 (invalid) → legacy-only path with positive-integer guard", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv)
    const out = await appendSignal(env, owner, repo, scope, makeSignal(), -1)
    expect(out.repoIdPresent).toBe(false)
    expect(store.has(buildRepoIdKey(-1, scope))).toBe(false)
  })

  it("idempotent on commentId: redundant write is a no-op + emits skipped_duplicate", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv)
    const signal = makeSignal({ commentId: 42 })
    const first = await appendSignal(env, owner, repo, scope, signal, repoId)
    expect(first.skippedDuplicate).toBe(false)
    expect(first.signalCount).toBe(1)
    const second = await appendSignal(env, owner, repo, scope, signal, repoId)
    expect(second.skippedDuplicate).toBe(true)
    expect(second.signalCount).toBe(1)  // unchanged
    const stored = JSON.parse(store.get(buildKey(owner, repo, scope))!)
    expect(stored.signals).toHaveLength(1)
  })

  it("union read: legacy has signal A, new key has signal B → both persist post-write", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv)
    // Seed legacy with signal A
    const legacyRec: ReviewMemoryRecord = {
      schemaVersion: 1,
      category: "logic",
      signals: [makeSignal({ commentId: 1, ts: new Date(Date.now() - 1000).toISOString() })],
      lastUpdatedTs: new Date().toISOString(),
    }
    store.set(buildKey(owner, repo, scope), JSON.stringify(legacyRec))
    // Seed new key with signal B
    const newRec: ReviewMemoryRecord = {
      schemaVersion: 1,
      category: "logic",
      signals: [makeSignal({ commentId: 2, ts: new Date(Date.now() - 500).toISOString() })],
      lastUpdatedTs: new Date().toISOString(),
    }
    store.set(buildRepoIdKey(repoId, scope), JSON.stringify(newRec))
    // Append signal C — read should union A+B+C, then write to both
    await appendSignal(env, owner, repo, scope, makeSignal({ commentId: 3 }), repoId)
    const legacyStored = JSON.parse(store.get(buildKey(owner, repo, scope))!)
    const newStored = JSON.parse(store.get(buildRepoIdKey(repoId, scope))!)
    expect(legacyStored.signals.map((s: ReviewMemorySignal) => s.commentId).sort())
      .toEqual([1, 2, 3])
    expect(newStored.signals.map((s: ReviewMemorySignal) => s.commentId).sort())
      .toEqual([1, 2, 3])
  })
})

// ─── SIG-247 Phase 1 — read-union readMemory ───────────────

describe("readMemory — SIG-247 Phase 1 read-union", () => {
  const owner = "acme"
  const repo = "site"
  const repoId = 12345
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

  it("repoId provided, only legacy populated → returns legacy record", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv)
    const rec: ReviewMemoryRecord = {
      schemaVersion: 1,
      category: "logic",
      signals: [makeSignal({ commentId: 1 })],
      lastUpdatedTs: new Date().toISOString(),
    }
    store.set(buildKey(owner, repo, scope), JSON.stringify(rec))
    const out = await readMemory(env, owner, repo, scope, repoId)
    expect(out?.signals).toHaveLength(1)
    expect(out?.signals[0]?.commentId).toBe(1)
  })

  it("repoId provided, only new key populated → returns new record", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv)
    const rec: ReviewMemoryRecord = {
      schemaVersion: 1,
      category: "logic",
      signals: [makeSignal({ commentId: 2 })],
      lastUpdatedTs: new Date().toISOString(),
    }
    store.set(buildRepoIdKey(repoId, scope), JSON.stringify(rec))
    const out = await readMemory(env, owner, repo, scope, repoId)
    expect(out?.signals).toHaveLength(1)
    expect(out?.signals[0]?.commentId).toBe(2)
  })

  it("both populated with disjoint signals → returns union", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv)
    const legacyRec: ReviewMemoryRecord = {
      schemaVersion: 1,
      category: "logic",
      signals: [makeSignal({ commentId: 1, ts: new Date(Date.now() - 1000).toISOString() })],
      lastUpdatedTs: new Date().toISOString(),
    }
    const newRec: ReviewMemoryRecord = {
      schemaVersion: 1,
      category: "logic",
      signals: [makeSignal({ commentId: 2, ts: new Date(Date.now() - 500).toISOString() })],
      lastUpdatedTs: new Date().toISOString(),
    }
    store.set(buildKey(owner, repo, scope), JSON.stringify(legacyRec))
    store.set(buildRepoIdKey(repoId, scope), JSON.stringify(newRec))
    const out = await readMemory(env, owner, repo, scope, repoId)
    expect(out?.signals.map((s) => s.commentId).sort()).toEqual([1, 2])
  })

  it("repoId NOT provided → reads legacy only (back-compat)", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv)
    const legacyRec: ReviewMemoryRecord = {
      schemaVersion: 1,
      category: "logic",
      signals: [makeSignal({ commentId: 1 })],
      lastUpdatedTs: new Date().toISOString(),
    }
    const newRec: ReviewMemoryRecord = {
      schemaVersion: 1,
      category: "logic",
      signals: [makeSignal({ commentId: 999 })],
      lastUpdatedTs: new Date().toISOString(),
    }
    store.set(buildKey(owner, repo, scope), JSON.stringify(legacyRec))
    store.set(buildRepoIdKey(repoId, scope), JSON.stringify(newRec))
    const out = await readMemory(env, owner, repo, scope)
    expect(out?.signals).toHaveLength(1)
    expect(out?.signals[0]?.commentId).toBe(1)  // legacy only; new key ignored
  })

  it("both empty → returns null", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    const out = await readMemory(env, owner, repo, scope, repoId)
    expect(out).toBeNull()
  })

  it("repoId=0 (invalid) → reads legacy only, ignores any new key", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv)
    const newRec: ReviewMemoryRecord = {
      schemaVersion: 1,
      category: "logic",
      signals: [makeSignal({ commentId: 999 })],
      lastUpdatedTs: new Date().toISOString(),
    }
    store.set(buildRepoIdKey(0, scope), JSON.stringify(newRec))
    const out = await readMemory(env, owner, repo, scope, 0)
    expect(out).toBeNull()
  })
})
