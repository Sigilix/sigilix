import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { handleSlackRequest } from "@/src/index-slack-webhook"
import { dispatchJob } from "@/src/index-dispatch"
import { resolveSlackScope } from "@/src/lib/slack/slack-scope"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"

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

vi.mock("@/src/features/entitlements", () => ({
  resolveEntitlement: vi.fn(),
  upsellFor: vi.fn(),
}))

import { runSlackAgent } from "@/src/lib/slack/slack-agent"
import { getSlackBotToken } from "@/src/lib/slack/slack-install"
import { capAndRedactThread, fetchSlackThread, postSlackMessage } from "@/src/lib/slack/slack-api"
import { checkSlackRateLimit, recordSlackAction } from "@/src/lib/slack/slack-rate-limit"
import { resolveEntitlement, upsellFor } from "@/src/features/entitlements"

const BASE_SQL = readFileSync(new URL("../migrations/0001_create_tenant_repo_usage.sql", import.meta.url), "utf8")
const SLACK_SQL = readFileSync(new URL("../migrations/0019_create_slack_channel_repo.sql", import.meta.url), "utf8")

const SIGNING_SECRET = "slack-scope-isolation-secret"
const TEAM_ID = "T0TENANT42"
const SAME_TENANT_CHANNEL = "C0SAME12345"
const FOREIGN_REPO_CHANNEL = "C0CROSS1234"
const NOW = "2026-07-13T00:00:00.000Z"
const INSTALLATION_ID = 42
const OTHER_INSTALLATION_ID = 77
const TOKEN = "ghs_exact_installation_42"

interface FakeKv extends KVNamespace {
  values: Map<string, string>
}

function makeKv(): FakeKv {
  const values = new Map<string, string>()
  return {
    values,
    get: vi.fn(async (key: string, type?: string) => {
      const raw = values.get(key)
      if (raw === undefined) return null
      return type === "json" ? JSON.parse(raw) : raw
    }),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value)
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key)
    }),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: undefined })),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
  } as unknown as FakeKv
}

function makeExecutionContext(): ExecutionContext & { flush(): Promise<void> } {
  const pending: Promise<unknown>[] = []
  return {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise)
    },
    passThroughOnException() {},
    async flush() {
      await Promise.all(pending)
    },
  } as ExecutionContext & { flush(): Promise<void> }
}

async function signSlackBody(timestamp: string, body: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${body}`))
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
  return `v0=${hex}`
}

async function signedMention(channelId: string, eventId: string): Promise<Request> {
  const body = JSON.stringify({
    type: "event_callback",
    team_id: TEAM_ID,
    event_id: eventId,
    event: {
      type: "app_mention",
      user: "U0MEMBER42",
      channel: channelId,
      text: "<@U0SIGILIX> explain this repository",
      ts: "1783900000.000100",
    },
  })
  const timestamp = String(Math.floor(Date.now() / 1_000))
  return new Request("https://api.sigilix.ai/slack/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": await signSlackBody(timestamp, body),
    },
    body,
  })
}

async function makePlatformDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(BASE_SQL)
  await db.exec(SLACK_SQL)
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
        " VALUES (?, ?, 'Organization', ?, ?), (?, ?, 'Organization', ?, ?)",
    )
    .bind(INSTALLATION_ID, "acme", NOW, NOW, OTHER_INSTALLATION_ID, "globex", NOW, NOW)
    .run()
  await db
    .prepare(
      "INSERT INTO repo (repo_id, installation_id, full_name, updated_at)" +
        " VALUES (101, ?, 'acme/api', ?), (202, ?, 'globex/secrets', ?)",
    )
    .bind(INSTALLATION_ID, NOW, OTHER_INSTALLATION_ID, NOW)
    .run()
  await db
    .prepare(
      "INSERT INTO slack_workspace (team_id, installation_id, installed_by, installed_at, updated_at)" +
        " VALUES (?, ?, 'acme-admin', ?, ?)",
    )
    .bind(TEAM_ID, INSTALLATION_ID, NOW, NOW)
    .run()
  await db
    .prepare(
      "INSERT INTO slack_channel_binding" +
        " (team_id, channel_id, installation_id, use_all_repos, created_at, updated_at)" +
        " VALUES (?, ?, ?, 0, ?, ?), (?, ?, ?, 0, ?, ?)",
    )
    .bind(
      TEAM_ID,
      SAME_TENANT_CHANNEL,
      INSTALLATION_ID,
      NOW,
      NOW,
      TEAM_ID,
      FOREIGN_REPO_CHANNEL,
      INSTALLATION_ID,
      NOW,
      NOW,
    )
    .run()
  await db
    .prepare(
      "INSERT INTO slack_channel_repo" +
        " (team_id, channel_id, installation_id, github_repo_id, github_repo_full_name, created_at, updated_at)" +
        " VALUES (?, ?, ?, 101, 'acme/api', ?, ?)," +
        " (?, ?, ?, 202, 'globex/secrets', ?, ?)",
    )
    .bind(
      TEAM_ID,
      SAME_TENANT_CHANNEL,
      INSTALLATION_ID,
      NOW,
      NOW,
      TEAM_ID,
      FOREIGN_REPO_CHANNEL,
      INSTALLATION_ID,
      NOW,
      NOW,
    )
    .run()
  return db
}

async function setup(): Promise<{ env: Env; fetchMock: ReturnType<typeof vi.fn>; queuedJobs: JobMessage[] }> {
  const db = await makePlatformDb()
  const kv = makeKv()
  kv.values.set(
    `gh-installation-token:${INSTALLATION_ID}`,
    JSON.stringify({ token: TOKEN, expiresAt: Date.now() + 60 * 60 * 1_000 }),
  )

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString())
    if (url.pathname !== "/installation/repositories") return new Response("not found", { status: 404 })
    expect(new Headers(init?.headers).get("authorization")).toBe(`token ${TOKEN}`)
    return new Response(
      JSON.stringify({
        total_count: 1,
        repositories: [{ id: 101, full_name: "acme/api" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  })
  vi.stubGlobal("fetch", fetchMock)
  const queuedJobs: JobMessage[] = []

  const env = {
    OPENCLAW_STATE: kv,
    OPENCLAW_JOBS: {
      send: vi.fn(async (job: JobMessage) => {
        queuedJobs.push(job)
      }),
    } as unknown as Queue<JobMessage>,
    SIGILIX_PLATFORM_DB: db,
    SIGILIX_SLACK_MODE: "on",
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    GITHUB_APP_ID: "12345",
    // The exact installation token is cached above, so no signing should occur.
    GITHUB_PRIVATE_KEY: "unused-cached-private-key",
    // This deliberately-valid legacy fallback must not rescue the foreign D1 row.
    SIGILIX_SLACK_SCOPE_MAP: JSON.stringify({
      [`${TEAM_ID}:${FOREIGN_REPO_CHANNEL}`]: { repos: ["globex/secrets"] },
    }),
    OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({
      "acme/api": String(INSTALLATION_ID),
      "globex/secrets": String(OTHER_INSTALLATION_ID),
    }),
  } as unknown as Env
  return { env, fetchMock, queuedJobs }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSlackBotToken).mockResolvedValue("xoxb-scope-test")
  vi.mocked(fetchSlackThread).mockResolvedValue(["thread context"])
  vi.mocked(capAndRedactThread).mockReturnValue("thread context")
  vi.mocked(postSlackMessage).mockResolvedValue({ ok: true })
  vi.mocked(checkSlackRateLimit).mockResolvedValue({ allowed: true, used: 0, cap: 3 })
  vi.mocked(recordSlackAction).mockResolvedValue(undefined)
  vi.mocked(resolveEntitlement).mockResolvedValue({ blocked: false, plan: "pro" } as never)
  vi.mocked(upsellFor).mockReturnValue(null)
  vi.mocked(runSlackAgent).mockResolvedValue({ reply: "grounded answer", action: { kind: "qa" } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("signed Slack webhook repository-scope isolation", () => {
  it("allows a same-installation repository through the real D1 scope path", async () => {
    const { env, queuedJobs } = await setup()
    const scope = await resolveSlackScope(env, { teamId: TEAM_ID, channelId: SAME_TENANT_CHANNEL })
    expect(scope.ok).toBe(true)

    const ctx = makeExecutionContext()
    const response = await handleSlackRequest(await signedMention(SAME_TENANT_CHANNEL, "EvSameTenant"), env, ctx)
    expect(response.status).toBe(200)
    expect(queuedJobs).toHaveLength(1)
    await dispatchJob(queuedJobs[0]!, env)

    expect(fetchSlackThread).toHaveBeenCalledOnce()
    expect(runSlackAgent).toHaveBeenCalledOnce()
  })

  it("denies a foreign immutable repo id before thread fetch or agent/model work", async () => {
    const { env, queuedJobs } = await setup()
    const ctx = makeExecutionContext()
    const response = await handleSlackRequest(await signedMention(FOREIGN_REPO_CHANNEL, "EvForeignTenant"), env, ctx)

    // Slack still receives its retry-safe acknowledgement; denial is queued.
    expect(response.status).toBe(200)
    expect(queuedJobs).toHaveLength(1)
    await dispatchJob(queuedJobs[0]!, env)

    expect(fetchSlackThread).not.toHaveBeenCalled()
    expect(runSlackAgent).not.toHaveBeenCalled()
    expect(postSlackMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("not connected") }),
    )
  })
})
