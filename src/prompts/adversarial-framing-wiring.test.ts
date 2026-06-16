// SIG-452: adversarial-framing wiring + byte-identity + two-loci tests.
//
// These assert the production composition the orchestrator performs in
// `assemble-prompts.ts` / `synthesize.ts`: the enforce-gated block is appended to
// the LOGIC specialist message and the SYNTH message, and is empty (→ byte-
// identical output) in off/shadow. The two loci are exercised INDEPENDENTLY
// (Codex #3): the logic locus carries the EMIT rule; the synth locus carries the
// KEEP rule; each works on its own.

import { describe, it, expect } from "vitest"
import { buildSpecialistInitialMessage, buildSynthesizerInitialMessage } from "@/src/prompts/pr-review-specialists"
import {
  renderAdversarialFramingLogicBlock,
  renderAdversarialFramingSynthBlock,
} from "@/src/prompts/adversarial-framing"
import type { RemovedGuardingTest } from "@/src/lib/removed-guarding-tests"
import type { SpecialistRole } from "@/src/shared/domain/specialist-role"

const SIGNAL: RemovedGuardingTest[] = [
  {
    testPath: "src/lib/order.test.ts",
    removedAssertionHint: "expect(resolveTimestamp(order)).toBe(order.created_at)",
    coveredSource: "src/lib/order.ts",
    coveredSymbol: "resolveTimestamp",
    correlationStrength: "symbol",
  },
]

// Mirror of the production composition in assemble-prompts.ts `messageForRole`:
// the logic block is appended to the LOGIC role message only, when non-empty.
function composeSpecialistMessage(role: SpecialistRole, logicBlock: string): string {
  const base = buildSpecialistInitialMessage({
    prNumber: 1,
    title: "t",
    body: "b",
    diff: "[DIFF]\nsome diff",
    retrievalSnapshot: "",
    namespace: "ns",
  })
  return role === "logic" && logicBlock.length > 0 ? `${base}\n\n${logicBlock}` : base
}

// Mirror of the production composition in synthesize.ts:
function composeSynthMessage(synthBlock: string): string {
  const base = buildSynthesizerInitialMessage({
    prNumber: 1,
    diff: "[DIFF]\nsome diff",
    specialistVerdictsBlock: "=== LOGIC ===\n{}",
  })
  return synthBlock.length > 0 ? `${base}\n\n${synthBlock}` : base
}

describe("adversarial-framing byte-identity (off / shadow)", () => {
  // off + shadow both produce an EMPTY block (the wiring only constructs a
  // non-empty block in enforce). So the composed messages must equal the
  // no-block baseline byte-for-byte.
  const emptyLogicBlock = renderAdversarialFramingLogicBlock([]) // "" — off/shadow
  const emptySynthBlock = renderAdversarialFramingSynthBlock([]) // "" — off/shadow

  it("the empty (off/shadow) block is the empty string", () => {
    expect(emptyLogicBlock).toBe("")
    expect(emptySynthBlock).toBe("")
  })

  it("LOGIC specialist message is byte-identical with an empty block", () => {
    const baseline = composeSpecialistMessage("logic", "")
    const withEmpty = composeSpecialistMessage("logic", emptyLogicBlock)
    expect(withEmpty).toBe(baseline)
  })

  it("SYNTH message is byte-identical with an empty block", () => {
    const baseline = composeSynthMessage("")
    const withEmpty = composeSynthMessage(emptySynthBlock)
    expect(withEmpty).toBe(baseline)
  })

  it("non-logic specialist messages are unaffected even when a block exists (enforce)", () => {
    const logicBlock = renderAdversarialFramingLogicBlock(SIGNAL)
    expect(logicBlock.length).toBeGreaterThan(0)
    for (const role of ["security", "performance", "tests"] as SpecialistRole[]) {
      const baseline = composeSpecialistMessage(role, "")
      const withBlock = composeSpecialistMessage(role, logicBlock)
      expect(withBlock).toBe(baseline)
    }
  })
})

describe("adversarial-framing two loci (enforce) — independent", () => {
  it("LOGIC locus: the logic specialist message carries the EMIT rule + grounded signal", () => {
    const logicBlock = renderAdversarialFramingLogicBlock(SIGNAL)
    const message = composeSpecialistMessage("logic", logicBlock)
    expect(message).toContain("REMOVED GUARDING TESTS")
    expect(message).toContain("resolveTimestamp")
    expect(message).toContain("NOT presumptively intentional")
    // The logic block instructs EMISSION (the synth's hallucination guard needs a
    // specialist finding to retain).
    expect(message).toMatch(/EMIT a logic finding/)
  })

  it("SYNTH locus: the synth message carries the KEEP rule independently", () => {
    const synthBlock = renderAdversarialFramingSynthBlock(SIGNAL)
    const message = composeSynthMessage(synthBlock)
    expect(message).toContain("KEEP RULE")
    expect(message).toContain("resolveTimestamp")
    expect(message).toMatch(/MUST NOT dismiss/)
  })

  it("the two loci are distinct blocks (logic EMIT rule != synth KEEP rule)", () => {
    const logicBlock = renderAdversarialFramingLogicBlock(SIGNAL)
    const synthBlock = renderAdversarialFramingSynthBlock(SIGNAL)
    expect(logicBlock).toMatch(/EMIT a logic finding/)
    expect(logicBlock).not.toMatch(/KEEP RULE/)
    expect(synthBlock).toMatch(/KEEP RULE/)
    expect(synthBlock).not.toMatch(/EMIT a logic finding/)
  })
})
