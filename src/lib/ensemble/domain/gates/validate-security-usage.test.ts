// SIG-311 Layers A+B: security usage-vs-mention validator. DEMOTE a sev>=4
// injection/xss finding only when path-is-mention-surface AND token-is-non-
// executable AND file-adds-no-real-sink — a strict conjunction that fails closed
// to KEEP (hiding a real P0 ≫ worse than the FP).

import { describe, it, expect } from "vitest"
import { evaluateSecurityUsage, parseSecurityUsageValidatorMode } from "@/lib/ensemble/domain/gates/validate-security-usage"
import type { PrReviewFinding } from "@/lib/triage-pr-review"

function finding(over: Partial<PrReviewFinding> & { cweId?: string }): PrReviewFinding {
  return {
    path: "src/lib/ast-rules/detector.ts",
    line: 10,
    score: 5,
    category: "security",
    cweId: "CWE-78", // injection by default
    headline: "x",
    body: "x",
    ...over,
  } as PrReviewFinding
}

/** A context whose file has the given per-line added text (line→text). */
function ctx(path: string, lines: Record<number, string>) {
  const inner = new Map<number, string>(Object.entries(lines).map(([k, v]) => [Number(k), v]))
  return { addedLineTextByLine: new Map([[path, inner]]) }
}
const demoted = (d: ReturnType<typeof evaluateSecurityUsage>) => d.keep === false
const kept = (d: ReturnType<typeof evaluateSecurityUsage>) => d.keep === true

describe("parseSecurityUsageValidatorMode", () => {
  it("defaults to off; parses shadow/enforce case-insensitively", () => {
    expect(parseSecurityUsageValidatorMode(undefined)).toBe("off")
    expect(parseSecurityUsageValidatorMode("xyz")).toBe("off")
    expect(parseSecurityUsageValidatorMode(" SHADOW ")).toBe("shadow")
    expect(parseSecurityUsageValidatorMode("enforce")).toBe("enforce")
  })
})

describe("evaluateSecurityUsage — DEMOTE (the PR #296 mention family)", () => {
  it("demotes an injection P0 on `re.exec` in a detector (the PR #296 shape)", () => {
    const f = finding({ path: "src/lib/ast-rules/scan-dynamic-html-sink.ts", line: 10 })
    const c = ctx(f.path, { 10: "  for (const re of X) { re.exec(line); }" })
    expect(demoted(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("demotes an injection P0 where `execSync` is only in a string literal in a validator", () => {
    const f = finding({ path: "src/lib/validate-foo.ts", line: 10 })
    const c = ctx(f.path, { 10: `  const hint = "use execSync(cmd) carefully";` })
    expect(demoted(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("demotes a multiline rule-message mention when the model anchors the neighboring line", () => {
    const f = finding({ path: "src/lib/ast-rules/rules/no-exec-shell-interpolation.ts", line: 12 })
    const c = ctx(f.path, {
      10: "  message:",
      11: '    "`exec()` with a dynamic command is a command-injection sink; use `execFile` instead.",',
      12: '  docs: "Flags shell interpolation.",',
    })
    expect(demoted(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("demotes a nearby mention when prose shifts the model anchor beyond two lines", () => {
    const f = finding({ path: "src/lib/ast-rules/rules/no-exec-shell-interpolation.ts", line: 15 })
    const c = ctx(f.path, {
      10: '    "`exec()` with a dynamic command is a command-injection sink; use `execFile` instead.",',
      15: '  docs: "Prefer argv APIs and avoid shells.",',
    })
    expect(demoted(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("demotes an injection mention in a markdown code example", () => {
    const f = finding({ path: "docs/security-rules.md", line: 8 })
    const c = ctx(f.path, { 8: "exec(`convert ${path}`)" })
    expect(demoted(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("demotes an xss mention where document.write is only in a test name", () => {
    const f = finding({ path: "tests/dom-sink.test.ts", line: 10, cweId: "CWE-79" })
    const c = ctx(f.path, { 10: `  it("flags document.write(userHtml)", () => {});` })
    expect(demoted(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("demotes an xss P0 where `dangerouslySetInnerHTML` is only a test describe-string", () => {
    const f = finding({ path: "tests/seat-panel.test.ts", line: 10, cweId: "CWE-79" })
    const c = ctx(f.path, { 10: `  it("flags dangerouslySetInnerHTML on noteHtml", () => {});` })
    expect(demoted(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("demotes an xss test-name mention even when the model over-justifies it", () => {
    const f = finding({
      path: "tests/seat-panel.test.ts",
      line: 10,
      cweId: "CWE-79",
      independentAssessment: "The test name mentions dangerouslySetInnerHTML with attacker-controlled HTML.",
    })
    const c = ctx(f.path, { 10: `  it("flags dangerouslySetInnerHTML on noteHtml", () => {});` })
    expect(demoted(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("demotes an injection finding where the call is only inside a // comment", () => {
    const f = finding({ path: "src/lib/ast-rules/runner.ts", line: 10 })
    const c = ctx(f.path, { 10: "  // a real exec(`rm ${x}`) here would be a shell sink — but this is prose" })
    expect(demoted(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("demotes vague independentAssessment text that does not cite concrete sink evidence", () => {
    const f = finding({
      path: "src/lib/ast-rules/x.ts",
      line: 10,
      independentAssessment: "This looks like a possible command injection risk in the changed rule text.",
    })
    const c = ctx(f.path, { 10: `  const message = "exec(userInput) is unsafe";` })
    expect(demoted(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("demotes an assessment that only quotes template example syntax", () => {
    const f = finding({
      path: "docs/security-rules.md",
      line: 10,
      independentAssessment: "The docs show `exec(`convert ${path}`)` as the unsafe example.",
    })
    const c = ctx(f.path, { 10: "exec(`convert ${path}`)" })
    expect(demoted(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("demotes an exec-sink phrase with no source or code location", () => {
    const f = finding({
      path: "tests/shell-rule.test.ts",
      line: 10,
      independentAssessment: "The test name mentions an exec sink.",
    })
    const c = ctx(f.path, { 10: `  it("flags exec(userInput)", () => {});` })
    expect(demoted(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it.each(["none", "n/a", "not applicable", "unknown", "   "])(
    "demotes when independentAssessment is not positive sink evidence: %s",
    (independentAssessment) => {
      const f = finding({
        path: "src/lib/ast-rules/x.ts",
        line: 10,
        independentAssessment,
      })
      const c = ctx(f.path, { 10: `  const message = "exec(userInput) is unsafe";` })
      expect(demoted(evaluateSecurityUsage(f, c))).toBe(true)
    },
  )
})

describe("evaluateSecurityUsage — KEEP (recall guards — never hide a real P0)", () => {
  it("KEEPS a real exec in a non-mention application path (A fails)", () => {
    const f = finding({ path: "src/server/jobs.ts", line: 10 })
    const c = ctx(f.path, { 10: "  exec(`convert ${userPath} out.png`);" })
    expect(kept(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("KEEPS a span that holds BOTH re.exec AND a real execSync (CodeRabbit #317)", () => {
    const f = finding({ path: "src/lib/ast-rules/x.ts", line: 11, startLine: 10 })
    const c = ctx(f.path, { 10: "  re.exec(line);", 11: "  execSync(`rm ${dir}`);" })
    expect(kept(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("KEEPS a REAL executable exec even on a detector path (B fails — not a mention)", () => {
    const f = finding({ path: "src/lib/ast-rules/x.ts", line: 10 })
    const c = ctx(f.path, { 10: "  child_process.exec(`rm ${dir}`);" })
    expect(kept(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("KEEPS a real executable dangerouslySetInnerHTML on a test path (B fails)", () => {
    const f = finding({ path: "tests/x.test.ts", line: 10, cweId: "CWE-79" })
    const c = ctx(f.path, { 10: "  return <div dangerouslySetInnerHTML={{ __html: userInput }} />;" })
    expect(kept(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("KEEPS a real executable document.write sink on a test path (B fails)", () => {
    const f = finding({ path: "tests/x.test.ts", line: 10, cweId: "CWE-79" })
    const c = ctx(f.path, { 10: "  document.write(userHtml);" })
    expect(kept(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("KEEPS an xss string mention when the FILE also adds document.write", () => {
    const f = finding({ path: "tests/x.test.ts", line: 10, cweId: "CWE-79" })
    const c = ctx(f.path, {
      10: `  const message = "document.write(userHtml) is unsafe";`,
      12: "  document.write(userHtml);",
    })
    expect(kept(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("KEEPS mdx because it is not treated as a markdown-prose path", () => {
    const f = finding({ path: "docs/example.mdx", line: 10 })
    const c = ctx(f.path, { 10: "exec(`convert ${path}`)" })
    expect(kept(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("KEEPS a re.exec mention when the FILE also imports child_process (C — harness guard)", () => {
    const f = finding({ path: "src/lib/ast-rules/x.ts", line: 10 })
    const c = ctx(f.path, { 5: `import { exec } from "child_process";`, 10: "  re.exec(line);" })
    expect(kept(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("KEEPS a re.exec mention when the FILE also requires child_process (C — harness guard)", () => {
    const f = finding({ path: "src/lib/ast-rules/x.ts", line: 10 })
    const c = ctx(f.path, { 5: `const { exec } = require("child_process");`, 10: "  re.exec(line);" })
    expect(kept(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("KEEPS a re.exec mention when the FILE also requires child_process with a template literal", () => {
    const f = finding({ path: "src/lib/ast-rules/x.ts", line: 10 })
    const c = ctx(f.path, { 5: "const { exec } = require(`child_process`);", 10: "  re.exec(line);" })
    expect(kept(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("KEEPS a re.exec mention when the FILE also dynamically imports child_process (C — harness guard)", () => {
    const f = finding({ path: "src/lib/ast-rules/x.ts", line: 10 })
    const c = ctx(f.path, { 5: `const { exec } = await import("node:child_process");`, 10: "  re.exec(line);" })
    expect(kept(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("KEEPS a mention when the FILE imports an external shell runner (C — harness guard)", () => {
    const f = finding({ path: "src/lib/ast-rules/x.ts", line: 10 })
    const c = ctx(f.path, { 5: `import { execa } from "execa";`, 10: "  re.exec(line);" })
    expect(kept(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("KEEPS a string mention when the FILE also adds an executable exec call without its import", () => {
    const f = finding({ path: "src/lib/ast-rules/x.ts", line: 10 })
    const c = ctx(f.path, {
      10: `  const message = "exec(userInput) is unsafe";`,
      12: "  exec(userInput);",
    })
    expect(kept(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("KEEPS when the widened nearby window also contains a real executable sink", () => {
    const f = finding({ path: "src/lib/ast-rules/x.ts", line: 47 })
    const c = ctx(f.path, {
      42: "  const msg = `exec(userInput) is unsafe`;",
      44: "  execSync(userDir);",
      47: "  const anchor = true;",
    })
    expect(kept(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("KEEPS a mention-line finding when the specialist supplies positive sink proof", () => {
    const f = finding({
      path: "src/lib/ast-rules/x.ts",
      line: 10,
      independentAssessment: "Resolved `runUserCommand` to a pre-existing `child_process.exec` sink fed by req.query.cmd.",
    })
    const c = ctx(f.path, { 10: `  const message = "exec(userInput) is unsafe";` })
    expect(kept(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("KEEPS natural concrete sink proof phrased as user-supplied data reaching a shell sink", () => {
    const f = finding({
      path: "src/lib/ast-rules/x.ts",
      line: 10,
      independentAssessment: "User-supplied `req.body.cmd` reaches the shell sink at src/jobs/convert.ts:5.",
    })
    const c = ctx(f.path, { 10: `  const message = "exec(userInput) is unsafe";` })
    expect(kept(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("KEEPS a sub-threshold (score 3) finding", () => {
    const f = finding({ path: "src/lib/ast-rules/x.ts", line: 10, score: 3 })
    const c = ctx(f.path, { 10: "  re.exec(line);" })
    expect(kept(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("KEEPS when no diff is wired", () => {
    const f = finding({ path: "src/lib/ast-rules/x.ts", line: 10 })
    expect(kept(evaluateSecurityUsage(f, { addedLineTextByLine: undefined }))).toBe(true)
  })
  it("KEEPS when the cited line isn't a resolved added line (not in hand)", () => {
    const f = finding({ path: "src/lib/ast-rules/x.ts", line: 99 })
    const c = ctx(f.path, { 10: "  re.exec(line);" })
    expect(kept(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("KEEPS a non-gated bucket (authn / IDOR — no line signature)", () => {
    const f = finding({ path: "src/lib/ast-rules/x.ts", line: 10, cweId: "CWE-639" })
    const c = ctx(f.path, { 10: "  re.exec(line);" })
    expect(kept(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("KEEPS when the bucket token isn't present on the cited line", () => {
    const f = finding({ path: "src/lib/ast-rules/x.ts", line: 10 })
    const c = ctx(f.path, { 10: "  const x = 1 + 2;" })
    expect(kept(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("KEEPS a multi-line citation that spans an unresolved context line", () => {
    const f = finding({ path: "src/lib/ast-rules/x.ts", line: 11, startLine: 10 })
    const c = ctx(f.path, { 11: "  re.exec(line);" }) // line 10 absent → partial range → keep
    expect(kept(evaluateSecurityUsage(f, c))).toBe(true)
  })
})
