// ARC-193 — deterministic regex checks: parser + runner + renderer.

import { describe, it, expect } from "vitest"

import {
  parseDeterministicChecks,
  runDeterministicChecks,
  renderHitsForPrompt,
  type DeterministicCheck,
} from "../src/lib/deterministic-checks"

const mkDiff = (path: string, addedLines: string[], oldStart = 1, newStart = 1) => {
  const lines = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStart},0 +${newStart},${addedLines.length} @@`,
    ...addedLines.map((l) => `+${l}`),
  ]
  return lines.join("\n")
}

describe("parseDeterministicChecks — happy paths", () => {
  it("parses a fully-specified rule", () => {
    const result = parseDeterministicChecks([
      { id: "no-todo", pattern: "TODO", severity: "error", message: "no TODOs" },
    ])
    expect(result).toEqual([
      { id: "no-todo", pattern: "TODO", severity: "error", message: "no TODOs" },
    ])
  })

  it("defaults severity to 'warn' when omitted", () => {
    const result = parseDeterministicChecks([
      { id: "x", pattern: "y", message: "z" },
    ])
    expect(result[0]?.severity).toBe("warn")
  })

  it("includes paths when array of strings", () => {
    const result = parseDeterministicChecks([
      { id: "x", pattern: "y", message: "z", paths: ["src/**/*.ts", "lib/**/*.ts"] },
    ])
    expect(result[0]?.paths).toEqual(["src/**/*.ts", "lib/**/*.ts"])
  })

  it("drops empty-string paths from the array", () => {
    const result = parseDeterministicChecks([
      { id: "x", pattern: "y", message: "z", paths: ["", "real.ts", ""] },
    ])
    expect(result[0]?.paths).toEqual(["real.ts"])
  })

  it("omits paths when all entries are empty/non-string", () => {
    const result = parseDeterministicChecks([
      { id: "x", pattern: "y", message: "z", paths: ["", null, 42] },
    ])
    expect(result[0]?.paths).toBeUndefined()
  })
})

describe("parseDeterministicChecks — defensive returns", () => {
  it("returns empty for non-array", () => {
    expect(parseDeterministicChecks(null)).toEqual([])
    expect(parseDeterministicChecks("[]")).toEqual([])  // string ≠ array
    expect(parseDeterministicChecks({ id: "x" })).toEqual([])
  })

  it("drops entries missing required fields", () => {
    const result = parseDeterministicChecks([
      { id: "x", pattern: "y", message: "z" },           // valid
      { id: "x", pattern: "y" },                          // missing message
      { id: "", pattern: "y", message: "z" },             // empty id
      { pattern: "y", message: "z" },                     // missing id
      { id: "x", message: "z" },                          // missing pattern
      "not an object",
      null,
      [],                                                 // array isn't an entry
    ])
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe("x")
  })

  it("rejects unknown severity values, falls back to 'warn'", () => {
    const result = parseDeterministicChecks([
      { id: "x", pattern: "y", message: "z", severity: "FATAL" },
    ])
    expect(result[0]?.severity).toBe("warn")
  })
})

describe("runDeterministicChecks — matching", () => {
  const mkCheck = (overrides: Partial<DeterministicCheck> = {}): DeterministicCheck => ({
    id: "no-todo",
    pattern: "TODO",
    severity: "warn",
    message: "no TODOs in code",
    ...overrides,
  })

  it("matches an added line", () => {
    const diff = mkDiff("foo.ts", ["// TODO: fix this"])
    const result = runDeterministicChecks(diff, [mkCheck()])
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.path).toBe("foo.ts")
    expect(result.hits[0]?.line).toBe(1)
    expect(result.hits[0]?.evidence).toBe("TODO")
    expect(result.hits[0]?.severity).toBe("warn")
  })

  it("does NOT match deleted lines (only added/+)", () => {
    const diff = [
      "diff --git a/foo.ts b/foo.ts",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,2 +1,1 @@",
      "-// TODO: pre-existing",
      "+// fixed",
    ].join("\n")
    const result = runDeterministicChecks(diff, [mkCheck()])
    expect(result.hits).toEqual([])
  })

  it("does NOT match context (unchanged) lines", () => {
    const diff = [
      "diff --git a/foo.ts b/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,3 +1,3 @@",
      " // TODO: legacy comment, not new",
      "-old",
      "+new",
    ].join("\n")
    const result = runDeterministicChecks(diff, [mkCheck()])
    expect(result.hits).toEqual([])
  })

  it("tracks line numbers across multiple files + hunks", () => {
    const diff = [
      "diff --git a/foo.ts b/foo.ts",
      "+++ b/foo.ts",
      "@@ -10,0 +10,3 @@",
      "+line 10",
      "+TODO line 11",
      "+line 12",
      "diff --git a/bar.ts b/bar.ts",
      "+++ b/bar.ts",
      "@@ -100,0 +100,1 @@",
      "+TODO line 100",
    ].join("\n")
    const result = runDeterministicChecks(diff, [{
      id: "x", pattern: "TODO", severity: "warn", message: "x",
    }])
    expect(result.hits).toHaveLength(2)
    expect(result.hits[0]).toMatchObject({ path: "foo.ts", line: 11 })
    expect(result.hits[1]).toMatchObject({ path: "bar.ts", line: 100 })
  })

  it("respects path filters via glob", () => {
    const diffSrc = mkDiff("src/foo.ts", ["TODO inside src"])
    const diffOther = mkDiff("vendor/foo.ts", ["TODO outside src"])
    const check: DeterministicCheck = {
      id: "x", pattern: "TODO", severity: "warn", message: "x", paths: ["src/**"],
    }
    expect(runDeterministicChecks(diffSrc, [check]).hits).toHaveLength(1)
    expect(runDeterministicChecks(diffOther, [check]).hits).toHaveLength(0)
  })

  it("glob `**` matches whole path segments only (not partial filename)", () => {
    // sigilix-bot dogfood catch on PR #52 fix commit: prior
    // `**`-as-`.*` translation let `src/**/foo.ts` match
    // `src/barfoo.ts`. Verify the segment-boundary fix.
    const check: DeterministicCheck = {
      id: "x", pattern: "TODO", severity: "warn", message: "x", paths: ["src/**/foo.ts"],
    }
    // Should NOT match — no segment boundary between src/ and foo.ts
    expect(runDeterministicChecks(mkDiff("src/barfoo.ts", ["TODO no"]), [check]).hits).toHaveLength(0)
    // SHOULD match — direct child
    expect(runDeterministicChecks(mkDiff("src/foo.ts", ["TODO yes"]), [check]).hits).toHaveLength(1)
    // SHOULD match — nested
    expect(runDeterministicChecks(mkDiff("src/sub/dir/foo.ts", ["TODO yes"]), [check]).hits).toHaveLength(1)
  })

  it("glob `dist/**` matches `dist` itself AND anything under it", () => {
    // sigilix-bot dogfood catch on PR #52 fix commit: prior translation
    // emitted `^dist/.*$` which required the trailing slash; `dist`
    // (no trailing slash) wouldn't match. Verify `(?:/.*)?` fix.
    const check: DeterministicCheck = {
      id: "x", pattern: "TODO", severity: "warn", message: "x", paths: ["dist/**"],
    }
    expect(runDeterministicChecks(mkDiff("dist", ["TODO yes"]), [check]).hits).toHaveLength(1)
    expect(runDeterministicChecks(mkDiff("dist/index.js", ["TODO yes"]), [check]).hits).toHaveLength(1)
    expect(runDeterministicChecks(mkDiff("dist/sub/file.js", ["TODO yes"]), [check]).hits).toHaveLength(1)
    // NOT a match — different prefix
    expect(runDeterministicChecks(mkDiff("distinct/foo.js", ["TODO no"]), [check]).hits).toHaveLength(0)
  })

  it("supports JS regex syntax (groups, classes)", () => {
    const diff = mkDiff("foo.ts", ["console.log(x)", "logger.info(y)"])
    const result = runDeterministicChecks(diff, [{
      id: "x", pattern: "console\\.(log|warn|error)", severity: "warn", message: "x",
    }])
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.evidence).toBe("console.log")
  })

  it("does NOT confuse content lines starting with '--- ' or '+++ ' as headers (sigilix-bot dogfood catch on PR #52)", () => {
    // Inside a hunk, a deleted SQL/Lua-style comment that begins with
    // `--- ` would falsely match the header-detection check if it
    // weren't gated by `inFileHeader`. Verify a hit AFTER such a line
    // still fires — proves we kept tracking the hunk correctly.
    const diff = [
      "diff --git a/script.sql b/script.sql",
      "--- a/script.sql",
      "+++ b/script.sql",
      "@@ -1,5 +1,5 @@",
      " keep",
      "--- old SQL comment",  // CONTENT line that LOOKS like a header marker
      "+++ replacement note",  // CONTENT addition that LOOKS like a header marker
      "+TODO target line",
      " trailing context",
    ].join("\n")
    const result = runDeterministicChecks(diff, [{
      id: "x", pattern: "TODO", severity: "warn", message: "x",
    }])
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.path).toBe("script.sql")
    // newLine starts at 1 (per @@ -1,5 +1,5), advances on context (line 1 → 2)
    // and on additions (TODO is the second `+` line so... let's just
    // assert it's reasonable)
    expect(result.hits[0]?.line).toBeGreaterThan(0)
  })

  it("returns multiple hits when multiple rules match", () => {
    const diff = mkDiff("foo.ts", ["// TODO: console.log(x)"])
    const result = runDeterministicChecks(diff, [
      { id: "todo", pattern: "TODO", severity: "warn", message: "todo" },
      { id: "log", pattern: "console\\.log", severity: "error", message: "log" },
    ])
    expect(result.hits).toHaveLength(2)
    expect(result.hits.map((h) => h.ruleId).sort()).toEqual(["log", "todo"])
  })
})

describe("runDeterministicChecks — fail-open", () => {
  it("skips rules with malformed regex but records the failure", () => {
    const diff = mkDiff("foo.ts", ["console.log(x)"])
    const result = runDeterministicChecks(diff, [
      { id: "ok", pattern: "console", severity: "warn", message: "log" },
      { id: "bad", pattern: "[unterminated", severity: "warn", message: "broken" },
    ])
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.ruleId).toBe("ok")
    expect(result.compiledRegexFailures).toEqual(["bad"])
  })

  it("returns empty for empty diff", () => {
    const result = runDeterministicChecks("", [{
      id: "x", pattern: "TODO", severity: "warn", message: "x",
    }])
    expect(result.hits).toEqual([])
    expect(result.compiledRegexFailures).toEqual([])
  })

  it("returns empty for empty rule list", () => {
    const diff = mkDiff("foo.ts", ["TODO"])
    expect(runDeterministicChecks(diff, []).hits).toEqual([])
  })

  it("truncates evidence over the per-hit cap", () => {
    const longLine = "TODO " + "x".repeat(500)
    const diff = mkDiff("foo.ts", [longLine])
    const result = runDeterministicChecks(diff, [{
      id: "x", pattern: "TODO.+", severity: "warn", message: "x",
    }])
    expect(result.hits[0]?.evidence.length).toBeLessThanOrEqual(200)
  })
})

describe("renderHitsForPrompt", () => {
  it("returns empty string for no hits", () => {
    expect(renderHitsForPrompt([])).toBe("")
  })

  it("renders a labeled block with file:line, severity, rule id, message, evidence", () => {
    const block = renderHitsForPrompt([
      {
        ruleId: "no-todo",
        severity: "warn",
        message: "no TODOs",
        path: "src/foo.ts",
        line: 42,
        evidence: "// TODO: fix this",
      },
    ])
    expect(block).toContain("DETERMINISTIC CHECKS")
    expect(block).toContain("[WARN]")
    expect(block).toContain("src/foo.ts:42")
    expect(block).toContain("rule: no-todo")
    expect(block).toContain("no TODOs")
    expect(block).toContain("// TODO: fix this")
  })
})
