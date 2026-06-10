// SIG-225 — unit tests for the bot-authored commentId tracker.
//
// The bug: Sigilix posts a reply via OAuth, Linear fires another
// Comment.create webhook for the bot's own comment, the existing
// `isBotHandle(displayName)` self-filter fails (Linear may set
// data.user to the OAuth app owner's identity, not the bot's), and
// the SIG-225 thread-walk re-fires the bot into its own previous
// thread → duplicate reply in the wrong thread.
//
// This tracker is the deterministic defense: every commentId the bot
// creates is stamped in KV with a short TTL; the webhook handler
// checks it before any displayName-based filter. No dependency on
// what Linear puts in the webhook payload's `user` subtree.
//
// Defense-in-depth: the existing isBotHandle() check stays as the
// fallback for the cold-cache window (Cloudflare KV eventual
// consistency: a write from the queue worker may not be visible to
// a webhook worker on a different POP for up to ~60s).

import { describe, expect, it } from "vitest"
import {
  markBotAuthoredComment,
  isBotAuthoredComment,
  BOT_AUTHORED_KV_PREFIX,
  BOT_AUTHORED_TTL_SECONDS,
} from "@/src/lib/bot-authored-comments"

interface KvStub {
  kv: KVNamespace
  store: Map<string, string>
  puts: Array<{ key: string; value: string; options?: { expirationTtl?: number } }>
}

function makeKvStub(): KvStub {
  const store = new Map<string, string>()
  const puts: KvStub["puts"] = []
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null
    },
    async put(
      key: string,
      value: string,
      options?: { expirationTtl?: number }
    ): Promise<void> {
      store.set(key, value)
      puts.push({ key, value, options })
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
  } as unknown as KVNamespace
  return { kv, store, puts }
}

describe("BOT_AUTHORED_KV_PREFIX", () => {
  it("uses the documented namespaced prefix", () => {
    // The prefix is part of the public contract because the webhook
    // worker reads from the same KV namespace; changing it without
    // coordinated deploy would silently fall back to isBotHandle().
    expect(BOT_AUTHORED_KV_PREFIX).toBe("bot-authored-comment")
  })
})

describe("BOT_AUTHORED_TTL_SECONDS", () => {
  it("is long enough to cover Linear's webhook redelivery window but short enough to avoid leaking memory", () => {
    // Linear retries failed webhook deliveries over a couple of hours
    // at most; we set a 1-hour TTL which is well past the practical
    // re-delivery cadence while keeping the KV footprint trivial.
    expect(BOT_AUTHORED_TTL_SECONDS).toBeGreaterThanOrEqual(60 * 30)
    expect(BOT_AUTHORED_TTL_SECONDS).toBeLessThanOrEqual(60 * 60 * 6)
  })
})

describe("markBotAuthoredComment", () => {
  it("writes the commentId under the documented prefix with the TTL", async () => {
    const { kv, store, puts } = makeKvStub()
    await markBotAuthoredComment(kv, "comment-abc-123")
    expect(store.has(`${BOT_AUTHORED_KV_PREFIX}:comment-abc-123`)).toBe(true)
    expect(puts).toHaveLength(1)
    expect(puts[0].key).toBe(`${BOT_AUTHORED_KV_PREFIX}:comment-abc-123`)
    expect(puts[0].options?.expirationTtl).toBe(BOT_AUTHORED_TTL_SECONDS)
  })

  it("does not throw on empty / whitespace commentId (defensive no-op)", async () => {
    // Failure inside the helper must NEVER prevent the user-facing
    // reply from being posted, so the helper is intentionally
    // forgiving. Callers can call it unconditionally.
    const { kv, puts } = makeKvStub()
    await expect(markBotAuthoredComment(kv, "")).resolves.toBeUndefined()
    await expect(markBotAuthoredComment(kv, "   ")).resolves.toBeUndefined()
    expect(puts).toHaveLength(0)
  })

  it("swallows KV.put errors (best-effort: must never block the reply)", async () => {
    // The bot already posted the comment by the time we call this;
    // a KV write failure shouldn't surface as an unhandled rejection
    // and abort the surrounding handleMention path.
    const explodingKv = {
      async put(): Promise<void> {
        throw new Error("KV unavailable")
      },
      async get(): Promise<string | null> {
        return null
      },
    } as unknown as KVNamespace
    await expect(markBotAuthoredComment(explodingKv, "x")).resolves.toBeUndefined()
  })
})

describe("isBotAuthoredComment", () => {
  it("returns true after markBotAuthoredComment writes the commentId", async () => {
    const { kv } = makeKvStub()
    await markBotAuthoredComment(kv, "comment-xyz-789")
    expect(await isBotAuthoredComment(kv, "comment-xyz-789")).toBe(true)
  })

  it("returns false for an unmarked commentId", async () => {
    const { kv } = makeKvStub()
    expect(await isBotAuthoredComment(kv, "never-marked")).toBe(false)
  })

  it("returns false for empty / whitespace commentId (no probe)", async () => {
    const { kv } = makeKvStub()
    expect(await isBotAuthoredComment(kv, "")).toBe(false)
    expect(await isBotAuthoredComment(kv, "   ")).toBe(false)
  })

  it("returns false on KV.get errors (fail-open: legacy filters still run)", async () => {
    // If the KV read fails, we MUST return false so the downstream
    // self-filters (Option A id-match if/when added, then
    // isBotHandle()) get a chance to catch the self-reply. Returning
    // true on a transient KV blip would silently drop legitimate
    // user comments that happen to error on the lookup.
    const explodingKv = {
      async put(): Promise<void> {},
      async get(): Promise<string | null> {
        throw new Error("KV unavailable")
      },
    } as unknown as KVNamespace
    expect(await isBotAuthoredComment(explodingKv, "x")).toBe(false)
  })

  it("namespaces by commentId so different commentIds don't collide", async () => {
    const { kv } = makeKvStub()
    await markBotAuthoredComment(kv, "id-1")
    expect(await isBotAuthoredComment(kv, "id-1")).toBe(true)
    expect(await isBotAuthoredComment(kv, "id-2")).toBe(false)
  })

  it("is idempotent across repeat marks of the same commentId", async () => {
    // Defense-in-depth: the webhook handler stamps on the bot's
    // createComment, AND the queue consumer may also fire a stamp
    // path on retries. Re-marking the same commentId must not break
    // or change the lookup result. KV.put overwrites are safe.
    const { kv, puts } = makeKvStub()
    await markBotAuthoredComment(kv, "repeat-id")
    await markBotAuthoredComment(kv, "repeat-id")
    await markBotAuthoredComment(kv, "repeat-id")
    expect(await isBotAuthoredComment(kv, "repeat-id")).toBe(true)
    expect(puts).toHaveLength(3)
    for (const p of puts) {
      expect(p.options?.expirationTtl).toBe(BOT_AUTHORED_TTL_SECONDS)
    }
  })
})
