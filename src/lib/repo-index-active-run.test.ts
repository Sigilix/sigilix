import { describe, expect, it, vi } from "vitest"
import {
  activeRunKey,
  writeActiveRun,
  readActiveRunId,
  shouldFinalize,
} from "@/src/lib/repo-index-active-run"

function kvMock(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    OPENCLAW_STATE: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
      delete: vi.fn(async (k: string) => { store.delete(k) }),
    },
  } as any
}

describe("activeRunKey", () => {
  it("keys by lowercased owner/repo namespace", () => {
    expect(activeRunKey("Sigilix", "Sigilix")).toBe("repo-index-active-run:sigilix/sigilix")
  })
})

describe("writeActiveRun / readActiveRunId", () => {
  it("round-trips the runId", async () => {
    const env = kvMock()
    await writeActiveRun(env, "o", "r", "run-1")
    expect(await readActiveRunId(env, "o", "r")).toBe("run-1")
  })
  it("readActiveRunId returns null on missing / invalid JSON / wrong version", async () => {
    expect(await readActiveRunId(kvMock(), "o", "r")).toBeNull()
    expect(await readActiveRunId(kvMock({ "repo-index-active-run:o/r": "not json" }), "o", "r")).toBeNull()
    expect(await readActiveRunId(kvMock({ "repo-index-active-run:o/r": JSON.stringify({ v: 2, runId: "x" }) }), "o", "r")).toBeNull()
  })
  it("readActiveRunId returns null on array / non-object primitive / empty or non-string runId", async () => {
    expect(await readActiveRunId(kvMock({ "repo-index-active-run:o/r": JSON.stringify(["x"]) }), "o", "r")).toBeNull()
    expect(await readActiveRunId(kvMock({ "repo-index-active-run:o/r": JSON.stringify(5) }), "o", "r")).toBeNull()
    expect(await readActiveRunId(kvMock({ "repo-index-active-run:o/r": JSON.stringify({ v: 1, runId: "" }) }), "o", "r")).toBeNull()
    expect(await readActiveRunId(kvMock({ "repo-index-active-run:o/r": JSON.stringify({ v: 1, runId: 7 }) }), "o", "r")).toBeNull()
  })
  it("writeActiveRun THROWS on KV put failure (so the caller can retry)", async () => {
    const env = kvMock()
    env.OPENCLAW_STATE.put = vi.fn(async () => { throw new Error("kv down") })
    await expect(writeActiveRun(env, "o", "r", "run-1")).rejects.toThrow()
  })
})

describe("shouldFinalize", () => {
  it("true when the lease is absent or equals this run; false when another run owns it", () => {
    expect(shouldFinalize(null, "run-1")).toBe(true)
    expect(shouldFinalize("run-1", "run-1")).toBe(true)
    expect(shouldFinalize("run-2", "run-1")).toBe(false)
  })
})
