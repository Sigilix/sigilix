// no-prototype-pollution — deterministic prototype-pollution floor (CWE-1321).
// Positives = a request object RECURSIVELY merged into a target. Negatives = the
// FP-safety set: Object.assign (shallow), non-tainted merge, non-lodash bare
// merge, a __proto__ guard, and — deliberately — user-keyed dynamic-dictionary
// writes (`obj[req.body.key] = v`), which this floor does NOT flag (too
// indistinguishable from idiomatic cache/session/accumulator writes).

import { describe, it, expect } from "vitest"
import { parseSource } from "@/src/features/ast-rules/domain/parser"
import { walkAst, type AstNode } from "@/src/features/ast-rules/domain/walker"
import { noPrototypePollution } from "@/src/features/ast-rules/domain/rules/no-prototype-pollution"
import type { AstRuleHit, AstRuleVisitResult } from "@/src/features/ast-rules/domain/types"

function runRule(source: string, path = "src/routes/config.ts"): AstRuleHit[] {
  const r = parseSource(source, ".ts")
  if (!r.ok) throw new Error(`parse failed: ${r.reason}`)
  const out: AstRuleHit[] = []
  const visitors: Record<string, (n: AstNode) => void> = {}
  for (const t of noPrototypePollution.nodeTypes) {
    visitors[t] = (n: AstNode) => {
      const hit: AstRuleVisitResult = noPrototypePollution.visit(n, { path, source, ast: r.ast })
      if (hit) Array.isArray(hit) ? out.push(...hit) : out.push(hit)
    }
  }
  walkAst(r.ast, visitors)
  return out
}

describe("no-prototype-pollution — FIRES on a tainted object recursively merged", () => {
  it("lodash deep merge of a tainted object: _.merge(target, req.body)", () => {
    expect(runRule(`app.post("/m", (req, res) => { _.merge(target, req.body); });`).length).toBe(1)
  })
  it("distinctive standalone: deepmerge(opts, req.query)", () => {
    expect(runRule(`app.post("/d", (req, res) => { deepmerge(opts, req.query); });`).length).toBe(1)
  })
  it("distinctive method: _.defaultsDeep(settings, req.body.prefs)", () => {
    expect(runRule(`app.post("/dd", (req, res) => { _.defaultsDeep(settings, req.body.prefs); });`).length).toBe(1)
  })
  it("mergeWith: _.mergeWith(cfg, req.body, customizer)", () => {
    expect(runRule(`app.post("/mw", (req, res) => { _.mergeWith(cfg, req.body, customizer); });`).length).toBe(1)
  })
  it("tainted source via alias: const src = req.body; _.merge(target, src)", () => {
    expect(runRule(`app.post("/a", (req, res) => { const src = req.body; _.merge(target, src); });`).length).toBe(1)
  })
  it("Hono: _.merge(target, c.req.query('p'))-style whole-ref source", () => {
    const src = `
import { Hono } from "hono";
const app = new Hono();
app.post("/m", (c) => { _.merge(target, c.req.query("payload")); return c.text("ok"); });`
    expect(runRule(src).length).toBe(1)
  })
})

describe("no-prototype-pollution — FP-safety: does NOT fire", () => {
  it("Object.assign is shallow — not a recursive-merge sink", () => {
    expect(runRule(`app.post("/o", (req, res) => { Object.assign(target, req.body); });`).length).toBe(0)
  })
  it("merge of a NON-tainted object never fires", () => {
    expect(runRule(`app.post("/c", (req, res) => { _.merge(target, defaults); });`).length).toBe(0)
  })
  it("bare merge on a non-lodash receiver (RxJS / custom) does not fire", () => {
    expect(runRule(`app.post("/rx", (req, res) => { rxjs.merge(a$, req.body); });`).length).toBe(0)
    expect(runRule(`app.post("/x", (req, res) => { merge(target, req.body); });`).length).toBe(0)
  })
  it("user-keyed dynamic-dict writes are DELIBERATELY not flagged (idiomatic)", () => {
    expect(runRule(`app.post("/cache", (req, res) => { cache[req.query.key] = req.body.value; });`).length).toBe(0)
    expect(runRule(`app.post("/sess", (req, res) => { sessions[req.params.id] = data; });`).length).toBe(0)
    expect(runRule(`app.post("/acc", (req, res) => { acc[req.body.k] = 1; });`).length).toBe(0)
  })
  it("a __proto__ sanitization guard clears it (dev is defending)", () => {
    expect(
      runRule(`app.post("/g", (req, res) => { delete req.body.__proto__; _.merge(target, req.body); });`).length,
    ).toBe(0)
  })
  it("tainted SCALAR field in a fixed merge source is not a whole-tainted-ref", () => {
    expect(runRule(`app.post("/f", (req, res) => { _.merge(target, { name: req.body.name }); });`).length).toBe(0)
  })
  it("skips test / spec / config / migration / script files", () => {
    const src = `app.post("/m", (req, res) => { _.merge(target, req.body); });`
    expect(runRule(src, "tests/config.test.ts").length).toBe(0)
    expect(runRule(src, "src/config.spec.ts").length).toBe(0)
    expect(runRule(src, "src/app.config.ts").length).toBe(0)
    expect(runRule(src, "src/migrations/001.ts").length).toBe(0)
    expect(runRule(src, "scripts/seed.ts").length).toBe(0)
  })
})
