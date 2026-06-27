import { describe, expect, it } from "vitest"
import { parseLinearTriageCommand } from "@/src/lib/github-mention-linear-triage"

describe("parseLinearTriageCommand", () => {
  it("matches the canonical phrasings (case-insensitive)", () => {
    for (const q of [
      "make a linear triage",
      "Make a Linear triage for this",
      "can you create a linear issue from this PR",
      "triage this into linear",
      "make a linear ticket",
    ]) expect(parseLinearTriageCommand(q).matched).toBe(true)
  })
  it("does NOT match normal questions or other commands", () => {
    for (const q of [
      "why does this function return null?",
      "dismiss too-minor",
      "summary",
      "what would a linear triage look like here?", // not a directive
    ]) expect(parseLinearTriageCommand(q).matched).toBe(false)
  })
})
