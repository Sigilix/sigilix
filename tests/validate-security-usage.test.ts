// SIG-311 Layers A+B: security usage-vs-mention validator. DEMOTE a sev>=4
// injection/xss finding only when path-is-mention-surface AND token-is-non-
// executable AND file-adds-no-real-sink — a strict conjunction that fails closed
// to KEEP (hiding a real P0 ≫ worse than the FP).

import { describe, it, expect } from "vitest"
import { evaluateSecurityUsage, parseSecurityUsageValidatorMode } from "../src/lib/validate-security-usage"
import type { PrReviewFinding } from "../src/lib/triage-pr-review"

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
  it("demotes an xss P0 where `dangerouslySetInnerHTML` is only a test describe-string", () => {
    const f = finding({ path: "tests/seat-panel.test.ts", line: 10, cweId: "CWE-79" })
    const c = ctx(f.path, { 10: `  it("flags dangerouslySetInnerHTML on noteHtml", () => {});` })
    expect(demoted(evaluateSecurityUsage(f, c))).toBe(true)
  })
  it("demotes an injection finding where the call is only inside a // comment", () => {
    const f = finding({ path: "src/lib/ast-rules/runner.ts", line: 10 })
    const c = ctx(f.path, { 10: "  // a real exec(`rm ${x}`) here would be a shell sink — but this is prose" })
    expect(demoted(evaluateSecurityUsage(f, c))).toBe(true)
  })
})

describe("evaluateSecurityUsage — KEEP (recall guards — never hide a real P0)", () => {
  it("KEEPS a real exec in a non-mention application path (A fails)", () => {
    const f = finding({ path: "src/server/jobs.ts", line: 10 })
    const c = ctx(f.path, { 10: "  exec(`convert ${userPath} out.png`);" })
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
  it("KEEPS a re.exec mention when the FILE also imports child_process (C — harness guard)", () => {
    const f = finding({ path: "src/lib/ast-rules/x.ts", line: 10 })
    const c = ctx(f.path, { 5: `import { exec } from "child_process";`, 10: "  re.exec(line);" })
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
