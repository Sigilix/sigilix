// sig-free-tier-entitlements — CI-triage surface gate. Proves that in ENFORCE
// with an un-entitled installation, handleCiTriage clean-returns BEFORE touching
// KV (no dedupe write) or doing any GitHub/model work — and that with the flag
// OFF (default) the gate is a no-op (KV dedupe path is reached as before).

import { describe, expect, it, vi } from "vitest"
import { handleCiTriage } from "@/src/lib/triage-ci"
import type { Env } from "@/src/shared/types/env"

function makeKv(): { kv: KVNamespace; get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> } {
  const get = vi.fn(async () => null)
  const put = vi.fn(async () => {})
  const del = vi.fn(async () => {})
  return { kv: { get, put, delete: del } as unknown as KVNamespace, get, put }
}

function baseArgs(env: Env) {
  return { owner: "acme", repo: "app", prNumber: 3, runId: 55, headSha: "deadbeef", installationId: 12, env }
}

describe("handleCiTriage — entitlement gate", () => {
  it("enforce + un-entitled (no platform DB → fail-closed) → returns before any KV work", async () => {
    const { kv, get, put } = makeKv()
    const env = { OPENCLAW_STATE: kv, OPENCLAW_ENTITLEMENTS_MODE: "enforce" } as unknown as Env
    await handleCiTriage(baseArgs(env))
    // Gate is BEFORE the dedupe guard — neither read nor write happens.
    expect(get).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })

  it("off (default) → gate is a no-op, the dedupe guard is reached", async () => {
    const { kv, get } = makeKv()
    // No OPENCLAW_ENTITLEMENTS_MODE → off. No platform DB needed (off skips lookup).
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    // runCiTriage runs past the gate and then faults building a GitHub client
    // (no app creds in this unit env) — that's expected; we only assert the gate
    // did NOT short-circuit, i.e. the dedupe guard was reached.
    await handleCiTriage(baseArgs(env)).catch(() => {})
    expect(get).toHaveBeenCalledOnce()
  })
})
