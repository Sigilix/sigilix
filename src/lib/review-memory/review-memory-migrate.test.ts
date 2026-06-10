// SIG-247 Phase 1 PR B — unit tests for the review-memory migration
// helper. Mirrors the SIG-243 `index-migrate-to-repo-id.test.ts`
// pattern: per-repo state machine + read-union-write semantics +
// dry-run + idempotent re-run.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { migrateOneRepoReviewMemory } from "@/lib/review-memory/migrate"
import { GitHubClient } from "@/shared/adapters/github"
import type { Env } from "@/shared/types/env"
import type {
  ReviewMemoryRecord,
  ReviewMemorySignal,
} from "@/lib/review-memory/types"

interface KvStub {
  kv: Env["OPENCLAW_STATE"]
  store: Map<string, string>
}

function makeKvStub(): KvStub {
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
    async list({ prefix }: { prefix: string }): Promise<{
      keys: { name: string }[]
      list_complete: boolean
      cursor?: string
    }> {
      const keys = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }))
      return { keys, list_complete: true }
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store }
}

function makeEnv(kv: Env["OPENCLAW_STATE"]): Env {
  return { OPENCLAW_STATE: kv } as unknown as Env
}

function makeClient(
  getRepository: (
    owner: string,
    repo: string,
  ) => Promise<{ default_branch: string; id: number | undefined } | null>,
): GitHubClient {
  return { getRepository } as unknown as GitHubClient
}

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

function makeRecord(signals: ReviewMemorySignal[]): ReviewMemoryRecord {
  return {
    schemaVersion: 1,
    category: "performance",
    signals,
    lastUpdatedTs: new Date().toISOString(),
  }
}

const OWNER = "Arc-and-Anchor"
const REPO = "sigilix"
const REPO_ID = 808247824

describe("migrateOneRepoReviewMemory — state machine", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  })
  afterEach(() => {
    consoleSpy.mockRestore()
  })

  it("returns 'no-legacy-records' when the legacy prefix has no keys", async () => {
    const { kv } = makeKvStub()
    const client = makeClient(async () => {
      throw new Error("should not be called — no legacy state")
    })
    const out = await migrateOneRepoReviewMemory(makeEnv(kv), client, OWNER, REPO)
    expect(out.status).toBe("no-legacy-records")
    expect(out.legacyKeysFound).toBe(0)
    expect(out.recordsWritten).toBe(0)
  })

  it("returns 'github-404' when GitHub says the repo is gone", async () => {
    const { kv, store } = makeKvStub()
    store.set(
      `review-memory:${OWNER}/${REPO}:cat:performance`,
      JSON.stringify(makeRecord([makeSignal()])),
    )
    const client = makeClient(async () => null)
    const out = await migrateOneRepoReviewMemory(makeEnv(kv), client, OWNER, REPO)
    expect(out.status).toBe("github-404")
    expect(out.legacyKeysFound).toBe(1)
    expect(out.recordsWritten).toBe(0)
  })

  it("returns 'github-no-id' when GitHub responds without a positive integer id", async () => {
    const { kv, store } = makeKvStub()
    store.set(
      `review-memory:${OWNER}/${REPO}:cat:performance`,
      JSON.stringify(makeRecord([makeSignal()])),
    )
    const client = makeClient(async () => ({ default_branch: "main", id: undefined }))
    const out = await migrateOneRepoReviewMemory(makeEnv(kv), client, OWNER, REPO)
    expect(out.status).toBe("github-no-id")
  })

  it("returns 'github-error' when the GitHub call throws", async () => {
    const { kv, store } = makeKvStub()
    store.set(
      `review-memory:${OWNER}/${REPO}:cat:performance`,
      JSON.stringify(makeRecord([makeSignal()])),
    )
    const client = makeClient(async () => {
      throw new Error("transient 502")
    })
    const out = await migrateOneRepoReviewMemory(makeEnv(kv), client, OWNER, REPO)
    expect(out.status).toBe("github-error")
    expect(out.detail).toContain("transient 502")
  })

  it("copies a legacy category-scope record to the new keyspace with migratedAt sentinel", async () => {
    const { kv, store } = makeKvStub()
    const seedRecord = makeRecord([
      makeSignal({ commentId: 1 }),
      makeSignal({ commentId: 2 }),
    ])
    store.set(
      `review-memory:${OWNER}/${REPO}:cat:performance`,
      JSON.stringify(seedRecord),
    )
    const client = makeClient(async () => ({ default_branch: "main", id: REPO_ID }))
    const out = await migrateOneRepoReviewMemory(makeEnv(kv), client, OWNER, REPO)
    expect(out.status).toBe("migrated")
    expect(out.githubRepoId).toBe(REPO_ID)
    expect(out.recordsWritten).toBe(1)
    expect(out.signalsCopied).toBe(2)
    const newRecord = JSON.parse(
      store.get(`review-memory:repo:${REPO_ID}:cat:performance`)!,
    )
    expect(newRecord.signals).toHaveLength(2)
    expect(newRecord.migratedAt).toBeDefined()
    expect(new Date(newRecord.migratedAt).getTime()).toBeGreaterThan(0)
  })

  it("copies path-scope records preserving the pathSha256 in both key and value", async () => {
    const { kv, store } = makeKvStub()
    const pathSha =
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
    const seedRecord: ReviewMemoryRecord = {
      schemaVersion: 1,
      category: "logic",
      pathSha256: pathSha,
      signals: [makeSignal({ commentId: 7 })],
      lastUpdatedTs: new Date().toISOString(),
    }
    store.set(
      `review-memory:${OWNER}/${REPO}:path:${pathSha}:cat:logic`,
      JSON.stringify(seedRecord),
    )
    const client = makeClient(async () => ({ default_branch: "main", id: REPO_ID }))
    const out = await migrateOneRepoReviewMemory(makeEnv(kv), client, OWNER, REPO)
    expect(out.status).toBe("migrated")
    expect(out.recordsWritten).toBe(1)
    const newKey = `review-memory:repo:${REPO_ID}:path:${pathSha}:cat:logic`
    const newRecord = JSON.parse(store.get(newKey)!)
    expect(newRecord.signals).toHaveLength(1)
    expect(newRecord.pathSha256).toBe(pathSha)
    expect(newRecord.migratedAt).toBeDefined()
  })

  it("read-union-write: merges legacy + existing new-key signals on commentId dedup", async () => {
    // The new key may already hold a record from Phase 1 PR A
    // dual-write captures during the transition window. Naive
    // overwrite would lose those signals. Migration must read-union.
    const { kv, store } = makeKvStub()
    const olderTs = new Date(Date.now() - 5000).toISOString()
    const newerTs = new Date(Date.now() - 500).toISOString()
    // Legacy: signals A (commentId 1) + B (commentId 2)
    store.set(
      `review-memory:${OWNER}/${REPO}:cat:tests`,
      JSON.stringify({
        schemaVersion: 1,
        category: "tests",
        signals: [
          makeSignal({ commentId: 1, ts: olderTs }),
          makeSignal({ commentId: 2, ts: olderTs }),
        ],
        lastUpdatedTs: olderTs,
      }),
    )
    // New key: signals B (commentId 2 — dup) + C (commentId 3)
    store.set(
      `review-memory:repo:${REPO_ID}:cat:tests`,
      JSON.stringify({
        schemaVersion: 1,
        category: "tests",
        signals: [
          makeSignal({ commentId: 2, ts: newerTs }),
          makeSignal({ commentId: 3, ts: newerTs }),
        ],
        lastUpdatedTs: newerTs,
      }),
    )
    const client = makeClient(async () => ({ default_branch: "main", id: REPO_ID }))
    const out = await migrateOneRepoReviewMemory(makeEnv(kv), client, OWNER, REPO)
    expect(out.status).toBe("migrated")
    const merged = JSON.parse(
      store.get(`review-memory:repo:${REPO_ID}:cat:tests`)!,
    )
    expect(merged.signals).toHaveLength(3)
    // commentId 2 deduped — the newerTs wins
    const dupSignal = merged.signals.find(
      (s: ReviewMemorySignal) => s.commentId === 2,
    )
    expect(dupSignal.ts).toBe(newerTs)
    expect(merged.signals.map((s: ReviewMemorySignal) => s.commentId).sort())
      .toEqual([1, 2, 3])
  })

  it("M1: preserves the original migratedAt on idempotent re-runs (NOT restamped)", async () => {
    // Code-reviewer M1: re-running migration must NOT reset the
    // sentinel to "last re-run". The original "first migrated"
    // timestamp is what Phase 5 cleanup relies on as evidence.
    const { kv, store } = makeKvStub()
    const seedRecord = makeRecord([makeSignal({ commentId: 1 })])
    store.set(
      `review-memory:${OWNER}/${REPO}:cat:performance`,
      JSON.stringify(seedRecord),
    )
    const originalStamp = "2026-05-01T00:00:00.000Z"
    store.set(
      `review-memory:repo:${REPO_ID}:cat:performance`,
      JSON.stringify({ ...seedRecord, migratedAt: originalStamp }),
    )
    const client = makeClient(async () => ({ default_branch: "main", id: REPO_ID }))
    await migrateOneRepoReviewMemory(makeEnv(kv), client, OWNER, REPO)
    const after = JSON.parse(
      store.get(`review-memory:repo:${REPO_ID}:cat:performance`)!,
    )
    expect(after.migratedAt).toBe(originalStamp)
  })

  it("M2: dryRun separates recordsConsidered (planned) from recordsWritten (0)", async () => {
    // Code-reviewer M2: dryRun must NOT inflate recordsWritten —
    // that field's semantic is "actual KV puts that succeeded".
    // recordsConsidered is the "how big is this batch?" surface.
    const { kv, store } = makeKvStub()
    store.set(
      `review-memory:${OWNER}/${REPO}:cat:performance`,
      JSON.stringify(makeRecord([makeSignal()])),
    )
    store.set(
      `review-memory:${OWNER}/${REPO}:cat:logic`,
      JSON.stringify(makeRecord([makeSignal({ commentId: 5 })])),
    )
    const client = makeClient(async () => ({ default_branch: "main", id: REPO_ID }))
    const out = await migrateOneRepoReviewMemory(
      makeEnv(kv),
      client,
      OWNER,
      REPO,
      { dryRun: true },
    )
    expect(out.recordsConsidered).toBe(2)
    expect(out.recordsWritten).toBe(0)
  })

  it("idempotent re-run: status='already-migrated' when every new-key record has migratedAt", async () => {
    const { kv, store } = makeKvStub()
    const seedRecord = makeRecord([makeSignal({ commentId: 1 })])
    store.set(
      `review-memory:${OWNER}/${REPO}:cat:performance`,
      JSON.stringify(seedRecord),
    )
    // Pre-seed the new key with migratedAt sentinel
    store.set(
      `review-memory:repo:${REPO_ID}:cat:performance`,
      JSON.stringify({
        ...seedRecord,
        migratedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    )
    const client = makeClient(async () => ({ default_branch: "main", id: REPO_ID }))
    const out = await migrateOneRepoReviewMemory(makeEnv(kv), client, OWNER, REPO)
    expect(out.status).toBe("already-migrated")
    expect(out.legacyKeysFound).toBe(1)
  })

  it("dryRun=true: reads + computes union but does NOT write to KV", async () => {
    const { kv, store } = makeKvStub()
    const seedRecord = makeRecord([makeSignal({ commentId: 1 })])
    store.set(
      `review-memory:${OWNER}/${REPO}:cat:performance`,
      JSON.stringify(seedRecord),
    )
    const client = makeClient(async () => ({ default_branch: "main", id: REPO_ID }))
    const out = await migrateOneRepoReviewMemory(
      makeEnv(kv),
      client,
      OWNER,
      REPO,
      { dryRun: true },
    )
    expect(out.status).toBe("migrated")
    expect(out.recordsConsidered).toBe(1)  // planned
    expect(out.recordsWritten).toBe(0)     // actual KV puts (M2 fix)
    expect(out.signalsCopied).toBe(1)
    // The new key was NOT written
    expect(store.has(`review-memory:repo:${REPO_ID}:cat:performance`)).toBe(false)
  })

  it("skips corrupt legacy records but continues on remaining valid ones", async () => {
    const { kv, store } = makeKvStub()
    // One corrupt + one valid
    store.set(
      `review-memory:${OWNER}/${REPO}:cat:performance`,
      "not-json {{",
    )
    store.set(
      `review-memory:${OWNER}/${REPO}:cat:logic`,
      JSON.stringify(makeRecord([makeSignal()])),
    )
    const client = makeClient(async () => ({ default_branch: "main", id: REPO_ID }))
    const out = await migrateOneRepoReviewMemory(makeEnv(kv), client, OWNER, REPO)
    expect(out.status).toBe("migrated")
    // Only the valid record was discovered + written
    expect(out.recordsWritten).toBe(1)
    expect(store.has(`review-memory:repo:${REPO_ID}:cat:logic`)).toBe(true)
    expect(store.has(`review-memory:repo:${REPO_ID}:cat:performance`)).toBe(false)
  })

  it("does NOT delete the legacy key (cleanup deferred to Phase 5)", async () => {
    // PR B is migration-only. Legacy keys stay intact until Phase 5
    // confirms zero canary regressions over a 7-day window.
    const { kv, store } = makeKvStub()
    const legacyKey = `review-memory:${OWNER}/${REPO}:cat:performance`
    store.set(legacyKey, JSON.stringify(makeRecord([makeSignal()])))
    const client = makeClient(async () => ({ default_branch: "main", id: REPO_ID }))
    await migrateOneRepoReviewMemory(makeEnv(kv), client, OWNER, REPO)
    expect(store.has(legacyKey)).toBe(true)
  })

  it("rejects an unknown category in the legacy key shape (defensive parser)", async () => {
    const { kv, store } = makeKvStub()
    // Bogus category — not in ALL_REVIEW_MEMORY_CATEGORIES
    store.set(
      `review-memory:${OWNER}/${REPO}:cat:bogus`,
      JSON.stringify({
        schemaVersion: 1,
        category: "bogus",
        signals: [],
        lastUpdatedTs: new Date().toISOString(),
      }),
    )
    const client = makeClient(async () => {
      throw new Error("should not be called — no valid legacy state")
    })
    const out = await migrateOneRepoReviewMemory(makeEnv(kv), client, OWNER, REPO)
    expect(out.status).toBe("no-legacy-records")
  })
})
