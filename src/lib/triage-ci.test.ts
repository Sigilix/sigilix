// CI triage pure helpers: file-mention extraction, confidence parsing, and structured JSON rendering.

import { describe, expect, it } from "vitest"
import {
  buildCiTriageCommentFromModelResponse,
  extractMentionedFiles,
  parseCiTriageResponse,
  parseConfidence,
  renderCiTriageComment,
} from "@/lib/triage-ci"

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
  it("parses a valid structured diagnosis with patch data", () => {
    const parsed = parseCiTriageResponse(JSON.stringify({
      rootCause: "The test still expects the old return shape.",
      suggestedFix: "Update `tests/report.test.ts:42` to expect `regions`.",
      affectedFiles: ["tests/report.test.ts", "src/report.ts"],
      failureExcerpt: "TS2339: Property 'region' does not exist on type 'Report'",
      patches: [
        {
          path: "tests/report.test.ts",
          line: 42,
          replacement: "expect(result.regions).toEqual([\"iad\"])",
        },
        {
          path: "src/report.ts",
          line: 18,
          replacement: "return { regions, metadata }",
        },
      ],
      confidence: "high",
    }))

    expect(parsed).toMatchObject({
      rootCause: "The test still expects the old return shape.",
      suggestedFix: "Update `tests/report.test.ts:42` to expect `regions`.",
      affectedFiles: ["tests/report.test.ts", "src/report.ts"],
      failureExcerpt: "TS2339: Property 'region' does not exist on type 'Report'",
      confidence: "high",
    })
    expect(parsed?.patches).toEqual([
      {
        path: "tests/report.test.ts",
        line: 42,
        replacement: "expect(result.regions).toEqual([\"iad\"])",
      },
      {
        path: "src/report.ts",
        line: 18,
        replacement: "return { regions, metadata }",
      },
    ])
  })

  it("returns null on partial structured diagnosis so callers can use the free-form fallback", () => {
    const parsed = parseCiTriageResponse(`{
      "rootCause": "The lint step fails on a renamed rule.",
      "confidence": "Medium"
    }`)

    expect(parsed).toBeNull()
  })

  it("accepts a structured diagnosis with no patch data", () => {
    const parsed = parseCiTriageResponse(JSON.stringify({
      rootCause: "The lint step fails on a renamed rule.",
      suggestedFix: "Update the eslint config to use the renamed rule.",
      affectedFiles: ["eslint.config.js"],
      failureExcerpt: "Definition for rule 'local/no-legacy-rule' was not found.",
      confidence: "Medium",
    }))

    expect(parsed).toEqual({
      rootCause: "The lint step fails on a renamed rule.",
      suggestedFix: "Update the eslint config to use the renamed rule.",
      affectedFiles: ["eslint.config.js"],
      failureExcerpt: "Definition for rule 'local/no-legacy-rule' was not found.",
      patches: [],
      confidence: "medium",
    })
  })

  it("handles fenced JSON and filters invalid patch entries", () => {
    const parsed = parseCiTriageResponse(`Here is the diagnosis:
\`\`\`json
{
  "rootCause": "A caller still passes the deleted argument.",
  "affectedFiles": ["src/api.ts", "src/api.ts", ""],
  "failureExcerpt": "Expected 1 arguments, but got 2.",
  "confidence": "high",
  "patches": [
    { "path": "src/api.ts", "line": 12, "replacement": "callApi(req)" },
    { "path": "src/api.ts", "line": "13", "replacement": "callApi(req)" },
    { "path": "", "line": 14, "replacement": "callApi(req)" },
    { "path": "src/api.ts", "line": 15, "replacement": "" }
  ]
}
\`\`\``)

    expect(parsed?.affectedFiles).toEqual(["src/api.ts"])
    expect(parsed?.patches).toEqual([
      { path: "src/api.ts", line: 12, replacement: "callApi(req)" },
    ])
  })

  it("rejects unsafe patch paths and oversized replacements", () => {
    const parsed = parseCiTriageResponse(JSON.stringify({
      rootCause: "A caller still passes the deleted argument.",
      affectedFiles: ["src/api.ts"],
      failureExcerpt: "Expected 1 arguments, but got 2.",
      confidence: "high",
      patches: [
        { path: "src/api.ts", line: 12, replacement: "callApi(req)" },
        { path: "src\\windows.ts", line: 20, replacement: "callApi(req)" },
        { path: "../.env", line: 1, replacement: "secret" },
        { path: "/tmp/file.ts", line: 1, replacement: "secret" },
        { path: "src//api.ts", line: 12, replacement: "callApi(req)" },
        { path: "src/huge.ts", line: 1, replacement: "x".repeat(5001) },
      ],
    }))

    expect(parsed?.patches).toEqual([
      { path: "src/api.ts", line: 12, replacement: "callApi(req)" },
      { path: "src/windows.ts", line: 20, replacement: "callApi(req)" },
    ])
  })

  it("returns null on malformed JSON so callers can use the free-form fallback", () => {
    expect(parseCiTriageResponse("{ nope")).toBeNull()
  })
})

describe("renderCiTriageComment", () => {
  it("renders the existing sticky-comment shape from a structured diagnosis", () => {
    const body = renderCiTriageComment({
      rootCause: "The build references a deleted export.",
      suggestedFix: "Update `src/index.ts:7` to import `createClient`.",
      affectedFiles: ["src/index.ts"],
      failureExcerpt: "Module has no exported member 'client'.",
      patches: [
        { path: "src/index.ts", line: 7, replacement: "import { createClient } from './client'" },
      ],
      confidence: "high",
    })

    expect(body).toContain("🔴 **Root cause:** The build references a deleted export.")
    expect(body).toContain("📍 **Likely fix:**\n- Update `src/index.ts:7` to import `createClient`.")
    expect(body).toContain("📋 **Failure excerpt:**\n```\nModule has no exported member 'client'.\n```")
    expect(body).toContain("🤔 **Confidence:** high")
    expect(body).not.toContain("replacement")
    expect(body).not.toContain("```suggestion")
  })

  it("uses a longer failure-excerpt fence when the excerpt contains backticks", () => {
    const body = renderCiTriageComment({
      rootCause: "The formatter prints a fenced block inside the error.",
      affectedFiles: [],
      failureExcerpt: "Rendered markdown includes:\n```\ninner\n```",
      patches: [],
      confidence: "medium",
    })

    expect(body).toContain("📋 **Failure excerpt:**\n````\nRendered markdown includes:\n```\ninner\n```\n````")
  })

  it("renders a generic fix bullet for global failures with no affected files", () => {
    const body = renderCiTriageComment({
      rootCause: "The runner is missing OPENCLAW_TOKEN.",
      affectedFiles: [],
      failureExcerpt: "Missing OPENCLAW_TOKEN",
      patches: [],
      confidence: "medium",
    })

    expect(body).toContain("- Inspect the failing step and changed files named in the log.")
  })
})

describe("buildCiTriageCommentFromModelResponse", () => {
  it("uses structured rendering when JSON parses", () => {
    const out = buildCiTriageCommentFromModelResponse(JSON.stringify({
      rootCause: "A required env var is now missing.",
      affectedFiles: [],
      failureExcerpt: "Missing OPENCLAW_TOKEN",
      confidence: "medium",
    }))

    expect(out?.confidence).toBe("medium")
    expect(out?.diagnosis?.rootCause).toBe("A required env var is now missing.")
    expect(out?.body).toContain("🔴 **Root cause:** A required env var is now missing.")
  })

  it("falls back to the legacy free-form markdown response when structured parsing fails", () => {
    const legacy = `🔴 **Root cause:** The test imports a removed symbol.

📍 **Likely fix:**
- Update \`tests/foo.test.ts:3\` to import \`makeFoo\`.

📋 **Failure excerpt:**
\`\`\`
Module has no exported member 'foo'
\`\`\`

🤔 **Confidence:** medium`

    const out = buildCiTriageCommentFromModelResponse(legacy)

    expect(out).toEqual({
      body: legacy,
      confidence: "medium",
      diagnosis: null,
    })
  })

  it("falls back to the legacy free-form renderer for partial model output with legacy confidence", () => {
    const partial = `{
  "rootCause": "The package manager command is missing.",
  "confidence": "medium"
}

🤔 **Confidence:** medium`

    const out = buildCiTriageCommentFromModelResponse(partial)

    expect(out).toEqual({
      body: partial,
      confidence: "medium",
      diagnosis: null,
    })
  })

  it("returns null when neither structured JSON nor legacy confidence parses", () => {
    expect(buildCiTriageCommentFromModelResponse("unusable")).toBeNull()
  })
})
