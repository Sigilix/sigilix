// ARC-181 — runAstRules orchestrator tests.
//
// Covers all skip-paths + finding emission + multi-file resilience.

import { readFileSync } from "node:fs"
import { describe, it, expect } from "vitest"
import { runAstRules } from "@/features/ast-rules/app/runner"
import type { ReviewableMap } from "../src/lib/diff-positions"

const CTX = { owner: "o", repo: "r", prNumber: 1 }

const DEFAULT_CONFIG = {
  enabled: true,
  severityThreshold: "warning" as const,
  disabledRules: [],
  autoInline: false,
}

function diffWithEvalAt(line: number, path: string): string {
  // Build a unified diff that adds an `eval(x)` line at `line` in
  // `path` so the changed-lines filter accepts it.
  const header = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`
  const hunkStart = `@@ -${line},0 +${line},1 @@\n`
  const added = `+const x = eval("p")\n`
  return header + hunkStart + added
}

function diffAddingLineAt(line: number, path: string, lineText = "changed"): string {
  const header = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`
  const hunkStart = `@@ -${line},0 +${line},1 @@\n`
  return header + hunkStart + `+${lineText}\n`
}

const REVIEWABLE_AT = (path: string, line: number): ReviewableMap =>
  new Map([[path, [{ line, side: "RIGHT" }]]])

describe("runAstRules — skip paths", () => {
  it("skips with disabled-config when astRules.enabled = false", async () => {
    const r = await runAstRules({
      diff: diffWithEvalAt(1, "src/foo.ts"),
      filesByPath: new Map([["src/foo.ts", `eval("x")`]]),
      reviewable: REVIEWABLE_AT("src/foo.ts", 1),
      config: { ...DEFAULT_CONFIG, enabled: false },
      ctx: CTX,
    })
    expect(r.findings).toEqual([])
    expect(r.telemetry.skipReason).toBe("disabled-config")
  })

  it("skips with no-js-ts-files when no supported files in diff", async () => {
    const r = await runAstRules({
      diff: "",
      filesByPath: new Map([["README.md", "# hi"], ["x.py", "print(1)"]]),
      reviewable: new Map(),
      config: DEFAULT_CONFIG,
      ctx: CTX,
    })
    expect(r.findings).toEqual([])
    expect(r.telemetry.skipReason).toBe("no-js-ts-files")
  })

  it("counts large files in telemetry without parsing", async () => {
    const big = "x".repeat(600_000)
    const r = await runAstRules({
      diff: diffWithEvalAt(1, "src/big.ts"),
      filesByPath: new Map([["src/big.ts", big]]),
      reviewable: REVIEWABLE_AT("src/big.ts", 1),
      config: DEFAULT_CONFIG,
      ctx: CTX,
    })
    expect(r.findings).toEqual([])
    expect(r.telemetry.filesSkippedLarge).toBe(1)
  })

  it("keeps enum-drift scanning bounded when another file seeds a union map", async () => {
    const sourcePath = "src/lib/validate-logic-claim-refutation.ts"
    const unionPath = "src/types.ts"
    const source = readFileSync(new URL("../src/lib/validate-logic-claim-refutation.ts", import.meta.url), "utf8")
    const unionSource = `export interface Charge { status: "pending" | "settled" | "failed" }\n`
    const r = await runAstRules({
      diff: diffAddingLineAt(1, sourcePath, "// touched")
        + diffAddingLineAt(1, unionPath, unionSource.trim()),
      filesByPath: new Map([
        [sourcePath, source],
        [unionPath, unionSource],
      ]),
      reviewable: new Map([
        [sourcePath, [{ line: 1, side: "RIGHT" }]],
        [unionPath, [{ line: 1, side: "RIGHT" }]],
      ]),
      config: DEFAULT_CONFIG,
      ctx: CTX,
    })
    expect(r.findings.filter((f) => f.ruleId === "no-enum-literal-drift")).toEqual([])
  })
})

describe("runAstRules — pathFilters compatibility (Codex MAJOR #4)", () => {
  // The ensemble orchestrator filters changed-file paths through
  // sigilix.json `pathFilters` BEFORE handing the file list to
  // runAstRules. The runner trusts this — paths NOT in
  // `filesByPath` are never fetched, parsed, or scanned. These
  // tests lock that contract.

  it("excluded paths (not in filesByPath) are NEVER scanned", async () => {
    const r = await runAstRules({
      // Diff mentions BOTH dist/foo.js (excluded by pathFilters)
      // AND src/bar.js (included). Caller passes only src/bar.js
      // in filesByPath — simulating pathFilters dropping dist/**.
      diff: diffWithEvalAt(1, "dist/foo.js") + diffWithEvalAt(1, "src/bar.js"),
      filesByPath: new Map([
        // dist/foo.js INTENTIONALLY OMITTED — caller's pathFilters dropped it
        ["src/bar.js", `const x = eval("p")\n`],
      ]),
      reviewable: new Map([
        ["dist/foo.js", [{ line: 1, side: "RIGHT" }]],
        ["src/bar.js", [{ line: 1, side: "RIGHT" }]],
      ]),
      config: DEFAULT_CONFIG,
      ctx: CTX,
    })
    // Only src/bar.js gets a finding — dist/foo.js is invisible to
    // the runner.
    expect(r.findings.length).toBe(1)
    expect(r.findings[0].path).toBe("src/bar.js")
  })

  it("when ALL paths are filtered out, no scan happens", async () => {
    const r = await runAstRules({
      diff: diffWithEvalAt(1, "dist/foo.js"),
      filesByPath: new Map(),  // nothing left after pathFilters
      reviewable: new Map([["dist/foo.js", [{ line: 1, side: "RIGHT" }]]]),
      config: DEFAULT_CONFIG,
      ctx: CTX,
    })
    expect(r.findings.length).toBe(0)
    expect(r.telemetry.skipReason).toBe("no-js-ts-files")
  })
})

describe("runAstRules — finding emission", () => {
  it("emits a finding for eval() in a changed line", async () => {
    const r = await runAstRules({
      diff: diffWithEvalAt(1, "src/foo.ts"),
      filesByPath: new Map([["src/foo.ts", `const x = eval("p")\n`]]),
      reviewable: REVIEWABLE_AT("src/foo.ts", 1),
      config: DEFAULT_CONFIG,
      ctx: CTX,
    })
    expect(r.findings.length).toBe(1)
    expect(r.findings[0].ruleId).toBe("no-eval-call")
    expect(r.findings[0].astFindingId).toMatch(/^ast\/no-eval-call\/[0-9a-f]{7}\/1$/)
  })

  it("does NOT emit when eval is on a line outside the changed set", async () => {
    // Diff only touches line 5; eval is on line 1 which is unchanged
    const diff = `diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -5,0 +5,1 @@\n+const newline = 1\n`
    const r = await runAstRules({
      diff,
      filesByPath: new Map([["src/foo.ts", `eval("p")\nconst a = 1\nconst b = 2\nconst c = 3\nconst newline = 1\n`]]),
      reviewable: new Map([["src/foo.ts", [{ line: 5, side: "RIGHT" }]]]),
      config: DEFAULT_CONFIG,
      ctx: CTX,
    })
    expect(r.findings.length).toBe(0)
  })

  it("emits no review position when reviewable map lacks the line", async () => {
    const r = await runAstRules({
      diff: diffWithEvalAt(1, "src/foo.ts"),
      filesByPath: new Map([["src/foo.ts", `const x = eval("p")\n`]]),
      reviewable: new Map(), // no positions at all
      config: DEFAULT_CONFIG,
      ctx: CTX,
    })
    expect(r.findings.length).toBe(1)
    expect(r.perFinding.get(r.findings[0].astFindingId)).toBeNull()
  })

  it("disabledRules excludes a rule entirely", async () => {
    const r = await runAstRules({
      diff: diffWithEvalAt(1, "src/foo.ts"),
      filesByPath: new Map([["src/foo.ts", `const x = eval("p")\n`]]),
      reviewable: REVIEWABLE_AT("src/foo.ts", 1),
      config: { ...DEFAULT_CONFIG, disabledRules: ["no-eval-call"] },
      ctx: CTX,
    })
    expect(r.findings.length).toBe(0)
  })

  it("severityThreshold error keeps error-tier rule", async () => {
    const r = await runAstRules({
      diff: diffWithEvalAt(1, "src/foo.ts"),
      filesByPath: new Map([["src/foo.ts", `const x = eval("p")\n`]]),
      reviewable: REVIEWABLE_AT("src/foo.ts", 1),
      config: { ...DEFAULT_CONFIG, severityThreshold: "error" },
      ctx: CTX,
    })
    expect(r.findings.length).toBe(1)
  })

  it("parse failure on file A doesn't block scan of file B", async () => {
    const r = await runAstRules({
      diff: diffWithEvalAt(1, "src/a.js") + diffWithEvalAt(1, "src/b.js"),
      filesByPath: new Map([
        ["src/a.js", `const x = ;`],         // syntax error
        ["src/b.js", `const x = eval("p")\n`],
      ]),
      reviewable: new Map([
        ["src/a.js", [{ line: 1, side: "RIGHT" }]],
        ["src/b.js", [{ line: 1, side: "RIGHT" }]],
      ]),
      config: DEFAULT_CONFIG,
      ctx: CTX,
    })
    expect(r.findings.length).toBe(1)
    expect(r.findings[0].path).toBe("src/b.js")
    expect(r.telemetry.filesParseFailed).toBe(1)
  })

  it("redacts long string literals in evidence", async () => {
    const longStr = "x".repeat(100)
    const r = await runAstRules({
      diff: diffWithEvalAt(1, "src/foo.js"),
      filesByPath: new Map([["src/foo.js", `const x = eval("${longStr}")\n`]]),
      reviewable: REVIEWABLE_AT("src/foo.js", 1),
      config: DEFAULT_CONFIG,
      ctx: CTX,
    })
    expect(r.findings.length).toBe(1)
    expect(r.findings[0].evidence).not.toContain(longStr)
    expect(r.findings[0].evidence).toContain("<redacted-literal>")
  })

  it.each([
    {
      ruleId: "no-await-in-loop",
      path: "src/awaits.ts",
      changedLine: 5,
      source: [
        "async function oldLoop(xs) {",
        "  for (const x of xs) await oldWork(x)",
        "}",
        "async function newLoop(xs) {",
        "  for (const x of xs) await newWork(x)",
        "}",
      ].join("\n"),
    },
    {
      ruleId: "no-spread-accumulator-in-loop",
      path: "src/spread.ts",
      changedLine: 5,
      source: [
        "let oldAcc = []",
        "for (const x of xs) { oldAcc = [...oldAcc, x] }",
        "",
        "let newAcc = []",
        "for (const x of xs) { newAcc = [...newAcc, x] }",
      ].join("\n"),
    },
    {
      ruleId: "no-allocation-in-loop",
      path: "src/allocation.ts",
      changedLine: 5,
      source: [
        "function oldOne(xs) {",
        "  for (const x of xs) { new RegExp(\"old\").test(x) }",
        "}",
        "function newOne(xs) {",
        "  for (const x of xs) { new RegExp(\"new\").test(x) }",
        "}",
      ].join("\n"),
    },
    {
      ruleId: "no-n-plus-one-call-in-loop",
      path: "src/n-plus-one.ts",
      changedLine: 5,
      source: [
        "async function oldOne(ids) {",
        "  for (const id of ids) { await db.query(\"old\") }",
        "}",
        "async function newOne(ids) {",
        "  for (const id of ids) { await db.query(\"new\") }",
        "}",
      ].join("\n"),
    },
    {
      ruleId: "no-sync-io-in-request-path",
      path: "src/app.ts",
      changedLine: 4,
      source: [
        "import fs from \"fs\"",
        "app.get(\"/old\", (req, res) => { fs.readFileSync(\"old\") })",
        "",
        "app.get(\"/new\", (req, res) => { fs.readFileSync(\"new\") })",
      ].join("\n"),
    },
  ])("emits changed $ruleId hit when an unchanged earlier hit exists", async ({
    ruleId,
    path,
    changedLine,
    source,
  }) => {
    const r = await runAstRules({
      diff: diffAddingLineAt(changedLine, path),
      filesByPath: new Map([[path, source]]),
      reviewable: REVIEWABLE_AT(path, changedLine),
      config: DEFAULT_CONFIG,
      ctx: CTX,
    })

    const findings = r.findings.filter((f) => f.ruleId === ruleId)
    expect(findings).toHaveLength(1)
    expect(findings[0].line).toBe(changedLine)
  })
})
