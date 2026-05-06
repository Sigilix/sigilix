// ARC-178 — slash-command parsing.

import { describe, it, expect } from "vitest"

import { parseSlashCommand, renderSlashCommandAck } from "../src/lib/slash-commands"
import { stripQuotesAndCode } from "../src/lib/mention"

describe("parseSlashCommand", () => {
  it("returns null for empty / non-string input", () => {
    expect(parseSlashCommand("")).toBeNull()
    // @ts-expect-error — runtime guard against non-string callers
    expect(parseSlashCommand(undefined)).toBeNull()
    // @ts-expect-error
    expect(parseSlashCommand(null)).toBeNull()
  })

  it("recognizes `/sigilix review` at line start", () => {
    expect(parseSlashCommand("/sigilix review")).toEqual({ cmd: "review" })
  })

  it("tolerates leading / trailing whitespace on the line", () => {
    expect(parseSlashCommand("   /sigilix review   ")).toEqual({ cmd: "review" })
  })

  it("is case-insensitive on the prefix and command word", () => {
    expect(parseSlashCommand("/Sigilix REVIEW")).toEqual({ cmd: "review" })
    expect(parseSlashCommand("/SIGILIX Review")).toEqual({ cmd: "review" })
  })

  it("ignores extra arguments after the command word in v1", () => {
    expect(parseSlashCommand("/sigilix review please")).toEqual({ cmd: "review" })
  })

  it("returns null when the slash command isn't at line start", () => {
    expect(parseSlashCommand("Hey /sigilix review")).toBeNull()
    expect(parseSlashCommand("could you /sigilix review this")).toBeNull()
  })

  it("doesn't trigger on `@sigilix` mentions", () => {
    expect(parseSlashCommand("@sigilix review please")).toBeNull()
  })

  it("returns null for unsupported subcommands (v1 review-only)", () => {
    expect(parseSlashCommand("/sigilix ask anything")).toBeNull()
    expect(parseSlashCommand("/sigilix improve")).toBeNull()
    expect(parseSlashCommand("/sigilix describe")).toBeNull()
    expect(parseSlashCommand("/sigilix bogus")).toBeNull()
  })

  it("returns null for bare `/sigilix` with no subcommand", () => {
    expect(parseSlashCommand("/sigilix")).toBeNull()
  })

  it("finds the command on any line in a multi-line body", () => {
    const body = [
      "Thanks for the review.",
      "",
      "/sigilix review",
      "",
      "(re-running because I pushed a fix)",
    ].join("\n")
    expect(parseSlashCommand(body)).toEqual({ cmd: "review" })
  })

  it("matches only the first recognized invocation when multiple exist", () => {
    const body = [
      "/sigilix review",
      "/sigilix review",
    ].join("\n")
    // First match wins; both would yield the same result but we want
    // to confirm we don't accumulate state or return arrays.
    expect(parseSlashCommand(body)).toEqual({ cmd: "review" })
  })

  it("doesn't match when prefix is missing the trailing space and isn't bare", () => {
    // `/sigilixreview` is not a valid invocation.
    expect(parseSlashCommand("/sigilixreview")).toBeNull()
  })

  it("tolerates Windows CRLF line endings", () => {
    // GitHub UI on Windows clients posts \r\n. The trim() in the
    // parser strips the trailing \r before pattern matching.
    expect(parseSlashCommand("/sigilix review\r\nthanks")).toEqual({ cmd: "review" })
    expect(parseSlashCommand("intro\r\n/sigilix review\r\noutro")).toEqual({ cmd: "review" })
  })

  it("recognizes the command on a later line in a mixed body", () => {
    // First line has the command embedded mid-sentence (no match);
    // a later line has it at the start (match).
    const body = [
      "Hey /sigilix review please do it",
      "",
      "/sigilix review",
    ].join("\n")
    expect(parseSlashCommand(body)).toEqual({ cmd: "review" })
  })
})

describe("parseSlashCommand + stripQuotesAndCode integration", () => {
  // The webhook handler calls stripQuotesAndCode(body) before
  // parseSlashCommand, so commands inside fenced blocks or markdown
  // blockquotes never reach the parser. These tests lock that
  // contract in so a regression in either function surfaces.

  it("ignores `/sigilix review` inside a fenced code block", () => {
    const body = [
      "Some explanation",
      "```",
      "/sigilix review",
      "```",
      "",
    ].join("\n")
    expect(parseSlashCommand(stripQuotesAndCode(body))).toBeNull()
  })

  it("ignores `/sigilix review` inside a markdown blockquote", () => {
    const body = [
      "Quoting an earlier comment:",
      "> /sigilix review",
      "",
      "what does that command actually do?",
    ].join("\n")
    expect(parseSlashCommand(stripQuotesAndCode(body))).toBeNull()
  })

  it("still recognizes a real invocation alongside fenced examples", () => {
    const body = [
      "Earlier I said `/sigilix review` doesn't work — wrong.",
      "```",
      "/sigilix review",
      "```",
      "/sigilix review",
    ].join("\n")
    expect(parseSlashCommand(stripQuotesAndCode(body))).toEqual({ cmd: "review" })
  })
})

describe("renderSlashCommandAck", () => {
  it("renders a non-empty ack for the review command", () => {
    const out = renderSlashCommandAck("review")
    expect(typeof out).toBe("string")
    expect(out.length).toBeGreaterThan(0)
    expect(out.toLowerCase()).toContain("review")
  })
})
