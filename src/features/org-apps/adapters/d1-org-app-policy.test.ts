// org_app_policy adapter, through the real migration and a SQLite shim.
// The two behaviours that must never regress: a failed READ leaves apps ON, and a
// failed WRITE is reported rather than silently swallowed.

import { describe, it, expect, beforeEach } from "vitest"
import type { D1Database } from "@cloudflare/workers-types"
import { readFileSync } from "node:fs"

import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { readOrgAppPolicy, writeOrgAppPolicy } from "@/src/features/org-apps/adapters/d1-org-app-policy"
import { ORG_APP_IDS } from "@/src/features/org-apps/domain/types"

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0038_create_org_app_policy.sql", import.meta.url),
  "utf8",
)

const ORG = 4242

function brokenDb(): D1Database {
  return {
    prepare() {
      throw new Error("simulated D1 error")
    },
  } as unknown as D1Database
}

describe("readOrgAppPolicy", () => {
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("an org with no rows gets every app ON", async () => {
    const policy = await readOrgAppPolicy({ SIGILIX_PLATFORM_DB: db }, ORG)
    expect(policy.pr_review.enabled).toBe(true)
    expect(policy.slack.enabled).toBe(true)
    expect(policy.slack.version).toBeNull()
  })

  it("reads back an explicit off, leaving the other apps on", async () => {
    await writeOrgAppPolicy(
      { SIGILIX_PLATFORM_DB: db },
      { installationId: ORG, appId: "slack", enabled: false, expectedVersion: null, updatedBy: "gh:1", nowMs: 5 },
    )
    const policy = await readOrgAppPolicy({ SIGILIX_PLATFORM_DB: db }, ORG)
    expect(policy.slack).toMatchObject({ enabled: false, version: 1, updatedBy: "gh:1" })
    expect(policy.pr_review.enabled).toBe(true)
  })

  it("is scoped to the org — another tenant's choice never leaks", async () => {
    await writeOrgAppPolicy(
      { SIGILIX_PLATFORM_DB: db },
      { installationId: 999, appId: "slack", enabled: false, expectedVersion: null, updatedBy: "gh:2", nowMs: 5 },
    )
    expect((await readOrgAppPolicy({ SIGILIX_PLATFORM_DB: db }, ORG)).slack.enabled).toBe(true)
  })

  it("FAILS OPEN on a D1 error — a blip must not silently disable a customer's apps", async () => {
    const policy = await readOrgAppPolicy({ SIGILIX_PLATFORM_DB: brokenDb() }, ORG)
    expect(policy.pr_review.enabled).toBe(true)
    expect(policy.slack.enabled).toBe(true)
  })

  it("absent binding → all-on defaults, no throw", async () => {
    expect((await readOrgAppPolicy({}, ORG)).cli.enabled).toBe(true)
  })

  it("a non-positive installation id yields defaults rather than querying", async () => {
    expect((await readOrgAppPolicy({ SIGILIX_PLATFORM_DB: db }, 0)).cli.enabled).toBe(true)
  })
})

describe("writeOrgAppPolicy", () => {
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  const env = () => ({ SIGILIX_PLATFORM_DB: db })

  it("first write creates version 1", async () => {
    const res = await writeOrgAppPolicy(env(), {
      installationId: ORG,
      appId: "cli",
      enabled: false,
      expectedVersion: null,
      updatedBy: "gh:1",
      nowMs: 1,
    })
    expect(res).toEqual({ ok: true, version: 1 })
  })

  it("a second write at the version it read increments", async () => {
    await writeOrgAppPolicy(env(), {
      installationId: ORG,
      appId: "cli",
      enabled: false,
      expectedVersion: null,
      updatedBy: "gh:1",
      nowMs: 1,
    })
    const res = await writeOrgAppPolicy(env(), {
      installationId: ORG,
      appId: "cli",
      enabled: true,
      expectedVersion: 1,
      updatedBy: "gh:1",
      nowMs: 2,
    })
    expect(res).toEqual({ ok: true, version: 2 })
    expect((await readOrgAppPolicy(env(), ORG)).cli.enabled).toBe(true)
  })

  it("a stale version CONFLICTS instead of clobbering a concurrent admin", async () => {
    await writeOrgAppPolicy(env(), {
      installationId: ORG,
      appId: "cli",
      enabled: false,
      expectedVersion: null,
      updatedBy: "a",
      nowMs: 1,
    })
    await writeOrgAppPolicy(env(), {
      installationId: ORG,
      appId: "cli",
      enabled: true,
      expectedVersion: 1,
      updatedBy: "b",
      nowMs: 2,
    })
    // Admin C read version 1 before B's write landed.
    const stale = await writeOrgAppPolicy(env(), {
      installationId: ORG,
      appId: "cli",
      enabled: false,
      expectedVersion: 1,
      updatedBy: "c",
      nowMs: 3,
    })
    expect(stale).toEqual({ ok: false, reason: "conflict" })
    expect((await readOrgAppPolicy(env(), ORG)).cli.enabled).toBe(true) // B's write stands
  })

  it("a create racing an existing row CONFLICTS rather than silently doing nothing", async () => {
    await writeOrgAppPolicy(env(), {
      installationId: ORG,
      appId: "chat",
      enabled: false,
      expectedVersion: null,
      updatedBy: "a",
      nowMs: 1,
    })
    const raced = await writeOrgAppPolicy(env(), {
      installationId: ORG,
      appId: "chat",
      enabled: true,
      expectedVersion: null,
      updatedBy: "b",
      nowMs: 2,
    })
    expect(raced).toEqual({ ok: false, reason: "conflict" })
  })

  it("REPORTS failure — a write error must never read as success to an admin", async () => {
    const res = await writeOrgAppPolicy(
      { SIGILIX_PLATFORM_DB: brokenDb() },
      { installationId: ORG, appId: "cli", enabled: false, expectedVersion: null, updatedBy: "x", nowMs: 1 },
    )
    expect(res).toEqual({ ok: false, reason: "error" })
  })

  it("absent binding reports unavailable, not success", async () => {
    const res = await writeOrgAppPolicy(
      {},
      { installationId: ORG, appId: "cli", enabled: false, expectedVersion: null, updatedBy: "x", nowMs: 1 },
    )
    expect(res).toEqual({ ok: false, reason: "unavailable" })
  })

  it("expectedVersion 0 is REJECTED, not a permanent silent conflict", async () => {
    // The sibling skill-policy store uses 0 as its create sentinel, so passing 0 here
    // is a live mistake. Untrapped it takes the UPDATE branch with `version = 0`,
    // which CHECK (version > 0) can never match — an admin would get "conflict"
    // forever with no way to recover by reloading.
    const res = await writeOrgAppPolicy(env(), {
      installationId: ORG,
      appId: "cli",
      enabled: false,
      expectedVersion: 0,
      updatedBy: "x",
      nowMs: 1,
    })
    expect(res).toEqual({ ok: false, reason: "error" })
  })

  it("a negative/non-integer expectedVersion is rejected too", async () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(
        await writeOrgAppPolicy(env(), {
          installationId: ORG,
          appId: "cli",
          enabled: false,
          expectedVersion: bad,
          updatedBy: "x",
          nowMs: 1,
        }),
      ).toEqual({ ok: false, reason: "error" })
    }
  })

  it("round-trips updatedAtMs and bounds an oversized actor string", async () => {
    await writeOrgAppPolicy(env(), {
      installationId: ORG,
      appId: "chat",
      enabled: false,
      expectedVersion: null,
      updatedBy: "g".repeat(500),
      nowMs: 12345,
    })
    const state = (await readOrgAppPolicy(env(), ORG)).chat
    expect(state.updatedAtMs).toBe(12345)
    expect(state.updatedBy!.length).toBe(160)
  })

  it("the CHECK constraint rejects an unknown app id at the SQL layer", async () => {
    const res = await writeOrgAppPolicy(env(), {
      installationId: ORG,
      appId: "github" as never,
      enabled: false,
      expectedVersion: null,
      updatedBy: "x",
      nowMs: 1,
    })
    expect(res).toEqual({ ok: false, reason: "error" })
  })
})

describe("schema drift", () => {
  it("the SQL CHECK list and ORG_APP_IDS stay in lockstep", () => {
    // SQLite can't ALTER a CHECK, so adding an app to the TS union only would make
    // every write for it fail as reason:"error" — indistinguishable from an outage.
    const inList = /app_id\s+TEXT\s+NOT NULL CHECK \(app_id IN \(([^)]*)\)\)/.exec(MIGRATION_SQL)
    expect(inList).not.toBeNull()
    const sqlIds = inList![1]!.split(",").map((s) => s.trim().replace(/^'|'$/g, ""))
    expect(sqlIds.sort()).toEqual([...ORG_APP_IDS].sort())
  })
})
