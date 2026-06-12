// SIG-107: RunnerToolMetricsDO — rolling per-tool scan-manifest telemetry.
//
// The runner evidence receipt tells us whether a review is backed by CI evidence;
// this DO answers the product question beneath it: which deterministic tools are
// enabled, which fail to produce output, and which produce findings. It records
// accepted runner scan manifests only. Telemetry is never part of receipt
// correctness; callers must treat write failures as non-fatal.

import { DurableObject } from "cloudflare:workers"
import type { Env } from "@/src/shared/types/env"
import { isSafeRunnerToolId } from "@/src/shared/domain/runner-tool-catalog"

const RETENTION_DAYS = 35
const MAX_LATEST_TOOL_ROWS = 500
const DAY_MS = 86_400_000
const MAX_WINDOW_DAYS = 30
const RUNNER_TOOL_STATUS_SET: ReadonlySet<string> = new Set([
  "disabled",
  "missing-output",
  "invalid-output",
  "empty",
  "produced",
])

const SCHEMA = `
CREATE TABLE IF NOT EXISTS daily_manifest (
  day TEXT PRIMARY KEY,
  receipts INTEGER NOT NULL DEFAULT 0,
  tool_rows INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS daily_tool_status (
  day TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  status TEXT NOT NULL,
  receipts INTEGER NOT NULL DEFAULT 0,
  enabled_receipts INTEGER NOT NULL DEFAULT 0,
  run_count INTEGER NOT NULL DEFAULT 0,
  result_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, tool_id, status)
);
CREATE INDEX IF NOT EXISTS runner_tool_status_by_day ON daily_tool_status(day);
CREATE TABLE IF NOT EXISTS repo_tool_latest (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  status TEXT NOT NULL,
  run_count INTEGER NOT NULL DEFAULT 0,
  result_count INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (owner, repo, tool_id)
);
CREATE INDEX IF NOT EXISTS runner_tool_latest_by_at ON repo_tool_latest(last_seen_at);
`

export type RunnerToolStatus = "disabled" | "missing-output" | "invalid-output" | "empty" | "produced"

export interface RecordRunnerToolManifestTool {
  toolId: string
  enabled: boolean
  status: RunnerToolStatus
  runCount?: number
  resultCount?: number
}

export interface RecordRunnerToolManifestArgs {
  owner: string
  repo: string
  tools: readonly RecordRunnerToolManifestTool[]
  occurredAt?: string
}

export interface RunnerToolMetricsQuery {
  window: { days: number; startDay: string; endDay: string }
  manifestReceipts: number
  toolRows: number
  tools: Array<{
    toolId: string
    statuses: Record<string, number>
    enabledReceipts: number
    runCount: number
    resultCount: number
  }>
  latestByRepo: Array<{
    owner: string
    repo: string
    toolId: string
    enabled: boolean
    status: string
    runCount: number
    resultCount: number
    lastSeenAt: string
  }>
}

function utcDay(iso?: string): string {
  return (iso ? new Date(iso) : new Date()).toISOString().slice(0, 10)
}

function utcDayMinus(iso: string, n: number): string {
  return new Date(new Date(iso).getTime() - n * DAY_MS).toISOString().slice(0, 10)
}

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

function isRecordableTool(tool: RecordRunnerToolManifestTool): boolean {
  return isSafeRunnerToolId(tool.toolId) && RUNNER_TOOL_STATUS_SET.has(tool.status)
}

export class RunnerToolMetricsDO extends DurableObject<Env> {
  private ready = false

  private sql(): DurableObjectStorage["sql"] {
    if (!this.ready) {
      this.ctx.storage.sql.exec(SCHEMA)
      this.ready = true
    }
    return this.ctx.storage.sql
  }

  async recordManifest(args: RecordRunnerToolManifestArgs): Promise<void> {
    const sql = this.sql()
    const day = utcDay(args.occurredAt)
    const at = args.occurredAt ?? new Date().toISOString()
    const tools = args.tools.filter(isRecordableTool)

    this.ctx.storage.transactionSync(() => {
      sql.exec(
        `INSERT INTO daily_manifest (day, receipts, tool_rows)
         VALUES (?, 1, ?)
         ON CONFLICT(day) DO UPDATE SET
           receipts = receipts + 1,
           tool_rows = tool_rows + ?`,
        day,
        tools.length,
        tools.length,
      )

      for (const tool of tools) {
        const runCount = count(tool.runCount)
        const resultCount = count(tool.resultCount)
        const enabledReceipts = tool.enabled ? 1 : 0
        sql.exec(
          `INSERT INTO daily_tool_status
             (day, tool_id, status, receipts, enabled_receipts, run_count, result_count)
           VALUES (?, ?, ?, 1, ?, ?, ?)
           ON CONFLICT(day, tool_id, status) DO UPDATE SET
             receipts = receipts + 1,
             enabled_receipts = enabled_receipts + ?,
             run_count = run_count + ?,
             result_count = result_count + ?`,
          day,
          tool.toolId,
          tool.status,
          enabledReceipts,
          runCount,
          resultCount,
          enabledReceipts,
          runCount,
          resultCount,
        )

        if (args.owner !== "" && args.repo !== "") {
          sql.exec(
            `INSERT INTO repo_tool_latest
               (owner, repo, tool_id, enabled, status, run_count, result_count, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(owner, repo, tool_id) DO UPDATE SET
               enabled = excluded.enabled,
               status = excluded.status,
               run_count = excluded.run_count,
               result_count = excluded.result_count,
               last_seen_at = excluded.last_seen_at
             WHERE excluded.last_seen_at >= repo_tool_latest.last_seen_at`,
            args.owner,
            args.repo,
            tool.toolId,
            tool.enabled ? 1 : 0,
            tool.status,
            runCount,
            resultCount,
            at,
          )
        }
      }
    })

    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + DAY_MS)
    }
  }

  async query(args: { windowDays: number; nowIso?: string }): Promise<RunnerToolMetricsQuery> {
    const sql = this.sql()
    const windowDays = Math.max(1, Math.min(args.windowDays, MAX_WINDOW_DAYS))
    const now = args.nowIso ?? new Date().toISOString()
    const endDay = utcDay(now)
    const startDay = utcDayMinus(now, windowDays - 1)
    const startAt = `${startDay}T00:00:00.000Z`

    const manifest = [
      ...sql.exec<{ receipts: number; tool_rows: number }>(
        `SELECT COALESCE(SUM(receipts), 0) AS receipts,
                COALESCE(SUM(tool_rows), 0) AS tool_rows
         FROM daily_manifest WHERE day >= ? AND day <= ?`,
        startDay,
        endDay,
      ),
    ][0] ?? { receipts: 0, tool_rows: 0 }

    const byTool = new Map<
      string,
      {
        toolId: string
        statuses: Record<string, number>
        enabledReceipts: number
        runCount: number
        resultCount: number
      }
    >()
    for (const row of sql.exec<{
      tool_id: string
      status: string
      receipts: number
      enabled_receipts: number
      run_count: number
      result_count: number
    }>(
      `SELECT tool_id, status,
              SUM(receipts) AS receipts,
              SUM(enabled_receipts) AS enabled_receipts,
              SUM(run_count) AS run_count,
              SUM(result_count) AS result_count
       FROM daily_tool_status
       WHERE day >= ? AND day <= ?
       GROUP BY tool_id, status`,
      startDay,
      endDay,
    )) {
      const entry = byTool.get(row.tool_id) ?? {
        toolId: row.tool_id,
        statuses: {},
        enabledReceipts: 0,
        runCount: 0,
        resultCount: 0,
      }
      entry.statuses[row.status] = row.receipts
      entry.enabledReceipts += row.enabled_receipts
      entry.runCount += row.run_count
      entry.resultCount += row.result_count
      byTool.set(row.tool_id, entry)
    }

    const latestByRepo = [
      ...sql.exec<{
        owner: string
        repo: string
        tool_id: string
        enabled: number
        status: string
        run_count: number
        result_count: number
        last_seen_at: string
      }>(
        `SELECT owner, repo, tool_id, enabled, status, run_count, result_count, last_seen_at
         FROM repo_tool_latest
         WHERE last_seen_at >= ?
         ORDER BY last_seen_at DESC LIMIT ?`,
        startAt,
        MAX_LATEST_TOOL_ROWS,
      ),
    ].map((row) => ({
      owner: row.owner,
      repo: row.repo,
      toolId: row.tool_id,
      enabled: row.enabled === 1,
      status: row.status,
      runCount: row.run_count,
      resultCount: row.result_count,
      lastSeenAt: row.last_seen_at,
    }))

    return {
      window: { days: windowDays, startDay, endDay },
      manifestReceipts: manifest.receipts,
      toolRows: manifest.tool_rows,
      tools: [...byTool.values()].sort((a, b) => a.toolId.localeCompare(b.toolId)),
      latestByRepo,
    }
  }

  override async alarm(): Promise<void> {
    const sql = this.sql()
    const now = new Date().toISOString()
    const cutoffDay = utcDayMinus(now, RETENTION_DAYS - 1)
    const cutoffAt = new Date(new Date(now).getTime() - RETENTION_DAYS * DAY_MS).toISOString()

    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM daily_manifest WHERE day < ?", cutoffDay)
      sql.exec("DELETE FROM daily_tool_status WHERE day < ?", cutoffDay)
      sql.exec("DELETE FROM repo_tool_latest WHERE last_seen_at < ?", cutoffAt)
    })

    const remaining = [...sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM daily_manifest")][0]?.n ?? 0
    if (remaining > 0) await this.ctx.storage.setAlarm(Date.now() + DAY_MS)
  }
}
