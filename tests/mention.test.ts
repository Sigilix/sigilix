// Mention detection — covers the parts most likely to silently break:
// quote-stripping (so the bot doesn't reply to its own quoted self),
// inline-code stripping (so doc references don't trigger), and the
// strip-from-body helper (so the prompt sees the question without the
// trigger handle attached).

import { describe, expect, it } from "vitest"
import {
  bodyMentionsBot,
  getMentionTriggers,
  isLikelyBotAuthor,
  stripMentionFromBody,
  stripQuotesAndCode,
} from "../src/lib/mention"

// Test triggers cover the current Sigilix brand AND every legacy
// alias (Arc, OpenClaw) since all three live in the production default
// list to keep historical PR threads triggering after the rebrands.
const TRIGGERS = [
  "sigilix",
  "sigilix[bot]",
  "Sigilix[bot]",
  "arc",
  "arc[bot]",
  "Arc[bot]",
  "openclaw",
  "openclaw[bot]",
  "OpenClaw[bot]",
]

describe("getMentionTriggers", () => {
  it("returns defaults when env value is empty / undefined", () => {
    expect(getMentionTriggers(undefined)).toContain("sigilix")
    expect(getMentionTriggers("")).toContain("sigilix")
    expect(getMentionTriggers("   ")).toContain("sigilix")
  })

  it("includes the current sigilix handles in defaults", () => {
    const t = getMentionTriggers(undefined)
    expect(t).toContain("sigilix")
    expect(t).toContain("sigilix[bot]")
  })

  it("includes legacy arc and openclaw handles in defaults for back-compat", () => {
    const t = getMentionTriggers(undefined)
    expect(t).toContain("arc")
    expect(t).toContain("arc-copilot[bot]")
    expect(t).toContain("openclaw")
  })

  it("parses comma-separated overrides", () => {
    const t = getMentionTriggers("foo, bar,baz")
    expect(t).toEqual(["foo", "bar", "baz"])
  })

  it("falls back to defaults if override is all whitespace", () => {
    const t = getMentionTriggers(", ,  ")
    expect(t).toContain("sigilix")
  })
})

describe("bodyMentionsBot", () => {
  it("matches a plain @-mention", () => {
    expect(bodyMentionsBot("hey @openclaw can you help", TRIGGERS)).toBe(true)
  })

  it("matches @openclaw[bot]", () => {
    expect(bodyMentionsBot("@openclaw[bot] thoughts?", TRIGGERS)).toBe(true)
  })

  it("is case-insensitive", () => {
    expect(bodyMentionsBot("@OpenClaw what now", TRIGGERS)).toBe(true)
  })

  it("ignores email-like suffixes", () => {
    expect(bodyMentionsBot("send to openclaw@example.com", TRIGGERS)).toBe(false)
  })

  it("ignores @openclaw inside backticks", () => {
    expect(bodyMentionsBot("the trigger is `@openclaw` btw", TRIGGERS)).toBe(false)
  })

  it("ignores @openclaw inside fenced code", () => {
    const body = "```\n@openclaw test\n```\nplus some text"
    expect(bodyMentionsBot(body, TRIGGERS)).toBe(false)
  })

  it("ignores @openclaw inside markdown blockquotes (self-quote loop)", () => {
    const body = "> @openclaw — first read on your issue\n\nthanks!"
    expect(bodyMentionsBot(body, TRIGGERS)).toBe(false)
  })

  it("returns false for empty / non-string body", () => {
    expect(bodyMentionsBot("", TRIGGERS)).toBe(false)
    expect(bodyMentionsBot(null as unknown as string, TRIGGERS)).toBe(false)
  })
})

describe("stripQuotesAndCode", () => {
  it("removes fenced code blocks", () => {
    expect(stripQuotesAndCode("a\n```\nblock\n```\nb")).not.toContain("block")
  })

  it("removes inline backtick spans", () => {
    expect(stripQuotesAndCode("a `code` b")).not.toContain("code")
  })

  it("removes blockquote lines", () => {
    expect(stripQuotesAndCode("> quoted\nnot quoted")).not.toContain("quoted\n")
  })
})

describe("stripMentionFromBody", () => {
  it("removes plain @-mentions", () => {
    expect(stripMentionFromBody("@openclaw what does this do?", TRIGGERS)).toBe(
      "what does this do?"
    )
  })

  it("removes @-mentions with a trailing comma", () => {
    expect(stripMentionFromBody("@openclaw, please advise", TRIGGERS)).toBe("please advise")
  })

  it("removes [bot]-suffix mentions", () => {
    expect(stripMentionFromBody("@OpenClaw[bot] take a look", TRIGGERS)).toBe("take a look")
  })

  it("returns trimmed empty string for input that's only the mention", () => {
    expect(stripMentionFromBody("  @openclaw   ", TRIGGERS)).toBe("")
  })
})

describe("isLikelyBotAuthor", () => {
  it.each([
    // Current brand
    ["Sigilix[bot]", true],
    ["sigilix", true],
    // Legacy aliases (back-compat)
    ["OpenClaw[bot]", true],
    ["openclaw", true],
    ["arc", true],
    ["Arc[bot]", true],
    // Other bots — caught by the generic [bot] suffix arm
    ["GitHub-actions[bot]", true],
    // Humans
    ["danny", false],
    ["Daniel", false],
    [null, false],
    [undefined, false],
    ["", false],
  ])("isLikelyBotAuthor(%j) → %s", (input, expected) => {
    expect(isLikelyBotAuthor(input as string | null | undefined)).toBe(expected)
  })
})
