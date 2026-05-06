// ARC-178 — slash-command parsing.

import { describe, it, expect } from "vitest"

import { parseSlashCommand, renderSlashCommandAck, renderHelpBody } from "../src/lib/slash-commands"
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

  it("recognizes `/sigilix improve` (ARC-179)", () => {
    expect(parseSlashCommand("/sigilix improve")).toEqual({ cmd: "improve" })
    expect(parseSlashCommand("/Sigilix IMPROVE")).toEqual({ cmd: "improve" })
    expect(parseSlashCommand("/sigilix improve please")).toEqual({ cmd: "improve" })
  })

  it("recognizes `/sigilix help`", () => {
    expect(parseSlashCommand("/sigilix help")).toEqual({ cmd: "help" })
    expect(parseSlashCommand("/Sigilix HELP")).toEqual({ cmd: "help" })
    expect(parseSlashCommand("/sigilix help me please")).toEqual({ cmd: "help" })
  })

  it("returns null for unsupported subcommands", () => {
    expect(parseSlashCommand("/sigilix ask anything")).toBeNull()
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

  it("doesn't let an unsupported earlier line suppress a supported later one (sigilix-bot catch)", () => {
    // Sigilix-bot's self-review on PR #58 caught this: previously,
    // hitting a `/sigilix <unsupported>` line returned null without
    // checking later lines, so a body that opened with an unknown
    // subcommand would silently drop a valid `/sigilix review`
    // further down. Use a still-unrecognized subcommand here so the
    // test stays meaningful as we add more commands.
    const body = [
      "/sigilix bogus",
      "/sigilix review",
    ].join("\n")
    expect(parseSlashCommand(body)).toEqual({ cmd: "review" })
  })
})

describe("parseSlashCommand — `/sigilix describe` (ARC-191)", () => {
  it("recognizes `/sigilix describe` with no arg → default pr-description mode", () => {
    expect(parseSlashCommand("/sigilix describe")).toEqual({
      cmd: "describe",
      mode: "pr-description",
    })
  })

  it("recognizes the short token `pr` → pr-description", () => {
    expect(parseSlashCommand("/sigilix describe pr")).toEqual({
      cmd: "describe",
      mode: "pr-description",
    })
  })

  it("recognizes `internal` → internal-changelog", () => {
    expect(parseSlashCommand("/sigilix describe internal")).toEqual({
      cmd: "describe",
      mode: "internal-changelog",
    })
  })

  it("recognizes `external` → external-changelog", () => {
    expect(parseSlashCommand("/sigilix describe external")).toEqual({
      cmd: "describe",
      mode: "external-changelog",
    })
  })

  it("returns mode=unknown + rawArg for an unrecognized arg (NOT silent fallback)", () => {
    expect(parseSlashCommand("/sigilix describe foo")).toEqual({
      cmd: "describe",
      mode: "unknown",
      rawArg: "foo",
    })
  })

  it("is case-insensitive on the command word and the mode arg", () => {
    expect(parseSlashCommand("/Sigilix DESCRIBE Internal")).toEqual({
      cmd: "describe",
      mode: "internal-changelog",
    })
  })

  it("ignores trailing tokens after the mode arg", () => {
    expect(parseSlashCommand("/sigilix describe internal please now")).toEqual({
      cmd: "describe",
      mode: "internal-changelog",
    })
  })

  it("treats a bare `/sigilix describe` followed by trailing spaces as default mode", () => {
    expect(parseSlashCommand("/sigilix describe   ")).toEqual({
      cmd: "describe",
      mode: "pr-description",
    })
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
    const out = renderSlashCommandAck({ cmd: "review" })
    expect(typeof out).toBe("string")
    expect(out.length).toBeGreaterThan(0)
    expect(out.toLowerCase()).toContain("review")
  })

  it("renders a non-empty ack for the improve command", () => {
    const out = renderSlashCommandAck({ cmd: "improve" })
    expect(typeof out).toBe("string")
    expect(out.length).toBeGreaterThan(0)
    expect(out.toLowerCase()).toMatch(/(suggest|apply|patch)/)
  })

  it("renders the help body for the help command (the body IS the response)", () => {
    const out = renderSlashCommandAck({ cmd: "help" })
    expect(out).toContain("Sigilix slash commands")
    expect(out).toContain("`/sigilix review`")
    expect(out).toContain("`/sigilix help`")
  })

  it("renders an ack for `describe` (mode-aware)", () => {
    const out = renderSlashCommandAck({ cmd: "describe", mode: "pr-description" })
    expect(typeof out).toBe("string")
    expect(out.length).toBeGreaterThan(0)
    expect(out.toLowerCase()).toContain("describe")
    expect(out.toLowerCase()).toContain("pr description")
  })

  it("renders a usage comment for unknown describe arg (NOT a generic ack)", () => {
    const out = renderSlashCommandAck({
      cmd: "describe",
      mode: "unknown",
      rawArg: "foo",
    })
    expect(out).toContain("`foo`")
    expect(out).toMatch(/`pr`/)
    expect(out).toMatch(/`internal`/)
    expect(out).toMatch(/`external`/)
  })
})

describe("renderHelpBody", () => {
  const body = renderHelpBody()

  it("lists every currently-live command", () => {
    expect(body).toContain("`/sigilix review`")
    expect(body).toContain("`/sigilix improve`")
    expect(body).toContain("`/sigilix help`")
  })

  it("documents the ACL gate", () => {
    expect(body).toMatch(/OWNER.*MEMBER.*COLLABORATOR/)
  })

  it("calls out the line-start + fenced-block recognition rules", () => {
    expect(body.toLowerCase()).toMatch(/start of a line|line start/)
    expect(body.toLowerCase()).toMatch(/fenced|blockquote/)
  })

  it("flags upcoming commands so users know what's coming", () => {
    expect(body).toContain("/sigilix ask")
    expect(body).toContain("/sigilix describe")
  })
})
