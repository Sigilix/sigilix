// ARC-189 — Capture pipeline tests (Task 9).

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { captureReviewFeedback } from "../src/lib/review-memory/capture"
import { buildKey } from "../src/lib/review-memory/storage"
import type { Env } from "../src/index"
import type { GitHubClient } from "../src/lib/github"
import type { ResolvedReviewMemoryConfig } from "../src/lib/review-memory/types"
import { computePathSha256 } from "../src/lib/review-memory/marker"

// ─── Test infra ──────────────────────────────────────────────

interface KvStub {
  kv: Env["OPENCLAW_STATE"]
  store: Map<string, string>
  putKeys: string[]
  failPut: { value: boolean }
  failPutKeys: Set<string>
}

function makeKvStub(): KvStub {
  const store = new Map<string, string>()
  const putKeys: string[] = []
  const failPut = { value: false }
  const failPutKeys = new Set<string>()
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null
    },
    async put(key: string, value: string): Promise<void> {
      putKeys.push(key)
      if (failPut.value || failPutKeys.has(key)) {
        throw new Error(`kv-put failed for ${key}`)
      }
      store.set(key, value)
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store, putKeys, failPut, failPutKeys }
}

function makeEnv(
  kv: Env["OPENCLAW_STATE"],
  captureEnv: "on" | "off" = "on",
): Env {
  return {
    OPENCLAW_STATE: kv,
    OPENCLAW_REVIEW_MEMORY_CAPTURE: captureEnv,
  } as unknown as Env
}

function makeConfig(
  over: Partial<ResolvedReviewMemoryConfig> = {},
): ResolvedReviewMemoryConfig {
  return {
    enabled: false,
    captureOnly: true,  // capture-only by default — testing the
                        // capture path independently from retrieval
    categories: ["security", "logic", "performance", "tests"],
    maxInjectedMemories: 5,
    minSignalThreshold: 3,
    maxSignalAgeDays: 90,
    ...over,
  }
}

interface FakeClientShape {
  getPullRequestReviewComment: ReturnType<typeof vi.fn>
}

function makeClient(parentBody: string | null): GitHubClient {
  const fn = vi.fn(async (_o: string, _r: string, _id: number) => {
    if (parentBody === null) return null
    return { id: 9001, body: parentBody }
  })
  return { getPullRequestReviewComment: fn } as unknown as GitHubClient
}

const VALID_MARKER =
  "<!-- sigilix:fid:1111111111111111:cat:performance:sev:warning:path:222222222222 -->"

// ─── Capture: gate skips ─────────────────────────────────────

describe("captureReviewFeedback — gate skips", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  })
  afterEach(() => {
    consoleSpy.mockRestore()
  })

  it("skips when env CAPTURE flag is off (no KV touched)", async () => {
    const { kv, putKeys } = makeKvStub()
    const env = makeEnv(kv, "off")
    const client = makeClient("body has parent marker")
    await captureReviewFeedback({
      env, client, owner: "a", repo: "r", prNumber: 1,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
      config: makeConfig(),
    })
    expect(putKeys.length).toBe(0)
  })

  it("skips when sigilix.json enabled=false AND captureOnly=false", async () => {
    const { kv, putKeys } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient("body has marker")
    await captureReviewFeedback({
      env, client, owner: "a", repo: "r", prNumber: 1,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
      config: makeConfig({ enabled: false, captureOnly: false }),
    })
    expect(putKeys.length).toBe(0)
  })

  it("skips when reply has no in_reply_to_id (top-level comment, not a reply)", async () => {
    const { kv, putKeys } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient(null)
    await captureReviewFeedback({
      env, client, owner: "a", repo: "r", prNumber: 1,
      replyComment: { id: 100, body: "false positive", path: "src/lib/foo.ts" },
      config: makeConfig(),
    })
    expect(putKeys.length).toBe(0)
  })
})

// ─── Capture: parent + reply parsing ────────────────────────

describe("captureReviewFeedback — parent + reply parsing", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  })
  afterEach(() => {
    consoleSpy.mockRestore()
  })

  it("happy path: parent has marker AND reply has dismissal → both KV writes + capture-written telemetry", async () => {
    const { kv, store, putKeys } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient(`Some review text\n\n${VALID_MARKER}`)
    await captureReviewFeedback({
      env, client, owner: "a", repo: "r", prNumber: 7,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
      config: makeConfig(),
    })
    // 1 seen-marker write + 2 signal writes = 3 puts total
    const signalWrites = putKeys.filter((k) =>
      k.startsWith("review-memory:a/r:"),
    )
    expect(signalWrites.length).toBe(2)
    // Both stored records present
    const catRecord = JSON.parse(
      store.get("review-memory:a/r:cat:performance")!,
    )
    expect(catRecord.signals.length).toBe(1)
    expect(catRecord.signals[0].fid).toBe("1111111111111111")
    expect(catRecord.signals[0].commentId).toBe(100)
    // Path-scope record exists (path-sha key derived from marker pathSha12 — but
    // capture pipeline uses the FULL sha256 derived independently so the test
    // can't predict the exact key without knowing the path. Check via prefix.)
    const pathScopeKeys = Array.from(store.keys()).filter((k) =>
      k.startsWith("review-memory:a/r:path:"),
    )
    expect(pathScopeKeys.length).toBe(1)
    // capture-written telemetry fired
    const events = consoleSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((s) => s.includes("review-memory-capture-written"))
    expect(events.length).toBeGreaterThan(0)
  })

  it("skips when parent has no marker (not-a-reply-to-sigilix)", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient("Just a review comment with no markers")
    await captureReviewFeedback({
      env, client, owner: "a", repo: "r", prNumber: 7,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
      config: makeConfig(),
    })
    expect(Array.from(store.keys())
      .filter((k) => k.startsWith("review-memory:a/r:")).length).toBe(0)
    const events = consoleSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((s) => s.includes("not-a-reply-to-sigilix"))
    expect(events.length).toBeGreaterThan(0)
  })

  it("skips when reply has no dismissal keyword (no-dismissal-keyword)", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient(`text\n${VALID_MARKER}`)
    await captureReviewFeedback({
      env, client, owner: "a", repo: "r", prNumber: 7,
      replyComment: { id: 100, body: "Thanks for the catch!", in_reply_to_id: 50, path: "src/lib/foo.ts" },
      config: makeConfig(),
    })
    expect(Array.from(store.keys())
      .filter((k) => k.startsWith("review-memory:a/r:")).length).toBe(0)
    const events = consoleSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((s) => s.includes("no-dismissal-keyword"))
    expect(events.length).toBeGreaterThan(0)
  })

  it("skips when parent fetch returns null (parent-fetch-failed) — defensive", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient(null)  // parent deleted / 404
    await captureReviewFeedback({
      env, client, owner: "a", repo: "r", prNumber: 7,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
      config: makeConfig(),
    })
    expect(Array.from(store.keys())
      .filter((k) => k.startsWith("review-memory:a/r:")).length).toBe(0)
  })
})

// ─── Capture: idempotency + race ─────────────────────────────

describe("captureReviewFeedback — idempotency + concurrent race", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  })
  afterEach(() => {
    consoleSpy.mockRestore()
  })

  it("sequential delivery: second call on same commentId hits already-seen", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient(`text\n${VALID_MARKER}`)
    const args = {
      env, client, owner: "a", repo: "r", prNumber: 7,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
      config: makeConfig(),
    } as const
    await captureReviewFeedback(args)
    const catRecordAfterFirst = JSON.parse(
      store.get("review-memory:a/r:cat:performance")!,
    )
    expect(catRecordAfterFirst.signals.length).toBe(1)

    // Second call - should hit already-seen and NOT add another signal
    await captureReviewFeedback(args)
    const catRecordAfterSecond = JSON.parse(
      store.get("review-memory:a/r:cat:performance")!,
    )
    expect(catRecordAfterSecond.signals.length).toBe(1)
    const events = consoleSpy.mock.calls
      .map((args2) => String(args2[0]))
      .filter((s) => s.includes("already-seen"))
    expect(events.length).toBeGreaterThan(0)
  })

  it("concurrent delivery (bounded duplicate tolerance ≤2 per spec §10)", async () => {
    // Simulate two simultaneous webhook deliveries: we run captureReviewFeedback
    // twice IN PARALLEL on a fresh KV. Without CAS the seen-marker check can
    // pass on both, so signals recorded ≤ 2 (NOT exactly 1).
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient(`text\n${VALID_MARKER}`)
    const args = {
      env, client, owner: "a", repo: "r", prNumber: 7,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
      config: makeConfig(),
    } as const
    await Promise.all([
      captureReviewFeedback(args),
      captureReviewFeedback(args),
    ])
    const catRecord = JSON.parse(
      store.get("review-memory:a/r:cat:performance")!,
    )
    expect(catRecord.signals.length).toBeGreaterThanOrEqual(1)
    expect(catRecord.signals.length).toBeLessThanOrEqual(2)
  })
})

// ─── Capture: error resilience ───────────────────────────────

describe("captureReviewFeedback — best-effort error resilience", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  })
  afterEach(() => {
    consoleSpy.mockRestore()
  })

  it("does not throw when KV put fails", async () => {
    const { kv, failPut } = makeKvStub()
    failPut.value = true
    const env = makeEnv(kv, "on")
    const client = makeClient(`text\n${VALID_MARKER}`)
    await expect(
      captureReviewFeedback({
        env, client, owner: "a", repo: "r", prNumber: 7,
        replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
        config: makeConfig(),
      }),
    ).resolves.toBeUndefined()
  })

  it("path-scope write attempted even if category-scope fails", async () => {
    const { kv, failPutKeys } = makeKvStub()
    failPutKeys.add("review-memory:a/r:cat:performance")
    const env = makeEnv(kv, "on")
    const client = makeClient(`text\n${VALID_MARKER}`)
    await captureReviewFeedback({
      env, client, owner: "a", repo: "r", prNumber: 7,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
      config: makeConfig(),
    })
    // capture-failed for the cat-scope key + capture-written for the path-scope
    const events = consoleSpy.mock.calls.map((args2) => String(args2[0]))
    expect(events.some((s) => s.includes("review-memory-capture-failed"))).toBe(true)
    expect(events.some((s) => s.includes("review-memory-capture-written"))).toBe(true)
  })

  it("does not throw when client.getPullRequestReviewComment throws", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = {
      getPullRequestReviewComment: vi.fn(async () => {
        throw new Error("network fail")
      }),
    } as unknown as GitHubClient
    await expect(
      captureReviewFeedback({
        env, client, owner: "a", repo: "r", prNumber: 7,
        replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
        config: makeConfig(),
      }),
    ).resolves.toBeUndefined()
  })
})

// ─── KV-key path-sha derivation ─────────────────────────────

describe("captureReviewFeedback — path-key derivation uses replyComment.path", () => {
  it("path-scope KV key uses full SHA-256 of replyComment.path (matches lookup keyspace)", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient(`text\n${VALID_MARKER}`)
    const path = "src/lib/foo.ts"
    await captureReviewFeedback({
      env, client, owner: "a", repo: "r", prNumber: 7,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path },
      config: makeConfig(),
    })
    // KV key uses the full SHA-256 of the comment's anchored path.
    const expectedSha256 = await computePathSha256(path)
    const expectedKey = buildKey("a", "r", {
      kind: "path-category",
      category: "performance",
      pathSha256: expectedSha256,
    })
    expect(store.get(expectedKey)).toBeDefined()
  })
})
