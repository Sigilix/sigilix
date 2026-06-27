// SIG-196: tests for handleSlackRequest — the /slack/events route.
//
// Coverage:
//   (a) mode=off → inert 200 but url_verification is echoed regardless
//   (b) bad sig → 401
//   (c) missing SLACK_SIGNING_SECRET → 503
//   (d) duplicate event_id (KV pre-seeded) → 200, runSlackAgent NOT called
//   (e) on + valid app_mention + scoped channel → 200 ack; after flushing
//       waitUntil: runSlackAgent + postSlackMessage called
//   (f) unscoped channel → runSlackAgent NOT called; 'not connected' message posted
//   (g) shadow → runSlackAgent called, postSlackMessage NOT called, recordSlackAction NOT called

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"

// ─── Mock declarations (must precede imports of the mocked modules) ──────────

vi.mock("@/src/lib/slack/slack-scope", () => ({
  resolveSlackScope: vi.fn(),
}))
vi.mock("@/src/lib/slack/slack-agent", () => ({
  runSlackAgent: vi.fn(),
}))
vi.mock("@/src/lib/slack/slack-install", () => ({
  getSlackBotToken: vi.fn(),
  handleSlackInstall: vi.fn(),
  handleSlackOAuthCallback: vi.fn(),
}))
vi.mock("@/src/lib/slack/slack-api", () => ({
  postSlackMessage: vi.fn(),
  fetchSlackThread: vi.fn(),
  capAndRedactThread: vi.fn(),
}))
vi.mock("@/src/lib/slack/slack-rate-limit", () => ({
  checkSlackRateLimit: vi.fn(),
  recordSlackAction: vi.fn(),
}))

import { resolveSlackScope } from "@/src/lib/slack/slack-scope"
import { runSlackAgent } from "@/src/lib/slack/slack-agent"
import { getSlackBotToken } from "@/src/lib/slack/slack-install"
import { postSlackMessage, fetchSlackThread, capAndRedactThread } from "@/src/lib/slack/slack-api"
import { checkSlackRateLimit, recordSlackAction } from "@/src/lib/slack/slack-rate-limit"

// Import under test AFTER mocks are declared.
import { handleSlackRequest } from "@/src/index-slack-webhook"

// ─── HMAC sign helper (matches pattern from slack-verify.test.ts) ─────────────

const encoder = new TextEncoder()

async function sign(ts: string, body: string, secret: string): Promise<string> {
  const basestring = `v0:${ts}:${body}`
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(basestring))
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  return `v0=${hex}`
}

// ─── Fake KV ──────────────────────────────────────────────────────────────────

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
    list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: undefined })),
    getWithMetadata: vi.fn(async (_key: string) => ({ value: null, metadata: null })),
  }
}

type FakeKV = ReturnType<typeof makeFakeKV>

// ─── Fake ExecutionContext ────────────────────────────────────────────────────

function makeFakeCtx() {
  let storedPromise: Promise<void> | undefined
  const ctx = {
    waitUntil: vi.fn((p: Promise<void>) => {
      storedPromise = p
    }),
    passThroughOnException: vi.fn(),
    /** Flush the deferred promise so tests can assert on its side-effects. */
    flush: async () => {
      if (storedPromise) await storedPromise
    },
  }
  return ctx
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SIGNING_SECRET = "test-signing-secret"
const TEAM_ID = "T123"
const CHANNEL_ID = "C456"
const USER_ID = "U789"
const BOT_TOKEN = "xoxb-fake-bot-token"
const EVENT_ID = "Ev001"

const APP_MENTION_BODY = JSON.stringify({
  type: "event_callback",
  team_id: TEAM_ID,
  event_id: EVENT_ID,
  event: {
    type: "app_mention",
    user: USER_ID,
    channel: CHANNEL_ID,
    text: "<@U0BOTID> help me understand the codebase",
    ts: "1234567890.000001",
  },
})

// ─── Request builder ──────────────────────────────────────────────────────────

async function makeSignedRequest(body: string, secret: string, tsOverride?: string): Promise<Request> {
  const ts = tsOverride ?? String(Math.floor(Date.now() / 1000))
  const sig = await sign(ts, body, secret)
  return new Request("https://worker.example.com/slack/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-signature": sig,
      "x-slack-request-timestamp": ts,
    },
    body,
  })
}

// ─── Env factory ──────────────────────────────────────────────────────────────

function makeEnv(mode: "off" | "shadow" | "on", kv: FakeKV, secret: string | undefined = SIGNING_SECRET): Env {
  return {
    OPENCLAW_STATE: kv as unknown as KVNamespace,
    SIGILIX_SLACK_MODE: mode,
    SLACK_SIGNING_SECRET: secret,
  } as unknown as Env
}

// ─── Scoped scope mock ────────────────────────────────────────────────────────

function scopeOk() {
  vi.mocked(resolveSlackScope).mockReturnValue({
    ok: true,
    scope: {
      teamId: TEAM_ID,
      channelId: CHANNEL_ID,
      repos: [{ owner: "sigilix", repo: "sigilix", installationId: 111 }],
      linearTeam: null,
    },
  })
}

function scopeDenied() {
  vi.mocked(resolveSlackScope).mockReturnValue({ ok: false, reason: "no-config" })
}

// ─── Shared test setup ────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()

  // Happy-path defaults.
  scopeOk()
  vi.mocked(getSlackBotToken).mockResolvedValue(BOT_TOKEN)
  vi.mocked(postSlackMessage).mockResolvedValue({ ok: true })
  vi.mocked(fetchSlackThread).mockResolvedValue(["thread message"])
  vi.mocked(capAndRedactThread).mockReturnValue("thread message")
  vi.mocked(checkSlackRateLimit).mockResolvedValue({ allowed: true, used: 0, cap: 3 })
  vi.mocked(recordSlackAction).mockResolvedValue(undefined)
  vi.mocked(runSlackAgent).mockResolvedValue({
    reply: "Agent reply",
    action: { kind: "qa" },
  })
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("handleSlackRequest", () => {
  // ── (a) off mode ────────────────────────────────────────────────────────────

  describe("(a) mode=off", () => {
    it("returns inert 200 for a regular event payload when mode is off", async () => {
      const kv = makeFakeKV()
      const env = makeEnv("off", kv)
      const ctx = makeFakeCtx()
      const req = await makeSignedRequest(APP_MENTION_BODY, SIGNING_SECRET)

      const res = await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)

      expect(res.status).toBe(200)
      expect(ctx.waitUntil).not.toHaveBeenCalled()
    })

    it("echoes url_verification challenge even when mode is off (before any auth)", async () => {
      const kv = makeFakeKV()
      const env = makeEnv("off", kv)
      const ctx = makeFakeCtx()
      const body = JSON.stringify({ type: "url_verification", challenge: "abc123challenge" })
      // No signature headers needed — url_verification is answered before auth.
      const req = new Request("https://worker.example.com/slack/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })

      const res = await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)

      expect(res.status).toBe(200)
      const json = (await res.json()) as { challenge: string }
      expect(json.challenge).toBe("abc123challenge")
    })
  })

  // ── (b) bad signature → 401 ─────────────────────────────────────────────────

  it("(b) returns 401 when the Slack signature is wrong", async () => {
    const kv = makeFakeKV()
    const env = makeEnv("on", kv)
    const ctx = makeFakeCtx()
    const ts = String(Math.floor(Date.now() / 1000))
    // Sign with the WRONG secret.
    const badSig = await sign(ts, APP_MENTION_BODY, "wrong-secret")
    const req = new Request("https://worker.example.com/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-signature": badSig,
        "x-slack-request-timestamp": ts,
      },
      body: APP_MENTION_BODY,
    })

    const res = await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)

    expect(res.status).toBe(401)
    expect(ctx.waitUntil).not.toHaveBeenCalled()
  })

  // ── (c) missing signing secret → 503 ────────────────────────────────────────

  it("(c) returns 503 when SLACK_SIGNING_SECRET is unset", async () => {
    const kv = makeFakeKV()
    // Build env WITHOUT SLACK_SIGNING_SECRET (JS default-param pitfall: passing
    // undefined explicitly still triggers the default, so we omit the key entirely).
    const env = {
      OPENCLAW_STATE: kv as unknown as KVNamespace,
      SIGILIX_SLACK_MODE: "on",
    } as unknown as Env
    const ctx = makeFakeCtx()
    const req = await makeSignedRequest(APP_MENTION_BODY, SIGNING_SECRET)

    const res = await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)

    expect(res.status).toBe(503)
    expect(ctx.waitUntil).not.toHaveBeenCalled()
  })

  // ── (d) duplicate event_id → 200 no-op ─────────────────────────────────────

  it("(d) duplicate event_id → 200 with runSlackAgent NOT called", async () => {
    const kv = makeFakeKV()
    // Pre-seed the idempotency key.
    kv._store.set(`slack-event:${EVENT_ID}`, "1")
    const env = makeEnv("on", kv)
    const ctx = makeFakeCtx()
    const req = await makeSignedRequest(APP_MENTION_BODY, SIGNING_SECRET)

    const res = await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)

    expect(res.status).toBe(200)
    // No deferred work should be scheduled after a duplicate event.
    expect(ctx.waitUntil).not.toHaveBeenCalled()
    await ctx.flush()
    expect(runSlackAgent).not.toHaveBeenCalled()
    expect(postSlackMessage).not.toHaveBeenCalled()
  })

  // ── (e) on + valid scoped app_mention → 200 ack + agent + post ──────────────

  it("(e) on + valid scoped app_mention → 200 ack; waitUntil runs agent and posts", async () => {
    const kv = makeFakeKV()
    const env = makeEnv("on", kv)
    const ctx = makeFakeCtx()
    const req = await makeSignedRequest(APP_MENTION_BODY, SIGNING_SECRET)

    const res = await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)

    expect(res.status).toBe(200)
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1)

    // Flush the deferred work.
    await ctx.flush()

    expect(runSlackAgent).toHaveBeenCalledTimes(1)
    expect(postSlackMessage).toHaveBeenCalledTimes(1)
    expect(postSlackMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "Agent reply", botToken: BOT_TOKEN }))
    // Rate-limit action must be recorded in on mode.
    expect(recordSlackAction).toHaveBeenCalledTimes(1)
  })

  // ── (f) unscoped channel → no agent, posts 'not connected' ─────────────────

  it("(f) unscoped channel → runSlackAgent NOT called; 'not connected' message posted", async () => {
    scopeDenied()
    const kv = makeFakeKV()
    const env = makeEnv("on", kv)
    const ctx = makeFakeCtx()
    const req = await makeSignedRequest(APP_MENTION_BODY, SIGNING_SECRET)

    const res = await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)

    expect(res.status).toBe(200)

    await ctx.flush()

    expect(runSlackAgent).not.toHaveBeenCalled()
    // A bot-token look-up is attempted so the 'not connected' error can be posted.
    expect(postSlackMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("not connected"),
      }),
    )
  })

  // ── (f2) shadow + scope-denied → no post, structured log only ──────────────

  it("(f2) shadow + unscoped channel → runSlackAgent NOT called; postSlackMessage NOT called", async () => {
    scopeDenied()
    const kv = makeFakeKV()
    const env = makeEnv("shadow", kv)
    const ctx = makeFakeCtx()
    const req = await makeSignedRequest(APP_MENTION_BODY, SIGNING_SECRET)

    const res = await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)

    expect(res.status).toBe(200)

    await ctx.flush()

    expect(runSlackAgent).not.toHaveBeenCalled()
    // In shadow mode, scope-denied must NOT post to Slack — structured log only.
    expect(postSlackMessage).not.toHaveBeenCalled()
  })

  // ── (g) shadow → agent called, NO post, NO record ──────────────────────────

  it("(g) shadow → runSlackAgent called but postSlackMessage and recordSlackAction NOT called", async () => {
    const kv = makeFakeKV()
    const env = makeEnv("shadow", kv)
    const ctx = makeFakeCtx()
    const req = await makeSignedRequest(APP_MENTION_BODY, SIGNING_SECRET)

    const res = await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)

    expect(res.status).toBe(200)

    await ctx.flush()

    expect(runSlackAgent).toHaveBeenCalledTimes(1)
    expect(postSlackMessage).not.toHaveBeenCalled()
    expect(recordSlackAction).not.toHaveBeenCalled()
  })

  // ── url_verification works in on mode too (always highest priority) ─────────

  it("url_verification in on mode returns 200 + challenge without auth", async () => {
    const kv = makeFakeKV()
    const env = makeEnv("on", kv)
    const ctx = makeFakeCtx()
    const body = JSON.stringify({ type: "url_verification", challenge: "xyz987" })
    const req = new Request("https://worker.example.com/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })

    const res = await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)

    expect(res.status).toBe(200)
    const json = (await res.json()) as { challenge: string }
    expect(json.challenge).toBe("xyz987")
  })

  // ── New event_id is stored in KV before work is scheduled ───────────────────

  it("stores event_id in KV (idempotency claim) before scheduling deferred work", async () => {
    const kv = makeFakeKV()
    const env = makeEnv("on", kv)
    const ctx = makeFakeCtx()
    const req = await makeSignedRequest(APP_MENTION_BODY, SIGNING_SECRET)

    await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)

    // KV put must have been called synchronously (before the 200 ack).
    const stored = kv._store.get(`slack-event:${EVENT_ID}`)
    expect(stored).toBe("1")
  })
})
