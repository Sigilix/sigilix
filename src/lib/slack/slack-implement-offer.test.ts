// SIG-545 B3c: unit tests for the thread-scoped pending-offer state + the
// affirmative/revise classifier. KV is a Map-backed fake (get/put/delete); the
// classifier is pure.

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"
import {
  classifyOfferReply,
  clearImplementOffer,
  getImplementOffer,
  setImplementOffer,
} from "@/src/lib/slack/slack-implement-offer"

// ─── Map-backed fake KVNamespace ────────────────────────────────────────────

function makeFakeKV() {
  const store = new Map<string, string>()
  return {
    _store: store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, _opts?: unknown) => {
      store.set(key, value)
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key)
    }),
  }
}

type FakeKV = ReturnType<typeof makeFakeKV>

function makeEnv(kv: FakeKV): Pick<Env, "OPENCLAW_STATE"> {
  return { OPENCLAW_STATE: kv as unknown as KVNamespace }
}

const CHANNEL = "C001"
const THREAD = "1700000000.000100"
const KEY = `slack-implement-offer:${CHANNEL}:${THREAD}`

let kv: FakeKV
let env: Pick<Env, "OPENCLAW_STATE">

beforeEach(() => {
  kv = makeFakeKV()
  env = makeEnv(kv)
  vi.clearAllMocks()
})

// ─── State accessors ─────────────────────────────────────────────────────────

describe("slack-implement-offer state", () => {
  it("set → get round-trips the offer", async () => {
    await setImplementOffer(env, CHANNEL, THREAD, { plan: "x / y / z", title: "Add retry" })
    const got = await getImplementOffer(env, CHANNEL, THREAD)
    expect(got).toEqual({ plan: "x / y / z", title: "Add retry" })
  })

  it("set writes with a 24h TTL", async () => {
    await setImplementOffer(env, CHANNEL, THREAD, { plan: "p", title: "t" })
    expect(kv.put).toHaveBeenCalledTimes(1)
    const [putKey, , putOpts] = kv.put.mock.calls[0] as [string, string, unknown]
    expect(putKey).toBe(KEY)
    expect(putOpts).toMatchObject({ expirationTtl: 86_400 })
  })

  it("get returns null on a miss", async () => {
    expect(await getImplementOffer(env, CHANNEL, THREAD)).toBeNull()
  })

  it("get returns null on a malformed value", async () => {
    kv._store.set(KEY, "{not json")
    expect(await getImplementOffer(env, CHANNEL, THREAD)).toBeNull()
  })

  it("get returns null when plan or title is missing", async () => {
    kv._store.set(KEY, JSON.stringify({ plan: "only plan" }))
    expect(await getImplementOffer(env, CHANNEL, THREAD)).toBeNull()
  })

  it("get fails closed (null) on a KV fault", async () => {
    kv.get.mockRejectedValueOnce(new Error("KV down"))
    expect(await getImplementOffer(env, CHANNEL, THREAD)).toBeNull()
  })

  it("clear removes the stored offer", async () => {
    await setImplementOffer(env, CHANNEL, THREAD, { plan: "p", title: "t" })
    await clearImplementOffer(env, CHANNEL, THREAD)
    expect(kv.delete).toHaveBeenCalledWith(KEY)
    expect(await getImplementOffer(env, CHANNEL, THREAD)).toBeNull()
  })

  it("set swallows a KV fault without throwing", async () => {
    kv.put.mockRejectedValueOnce(new Error("KV down"))
    await expect(setImplementOffer(env, CHANNEL, THREAD, { plan: "p", title: "t" })).resolves.toBeUndefined()
  })
})

// ─── Classifier ──────────────────────────────────────────────────────────────

describe("classifyOfferReply", () => {
  it.each(["yes", "yep", "go ahead", "do it", "ship it", "lgtm", "sounds good", "OK", "perfect", "please do"])(
    "treats %j as confirm",
    (text) => {
      expect(classifyOfferReply(text)).toBe("confirm")
    },
  )

  it.each([
    "do it this way instead",
    "I'd prefer X",
    "it'd be better if you did X",
    "can you also add a test?",
    "use a queue instead",
    // A counter-proposal that STARTS with a negation must negotiate, not decline.
    "no, use a queue instead",
    "no — do it this way",
    "nope, add a test first",
  ])("treats %j as revise", (text) => {
    expect(classifyOfferReply(text)).toBe("revise")
  })

  it.each([
    "no",
    "nope",
    "nah",
    "never mind",
    "nevermind",
    "cancel",
    "stop",
    "forget it",
    "leave it",
    "drop it",
    "no thanks",
    "not now",
  ])("treats %j as decline", (text) => {
    expect(classifyOfferReply(text)).toBe("decline")
  })
})
