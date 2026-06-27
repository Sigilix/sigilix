// SIG-196: unit tests for slack-rate-limit — rolling KV counter per (teamId, slackUserId).
// Uses a Map-backed fake KVNamespace (get/put); no Workers-specific bindings required.
//
// Coverage:
//   (a) under cap → allowed:true with correct used
//   (b) at cap → allowed:false
//   (c) stale entries are pruned (don't count)
//   (d) KV get throws → fail-open {allowed:true, used:0}
//   (e) recordSlackAction appends and prunes
//   (f) checkSlackRateLimit never calls kv.put (pure read)

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"
import { checkSlackRateLimit, recordSlackAction } from "@/src/lib/slack/slack-rate-limit"

// ─── Map-backed fake KVNamespace ────────────────────────────────────────────

function makeFakeKV() {
  const store = new Map<string, string>()
  return {
    _store: store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, _opts?: unknown) => {
      store.set(key, value)
    }),
  }
}

type FakeKV = ReturnType<typeof makeFakeKV>

function makeEnv(kv: FakeKV): Pick<Env, "OPENCLAW_STATE"> {
  return { OPENCLAW_STATE: kv as unknown as KVNamespace }
}

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const TEAM_ID = "T001"
const USER_ID = "U001"
const KV_KEY = `slack-rl:${TEAM_ID}:${USER_ID}`
const NOW_MS = 1_000_000_000_000 // fixed epoch
const CAP = 3
const WINDOW_MS = 5 * 60 * 60 * 1000 // 5h default

let kv: FakeKV
let env: Pick<Env, "OPENCLAW_STATE">

beforeEach(() => {
  kv = makeFakeKV()
  env = makeEnv(kv)
  vi.clearAllMocks()
})

// ─── checkSlackRateLimit ─────────────────────────────────────────────────────

describe("checkSlackRateLimit", () => {
  it("(a) under cap → allowed:true with correct used count", async () => {
    const recentTs = [NOW_MS - 1000, NOW_MS - 2000]
    kv._store.set(KV_KEY, JSON.stringify(recentTs))

    const result = await checkSlackRateLimit(env, {
      teamId: TEAM_ID,
      slackUserId: USER_ID,
      nowMs: NOW_MS,
      cap: CAP,
      windowMs: WINDOW_MS,
    })

    expect(result).toEqual({ allowed: true, used: 2, cap: CAP })
  })

  it("(b) at cap → allowed:false", async () => {
    const recentTs = [NOW_MS - 1000, NOW_MS - 2000, NOW_MS - 3000]
    kv._store.set(KV_KEY, JSON.stringify(recentTs))

    const result = await checkSlackRateLimit(env, {
      teamId: TEAM_ID,
      slackUserId: USER_ID,
      nowMs: NOW_MS,
      cap: CAP,
      windowMs: WINDOW_MS,
    })

    expect(result).toEqual({ allowed: false, used: 3, cap: CAP })
  })

  it("(c) entries older than the window are pruned and do not count", async () => {
    const inWindow = NOW_MS - 1000
    const outOfWindow = NOW_MS - WINDOW_MS - 1 // 1 ms outside
    kv._store.set(KV_KEY, JSON.stringify([outOfWindow, outOfWindow, inWindow]))

    const result = await checkSlackRateLimit(env, {
      teamId: TEAM_ID,
      slackUserId: USER_ID,
      nowMs: NOW_MS,
      cap: CAP,
      windowMs: WINDOW_MS,
    })

    expect(result).toEqual({ allowed: true, used: 1, cap: CAP })
  })

  it("(d) KV get throws → fail-open {allowed:true, used:0}", async () => {
    kv.get.mockRejectedValueOnce(new Error("KV unavailable"))

    const result = await checkSlackRateLimit(env, {
      teamId: TEAM_ID,
      slackUserId: USER_ID,
      nowMs: NOW_MS,
    })

    expect(result).toEqual({ allowed: true, used: 0, cap: 3 })
  })

  it("(f) check never calls kv.put (pure read)", async () => {
    kv._store.set(KV_KEY, JSON.stringify([NOW_MS - 100]))

    await checkSlackRateLimit(env, { teamId: TEAM_ID, slackUserId: USER_ID, nowMs: NOW_MS })

    expect(kv.put).not.toHaveBeenCalled()
  })

  it("returns allowed:true, used:0 when no prior actions exist (missing KV key)", async () => {
    const result = await checkSlackRateLimit(env, {
      teamId: TEAM_ID,
      slackUserId: USER_ID,
      nowMs: NOW_MS,
    })

    expect(result).toEqual({ allowed: true, used: 0, cap: 3 })
  })
})

// ─── recordSlackAction ───────────────────────────────────────────────────────

describe("recordSlackAction", () => {
  it("(e) appends nowMs, prunes stale entries, and writes back with a TTL", async () => {
    const stale = NOW_MS - WINDOW_MS - 1
    const recent = NOW_MS - 1000
    kv._store.set(KV_KEY, JSON.stringify([stale, recent]))

    await recordSlackAction(env, {
      teamId: TEAM_ID,
      slackUserId: USER_ID,
      nowMs: NOW_MS,
      windowMs: WINDOW_MS,
    })

    expect(kv.put).toHaveBeenCalledTimes(1)
    const [putKey, putValue, putOpts] = kv.put.mock.calls[0] as [string, string, unknown]
    expect(putKey).toBe(KV_KEY)
    const stored = JSON.parse(putValue) as number[]
    // Stale entry pruned; recent + nowMs remain
    expect(stored).toEqual([recent, NOW_MS])
    // TTL must be set
    expect(putOpts).toMatchObject({ expirationTtl: expect.any(Number) })
  })

  it("swallows a KV fault silently without throwing", async () => {
    kv.get.mockRejectedValueOnce(new Error("KV unavailable"))

    await expect(
      recordSlackAction(env, { teamId: TEAM_ID, slackUserId: USER_ID, nowMs: NOW_MS }),
    ).resolves.toBeUndefined()
  })
})
