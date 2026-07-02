// SIG-298 follow-on — verify the SDK guidance block lands in the specialist
// user message alongside the other repo/context guidance sources (mirroring
// how `learningsBlock` is placed — see scoped-rules-injection.test.ts /
// learnings for the same pattern), and that it renders ONLY when supplied
// (the off/shadow contract: assemble-prompts passes "" in those modes, so
// `buildSpecialistInitialMessage` must not emit anything for an empty block).

import { describe, expect, it } from "vitest"

import { buildSpecialistInitialMessage } from "@/src/prompts/pr-review-specialists"

function buildPrompt(args: { sdkGuidanceBlock?: string; learningsBlock?: string }): string {
  return buildSpecialistInitialMessage({
    prNumber: 42,
    title: "Test PR",
    body: "Body.",
    diff: "diff --git a/x b/x\n",
    retrievalSnapshot: "(empty)",
    namespace: "owner/repo",
    ...(args.sdkGuidanceBlock ? { sdkGuidanceBlock: args.sdkGuidanceBlock } : {}),
    ...(args.learningsBlock ? { learningsBlock: args.learningsBlock } : {}),
  })
}

describe("buildSpecialistInitialMessage — SDK guidance placement", () => {
  it("emits no SDK guidance section when the block is absent", () => {
    const prompt = buildPrompt({})
    expect(prompt).not.toContain("SDK guidance")
  })

  it("emits no SDK guidance section when the block is an empty string (off/shadow mode)", () => {
    const prompt = buildPrompt({ sdkGuidanceBlock: "" })
    expect(prompt).not.toContain("SDK guidance")
  })

  it("renders the supplied SDK guidance block into the user message", () => {
    const block = "## SDK guidance (self-authored from public docs — not a partner endorsement)\nsome rule"
    const prompt = buildPrompt({ sdkGuidanceBlock: block })
    expect(prompt).toContain(block)
  })

  it("places the SDK guidance block BEFORE the diff", () => {
    const block = "## SDK guidance — placement marker"
    const prompt = buildPrompt({ sdkGuidanceBlock: block })
    const idxBlock = prompt.indexOf(block)
    const idxDiff = prompt.indexOf("[DIFF]")
    expect(idxBlock).toBeGreaterThan(-1)
    expect(idxDiff).toBeGreaterThan(idxBlock)
  })

  it("renders alongside learningsBlock — both repo/context guidance sources are additive", () => {
    const sdk = "## SDK guidance — marker"
    const learnings = "## Repository-specific guidance (learned from past reviews)\n- rule"
    const prompt = buildPrompt({ sdkGuidanceBlock: sdk, learningsBlock: learnings })
    expect(prompt).toContain(sdk)
    expect(prompt).toContain(learnings)
    // learnings renders first (it's the pre-existing, higher-precedent block).
    expect(prompt.indexOf(learnings)).toBeLessThan(prompt.indexOf(sdk))
  })
})
