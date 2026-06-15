// SIG-369(b) — second-pass reasoner override: pure decision tests. Pins the
// flag normalization (default off; only literal "on" enables) and the override
// shape (off → undefined = byte-identical o3 path; on → v4-pro primary with
// every other ModelConfig knob preserved).

import { describe, expect, it } from "vitest"
import {
  SECONDPASS_REASONER_MODEL,
  parseSecondPassReasonerMode,
  secondPassReasonerOverride,
} from "@/src/lib/ensemble/domain/secondpass-reasoner"
import type { ModelConfig } from "@/src/lib/ensemble/domain/model-policy"

// The shipped logic role config shape (openai/o3): the base the second passes
// override against. Mirrors SPECIALIST_CONFIGS.logic so the test pins the real
// preservation behavior, not a toy.
const LOGIC_BASE: ModelConfig = {
  primary: "openai/o3",
  retries: 1,
  fallback: null,
  perAttemptTimeoutMs: 120_000,
}

describe("parseSecondPassReasonerMode", () => {
  it("defaults off for unset / empty / unknown", () => {
    expect(parseSecondPassReasonerMode(undefined)).toBe("off")
    expect(parseSecondPassReasonerMode("")).toBe("off")
    expect(parseSecondPassReasonerMode("bogus")).toBe("off")
    // Deliberately NOT a tri-state: "shadow" is not a second-pass concept (the
    // phases own their own shadow/on contract), so anything other than "on"
    // is off.
    expect(parseSecondPassReasonerMode("shadow")).toBe("off")
  })

  it('enables only on the literal "on" (trimmed + case-insensitive)', () => {
    expect(parseSecondPassReasonerMode("on")).toBe("on")
    expect(parseSecondPassReasonerMode(" ON ")).toBe("on")
    expect(parseSecondPassReasonerMode("On")).toBe("on")
  })
})

describe("secondPassReasonerOverride", () => {
  it("off → undefined (no override; caller uses SPECIALIST_CONFIGS[role] — byte-identical)", () => {
    expect(secondPassReasonerOverride({ mode: "off", baseConfig: LOGIC_BASE })).toBeUndefined()
  })

  it("on → v4-pro primary, every other knob preserved from the base config", () => {
    const override = secondPassReasonerOverride({ mode: "on", baseConfig: LOGIC_BASE })
    expect(override).toEqual({
      primary: SECONDPASS_REASONER_MODEL,
      retries: 1,
      fallback: null,
      perAttemptTimeoutMs: 120_000,
    })
    expect(SECONDPASS_REASONER_MODEL).toBe("deepseek/deepseek-v4-pro")
  })

  it("on → does NOT mutate the base config (pure)", () => {
    const base: ModelConfig = { primary: "openai/o3", retries: 1, fallback: null, perAttemptTimeoutMs: 120_000 }
    const snapshot = { ...base }
    secondPassReasonerOverride({ mode: "on", baseConfig: base })
    expect(base).toEqual(snapshot)
  })

  it("on → preserves a base WITHOUT perAttemptTimeoutMs (e.g. a non-logic role config)", () => {
    const base: ModelConfig = { primary: "z-ai/glm-5.1", retries: 1, fallback: null }
    expect(secondPassReasonerOverride({ mode: "on", baseConfig: base })).toEqual({
      primary: SECONDPASS_REASONER_MODEL,
      retries: 1,
      fallback: null,
    })
  })
})
