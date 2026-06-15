// SIG-437 — `parseSummaryCommand` tests. The trigger gate. Critical cases: a
// fresh author-typed trigger fires; a trigger inside code/quotes does NOT; and a
// `@sigilix summary` echoed INSIDE the already-written managed block does NOT
// re-trigger (Codex MUST-FIX #4 — our own body PATCH is an `edited` event).

import { describe, it, expect } from "vitest"

import { parseSummaryCommand } from "@/src/lib/pr-summary-command"
import { SUMMARY_MARKERS } from "@/src/lib/pr-summary-apply"

describe("parseSummaryCommand — positive", () => {
  it("matches a standalone trigger line", () => {
    expect(parseSummaryCommand("@sigilix summary")).toEqual({ kind: "summary" })
    expect(parseSummaryCommand("intro text\n\n@sigilix summary\n\nmore")).toEqual({ kind: "summary" })
    expect(parseSummaryCommand("  @Sigilix   SUMMARY  ")).toEqual({ kind: "summary" })
  })

  it("honors custom triggers via the env string", () => {
    expect(parseSummaryCommand("@mybot summary", "mybot")).toEqual({ kind: "summary" })
    // default triggers don't include `mybot`
    expect(parseSummaryCommand("@mybot summary")).toBeNull()
  })
})

describe("parseSummaryCommand — negative", () => {
  it("returns null for empty / null / undefined", () => {
    expect(parseSummaryCommand("")).toBeNull()
    expect(parseSummaryCommand(null)).toBeNull()
    expect(parseSummaryCommand(undefined)).toBeNull()
  })

  it("does not fire on near-misses or mid-sentence mentions", () => {
    expect(parseSummaryCommand("please @sigilix summary this PR")).toBeNull()
    expect(parseSummaryCommand("@sigilix summarize")).toBeNull()
    expect(parseSummaryCommand("@sigilix review")).toBeNull()
  })

  it("ignores a trigger inside a fenced code block", () => {
    expect(parseSummaryCommand("```\n@sigilix summary\n```")).toBeNull()
  })

  it("ignores a trigger inside an inline code span", () => {
    expect(parseSummaryCommand("type `@sigilix summary` to run it")).toBeNull()
  })

  it("ignores a trigger inside a blockquote", () => {
    expect(parseSummaryCommand("> @sigilix summary")).toBeNull()
  })
})

describe("parseSummaryCommand — re-trigger guard (the load-bearing case)", () => {
  it("does NOT re-trigger when the only `@sigilix summary` is INSIDE the managed block", () => {
    const body = [
      "## Context",
      "",
      "Author prose.",
      "",
      SUMMARY_MARKERS.start,
      "## What",
      "",
      // model echoed the trigger inside the generated description
      "This PR adds `@sigilix summary` support.",
      SUMMARY_MARKERS.end,
    ].join("\n")
    expect(parseSummaryCommand(body)).toBeNull()
  })

  it("DOES fire when a fresh trigger sits OUTSIDE an existing block", () => {
    const body = [SUMMARY_MARKERS.start, "old generated content", SUMMARY_MARKERS.end, "", "@sigilix summary"].join(
      "\n",
    )
    expect(parseSummaryCommand(body)).toEqual({ kind: "summary" })
  })
})
