// SIG-303 — deep-research chatbot SEAT-pool metering write-path tests.
// Exercises the real handleResearchCreate path with a stub DEEP_RESEARCH DO and a
// real D1 shim, asserting the chatbot seat event is recorded + the seat gate fires.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { handleResearchCreate, seatIdentityFromCreator } from "@/src/do/deep-research/routes"
import { readUsageEventCount } from "@/src/features/tenancy"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(9))
const M3 = readFileSync(
  new URL("../../../migrations/0003_create_account_tenant_and_api_key.sql", import.meta.url),
  "utf8",
)
const M4 = readFileSync(new URL("../../../migrations/0004_create_usage_events.sql", import.meta.url), "utf8")

function makeKV(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: async (k: string, t?: "json") => {
      const v = store.get(k)
      return v === undefined ? null : t === "json" ? JSON.parse(v) : v
    },
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  } as unknown as KVNamespace
}

/** Minimal DEEP_RESEARCH DO stub: newUniqueId() + get().fetch(/start) → 200. */
function makeDeepResearchNs(startOk = true): Env["DEEP_RESEARCH"] {
  return {
    newUniqueId: () => ({ toString: () => "do-id-1" }),
    idFromString: (s: string) => ({ toString: () => s }),
    get: () => ({
      fetch: async () => new Response(startOk ? "{}" : "err", { status: startOk ? 200 : 500 }),
    }),
  } as unknown as Env["DEEP_RESEARCH"]
}

const ctx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException() {} } as unknown as ExecutionContext

function researchReq(cookie: string | null, body: unknown): Request {
  const headers = new Headers({ "content-type": "application/json" })
  if (cookie) headers.set("cookie", `${SESSION_COOKIE}=${cookie}`)
  return new Request("https://x/v1/research", { method: "POST", headers, body: JSON.stringify(body) })
}

describe("seatIdentityFromCreator", () => {
  it("maps a portal session to a gh: seat with no org context", () => {
    expect(seatIdentityFromCreator("session:42")).toEqual({ userKey: "gh:42", installationId: 0 })
  })
  it("maps an api tenant to an inst: seat carrying the installation as context", () => {
    expect(seatIdentityFromCreator("tenant:9")).toEqual({ userKey: "inst:9", installationId: 9 })
  })
  it("legacy tenant (-1) → no org context", () => {
    expect(seatIdentityFromCreator("tenant:-1")).toEqual({ userKey: "inst:-1", installationId: 0 })
  })
})

describe("handleResearchCreate — chatbot SEAT metering", () => {
  let db: D1Database
  let kv: KVNamespace
  beforeEach(async () => {
    db = makeD1()
    await db.exec(M4)
    kv = makeKV()
    await createSession({
      kv,
      sessionId: "s1",
      login: "dev",
      githubUserId: 42,
      accessToken: "t",
      encryptionKeyB64url: ENC_KEY,
    })
  })

  it("records one chatbot seat event (keyed to gh:<userId>) after a run starts", async () => {
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
      DEEP_RESEARCH: makeDeepResearchNs(true),
    } as unknown as Env

    const res = await handleResearchCreate(researchReq("s1", { question: "why?" }), env, ctx)
    expect(res.status).toBe(200)
    // waitUntil append runs inline in this stub → the row is present.
    const seat = await readUsageEventCount(
      { SIGILIX_PLATFORM_DB: db },
      {
        meter: "chatbot",
        userKey: "gh:42",
        sinceIso: "2000-01-01T00:00:00.000Z",
      },
    )
    expect(seat).toEqual({ ok: true, count: 1 })
  })

  it("stamps the org installation on the chatbot event when the session user is account_tenant-linked", async () => {
    // account_tenant links github user 42 → installation 7, so the SEAT chatbot
    // event carries that org (context only) for the admin per-member drill.
    await db.exec(M3)
    await db
      .prepare(
        "INSERT INTO account_tenant (github_user_id, installation_id, role, created_at)" +
          " VALUES ('42', 7, 'member', '2026-01-01T00:00:00.000Z')",
      )
      .run()
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
      DEEP_RESEARCH: makeDeepResearchNs(true),
    } as unknown as Env

    const res = await handleResearchCreate(researchReq("s1", { question: "why?" }), env, ctx)
    expect(res.status).toBe(200)
    // Event is keyed to the developer AND stamped with their org (installation 7).
    const seat = await readUsageEventCount(
      { SIGILIX_PLATFORM_DB: db },
      { meter: "chatbot", userKey: "gh:42", installationId: 7, sinceIso: "2000-01-01T00:00:00.000Z" },
    )
    expect(seat).toEqual({ ok: true, count: 1 })
  })

  it("enforce + over the seat cap → 429, no run started, no event recorded", async () => {
    // Pre-fill the seat pool to the cap.
    await db
      .prepare(
        "INSERT INTO usage_events (meter, installation_id, user_key, surface, event_id, created_at) VALUES ('chatbot', 0, 'gh:42', 'portal', 'prev', ?)",
      )
      .bind(new Date().toISOString())
      .run()
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
      DEEP_RESEARCH: makeDeepResearchNs(true),
      SIGILIX_USAGE_METER_MODE: "enforce",
      SIGILIX_USAGE_CAP_SEAT_SESSION: "1",
      SIGILIX_USAGE_CAP_SEAT_WEEKLY: "-1",
    } as unknown as Env

    const res = await handleResearchCreate(researchReq("s1", { question: "why?" }), env, ctx)
    expect(res.status).toBe(429)
    const seat = await readUsageEventCount(
      { SIGILIX_PLATFORM_DB: db },
      {
        meter: "chatbot",
        userKey: "gh:42",
        sinceIso: "2000-01-01T00:00:00.000Z",
      },
    )
    expect(seat).toEqual({ ok: true, count: 1 }) // only the pre-filled row
  })
})
