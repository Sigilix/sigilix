// SIG-196: unit tests for slack-reply.ts — pure intent detection + reply formatting.

import { describe, expect, it } from "vitest"
import { detectSlackIntent, formatSigilixReply } from "@/src/lib/slack/slack-reply"

// ─── detectSlackIntent ────────────────────────────────────────────────────────

describe("detectSlackIntent", () => {
  // linear-triage trigger phrases
  it.each([
    ["make a linear triage"],
    ["please make a linear triage of this thread"],
    ["MAKE A LINEAR TRIAGE"],
    ["create a linear issue"],
    ["can you create a linear issue for this?"],
    ["triage this"],
    ["Triage This"],
    ["linear triage"],
    ["can you do a linear triage?"],
  ])("returns linear-triage for: %s", (text) => {
    expect(detectSlackIntent(text)).toEqual({ kind: "linear-triage" })
  })

  // qa default
  it.each([
    ["how does the auth flow work?"],
    ["what is the default model?"],
    [""],
    ["summarize this PR for me"],
    ["what changed in the last release?"],
    ["triage"],           // bare word without "this" or "linear" prefix
    ["create an issue"],  // not the exact Linear phrase
  ])("returns qa for: %s", (text) => {
    expect(detectSlackIntent(text)).toEqual({ kind: "qa" })
  })
})

// ─── formatSigilixReply ───────────────────────────────────────────────────────

describe("formatSigilixReply", () => {
  it("contains the body", () => {
    const result = formatSigilixReply("This is the answer.")
    expect(result).toContain("This is the answer.")
  })

  it("contains a footer", () => {
    const result = formatSigilixReply("Some body.")
    expect(result).toContain("---")
    expect(result).toContain("Sigilix")
  })

  it("does NOT contain the phrase 'slack bot'", () => {
    const result = formatSigilixReply("Here is what I found.")
    expect(result.toLowerCase()).not.toContain("slack bot")
  })

  it("appends provenance when provided", () => {
    const result = formatSigilixReply("Answer here.", { provenance: "grounded" })
    expect(result).toContain("grounded")
  })

  it("omits provenance suffix when not provided", () => {
    const result = formatSigilixReply("Answer here.")
    // Footer ends without extra '·' from provenance
    const lines = result.split("\n")
    const footerLine = lines[lines.length - 1]
    expect(footerLine).not.toMatch(/·\s*$/)
  })

  it("trims leading/trailing whitespace from body", () => {
    const result = formatSigilixReply("  padded  ")
    expect(result).toMatch(/^padded/)
  })
})
