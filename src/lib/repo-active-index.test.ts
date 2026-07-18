import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import {
  deleteRepoActiveIndexByInstallationId,
  deleteRepoActiveIndexByRepoId,
  materializeRepoActiveIndex,
  parseRepoActiveIndexMode,
  parseRepoActiveIndexSnapshot,
  RepoActiveIndexSealedReplayMismatchError,
  stageRepoActiveIndexSlice,
  sweepExpiredRepoActiveIndexRuns,
} from "./repo-active-index"

const MIGRATION_SQL = readFileSync(
  new URL("../../migrations/0025_create_repo_active_index_stage.sql", import.meta.url),
  "utf8",
)
const REPO_ID = 808247824
const INSTALLATION_ID = 42
const RUN_ID = "a".repeat(16)
const DAY_MS = 24 * 60 * 60 * 1_000

function vectorId(value: number): string {
  return value.toString(16).padStart(48, "0")
}

function ids(count: number, start = 1): string[] {
  return Array.from({ length: count }, (_, index) => vectorId(start + index))
}

describe("repo active-index snapshot parsing", () => {
  it("defaults unknown rollout values to off and accepts only explicit modes", () => {
    expect(parseRepoActiveIndexMode(undefined)).toBe("off")
    expect(parseRepoActiveIndexMode("ON")).toBe("off")
    expect(parseRepoActiveIndexMode("unexpected")).toBe("off")
    expect(parseRepoActiveIndexMode("shadow")).toBe("shadow")
    expect(parseRepoActiveIndexMode("on")).toBe("on")
  })

  it("strictly parses provenance and rebuilds byPath without an object prototype", () => {
    const parsed = parseRepoActiveIndexSnapshot({
      version: 1,
      githubRepoId: REPO_ID,
      builtMode: "shadow",
      byPath: JSON.parse(`{"__proto__":["${vectorId(1)}"],"src/index.ts":["${vectorId(2)}"]}`),
    })

    expect(parsed).not.toBeNull()
    expect(Object.getPrototypeOf(parsed?.byPath)).toBeNull()
    expect(Object.keys(parsed?.byPath ?? {})).toEqual(["__proto__", "src/index.ts"])
    expect(parsed?.byPath["__proto__"]).toEqual([vectorId(1)])
  })

  it.each([
    ["unsafe repository id", { githubRepoId: Number.MAX_SAFE_INTEGER + 1 }],
    ["off build provenance", { builtMode: "off" }],
    ["unexpected top-level field", { extra: true }],
    ["empty path", { byPath: { "": [vectorId(1)] } }],
    ["NUL path", { byPath: { "src\0index.ts": [vectorId(1)] } }],
    ["empty id list", { byPath: { "src/index.ts": [] } }],
    ["malformed vector id", { byPath: { "src/index.ts": ["not-an-id"] } }],
    ["duplicate vector id", { byPath: { "src/index.ts": [vectorId(1), vectorId(1)] } }],
  ])("rejects %s", (_label, override) => {
    expect(
      parseRepoActiveIndexSnapshot({
        version: 1,
        githubRepoId: REPO_ID,
        builtMode: "on",
        byPath: { "src/index.ts": [vectorId(1)] },
        ...override,
      }),
    ).toBeNull()
  })

  it("returns null instead of executing a hostile accessor", () => {
    const value = {
      version: 1,
      githubRepoId: REPO_ID,
      builtMode: "on",
      get byPath(): never {
        throw new Error("must not escape the parser")
      },
    }
    expect(parseRepoActiveIndexSnapshot(value)).toBeNull()
  })
})

describe("repo active-index D1 staging", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("stages ordered slices, preserves every path, and materializes through a causal bookmark", async () => {
    const first = await stageRepoActiveIndexSlice({
      db,
      githubRepoId: REPO_ID,
      installationId: INSTALLATION_ID,
      runId: RUN_ID,
      totalFiles: 4,
      lo: 0,
      hi: 2,
      mode: "shadow",
      idsByPath: { "src/a.ts": [vectorId(1)], "src/b.ts": [vectorId(2)] },
      nowMs: 1_000,
    })
    expect(first.completedThrough).toBe(2)
    expect(first.bookmark).toEqual(expect.any(String))

    const second = await stageRepoActiveIndexSlice({
      db,
      githubRepoId: REPO_ID,
      installationId: INSTALLATION_ID,
      runId: RUN_ID,
      totalFiles: 4,
      lo: 2,
      hi: 4,
      mode: "shadow",
      idsByPath: { "src/c.ts": [vectorId(3)], "src/d.ts": [vectorId(4)] },
      bookmark: first.bookmark,
      nowMs: 2_000,
    })
    expect(second.completedThrough).toBe(4)

    const materialized = await materializeRepoActiveIndex({
      db,
      githubRepoId: REPO_ID,
      runId: RUN_ID,
      bookmark: second.bookmark,
    })
    expect(materialized.snapshot).toEqual({
      version: 1,
      githubRepoId: REPO_ID,
      builtMode: "shadow",
      byPath: {
        "src/a.ts": [vectorId(1)],
        "src/b.ts": [vectorId(2)],
        "src/c.ts": [vectorId(3)],
        "src/d.ts": [vectorId(4)],
      },
    })
    expect(Object.getPrototypeOf(materialized.snapshot.byPath)).toBeNull()

    const run = await db
      .prepare(
        "SELECT completed_through, latest_bookmark, expires_at_ms, sealed FROM repo_active_index_run" +
          " WHERE github_repo_id = ? AND run_id = ?",
      )
      .bind(REPO_ID, RUN_ID)
      .first<{ completed_through: number; latest_bookmark: string | null; expires_at_ms: number; sealed: number }>()
    expect(run).toMatchObject({ completed_through: 4, latest_bookmark: expect.any(String), sealed: 1 })
    expect(run?.expires_at_ms).toBe(2_000 + DAY_MS)
  })

  it("makes a stale-bookmark slice replay idempotent and returns the stored latest bookmark", async () => {
    const withSession = vi.spyOn(db, "withSession")
    const first = await stageRepoActiveIndexSlice({
      db,
      githubRepoId: REPO_ID,
      installationId: INSTALLATION_ID,
      runId: RUN_ID,
      totalFiles: 2,
      lo: 0,
      hi: 1,
      mode: "on",
      idsByPath: { "src/a.ts": [vectorId(1)] },
      nowMs: 100,
    })
    const final = await stageRepoActiveIndexSlice({
      db,
      githubRepoId: REPO_ID,
      installationId: INSTALLATION_ID,
      runId: RUN_ID,
      totalFiles: 2,
      lo: 1,
      hi: 2,
      mode: "on",
      idsByPath: { "src/b.ts": [vectorId(2)] },
      bookmark: first.bookmark,
      nowMs: 200,
    })

    const replay = await stageRepoActiveIndexSlice({
      db,
      githubRepoId: REPO_ID,
      installationId: INSTALLATION_ID,
      runId: RUN_ID,
      totalFiles: 2,
      lo: 1,
      hi: 2,
      mode: "on",
      idsByPath: { "src/b.ts": [vectorId(2)] },
      bookmark: first.bookmark,
      nowMs: 300,
    })
    expect(replay.completedThrough).toBe(2)
    expect(replay.bookmark).not.toBe(first.bookmark)

    const parts = await db
      .prepare("SELECT COUNT(*) AS count FROM repo_active_index_part WHERE github_repo_id = ? AND run_id = ?")
      .bind(REPO_ID, RUN_ID)
      .first<{ count: number }>()
    expect(parts?.count).toBe(2)
    expect(
      (await materializeRepoActiveIndex({ db, githubRepoId: REPO_ID, runId: RUN_ID, bookmark: replay.bookmark }))
        .snapshot.byPath,
    ).toEqual({
      "src/a.ts": [vectorId(1)],
      "src/b.ts": [vectorId(2)],
    })
    expect(final.completedThrough).toBe(2)
    expect(withSession.mock.calls.every(([constraint]) => constraint === "first-primary")).toBe(true)
  })

  it("keeps the first committed checkpoint boundary canonical across a shorter stale replay", async () => {
    const first = await stageRepoActiveIndexSlice({
      db,
      githubRepoId: REPO_ID,
      installationId: INSTALLATION_ID,
      runId: RUN_ID,
      totalFiles: 4,
      lo: 0,
      hi: 2,
      mode: "on",
      idsByPath: { "src/a.ts": [vectorId(1)], "src/b.ts": [vectorId(2)] },
      nowMs: 100,
    })
    await stageRepoActiveIndexSlice({
      db,
      githubRepoId: REPO_ID,
      installationId: INSTALLATION_ID,
      runId: RUN_ID,
      totalFiles: 4,
      lo: 2,
      hi: 4,
      mode: "on",
      idsByPath: { "src/c.ts": [vectorId(3)], "src/d.ts": [vectorId(4)] },
      bookmark: first.bookmark,
      nowMs: 200,
    })

    await expect(
      stageRepoActiveIndexSlice({
        db,
        githubRepoId: REPO_ID,
        installationId: INSTALLATION_ID,
        runId: RUN_ID,
        totalFiles: 4,
        lo: 0,
        hi: 1,
        mode: "on",
        idsByPath: { "src/a.ts": [vectorId(1)] },
        bookmark: first.bookmark,
        nowMs: 300,
      }),
    ).resolves.toMatchObject({ completedThrough: 4 })
    await expect(
      db.prepare("SELECT completed_through, invalidated FROM repo_active_index_run").first(),
    ).resolves.toEqual({ completed_through: 4, invalidated: 0 })
  })

  it("rejects a completed slice replay whose exact membership changed", async () => {
    const first = await stageRepoActiveIndexSlice({
      db,
      githubRepoId: REPO_ID,
      installationId: INSTALLATION_ID,
      runId: RUN_ID,
      totalFiles: 1,
      lo: 0,
      hi: 1,
      mode: "on",
      idsByPath: { "src/a.ts": [vectorId(1)] },
      nowMs: 100,
    })

    await expect(
      stageRepoActiveIndexSlice({
        db,
        githubRepoId: REPO_ID,
        installationId: INSTALLATION_ID,
        runId: RUN_ID,
        totalFiles: 1,
        lo: 0,
        hi: 1,
        mode: "on",
        idsByPath: { "src/a.ts": [vectorId(2)] },
        bookmark: first.bookmark,
        nowMs: 200,
      }),
    ).rejects.toThrow(/replay.*mismatch/i)
    await expect(materializeRepoActiveIndex({ db, githubRepoId: REPO_ID, runId: RUN_ID })).rejects.toThrow(
      /invalidated/i,
    )
    const parts = await db
      .prepare(
        "SELECT entries_json FROM repo_active_index_part WHERE github_repo_id = ? AND run_id = ? ORDER BY part_no",
      )
      .bind(REPO_ID, RUN_ID)
      .all<{ entries_json: string }>()
    expect(parts.results).toEqual([{ entries_json: JSON.stringify([["src/a.ts", [vectorId(1)]]]) }])
  })

  it("does not attach a post-batch bookmark after a concurrent invalidation", async () => {
    const racingDb = new Proxy(db, {
      get(targetDb, property, receiver) {
        if (property === "withSession") {
          return (constraint?: D1SessionConstraint) => {
            const session = targetDb.withSession(constraint)
            return new Proxy(session, {
              get(target, sessionProperty, sessionReceiver) {
                if (sessionProperty === "batch") {
                  return async (statements: D1PreparedStatement[]) => {
                    const results = await target.batch(statements)
                    await target
                      .prepare(
                        "UPDATE repo_active_index_run SET invalidated = 1" +
                          " WHERE github_repo_id = ? AND run_id = ? AND sealed = 0",
                      )
                      .bind(REPO_ID, RUN_ID)
                      .run()
                    return results
                  }
                }
                const value = Reflect.get(target, sessionProperty, sessionReceiver) as unknown
                return typeof value === "function" ? value.bind(target) : value
              },
            })
          }
        }
        const value = Reflect.get(targetDb, property, receiver) as unknown
        return typeof value === "function" ? value.bind(targetDb) : value
      },
    })

    await stageRepoActiveIndexSlice({
      db: racingDb,
      githubRepoId: REPO_ID,
      installationId: INSTALLATION_ID,
      runId: RUN_ID,
      totalFiles: 1,
      lo: 0,
      hi: 1,
      mode: "on",
      idsByPath: { "src/a.ts": [vectorId(1)] },
      nowMs: 100,
    })

    await expect(
      db
        .prepare("SELECT invalidated, latest_bookmark FROM repo_active_index_run")
        .first<{ invalidated: number; latest_bookmark: string | null }>(),
    ).resolves.toEqual({ invalidated: 1, latest_bookmark: null })
  })

  it("keeps a sealed canonical run usable when a late replay has divergent membership", async () => {
    const staged = await stageRepoActiveIndexSlice({
      db,
      githubRepoId: REPO_ID,
      installationId: INSTALLATION_ID,
      runId: RUN_ID,
      totalFiles: 1,
      lo: 0,
      hi: 1,
      mode: "on",
      idsByPath: { "src/a.ts": [vectorId(1)] },
      nowMs: 100,
    })
    const canonical = await materializeRepoActiveIndex({
      db,
      githubRepoId: REPO_ID,
      runId: RUN_ID,
      bookmark: staged.bookmark,
    })

    await expect(
      stageRepoActiveIndexSlice({
        db,
        githubRepoId: REPO_ID,
        installationId: INSTALLATION_ID,
        runId: RUN_ID,
        totalFiles: 1,
        lo: 0,
        hi: 1,
        mode: "on",
        idsByPath: { "src/a.ts": [vectorId(2)] },
        bookmark: canonical.bookmark,
        nowMs: 200,
      }),
    ).rejects.toBeInstanceOf(RepoActiveIndexSealedReplayMismatchError)

    expect(
      await db
        .prepare("SELECT sealed, invalidated FROM repo_active_index_run WHERE github_repo_id = ? AND run_id = ?")
        .bind(REPO_ID, RUN_ID)
        .first<{ sealed: number; invalidated: number }>(),
    ).toEqual({ sealed: 1, invalidated: 0 })
    await expect(materializeRepoActiveIndex({ db, githubRepoId: REPO_ID, runId: RUN_ID })).resolves.toMatchObject({
      snapshot: canonical.snapshot,
    })
  })

  it("rejects out-of-order slices and pinned-run metadata drift without retaining parts", async () => {
    const base = {
      db,
      githubRepoId: REPO_ID,
      installationId: INSTALLATION_ID,
      runId: RUN_ID,
      totalFiles: 4,
      mode: "shadow" as const,
      idsByPath: { "src/c.ts": [vectorId(3)] },
      nowMs: 100,
    }
    await expect(stageRepoActiveIndexSlice({ ...base, lo: 2, hi: 3 })).rejects.toThrow(/out of order/i)
    expect(await db.prepare("SELECT COUNT(*) AS count FROM repo_active_index_part").first<{ count: number }>()).toEqual(
      { count: 0 },
    )

    const first = await stageRepoActiveIndexSlice({
      ...base,
      lo: 0,
      hi: 2,
      idsByPath: { "src/a.ts": [vectorId(1)] },
    })
    await expect(
      stageRepoActiveIndexSlice({
        ...base,
        lo: 2,
        hi: 4,
        mode: "on",
        bookmark: first.bookmark,
      }),
    ).rejects.toThrow(/metadata/i)
  })

  it("splits one large path across bounded parts and paginates more than sixteen parts", async () => {
    const byPath: Record<string, string[]> = {}
    for (let pathIndex = 0; pathIndex < 9; pathIndex += 1) {
      byPath[`src/large-${pathIndex}.ts`] = ids(700, pathIndex * 1_000 + 1)
    }
    const staged = await stageRepoActiveIndexSlice({
      db,
      githubRepoId: REPO_ID,
      installationId: INSTALLATION_ID,
      runId: RUN_ID,
      totalFiles: 9,
      lo: 0,
      hi: 9,
      mode: "on",
      idsByPath: byPath,
      nowMs: 100,
    })
    const rows = await db
      .prepare(
        "SELECT entries_json FROM repo_active_index_part" +
          " WHERE github_repo_id = ? AND run_id = ? ORDER BY slice_lo, part_no",
      )
      .bind(REPO_ID, RUN_ID)
      .all<{ entries_json: string }>()
    expect(rows.results.length).toBeGreaterThan(16)
    expect(rows.results.every((row) => new TextEncoder().encode(row.entries_json).byteLength <= 32 * 1024)).toBe(true)

    const materialized = await materializeRepoActiveIndex({
      db,
      githubRepoId: REPO_ID,
      runId: RUN_ID,
      bookmark: staged.bookmark,
    })
    expect(materialized.snapshot.byPath).toEqual(byPath)
  })

  it("rejects materialization before every file slice is complete and on malformed staged JSON", async () => {
    const staged = await stageRepoActiveIndexSlice({
      db,
      githubRepoId: REPO_ID,
      installationId: INSTALLATION_ID,
      runId: RUN_ID,
      totalFiles: 2,
      lo: 0,
      hi: 1,
      mode: "on",
      idsByPath: { "src/a.ts": [vectorId(1)] },
      nowMs: 100,
    })
    await expect(
      materializeRepoActiveIndex({ db, githubRepoId: REPO_ID, runId: RUN_ID, bookmark: staged.bookmark }),
    ).rejects.toThrow(/incomplete/i)
    await expect(
      db
        .prepare("UPDATE repo_active_index_run SET sealed = 1 WHERE github_repo_id = ? AND run_id = ?")
        .bind(REPO_ID, RUN_ID)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/i)

    await db
      .prepare(
        "UPDATE repo_active_index_run SET completed_through = total_files WHERE github_repo_id = ? AND run_id = ?",
      )
      .bind(REPO_ID, RUN_ID)
      .run()
    await db
      .prepare("UPDATE repo_active_index_part SET entries_json = ? WHERE github_repo_id = ? AND run_id = ?")
      .bind("{not-json", REPO_ID, RUN_ID)
      .run()
    await expect(materializeRepoActiveIndex({ db, githubRepoId: REPO_ID, runId: RUN_ID })).rejects.toThrow(/malformed/i)
  })

  it("rejects non-contiguous part numbers instead of publishing a silently truncated snapshot", async () => {
    const staged = await stageRepoActiveIndexSlice({
      db,
      githubRepoId: REPO_ID,
      installationId: INSTALLATION_ID,
      runId: RUN_ID,
      totalFiles: 1,
      lo: 0,
      hi: 1,
      mode: "on",
      idsByPath: { "src/a.ts": [vectorId(1)] },
      nowMs: 100,
    })
    await db
      .prepare(
        "UPDATE repo_active_index_part SET part_no = 1" +
          " WHERE github_repo_id = ? AND run_id = ? AND slice_lo = 0 AND part_no = 0",
      )
      .bind(REPO_ID, RUN_ID)
      .run()

    await expect(
      materializeRepoActiveIndex({ db, githubRepoId: REPO_ID, runId: RUN_ID, bookmark: staged.bookmark }),
    ).rejects.toThrow(/malformed/i)
  })

  it("rejects a staged part count that could exceed the per-invocation query budget", async () => {
    await db
      .prepare(
        `INSERT INTO repo_active_index_run
          (github_repo_id, run_id, installation_id, total_files, completed_through,
           built_mode, latest_bookmark, expires_at_ms)
         VALUES (?, ?, ?, 1, 1, 'on', NULL, ?)`,
      )
      .bind(REPO_ID, RUN_ID, INSTALLATION_ID, DAY_MS)
      .run()
    await db.exec(`WITH RECURSIVE sequence(part_no) AS (
        SELECT 0
        UNION ALL SELECT part_no + 1 FROM sequence WHERE part_no < 11000
      )
      INSERT INTO repo_active_index_part
        (github_repo_id, run_id, slice_lo, part_no, entries_json)
      SELECT ${REPO_ID}, '${RUN_ID}', 0, part_no,
        '[["src/' || part_no || '.ts",["' || printf('%048x', part_no + 1) || '"]]]'
      FROM sequence`)

    await expect(materializeRepoActiveIndex({ db, githubRepoId: REPO_ID, runId: RUN_ID })).rejects.toThrow(
      /part count/i,
    )
  })

  it("bounds expiry sweeps and supports exact repository and installation deletion", async () => {
    for (let index = 0; index < 3; index += 1) {
      await stageRepoActiveIndexSlice({
        db,
        githubRepoId: REPO_ID + index,
        installationId: index < 2 ? INSTALLATION_ID : INSTALLATION_ID + 1,
        runId: index.toString(16).repeat(16),
        totalFiles: 1,
        lo: 0,
        hi: 1,
        mode: "shadow",
        idsByPath: { [`src/${index}.ts`]: [vectorId(index + 1)] },
        nowMs: index,
      })
    }

    expect(await sweepExpiredRepoActiveIndexRuns({ db, nowMs: DAY_MS + 10, limit: 1 })).toBe(1)
    expect(await sweepExpiredRepoActiveIndexRuns({ db, nowMs: DAY_MS + 10, limit: 10 })).toBe(2)

    await stageRepoActiveIndexSlice({
      db,
      githubRepoId: REPO_ID + 10,
      installationId: INSTALLATION_ID,
      runId: "d".repeat(16),
      totalFiles: 1,
      lo: 0,
      hi: 1,
      mode: "on",
      idsByPath: { "src/repo.ts": [vectorId(10)] },
      nowMs: DAY_MS + 20,
    })
    await stageRepoActiveIndexSlice({
      db,
      githubRepoId: REPO_ID + 11,
      installationId: INSTALLATION_ID,
      runId: "e".repeat(16),
      totalFiles: 1,
      lo: 0,
      hi: 1,
      mode: "on",
      idsByPath: { "src/installation.ts": [vectorId(11)] },
      nowMs: DAY_MS + 20,
    })

    expect(await deleteRepoActiveIndexByRepoId({ db, githubRepoId: REPO_ID + 10 })).toBe(1)
    expect(await deleteRepoActiveIndexByInstallationId({ db, installationId: INSTALLATION_ID })).toBe(1)
    expect(await db.prepare("SELECT COUNT(*) AS count FROM repo_active_index_run").first<{ count: number }>()).toEqual({
      count: 0,
    })
    expect(await db.prepare("SELECT COUNT(*) AS count FROM repo_active_index_part").first<{ count: number }>()).toEqual(
      { count: 0 },
    )
  })
})
