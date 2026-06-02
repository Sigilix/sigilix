// SIG-309: no-exec-shell-interpolation — flags exec()/execSync() with a
// dynamic (non-provably-constant) command; FP-safe on constant commands.

import { describe, it, expect } from "vitest"
import { parseSource } from "../src/lib/ast-rules/parser"
import { walkAst } from "../src/lib/ast-rules/walker"
import { noExecShellInterpolation } from "../src/lib/ast-rules/rules/no-exec-shell-interpolation"
import { ALL_RULES } from "../src/lib/ast-rules/rule-registry"
import type { AstRuleHit, AstRuleVisitResult } from "../src/lib/ast-rules/types"

function appendHits(out: AstRuleHit[], hit: AstRuleVisitResult): void {
  if (!hit) return
  if (Array.isArray(hit)) out.push(...hit)
  else out.push(hit)
}

function runRule(source: string, ext: ".js" | ".ts" | ".tsx" = ".js"): AstRuleHit[] {
  const r = parseSource(source, ext)
  if (!r.ok) throw new Error(`parse failed: ${r.reason}`)
  const hits: AstRuleHit[] = []
  walkAst(r.ast, {
    CallExpression(node) {
      appendHits(hits, noExecShellInterpolation.visit(node, { path: "test.js", source, ast: r.ast }))
    },
  })
  return hits
}

describe("no-exec-shell-interpolation — positive (dynamic command → flag)", () => {
  it("flags exec with an interpolated template (the pr/06 D2 sink)", () => {
    expect(runRule("exec(`convert ${path} -resize 200x200 ${out}`)").length).toBe(1)
  })
  it("flags execSync with a string concatenation of a non-literal", () => {
    expect(runRule(`execSync("rm -rf " + dir)`).length).toBe(1)
  })
  it("flags exec with a bare identifier command", () => {
    expect(runRule(`exec(cmd)`).length).toBe(1)
  })
  it("flags member-access cp.exec(...) with interpolation", () => {
    expect(runRule("cp.exec(`ls ${x}`)").length).toBe(1)
  })
  it("flags exec of a call-built command", () => {
    expect(runRule(`function buildCmd(){return ""} exec(buildCmd())`).length).toBe(1)
  })
  it("flags exec where only PART of a concat is constant", () => {
    expect(runRule("exec(`git checkout ` + branch)").length).toBe(1)
  })
})

describe("no-exec-shell-interpolation — negative (constant / not-exec → no flag)", () => {
  it("does NOT flag a plain string-literal command", () => {
    expect(runRule(`exec("ls -la")`).length).toBe(0)
  })
  it("does NOT flag a template with no interpolation", () => {
    expect(runRule("execSync(`ls -la`)").length).toBe(0)
  })
  it("does NOT flag a concatenation of two string literals", () => {
    expect(runRule(`exec("ls " + "-la")`).length).toBe(0)
  })
  it("does NOT flag spawn (covered by spawn-shell-true, not this rule)", () => {
    expect(runRule("spawn(`ls ${x}`)").length).toBe(0)
  })
  it("does NOT flag execFile (no shell — argv array)", () => {
    expect(runRule("execFile('convert', [path])").length).toBe(0)
  })
  it("does NOT flag an unrelated method named differently", () => {
    expect(runRule("obj.execute(`${x}`)").length).toBe(0)
  })
  it("does NOT flag a computed member call cp['exec'](...) (v1 scope)", () => {
    expect(runRule("cp['exec'](`ls ${x}`)").length).toBe(0)
  })
})

describe("no-exec-shell-interpolation — registry + TS surface", () => {
  it("is registered as an error-severity security rule", () => {
    const r = ALL_RULES.find((x) => x.id === "no-exec-shell-interpolation")
    expect(r).toBeTruthy()
    expect(r?.severity).toBe("error")
    expect(r?.roleHint).toBe("security")
  })
  it("flags an interpolated exec in TS too", () => {
    expect(runRule("const out: string = ''; exec(`convert ${out}`)", ".ts").length).toBe(1)
  })
})
