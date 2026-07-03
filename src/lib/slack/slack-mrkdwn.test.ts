// Unit tests for the Markdown -> Slack mrkdwn converter.

import { describe, expect, it } from "vitest"
import { markdownToMrkdwn } from "@/src/lib/slack/slack-mrkdwn"

describe("markdownToMrkdwn", () => {
  it("converts **bold** to *bold*", () => {
    expect(markdownToMrkdwn("this is **bold** text")).toBe("this is *bold* text")
  })

  it("converts __bold__ to *bold*", () => {
    expect(markdownToMrkdwn("this is __bold__ text")).toBe("this is *bold* text")
  })

  it("converts multiple bold spans on one line", () => {
    expect(markdownToMrkdwn("**a** and **b**")).toBe("*a* and *b*")
  })

  it("converts # headings to a bold line", () => {
    expect(markdownToMrkdwn("# Heading")).toBe("*Heading*")
  })

  it("converts ## and deeper headings to a bold line", () => {
    expect(markdownToMrkdwn("### Deep heading")).toBe("*Deep heading*")
  })

  it("converts [text](url) links to <url|text>", () => {
    expect(markdownToMrkdwn("see [the docs](https://example.com/x)")).toBe("see <https://example.com/x|the docs>")
  })

  it("leaves inline code untouched", () => {
    expect(markdownToMrkdwn("run `npm run build` now")).toBe("run `npm run build` now")
  })

  it("does not convert markdown INSIDE inline code", () => {
    expect(markdownToMrkdwn("literal `**not bold**` here")).toBe("literal `**not bold**` here")
  })

  it("leaves fenced code blocks untouched", () => {
    const input = "before\n```\n**still literal**\n# not a heading\n```\nafter"
    expect(markdownToMrkdwn(input)).toBe(input)
  })

  it("leaves bullet lines as-is", () => {
    const input = "- first\n- second"
    expect(markdownToMrkdwn(input)).toBe(input)
  })

  it("leaves already-Slack bold (single asterisk) untouched", () => {
    expect(markdownToMrkdwn("this is *already* slack bold")).toBe("this is *already* slack bold")
  })

  it("leaves already-Slack links untouched", () => {
    expect(markdownToMrkdwn("<https://example.com|link>")).toBe("<https://example.com|link>")
  })

  it("does not corrupt plain numbers or surrounding text", () => {
    expect(markdownToMrkdwn("meet in 5 minutes at 10 am")).toBe("meet in 5 minutes at 10 am")
  })

  it("preserves text around restored inline code without adding stray spaces", () => {
    expect(markdownToMrkdwn("foo `bar` baz")).toBe("foo `bar` baz")
  })

  it("preserves backtick-wrapped code identifiers verbatim (dunders included)", () => {
    // Code refs are always backtick-wrapped in the agent's output, so real code is
    // never mangled — the protected-region pass keeps them intact.
    expect(markdownToMrkdwn("call `__init__` then `__main__`")).toBe("call `__init__` then `__main__`")
  })

  it("bolds bare __dunder__ in prose (standard Markdown behavior)", () => {
    // Documented + intentional: standard Markdown/CommonMark bolds `__init__` in
    // prose too. Backtick-wrap code identifiers (the agent does) to avoid this.
    expect(markdownToMrkdwn("the __init__ method")).toBe("the *init* method")
  })

  it("handles empty input", () => {
    expect(markdownToMrkdwn("")).toBe("")
  })

  it("converts a mixed message end-to-end", () => {
    const input = "# Title\n\nThe **auth** flow lives in `auth.ts`. See [PR #12](https://example.com/12)."
    const expected = "*Title*\n\nThe *auth* flow lives in `auth.ts`. See <https://example.com/12|PR #12>."
    expect(markdownToMrkdwn(input)).toBe(expected)
  })
})
