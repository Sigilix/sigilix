// no-sql-injection — deterministic SQL-injection floor (CWE-89). Positives =
// request-controlled value concatenated/interpolated into a raw SQL string at a
// query sink. Negatives = the FP-safety set (parameterized queries, tagged
// templates, constant SQL, non-SQL `.run`/`.query`, escaped input).

import { describe, it, expect } from "vitest"
import { parseSource } from "../src/lib/ast-rules/parser"
import { walkAst, type AstNode } from "../src/lib/ast-rules/walker"
import { noSqlInjection } from "../src/lib/ast-rules/rules/no-sql-injection"
import type { AstRuleHit, AstRuleVisitResult } from "../src/lib/ast-rules/types"

function runRule(source: string, path = "src/routes/users.ts"): AstRuleHit[] {
  const r = parseSource(source, ".ts")
  if (!r.ok) throw new Error(`parse failed: ${r.reason}`)
  const out: AstRuleHit[] = []
  const visitors: Record<string, (n: AstNode) => void> = {}
  for (const t of noSqlInjection.nodeTypes) {
    visitors[t] = (n: AstNode) => {
      const hit: AstRuleVisitResult = noSqlInjection.visit(n, { path, source, ast: r.ast })
      if (hit) Array.isArray(hit) ? out.push(...hit) : out.push(hit)
    }
  }
  walkAst(r.ast, visitors)
  return out
}

describe("no-sql-injection — FIRES on tainted SQL strings", () => {
  it("concat: db.query('SELECT * FROM users WHERE id = ' + req.query.id)", () => {
    expect(runRule(`app.get("/u", (req, res) => { db.query("SELECT * FROM users WHERE id = " + req.query.id); });`).length).toBe(1)
  })
  it("template: conn.query(`SELECT * FROM users WHERE name = '${req.params.name}'`)", () => {
    expect(runRule("app.get('/u', (req, res) => { conn.query(`SELECT * FROM users WHERE name = '${req.params.name}'`); });").length).toBe(1)
  })
  it("tainted via local: const sql = 'DELETE FROM t WHERE id=' + req.body.id; pool.execute(sql)", () => {
    const src = `app.post("/u", (req, res) => { const sql = "DELETE FROM t WHERE id=" + req.body.id; pool.execute(sql); });`
    expect(runRule(src).length).toBe(1)
  })
  it("Prisma $queryRawUnsafe (name-sufficient): prisma.$queryRawUnsafe('SELECT ' + req.query.cols)", () => {
    expect(runRule(`app.get("/u", (req, res) => { prisma.$queryRawUnsafe("SELECT " + req.query.cols); });`).length).toBe(1)
  })
  it("knex whereRaw (name-sufficient): qb.whereRaw('id = ' + req.query.id)", () => {
    expect(runRule(`app.get("/u", (req, res) => { qb.whereRaw("id = " + req.query.id); });`).length).toBe(1)
  })
  it("Hono: c.req.query into a concatenated query", () => {
    const src = `
import { Hono } from "hono";
const app = new Hono();
app.get("/u", (c) => { return db.query("SELECT * FROM u WHERE id = " + c.req.query("id")); });`
    expect(runRule(src).length).toBe(1)
  })
})

describe("no-sql-injection — FP-safety: does NOT fire on safe query code", () => {
  it("parameterized query is safe (taint is in the params, not the SQL string)", () => {
    expect(runRule(`app.get("/u", (req, res) => { db.query("SELECT * FROM users WHERE id = $1", [req.query.id]); });`).length).toBe(0)
  })
  it("mysql ? placeholder is safe", () => {
    expect(runRule(`app.get("/u", (req, res) => { db.execute("SELECT * FROM users WHERE id = ?", [req.query.id]); });`).length).toBe(0)
  })
  it("a tagged-template query is safe (not a CallExpression): sql`SELECT ... ${id}`", () => {
    expect(runRule("app.get('/u', (req, res) => { db.query(sql`SELECT * FROM u WHERE id = ${req.query.id}`); });").length).toBe(0)
  })
  it("Prisma $queryRaw tagged template is safe", () => {
    expect(runRule("app.get('/u', (req, res) => { prisma.$queryRaw`SELECT * FROM u WHERE id = ${req.query.id}`; });").length).toBe(0)
  })
  it("a constant SQL string never fires", () => {
    expect(runRule(`app.get("/u", (req, res) => { db.query("SELECT * FROM users"); });`).length).toBe(0)
  })
  it("a non-SQL .run/.all/.get with taint does not fire (not a SQL sink method)", () => {
    expect(runRule(`app.get("/u", (req, res) => { taskRunner.run(req.query.job); });`).length).toBe(0)
    expect(runRule(`app.get("/u", (req, res) => { cache.get("user-" + req.query.k); });`).length).toBe(0)
    expect(runRule(`app.get("/u", (req, res) => { tasks.all(req.query.x); });`).length).toBe(0)
  })
  // The dominant prose-FP class the internal review caught: SQL keywords inside an
  // English sentence passed to a job/cache/log API must NOT fire.
  it("prose containing SQL keywords through a non-SQL method does not fire", () => {
    expect(runRule(`app.get("/u", (req, res) => { logger.run("UPDATE FAILED FOR " + req.query.id + " SET status"); });`).length).toBe(0)
    expect(runRule(`app.get("/u", (req, res) => { queue.run("SELECT a plan FROM options for " + req.query.user); });`).length).toBe(0)
    expect(runRule(`app.get("/u", (req, res) => { notifier.run("Please UPDATE your profile and SET " + req.query.field); });`).length).toBe(0)
  })
  it("prose through a SQL method still does not fire (anchored shape rejects mid-sentence keywords)", () => {
    // `.execute` IS a SQL sink, but the static text isn't a real statement shape.
    expect(runRule(`app.get("/u", (req, res) => { db.execute("Please SELECT a value and tell me FROM where " + req.query.x); });`).length).toBe(0)
  })
  it("a non-SQL .query with taint does not fire (DOM-like): el.query('.item-' + req.query.k)", () => {
    expect(runRule(`app.get("/u", (req, res) => { el.query(".item-" + req.query.k); });`).length).toBe(0)
  })
  it("escaped input is skipped: db.query('... ' + conn.escape(req.query.id))", () => {
    expect(runRule(`app.get("/u", (req, res) => { db.query("SELECT * FROM users WHERE id = " + conn.escape(req.query.id)); });`).length).toBe(0)
  })
  it("a constant SQL with a non-request concat never fires", () => {
    expect(runRule(`const T = "users"; app.get("/u", (req, res) => { db.query("SELECT * FROM " + T + " LIMIT 10"); });`).length).toBe(0)
  })
  it("skips test / spec / config / migration / script files", () => {
    const src = `app.get("/u", (req, res) => { db.query("SELECT * FROM users WHERE id = " + req.query.id); });`
    expect(runRule(src, "tests/users.test.ts").length).toBe(0)
    expect(runRule(src, "src/users.spec.ts").length).toBe(0)
    expect(runRule(src, "src/db.config.ts").length).toBe(0)
    expect(runRule(src, "src/migrations/001.ts").length).toBe(0)
    expect(runRule(src, "scripts/seed.ts").length).toBe(0)
  })
})
