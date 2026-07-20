// SIG-196: tests for handleSlackRequest — the /slack/events route.
//
// Coverage:
//   (a) mode=off → inert 200 but url_verification is echoed regardless
//   (b) bad sig → 401
//   (c) missing SLACK_SIGNING_SECRET → 503
//   (d) duplicate event_id (KV pre-seeded) → 200, no queue job
//   (e) on + valid app_mention + scoped channel → durable queue handoff;
//       real dispatch runs runSlackAgent + postSlackMessage
//   (f) unscoped channel → runSlackAgent NOT called; 'not connected' message posted
//   (g) shadow → runSlackAgent called, postSlackMessage NOT called, recordSlackAction NOT called

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"

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

// Imports under test AFTER mocks are declared.
import { handleSlackRequest } from "@/src/index-slack-webhook"
import { dispatchJob } from "@/src/index-dispatch"

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

const queueSend = vi.fn(async (_job: unknown) => undefined)

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
    OPENCLAW_JOBS: { send: queueSend } as unknown as Queue<JobMessage>,
    SIGILIX_SLACK_MODE: mode,
    SLACK_SIGNING_SECRET: secret,
  } as unknown as Env
}

function queuedJob(index = 0): JobMessage {
  const job = queueSend.mock.calls[index]?.[0]
  expect(job).toBeDefined()
  return job as JobMessage
}

async function dispatchQueuedJob(env: Env, index = 0): Promise<JobMessage> {
  const job = queuedJob(index)
  await dispatchJob(job, env)
  return job
}

// ─── Scoped scope mock ────────────────────────────────────────────────────────

function scopeOk() {
  vi.mocked(resolveSlackScope).mockResolvedValue({
    ok: true,
    scope: {
      teamId: TEAM_ID,
      channelId: CHANNEL_ID,
      installationId: 111,
      repos: [{ githubRepoId: 101, owner: "sigilix", repo: "sigilix" }],
      linearTeam: null,
    },
  })
}

function scopeDenied() {
  vi.mocked(resolveSlackScope).mockResolvedValue({ ok: false, reason: "no-config" })
}

// ─── Shared test setup ────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  queueSend.mockReset()
  queueSend.mockResolvedValue(undefined)

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

  it("(d) duplicate event_id → 200 without enqueueing or running the agent", async () => {
    const kv = makeFakeKV()
    // Pre-seed the idempotency key.
    kv._store.set(`slack-event:${TEAM_ID}:${EVENT_ID}`, "1")
    const env = makeEnv("on", kv)
    const ctx = makeFakeCtx()
    const req = await makeSignedRequest(APP_MENTION_BODY, SIGNING_SECRET)

    const res = await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)

    expect(res.status).toBe(200)
    // No work should be scheduled after a duplicate event.
    expect(ctx.waitUntil).not.toHaveBeenCalled()
    expect(queueSend).not.toHaveBeenCalled()
    expect(runSlackAgent).not.toHaveBeenCalled()
    expect(postSlackMessage).not.toHaveBeenCalled()
  })

  it("returns 503 for a pending event claim so Slack keeps retrying until queue handoff is known", async () => {
    const kv = makeFakeKV()
    kv._store.set(`slack-event:${TEAM_ID}:${EVENT_ID}`, "pending")
    const env = makeEnv("on", kv)
    const ctx = makeFakeCtx()
    const req = await makeSignedRequest(APP_MENTION_BODY, SIGNING_SECRET)

    const res = await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)

    expect(res.status).toBe(503)
    expect(queueSend).not.toHaveBeenCalled()
  })

  it("does not treat another Slack team's matching event_id as a duplicate", async () => {
    const kv = makeFakeKV()
    kv._store.set(`slack-event:T_OTHER:${EVENT_ID}`, "queued")
    const env = makeEnv("on", kv)
    const ctx = makeFakeCtx()
    const req = await makeSignedRequest(APP_MENTION_BODY, SIGNING_SECRET)

    const res = await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)

    expect(res.status).toBe(200)
    expect(queueSend).toHaveBeenCalledTimes(1)
    expect(kv._store.get(`slack-event:${TEAM_ID}:${EVENT_ID}`)).toBe("queued")
  })

  // ── (e) on + valid scoped app_mention → 200 ack + agent + post ──────────────

  it("(e0) signed app_mention enqueues a secrets-free job without waitUntil", async () => {
    const kv = makeFakeKV()
    const env = makeEnv("on", kv)
    const ctx = makeFakeCtx()
    const req = await makeSignedRequest(APP_MENTION_BODY, SIGNING_SECRET)

    const res = await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)

    expect(res.status).toBe(200)
    expect(ctx.waitUntil).not.toHaveBeenCalled()
    expect(queueSend).toHaveBeenCalledTimes(1)
    expect(queueSend).toHaveBeenCalledWith({
      type: "slack-mention",
      eventId: EVENT_ID,
      teamId: TEAM_ID,
      channelId: CHANNEL_ID,
      slackUserId: USER_ID,
      rawText: "<@U0BOTID> help me understand the codebase",
      threadTs: "1234567890.000001",
    })
    expect(JSON.stringify(queueSend.mock.calls[0]?.[0])).not.toContain(SIGNING_SECRET)
    expect(JSON.stringify(queueSend.mock.calls[0]?.[0])).not.toContain(BOT_TOKEN)
  })

  it("(e) on + valid scoped app_mention → real queue dispatch runs agent and posts", async () => {
    const kv = makeFakeKV()
    const env = makeEnv("on", kv)
    const ctx = makeFakeCtx()
    const req = await makeSignedRequest(APP_MENTION_BODY, SIGNING_SECRET)

    const res = await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)

    expect(res.status).toBe(200)
    expect(ctx.waitUntil).not.toHaveBeenCalled()
    expect(runSlackAgent).not.toHaveBeenCalled()

    // Exercise the real producer payload through the real queue dispatcher.
    await dispatchQueuedJob(env)

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
    await dispatchQueuedJob(env)

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
    await dispatchQueuedJob(env)

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
    await dispatchQueuedJob(env)

    expect(runSlackAgent).toHaveBeenCalledTimes(1)
    expect(postSlackMessage).not.toHaveBeenCalled()
    expect(recordSlackAction).not.toHaveBeenCalled()
  })

  // ── (h) entitlements enforce → un-entitled team gets an upsell, no agent run ──
  // sig-free-tier-entitlements: on + scoped, but the mapped installation's plan is
  // unresolvable (no platform DB → fail-closed → not entitled). The surface must
  // post a brief upsell and NOT run the agent.

  it("(h) entitlements enforce + un-entitled → upsell posted, runSlackAgent NOT called", async () => {
    const kv = makeFakeKV()
    const env = {
      ...(makeEnv("on", kv) as unknown as Record<string, unknown>),
      OPENCLAW_ENTITLEMENTS_MODE: "enforce",
    } as unknown as Env
    const ctx = makeFakeCtx()
    const req = await makeSignedRequest(APP_MENTION_BODY, SIGNING_SECRET)

    const res = await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)
    expect(res.status).toBe(200)
    await dispatchQueuedJob(env)

    expect(runSlackAgent).not.toHaveBeenCalled()
    expect(recordSlackAction).not.toHaveBeenCalled()
    expect(postSlackMessage).toHaveBeenCalledTimes(1)
    const posted = vi.mocked(postSlackMessage).mock.calls[0]?.[0] as { text: string }
    expect(posted.text).toContain("Pro feature")
    expect(posted.text).toContain("app.sigilix.ai")
  })

  // ── (i) entitlements off (default) → gate is a no-op, agent runs as before ────

  it("(i) entitlements off (default) → runSlackAgent still called (no-op gate)", async () => {
    const kv = makeFakeKV()
    const env = makeEnv("on", kv) // no OPENCLAW_ENTITLEMENTS_MODE → off
    const ctx = makeFakeCtx()
    const req = await makeSignedRequest(APP_MENTION_BODY, SIGNING_SECRET)

    await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)
    await dispatchQueuedJob(env)

    expect(runSlackAgent).toHaveBeenCalledTimes(1)
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

  it("returns 503 and releases the event claim when queue handoff fails", async () => {
    const kv = makeFakeKV()
    const env = makeEnv("on", kv)
    const ctx = makeFakeCtx()
    const req = await makeSignedRequest(APP_MENTION_BODY, SIGNING_SECRET)
    queueSend.mockRejectedValueOnce(new Error("queue unavailable"))

    const res = await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)

    expect(res.status).toBe(503)
    expect(kv.delete).toHaveBeenCalledWith(`slack-event:${TEAM_ID}:${EVENT_ID}`)
    expect(kv._store.has(`slack-event:${TEAM_ID}:${EVENT_ID}`)).toBe(false)
    expect(ctx.waitUntil).not.toHaveBeenCalled()
  })

  it("acks an invalid app_mention without enqueueing it", async () => {
    const kv = makeFakeKV()
    const env = makeEnv("on", kv)
    const ctx = makeFakeCtx()
    const invalidBody = JSON.stringify({
      type: "event_callback",
      team_id: TEAM_ID,
      event_id: EVENT_ID,
      event: { type: "app_mention", channel: CHANNEL_ID, text: "hello", ts: "123.456" },
    })
    const req = await makeSignedRequest(invalidBody, SIGNING_SECRET)

    const res = await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)

    expect(res.status).toBe(200)
    expect(queueSend).not.toHaveBeenCalled()
    expect(kv.put).not.toHaveBeenCalled()
  })

  it("uses event.ts as the thread root for a top-level app_mention", async () => {
    const kv = makeFakeKV()
    const env = makeEnv("on", kv)
    const ctx = makeFakeCtx()
    const req = await makeSignedRequest(APP_MENTION_BODY, SIGNING_SECRET)

    await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)

    expect(queuedJob()).toMatchObject({ threadTs: "1234567890.000001" })
  })

  it("uses event.ts when Slack sends a null thread_ts on a top-level mention", async () => {
    const kv = makeFakeKV()
    const env = makeEnv("on", kv)
    const ctx = makeFakeCtx()
    const body = JSON.stringify({
      type: "event_callback",
      team_id: TEAM_ID,
      event_id: EVENT_ID,
      event: {
        type: "app_mention",
        user: USER_ID,
        channel: CHANNEL_ID,
        text: "<@U0BOTID> help",
        thread_ts: null,
        ts: "1234567890.000001",
      },
    })
    const req = await makeSignedRequest(body, SIGNING_SECRET)

    await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)

    expect(queuedJob()).toMatchObject({ threadTs: "1234567890.000001" })
  })

  it("acks an app_mention with an invalid Slack timestamp without enqueueing it", async () => {
    const kv = makeFakeKV()
    const env = makeEnv("on", kv)
    const ctx = makeFakeCtx()
    const invalidBody = JSON.stringify({
      type: "event_callback",
      team_id: TEAM_ID,
      event_id: EVENT_ID,
      event: {
        type: "app_mention",
        user: USER_ID,
        channel: CHANNEL_ID,
        text: "hello",
        ts: "not-a-slack-timestamp",
      },
    })
    const req = await makeSignedRequest(invalidBody, SIGNING_SECRET)

    const res = await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)

    expect(res.status).toBe(200)
    expect(queueSend).not.toHaveBeenCalled()
  })

  it("does not run a queued mention after Slack mode changes to off", async () => {
    const kv = makeFakeKV()
    const env = makeEnv("on", kv)
    const ctx = makeFakeCtx()
    const req = await makeSignedRequest(APP_MENTION_BODY, SIGNING_SECRET)
    await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)
    env.SIGILIX_SLACK_MODE = "off"

    await dispatchJob(queuedJob(), env)

    expect(runSlackAgent).not.toHaveBeenCalled()
    expect(postSlackMessage).not.toHaveBeenCalled()
    expect(kv._store.get(`slack-event-posted:${TEAM_ID}:${EVENT_ID}`)).toBe("1")
  })

  it("dispatching the same completed job twice posts only once", async () => {
    const kv = makeFakeKV()
    const env = makeEnv("on", kv)
    const ctx = makeFakeCtx()
    const req = await makeSignedRequest(APP_MENTION_BODY, SIGNING_SECRET)
    await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)
    const job = queuedJob()

    await dispatchJob(job, env)
    await dispatchJob(job, env)

    expect(postSlackMessage).toHaveBeenCalledTimes(1)
    expect(runSlackAgent).toHaveBeenCalledTimes(1)
    expect(kv._store.get(`slack-event-posted:${TEAM_ID}:${EVENT_ID}`)).toBe("1")
  })

  it("does not suppress a reply completed by another Slack team with the same event_id", async () => {
    const kv = makeFakeKV()
    const env = makeEnv("on", kv)
    const ctx = makeFakeCtx()
    const req = await makeSignedRequest(APP_MENTION_BODY, SIGNING_SECRET)
    await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)
    kv._store.set(`slack-event-posted:T_OTHER:${EVENT_ID}`, "1")

    await dispatchJob(queuedJob(), env)

    expect(postSlackMessage).toHaveBeenCalledTimes(1)
    expect(kv._store.get(`slack-event-posted:${TEAM_ID}:${EVENT_ID}`)).toBe("1")
  })

  it("keeps a rejected Slack post retryable without a completion marker", async () => {
    const kv = makeFakeKV()
    const env = makeEnv("on", kv)
    const ctx = makeFakeCtx()
    const req = await makeSignedRequest(APP_MENTION_BODY, SIGNING_SECRET)
    await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)
    vi.mocked(postSlackMessage).mockResolvedValueOnce({ ok: false })

    await expect(dispatchJob(queuedJob(), env)).rejects.toThrow("Slack reply was not accepted")

    expect(kv._store.has(`slack-event-posted:${TEAM_ID}:${EVENT_ID}`)).toBe(false)
  })

  it("does not retry a confirmed post when the completion marker write fails", async () => {
    const kv = makeFakeKV()
    const env = makeEnv("on", kv)
    const ctx = makeFakeCtx()
    const req = await makeSignedRequest(APP_MENTION_BODY, SIGNING_SECRET)
    await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)
    kv.put.mockImplementation(async (key: string, value: string) => {
      if (key.startsWith("slack-event-posted:")) throw new Error("KV unavailable")
      kv._store.set(key, value)
    })

    await expect(dispatchJob(queuedJob(), env)).resolves.toBeUndefined()

    expect(postSlackMessage).toHaveBeenCalledTimes(1)
    expect(kv._store.has(`slack-event-posted:${TEAM_ID}:${EVENT_ID}`)).toBe(false)
  })

  // ── New event_id is stored in KV before work is enqueued ────────────────────

  it("transitions a short pending claim to a 24-hour queued claim around the durable handoff", async () => {
    const kv = makeFakeKV()
    const env = makeEnv("on", kv)
    const ctx = makeFakeCtx()
    const req = await makeSignedRequest(APP_MENTION_BODY, SIGNING_SECRET)

    await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)

    // KV put must have been called synchronously (before the 200 ack).
    const stored = kv._store.get(`slack-event:${TEAM_ID}:${EVENT_ID}`)
    expect(stored).toBe("queued")
    expect(kv.put).toHaveBeenNthCalledWith(1, `slack-event:${TEAM_ID}:${EVENT_ID}`, "pending", {
      expirationTtl: 240,
    })
    expect(kv.put).toHaveBeenNthCalledWith(2, `slack-event:${TEAM_ID}:${EVENT_ID}`, "queued", {
      expirationTtl: 86_400,
    })
  })

  it("retries the queued claim transition after a transient KV failure", async () => {
    const kv = makeFakeKV()
    let queuedAttempts = 0
    kv.put.mockImplementation(async (key: string, value: string) => {
      if (value === "queued" && queuedAttempts++ < 2) throw new Error("KV unavailable")
      kv._store.set(key, value)
    })
    const env = makeEnv("on", kv)
    const ctx = makeFakeCtx()
    const req = await makeSignedRequest(APP_MENTION_BODY, SIGNING_SECRET)

    const res = await handleSlackRequest(req, env, ctx as unknown as ExecutionContext)

    expect(res.status).toBe(200)
    expect(queueSend).toHaveBeenCalledTimes(1)
    expect(queuedAttempts).toBe(3)
    expect(kv._store.get(`slack-event:${TEAM_ID}:${EVENT_ID}`)).toBe("queued")
  })
})
