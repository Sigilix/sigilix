import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"
import { stageRepoActiveIndexSlice } from "@/src/lib/repo-active-index"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"

const { enqueueDueSeatWork } = vi.hoisted(() => ({
  enqueueDueSeatWork: vi.fn(async () => undefined),
}))

vi.mock("@/src/features/billing", () => ({
  enqueueDueSeatWork,
  handleStripeWebhookRoute: vi.fn(),
}))

import worker from "@/src/index"

function emptyKv(): KVNamespace {
  return {
    get: async () => null,
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    put: async () => undefined,
    delete: async () => undefined,
  } as unknown as KVNamespace
}

describe("scheduled — Stripe seat recovery", () => {
  beforeEach(() => {
    enqueueDueSeatWork.mockClear()
  })

  it("runs even when automatic repository indexing is disabled", async () => {
    const env = { OPENCLAW_STATE: emptyKv() } as unknown as Env
    const waits: Promise<unknown>[] = []
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        waits.push(promise)
      },
      passThroughOnException() {},
    } as unknown as ExecutionContext

    await worker.scheduled({} as ScheduledEvent, env, ctx)
    await Promise.all(waits)

    expect(enqueueDueSeatWork).toHaveBeenCalledOnce()
    expect(enqueueDueSeatWork).toHaveBeenCalledWith(expect.objectContaining({ OPENCLAW_STATE: env.OPENCLAW_STATE }))
  })

  it("sweeps expired active-index staging even when automatic indexing is disabled", async () => {
    const db = makeD1()
    await db.exec(
      readFileSync(new URL("../migrations/0025_create_repo_active_index_stage.sql", import.meta.url), "utf8"),
    )
    await stageRepoActiveIndexSlice({
      db,
      githubRepoId: 101,
      installationId: 99,
      runId: "a".repeat(16),
      totalFiles: 1,
      lo: 0,
      hi: 1,
      mode: "shadow",
      idsByPath: { "src/expired.ts": ["1".repeat(48)] },
      nowMs: 0,
    })
    await stageRepoActiveIndexSlice({
      db,
      githubRepoId: 202,
      installationId: 99,
      runId: "b".repeat(16),
      totalFiles: 1,
      lo: 0,
      hi: 1,
      mode: "shadow",
      idsByPath: { "src/current.ts": ["2".repeat(48)] },
    })
    const env = { OPENCLAW_STATE: emptyKv(), SIGILIX_PLATFORM_DB: db } as unknown as Env
    const waits: Promise<unknown>[] = []
    const ctx = { waitUntil: (promise: Promise<unknown>) => waits.push(promise) } as unknown as ExecutionContext

    await worker.scheduled({} as ScheduledEvent, env, ctx)
    await Promise.all(waits)

    const rows = await db.prepare("SELECT github_repo_id FROM repo_active_index_run").all<{ github_repo_id: number }>()
    expect(rows.results).toEqual([{ github_repo_id: 202 }])
  })
})
