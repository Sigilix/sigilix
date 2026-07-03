import { describe, expect, it } from "vitest"
import { normalizeEnv } from "@/src/shared/util/normalize-env"
import type { Env } from "@/src/shared/types/env"

// sig-worker-debrand-openclaw: the back-compat env shim. These tests pin the
// load-bearing safety contract — the deployed Worker must keep working whether
// Cloudflare holds a value under the legacy OPENCLAW_ name alone (today) or under both
// the OPENCLAW_ and the new SIGILIX_ name (the transition). The shim reads a loose
// string-keyed bag, so the tests build a minimal object and cast at the boundary
// (mirrors how the real `env` is a runtime bag).
function asEnv(bag: Record<string, unknown>): Env {
  return bag as unknown as Env
}

function rec(env: Env): Record<string, unknown> {
  return normalizeEnv(env) as unknown as Record<string, unknown>
}

describe("normalizeEnv", () => {
  it("byte-identical today: only the OPENCLAW_ name set → both names resolve to it, never throws", () => {
    // This is prod today: the SIGILIX_ secret is unset, the OPENCLAW_ one is live.
    const out = rec(asEnv({ OPENCLAW_PLAN: "team" }))
    expect(out.OPENCLAW_PLAN).toBe("team")
    expect(out.SIGILIX_PLAN).toBe("team")
  })

  it("SIGILIX_ override wins for the legacy reader when both are set", () => {
    const out = rec(asEnv({ SIGILIX_LEARNINGS_MODE: "on", OPENCLAW_LEARNINGS_MODE: "off" }))
    expect(out.OPENCLAW_LEARNINGS_MODE).toBe("on")
    expect(out.SIGILIX_LEARNINGS_MODE).toBe("on")
  })

  it("honors an intentional empty-string SIGILIX_ override (?? not ||)", () => {
    const out = rec(asEnv({ SIGILIX_BASE_URL: "", OPENCLAW_BASE_URL: "https://legacy.example" }))
    expect(out.OPENCLAW_BASE_URL).toBe("")
    expect(out.SIGILIX_BASE_URL).toBe("")
  })

  it("mirrors resource bindings — SIGILIX_ binding wins, OPENCLAW_ binding is the fallback", () => {
    const sigilixIndex = { id: "sigilix-binding" }
    const openclawIndex = { id: "openclaw-binding" }

    const bothSet = rec(asEnv({ SIGILIX_CODE_INDEX: sigilixIndex, OPENCLAW_CODE_INDEX: openclawIndex }))
    expect(bothSet.SIGILIX_CODE_INDEX).toBe(sigilixIndex)
    expect(bothSet.OPENCLAW_CODE_INDEX).toBe(sigilixIndex)

    // The live-prod case: only the legacy binding exists (the SIGILIX_ block is not
    // deployed yet). The SIGILIX_ name resolves to the legacy binding reference.
    const legacyOnly = rec(asEnv({ OPENCLAW_CODE_INDEX: openclawIndex }))
    expect(legacyOnly.OPENCLAW_CODE_INDEX).toBe(openclawIndex)
    expect(legacyOnly.SIGILIX_CODE_INDEX).toBe(openclawIndex)
  })

  it("leaves a SIGILIX-native var untouched and never invents an OPENCLAW_ sibling for it", () => {
    const out = rec(asEnv({ SIGILIX_FAIRNESS_MODE: "enforce" }))
    expect(out.SIGILIX_FAIRNESS_MODE).toBe("enforce")
    // Critical: no spurious OPENCLAW_FAIRNESS_MODE key (there is no legacy reader for it,
    // and inventing one changes the env shape passed downstream).
    expect("OPENCLAW_FAIRNESS_MODE" in out).toBe(false)
  })

  it("does not mutate the input env", () => {
    const input = asEnv({ OPENCLAW_ADMIN_TOKEN: "secret" })
    const before = { ...(input as unknown as Record<string, unknown>) }
    normalizeEnv(input)
    expect(input as unknown as Record<string, unknown>).toEqual(before)
    expect((input as unknown as Record<string, unknown>).SIGILIX_ADMIN_TOKEN).toBeUndefined()
  })

  it("does not invent a key for a pair where neither side has a value", () => {
    const out = rec(asEnv({ OPENCLAW_PLAN: undefined }))
    expect("SIGILIX_PLAN" in out).toBe(false)
  })

  it("leaves non-prefixed bindings/keys (AI, LINEAR_API_KEY, …) alone", () => {
    const ai = { embed: true }
    const out = rec(asEnv({ AI: ai, LINEAR_API_KEY: "k" }))
    expect(out.AI).toBe(ai)
    expect(out.LINEAR_API_KEY).toBe("k")
    expect("SIGILIX_API_KEY" in out).toBe(false)
  })
})
