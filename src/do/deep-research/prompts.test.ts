import { describe, it, expect } from "vitest"
import { buildDirectAnswerPrompt, buildRepoAnswerPrompt, buildFinalReportPrompt } from "./prompts"

// The three prompts that produce text shown to the user must instruct the model
// not to emit emojis. Guards against the rule being dropped from any of them.
describe("user-facing answer prompts forbid emojis", () => {
  it("direct-answer prompt (greetings / no-search) forbids emojis", () => {
    const { system } = buildDirectAnswerPrompt("hi")
    expect(system).toMatch(/do not use emojis/i)
  })

  it("repo-grounded answer prompt forbids emojis", () => {
    const { system } = buildRepoAnswerPrompt({ question: "where is auth?", repoContext: "x", sources: [] })
    expect(system).toMatch(/do not use emojis/i)
  })

  it("final research-report prompt forbids emojis", () => {
    const { system } = buildFinalReportPrompt({ question: "q", notes: "n", sources: [] })
    expect(system).toMatch(/do not use emojis/i)
  })
})
