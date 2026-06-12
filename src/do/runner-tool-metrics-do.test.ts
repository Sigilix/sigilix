// SIG-107 — RunnerToolMetricsDO: rolling per-tool scan-manifest telemetry.

import { describe, expect, it } from "vitest"
import { RunnerToolMetricsDO, type RecordRunnerToolManifestTool } from "@/src/do/runner-tool-metrics"
import type { Env } from "@/src/shared/types/env"
import { NodeSqliteStorage } from "@/src/test-shims/cloudflare-workers-shim"

function makeDoInstance(): { do_: RunnerToolMetricsDO; getAlarm: () => number | null } {
  const sqlStorage = new NodeSqliteStorage()
  let alarmAt: number | null = null
  const state = {
    storage: {
      sql: sqlStorage,
      transactionSync<T>(fn: () => T): T {
        return sqlStorage.transactionSync(fn)
      },
      async get(): Promise<unknown> {
        return undefined
      },
      async put(): Promise<void> {},
      async delete(): Promise<boolean> {
        return false
      },
      async setAlarm(t: number): Promise<void> {
        alarmAt = t
      },
      async getAlarm(): Promise<number | null> {
        return alarmAt
      },
      async deleteAlarm(): Promise<void> {
        alarmAt = null
      },
    },
    id: { toString: () => "global", name: "global" },
  }
  return {
    do_: new RunnerToolMetricsDO(state as unknown as DurableObjectState, {} as Env),
    getAlarm: () => alarmAt,
  }
}

const base = { owner: "Sigilix", repo: "sigilix" }
const T = "2026-06-12T12:00:00.000Z"

const tool = (over: Partial<RecordRunnerToolManifestTool>): RecordRunnerToolManifestTool => ({
  toolId: "eslint",
  enabled: true,
  status: "produced",
  runCount: 1,
  resultCount: 3,
  ...over,
})

describe("RunnerToolMetricsDO.recordManifest + query", () => {
  it("aggregates scan-manifest receipts by tool status and result volume", async () => {
    const { do_ } = makeDoInstance()
    await do_.recordManifest({
      ...base,
      occurredAt: T,
      tools: [
        tool({ toolId: "eslint", status: "produced", resultCount: 3 }),
        tool({ toolId: "ruff", status: "empty", resultCount: 0 }),
        { toolId: "shellcheck", enabled: false, status: "disabled" },
      ],
    })
    await do_.recordManifest({
      ...base,
      occurredAt: T,
      tools: [tool({ toolId: "eslint", status: "produced", resultCount: 5 })],
    })

    const out = await do_.query({ windowDays: 7, nowIso: T })
    expect(out.manifestReceipts).toBe(2)
    expect(out.toolRows).toBe(4)
    const eslint = out.tools.find((t) => t.toolId === "eslint")
    expect(eslint).toMatchObject({
      enabledReceipts: 2,
      runCount: 2,
      resultCount: 8,
      statuses: { produced: 2 },
    })
    const shellcheck = out.tools.find((t) => t.toolId === "shellcheck")
    expect(shellcheck).toMatchObject({
      enabledReceipts: 0,
      runCount: 0,
      resultCount: 0,
      statuses: { disabled: 1 },
    })
  })

  it("keeps latest per-repo tool state with newest timestamp winning", async () => {
    const { do_ } = makeDoInstance()
    await do_.recordManifest({
      ...base,
      occurredAt: "2026-06-12T10:00:00.000Z",
      tools: [{ toolId: "eslint", enabled: true, status: "missing-output" }],
    })
    await do_.recordManifest({
      ...base,
      occurredAt: "2026-06-12T11:00:00.000Z",
      tools: [tool({ toolId: "eslint", status: "produced", resultCount: 4 })],
    })
    await do_.recordManifest({
      ...base,
      occurredAt: "2026-06-12T09:00:00.000Z",
      tools: [{ toolId: "eslint", enabled: true, status: "invalid-output" }],
    })

    const out = await do_.query({ windowDays: 7, nowIso: T })
    expect(out.latestByRepo.find((row) => row.toolId === "eslint")).toMatchObject({
      owner: "Sigilix",
      repo: "sigilix",
      status: "produced",
      resultCount: 4,
      lastSeenAt: "2026-06-12T11:00:00.000Z",
    })
  })

  it("excludes old daily counts from the requested window", async () => {
    const { do_ } = makeDoInstance()
    await do_.recordManifest({
      owner: "Old",
      repo: "repo",
      occurredAt: "2026-05-20T12:00:00.000Z",
      tools: [tool({ toolId: "ruff" })],
    })
    await do_.recordManifest({ ...base, occurredAt: T, tools: [tool({})] })

    const out = await do_.query({ windowDays: 7, nowIso: T })
    expect(out.manifestReceipts).toBe(1)
    expect(out.window).toEqual({ days: 7, startDay: "2026-06-06", endDay: "2026-06-12" })
    expect(out.latestByRepo.some((row) => row.owner === "Old" && row.repo === "repo")).toBe(false)
  })

  it("drops unsafe direct tool rows and clamps direct query windows", async () => {
    const { do_ } = makeDoInstance()
    await do_.recordManifest({
      ...base,
      occurredAt: T,
      tools: [
        tool({ toolId: "semgrep" }),
        { toolId: "bad/tool", enabled: true, status: "produced", resultCount: 9 },
        {
          toolId: "eslint",
          enabled: true,
          status: "not-a-status",
          resultCount: 9,
        } as unknown as RecordRunnerToolManifestTool,
      ],
    })

    const out = await do_.query({ windowDays: 999, nowIso: T })
    expect(out.window.days).toBe(30)
    expect(out.toolRows).toBe(1)
    expect(out.tools.map((t) => t.toolId)).toEqual(["semgrep"])
  })

  it("arms and runs retention GC", async () => {
    const { do_, getAlarm } = makeDoInstance()
    const nowIso = new Date().toISOString()
    const old = new Date(new Date(nowIso).getTime() - 40 * 86_400_000).toISOString()
    await do_.recordManifest({ ...base, occurredAt: old, tools: [tool({})] })
    await do_.recordManifest({ ...base, occurredAt: nowIso, tools: [tool({ toolId: "ruff" })] })
    expect(getAlarm()).not.toBeNull()

    await do_.alarm()
    const out = await do_.query({ windowDays: 30, nowIso })
    expect(out.tools.map((t) => t.toolId)).toEqual(["ruff"])
    expect(out.latestByRepo.some((row) => row.toolId === "eslint")).toBe(false)
  })
})
