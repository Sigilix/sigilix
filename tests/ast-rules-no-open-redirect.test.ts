// no-open-redirect — deterministic open-redirect floor (CWE-601). Positives =
// request-controlled value into a redirect/Location sink. Negatives = the
// FP-safety set (constant targets, validated destinations, non-redirect sinks).

import { describe, it, expect } from "vitest"
import { parseSource } from "../src/lib/ast-rules/parser"
import { walkAst, type AstNode } from "../src/lib/ast-rules/walker"
import { noOpenRedirect } from "../src/lib/ast-rules/rules/no-open-redirect"
import type { AstRuleHit, AstRuleVisitResult } from "../src/lib/ast-rules/types"

function runRule(source: string, path = "src/routes/x.ts"): AstRuleHit[] {
  const r = parseSource(source, ".ts")
  if (!r.ok) throw new Error(`parse failed: ${r.reason}`)
  const out: AstRuleHit[] = []
  const visitors: Record<string, (n: AstNode) => void> = {}
  for (const t of noOpenRedirect.nodeTypes) {
    visitors[t] = (n: AstNode) => {
      const hit: AstRuleVisitResult = noOpenRedirect.visit(n, { path, source, ast: r.ast })
      if (hit) Array.isArray(hit) ? out.push(...hit) : out.push(hit)
    }
  }
  walkAst(r.ast, visitors)
  return out
}

describe("no-open-redirect — FIRES on request-controlled redirects", () => {
  it("Express: res.redirect(req.query.url)", () => {
    expect(runRule(`app.get("/r", (req, res) => { res.redirect(req.query.url); });`).length).toBe(1)
  })
  it("taint flows through a local: const next = req.query.next; res.redirect(next)", () => {
    const src = `app.get("/r", (req, res) => { const next = req.query.next; res.redirect(next); });`
    expect(runRule(src).length).toBe(1)
  })
  it("Hono: c.redirect(c.req.query('returnTo'))", () => {
    const src = `
import { Hono } from "hono";
const app = new Hono();
app.get("/r", (c) => { return c.redirect(c.req.query("returnTo")); });`
    expect(runRule(src).length).toBe(1)
  })
  it("Workers: Response.redirect(new URL(request.url).searchParams.get('dest'))", () => {
    const src = `
export default {
  async fetch(request, env) {
    return Response.redirect(new URL(request.url).searchParams.get("dest"));
  }
};`
    expect(runRule(src, "src/worker.ts").length).toBe(1)
  })
  it("Location header: res.setHeader('Location', req.query.url)", () => {
    expect(runRule(`app.get("/r", (req, res) => { res.setHeader("Location", req.query.url); });`).length).toBe(1)
  })
  it("Express status + url form: res.redirect(301, req.query.url)", () => {
    expect(runRule(`app.get("/r", (req, res) => { res.redirect(301, req.query.url); });`).length).toBe(1)
  })
  it("Workers Headers.set: headers.set('Location', tainted) on a Headers receiver fires", () => {
    const src = `export async function handle(request) {
      const headers = new Headers();
      headers.set("Location", new URL(request.url).searchParams.get("dest"));
      return new Response(null, { status: 302, headers });
    }`
    expect(runRule(src, "src/worker.ts").length).toBe(1)
  })
  it("res.headers.append('Location', req.query.url) on a .headers member fires", () => {
    expect(runRule(`app.get("/r", (req, res) => { res.headers.append("Location", req.query.url); });`).length).toBe(1)
  })
  // F1 recall: prefixes that let the tainted tail escape the origin MUST still fire.
  it("protocol-relative prefix STILL fires: res.redirect('//' + req.query.x)", () => {
    expect(runRule(`app.get("/r", (req, res) => { res.redirect("//" + req.query.x); });`).length).toBe(1)
  })
  it("bare-slash prefix STILL fires (tail can become '//evil'): res.redirect('/' + req.query.x)", () => {
    expect(runRule(`app.get("/r", (req, res) => { res.redirect("/" + req.query.x); });`).length).toBe(1)
  })
  it("tainted-leading concat STILL fires: res.redirect(req.query.url + '?x=1')", () => {
    expect(runRule(`app.get("/r", (req, res) => { res.redirect(req.query.url + "?x=1"); });`).length).toBe(1)
  })
  it("absolute-URL prefix STILL fires: res.redirect('https://' + req.query.dest)", () => {
    expect(runRule(`app.get("/r", (req, res) => { res.redirect("https://" + req.query.dest); });`).length).toBe(1)
  })
})

describe("no-open-redirect — FP-safety: does NOT fire on safe redirect code", () => {
  it("a constant redirect target never fires", () => {
    expect(runRule(`app.get("/r", (req, res) => { res.redirect("/home"); });`).length).toBe(0)
  })
  it("a validated destination (startsWith) is skipped (fail closed)", () => {
    const src = `app.get("/r", (req, res) => {
      const url = req.query.url;
      if (typeof url === "string" && url.startsWith("/")) res.redirect(url);
      else res.redirect("/");
    });`
    expect(runRule(src).length).toBe(0)
  })
  it("a named safe-redirect validator is skipped", () => {
    const src = `app.get("/r", (req, res) => {
      const dest = isSafeRedirect(req.query.to) ? req.query.to : "/";
      res.redirect(dest);
    });`
    expect(runRule(src).length).toBe(0)
  })
  it("a parsed-URL host check is skipped", () => {
    const src = `app.get("/r", (req, res) => {
      const u = new URL(req.query.url, "https://app.example.com");
      if (u.host === "app.example.com") res.redirect(req.query.url);
    });`
    expect(runRule(src).length).toBe(0)
  })
  it("a non-Location header write never fires", () => {
    expect(runRule(`app.get("/r", (req, res) => { res.setHeader("X-Trace", req.query.id); });`).length).toBe(0)
  })
  it("a non-redirect sink (res.json) never fires", () => {
    expect(runRule(`app.get("/r", (req, res) => { res.json(req.query.data); });`).length).toBe(0)
  })
  it("Map/cache .set('location', tainted) does NOT fire (not a Headers receiver) — H1", () => {
    expect(runRule(`app.get("/r", (req, res) => { const cache = new Map(); cache.set("location", req.query.x); res.end(); });`).length).toBe(0)
  })
  it("url.searchParams.set('location', tainted) does NOT fire (not a Headers receiver)", () => {
    const src = `app.get("/r", (req, res) => { const u = new URL("https://x"); u.searchParams.set("location", req.query.x); res.end(); });`
    expect(runRule(src).length).toBe(0)
  })
  it("map.location(req.query.coords) does NOT fire (location verb dropped) — H2", () => {
    expect(runRule(`app.get("/r", (req, res) => { const map = makeMap(); map.location(req.query.coords); res.end(); });`).length).toBe(0)
  })
  it("a Map NAMED headers does NOT fire (declaration-based receiver, not name) — F2", () => {
    const src = `app.get("/r", (req, res) => { const headers = new Map(); headers.set("location", req.query.x); res.end(); });`
    expect(runRule(src).length).toBe(0)
  })
  // F1: a literal same-origin path prefix makes the request tail non-escaping.
  it("same-origin prefix concat does NOT fire: res.redirect('/dashboard/' + req.query.tab)", () => {
    expect(runRule(`app.get("/r", (req, res) => { res.redirect("/dashboard/" + req.query.tab); });`).length).toBe(0)
  })
  it("same-origin template does NOT fire: res.redirect(`/u/${req.params.id}/edit`)", () => {
    expect(runRule("app.get('/r', (req, res) => { res.redirect(`/u/${req.params.id}/edit`); });").length).toBe(0)
  })
  it("same-origin prefix chain does NOT fire: res.redirect('/users/' + req.params.id + '?x=1')", () => {
    expect(runRule(`app.get("/r", (req, res) => { res.redirect("/users/" + req.params.id + "?x=1"); });`).length).toBe(0)
  })
  it("skips test / spec / migration files", () => {
    const src = `app.get("/r", (req, res) => { res.redirect(req.query.url); });`
    expect(runRule(src, "tests/routes.test.ts").length).toBe(0)
    expect(runRule(src, "src/migrations/001.ts").length).toBe(0)
  })
})
