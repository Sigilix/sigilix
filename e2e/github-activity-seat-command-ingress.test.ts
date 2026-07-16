import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"

const mockLoadSigilixConfig = vi.fn()
const mockGetInstallationToken = vi.fn(async (_args?: unknown) => "fake-token")

vi.mock("@/src/lib/pr-overview-stub", () => ({
  postPrOverviewStubIfNeeded: vi.fn(async () => ({ kind: "skipped" as const, reason: "disabled" as const })),
}))

vi.mock("@/src/shared/adapters/github/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("@/src/shared/adapters/github", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/github")>("@/src/shared/adapters/github")
  return { ...actual, GitHubClient: vi.fn().mockImplementation(() => ({})) }
})

vi.mock("@/src/lib/sigilix-config", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/sigilix-config")>("@/src/lib/sigilix-config")
  return {
    ...actual,
    loadSigilixConfig: (...args: unknown[]) => mockLoadSigilixConfig(...args),
  }
})

const SECRET = "activity-seat-ingress-secret"

function migration(name: string): string {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8")
}

async function makeDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(migration("0001_create_tenant_repo_usage.sql"))
  await db.exec(migration("0034_create_org_activity_seat_command.sql"))
  return db
}

function makePayload(authorAssociation = "MEMBER") {
  return {
    action: "opened",
    installation: { id: 12345, account: { login: "acme", type: "Organization" } },
    repository: { id: 67890, name: "site", owner: { login: "acme" }, full_name: "acme/site" },
    pull_request: {
      number: 73,
      draft: false,
      author_association: authorAssociation,
      user: { id: 111, login: "author" },
      head: { sha: "a".repeat(40), ref: "feature/x", repo: { full_name: "acme/site" } },
      base: { sha: "b".repeat(40), ref: "main" },
    },
    sender: { id: 222, login: "sender" },
  }
}

async function signBody(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `sha256=${hex}`
}

async function hashBody(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function makeEnv(
  db: D1Database,
  pausedOrIgnoredKey?: string,
): {
  env: Record<string, unknown>
  doCalls: Array<{ url: string; body: unknown }>
} {
  const doCalls: Array<{ url: string; body: unknown }> = []
  const env = {
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
    GITHUB_WEBHOOK_SECRET: SECRET,
    SIGILIX_PLATFORM_DB: db,
    OPENCLAW_REVIEW_MANIFEST_ENABLED: "off",
    OPENCLAW_STATE: {
      get: async (key: string) => (key === pausedOrIgnoredKey ? "1700000000000" : null),
      put: async () => {},
      delete: async () => {},
    },
    OPENCLAW_JOBS: { send: async () => {} },
    PR_REVIEW_RUN: {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: async (input: string | Request, init?: RequestInit) => {
          doCalls.push({
            url: typeof input === "string" ? input : input.url,
            body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
          })
          return new Response(JSON.stringify({ deduped: false, runId: "run-1", action: "create" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        },
      }),
    },
  }
  return { env, doCalls }
}

async function post(
  worker: { fetch: (request: Request, env: never, ctx: never) => Promise<Response> },
  env: Record<string, unknown>,
  payload: unknown,
  options: { deliveryId?: string; signature?: string } = {},
): Promise<Response> {
  const body = JSON.stringify(payload)
  const request = new Request("https://example.com/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": options.deliveryId ?? "delivery-activity-1",
      "x-hub-signature-256": options.signature ?? (await signBody(body)),
    },
    body,
  })
  const waits: Promise<unknown>[] = []
  const response = await worker.fetch(
    request,
    env as never,
    {
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
      passThroughOnException: () => {},
    } as never,
  )
  await Promise.all(waits)
  return response
}

describe("signed GitHub activity-seat command ingress", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockLoadSigilixConfig.mockReset().mockResolvedValue({ overview: { enabled: false } })
    mockGetInstallationToken.mockClear()
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
  })

  it("persists exact immutable MEMBER evidence through the real signed worker path before DO dispatch", async () => {
    const db = await makeDb()
    const { env, doCalls } = makeEnv(db)
    const worker = (await import("@/src/index")).default
    const payload = makePayload()
    const expectedPayloadSha256 = await hashBody(JSON.stringify(payload))

    const response = await post(worker, env, payload)

    expect(response.status).toBe(202)
    expect(doCalls).toHaveLength(1)
    await expect(
      db
        .prepare(
          `SELECT delivery_id, installation_id, repository_id, pr_number, head_sha, action,
                  target_github_user_id, target_login, actor_github_user_id, actor_login,
                  author_association, received_at_ms, payload_sha256
             FROM org_activity_seat_command`,
        )
        .first(),
    ).resolves.toEqual({
      delivery_id: "delivery-activity-1",
      installation_id: 12345,
      repository_id: 67890,
      pr_number: 73,
      head_sha: "a".repeat(40),
      action: "opened",
      target_github_user_id: "111",
      target_login: "author",
      actor_github_user_id: "222",
      actor_login: "sender",
      author_association: "MEMBER",
      received_at_ms: expect.any(Number),
      payload_sha256: expectedPayloadSha256,
    })
  })

  it("deduplicates the verified body across a different delivery header while still retrying the DO", async () => {
    const db = await makeDb()
    const { env, doCalls } = makeEnv(db)
    const worker = (await import("@/src/index")).default
    const payload = makePayload()

    expect((await post(worker, env, payload, { deliveryId: "delivery-original" })).status).toBe(202)
    expect((await post(worker, env, payload, { deliveryId: "delivery-redelivery" })).status).toBe(202)

    expect(doCalls).toHaveLength(2)
    await expect(
      db.prepare("SELECT COUNT(*) AS count, delivery_id FROM org_activity_seat_command").first(),
    ).resolves.toEqual({ count: 1, delivery_id: "delivery-original" })
  })

  it("stores a distinct digest for a different signed body", async () => {
    const db = await makeDb()
    const { env, doCalls } = makeEnv(db)
    const worker = (await import("@/src/index")).default
    const opened = makePayload()
    const synchronize = {
      ...makePayload(),
      action: "synchronize",
      pull_request: {
        ...makePayload().pull_request,
        head: {
          ...makePayload().pull_request.head,
          sha: "c".repeat(40),
        },
      },
    }

    expect((await post(worker, env, opened, { deliveryId: "delivery-opened" })).status).toBe(202)
    expect((await post(worker, env, synchronize, { deliveryId: "delivery-sync" })).status).toBe(202)

    expect(doCalls).toHaveLength(2)
    await expect(
      db.prepare("SELECT delivery_id, payload_sha256 FROM org_activity_seat_command ORDER BY delivery_id").all(),
    ).resolves.toMatchObject({
      results: [
        { delivery_id: "delivery-opened", payload_sha256: await hashBody(JSON.stringify(opened)) },
        { delivery_id: "delivery-sync", payload_sha256: await hashBody(JSON.stringify(synchronize)) },
      ],
    })
  })

  it("never persists tampered, untrusted, malformed, or paused activity", async () => {
    const worker = (await import("@/src/index")).default

    const tamperedDb = await makeDb()
    const tampered = makeEnv(tamperedDb)
    expect((await post(worker, tampered.env, makePayload(), { signature: "sha256=deadbeef" })).status).toBe(401)
    expect(tampered.doCalls).toHaveLength(0)
    await expect(
      tamperedDb.prepare("SELECT COUNT(*) AS count FROM org_activity_seat_command").first(),
    ).resolves.toEqual({
      count: 0,
    })

    const collaboratorDb = await makeDb()
    const collaborator = makeEnv(collaboratorDb)
    expect((await post(worker, collaborator.env, makePayload("COLLABORATOR"))).status).toBe(202)
    expect(collaborator.doCalls).toHaveLength(1)
    await expect(
      collaboratorDb.prepare("SELECT COUNT(*) AS count FROM org_activity_seat_command").first(),
    ).resolves.toEqual({ count: 0 })

    for (const malformedPayload of [
      { ...makePayload(), repository: { ...makePayload().repository, id: 0 } },
      {
        ...makePayload(),
        pull_request: { ...makePayload().pull_request, user: { id: 0, login: "author" } },
      },
      { ...makePayload(), sender: { login: "sender" } },
    ]) {
      const malformedDb = await makeDb()
      const malformed = makeEnv(malformedDb)
      expect((await post(worker, malformed.env, malformedPayload)).status).toBe(202)
      expect(malformed.doCalls).toHaveLength(1)
      await expect(
        malformedDb.prepare("SELECT COUNT(*) AS count FROM org_activity_seat_command").first(),
      ).resolves.toEqual({ count: 0 })
    }

    const pausedDb = await makeDb()
    const paused = makeEnv(pausedDb, "pr-paused:acme/site#73")
    expect((await post(worker, paused.env, makePayload())).status).toBe(202)
    expect(paused.doCalls).toHaveLength(0)
    await expect(pausedDb.prepare("SELECT COUNT(*) AS count FROM org_activity_seat_command").first()).resolves.toEqual({
      count: 0,
    })
  })

  it("returns 503 without calling the DO when the immutable D1 write fails", async () => {
    const db = await makeDb()
    const failingDb = {
      prepare: db.prepare.bind(db),
      batch: db.batch.bind(db),
      exec: db.exec.bind(db),
      withSession: () => {
        throw new Error("activity command unavailable")
      },
    } as unknown as D1Database
    const { env, doCalls } = makeEnv(failingDb)
    const worker = (await import("@/src/index")).default

    const response = await post(worker, env, makePayload())

    expect(response.status).toBe(503)
    expect(doCalls).toHaveLength(0)
    await expect(db.prepare("SELECT COUNT(*) AS count FROM org_activity_seat_command").first()).resolves.toEqual({
      count: 0,
    })
  })

  it("captures receipt time before later webhook-path latency", async () => {
    const db = await makeDb()
    const { env } = makeEnv(db)
    const worker = (await import("@/src/index")).default
    let now = 1_000
    vi.spyOn(Date, "now").mockImplementation(() => now)
    mockLoadSigilixConfig.mockImplementationOnce(async () => {
      now = 9_000
      return { overview: { enabled: false } }
    })

    expect((await post(worker, env, makePayload())).status).toBe(202)

    await expect(db.prepare("SELECT received_at_ms FROM org_activity_seat_command").first()).resolves.toEqual({
      received_at_ms: 1_000,
    })
  })
})
