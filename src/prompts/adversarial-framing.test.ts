// SIG-452: adversarial-framing prompt-block unit tests.

import { describe, it, expect } from "vitest"
import {
  ADVERSARIAL_FRAMING_PROMPT_VERSION,
  renderAdversarialFramingLogicBlock,
  renderAdversarialFramingSynthBlock,
} from "@/src/prompts/adversarial-framing"
import type { RemovedGuardingTest } from "@/src/lib/removed-guarding-tests"

const SIGNAL: RemovedGuardingTest[] = [
  {
    testPath: "src/lib/order.test.ts",
    removedAssertionHint: "expect(resolveTimestamp(order)).toBe(order.created_at)",
    coveredSource: "src/lib/order.ts",
    coveredSymbol: "resolveTimestamp",
    correlationStrength: "symbol",
  },
]

describe("renderAdversarialFramingLogicBlock", () => {
  it("returns empty string for no signals (off/shadow → byte-identical)", () => {
    expect(renderAdversarialFramingLogicBlock([])).toBe("")
  })

  it("renders the inverted-inference rule + grounded citation + FLAG/SKIP calibration", () => {
    const block = renderAdversarialFramingLogicBlock(SIGNAL)
    expect(block).toContain("REMOVED GUARDING TESTS")
    // The grounded, cited pointer (testPath + symbol + source + the removed assertion).
    expect(block).toContain("src/lib/order.test.ts")
    expect(block).toContain("resolveTimestamp")
    expect(block).toContain("src/lib/order.ts")
    expect(block).toContain("expect(resolveTimestamp(order)).toBe(order.created_at)")
    // The inverted inference: removed coverage is a red flag, NOT intent.
    expect(block).toContain("NOT presumptively intentional")
    expect(block).toMatch(/RED FLAG/)
    // Carries both a FLAG and a SKIP calibration example.
    expect(block).toContain("FLAG:")
    expect(block).toContain("SKIP:")
    // Instructs grounded emission at >= P2 (score >= 4 ask-to-confirm).
    expect(block).toMatch(/score >= 4/)
  })
})

describe("renderAdversarialFramingSynthBlock", () => {
  it("returns empty string for no signals (off/shadow → byte-identical)", () => {
    expect(renderAdversarialFramingSynthBlock([])).toBe("")
  })

  it("renders the no-wave-through keep-rule + preserves the hallucination guard", () => {
    const block = renderAdversarialFramingSynthBlock(SIGNAL)
    expect(block).toContain("KEEP RULE")
    expect(block).toContain("resolveTimestamp")
    expect(block).toMatch(/MUST NOT dismiss/)
    expect(block).toContain("intentional contract change")
    // It must NOT instruct the synth to invent findings — the hallucination guard
    // still applies (Codex #3: synth needs the keep-rule, not a fabrication license).
    expect(block).toMatch(/do not create new findings|does not create new findings|do NOT.*INVENT/i)
  })
})

describe("ADVERSARIAL_FRAMING_PROMPT_VERSION", () => {
  it("is a non-empty version string for telemetry auditability", () => {
    expect(typeof ADVERSARIAL_FRAMING_PROMPT_VERSION).toBe("string")
    expect(ADVERSARIAL_FRAMING_PROMPT_VERSION.length).toBeGreaterThan(0)
  })
})
