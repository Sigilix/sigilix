// SIG-184 PR 2 — RunnerReceiptDO: atomic single-use claim (accepted / duplicate
// / conflict), run_attempt distinguishing legit re-runs, and retention GC.
// Same harness as the ValidationMetricsDO tests (real in-memory node:sqlite).

import { describe, expect, it } from "vitest"
import { RunnerReceiptDO } from "../src/do/runner-receipt"
import type { Env } from "../src/index"
import { NodeSqliteStorage } from "./_shims/cloudflare-workers-shim"

function makeDo(): RunnerReceiptDO {
  const sqlStorage = new NodeSqliteStorage()
  let alarmAt: number | null = null
  const state = {
    storage: {
      sql: sqlStorage,
      transactionSync<T>(fn: () => T): T { return sqlStorage.transactionSync(fn) },
      async get(): Promise<unknown> { return undefined },
      async put(): Promise<void> { /* no-op */ },
      async delete(): Promise<boolean> { return false },
      async setAlarm(t: number): Promise<void> { alarmAt = t },
      async getAlarm(): Promise<number | null> { return alarmAt },
      async deleteAlarm(): Promise<void> { alarmAt = null },
    },
    id: { toString: () => "repo:424242", name: "repo:424242" },
  }
  return new RunnerReceiptDO(state as unknown as DurableObjectState, {} as Env)
}

const base = {
  repositoryId: "424242",
  sha: "deadbeef",
  pullNumber: 7,
  runId: "100",
  runAttempt: "1",
  sarifSha256: "hash-A",
  scrubbedSha256: "scrub-A",
  repository: "Sigilix/sigilix",
  jobWorkflowRef: "sigilix/runner/.github/workflows/scan.yml@v1",
  runnerEnvironment: "github-hosted",
}

describe("RunnerReceiptDO.claimReceipt", () => {
  it("first claim is accepted and stored", async () => {
    const d = makeDo()
    expect(await d.claimReceipt(base)).toEqual({ outcome: "accepted" })
    expect(await d.debugGet("424242", "deadbeef", "100", "1")).toMatchObject({ sarifSha256: "hash-A" })
  })

  it("same key + same hash is an idempotent duplicate", async () => {
    const d = makeDo()
    await d.claimReceipt(base)
    expect(await d.claimReceipt(base)).toEqual({ outcome: "duplicate" })
  })

  it("same key + DIFFERENT hash is a conflict — and does NOT overwrite", async () => {
    const d = makeDo()
    await d.claimReceipt(base)
    expect(await d.claimReceipt({ ...base, sarifSha256: "hash-B" })).toEqual({
      outcome: "conflict",
      existingSarifSha256: "hash-A",
    })
    expect(await d.debugGet("424242", "deadbeef", "100", "1")).toMatchObject({ sarifSha256: "hash-A" })
  })

  it("a re-run (incremented run_attempt) is a NEW accepted receipt", async () => {
    const d = makeDo()
    await d.claimReceipt(base)
    expect(await d.claimReceipt({ ...base, runAttempt: "2", sarifSha256: "hash-B" })).toEqual({ outcome: "accepted" })
  })

  it("different sha / run_id are independent claims", async () => {
    const d = makeDo()
    await d.claimReceipt(base)
    expect(await d.claimReceipt({ ...base, sha: "feedface" })).toEqual({ outcome: "accepted" })
    expect(await d.claimReceipt({ ...base, runId: "200" })).toEqual({ outcome: "accepted" })
  })

  it("arms a retention GC alarm after the first claim (so receipts can't leak forever)", async () => {
    const sqlStorage = new NodeSqliteStorage()
    let alarmAt: number | null = null
    const state = {
      storage: {
        sql: sqlStorage,
        transactionSync<T>(fn: () => T): T { return sqlStorage.transactionSync(fn) },
        async get(): Promise<unknown> { return undefined },
        async put(): Promise<void> { /* no-op */ },
        async delete(): Promise<boolean> { return false },
        async setAlarm(t: number): Promise<void> { alarmAt = t },
        async getAlarm(): Promise<number | null> { return alarmAt },
        async deleteAlarm(): Promise<void> { alarmAt = null },
      },
      id: { toString: () => "x", name: "x" },
    }
    const d = new RunnerReceiptDO(state as unknown as DurableObjectState, {} as Env)
    expect(alarmAt).toBeNull()
    await d.claimReceipt(base)
    expect(alarmAt).not.toBeNull()
  })

  it("alarm GC drops receipts older than the retention window", async () => {
    const d = makeDo()
    await d.claimReceipt({ ...base, ingestedAtMs: Date.now() - 8 * 86_400_000 }) // 8 days old
    await d.claimReceipt({ ...base, runId: "fresh", ingestedAtMs: Date.now() }) // recent
    await d.alarm()
    expect(await d.debugGet("424242", "deadbeef", "100", "1")).toBeNull()
    expect(await d.debugGet("424242", "deadbeef", "fresh", "1")).not.toBeNull()
  })
})

describe("RunnerReceiptDO.queryReceiptByPull (review join)", () => {
  it("returns the receipt for a (repository_id, pull_number) review join", async () => {
    const d = makeDo()
    await d.claimReceipt(base)
    expect(await d.queryReceiptByPull("424242", 7)).toMatchObject({
      sha: "deadbeef", pullNumber: 7, runId: "100", runAttempt: "1",
      sarifSha256: "hash-A", scrubbedSha256: "scrub-A", repository: "Sigilix/sigilix",
    })
  })

  it("returns null for a non-matching PR number, a non-PR (pull 0), and a different repo", async () => {
    const d = makeDo()
    await d.claimReceipt(base)
    expect(await d.queryReceiptByPull("424242", 999)).toBeNull()
    expect(await d.queryReceiptByPull("424242", 0)).toBeNull() // non-PR run never joins
    // a fork's receipt (different repository_id) must NOT bind to another repo's review.
    expect(await d.queryReceiptByPull("999999", 7)).toBeNull()
  })

  it("returns the MOST RECENT receipt by ingested_at (a re-run supersedes)", async () => {
    const d = makeDo()
    await d.claimReceipt({ ...base, runAttempt: "1", sha: "merge-old", sarifSha256: "hash-A", scrubbedSha256: "scrub-A", ingestedAtMs: 1000 })
    await d.claimReceipt({ ...base, runAttempt: "2", sha: "merge-new", sarifSha256: "hash-B", scrubbedSha256: "scrub-B", ingestedAtMs: 2000 })
    expect(await d.queryReceiptByPull("424242", 7)).toMatchObject({ runAttempt: "2", sha: "merge-new", sarifSha256: "hash-B" })
  })
})
