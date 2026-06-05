// no-nosql-injection — deterministic NoSQL-injection floor (CWE-943).
// Positives = a request object handed DIRECTLY to a Mongo query as the filter,
// with a POSITIVE Mongo signal (distinctive driver method / `.collection(` /
// Mongoose chain / tainted `$where`). Negatives = the FP-safety set (fixed-shape
// scalar, knex/Sequelize/TypeORM ambiguous-name collisions, array `.find(cb)`,
// lodash, bare Mongoose with no signal, sanitized).

import { describe, it, expect } from "vitest"
import { parseSource } from "../src/lib/ast-rules/parser"
import { walkAst, type AstNode } from "../src/lib/ast-rules/walker"
import { noNosqlInjection } from "../src/lib/ast-rules/rules/no-nosql-injection"
import type { AstRuleHit, AstRuleVisitResult } from "../src/lib/ast-rules/types"

function runRule(source: string, path = "src/routes/users.ts"): AstRuleHit[] {
  const r = parseSource(source, ".ts")
  if (!r.ok) throw new Error(`parse failed: ${r.reason}`)
  const out: AstRuleHit[] = []
  const visitors: Record<string, (n: AstNode) => void> = {}
  for (const t of noNosqlInjection.nodeTypes) {
    visitors[t] = (n: AstNode) => {
      const hit: AstRuleVisitResult = noNosqlInjection.visit(n, { path, source, ast: r.ast })
      if (hit) Array.isArray(hit) ? out.push(...hit) : out.push(hit)
    }
  }
  walkAst(r.ast, visitors)
  return out
}

describe("no-nosql-injection — FIRES on a request object handed directly to a query", () => {
  it("native driver: db.collection('users').find(req.query)", () => {
    expect(runRule(`app.get("/u", (req, res) => { db.collection("users").find(req.query); });`).length).toBe(1)
  })
  it("native driver: db.collection('orders').findOne(req.body)", () => {
    expect(runRule(`app.post("/u", (req, res) => { db.collection("orders").findOne(req.body); });`).length).toBe(1)
  })
  it("distinctive method (name-sufficient): deleteMany(req.body.filter)", () => {
    expect(runRule(`app.post("/d", (req, res) => { Order.deleteMany(req.body.filter); });`).length).toBe(1)
  })
  it("distinctive method via a whole-object alias: const f = req.body; updateMany(f, ...)", () => {
    expect(runRule(`app.post("/a", (req, res) => { const f = req.body; Account.updateMany(f, { $set: { active: false } }); });`).length).toBe(1)
  })
  it("$where with a tainted value (server-side JS injection) — $where is itself a Mongo signal", () => {
    expect(runRule(`app.get("/w", (req, res) => { User.find({ $where: req.query.fn }); });`).length).toBe(1)
  })
  it("$function with a tainted value", () => {
    expect(runRule(`app.get("/f", (req, res) => { User.find({ $function: { body: req.query.fn, args: [], lang: "js" } }); });`).length).toBe(1)
  })
  it("$accumulator with a tainted value", () => {
    expect(runRule(`app.post("/ac", (req, res) => { Metric.find({ $accumulator: req.body.acc }); });`).length).toBe(1)
  })
  it("Mongoose query chain: User.find(req.query).lean()", () => {
    expect(runRule(`app.get("/m", (req, res) => { User.find(req.query).sort({ a: 1 }).lean(); });`).length).toBe(1)
  })
  it("Hono native driver: db.collection('u').deleteOne(c.req.query('id'))", () => {
    const src = `
import { Hono } from "hono";
const app = new Hono();
app.post("/u", (c) => { return db.collection("u").deleteOne(c.req.query("id")); });`
    expect(runRule(src).length).toBe(1)
  })
})

describe("no-nosql-injection — FP-safety: does NOT fire on safe / non-Mongo code", () => {
  it("fixed-shape literal with a tainted SCALAR is safe even on a real collection", () => {
    expect(runRule(`app.get("/u", (req, res) => { db.collection("users").findOne({ _id: req.params.id }); });`).length).toBe(0)
  })
  it("fixed-shape multi-field literal: find({ username: req.body.username, active: true })", () => {
    expect(runRule(`app.post("/u", (req, res) => { db.collection("u").find({ username: req.body.username, active: true }); });`).length).toBe(0)
  })
  it("knex `.update(req.body)` is the safe parameterized column-map idiom", () => {
    expect(runRule(`app.post("/k", (req, res) => { knex("users").where({ id: req.params.id }).update(req.body); });`).length).toBe(0)
  })
  it("Sequelize/TypeORM ambiguous names with no Mongo signal do not fire", () => {
    expect(runRule(`app.get("/seq", (req, res) => { User.count(req.query); });`).length).toBe(0)
    expect(runRule(`app.get("/orm", (req, res) => { repo.find(req.query); });`).length).toBe(0)
    expect(runRule(`app.post("/orm2", (req, res) => { Model.update(req.body, { where: { id: 1 } }); });`).length).toBe(0)
  })
  it("array .find(callback) never fires (callback, not a tainted object)", () => {
    expect(runRule(`app.get("/a", (req, res) => { items.find((x) => x.id === req.query.id); });`).length).toBe(0)
  })
  it("lodash/underscore receivers are excluded (in-memory predicate, not a DB)", () => {
    expect(runRule(`app.get("/l", (req, res) => { _.find(rows, req.query); });`).length).toBe(0)
    expect(runRule(`app.get("/l2", (req, res) => { lodash.find(rows, req.body); });`).length).toBe(0)
  })
  it("bare Mongoose find with NO signal is a deliberate FN (Model ≈ ORM repo; fail closed)", () => {
    expect(runRule(`app.get("/u", (req, res) => { User.find(req.query); });`).length).toBe(0)
  })
  it("no taint: a constant filter never fires", () => {
    expect(runRule(`app.get("/u", (req, res) => { db.collection("u").find({ role: "admin" }); });`).length).toBe(0)
  })
  it("a shadowed/redeclared binding is never tainted (CodeRabbit #356 — fail closed)", () => {
    // `f` is redeclared; the inner sanitized binding reaches the sink. The
    // ambiguous-name guard skips `f` entirely rather than merging taint.
    const src = `app.get("/u", (req, res) => { const f = req.body; doStuff(f); { const f = { _id: "fixed" }; db.collection("u").findOne(f); } });`
    expect(runRule(src).length).toBe(0)
  })
  it("a catch-param shadowing a tainted outer binding does not fire (CodeRabbit #356)", () => {
    // `f` is the caught error inside the catch, NOT the outer tainted `req.body`.
    const src = `app.get("/u", (req, res) => { const f = req.body; try { go(f); } catch (f) { db.collection("u").findOne(f); } });`
    expect(runRule(src).length).toBe(0)
  })
  it("a sanitized filter is skipped (fail closed)", () => {
    expect(runRule(`app.get("/u", (req, res) => { const f = mongoSanitize(req.query); db.collection("u").find(f); });`).length).toBe(0)
  })
  it("skips test / spec / config / migration / script files", () => {
    const src = `app.get("/u", (req, res) => { db.collection("u").find(req.query); });`
    expect(runRule(src, "tests/users.test.ts").length).toBe(0)
    expect(runRule(src, "src/users.spec.ts").length).toBe(0)
    expect(runRule(src, "src/db.config.ts").length).toBe(0)
    expect(runRule(src, "src/migrations/001.ts").length).toBe(0)
    expect(runRule(src, "scripts/seed.ts").length).toBe(0)
  })
})
