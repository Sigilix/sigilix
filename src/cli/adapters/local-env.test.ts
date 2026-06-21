// SIG-304 Phase 0 — CI coverage for the headless `Env` factory. (The full dry-run
// orchestrator path is proven by the live test e2e/run-review-in-node.live.test.ts,
// which SKIPs in CI; a mocked-chat integration test is a documented fast-follow.)

import { describe, it, expect } from "vitest"
import { createLocalEnv } from "./local-env"

describe("createLocalEnv — headless Env factory", () => {
  it("provides a working in-memory KV (put/get/delete round-trip)", async () => {
    const env = createLocalEnv({ processEnv: {} })
    await env.OPENCLAW_STATE.put("k", "v")
    expect(await env.OPENCLAW_STATE.get("k")).toBe("v")
    await env.OPENCLAW_STATE.delete("k")
    expect(await env.OPENCLAW_STATE.get("k")).toBeNull()
  })

  it("shares a caller-supplied KV store (so a JSON-backed Map can persist across runs)", async () => {
    const store = new Map<string, string>()
    const env = createLocalEnv({ processEnv: {}, kvStore: store })
    await env.OPENCLAW_STATE.put("x", "1")
    expect(store.get("x")).toBe("1")
  })

  it("DO stub answers fetch with 200 AND any RPC method with an async no-op (never throws)", async () => {
    const env = createLocalEnv({ processEnv: {} })
    const stub = env.PR_REVIEW_RUN.get(env.PR_REVIEW_RUN.idFromName("any"))
    const res = await stub.fetch("https://do/")
    expect(res.status).toBe(200)
    // An RPC-style method the engine's metrics clients call — must not throw (MINOR-1).
    const rpc = stub as unknown as { recordBatch: (items: unknown[]) => Promise<unknown> }
    await expect(rpc.recordBatch([{ a: 1 }])).resolves.toBeUndefined()
  })

  it("surfaces secrets/model keys from processEnv (BYO models) and leaves ensemble flags unset", () => {
    const env = createLocalEnv({ processEnv: { OPENROUTER_API_KEY: "or-key", OLLAMA_CHAT_ENABLE: "on" } })
    expect(env.OPENROUTER_API_KEY).toBe("or-key")
    expect(env.OLLAMA_CHAT_ENABLE).toBe("on")
    // Flags not provided default to undefined → parseEnsembleConfig yields all-default.
    expect(env.OPENCLAW_REVIEW_MULTIBATCH_MODE).toBeUndefined()
  })
})
