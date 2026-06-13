// ARC-181 — full rule-pack tests. Each rule gets 3+ positive +
// 3+ negative fixtures per Linear AC. Plus the ALL_RULES registry
// contract test (Codex MAJOR #3) locking the 10-rule set.

import { describe, it, expect } from "vitest"
import { parseSource } from "@/src/features/ast-rules/domain/parser"
import { walkAst } from "@/src/features/ast-rules/domain/walker"
import { ALL_RULES } from "@/src/features/ast-rules/domain/rule-registry"
import type { AstRule, AstRuleHit, AstRuleVisitResult } from "@/src/features/ast-rules/domain/types"

function appendHits(out: AstRuleHit[], hit: AstRuleVisitResult): void {
  if (!hit) return
  if (Array.isArray(hit)) out.push(...hit)
  else out.push(hit)
}

function runRule(rule: AstRule, source: string, ext: ".js" | ".ts" = ".js"): AstRuleHit[] {
  const r = parseSource(source, ext)
  if (!r.ok) throw new Error(`parse failed: ${r.reason}`)
  const hits: AstRuleHit[] = []
  const visitors: Record<string, (n: unknown) => void> = {}
  for (const t of rule.nodeTypes) {
    visitors[t] = (n: unknown) => {
      const hit = rule.visit(n, { path: "test.js", source, ast: r.ast })
      appendHits(hits, hit)
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
  it("exports exactly 37 rules in the canonical order", () => {
    expect(ALL_RULES.map((r) => r.id)).toEqual([
      "no-eval-call",
      "no-new-function-constructor",
      "spawn-shell-true",
      "no-exec-shell-interpolation",
      "no-disabled-tls-reject-unauthorized",
      "no-document-write-call",
      "no-async-without-await",
      "no-throw-literal",
      "no-await-in-loop",
      "no-floating-promise-call-known-async",
      "no-process-env-mutation",
      // SIG-109: logic-specialist correctness rules.
      "no-dupe-switch-case",
      "no-dupe-object-keys",
      "no-return-in-finally",
      "no-unreachable-after-jump",
      "no-self-assignment",
      "no-constant-binary-condition",
      "no-invalid-typeof-compare",
      "no-unsafe-negation",
      // SIG-110: performance-specialist rules.
      "no-spread-accumulator-in-loop",
      "no-allocation-in-loop",
      "no-n-plus-one-call-in-loop",
      "no-sync-io-in-request-path",
      // SIG-310
      "no-snake-camel-optional-alias",
      // SIG-392 (b8): runtime launder-cast contract-drift (logic/warning).
      "no-double-cast-through-unknown",
      // SIG-314: deterministic IDOR/BOLA floor (security/warning).
      "no-unauthorized-object-lookup",
      // deterministic weak-randomness floor (CWE-338, security/warning).
      "no-insecure-random-token",
      // deterministic open-redirect floor (CWE-601, security/warning).
      "no-open-redirect",
      // deterministic SSRF floor (CWE-918, security/warning).
      "no-ssrf",
      // deterministic path-traversal floor (CWE-22, security/warning).
      "no-path-traversal",
      // deterministic SQL-injection floor (CWE-89, security/warning).
      "no-sql-injection",
      // deterministic SSTI floor (CWE-1336, security/warning).
      "no-ssti",
      // deterministic NoSQL-injection floor (CWE-943, security/warning).
      "no-nosql-injection",
      // deterministic prototype-pollution floor (CWE-1321, security/warning).
      "no-prototype-pollution",
      // deterministic XXE floor (CWE-611, security/warning).
      "no-xxe",
      // SIG-392 (b14): deterministic fail-open hardcoded-secret floor (CWE-798, security/warning).
      "no-hardcoded-secret-fallback",
      // SIG-392 (b20): deterministic HMAC-over-reserialized-body floor (CWE-345/347, security/warning).
      "no-hmac-over-reserialized-body",
    ])
  })

  it("locks per-rule severity + roleHint", () => {
    const expected: Record<string, { severity: string; roleHint: string }> = {
      "no-eval-call": { severity: "error", roleHint: "security" },
      "no-new-function-constructor": { severity: "error", roleHint: "security" },
      "spawn-shell-true": { severity: "error", roleHint: "security" },
      "no-exec-shell-interpolation": { severity: "error", roleHint: "security" },
      "no-disabled-tls-reject-unauthorized": { severity: "error", roleHint: "security" },
      "no-document-write-call": { severity: "error", roleHint: "security" },
      "no-async-without-await": { severity: "warning", roleHint: "logic" },
      "no-throw-literal": { severity: "warning", roleHint: "logic" },
      "no-await-in-loop": { severity: "warning", roleHint: "performance" },
      "no-floating-promise-call-known-async": { severity: "warning", roleHint: "logic" },
      "no-process-env-mutation": { severity: "warning", roleHint: "logic" },
      "no-dupe-switch-case": { severity: "warning", roleHint: "logic" },
      "no-dupe-object-keys": { severity: "warning", roleHint: "logic" },
      "no-return-in-finally": { severity: "warning", roleHint: "logic" },
      "no-unreachable-after-jump": { severity: "warning", roleHint: "logic" },
      "no-self-assignment": { severity: "warning", roleHint: "logic" },
      "no-constant-binary-condition": { severity: "warning", roleHint: "logic" },
      "no-invalid-typeof-compare": { severity: "warning", roleHint: "logic" },
      "no-unsafe-negation": { severity: "warning", roleHint: "logic" },
      "no-spread-accumulator-in-loop": { severity: "warning", roleHint: "performance" },
      "no-allocation-in-loop": { severity: "warning", roleHint: "performance" },
      "no-n-plus-one-call-in-loop": { severity: "warning", roleHint: "performance" },
      "no-sync-io-in-request-path": { severity: "warning", roleHint: "performance" },
      "no-snake-camel-optional-alias": { severity: "warning", roleHint: "logic" },
      "no-double-cast-through-unknown": { severity: "warning", roleHint: "logic" },
      "no-unauthorized-object-lookup": { severity: "warning", roleHint: "security" },
      "no-insecure-random-token": { severity: "warning", roleHint: "security" },
      "no-open-redirect": { severity: "warning", roleHint: "security" },
      "no-ssrf": { severity: "warning", roleHint: "security" },
      "no-path-traversal": { severity: "warning", roleHint: "security" },
      "no-sql-injection": { severity: "warning", roleHint: "security" },
      "no-ssti": { severity: "warning", roleHint: "security" },
      "no-nosql-injection": { severity: "warning", roleHint: "security" },
      "no-prototype-pollution": { severity: "warning", roleHint: "security" },
      "no-xxe": { severity: "warning", roleHint: "security" },
      "no-hardcoded-secret-fallback": { severity: "warning", roleHint: "security" },
      "no-hmac-over-reserialized-body": { severity: "warning", roleHint: "security" },
    }
    for (const r of ALL_RULES) {
      expect({ severity: r.severity, roleHint: r.roleHint }).toEqual(expected[r.id])
    }
  })
})

// ─── no-new-function-constructor ────────────────────────────────

describe("no-new-function-constructor", () => {
  const r = ruleById("no-new-function-constructor")
  it("flags new Function('x')", () => expect(runRule(r, `new Function("x")`).length).toBe(1))
  it("flags new Function(a, b, c)", () => expect(runRule(r, `new Function("a", "b", "return a+b")`).length).toBe(1))
  it("flags new Function() empty", () => expect(runRule(r, `new Function()`).length).toBe(1))
  it("does NOT flag Function('x') without new", () => expect(runRule(r, `Function("x")`).length).toBe(0))
  it("does NOT flag new MyFunction()", () =>
    expect(runRule(r, `function MyFunction(){}; new MyFunction()`).length).toBe(0))
  it("does NOT flag function declarations", () => expect(runRule(r, `function Function(){return 1}`).length).toBe(0))
})

// ─── spawn-shell-true ───────────────────────────────────────────

describe("spawn-shell-true", () => {
  const r = ruleById("spawn-shell-true")
  it("flags spawn(cmd, args, {shell:true})", () =>
    expect(runRule(r, `spawn("c", ["a"], {shell: true})`).length).toBe(1))
  it("flags spawnSync(cmd, {shell:true})", () => expect(runRule(r, `spawnSync("c", {shell: true})`).length).toBe(1))
  it("flags execFile(cmd, {shell:true})", () => expect(runRule(r, `execFile("c", {shell: true})`).length).toBe(1))
  it("does NOT flag spawn without shell:true", () => expect(runRule(r, `spawn("c", ["a"])`).length).toBe(0))
  it("does NOT flag spawn with shell:false", () => expect(runRule(r, `spawn("c", {shell: false})`).length).toBe(0))
  it("does NOT flag exec({shell:true}) (Codex #7)", () => expect(runRule(r, `exec("c", {shell: true})`).length).toBe(0))
})

// ─── no-disabled-tls-reject-unauthorized ────────────────────────

describe("no-disabled-tls-reject-unauthorized", () => {
  const r = ruleById("no-disabled-tls-reject-unauthorized")
  it("flags { rejectUnauthorized: false }", () =>
    expect(runRule(r, `const opts = { rejectUnauthorized: false }`).length).toBe(1))
  it("flags { rejectUnauthorized: false } in arg", () =>
    expect(runRule(r, `https.request("u", { rejectUnauthorized: false })`).length).toBe(1))
  it("flags nested object with the prop", () =>
    expect(runRule(r, `const c = { tls: { rejectUnauthorized: false } }`).length).toBe(1))
  it("does NOT flag rejectUnauthorized: true", () =>
    expect(runRule(r, `const opts = { rejectUnauthorized: true }`).length).toBe(0))
  it("does NOT flag missing prop", () => expect(runRule(r, `const opts = { ca: "..." }`).length).toBe(0))
  it("does NOT flag a rejectUnauthorized variable", () =>
    expect(runRule(r, `const rejectUnauthorized = false`).length).toBe(0))
})

// ─── no-document-write-call ─────────────────────────────────────

describe("no-document-write-call", () => {
  const r = ruleById("no-document-write-call")
  it("flags document.write('x')", () => expect(runRule(r, `document.write("x")`).length).toBe(1))
  it("flags document.writeln('x')", () => expect(runRule(r, `document.writeln("x")`).length).toBe(1))
  it("flags document.write(html)", () => expect(runRule(r, `function f(html){ document.write(html) }`).length).toBe(1))
  it("does NOT flag document.createElement", () => expect(runRule(r, `document.createElement("div")`).length).toBe(0))
  it("does NOT flag fakeDoc.write", () => expect(runRule(r, `fakeDoc.write("x")`).length).toBe(0))
  it("does NOT flag write as global", () => expect(runRule(r, `function write(){}; write("x")`).length).toBe(0))
})

// ─── no-async-without-await ─────────────────────────────────────

describe("no-async-without-await", () => {
  const r = ruleById("no-async-without-await")
  it("flags async function with no await", () => expect(runRule(r, `async function f() { return 1 }`).length).toBe(1))
  it("flags async arrow with no await", () => expect(runRule(r, `const f = async () => 1`).length).toBe(1))
  it("flags async method with no await", () =>
    expect(runRule(r, `const o = { async m() { return 1 } }`).length).toBe(1))
  it("does NOT flag async function with await", () =>
    expect(runRule(r, `async function f() { return await g() }`).length).toBe(0))
  it("does NOT flag a sync function", () => expect(runRule(r, `function f() { return 1 }`).length).toBe(0))
  it("does NOT flag await deep in body", () =>
    expect(runRule(r, `async function f() { if (cond) { for (let i=0;i<1;i++) { await g() } } }`).length).toBe(0))
  // PR #67 sigilix-bot self-review regression: bodyHasAwait must NOT
  // count `await` inside a nested function as belonging to the outer.
  it("FLAGS async outer with await ONLY in nested fn body", () =>
    expect(runRule(r, `async function outer() { (async function inner() { await g() })() }`).length).toBe(1))
  it("FLAGS async outer with await ONLY in nested arrow body", () =>
    expect(runRule(r, `async function outer() { const inner = async () => await g(); }`).length).toBe(1))
  it("FLAGS async arrow with await ONLY in nested fn", () =>
    expect(runRule(r, `const outer = async () => { async function inner() { await g() } }`).length).toBe(1))
})

// ─── no-throw-literal ───────────────────────────────────────────

describe("no-throw-literal", () => {
  const r = ruleById("no-throw-literal")
  it("flags throw 'string'", () => expect(runRule(r, `throw "boom"`).length).toBe(1))
  it("flags throw 42", () => expect(runRule(r, `throw 42`).length).toBe(1))
  it("flags throw \\\`plain template\\\`", () => expect(runRule(r, "throw `boom`").length).toBe(1))
  it("does NOT flag throw new Error()", () => expect(runRule(r, `throw new Error("x")`).length).toBe(0))
  it("does NOT flag throw err", () => expect(runRule(r, `function f(err){ throw err }`).length).toBe(0))
  it("does NOT flag throw template with expression", () =>
    expect(runRule(r, "function f(x){ throw `boom: ${x}` }").length).toBe(0))
})

// ─── no-await-in-loop ───────────────────────────────────────────

describe("no-await-in-loop", () => {
  const r = ruleById("no-await-in-loop")
  it("flags await in for-of", () =>
    expect(runRule(r, `async function f(arr){ for (const x of arr) await g(x) }`).length).toBe(1))
  it("flags await in while", () => expect(runRule(r, `async function f(){ while (cond) await g() }`).length).toBe(1))
  it("flags await in do-while", () =>
    expect(runRule(r, `async function f(){ do { await g() } while (cond) }`).length).toBe(1))
  it("does NOT flag await outside loop", () =>
    expect(runRule(r, `async function f(){ const x = await g() }`).length).toBe(0))
  it("does NOT flag await in nested fn inside loop", () =>
    expect(runRule(r, `async function f(){ for (const x of arr) { (async () => { await g() })() } }`).length).toBe(0))
  it("does NOT flag await in Promise.all map", () =>
    expect(runRule(r, `async function f(arr){ await Promise.all(arr.map(async x => await g(x))) }`).length).toBe(0))
})

// ─── no-floating-promise-call-known-async ───────────────────────

describe("no-floating-promise-call-known-async", () => {
  const r = ruleById("no-floating-promise-call-known-async")
  it("flags asyncFn() expression statement", () => {
    expect(runRule(r, `async function fetchUser(){return 1}\nfetchUser()`).length).toBe(1)
  })
  it("flags const asyncArrow then call", () => {
    expect(runRule(r, `const fetchUser = async () => 1\nfetchUser()`).length).toBe(1)
  })
  it("flags const asyncFnExpr then call", () => {
    expect(runRule(r, `const fetchUser = async function(){return 1}\nfetchUser()`).length).toBe(1)
  })
  it("does NOT flag awaited call", () => {
    expect(runRule(r, `async function fetchUser(){return 1}\nasync function g(){ await fetchUser() }`).length).toBe(0)
  })
  it("does NOT flag assigned call", () => {
    expect(runRule(r, `async function fetchUser(){return 1}\nconst p = fetchUser()`).length).toBe(0)
  })
  it("does NOT flag sync function call", () => {
    expect(runRule(r, `function syncFn(){return 1}\nsyncFn()`).length).toBe(0)
  })
})

// ─── no-process-env-mutation ────────────────────────────────────

describe("no-process-env-mutation", () => {
  const r = ruleById("no-process-env-mutation")
  it("flags process.env.X = 'y'", () => expect(runRule(r, `process.env.NODE_ENV = "test"`).length).toBe(1))
  it("flags process.env.X = expr", () => expect(runRule(r, `function f(v){ process.env.X = v }`).length).toBe(1))
  it("flags process.env.foo += 'x'", () => expect(runRule(r, `process.env.foo += "y"`).length).toBe(1))
  it("does NOT flag process.env.X read", () => expect(runRule(r, `const x = process.env.X`).length).toBe(0))
  it("does NOT flag obj.env.X = 'y'", () => expect(runRule(r, `const obj = {env:{}}; obj.env.X = "y"`).length).toBe(0))
  it("does NOT flag process.x = 'y'", () => expect(runRule(r, `process.foo = "y"`).length).toBe(0))
})

// ─── SIG-109: no-dupe-switch-case ───────────────────────────────

describe("no-dupe-switch-case", () => {
  const r = ruleById("no-dupe-switch-case")
  it("flags duplicate numeric case", () =>
    expect(runRule(r, `switch(k){ case 1: break; case 1: break }`).length).toBe(1))
  it("flags duplicate string case", () =>
    expect(runRule(r, `switch(k){ case "a": break; case "a": break }`).length).toBe(1))
  it("flags duplicate even with gap", () =>
    expect(runRule(r, `switch(k){ case 1: break; case 2: break; case 1: break }`).length).toBe(1))
  it("does NOT flag distinct cases", () =>
    expect(runRule(r, `switch(k){ case 1: break; case 2: break }`).length).toBe(0))
  it("does NOT collide 1 and '1'", () =>
    expect(runRule(r, `switch(k){ case 1: break; case "1": break }`).length).toBe(0))
  it("does NOT flag identifier cases (conservative)", () =>
    expect(runRule(r, `switch(k){ case A: break; case A: break }`).length).toBe(0))
  it("does NOT flag default + a case", () =>
    expect(runRule(r, `switch(k){ case 1: break; default: break }`).length).toBe(0))
})

// ─── SIG-109: no-dupe-object-keys ───────────────────────────────

describe("no-dupe-object-keys", () => {
  const r = ruleById("no-dupe-object-keys")
  it("flags duplicate identifier key", () => expect(runRule(r, `const o = { a: 1, a: 2 }`).length).toBe(1))
  it("flags duplicate string key", () => expect(runRule(r, `const o = { "x": 1, "x": 2 }`).length).toBe(1))
  it("flags identifier == string key", () => expect(runRule(r, `const o = { a: 1, "a": 2 }`).length).toBe(1))
  it("flags two getters for same key", () => expect(runRule(r, `const o = { get x(){}, get x(){} }`).length).toBe(1))
  it("flags getter + data property", () => expect(runRule(r, `const o = { get x(){}, x: 1 }`).length).toBe(1))
  it("does NOT flag distinct keys", () => expect(runRule(r, `const o = { a: 1, b: 2 }`).length).toBe(0))
  it("does NOT flag a getter/setter pair (exempt)", () =>
    expect(runRule(r, `const o = { get x(){}, set x(v){} }`).length).toBe(0))
  it("does NOT flag computed keys (conservative)", () =>
    expect(runRule(r, `const o = { [k]: 1, [k]: 2 }`).length).toBe(0))
  it("does NOT flag spread elements", () => expect(runRule(r, `const o = { ...a, ...b }`).length).toBe(0))
})

// ─── SIG-109: no-return-in-finally ──────────────────────────────

describe("no-return-in-finally", () => {
  const r = ruleById("no-return-in-finally")
  it("flags return in finally", () =>
    expect(runRule(r, `function f(){ try { g() } finally { return 1 } }`).length).toBe(1))
  it("flags throw in finally", () =>
    expect(runRule(r, `function f(){ try { g() } finally { throw new Error("x") } }`).length).toBe(1))
  it("flags break in finally", () =>
    expect(runRule(r, `function f(){ for(;;){ try { g() } finally { break } } }`).length).toBe(1))
  it("flags continue in finally", () =>
    expect(runRule(r, `function f(){ for(;;){ try { g() } finally { continue } } }`).length).toBe(1))
  it("flags return nested in finally if-block", () =>
    expect(runRule(r, `function f(){ try { g() } finally { if (c) { return 1 } } }`).length).toBe(1))
  it("does NOT flag return in try", () =>
    expect(runRule(r, `function f(){ try { return 1 } finally { cleanup() } }`).length).toBe(0))
  it("does NOT flag return in catch", () =>
    expect(runRule(r, `function f(){ try { g() } catch(e) { return 1 } finally { cleanup() } }`).length).toBe(0))
  it("does NOT flag return in a fn declared inside finally (nested scope)", () =>
    expect(runRule(r, `function f(){ try { g() } finally { const h = () => { return 1 } } }`).length).toBe(0))
  // Review (HIGH): a break/continue LOCAL to a loop/switch inside the
  // finally exits only that construct — it does NOT swallow the outcome.
  it("does NOT flag break inside a loop within finally", () =>
    expect(runRule(r, `function f(){ try { g() } finally { while (c) { if (d) break } cleanup() } }`).length).toBe(0))
  it("does NOT flag continue inside a for-of within finally", () =>
    expect(runRule(r, `function f(){ try { g() } finally { for (const x of y) { if (x) continue } } }`).length).toBe(0))
  it("does NOT flag break inside a switch within finally", () =>
    expect(runRule(r, `function f(){ try { g() } finally { switch (x) { case 1: break } } }`).length).toBe(0))
  it("does NOT flag try with no finally", () =>
    expect(runRule(r, `function f(){ try { return 1 } catch(e) { return 2 } }`).length).toBe(0))
})

// ─── SIG-109: no-unreachable-after-jump ─────────────────────────

describe("no-unreachable-after-jump", () => {
  const r = ruleById("no-unreachable-after-jump")
  it("flags statement after return", () => expect(runRule(r, `function f(){ return 1; const x = 2 }`).length).toBe(1))
  it("flags statement after throw", () =>
    expect(runRule(r, `function f(){ throw new Error("x"); doThing() }`).length).toBe(1))
  it("flags statement after break", () =>
    expect(runRule(r, `function f(){ for(;;){ break; doThing() } }`).length).toBe(1))
  it("flags statement after continue", () =>
    expect(runRule(r, `function f(){ for(;;){ continue; doThing() } }`).length).toBe(1))
  it("does NOT flag return as last statement", () =>
    expect(runRule(r, `function f(){ const x = 1; return x }`).length).toBe(0))
  it("does NOT flag a hoisted function decl after return", () =>
    expect(runRule(r, `function f(){ return 1; function helper(){} }`).length).toBe(0))
  it("does NOT flag a var declaration after return (binding hoisted)", () =>
    expect(runRule(r, `function f(){ return 1; var x = 2 }`).length).toBe(0))
  it("does NOT cross into a nested block (same-block only)", () =>
    expect(runRule(r, `function f(){ if (c) { return 1 } const x = 2 }`).length).toBe(0))
  it("does NOT flag code in switch-case consequent (out of scope)", () =>
    expect(runRule(r, `function f(k){ switch(k){ case 1: return 1; doThing() } }`).length).toBe(0))
})

// ─── SIG-109: no-self-assignment ────────────────────────────────

describe("no-self-assignment", () => {
  const r = ruleById("no-self-assignment")
  it("flags x = x", () => expect(runRule(r, `function f(x){ x = x }`).length).toBe(1))
  // Member self-assignments are NOT flagged (review): an accessor /
  // Proxy trap means `this.x = this.x` can have side effects.
  it("does NOT flag this.x = this.x (member — accessor-safe)", () =>
    expect(runRule(r, `function f(){ this.x = this.x }`).length).toBe(0))
  it("does NOT flag a.b.c = a.b.c (member)", () => expect(runRule(r, `function f(a){ a.b.c = a.b.c }`).length).toBe(0))
  it("does NOT flag x = y", () => expect(runRule(r, `function f(x,y){ x = y }`).length).toBe(0))
  it("does NOT flag this.x = x", () => expect(runRule(r, `function f(x){ this.x = x }`).length).toBe(0))
  it("does NOT flag compound x += x", () => expect(runRule(r, `function f(x){ x += x }`).length).toBe(0))
  it("does NOT flag computed a[i] = a[i] (conservative)", () =>
    expect(runRule(r, `function f(a,i){ a[i] = a[i] }`).length).toBe(0))
  it("does NOT flag a.b = a.c", () => expect(runRule(r, `function f(a){ a.b = a.c }`).length).toBe(0))
})

// ─── SIG-109: no-constant-binary-condition ──────────────────────

describe("no-constant-binary-condition", () => {
  const r = ruleById("no-constant-binary-condition")
  // Flag ONLY when a constant LEFT operand short-circuits → right is DEAD.
  it("flags 1 || a (truthy left → right dead)", () => expect(runRule(r, `const z = 1 || a`).length).toBe(1))
  it("flags 0 && a (falsy left → right dead)", () => expect(runRule(r, `const z = 0 && a`).length).toBe(1))
  it("flags true || a", () => expect(runRule(r, `const z = true || a`).length).toBe(1))
  it("flags false && a", () => expect(runRule(r, `const z = false && a`).length).toBe(1))
  // RHS literal only fixes the result — common intentional override; NOT flagged (review).
  it("does NOT flag a || true (RHS literal — intentional override)", () =>
    expect(runRule(r, `const z = a || true`).length).toBe(0))
  it("does NOT flag a && false (RHS literal)", () => expect(runRule(r, `const z = a && false`).length).toBe(0))
  it("does NOT flag env.PORT || 3000 (fallback)", () => expect(runRule(r, `const z = env.PORT || 3000`).length).toBe(0))
  it("does NOT flag a || b (no literal)", () => expect(runRule(r, `const z = a || b`).length).toBe(0))
  it("does NOT flag a || '' (legit fallback)", () => expect(runRule(r, `const z = a || ""`).length).toBe(0))
  it("does NOT flag a && true (truthy && — common no-op guard)", () =>
    expect(runRule(r, `const z = a && true`).length).toBe(0))
  it("does NOT flag a || foo() (non-literal operand)", () =>
    expect(runRule(r, `function foo(){return 1}; const z = a || foo()`).length).toBe(0))
})

// ─── SIG-109: no-invalid-typeof-compare ─────────────────────────

describe("no-invalid-typeof-compare", () => {
  const r = ruleById("no-invalid-typeof-compare")
  it("flags typeof x === 'strnig'", () => expect(runRule(r, `if (typeof x === "strnig") {}`).length).toBe(1))
  it("flags typeof x === 'array'", () => expect(runRule(r, `if (typeof x === "array") {}`).length).toBe(1))
  it("flags typeof x !== 'null'", () => expect(runRule(r, `if (typeof x !== "null") {}`).length).toBe(1))
  it("flags mirrored 'array' === typeof x", () => expect(runRule(r, `if ("array" === typeof x) {}`).length).toBe(1))
  it("does NOT flag typeof x === 'string'", () => expect(runRule(r, `if (typeof x === "string") {}`).length).toBe(0))
  it("does NOT flag typeof x === 'undefined'", () =>
    expect(runRule(r, `if (typeof x === "undefined") {}`).length).toBe(0))
  it("does NOT flag typeof x === 'bigint'", () => expect(runRule(r, `if (typeof x === "bigint") {}`).length).toBe(0))
  it("does NOT flag typeof x === expected (non-literal)", () =>
    expect(runRule(r, `function f(x,expected){ return typeof x === expected }`).length).toBe(0))
  it("does NOT flag a non-typeof comparison", () => expect(runRule(r, `if (x === "strnig") {}`).length).toBe(0))
})

// ─── SIG-109: no-unsafe-negation ────────────────────────────────

describe("no-unsafe-negation", () => {
  const r = ruleById("no-unsafe-negation")
  it("flags !a in b", () => expect(runRule(r, `if (!a in b) {}`).length).toBe(1))
  it("flags !a instanceof B", () => expect(runRule(r, `if (!a instanceof B) {}`).length).toBe(1))
  it("flags !key in obj used as expr", () => expect(runRule(r, `const z = !key in obj`).length).toBe(1))
  it("does NOT flag !(a in b) (correct form)", () => expect(runRule(r, `if (!(a in b)) {}`).length).toBe(0))
  it("does NOT flag !(a instanceof B) (correct)", () => expect(runRule(r, `if (!(a instanceof B)) {}`).length).toBe(0))
  it("does NOT flag a in b (no negation)", () => expect(runRule(r, `if (a in b) {}`).length).toBe(0))
  it("does NOT flag a in !b (negation on right)", () => expect(runRule(r, `if (a in !b) {}`).length).toBe(0))
  it("does NOT flag ~a in b (different unary)", () => expect(runRule(r, `const z = ~a in b`).length).toBe(0))
})
