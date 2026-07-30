// History-ingest consumers, driven end-to-end with a fake GitHub client, a fake
// Vectorize/AI env, and the REAL lease through the real migration. The behaviours
// that must not regress: dark-flag no-op, resume-from-cursor sharding, no cursor
// advance past a lossy shard, and expire-on-throw so retries resume.

import { describe, it, expect, beforeEach, vi } from "vitest"
import type { D1Database } from "@cloudflare/workers-types"
import { readFileSync } from "node:fs"

import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { handleHistoryIngest } from "@/src/lib/history-corpus-jobs"
import { claimHistoryLease } from "@/src/lib/history-ingest-lease"
import { GitHubClient } from "@/src/shared/adapters/github"
import * as githubApp from "@/src/shared/adapters/github/github-app"
import type { Env } from "@/src/shared/types/env"

const MIGRATION_SQL = readFileSync(
  new URL("../../migrations/0039_create_history_ingest_lease.sql", import.meta.url),
  "utf8",
)

vi.mock("@/src/shared/adapters/github/github-app", () => ({ getInstallationToken: vi.fn(async () => "tok") }))

/** 30 merged PRs → 2 shards at SHARD_PRS=25. Each PR yields 2 embeddable docs. */
function fakeGithub(prCount = 30) {
  vi.spyOn(GitHubClient.prototype, "searchMergedPullRequests").mockImplementation(async () =>
    Array.from({ length: prCount }, (_, i) => ({ number: i + 1, title: `PR ${i + 1}`, body: "" })),
  )
  vi.spyOn(GitHubClient.prototype, "getPullRequestCommits").mockImplementation(async (_o, _r, n) => [
    { sha: `sha-${n}-a`, message: `feat: change ${n} with enough length` },
  ])
  vi.spyOn(GitHubClient.prototype, "listPullRequestReviewComments").mockImplementation(async (_o, _r, n) => [
    {
      id: n * 10,
      user: { login: "dev" },
      path: "src/x.ts",
      line: 1,
      original_line: 1,
      body: `don't do it that way here, we tried it and it broke ${n}`,
    },
  ])
  vi.spyOn(GitHubClient.prototype, "listPullRequestReviews").mockImplementation(async () => [])
}

function makeEnv(db: D1Database) {
  const upserts: Array<{ id: string; namespace?: string; metadata?: Record<string, unknown> }> = []
  const sent: unknown[] = []
  const env = {
    SIGILIX_HISTORY_CORPUS: "on",
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "k",
    OPENCLAW_STATE: { get: async () => null, put: async () => {} },
    SIGILIX_PLATFORM_DB: db,
    AI: { run: async (_m: string, _input: { text: string | string[] }) => ({ data: [Array(768).fill(0.1)] }) },
    OPENCLAW_CODE_INDEX: {
      upsert: async (vectors: Array<{ id: string; namespace?: string; metadata?: Record<string, unknown> }>) => {
        upserts.push(...vectors)
      },
    },
    OPENCLAW_JOBS: {
      send: async (msg: unknown) => {
        sent.push(msg)
      },
    },
  } as unknown as Env
  return { env, upserts, sent }
}

const JOB = { op: "backfill" as const, owner: "acme", repo: "site", installationId: 7 }

describe("handleHistoryIngest — backfill", () => {
  let db: D1Database
  beforeEach(async () => {
    vi.restoreAllMocks()
    vi.mocked(githubApp.getInstallationToken).mockResolvedValue("tok")
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("DARK flag → total no-op: no lease, no GitHub, no embeds", async () => {
    fakeGithub()
    const { env, upserts } = makeEnv(db)
    ;(env as { SIGILIX_HISTORY_CORPUS?: string | undefined }).SIGILIX_HISTORY_CORPUS = undefined
    await handleHistoryIngest(env, JOB, 1000)
    expect(upserts).toHaveLength(0)
    const lease = await db.prepare("SELECT COUNT(*) AS n FROM history_ingest_lease").first<{ n: number }>()
    expect(lease?.n).toBe(0)
  })

  it("first shard processes 25 PRs, persists the cursor, and re-enqueues itself", async () => {
    fakeGithub(30)
    const { env, upserts, sent } = makeEnv(db)
    await handleHistoryIngest(env, JOB, 1000)

    expect(upserts.length).toBe(50) // 25 PRs × 2 docs
    expect(upserts[0]!.namespace).toBe("history:acme/site")
    const row = await db.prepare("SELECT cursor, status, docs_done FROM history_ingest_lease").first<{
      cursor: number
      status: string
      docs_done: number
    }>()
    expect(row).toMatchObject({ cursor: 25, status: "running", docs_done: 50 })
    expect(sent).toEqual([
      {
        type: "history-ingest",
        op: "backfill",
        owner: "acme",
        repo: "site",
        installationId: 7,
        leaseToken: expect.any(String),
      },
    ])
  })

  it("the continuation shard RESUMES from the cursor (via its token) and completes the lease", async () => {
    // A continuation must RENEW, not re-claim: re-claiming would find its own live
    // lease, be denied, ack, and stall the run forever with nothing left to fire.
    fakeGithub(30)
    const { env, sent } = makeEnv(db)
    await handleHistoryIngest(env, JOB, 1000) // shard 1 (0-24), enqueues continuation
    const continuation = sent[0] as { leaseToken: string }
    const { env: env2, upserts: upserts2, sent: sent2 } = makeEnv(db)
    await handleHistoryIngest(env2, { ...JOB, leaseToken: continuation.leaseToken }, 2000) // shard 2 (25-29)

    expect(upserts2.length).toBe(10) // 5 remaining PRs × 2 — NOT re-embedding the first 25
    expect(sent2).toHaveLength(0) // done — no further continuation
    const row = await db.prepare("SELECT status, cursor, docs_done FROM history_ingest_lease").first<{
      status: string
      cursor: number
      docs_done: number
    }>()
    expect(row).toMatchObject({ status: "complete", cursor: 30, docs_done: 60 })
  })

  it("a lossy shard does NOT advance the cursor — it expires the lease and throws", async () => {
    fakeGithub(30)
    const { env } = makeEnv(db)
    // Make every embed fail: upsertHistoryDoc swallows and returns false.
    ;(env as unknown as { AI: { run: () => Promise<never> } }).AI = {
      run: async () => {
        throw new Error("ai down")
      },
    }
    await expect(handleHistoryIngest(env, JOB, 1000)).rejects.toThrow(/doc upserts failed/)

    const row = await db.prepare("SELECT cursor, status, lease_expires_at_ms FROM history_ingest_lease").first<{
      cursor: number
      status: string
      lease_expires_at_ms: number
    }>()
    expect(row).toMatchObject({ cursor: 0, status: "running", lease_expires_at_ms: 0 }) // resumable NOW
    // ...and the immediate retry can claim and resume (the permanent-loss fix).
    const retry = await claimHistoryLease(
      { SIGILIX_PLATFORM_DB: db },
      { owner: "acme", repo: "site", installationId: 7, nowMs: 2000 },
    )
    expect(retry.ok).toBe(true)
  })

  it("a second concurrent enqueue is denied by the live lease and acks harmlessly", async () => {
    fakeGithub(30)
    const { env } = makeEnv(db)
    await handleHistoryIngest(env, JOB, 1000)
    const { env: env2, upserts: upserts2 } = makeEnv(db)
    // Same nowMs — lease is live (renewed by shard 1's advance).
    await handleHistoryIngest(env2, { ...JOB }, 1500)
    // Denied claim: no work done. (Shard 1's continuation owns the run.)
    expect(upserts2).toHaveLength(0)
  })
})

describe("handleHistoryIngest — pr-upsert", () => {
  let db: D1Database
  beforeEach(async () => {
    vi.restoreAllMocks()
    vi.mocked(githubApp.getInstallationToken).mockResolvedValue("tok")
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("upserts one merged PR's docs with immutable ids (idempotent overwrites)", async () => {
    fakeGithub()
    const { env, upserts } = makeEnv(db)
    await handleHistoryIngest(env, { ...JOB, op: "pr-upsert", prNumber: 3 }, 1000)
    expect(upserts.map((u) => u.id).sort()).toEqual(["commit-sha-3-a", "prrc-30"])
    expect(upserts[0]!.metadata).toMatchObject({ kind: expect.any(String), ref: expect.any(String) })
  })

  it("THROWS when any doc upsert failed so the queue retries (no silent holes)", async () => {
    fakeGithub()
    const { env } = makeEnv(db)
    ;(env as unknown as { AI: { run: () => Promise<never> } }).AI = {
      run: async () => {
        throw new Error("ai down")
      },
    }
    await expect(handleHistoryIngest(env, { ...JOB, op: "pr-upsert", prNumber: 3 }, 1000)).rejects.toThrow(
      /doc upserts failed/,
    )
  })

  it("dark flag → no-op", async () => {
    fakeGithub()
    const { env, upserts } = makeEnv(db)
    ;(env as { SIGILIX_HISTORY_CORPUS?: string }).SIGILIX_HISTORY_CORPUS = "off"
    await handleHistoryIngest(env, { ...JOB, op: "pr-upsert", prNumber: 3 }, 1000)
    expect(upserts).toHaveLength(0)
  })
})
