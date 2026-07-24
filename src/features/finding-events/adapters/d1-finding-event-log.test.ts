// SIG-606 — finding event log adapter. Schema is owned by migration 0037; the
// shim applies it before each test.

import { describe, it, expect, beforeEach } from "vitest"
import type { D1Database } from "@cloudflare/workers-types"
import { readFileSync } from "node:fs"

import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { appendFindingEvents } from "@/src/features/finding-events/adapters/d1-finding-event-log"
import type { FindingEvent } from "@/src/features/finding-events/domain/types"
import type { Env } from "@/src/shared/types/env"

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0037_create_finding_event.sql", import.meta.url),
  "utf8",
)

const identity = {
  installationId: 42,
  repoId: 7,
  prNumber: 123,
  headSha: "abc123",
  modelId: "openai/gpt-5-codex",
  promptVersion: "34",
}

// FindingEvent is discriminated on `outcome`, so spreading a Partial of it defeats
// narrowing. A test factory casts; production callers get the full union safety.
const event = (over: Record<string, unknown> = {}): FindingEvent =>
  ({ findingKey: "k1", stage: "validator", outcome: "suppressed", ...over }) as FindingEvent

function makeEnv(db: D1Database): Pick<Env, "SIGILIX_PLATFORM_DB"> {
  return { SIGILIX_PLATFORM_DB: db }
}

function makeBrokenDb(): D1Database {
  return {
    prepare() {
      throw new Error("simulated D1 error")
    },
    batch() {
      return Promise.reject(new Error("simulated D1 error"))
    },
  } as unknown as D1Database
}

async function rows(db: D1Database) {
  const { results } = await db.prepare("SELECT * FROM finding_event ORDER BY id").all<Record<string, unknown>>()
  return results
}

describe("appendFindingEvents", () => {
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("writes one row per candidate with the review identity + provenance", async () => {
    await appendFindingEvents(
      makeEnv(db),
      identity,
      [
        event({ findingKey: "a", outcome: "posted-inline", inlineCommentId: 9, category: "logic", score: 4 }),
        event({ findingKey: "b", outcome: "suppressed", gate: "tests", reason: "no-specifics", enforced: true }),
      ],
      "2026-07-24T00:00:00.000Z",
    )
    const out = await rows(db)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      installation_id: 42,
      repo_id: 7,
      pr_number: 123,
      head_sha: "abc123",
      finding_key: "a",
      outcome: "posted-inline",
      inline_comment_id: 9,
      category: "logic",
      score: 4,
      model_id: "openai/gpt-5-codex",
      prompt_version: "34",
    })
    expect(out[1]).toMatchObject({ finding_key: "b", outcome: "suppressed", gate: "tests", enforced: 1 })
  })

  it("stores NO customer-source-derived text — enforced as an exact column allow-list", async () => {
    // The privacy boundary is structural. An allow-list (not spot checks) so ANY
    // future text column — snippet, excerpt, body — fails this test on sight.
    await appendFindingEvents(makeEnv(db), identity, [event()], "2026-07-24T00:00:00.000Z")
    const columns = Object.keys((await rows(db))[0]!).sort()
    expect(columns).toEqual(
      [
        "id",
        "installation_id",
        "repo_id",
        "pr_number",
        "head_sha",
        "finding_key",
        "content_fingerprint",
        "category",
        "score",
        "confidence",
        "gate_score",
        "path",
        "line",
        "start_line",
        "source_specialists",
        "trust_tier",
        "stage",
        "gate",
        "reason",
        "enforced",
        "outcome",
        "model_id",
        "prompt_version",
        "inline_comment_id",
        "created_at",
      ].sort(),
    )
  })

  it("rejects a typo'd label at the SQL layer (CHECK) instead of writing a silent fake", async () => {
    await appendFindingEvents(
      makeEnv(db),
      identity,
      [{ findingKey: "bad", stage: "validator", outcome: "posted_inline" } as unknown as FindingEvent],
      "2026-07-24T00:00:00.000Z",
    )
    expect(await rows(db)).toHaveLength(0)
  })

  it("ONE malformed candidate costs one row — the rest of the review's labels still land", async () => {
    // db.batch() is all-or-nothing; without the per-statement fallback a single bad
    // field would silently discard the whole review. That is the failure this table exists to prevent.
    await appendFindingEvents(
      makeEnv(db),
      identity,
      [
        event({ findingKey: "good-1" }),
        { findingKey: "bad", stage: "nonsense", outcome: "suppressed" } as unknown as FindingEvent,
        event({ findingKey: "good-2" }),
      ],
      "2026-07-24T00:00:00.000Z",
    )
    const out = await rows(db)
    expect(out.map((r) => r.finding_key)).toEqual(["good-1", "good-2"])
  })

  it("fails soft when db.batch() itself rejects (prepare succeeds)", async () => {
    // Distinct from makeBrokenDb: there prepare() throws and batch() is unreachable,
    // so nothing would catch a regression that moved the await outside the try.
    const batchRejects = {
      prepare: () => ({ bind: () => ({ run: () => Promise.reject(new Error("row failed")) }) }),
      batch: () => Promise.reject(new Error("batch failed")),
    } as unknown as D1Database
    await expect(
      appendFindingEvents({ SIGILIX_PLATFORM_DB: batchRejects }, identity, [event()], "2026-07-24T00:00:00.000Z"),
    ).resolves.toBeUndefined()
  })

  it("is APPEND-only: re-appending the same candidate adds a row, never overwrites", async () => {
    await appendFindingEvents(
      makeEnv(db),
      identity,
      [event({ findingKey: "a", stage: "validator" })],
      "2026-07-24T00:00:00.000Z",
    )
    await appendFindingEvents(
      makeEnv(db),
      identity,
      [event({ findingKey: "a", stage: "publish", outcome: "posted-inline" })],
      "2026-07-24T00:05:00.000Z",
    )
    const out = await rows(db)
    expect(out).toHaveLength(2) // timeline preserved, not collapsed
    expect(out.map((r) => r.stage)).toEqual(["validator", "publish"])
    expect(out.map((r) => r.outcome)).toEqual(["suppressed", "posted-inline"])
  })

  it("joins arrays and coerces absent optionals to NULL (never NaN/undefined)", async () => {
    await appendFindingEvents(
      makeEnv(db),
      identity,
      [event({ sourceSpecialists: ["logic", "security"], score: Number.NaN, gateScore: 0.75 })],
      "2026-07-24T00:00:00.000Z",
    )
    const out = await rows(db)
    expect(out[0]!.source_specialists).toBe("logic,security")
    expect(out[0]!.score).toBeNull() // NaN coerced, not written
    expect(out[0]!.gate_score).toBe(0.75)
    expect(out[0]!.content_fingerprint).toBeNull()
  })

  it("empty batch is a no-op", async () => {
    await appendFindingEvents(makeEnv(db), identity, [], "2026-07-24T00:00:00.000Z")
    expect(await rows(db)).toHaveLength(0)
  })

  it("absent binding → silent no-op (unprovisioned deploy records nothing)", async () => {
    await expect(appendFindingEvents({}, identity, [event()], "2026-07-24T00:00:00.000Z")).resolves.toBeUndefined()
  })

  it("D1 error → FAIL-SOFT, never throws (instrumentation must not break a review)", async () => {
    await expect(
      appendFindingEvents({ SIGILIX_PLATFORM_DB: makeBrokenDb() }, identity, [event()], "2026-07-24T00:00:00.000Z"),
    ).resolves.toBeUndefined()
  })

  it("missing repoId (legacy message) defaults to 0 rather than failing the insert", async () => {
    await appendFindingEvents(
      makeEnv(db),
      { installationId: 1, prNumber: 2, headSha: "s" },
      [event()],
      "2026-07-24T00:00:00.000Z",
    )
    expect((await rows(db))[0]).toMatchObject({ repo_id: 0, model_id: null })
  })
})
