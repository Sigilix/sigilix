// SIG-369: every specialist's per-attempt cap = the role wall (SPECIALIST_TIMEOUT_MS),
// so the absolute role-wall AbortSignal applied at fan-out (specialists.ts) is the SOLE
// limiter on each role's wall-clock.
//
// This replaces the SIG-287/SIG-449 model where each role had a SUB-wall per-attempt cap
// (120s logic / 90s fast roles / 160s tests) and the test asserted the retry CHAIN
// (Σ caps + backoff) fit the wall. With cap = wall that chain-sum no longer applies: a
// single deep pass can consume the FULL wall; a fast-fail retry only gets the REMAINING
// wall time (the signal is absolute from role start), so total per role is still bounded
// by SPECIALIST_TIMEOUT_MS regardless of retry count.
//
// Why: the old 120s logic cap (a SIG-449 regression) killed Kimi's deep reasoning pass
// mid-generation — uncapped, Kimi hit 203s deep passes at 97% recall, and the cap was
// dropping P0s like `missing-await-auth` (caught ONLY on a 203s pass; the 41s shallow
// pass missed). Codex + DeepSeek signed off the timing + budget math.

import { describe, expect, it } from "vitest"
import { SPECIALIST_CONFIGS, SPECIALIST_TIMEOUT_MS, PER_ATTEMPT_TIMEOUT_MS } from "@/src/lib/triage-pr-review-ensemble"

const ROLES = ["logic", "security", "performance", "tests"] as const

describe("SIG-369 — per-attempt cap = the role wall (all-roles uncap)", () => {
  it("sets every specialist's per-attempt cap to SPECIALIST_TIMEOUT_MS (the role wall)", () => {
    // cap = wall → the role-wall AbortSignal is the sole limiter. Reverting any role to a
    // sub-wall cap (the old 120s/90s/160s) re-introduces the mid-generation clip and fails here.
    for (const role of ROLES) {
      expect(SPECIALIST_CONFIGS[role].perAttemptTimeoutMs).toBe(SPECIALIST_TIMEOUT_MS)
    }
  })

  it("keeps every per-attempt cap above the 60s global default (no role is artificially clipped)", () => {
    for (const role of ROLES) {
      expect(SPECIALIST_CONFIGS[role].perAttemptTimeoutMs!).toBeGreaterThan(PER_ATTEMPT_TIMEOUT_MS)
    }
  })

  it("never lets a per-attempt cap EXCEED the role wall — the absolute signal bounds total role time", () => {
    // cap === wall (not >): a single attempt can use the full wall but never more, and the
    // AbortSignal.timeout(SPECIALIST_TIMEOUT_MS) applied at fan-out (specialists.ts) caps TOTAL
    // role wall-clock — so retries only consume time when an earlier attempt fails fast, and a
    // wall-length pass simply leaves no time for them. Total per role stays ≤ SPECIALIST_TIMEOUT_MS.
    for (const role of ROLES) {
      expect(SPECIALIST_CONFIGS[role].perAttemptTimeoutMs!).toBeLessThanOrEqual(SPECIALIST_TIMEOUT_MS)
    }
  })

  it("preserves the per-role retry counts (retries = fast-fail recovery, not extra wall-clock); only security carries a fallback (SIG-468)", () => {
    expect(SPECIALIST_CONFIGS.logic.retries).toBe(2)
    expect(SPECIALIST_CONFIGS.security.retries).toBe(2)
    expect(SPECIALIST_CONFIGS.performance.retries).toBe(2)
    expect(SPECIALIST_CONFIGS.tests.retries).toBe(1)
    // SIG-468: security gained a v4-pro fallback to recover parse-exhaustion (it shares the role
    // wall, so it adds no extra wall-clock); every other role stays fallback:null (OpenRouter
    // self-routes their attempts across upstreams).
    for (const role of ROLES) {
      if (role === "security") {
        expect(SPECIALIST_CONFIGS[role].fallback).toBe("deepseek/deepseek-v4-pro")
      } else {
        expect(SPECIALIST_CONFIGS[role].fallback).toBeNull()
      }
    }
  })
})
