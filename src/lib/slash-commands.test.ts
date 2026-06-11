// ARC-178 — slash-command parsing.

import { describe, it, expect } from "vitest"

import {
  parseSlashCommand,
  renderSlashCommandAck,
  renderHelpBody,
  isAuthorAllowedForSlashCommand,
} from "@/src/lib/slash-commands"
import { stripQuotesAndCode } from "@/src/lib/mention"

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
    const body = ["Thanks for the review.", "", "/sigilix review", "", "(re-running because I pushed a fix)"].join("\n")
    expect(parseSlashCommand(body)).toEqual({ cmd: "review" })
  })

  it("matches only the first recognized invocation when multiple exist", () => {
    const body = ["/sigilix review", "/sigilix review"].join("\n")
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
    const body = ["Hey /sigilix review please do it", "", "/sigilix review"].join("\n")
    expect(parseSlashCommand(body)).toEqual({ cmd: "review" })
  })

  it("doesn't let an unsupported earlier line suppress a supported later one (sigilix-bot catch)", () => {
    // Sigilix-bot's self-review on PR #58 caught this: previously,
    // hitting a `/sigilix <unsupported>` line returned null without
    // checking later lines, so a body that opened with an unknown
    // subcommand would silently drop a valid `/sigilix review`
    // further down. Use a still-unrecognized subcommand here so the
    // test stays meaningful as we add more commands.
    const body = ["/sigilix bogus", "/sigilix review"].join("\n")
    expect(parseSlashCommand(body)).toEqual({ cmd: "review" })
  })
})

describe("parseSlashCommand — `/sigilix describe` (ARC-191)", () => {
  it("recognizes `/sigilix describe` with no arg → default pr-description mode", () => {
    expect(parseSlashCommand("/sigilix describe")).toEqual({
      cmd: "describe",
      mode: "pr-description",
      apply: false,
    })
  })

  it("recognizes the short token `pr` → pr-description", () => {
    expect(parseSlashCommand("/sigilix describe pr")).toEqual({
      cmd: "describe",
      mode: "pr-description",
      apply: false,
    })
  })

  it("recognizes `internal` → internal-changelog", () => {
    expect(parseSlashCommand("/sigilix describe internal")).toEqual({
      cmd: "describe",
      mode: "internal-changelog",
      apply: false,
    })
  })

  it("recognizes `external` → external-changelog", () => {
    expect(parseSlashCommand("/sigilix describe external")).toEqual({
      cmd: "describe",
      mode: "external-changelog",
      apply: false,
    })
  })

  it("returns mode=unknown + rawArg for an unrecognized arg (NOT silent fallback)", () => {
    expect(parseSlashCommand("/sigilix describe foo")).toEqual({
      cmd: "describe",
      mode: "unknown",
      rawArg: "foo",
      apply: false,
    })
  })

  it("is case-insensitive on the command word and the mode arg", () => {
    expect(parseSlashCommand("/Sigilix DESCRIBE Internal")).toEqual({
      cmd: "describe",
      mode: "internal-changelog",
      apply: false,
    })
  })

  it("ignores trailing tokens after the mode arg", () => {
    expect(parseSlashCommand("/sigilix describe internal please now")).toEqual({
      cmd: "describe",
      mode: "internal-changelog",
      apply: false,
    })
  })

  it("treats a bare `/sigilix describe` followed by trailing spaces as default mode", () => {
    expect(parseSlashCommand("/sigilix describe   ")).toEqual({
      cmd: "describe",
      mode: "pr-description",
      apply: false,
    })
  })
})

describe("parseSlashCommand — `/sigilix describe apply` (ARC-264)", () => {
  it("recognizes bare `/sigilix describe apply` → apply=true + default mode", () => {
    expect(parseSlashCommand("/sigilix describe apply")).toEqual({
      cmd: "describe",
      mode: "pr-description",
      apply: true,
    })
  })

  it("recognizes `/sigilix describe apply pr` → apply=true + pr-description", () => {
    expect(parseSlashCommand("/sigilix describe apply pr")).toEqual({
      cmd: "describe",
      mode: "pr-description",
      apply: true,
    })
  })

  it("recognizes `/sigilix describe apply internal` → apply=true + internal-changelog", () => {
    expect(parseSlashCommand("/sigilix describe apply internal")).toEqual({
      cmd: "describe",
      mode: "internal-changelog",
      apply: true,
    })
  })

  it("recognizes `/sigilix describe apply external` → apply=true + external-changelog", () => {
    expect(parseSlashCommand("/sigilix describe apply external")).toEqual({
      cmd: "describe",
      mode: "external-changelog",
      apply: true,
    })
  })

  it("is case-insensitive on the `apply` token and the mode arg", () => {
    expect(parseSlashCommand("/Sigilix DESCRIBE APPLY Internal")).toEqual({
      cmd: "describe",
      mode: "internal-changelog",
      apply: true,
    })
  })

  it("returns mode=unknown + apply=true for `/sigilix describe apply <bad-mode>` (NOT silent fallback)", () => {
    expect(parseSlashCommand("/sigilix describe apply bogus")).toEqual({
      cmd: "describe",
      mode: "unknown",
      rawArg: "bogus",
      apply: true,
    })
  })

  it("ignores trailing tokens after the mode arg in apply form", () => {
    expect(parseSlashCommand("/sigilix describe apply external please now")).toEqual({
      cmd: "describe",
      mode: "external-changelog",
      apply: true,
    })
  })

  it("surfaces a usage error when `apply` appears AFTER the mode (typo guard)", () => {
    // Code-review M4 catch: `/sigilix describe pr apply` used to
    // silently demote to apply=false, giving the user a comment-mode
    // draft when they meant apply-mode. Now treated as an unknown
    // shape so the synchronous usage comment surfaces the intended
    // `apply <mode>` form.
    expect(parseSlashCommand("/sigilix describe pr apply")).toEqual({
      cmd: "describe",
      mode: "unknown",
      rawArg: "pr apply",
      apply: false,
    })
    expect(parseSlashCommand("/sigilix describe internal apply")).toEqual({
      cmd: "describe",
      mode: "unknown",
      rawArg: "internal apply",
      apply: false,
    })
  })

  it("returns apply=false for plain `/sigilix describe <mode>` (no regression on ARC-191 shape)", () => {
    expect(parseSlashCommand("/sigilix describe pr")).toEqual({
      cmd: "describe",
      mode: "pr-description",
      apply: false,
    })
    expect(parseSlashCommand("/sigilix describe internal")).toEqual({
      cmd: "describe",
      mode: "internal-changelog",
      apply: false,
    })
  })
})

describe("parseSlashCommand + stripQuotesAndCode integration", () => {
  // The webhook handler calls stripQuotesAndCode(body) before
  // parseSlashCommand, so commands inside fenced blocks or markdown
  // blockquotes never reach the parser. These tests lock that
  // contract in so a regression in either function surfaces.

  it("ignores `/sigilix review` inside a fenced code block", () => {
    const body = ["Some explanation", "```", "/sigilix review", "```", ""].join("\n")
    expect(parseSlashCommand(stripQuotesAndCode(body))).toBeNull()
  })

  it("ignores `/sigilix review` inside a markdown blockquote", () => {
    const body = ["Quoting an earlier comment:", "> /sigilix review", "", "what does that command actually do?"].join(
      "\n",
    )
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
    const out = renderSlashCommandAck({ cmd: "describe", mode: "pr-description", apply: false })
    expect(typeof out).toBe("string")
    expect(out.length).toBeGreaterThan(0)
    expect(out.toLowerCase()).toContain("describe")
    expect(out.toLowerCase()).toContain("pr description")
  })

  it("renders an apply-aware ack mentioning the marker fences (ARC-264)", () => {
    const out = renderSlashCommandAck({ cmd: "describe", mode: "external-changelog", apply: true })
    expect(out.toLowerCase()).toContain("external changelog")
    expect(out.toLowerCase()).toContain("pr body")
    expect(out.toLowerCase()).toMatch(/marker|fence/)
  })

  it("renders a usage comment for unknown describe arg (NOT a generic ack)", () => {
    const out = renderSlashCommandAck({
      cmd: "describe",
      mode: "unknown",
      rawArg: "foo",
      apply: false,
    })
    expect(out).toContain("`foo`")
    expect(out).toMatch(/`pr`/)
    expect(out).toMatch(/`internal`/)
    expect(out).toMatch(/`external`/)
  })
})

describe("parseSlashCommand — SIG-98 lifecycle commands", () => {
  it("recognizes `/sigilix pause`", () => {
    expect(parseSlashCommand("/sigilix pause")).toEqual({ cmd: "pause" })
    expect(parseSlashCommand("/Sigilix PAUSE")).toEqual({ cmd: "pause" })
    expect(parseSlashCommand("/sigilix pause please")).toEqual({ cmd: "pause" })
  })

  it("recognizes `/sigilix resume`", () => {
    expect(parseSlashCommand("/sigilix resume")).toEqual({ cmd: "resume" })
    expect(parseSlashCommand("/SIGILIX RESUME")).toEqual({ cmd: "resume" })
  })

  it("recognizes `/sigilix ignore`", () => {
    expect(parseSlashCommand("/sigilix ignore")).toEqual({ cmd: "ignore" })
    expect(parseSlashCommand("/sigilix Ignore")).toEqual({ cmd: "ignore" })
  })

  it("recognizes `/sigilix resolve`", () => {
    expect(parseSlashCommand("/sigilix resolve")).toEqual({ cmd: "resolve" })
    expect(parseSlashCommand("/Sigilix RESOLVE")).toEqual({ cmd: "resolve" })
  })

  it("recognizes `/sigilix cancel` (SIG-329)", () => {
    expect(parseSlashCommand("/sigilix cancel")).toEqual({ cmd: "cancel" })
    expect(parseSlashCommand("/Sigilix CANCEL")).toEqual({ cmd: "cancel" })
    expect(parseSlashCommand("/sigilix cancel now")).toEqual({ cmd: "cancel" })
  })

  it("recognizes the two-word `/sigilix full review`", () => {
    expect(parseSlashCommand("/sigilix full review")).toEqual({ cmd: "full-review" })
    expect(parseSlashCommand("/Sigilix FULL Review")).toEqual({ cmd: "full-review" })
    expect(parseSlashCommand("/sigilix full review please")).toEqual({ cmd: "full-review" })
  })

  it("returns null for `/sigilix full` without `review` token", () => {
    expect(parseSlashCommand("/sigilix full")).toBeNull()
    expect(parseSlashCommand("/sigilix full nonsense")).toBeNull()
  })

  it("doesn't let `/sigilix full nonsense` suppress a real command on a later line", () => {
    // The "unsupported earlier line suppresses later one" regression
    // from PR #58 also has to be guarded against the new two-token
    // `full` path. An unrecognized second token after `full` should
    // continue scanning later lines.
    const body = ["/sigilix full nonsense", "/sigilix review"].join("\n")
    expect(parseSlashCommand(body)).toEqual({ cmd: "review" })
  })

  it("matches all five new commands within mixed bodies (line-start required)", () => {
    expect(parseSlashCommand("ack the bot\n\n/sigilix pause\n")).toEqual({ cmd: "pause" })
    expect(parseSlashCommand("/sigilix resume\nthanks")).toEqual({ cmd: "resume" })
    expect(parseSlashCommand("Hey /sigilix pause")).toBeNull()
  })
})

describe("renderSlashCommandAck — SIG-98 lifecycle commands", () => {
  it("renders a pause ack mentioning the 24h window + resume CTA", () => {
    const out = renderSlashCommandAck({ cmd: "pause" })
    expect(out.toLowerCase()).toContain("pause")
    expect(out).toMatch(/24h|24 hour/i)
    expect(out).toContain("`/sigilix resume`")
  })

  it("renders a resume ack", () => {
    const out = renderSlashCommandAck({ cmd: "resume" })
    expect(out.toLowerCase()).toMatch(/re-?enabled|resumed/)
  })

  it("renders an ignore ack mentioning permanence + resume CTA", () => {
    const out = renderSlashCommandAck({ cmd: "ignore" })
    expect(out.toLowerCase()).toMatch(/permanent|disabled/)
    expect(out).toContain("`/sigilix resume`")
  })

  it("renders a full-review ack mentioning dedup bypass", () => {
    const out = renderSlashCommandAck({ cmd: "full-review" })
    expect(out.toLowerCase()).toMatch(/bypass|dedup|re-run/)
  })

  it("renders a resolve ack mentioning Sigilix-authored threads", () => {
    const out = renderSlashCommandAck({ cmd: "resolve" })
    expect(out.toLowerCase()).toContain("resolve")
    expect(out.toLowerCase()).toMatch(/sigilix-authored|sigilix/)
  })

  it("renders a cancel ack mentioning the in-progress review + check close (SIG-329)", () => {
    const out = renderSlashCommandAck({ cmd: "cancel" })
    expect(out.toLowerCase()).toContain("cancel")
    expect(out.toLowerCase()).toMatch(/in-progress|check/)
  })
})

describe("renderHelpBody", () => {
  const body = renderHelpBody()

  it("lists every currently-live command (including describe + apply, ARC-191 + ARC-264)", () => {
    expect(body).toContain("`/sigilix review`")
    expect(body).toContain("`/sigilix improve`")
    expect(body).toContain("`/sigilix describe`")
    expect(body).toContain("`/sigilix describe apply`")
    expect(body).toContain("`/sigilix help`")
  })

  it("documents the SIG-98 lifecycle commands", () => {
    expect(body).toContain("`/sigilix pause`")
    expect(body).toContain("`/sigilix resume`")
    expect(body).toContain("`/sigilix ignore`")
    expect(body).toContain("`/sigilix full review`")
    expect(body).toContain("`/sigilix resolve`")
  })

  it("documents the SIG-329 cancel command", () => {
    expect(body).toContain("`/sigilix cancel`")
  })

  it("documents the describe mode tokens", () => {
    expect(body).toContain("`pr`")
    expect(body).toContain("`internal`")
    expect(body).toContain("`external`")
  })

  it("explains apply's marker-preserving behavior so users know it's safe (ARC-264)", () => {
    const lower = body.toLowerCase()
    expect(lower).toContain("marker")
    expect(lower).toMatch(/preserve|untouched|outside/)
  })

  it("documents the ACL gate", () => {
    expect(body).toMatch(/OWNER.*MEMBER.*COLLABORATOR/)
  })

  it("calls out the line-start + fenced-block recognition rules", () => {
    expect(body.toLowerCase()).toMatch(/start of a line|line start/)
    expect(body.toLowerCase()).toMatch(/fenced|blockquote/)
  })

  it("flags only `/sigilix ask` as coming soon (describe shipped in ARC-191)", () => {
    expect(body).toContain("/sigilix ask")
    const comingSoonLine = body.split("\n").find((l) => l.toLowerCase().includes("coming soon")) ?? ""
    expect(comingSoonLine).toContain("ask")
    expect(comingSoonLine).not.toContain("describe")
  })
})

describe("isAuthorAllowedForSlashCommand", () => {
  it("allows OWNER", () => {
    expect(isAuthorAllowedForSlashCommand("OWNER")).toBe(true)
  })
  it("allows MEMBER", () => {
    expect(isAuthorAllowedForSlashCommand("MEMBER")).toBe(true)
  })
  it("allows COLLABORATOR", () => {
    expect(isAuthorAllowedForSlashCommand("COLLABORATOR")).toBe(true)
  })
  it("is case-insensitive", () => {
    expect(isAuthorAllowedForSlashCommand("owner")).toBe(true)
    expect(isAuthorAllowedForSlashCommand("Member")).toBe(true)
  })
  it("rejects CONTRIBUTOR (excluded — anyone whose PR has merged is forever CONTRIBUTOR)", () => {
    expect(isAuthorAllowedForSlashCommand("CONTRIBUTOR")).toBe(false)
  })
  it("rejects FIRST_TIME_CONTRIBUTOR", () => {
    expect(isAuthorAllowedForSlashCommand("FIRST_TIME_CONTRIBUTOR")).toBe(false)
  })
  it("rejects NONE", () => {
    expect(isAuthorAllowedForSlashCommand("NONE")).toBe(false)
  })
  it("rejects an empty string (missing association)", () => {
    expect(isAuthorAllowedForSlashCommand("")).toBe(false)
  })
  it("rejects null / undefined", () => {
    expect(isAuthorAllowedForSlashCommand(null)).toBe(false)
    expect(isAuthorAllowedForSlashCommand(undefined)).toBe(false)
  })
  it("rejects unknown values defensively", () => {
    expect(isAuthorAllowedForSlashCommand("ROOT")).toBe(false)
    expect(isAuthorAllowedForSlashCommand("ADMIN")).toBe(false)
  })
})
