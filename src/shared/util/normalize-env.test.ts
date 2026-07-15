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

  it("mirrors a SIGILIX_-only var back to the OPENCLAW_ name (config renamed ahead of readers)", () => {
    // This is the config-first rename case: a [vars] key renamed OPENCLAW_ → SIGILIX_
    // while the ~1,600 call sites still read env.OPENCLAW_X. The bidirectional mirror
    // fills the OPENCLAW_ sibling from the SIGILIX_ value so those readers keep working.
    const out = rec(asEnv({ SIGILIX_ENTITLEMENTS_MODE: "enforce" }))
    expect(out.SIGILIX_ENTITLEMENTS_MODE).toBe("enforce")
    expect(out.OPENCLAW_ENTITLEMENTS_MODE).toBe("enforce")
  })

  it("mirrors the canonical Slack memory-scope rollout var to its legacy reader", () => {
    const out = rec(asEnv({ SIGILIX_SLACK_MEMORY_SCOPE_MODE: "shadow" }))
    expect(out.SIGILIX_SLACK_MEMORY_SCOPE_MODE).toBe("shadow")
    expect(out.OPENCLAW_SLACK_MEMORY_SCOPE_MODE).toBe("shadow")
  })

  it("mirrors a SIGILIX-native var's (unread) OPENCLAW_ sibling — harmless, nothing reads it", () => {
    const out = rec(asEnv({ SIGILIX_FAIRNESS_MODE: "enforce" }))
    expect(out.SIGILIX_FAIRNESS_MODE).toBe("enforce")
    // The reverse mirror fills OPENCLAW_FAIRNESS_MODE from the live SIGILIX_ value. No
    // code reads that legacy name and no code branches on env-key presence, so this is
    // inert; the mirror stays uniform rather than maintaining an exception list.
    expect(out.OPENCLAW_FAIRNESS_MODE).toBe("enforce")
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
