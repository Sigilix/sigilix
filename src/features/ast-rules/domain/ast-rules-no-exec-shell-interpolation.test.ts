// SIG-309: no-exec-shell-interpolation — flags exec()/execSync() with a
// dynamic (non-provably-constant) command; FP-safe on constant commands.
// SIG-311: only emits when exec/execSync provably resolves to a child_process
// binding (kills the re.exec/db.exec self-FP — dogfood PR #296).

import { describe, it, expect } from "vitest"
import { parseSource } from "@/src/features/ast-rules/domain/parser"
import { walkAst } from "@/src/features/ast-rules/domain/walker"
import { noExecShellInterpolation } from "@/src/features/ast-rules/domain/rules/no-exec-shell-interpolation"
import { ALL_RULES } from "@/src/features/ast-rules/domain/rule-registry"
import type { AstRuleHit, AstRuleVisitResult } from "@/src/features/ast-rules/domain/types"

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

// A real exec/execSync is always imported from child_process — the rule now
// requires that binding, so realistic snippets carry the import.
const CP = `import { exec, execSync } from "child_process";\n`
const CP_NS = `import cp from "child_process";\n`

describe("no-exec-shell-interpolation — positive (dynamic command → flag)", () => {
  it("flags exec with an interpolated template (the pr/06 D2 sink)", () => {
    expect(runRule(CP + "exec(`convert ${path} -resize 200x200 ${out}`)").length).toBe(1)
  })
  it("flags execSync with a string concatenation of a non-literal", () => {
    expect(runRule(CP + `execSync("rm -rf " + dir)`).length).toBe(1)
  })
  it("flags exec with a bare identifier command", () => {
    expect(runRule(CP + `exec(cmd)`).length).toBe(1)
  })
  it("flags member-access cp.exec(...) with interpolation", () => {
    expect(runRule(CP_NS + "cp.exec(`ls ${x}`)").length).toBe(1)
  })
  it("flags exec of a call-built command", () => {
    expect(runRule(CP + `function buildCmd(){return ""} exec(buildCmd())`).length).toBe(1)
  })
  it("flags exec where only PART of a concat is constant", () => {
    expect(runRule(CP + "exec(`git checkout ` + branch)").length).toBe(1)
  })
  it("sets endLine on a multi-line exec call (diff-filter contract, CodeRabbit #292)", () => {
    const hits = runRule(CP + "exec(\n  `convert ${path}`\n  + flags\n)")
    expect(hits.length).toBe(1)
    expect(hits[0].endLine).toBeGreaterThan(hits[0].line)
  })
})

describe("no-exec-shell-interpolation — SIG-311 import-binding resolution", () => {
  // RECALL: every real child_process import form still emits.
  it("emits for `const { exec } = require('child_process')`", () => {
    expect(runRule(`const { exec } = require("child_process"); exec(\`x \${y}\`)`).length).toBe(1)
  })
  it("emits for an aliased destructured `require('child_process')` binding", () => {
    expect(runRule(`const { exec: run } = require("child_process"); run(\`x \${y}\`)`).length).toBe(1)
  })
  it("emits for an aliased destructured require binding with a default", () => {
    expect(runRule(`const { exec: run = fallback } = require("child_process"); run(\`x \${y}\`)`).length).toBe(1)
  })
  it("emits for an aliased named import from child_process", () => {
    expect(runRule(`import { execSync as runSync } from "child_process"; runSync(\`x \${y}\`)`).length).toBe(1)
  })
  it("emits for a comma declarator destructured `require('child_process')` binding", () => {
    expect(runRule(`let ignored, { exec } = require("child_process"); exec(\`x \${y}\`)`).length).toBe(1)
  })
  it("emits for parenthesized destructured `require('child_process')` assignment", () => {
    expect(runRule(`let exec; ({ exec } = require("child_process")); exec(\`x \${y}\`)`).length).toBe(1)
  })
  it("emits for `import * as cp from 'node:child_process'` + cp.execSync", () => {
    expect(runRule(`import * as cp from "node:child_process"; cp.execSync(\`x \${y}\`)`).length).toBe(1)
  })
  it("emits for `const cp = require('child_process')` + cp.exec", () => {
    expect(runRule(`const cp = require("child_process"); cp.exec("a " + b)`).length).toBe(1)
  })
  it("emits for a predeclared namespace assigned from require('child_process')", () => {
    expect(runRule(`let cp; cp = require("child_process"); cp.exec(\`x \${y}\`)`).length).toBe(1)
  })
  it("emits for a comma declarator namespace assigned from require('child_process')", () => {
    expect(runRule(`let ignored = 1, cp = require("child_process"); cp.exec(\`x \${y}\`)`).length).toBe(1)
  })
  it("emits for destructuring exec from a child_process namespace", () => {
    expect(runRule(`import cp from "child_process"; const { exec } = cp; exec(\`x \${y}\`)`).length).toBe(1)
  })
  it("emits for destructuring exec from a predeclared child_process namespace", () => {
    expect(runRule(`let cp; cp = require("child_process"); const { exec } = cp; exec(\`x \${y}\`)`).length).toBe(1)
  })
  it("emits for comma declarator destructuring from a child_process namespace", () => {
    expect(runRule(`const cp = require("child_process"); let ignored, { exec } = cp; exec(\`x \${y}\`)`).length).toBe(1)
  })
  it("emits for a local alias assigned from a child_process namespace method", () => {
    expect(runRule(`const cp = require("child_process"); const run = cp.exec; run(\`x \${y}\`)`).length).toBe(1)
  })
  it("emits for a comma declarator local alias assigned from a namespace method", () => {
    expect(
      runRule(`const cp = require("child_process"); let ignored, run = cp.execSync; run(\`x \${y}\`)`).length,
    ).toBe(1)
  })
  it("emits for a reassigned local alias from a namespace method", () => {
    expect(runRule(`const cp = require("child_process"); let run; run = cp.exec; run(\`x \${y}\`)`).length).toBe(1)
  })
  it("emits for an aliased destructure from a child_process namespace", () => {
    expect(runRule(`const cp = require("child_process"); const { exec: run } = cp; run(\`x \${y}\`)`).length).toBe(1)
  })
  it("emits for inline `require('child_process').exec(...)`", () => {
    expect(runRule('require("child_process").exec(`run ${cmd}`)').length).toBe(1)
  })
  it("emits for a local alias assigned from require('child_process').exec", () => {
    expect(runRule(`const run = require("child_process").exec; run(\`x \${y}\`)`).length).toBe(1)
  })
  it("emits for a reassigned local alias from require('child_process').execSync", () => {
    expect(runRule(`let run; run = require("child_process").execSync; run(\`x \${y}\`)`).length).toBe(1)
  })
  it("emits for inline require(`child_process`).exec(...) with a constant template specifier", () => {
    expect(runRule("require(`child_process`).exec(`run ${cmd}`)").length).toBe(1)
  })
  // Dynamic import bindings are explicit child_process bindings too — keep this
  // recall path without falling back to every `.exec(...)` in the file.
  it("emits for a dynamic import('child_process') namespace binding", () => {
    expect(
      runRule(`async function f(){ const cp = await import("child_process"); cp.exec(\`x \${cmd}\`); }`).length,
    ).toBe(1)
  })
  it("emits for a dynamic import(`child_process`) namespace binding", () => {
    expect(runRule("async function f(){ const cp = await import(`child_process`); cp.exec(`x ${cmd}`); }").length).toBe(
      1,
    )
  })
  it("emits for a dynamic import('child_process') destructured binding", () => {
    expect(
      runRule(`async function f(){ const { exec } = await import("child_process"); exec(\`run \${x}\`); }`).length,
    ).toBe(1)
  })
  it("emits for an aliased dynamic import('child_process') destructured binding", () => {
    expect(
      runRule(`async function f(){ const { exec: run } = await import("child_process"); run(\`run \${x}\`); }`).length,
    ).toBe(1)
  })
  it("emits for a parenthesized dynamic import('child_process') destructured assignment", () => {
    expect(
      runRule(
        `async function f(){ let execSync; ({ execSync } = await import("child_process")); execSync(\`run \${x}\`); }`,
      ).length,
    ).toBe(1)
  })
  it("does NOT treat `export { exec } from 'child_process'` as a local callable binding", () => {
    // Node ESM confirms an indirect re-export is not callable in the same module:
    // `export { readFile } from "node:fs"; readFile(...)` throws ReferenceError.
    expect(runRule(`export { exec } from "child_process";\nexec(\`run \${x}\`)`).length).toBe(0)
  })
  it("does NOT match a substring module name (./child_process_extra)", () => {
    expect(runRule(`import { exec } from "./child_process_extra"; exec(\`x \${y}\`)`).length).toBe(0)
  })
  // PRECISION (the PR #296 family): a same-named .exec on a NON-child_process
  // receiver, or a bare exec with no child_process import, is NOT a shell sink.
  it("does NOT flag re.exec(line) (RegExp.exec — the PR #296 self-FP)", () => {
    expect(runRule("const re = /x/g; re.exec(line)").length).toBe(0)
  })
  it("does NOT flag re.exec(line) in a file that also imports child_process", () => {
    expect(runRule(CP + "const re = /x/g; re.exec(line)").length).toBe(0)
  })
  it("does NOT flag db.exec(sql) (no child_process in file)", () => {
    expect(runRule("db.exec(`SELECT ${id}`)").length).toBe(0)
  })
  it("does NOT flag db.exec(sql) in a file that also imports child_process", () => {
    expect(runRule(CP + "db.exec(`SELECT ${id}`)").length).toBe(0)
  })
  it("does NOT flag non-identifier receiver expressions when child_process imports exec", () => {
    expect(runRule(CP + "getDb().exec(`SELECT ${id}`)").length).toBe(0)
  })
  it("does NOT flag stmt.exec(...) (no child_process in file)", () => {
    expect(runRule("stmt.exec(params)").length).toBe(0)
  })
  it("does NOT flag a bare exec(...) with no child_process import", () => {
    expect(runRule("exec(`echo ${x}`)").length).toBe(0)
  })
  it("does NOT flag exec imported from a DIFFERENT module", () => {
    expect(runRule(`import { exec } from "./my-runner"; exec(\`x \${y}\`)`).length).toBe(0)
  })
  it("does NOT treat an object method as child_process just because it wraps exec", () => {
    expect(
      runRule(`const { exec } = require("child_process"); const wrapper = { exec }; wrapper.exec(\`x \${y}\`)`).length,
    ).toBe(0)
  })
  it("does NOT infer a namespace from an object-literal property named cp", () => {
    expect(
      runRule(`const holder = { cp: require("child_process") }; const cp = { exec() {} }; cp.exec(\`x \${y}\`)`).length,
    ).toBe(0)
  })
})

describe("no-exec-shell-interpolation — negative (constant / not-exec → no flag)", () => {
  it("does NOT flag a plain string-literal command", () => {
    expect(runRule(CP + `exec("ls -la")`).length).toBe(0)
  })
  it("does NOT flag a template with no interpolation", () => {
    expect(runRule(CP + "execSync(`ls -la`)").length).toBe(0)
  })
  it("does NOT flag a concatenation of two string literals", () => {
    expect(runRule(CP + `exec("ls " + "-la")`).length).toBe(0)
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
    expect(runRule(CP_NS + "cp['exec'](`ls ${x}`)").length).toBe(0)
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
    expect(runRule(CP + "const out: string = ''; exec(`convert ${out}`)", ".ts").length).toBe(1)
  })
})
