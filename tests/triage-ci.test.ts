// CI triage pure helpers: file-mention extraction + confidence parser.

import { describe, expect, it } from "vitest"
import { extractMentionedFiles, parseConfidence } from "../src/lib/triage-ci"

describe("extractMentionedFiles", () => {
  it("returns the empty list on empty input", () => {
    expect(extractMentionedFiles("")).toEqual([])
  })

  it("extracts paths from ESLint-style colon-line output", () => {
    const log = `
src/lib/foo.ts:42:3 error  Unexpected any  @typescript-eslint/no-explicit-any
src/lib/foo.ts:42:3 error  Unexpected any
src/lib/bar.tsx:10:1 error  Cannot find name 'baz'
    `
    expect(extractMentionedFiles(log)).toEqual(["src/lib/foo.ts", "src/lib/bar.tsx"])
  })

  it("extracts paths from Vitest stack traces (relative path, line:col)", () => {
    const log = `FAIL tests/foo.test.ts > describe block > it works
   AssertionError: expected 1 to be 2
    at tests/foo.test.ts:10:5`
    expect(extractMentionedFiles(log)).toContain("tests/foo.test.ts")
  })

  it("requires at least one directory segment (single-name files won't match)", () => {
    // Regex demands `(?:[\w.-]+\/)+` — paths without a `/` are skipped to
    // avoid grabbing fragments like `package.json:5` mid-token. This is
    // intentional behavior the upstream rema-portal version also has.
    expect(extractMentionedFiles(`b.ts:1\na.ts:2`)).toEqual([])
  })

  it("preserves first-seen order on repeated path:line mentions", () => {
    const log = ` src/b.ts:1\n src/a.ts:2\n src/b.ts:3\n src/a.ts:4`
    expect(extractMentionedFiles(log)).toEqual(["src/b.ts", "src/a.ts"])
  })

  it("ignores plain words that aren't paths", () => {
    expect(extractMentionedFiles("Generic error: 1:2:3")).toEqual([])
  })
})

describe("parseConfidence", () => {
  it("parses high/medium/low (case-insensitive)", () => {
    expect(parseConfidence("Confidence: high")).toBe("high")
    expect(parseConfidence("Confidence: Medium")).toBe("medium")
    expect(parseConfidence("Confidence: LOW")).toBe("low")
  })

  it("strips markdown decorations before matching", () => {
    expect(parseConfidence("**Confidence:** *high*")).toBe("high")
    expect(parseConfidence("_Confidence:_ `medium`")).toBe("medium")
  })

  it("matches when nested in surrounding text", () => {
    const body = "Lots of text here\n\n🤔 **Confidence:** medium\n\nSign-off line"
    expect(parseConfidence(body)).toBe("medium")
  })

  it("returns null when no confidence line is present", () => {
    expect(parseConfidence("nothing here")).toBeNull()
    expect(parseConfidence("")).toBeNull()
  })

  it("returns null on unrecognized levels", () => {
    expect(parseConfidence("Confidence: solid")).toBeNull()
    // The regex requires the confidence word IMMEDIATELY after `Confidence:` +
    // optional whitespace; intervening words like "very" break the match.
    expect(parseConfidence("Confidence: very high")).toBeNull()
  })
})
