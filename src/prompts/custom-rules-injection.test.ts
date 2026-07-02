// Config-as-code — verify the REPO RULES block lands in the specialist user
// message alongside the other repo/context guidance sources (mirroring how
// `sdkGuidanceBlock` is placed — see sdk-guidance-injection.test.ts), and that
// it renders ONLY when supplied (the off contract: assemble-prompts passes ""
// when OPENCLAW_CONFIG_AS_CODE_MODE is off, so `buildSpecialistInitialMessage`
// must not emit anything for an empty block). Also pins ordering: the custom
// rules block renders AFTER the SDK guidance block and BEFORE the profile.

import { describe, expect, it } from "vitest"

import { buildSpecialistInitialMessage } from "@/src/prompts/pr-review-specialists"

function buildPrompt(args: {
  customRulesBlock?: string
  sdkGuidanceBlock?: string
  profile?: "chill" | "assertive"
}): string {
  return buildSpecialistInitialMessage({
    prNumber: 42,
    title: "Test PR",
    body: "Body.",
    diff: "diff --git a/x b/x\n",
    retrievalSnapshot: "(empty)",
    namespace: "owner/repo",
    ...(args.customRulesBlock ? { customRulesBlock: args.customRulesBlock } : {}),
    ...(args.sdkGuidanceBlock ? { sdkGuidanceBlock: args.sdkGuidanceBlock } : {}),
    ...(args.profile ? { profile: args.profile } : {}),
  })
}

describe("buildSpecialistInitialMessage — custom rules placement", () => {
  it("emits no REPO RULES section when the block is absent", () => {
    const prompt = buildPrompt({})
    expect(prompt).not.toContain("REPO RULES")
  })

  it("emits no REPO RULES section when the block is an empty string (off mode)", () => {
    const prompt = buildPrompt({ customRulesBlock: "" })
    expect(prompt).not.toContain("REPO RULES")
  })

  it("renders the supplied custom rules block into the user message", () => {
    const block = "[REPO RULES (from sigilix.json custom rules)]\nsome rule"
    const prompt = buildPrompt({ customRulesBlock: block })
    expect(prompt).toContain(block)
  })

  it("places the custom rules block BEFORE the diff", () => {
    const block = "[REPO RULES — placement marker]"
    const prompt = buildPrompt({ customRulesBlock: block })
    const idxBlock = prompt.indexOf(block)
    const idxDiff = prompt.indexOf("[DIFF]")
    expect(idxBlock).toBeGreaterThan(-1)
    expect(idxDiff).toBeGreaterThan(idxBlock)
  })

  it("renders AFTER the SDK guidance block and BEFORE the profile directive", () => {
    const sdk = "## SDK guidance — marker"
    const rules = "[REPO RULES — marker]"
    const prompt = buildPrompt({ sdkGuidanceBlock: sdk, customRulesBlock: rules, profile: "chill" })
    expect(prompt.indexOf(sdk)).toBeLessThan(prompt.indexOf(rules))
    expect(prompt.indexOf(rules)).toBeLessThan(prompt.indexOf("[REVIEW PROFILE"))
  })
})
