// SIG-606 — the dispatcher flush, end-to-end through a real SQLite D1 shim and the
// real migration. This is where the null-vs-empty posted-set decision actually bites.

import { describe, it, expect, beforeEach } from "vitest"
import type { D1Database } from "@cloudflare/workers-types"
import { readFileSync } from "node:fs"

import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { flushFindingEventLog } from "@/src/lib/finding-event-flush"
import type { FindingEventCapture, PostedFindingCapture } from "@/src/lib/ensemble/app/finding-event-capture"
import { materializeFindingEvents } from "@/src/lib/ensemble/app/finding-event-capture"

const MIGRATION_SQL = readFileSync(new URL("../../migrations/0037_create_finding_event.sql", import.meta.url), "utf8")

const job = { installationId: 7, repoId: 99, prNumber: 5, headSha: "deadbee" }

const capture = (over: Partial<FindingEventCapture> = {}): FindingEventCapture => ({
  path: "src/pay.ts",
  headline: "Double charge on retry",
  stage: "validator",
  ...over,
})

async function rows(db: D1Database) {
  const { results } = await db.prepare("SELECT * FROM finding_event ORDER BY id").all<Record<string, unknown>>()
  return results
}

describe("flushFindingEventLog", () => {
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("writes a posted row when publication observed the candidate", async () => {
    const captures = [capture({ gate: "diff-consistency", reason: "contradicts-diff", enforced: false })]
    const [draft] = await materializeFindingEvents(captures)
    const posted: PostedFindingCapture[] = [
      { findingKey: draft!.findingKey, surface: "posted-inline", inlineCommentId: 31 },
    ]

    await flushFindingEventLog({ SIGILIX_PLATFORM_DB: db }, job, captures, posted)

    const out = await rows(db)
    expect(out).toHaveLength(1)
    // Shadow gate + actually posted → posted, NOT suppressed.
    expect(out[0]).toMatchObject({
      outcome: "posted-inline",
      inline_comment_id: 31,
      gate: "diff-consistency",
      enforced: 0,
      installation_id: 7,
      repo_id: 99,
      pr_number: 5,
      head_sha: "deadbee",
    })
  })

  it("EMPTY posted sink → `unknown`, never `suppressed` (we never observed publication)", async () => {
    // An errored/aborted review reaches the flush with nothing posted. Labelling
    // those `suppressed` would invent false negatives for findings we may have posted.
    await flushFindingEventLog({ SIGILIX_PLATFORM_DB: db }, job, [capture()], [])
    const out = await rows(db)
    expect(out[0]!.outcome).toBe("unknown")
  })

  it("a candidate absent from a NON-empty posted set is suppressed", async () => {
    const captures = [capture({ path: "a.ts", headline: "Dropped one" }), capture({ path: "b.ts", headline: "Kept" })]
    const drafts = await materializeFindingEvents(captures)
    await flushFindingEventLog({ SIGILIX_PLATFORM_DB: db }, job, captures, [
      { findingKey: drafts[1]!.findingKey, surface: "posted-body" },
    ])
    const out = await rows(db)
    expect(out.map((r) => r.outcome)).toEqual(["suppressed", "posted-body"])
  })

  it("no captures → no rows, no write attempted", async () => {
    await flushFindingEventLog({ SIGILIX_PLATFORM_DB: db }, job, [], [])
    expect(await rows(db)).toHaveLength(0)
  })

  it("persists NO customer-source text (headline was only ever a hash input)", async () => {
    await flushFindingEventLog({ SIGILIX_PLATFORM_DB: db }, job, [capture()], [])
    expect(JSON.stringify(await rows(db))).not.toContain("Double charge")
  })

  it("FAILS SOFT — a broken DB never throws into the review", async () => {
    const broken = {
      prepare() {
        throw new Error("boom")
      },
      batch() {
        return Promise.reject(new Error("boom"))
      },
    } as unknown as D1Database
    await expect(flushFindingEventLog({ SIGILIX_PLATFORM_DB: broken }, job, [capture()], [])).resolves.toBeUndefined()
  })

  it("absent binding → silent no-op", async () => {
    await expect(flushFindingEventLog({}, job, [capture()], [])).resolves.toBeUndefined()
  })

  it("legacy job without repoId records repo_id 0 rather than failing", async () => {
    await flushFindingEventLog(
      { SIGILIX_PLATFORM_DB: db },
      { installationId: 1, prNumber: 2, headSha: "s" },
      [capture()],
      [],
    )
    expect((await rows(db))[0]).toMatchObject({ repo_id: 0 })
  })
})
