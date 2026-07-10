// Event-log tests for AgentRunnerContainer — the live diff-pane stream. The
// security boundary here is the per-run secret gate on appendRunEventAuthed.

import { describe, it, expect } from "vitest"
import { AgentRunnerContainer, type RunEvent } from "@/src/do/agent-runner-container"
import type { Env } from "@/src/shared/types/env"

function makeDO(): AgentRunnerContainer {
  const store = new Map<string, unknown>()
  const ctx = {
    storage: {
      async get<T>(k: string): Promise<T | undefined> {
        return store.get(k) as T | undefined
      },
      async put<T>(k: string, v: T): Promise<void> {
        store.set(k, v)
      },
      async delete(k: string): Promise<boolean> {
        return store.delete(k)
      },
    },
    // Container's constructor touches these; a minimal shape is enough here.
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
  } as unknown as ConstructorParameters<typeof AgentRunnerContainer>[0]
  return new AgentRunnerContainer(ctx, {} as Env)
}

const edit: Omit<RunEvent, "seq"> = {
  ts: 1,
  type: "file-edit",
  path: "src/a.ts",
  patch: "@@ -1 +1 @@\n-old\n+new",
  additions: 1,
  deletions: 1,
}

describe("AgentRunnerContainer event log", () => {
  it("rejects an append when no secret was set", async () => {
    const runner = makeDO()
    expect(await runner.appendRunEventAuthed("anything", edit)).toEqual({ ok: false })
  })

  it("rejects an append when the secret does not match", async () => {
    const runner = makeDO()
    await runner.setRunEventSecret("correct-secret")
    expect(await runner.appendRunEventAuthed("wrong-secret", edit)).toEqual({ ok: false })
  })

  it("appends with a monotonic seq when the secret matches", async () => {
    const runner = makeDO()
    await runner.setRunEventSecret("s3cr3t")
    expect(await runner.appendRunEventAuthed("s3cr3t", edit)).toEqual({ ok: true, seq: 1 })
    expect(await runner.appendRunEventAuthed("s3cr3t", edit)).toEqual({ ok: true, seq: 2 })
  })

  it("getRunEvents returns only events after the cursor, plus the latest cursor", async () => {
    const runner = makeDO()
    await runner.setRunEventSecret("s3cr3t")
    await runner.appendRunEventAuthed("s3cr3t", { ...edit, path: "a.ts" })
    await runner.appendRunEventAuthed("s3cr3t", { ...edit, path: "b.ts" })
    await runner.appendRunEventAuthed("s3cr3t", { ...edit, path: "c.ts" })

    const all = await runner.getRunEvents(0)
    expect(all.cursor).toBe(3)
    expect(all.events.map((e) => e.path)).toEqual(["a.ts", "b.ts", "c.ts"])

    const after2 = await runner.getRunEvents(2)
    expect(after2.events.map((e) => e.path)).toEqual(["c.ts"])
    expect(after2.cursor).toBe(3)
  })
})
