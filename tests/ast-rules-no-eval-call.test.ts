// ARC-181: no-eval-call rule — 3+ positive + 3+ negative fixtures
// per Linear AC, plus TS-surface smoke (eval injected into each TS
// fixture from Task 1, moved here per Codex BLOCKING #1).

import { describe, it, expect } from "vitest"
import { parseSource } from "../src/lib/ast-rules/parser"
import { walkAst } from "../src/lib/ast-rules/walker"
import { noEvalCall } from "../src/lib/ast-rules/rules/no-eval-call"
import { getEnabledRules, ALL_RULES } from "../src/lib/ast-rules/rule-registry"
import type { AstRuleHit } from "../src/lib/ast-rules/types"

function runRule(source: string, ext: ".js" | ".ts" | ".tsx" = ".js"): AstRuleHit[] {
  const r = parseSource(source, ext)
  if (!r.ok) throw new Error(`parse failed: ${r.reason}`)
  const hits: AstRuleHit[] = []
  walkAst(r.ast, {
    CallExpression(node) {
      const hit = noEvalCall.visit(node, { path: "test.js", source, ast: r.ast })
      if (hit) hits.push(hit)
    },
  })
  return hits
}

describe("no-eval-call — positive fixtures", () => {
  it("flags eval(x)", () => {
    expect(runRule(`eval(x)`).length).toBe(1)
  })

  it("flags eval(\"...\")", () => {
    expect(runRule(`eval("alert(1)")`).length).toBe(1)
  })

  it("flags eval(getInput())", () => {
    expect(runRule(`function getInput(){return ""} eval(getInput())`).length).toBe(1)
  })

  it("flags eval at any depth", () => {
    expect(runRule(`if (cond) { eval(x) }`).length).toBe(1)
  })
})

describe("no-eval-call — negative fixtures", () => {
  it("does NOT flag obj.eval(x) (member access)", () => {
    expect(runRule(`obj.eval(x)`).length).toBe(0)
  })

  it("does NOT flag eval inside a comment", () => {
    expect(runRule(`// eval(x)\nconst y = 1;`).length).toBe(0)
  })

  it("does NOT flag eval inside a string literal", () => {
    expect(runRule(`const s = "eval(x)"`).length).toBe(0)
  })

  it("does NOT flag a different identifier (myEval)", () => {
    expect(runRule(`function myEval(x){return x} myEval(1)`).length).toBe(0)
  })

  it("does NOT flag a property named eval without bare-Identifier call", () => {
    expect(runRule(`const obj = { eval: (x) => x }; obj.eval(1)`).length).toBe(0)
  })
})

describe("no-eval-call — TS-surface smoke (Codex BLOCKING #1: moved from parser tests)", () => {
  const fixtures: Array<{ name: string; ext: ".ts" | ".tsx"; before: string }> = [
    { name: "TSX", ext: ".tsx", before: `const el: JSX.Element = <div>x</div>;` },
    { name: "decorators", ext: ".ts", before: `function Cached(){return (t: unknown)=>t} @Cached() class X {}` },
    { name: "import attributes", ext: ".ts", before: `import data from "./d.json" with { type: "json" };` },
    { name: "satisfies operator", ext: ".ts", before: `const x = { a: 1 } satisfies { a: number };` },
    { name: "enums", ext: ".ts", before: `enum Color { Red, Green, Blue }` },
    { name: "namespaces", ext: ".ts", before: `namespace Foo { export const x = 1 }` },
    { name: "mixed JSX-in-TS", ext: ".tsx", before: `type P={x:number}; const C=(p:P):JSX.Element=><div>{p.x}</div>;` },
  ]
  for (const f of fixtures) {
    it(`flags eval inside ${f.name} fixture`, () => {
      const code = `${f.before}\nfunction handler() { eval("payload") }`
      expect(runRule(code, f.ext).length).toBe(1)
    })
  }
})

describe("rule-registry — getEnabledRules", () => {
  it("returns all rules when enabled + at default threshold", () => {
    const out = getEnabledRules({
      enabled: true, severityThreshold: "warning", disabledRules: [], autoInline: false,
    })
    expect(out.length).toBe(ALL_RULES.length)
  })

  it("returns empty when disabled", () => {
    const out = getEnabledRules({
      enabled: false, severityThreshold: "warning", disabledRules: [], autoInline: false,
    })
    expect(out.length).toBe(0)
  })

  it("excludes disabledRules entries", () => {
    const out = getEnabledRules({
      enabled: true, severityThreshold: "warning", disabledRules: ["no-eval-call"], autoInline: false,
    })
    expect(out.find((r) => r.id === "no-eval-call")).toBeUndefined()
  })

  it("threshold error keeps error+, drops warning+", () => {
    const out = getEnabledRules({
      enabled: true, severityThreshold: "error", disabledRules: [], autoInline: false,
    })
    for (const r of out) expect(r.severity).toBe("error")
  })

  it("threshold info keeps everything", () => {
    const out = getEnabledRules({
      enabled: true, severityThreshold: "info", disabledRules: [], autoInline: false,
    })
    expect(out.length).toBe(ALL_RULES.length)
  })
})
