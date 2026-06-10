// no-xxe — deterministic XML-external-entity floor (CWE-611).
// Positives = an XML parse with an external-entity option ENABLED on request-
// controlled input. Negatives = the FP-safety set (entities disabled, no option,
// constant input, a safe-by-default parser, non-XML parsing).

import { describe, it, expect } from "vitest"
import { parseSource } from "@/src/features/ast-rules/domain/parser"
import { walkAst, type AstNode } from "@/src/features/ast-rules/domain/walker"
import { noXxe } from "@/src/features/ast-rules/domain/rules/no-xxe"
import type { AstRuleHit, AstRuleVisitResult } from "@/src/features/ast-rules/domain/types"

function runRule(source: string, path = "src/routes/xml.ts"): AstRuleHit[] {
  const r = parseSource(source, ".ts")
  if (!r.ok) throw new Error(`parse failed: ${r.reason}`)
  const out: AstRuleHit[] = []
  const visitors: Record<string, (n: AstNode) => void> = {}
  for (const t of noXxe.nodeTypes) {
    visitors[t] = (n: AstNode) => {
      const hit: AstRuleVisitResult = noXxe.visit(n, { path, source, ast: r.ast })
      if (hit) Array.isArray(hit) ? out.push(...hit) : out.push(hit)
    }
  }
  walkAst(r.ast, visitors)
  return out
}

describe("no-xxe — FIRES on entity-enabled XML parse of untrusted input", () => {
  it("libxmljs.parseXml(req.body.xml, { noent: true })", () => {
    expect(runRule(`app.post("/x", (req, res) => { libxmljs.parseXml(req.body.xml, { noent: true }); });`).length).toBe(1)
  })
  it("replaceEntities: true on req.query input", () => {
    expect(runRule(`app.post("/p", (req, res) => { parser.parseXmlString(req.query.data, { replaceEntities: true }); });`).length).toBe(1)
  })
  it("resolveExternalEntities: true on req.body", () => {
    expect(runRule(`app.post("/r", (req, res) => { libxml.parseXml(req.body.payload, { resolveExternalEntities: true }); });`).length).toBe(1)
  })
  it("tainted input via a local: const xml = req.body.doc; parseXml(xml, { noent: true })", () => {
    expect(runRule(`app.post("/d", (req, res) => { const xml = req.body.doc; parseXml(xml, { dtdload: true, noent: true }); });`).length).toBe(1)
  })
  it("Hono: parseXml(c.req.query('xml'), { noent: true })", () => {
    const src = `
import { Hono } from "hono";
const app = new Hono();
app.post("/x", (c) => { libxmljs.parseXml(c.req.query("xml"), { noent: true }); return c.text("ok"); });`
    expect(runRule(src).length).toBe(1)
  })
})

describe("no-xxe — FP-safety: does NOT fire", () => {
  it("entities explicitly DISABLED (noent: false) is safe", () => {
    expect(runRule(`app.post("/s", (req, res) => { libxmljs.parseXml(req.body.xml, { noent: false }); });`).length).toBe(0)
  })
  it("no entity option (the safe default) never fires", () => {
    expect(runRule(`app.post("/d", (req, res) => { libxmljs.parseXml(req.body.xml); });`).length).toBe(0)
  })
  it("constant / non-request input never fires", () => {
    expect(runRule(`app.post("/c", (req, res) => { libxmljs.parseXml("<root/>", { noent: true }); });`).length).toBe(0)
    expect(runRule(`app.post("/t", (req, res) => { libxmljs.parseXml(trustedDoc, { noent: true }); });`).length).toBe(0)
  })
  it("a safe-by-default parser with no entity option does not fire", () => {
    expect(runRule(`app.post("/x2", (req, res) => { xml2js.parseString(req.body.xml, cb); });`).length).toBe(0)
  })
  it("non-XML parsing (JSON) never fires", () => {
    expect(runRule(`app.post("/j", (req, res) => { JSON.parse(req.body.data); });`).length).toBe(0)
  })
  it("an unrelated options object (no entity switch) does not fire", () => {
    expect(runRule(`app.post("/o", (req, res) => { parseXml(req.body.xml, { encoding: "utf8", compact: true }); });`).length).toBe(0)
  })
  it("a falsy non-boolean entity value (noent: 0) does not fire", () => {
    expect(runRule(`app.post("/z", (req, res) => { libxmljs.parseXml(req.body.xml, { noent: 0 }); });`).length).toBe(0)
  })
  it("taint ONLY inside the options object (not the parsed input) does not fire", () => {
    expect(runRule(`app.post("/b", (req, res) => { libxmljs.parseXml(trustedXml, { noent: true, baseUrl: req.body.base }); });`).length).toBe(0)
  })
  it("a NON-XML call reusing an entity-option name does not fire (sink-gated, CodeRabbit #363)", () => {
    expect(runRule(`app.post("/api", (req, res) => { client.configure(req.body.x, { noent: true }); });`).length).toBe(0)
    expect(runRule(`app.post("/c", (req, res) => { chart.render(req.body.data, { dtdload: true }); });`).length).toBe(0)
  })
  it("skips test / spec / config / migration / script files", () => {
    const src = `app.post("/x", (req, res) => { libxmljs.parseXml(req.body.xml, { noent: true }); });`
    expect(runRule(src, "tests/xml.test.ts").length).toBe(0)
    expect(runRule(src, "src/xml.spec.ts").length).toBe(0)
    expect(runRule(src, "src/xml.config.ts").length).toBe(0)
    expect(runRule(src, "src/migrations/001.ts").length).toBe(0)
    expect(runRule(src, "scripts/seed.ts").length).toBe(0)
  })
})
