// SIG-110: performance-specialist AST rule fixtures. Each rule gets
// positive cases (real perf hazards) + negative cases that specifically
// pin the false-positive traps Codex + deepseek-v4-pro flagged during
// sign-off (shadowing, global regex, JSON.parse, non-awaited calls,
// generic method names, Map.get false-routes, nested-function sync I/O).

import { describe, it, expect } from "vitest"
import { parseSource } from "@/features/ast-rules/domain/parser"
import { walkAst } from "@/features/ast-rules/domain/walker"
import type { AstRule, AstRuleHit, AstRuleVisitResult } from "@/features/ast-rules/domain/types"
import { noSpreadAccumulatorInLoop } from "@/features/ast-rules/domain/rules/no-spread-accumulator-in-loop"
import { noAllocationInLoop } from "@/features/ast-rules/domain/rules/no-allocation-in-loop"
import { noNPlusOneCallInLoop } from "@/features/ast-rules/domain/rules/no-n-plus-one-call-in-loop"
import { noSyncIoInRequestPath } from "@/features/ast-rules/domain/rules/no-sync-io-in-request-path"

function appendHits(out: AstRuleHit[], hit: AstRuleVisitResult): void {
  if (!hit) return
  if (Array.isArray(hit)) out.push(...hit)
  else out.push(hit)
}

function runRule(rule: AstRule, source: string, path = "src/app.ts", ext: ".js" | ".ts" = ".ts"): AstRuleHit[] {
  const r = parseSource(source, ext)
  if (!r.ok) throw new Error(`parse failed: ${r.reason}`)
  const hits: AstRuleHit[] = []
  const visitors: Record<string, (n: unknown) => void> = {}
  for (const t of rule.nodeTypes) {
    visitors[t] = (n: unknown) => {
      const hit = rule.visit(n, { path, source, ast: r.ast })
      appendHits(hits, hit)
    }
  }
  walkAst(r.ast, visitors)
  return hits
}

describe("no-spread-accumulator-in-loop", () => {
  it("flags array spread-rebuild in a for-of loop", () => {
    expect(runRule(noSpreadAccumulatorInLoop, `let acc = []; for (const x of xs) { acc = [...acc, x] }`)).toHaveLength(1)
  })
  it("flags object spread-rebuild in a while loop", () => {
    expect(runRule(noSpreadAccumulatorInLoop, `let o = {}; while (c) { o = {...o, k: 1} }`)).toHaveLength(1)
  })
  it("flags spread-rebuild in a c-style for loop", () => {
    expect(runRule(noSpreadAccumulatorInLoop, `let acc = []; for (let i = 0; i < n; i++) { acc = [...acc, i] }`)).toHaveLength(1)
  })
  it("does NOT flag in-place push", () => {
    expect(runRule(noSpreadAccumulatorInLoop, `let acc = []; for (const x of xs) { acc.push(x) }`)).toHaveLength(0)
  })
  it("does NOT flag compound assignment (+= is not the pattern)", () => {
    expect(runRule(noSpreadAccumulatorInLoop, `let acc = []; for (const x of xs) { acc += [...acc] }`)).toHaveLength(0)
  })
  it("does NOT flag a same-named binding declared inside the loop (catch-param shadow)", () => {
    expect(runRule(noSpreadAccumulatorInLoop, `let acc = []; for (const x of xs) { try {} catch (acc) { acc = [...acc, x] } }`)).toHaveLength(0)
  })
  it("does NOT flag a same-named inner declaration (let shadow)", () => {
    expect(runRule(noSpreadAccumulatorInLoop, `let acc = []; for (const x of xs) { let acc = []; acc = [...acc, x] }`)).toHaveLength(0)
  })
  it("does NOT flag a same-named DESTRUCTURED inner binding (object pattern shadow)", () => {
    expect(runRule(noSpreadAccumulatorInLoop, `let acc = []; for (const x of xs) { const { acc } = x; acc = [...acc, x] }`)).toHaveLength(0)
  })
  it("does NOT flag a same-named DESTRUCTURED inner binding (array pattern shadow)", () => {
    expect(runRule(noSpreadAccumulatorInLoop, `let acc = []; for (const x of xs) { const [acc] = x; acc = [...acc, x] }`)).toHaveLength(0)
  })
  it("does NOT flag spread of a DIFFERENT identifier", () => {
    expect(runRule(noSpreadAccumulatorInLoop, `let acc = []; for (const x of xs) { acc = [...other, x] }`)).toHaveLength(0)
  })
  it("does NOT flag outside any loop", () => {
    expect(runRule(noSpreadAccumulatorInLoop, `acc = [...acc, x]`)).toHaveLength(0)
  })
})

describe("no-allocation-in-loop", () => {
  it("flags new RegExp(literal) in a loop", () => {
    expect(runRule(noAllocationInLoop, `for (const x of xs) { const re = new RegExp("abc"); re.test(x) }`)).toHaveLength(1)
  })
  it("flags new RegExp with non-global flags", () => {
    expect(runRule(noAllocationInLoop, `for (const x of xs) { new RegExp("a", "i").test(x) }`)).toHaveLength(1)
  })
  it("flags new Intl.NumberFormat with literal args", () => {
    expect(runRule(noAllocationInLoop, `for (const x of xs) { new Intl.NumberFormat("en-US").format(x) }`)).toHaveLength(1)
  })
  it("does NOT flag a GLOBAL regex (hoisting changes lastIndex behavior)", () => {
    expect(runRule(noAllocationInLoop, `for (const x of xs) { new RegExp("a", "g").test(x) }`)).toHaveLength(0)
  })
  it("does NOT flag JSON.parse (identity/mutability matters)", () => {
    expect(runRule(noAllocationInLoop, `for (const x of xs) { const o = JSON.parse(s) }`)).toHaveLength(0)
  })
  it("does NOT flag an object literal (fresh identity is often required)", () => {
    expect(runRule(noAllocationInLoop, `for (const x of xs) { const o = { a: 1 } }`)).toHaveLength(0)
  })
  it("does NOT flag new RegExp with a non-literal pattern (may depend on loop var)", () => {
    expect(runRule(noAllocationInLoop, `for (const x of xs) { new RegExp(x) }`)).toHaveLength(0)
  })
  it("does NOT flag a RegExp outside any loop", () => {
    expect(runRule(noAllocationInLoop, `const re = new RegExp("abc")`)).toHaveLength(0)
  })
})

describe("no-n-plus-one-call-in-loop", () => {
  it("flags awaited db.query in a loop", () => {
    expect(runRule(noNPlusOneCallInLoop, `async function f(){ for (const id of ids) { await db.query("SELECT 1") } }`)).toHaveLength(1)
  })
  it("flags awaited prisma model CRUD in a loop", () => {
    expect(runRule(noNPlusOneCallInLoop, `async function f(){ for (const id of ids) { await prisma.user.findUnique({ where: { id } }) } }`)).toHaveLength(1)
  })
  it("flags awaited fetch in a loop", () => {
    expect(runRule(noNPlusOneCallInLoop, `async function f(){ for (const u of us) { await fetch(u.url) } }`)).toHaveLength(1)
  })
  it("flags awaited supabase chain in a loop", () => {
    expect(runRule(noNPlusOneCallInLoop, `async function f(){ for (const t of ts) { await supabase.from("t").select("*") } }`)).toHaveLength(1)
  })
  it("flags an awaited knex builder chain in a loop", () => {
    expect(runRule(noNPlusOneCallInLoop, `async function f(){ for (const id of ids) { await knex("users").where({ id }).first() } }`)).toHaveLength(1)
  })
  it("continues traversal after a hit so nested awaited data calls are not dropped", () => {
    expect(runRule(noNPlusOneCallInLoop, `async function f(){ for (const url of urls) { await db.query(await fetch(url)) } }`)).toHaveLength(2)
  })
  it("does NOT flag a non-awaited (batched) call", () => {
    expect(runRule(noNPlusOneCallInLoop, `function f(){ const ps = []; for (const id of ids) { ps.push(db.query("x")) } }`)).toHaveLength(0)
  })
  it("does NOT flag a generic .get on an unknown root", () => {
    expect(runRule(noNPlusOneCallInLoop, `async function f(){ for (const x of xs) { await cache.get(x) } }`)).toHaveLength(0)
  })
  it("does NOT flag a prisma method that isn't a known CRUD op", () => {
    expect(runRule(noNPlusOneCallInLoop, `async function f(){ for (const x of xs) { await prisma.user.customHelper(x) } }`)).toHaveLength(0)
  })
  it("does NOT flag an awaited data call OUTSIDE a loop", () => {
    expect(runRule(noNPlusOneCallInLoop, `async function f(){ await db.query("SELECT 1") }`)).toHaveLength(0)
  })
  it("does NOT flag an awaited call inside a nested function (loop scope resets)", () => {
    expect(runRule(noNPlusOneCallInLoop, `function f(){ for (const x of xs) { arr.map(async () => { await db.query("x") }) } }`)).toHaveLength(0)
  })
})

describe("no-sync-io-in-request-path", () => {
  it("flags fs.readFileSync in an express handler (default import)", () => {
    expect(runRule(noSyncIoInRequestPath, `import fs from "fs"; app.get("/x", (req, res) => { const d = fs.readFileSync("f"); res.end(d) })`)).toHaveLength(1)
  })
  it("flags a named-import readFileSync in a router handler", () => {
    expect(runRule(noSyncIoInRequestPath, `import { readFileSync } from "node:fs"; router.post("/y", async (req, res) => { readFileSync("f") })`)).toHaveLength(1)
  })
  it("flags execSync in a Next-style exported GET", () => {
    expect(runRule(noSyncIoInRequestPath, `import { execSync } from "child_process"; export async function GET() { execSync("ls") }`)).toHaveLength(1)
  })
  it("flags fs.statSync via CJS require in a handler", () => {
    expect(runRule(noSyncIoInRequestPath, `const fs = require("fs"); app.get("/z", (req, res) => { fs.statSync("f") })`)).toHaveLength(1)
  })
  it("continues traversal after a sync I/O hit so nested sync calls are not dropped", () => {
    expect(runRule(noSyncIoInRequestPath, `import fs from "fs"; app.get("/x", (req, res) => { fs.readFileSync(fs.readFileSync("path"), "utf8") })`)).toHaveLength(2)
  })
  it("does NOT flag when fs is not imported (unresolved identifier)", () => {
    expect(runRule(noSyncIoInRequestPath, `app.get("/x", (req, res) => { fs.readFileSync("f") })`)).toHaveLength(0)
  })
  it("does NOT flag the async fs.promises API", () => {
    expect(runRule(noSyncIoInRequestPath, `import fs from "fs"; app.get("/x", async (req, res) => { await fs.promises.readFile("f") })`)).toHaveLength(0)
  })
  it("does NOT mistake Map.get for a route (no function arg)", () => {
    expect(runRule(noSyncIoInRequestPath, `import fs from "fs"; const m = new Map(); const v = m.get("k")`)).toHaveLength(0)
  })
  it("does NOT flag sync I/O outside any handler", () => {
    expect(runRule(noSyncIoInRequestPath, `import fs from "fs"; const cfg = fs.readFileSync("config")`)).toHaveLength(0)
  })
  it("does NOT flag sync I/O inside a nested function within the handler", () => {
    expect(runRule(noSyncIoInRequestPath, `import fs from "fs"; app.get("/x", (req, res) => { setInterval(() => { fs.readFileSync("f") }, 1000) })`)).toHaveLength(0)
  })
  it.each([
    "src/foo.test.ts",
    "src/foo.spec.ts",
    "src/db/migrations/001_init.ts",
    "scripts/seed.ts",
    "src/app.config.ts",
  ])("skips non-request-path file %s", (path) => {
    expect(runRule(noSyncIoInRequestPath, `import fs from "fs"; app.get("/x", (req, res) => { fs.readFileSync("f") })`, path)).toHaveLength(0)
  })
  it("flags an ALIASED named sync import (readFileSync as read)", () => {
    expect(runRule(noSyncIoInRequestPath, `import { readFileSync as read } from "fs"; app.get("/x", (req, res) => { read("f") })`)).toHaveLength(1)
  })
  it("does NOT treat a non-route .get with a callback as a handler (cache.get FP)", () => {
    expect(runRule(noSyncIoInRequestPath, `import fs from "fs"; cache.get("key", () => fs.readFileSync("f"))`)).toHaveLength(0)
  })
})
