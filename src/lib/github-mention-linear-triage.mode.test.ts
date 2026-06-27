import { describe, expect, it } from "vitest"
import { resolveGithubLinearTriageMode } from "@/src/lib/github-mention-linear-triage"
describe("resolveGithubLinearTriageMode", () => {
  it("defaults to off when unset/unknown/uppercase", () => {
    expect(resolveGithubLinearTriageMode({})).toBe("off")
    expect(resolveGithubLinearTriageMode({ OPENCLAW_GITHUB_LINEAR_TRIAGE_MODE: "ON" })).toBe("off")
    expect(resolveGithubLinearTriageMode({ OPENCLAW_GITHUB_LINEAR_TRIAGE_MODE: "enforce" })).toBe("off")
  })
  it("parses the three states", () => {
    expect(resolveGithubLinearTriageMode({ OPENCLAW_GITHUB_LINEAR_TRIAGE_MODE: "off" })).toBe("off")
    expect(resolveGithubLinearTriageMode({ OPENCLAW_GITHUB_LINEAR_TRIAGE_MODE: "shadow" })).toBe("shadow")
    expect(resolveGithubLinearTriageMode({ OPENCLAW_GITHUB_LINEAR_TRIAGE_MODE: "on" })).toBe("on")
  })
})
