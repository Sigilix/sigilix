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
} from "@/lib/mention"

// Test triggers match the production default after 2026-05-06 — sigilix
// only. The previous DEFAULT_TRIGGERS included legacy `arc` and
// `openclaw` aliases, but a rubberfit#177 case showed `@arc` is too
// common a dictionary word to leave in production defaults; the false-
// positive trigger rate didn't justify the back-compat value.
const TRIGGERS = [
  "sigilix",
  "sigilix[bot]",
  "Sigilix[bot]",
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

  it("EXCLUDES legacy arc/openclaw handles from defaults (rubberfit#177 false-positive)", () => {
    // Production default was tightened on 2026-05-06 to only match the
    // current `sigilix` brand. `arc` is a common English word and was
    // triggering on unrelated comments; the back-compat value of
    // matching old @arc threads didn't justify the noise.
    const t = getMentionTriggers(undefined)
    expect(t).not.toContain("arc")
    expect(t).not.toContain("arc[bot]")
    expect(t).not.toContain("arc-copilot")
    expect(t).not.toContain("arc-copilot[bot]")
    expect(t).not.toContain("openclaw")
    expect(t).not.toContain("openclaw[bot]")
  })

  it("STILL allows opting back into legacy aliases via OPENCLAW_MENTION_TRIGGERS", () => {
    // For deployments that genuinely want legacy support back, the env
    // var override is the supported path.
    const t = getMentionTriggers("sigilix, arc, openclaw")
    expect(t).toContain("sigilix")
    expect(t).toContain("arc")
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
    expect(bodyMentionsBot("hey @sigilix can you help", TRIGGERS)).toBe(true)
  })

  it("matches @sigilix[bot]", () => {
    expect(bodyMentionsBot("@sigilix[bot] thoughts?", TRIGGERS)).toBe(true)
  })

  it("is case-insensitive", () => {
    expect(bodyMentionsBot("@Sigilix what now", TRIGGERS)).toBe(true)
  })

  it("does NOT match legacy @arc by default (rubberfit#177)", () => {
    expect(bodyMentionsBot("hey @arc can you help", TRIGGERS)).toBe(false)
  })

  it("does NOT match legacy @openclaw by default", () => {
    expect(bodyMentionsBot("hey @openclaw can you help", TRIGGERS)).toBe(false)
  })

  it("ignores email-like suffixes", () => {
    expect(bodyMentionsBot("send to sigilix@example.com", TRIGGERS)).toBe(false)
  })

  it("ignores @sigilix inside backticks", () => {
    expect(bodyMentionsBot("the trigger is `@sigilix` btw", TRIGGERS)).toBe(false)
  })

  it("ignores @sigilix inside fenced code", () => {
    const body = "```\n@sigilix test\n```\nplus some text"
    expect(bodyMentionsBot(body, TRIGGERS)).toBe(false)
  })

  it("ignores @sigilix inside markdown blockquotes (self-quote loop)", () => {
    const body = "> @sigilix — first read on your issue\n\nthanks!"
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
    expect(stripMentionFromBody("@sigilix what does this do?", TRIGGERS)).toBe(
      "what does this do?"
    )
  })

  it("removes @-mentions with a trailing comma", () => {
    expect(stripMentionFromBody("@sigilix, please advise", TRIGGERS)).toBe("please advise")
  })

  it("removes [bot]-suffix mentions", () => {
    expect(stripMentionFromBody("@Sigilix[bot] take a look", TRIGGERS)).toBe("take a look")
  })

  it("returns trimmed empty string for input that's only the mention", () => {
    expect(stripMentionFromBody("  @sigilix   ", TRIGGERS)).toBe("")
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
