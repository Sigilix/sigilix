// SIG-145 (stop/cancel): linear-agent-cancel marker tests.
//
// Coverage:
//   (a) mark writes the per-session marker with the 1h TTL
//   (b) isAgentSessionCancelled → true when the marker is present
//   (c) isAgentSessionCancelled → false when absent
//   (d) isAgentSessionCancelled FAILS OPEN (false) + logs on a KV fault
//   (e) empty/blank sessionId is a no-op (mark) / false (probe)

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import {
  markAgentSessionCancelled,
  isAgentSessionCancelled,
  clearAgentSessionCancelled,
  AGENT_CANCEL_KV_PREFIX,
  AGENT_CANCEL_TTL_SECONDS,
} from "@/src/lib/linear-agent-cancel"
import type { Env } from "@/src/shared/types/env"

const SESSION_ID = "agent-session-1"
const KEY = `${AGENT_CANCEL_KV_PREFIX}:${SESSION_ID}`

function makeEnv(overrides?: { get?: unknown; put?: unknown; del?: unknown }): {
  env: Pick<Env, "OPENCLAW_STATE">
  get: any
  put: any
  del: any
} {
  const store = new Map<string, string>()
  const put = vi.fn((k: string, v: string) => {
    store.set(k, v)
    return Promise.resolve(undefined)
  })
  const get = vi.fn((k: string) => Promise.resolve(store.get(k) ?? null))
  const del = vi.fn((k: string) => {
    store.delete(k)
    return Promise.resolve(undefined)
  })
  const kv = {
    put: (overrides?.put as typeof put) ?? put,
    get: (overrides?.get as typeof get) ?? get,
    delete: (overrides?.del as typeof del) ?? del,
    store,
  }
  return { env: { OPENCLAW_STATE: kv as unknown as KVNamespace }, get: kv.get, put: kv.put, del: kv.delete }
}

describe("linear-agent-cancel", () => {
  let spyWarn: MockInstance

  beforeEach(() => {
    spyWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })
  afterEach(() => {
    spyWarn.mockRestore()
  })

  it("(a) mark writes the per-session marker with the 1h TTL", async () => {
    const { env, put } = makeEnv()
    await markAgentSessionCancelled(env, SESSION_ID)
    expect(put).toHaveBeenCalledWith(KEY, "1", { expirationTtl: AGENT_CANCEL_TTL_SECONDS })
    expect(AGENT_CANCEL_TTL_SECONDS).toBe(3600)
  })

  it("(b) isAgentSessionCancelled → true when marked", async () => {
    const { env } = makeEnv()
    await markAgentSessionCancelled(env, SESSION_ID)
    await expect(isAgentSessionCancelled(env, SESSION_ID)).resolves.toBe(true)
  })

  it("(c) isAgentSessionCancelled → false when absent", async () => {
    const { env } = makeEnv()
    await expect(isAgentSessionCancelled(env, SESSION_ID)).resolves.toBe(false)
  })

  it("(d) isAgentSessionCancelled FAILS OPEN (false) + logs on a KV fault", async () => {
    const { env } = makeEnv({
      get: vi.fn(() => Promise.reject(new Error("KV unavailable"))),
    })
    await expect(isAgentSessionCancelled(env, SESSION_ID)).resolves.toBe(false)
    expect(spyWarn.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-cancel-read-failed")
  })

  it("(e) blank sessionId is a no-op (mark) / false (probe)", async () => {
    const { env, put } = makeEnv()
    await markAgentSessionCancelled(env, "   ")
    expect(put).not.toHaveBeenCalled()
    await expect(isAgentSessionCancelled(env, "")).resolves.toBe(false)
  })

  it("(f) clear deletes the marker so a re-prompt on the same session is not cancelled", async () => {
    const { env, del } = makeEnv()
    await markAgentSessionCancelled(env, SESSION_ID)
    await expect(isAgentSessionCancelled(env, SESSION_ID)).resolves.toBe(true)

    await clearAgentSessionCancelled(env, SESSION_ID)
    expect(del).toHaveBeenCalledWith(KEY)
    await expect(isAgentSessionCancelled(env, SESSION_ID)).resolves.toBe(false)
  })

  it("(g) clear FAILS SOFT (swallows + logs) on a KV fault; blank sessionId is a no-op", async () => {
    const { env, del } = makeEnv({ del: vi.fn(() => Promise.reject(new Error("KV down"))) })
    await expect(clearAgentSessionCancelled(env, SESSION_ID)).resolves.toBeUndefined()
    expect(spyWarn.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-cancel-clear-failed")

    del.mockClear()
    await clearAgentSessionCancelled(env, "  ")
    expect(del).not.toHaveBeenCalled()
  })
})
