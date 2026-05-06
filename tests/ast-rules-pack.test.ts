// ARC-181 — full rule-pack tests. Each rule gets 3+ positive +
// 3+ negative fixtures per Linear AC. Plus the ALL_RULES registry
// contract test (Codex MAJOR #3) locking the 10-rule set.

import { describe, it, expect } from "vitest"
import { parseSource } from "../src/lib/ast-rules/parser"
import { walkAst } from "../src/lib/ast-rules/walker"
import { ALL_RULES } from "../src/lib/ast-rules/rule-registry"
import type { AstRule, AstRuleHit } from "../src/lib/ast-rules/types"

function runRule(rule: AstRule, source: string, ext: ".js" | ".ts" = ".js"): AstRuleHit[] {
  const r = parseSource(source, ext)
  if (!r.ok) throw new Error(`parse failed: ${r.reason}`)
  const hits: AstRuleHit[] = []
  const visitors: Record<string, (n: unknown) => void> = {}
  for (const t of rule.nodeTypes) {
    visitors[t] = (n: unknown) => {
      const hit = rule.visit(n, { path: "test.js", source, ast: r.ast })
      if (hit) hits.push(hit)
    }
  }
  walkAst(r.ast, visitors)
  return hits
}

function ruleById(id: string): AstRule {
  const r = ALL_RULES.find((x) => x.id === id)
  if (!r) throw new Error(`rule not found: ${id}`)
  return r
}

// ─── ALL_RULES registry contract (Codex MAJOR #3) ───────────────

describe("ALL_RULES registry — v1 contract", () => {
  it("exports exactly 10 rules in the canonical order", () => {
    expect(ALL_RULES.map((r) => r.id)).toEqual([
      "no-eval-call",
      "no-new-function-constructor",
      "spawn-shell-true",
      "no-disabled-tls-reject-unauthorized",
      "no-document-write-call",
      "no-async-without-await",
      "no-throw-literal",
      "no-await-in-loop",
      "no-floating-promise-call-known-async",
      "no-process-env-mutation",
    ])
  })

  it("locks per-rule severity + roleHint", () => {
    const expected: Record<string, { severity: string; roleHint: string }> = {
      "no-eval-call":                          { severity: "error",   roleHint: "security" },
      "no-new-function-constructor":           { severity: "error",   roleHint: "security" },
      "spawn-shell-true":                      { severity: "error",   roleHint: "security" },
      "no-disabled-tls-reject-unauthorized":   { severity: "error",   roleHint: "security" },
      "no-document-write-call":                { severity: "error",   roleHint: "security" },
      "no-async-without-await":                { severity: "warning", roleHint: "logic" },
      "no-throw-literal":                      { severity: "warning", roleHint: "logic" },
      "no-await-in-loop":                      { severity: "warning", roleHint: "performance" },
      "no-floating-promise-call-known-async":  { severity: "warning", roleHint: "logic" },
      "no-process-env-mutation":               { severity: "warning", roleHint: "logic" },
    }
    for (const r of ALL_RULES) {
      expect({ severity: r.severity, roleHint: r.roleHint }).toEqual(expected[r.id])
    }
  })
})

// ─── no-new-function-constructor ────────────────────────────────

describe("no-new-function-constructor", () => {
  const r = ruleById("no-new-function-constructor")
  it("flags new Function('x')",      () => expect(runRule(r, `new Function("x")`).length).toBe(1))
  it("flags new Function(a, b, c)",  () => expect(runRule(r, `new Function("a", "b", "return a+b")`).length).toBe(1))
  it("flags new Function() empty",   () => expect(runRule(r, `new Function()`).length).toBe(1))
  it("does NOT flag Function('x') without new", () => expect(runRule(r, `Function("x")`).length).toBe(0))
  it("does NOT flag new MyFunction()",          () => expect(runRule(r, `function MyFunction(){}; new MyFunction()`).length).toBe(0))
  it("does NOT flag function declarations",     () => expect(runRule(r, `function Function(){return 1}`).length).toBe(0))
})

// ─── spawn-shell-true ───────────────────────────────────────────

describe("spawn-shell-true", () => {
  const r = ruleById("spawn-shell-true")
  it("flags spawn(cmd, args, {shell:true})",         () => expect(runRule(r, `spawn("c", ["a"], {shell: true})`).length).toBe(1))
  it("flags spawnSync(cmd, {shell:true})",           () => expect(runRule(r, `spawnSync("c", {shell: true})`).length).toBe(1))
  it("flags execFile(cmd, {shell:true})",            () => expect(runRule(r, `execFile("c", {shell: true})`).length).toBe(1))
  it("does NOT flag spawn without shell:true",       () => expect(runRule(r, `spawn("c", ["a"])`).length).toBe(0))
  it("does NOT flag spawn with shell:false",         () => expect(runRule(r, `spawn("c", {shell: false})`).length).toBe(0))
  it("does NOT flag exec({shell:true}) (Codex #7)",  () => expect(runRule(r, `exec("c", {shell: true})`).length).toBe(0))
})

// ─── no-disabled-tls-reject-unauthorized ────────────────────────

describe("no-disabled-tls-reject-unauthorized", () => {
  const r = ruleById("no-disabled-tls-reject-unauthorized")
  it("flags { rejectUnauthorized: false }",       () => expect(runRule(r, `const opts = { rejectUnauthorized: false }`).length).toBe(1))
  it("flags { rejectUnauthorized: false } in arg",() => expect(runRule(r, `https.request("u", { rejectUnauthorized: false })`).length).toBe(1))
  it("flags nested object with the prop",         () => expect(runRule(r, `const c = { tls: { rejectUnauthorized: false } }`).length).toBe(1))
  it("does NOT flag rejectUnauthorized: true",    () => expect(runRule(r, `const opts = { rejectUnauthorized: true }`).length).toBe(0))
  it("does NOT flag missing prop",                () => expect(runRule(r, `const opts = { ca: "..." }`).length).toBe(0))
  it("does NOT flag a rejectUnauthorized variable",() => expect(runRule(r, `const rejectUnauthorized = false`).length).toBe(0))
})

// ─── no-document-write-call ─────────────────────────────────────

describe("no-document-write-call", () => {
  const r = ruleById("no-document-write-call")
  it("flags document.write('x')",    () => expect(runRule(r, `document.write("x")`).length).toBe(1))
  it("flags document.writeln('x')",  () => expect(runRule(r, `document.writeln("x")`).length).toBe(1))
  it("flags document.write(html)",   () => expect(runRule(r, `function f(html){ document.write(html) }`).length).toBe(1))
  it("does NOT flag document.createElement", () => expect(runRule(r, `document.createElement("div")`).length).toBe(0))
  it("does NOT flag fakeDoc.write",  () => expect(runRule(r, `fakeDoc.write("x")`).length).toBe(0))
  it("does NOT flag write as global",() => expect(runRule(r, `function write(){}; write("x")`).length).toBe(0))
})

// ─── no-async-without-await ─────────────────────────────────────

describe("no-async-without-await", () => {
  const r = ruleById("no-async-without-await")
  it("flags async function with no await",      () => expect(runRule(r, `async function f() { return 1 }`).length).toBe(1))
  it("flags async arrow with no await",         () => expect(runRule(r, `const f = async () => 1`).length).toBe(1))
  it("flags async method with no await",        () => expect(runRule(r, `const o = { async m() { return 1 } }`).length).toBe(1))
  it("does NOT flag async function with await", () => expect(runRule(r, `async function f() { return await g() }`).length).toBe(0))
  it("does NOT flag a sync function",           () => expect(runRule(r, `function f() { return 1 }`).length).toBe(0))
  it("does NOT flag await deep in body",        () => expect(runRule(r, `async function f() { if (cond) { for (let i=0;i<1;i++) { await g() } } }`).length).toBe(0))
  // PR #67 sigilix-bot self-review regression: bodyHasAwait must NOT
  // count `await` inside a nested function as belonging to the outer.
  it("FLAGS async outer with await ONLY in nested fn body",
    () => expect(runRule(r, `async function outer() { (async function inner() { await g() })() }`).length).toBe(1))
  it("FLAGS async outer with await ONLY in nested arrow body",
    () => expect(runRule(r, `async function outer() { const inner = async () => await g(); }`).length).toBe(1))
  it("FLAGS async arrow with await ONLY in nested fn",
    () => expect(runRule(r, `const outer = async () => { async function inner() { await g() } }`).length).toBe(1))
})

// ─── no-throw-literal ───────────────────────────────────────────

describe("no-throw-literal", () => {
  const r = ruleById("no-throw-literal")
  it("flags throw 'string'",          () => expect(runRule(r, `throw "boom"`).length).toBe(1))
  it("flags throw 42",                () => expect(runRule(r, `throw 42`).length).toBe(1))
  it("flags throw \\\`plain template\\\`", () => expect(runRule(r, "throw `boom`").length).toBe(1))
  it("does NOT flag throw new Error()",  () => expect(runRule(r, `throw new Error("x")`).length).toBe(0))
  it("does NOT flag throw err",       () => expect(runRule(r, `function f(err){ throw err }`).length).toBe(0))
  it("does NOT flag throw template with expression", () => expect(runRule(r, "function f(x){ throw `boom: ${x}` }").length).toBe(0))
})

// ─── no-await-in-loop ───────────────────────────────────────────

describe("no-await-in-loop", () => {
  const r = ruleById("no-await-in-loop")
  it("flags await in for-of",        () => expect(runRule(r, `async function f(arr){ for (const x of arr) await g(x) }`).length).toBe(1))
  it("flags await in while",         () => expect(runRule(r, `async function f(){ while (cond) await g() }`).length).toBe(1))
  it("flags await in do-while",      () => expect(runRule(r, `async function f(){ do { await g() } while (cond) }`).length).toBe(1))
  it("does NOT flag await outside loop", () => expect(runRule(r, `async function f(){ const x = await g() }`).length).toBe(0))
  it("does NOT flag await in nested fn inside loop", () => expect(runRule(r, `async function f(){ for (const x of arr) { (async () => { await g() })() } }`).length).toBe(0))
  it("does NOT flag await in Promise.all map",  () => expect(runRule(r, `async function f(arr){ await Promise.all(arr.map(async x => await g(x))) }`).length).toBe(0))
})

// ─── no-floating-promise-call-known-async ───────────────────────

describe("no-floating-promise-call-known-async", () => {
  const r = ruleById("no-floating-promise-call-known-async")
  it("flags asyncFn() expression statement", () => {
    expect(runRule(r, `async function fetchUser(){return 1}\nfetchUser()`).length).toBe(1)
  })
  it("flags const asyncArrow then call",     () => {
    expect(runRule(r, `const fetchUser = async () => 1\nfetchUser()`).length).toBe(1)
  })
  it("flags const asyncFnExpr then call",    () => {
    expect(runRule(r, `const fetchUser = async function(){return 1}\nfetchUser()`).length).toBe(1)
  })
  it("does NOT flag awaited call",           () => {
    expect(runRule(r, `async function fetchUser(){return 1}\nasync function g(){ await fetchUser() }`).length).toBe(0)
  })
  it("does NOT flag assigned call",          () => {
    expect(runRule(r, `async function fetchUser(){return 1}\nconst p = fetchUser()`).length).toBe(0)
  })
  it("does NOT flag sync function call",     () => {
    expect(runRule(r, `function syncFn(){return 1}\nsyncFn()`).length).toBe(0)
  })
})

// ─── no-process-env-mutation ────────────────────────────────────

describe("no-process-env-mutation", () => {
  const r = ruleById("no-process-env-mutation")
  it("flags process.env.X = 'y'",   () => expect(runRule(r, `process.env.NODE_ENV = "test"`).length).toBe(1))
  it("flags process.env.X = expr",  () => expect(runRule(r, `function f(v){ process.env.X = v }`).length).toBe(1))
  it("flags process.env.foo += 'x'",() => expect(runRule(r, `process.env.foo += "y"`).length).toBe(1))
  it("does NOT flag process.env.X read",   () => expect(runRule(r, `const x = process.env.X`).length).toBe(0))
  it("does NOT flag obj.env.X = 'y'",      () => expect(runRule(r, `const obj = {env:{}}; obj.env.X = "y"`).length).toBe(0))
  it("does NOT flag process.x = 'y'",      () => expect(runRule(r, `process.foo = "y"`).length).toBe(0))
})
