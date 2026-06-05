// no-ssti — deterministic server-side template-injection floor (CWE-1336).
// Positives = request-controlled value as the TEMPLATE source of a template
// engine. Negatives = the FP-safety set (constant template + tainted DATA arg,
// `res.render` view names, non-engine receivers).

import { describe, it, expect } from "vitest"
import { parseSource } from "../src/lib/ast-rules/parser"
import { walkAst, type AstNode } from "../src/lib/ast-rules/walker"
import { noSsti } from "../src/lib/ast-rules/rules/no-ssti"
import type { AstRuleHit, AstRuleVisitResult } from "../src/lib/ast-rules/types"

function runRule(source: string, path = "src/routes/render.ts"): AstRuleHit[] {
  const r = parseSource(source, ".ts")
  if (!r.ok) throw new Error(`parse failed: ${r.reason}`)
  const out: AstRuleHit[] = []
  const visitors: Record<string, (n: AstNode) => void> = {}
  for (const t of noSsti.nodeTypes) {
    visitors[t] = (n: AstNode) => {
      const hit: AstRuleVisitResult = noSsti.visit(n, { path, source, ast: r.ast })
      if (hit) Array.isArray(hit) ? out.push(...hit) : out.push(hit)
    }
  }
  walkAst(r.ast, visitors)
  return out
}

describe("no-ssti — FIRES on request-controlled template source", () => {
  it("handlebars.compile(req.query.tpl)", () => {
    expect(runRule(`app.get("/r", (req, res) => { handlebars.compile(req.query.tpl); });`).length).toBe(1)
  })
  it("ejs.render(req.body.t, data) — template is arg 0", () => {
    expect(runRule(`app.post("/r", (req, res) => { ejs.render(req.body.t, { name: "x" }); });`).length).toBe(1)
  })
  it("pug.compile(req.params.x)", () => {
    expect(runRule(`app.get("/r", (req, res) => { pug.compile(req.params.x); });`).length).toBe(1)
  })
  it("nunjucks.renderString(req.query.t) — name-sufficient", () => {
    expect(runRule(`app.get("/r", (req, res) => { nunjucks.renderString(req.query.t, ctx); });`).length).toBe(1)
  })
  it("_.template(req.query.t) (lodash)", () => {
    expect(runRule(`app.get("/r", (req, res) => { _.template(req.query.t); });`).length).toBe(1)
  })
  it("tainted via a local: const t = req.body.tpl; ejs.render(t, data)", () => {
    expect(runRule(`app.post("/r", (req, res) => { const t = req.body.tpl; ejs.render(t, data); });`).length).toBe(1)
  })
  it("Hono: hbs.compile(c.req.query('tpl'))", () => {
    const src = `
import { Hono } from "hono";
const app = new Hono();
app.get("/r", (c) => { return hbs.compile(c.req.query("tpl")); });`
    expect(runRule(src).length).toBe(1)
  })
})

describe("no-ssti — FP-safety: does NOT fire on safe templating", () => {
  it("constant template + tainted DATA is safe (taint in arg 1, not the template)", () => {
    expect(runRule(`app.get("/r", (req, res) => { ejs.render("<h1><%= name %></h1>", { name: req.query.name }); });`).length).toBe(0)
  })
  it("handlebars.compile with a constant template never fires", () => {
    expect(runRule(`app.get("/r", (req, res) => { const tpl = handlebars.compile("Hi {{name}}"); tpl({ name: req.query.n }); });`).length).toBe(0)
  })
  it("Express res.render(viewName, data) is NOT a template sink (view name, not source)", () => {
    expect(runRule(`app.get("/r", (req, res) => { res.render("profile", { user: req.query.u }); });`).length).toBe(0)
  })
  it("res.render with a tainted VIEW name does not fire here (not a template engine receiver)", () => {
    // (a tainted view path is a path-traversal/LFI concern, handled elsewhere — `res` is not an engine)
    expect(runRule(`app.get("/r", (req, res) => { res.render(req.query.view, data); });`).length).toBe(0)
  })
  it("a non-engine .compile (regex/schema builder) does not fire: schema.compile(req.body.x)", () => {
    expect(runRule(`app.post("/r", (req, res) => { schema.compile(req.body.x); });`).length).toBe(0)
  })
  it("a non-engine .render does not fire: component.render(req.query.x)", () => {
    expect(runRule(`app.get("/r", (req, res) => { component.render(req.query.x); });`).length).toBe(0)
  })
  // Internal review: lodash only has `.template` (no `_.render`/`_.compile`), and
  // short collision-prone names (eta/art/dot) must NOT fire on generic .render.
  it("lodash `.render`/`.compile` do NOT fire (only `_.template` is a sink)", () => {
    expect(runRule(`app.get("/r", (req, res) => { _.render(req.query.x); });`).length).toBe(0)
    expect(runRule(`app.get("/r", (req, res) => { underscore.compile(req.query.x); });`).length).toBe(0)
  })
  it("a collision-prone short name does NOT fire on generic .render: art.render(req.query.config)", () => {
    expect(runRule(`app.get("/r", (req, res) => { art.render(req.query.config); });`).length).toBe(0)
    expect(runRule(`app.get("/r", (req, res) => { eta.render(req.query.x); });`).length).toBe(0)
  })
  it("skips test / spec / config / migration / script files", () => {
    const src = `app.get("/r", (req, res) => { handlebars.compile(req.query.tpl); });`
    expect(runRule(src, "tests/render.test.ts").length).toBe(0)
    expect(runRule(src, "src/render.spec.ts").length).toBe(0)
    expect(runRule(src, "src/view.config.ts").length).toBe(0)
    expect(runRule(src, "src/migrations/001.ts").length).toBe(0)
    expect(runRule(src, "scripts/seed.ts").length).toBe(0)
  })
})
