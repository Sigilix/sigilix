// CI triage pure helpers: file-mention extraction + confidence parser.

import { describe, expect, it } from "vitest"
import {
  extractMentionedFiles,
  parseConfidence,
  parseCiTriageResponse,
  renderCiTriageVerdict,
  type CiTriageVerdict,
} from "../src/lib/triage-ci"

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

describe("parseCiTriageResponse", () => {
  it("parses a full structured object", () => {
    const json = JSON.stringify({
      rootCause: "TS2339: Property 'foo' does not exist on type 'Bar'",
      suggestedFix: "- Add `foo` to `Bar` in `src/bar.ts:10`",
      affectedFiles: ["src/bar.ts", "src/caller.ts"],
      patches: [{ path: "src/bar.ts", line: 10, replacement: "  foo: string" }],
      failureExcerpt: "src/bar.ts(10,5): error TS2339",
      confidence: "high",
    })
    const v = parseCiTriageResponse(json)
    expect(v).not.toBeNull()
    expect(v?.rootCause).toContain("TS2339")
    expect(v?.confidence).toBe("high")
    expect(v?.affectedFiles).toEqual(["src/bar.ts", "src/caller.ts"])
    expect(v?.patches).toEqual([{ path: "src/bar.ts", line: 10, replacement: "  foo: string" }])
    expect(v?.suggestedFix).toContain("Add `foo`")
    expect(v?.failureExcerpt).toContain("TS2339")
  })

  it("accepts the minimum (rootCause + confidence) and defaults the rest", () => {
    const v = parseCiTriageResponse(JSON.stringify({ rootCause: "boom", confidence: "medium" }))
    expect(v).not.toBeNull()
    expect(v?.affectedFiles).toEqual([])
    expect(v?.patches).toEqual([])
    expect(v?.suggestedFix).toBeUndefined()
    expect(v?.failureExcerpt).toBeUndefined()
  })

  it("extracts JSON from a ```json fenced response (model ignored 'no fence')", () => {
    const fenced = "Here you go:\n```json\n" + JSON.stringify({ rootCause: "x", confidence: "low" }) + "\n```"
    const v = parseCiTriageResponse(fenced)
    expect(v?.rootCause).toBe("x")
    expect(v?.confidence).toBe("low")
  })

  it("returns null on non-JSON (caller falls back to free-form)", () => {
    expect(parseCiTriageResponse("🔴 Root cause: not json at all")).toBeNull()
    expect(parseCiTriageResponse("")).toBeNull()
  })

  it("returns null when rootCause is missing or empty", () => {
    expect(parseCiTriageResponse(JSON.stringify({ confidence: "high" }))).toBeNull()
    expect(parseCiTriageResponse(JSON.stringify({ rootCause: "   ", confidence: "high" }))).toBeNull()
  })

  it("returns null when confidence is missing or unrecognized", () => {
    expect(parseCiTriageResponse(JSON.stringify({ rootCause: "x" }))).toBeNull()
    expect(parseCiTriageResponse(JSON.stringify({ rootCause: "x", confidence: "solid" }))).toBeNull()
  })

  it("drops malformed patch entries but keeps valid ones", () => {
    const json = JSON.stringify({
      rootCause: "x",
      confidence: "high",
      patches: [
        { path: "src/a.ts", line: 5, replacement: "ok" }, // valid
        { path: "", line: 5, replacement: "no path" }, // dropped
        { path: "src/b.ts", line: 0, replacement: "bad line" }, // dropped
        { path: "src/c.ts", line: 2.5, replacement: "non-int" }, // dropped
        { path: "src/d.ts", replacement: "no line" }, // dropped
      ],
    })
    const v = parseCiTriageResponse(json)
    expect(v?.patches).toEqual([{ path: "src/a.ts", line: 5, replacement: "ok" }])
  })

  it("keeps an empty-string replacement (deletion patch)", () => {
    const v = parseCiTriageResponse(
      JSON.stringify({ rootCause: "x", confidence: "high", patches: [{ path: "src/a.ts", line: 3, replacement: "" }] })
    )
    expect(v?.patches).toEqual([{ path: "src/a.ts", line: 3, replacement: "" }])
  })

  it("filters non-string / empty affectedFiles entries", () => {
    const v = parseCiTriageResponse(
      JSON.stringify({ rootCause: "x", confidence: "high", affectedFiles: ["src/a.ts", "", 42, "  ", "src/b.ts"] })
    )
    expect(v?.affectedFiles).toEqual(["src/a.ts", "src/b.ts"])
  })
})

describe("renderCiTriageVerdict", () => {
  const base: CiTriageVerdict = {
    rootCause: "TS2339 on Bar.foo",
    affectedFiles: ["src/bar.ts"],
    patches: [{ path: "src/bar.ts", line: 10, replacement: "  foo: string" }],
    confidence: "high",
  }

  it("renders the 🔴/📍/📋/🤔 sections in order when all present", () => {
    const body = renderCiTriageVerdict({
      ...base,
      suggestedFix: "- Add `foo`",
      failureExcerpt: "error TS2339",
    })
    expect(body).toContain("🔴 **Root cause:** TS2339 on Bar.foo")
    expect(body).toContain("📍 **Likely fix:**")
    expect(body).toContain("📋 **Failure excerpt:**")
    expect(body).toContain("🤔 **Confidence:** high")
    // ordering
    expect(body.indexOf("Root cause")).toBeLessThan(body.indexOf("Likely fix"))
    expect(body.indexOf("Likely fix")).toBeLessThan(body.indexOf("Failure excerpt"))
    expect(body.indexOf("Failure excerpt")).toBeLessThan(body.indexOf("Confidence"))
  })

  it("omits optional sections when absent (minimal verdict)", () => {
    const body = renderCiTriageVerdict(base)
    expect(body).toContain("🔴 **Root cause:**")
    expect(body).toContain("🤔 **Confidence:** high")
    expect(body).not.toContain("Likely fix")
    expect(body).not.toContain("Failure excerpt")
  })

  it("does NOT render affectedFiles or patches (PR A keeps the comment unchanged)", () => {
    const body = renderCiTriageVerdict(base)
    expect(body).not.toContain("src/bar.ts")
    expect(body).not.toContain("foo: string")
  })
})
