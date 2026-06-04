// no-ssrf — deterministic SSRF floor (CWE-918). Positives = request-controlled
// value reaching a server-side fetch whose AUTHORITY the request can control.
// Negatives = the FP-safety set (fixed-host targets, validated hosts, config
// objects, same-origin paths) — Codex-vetted in the plan sign-off.

import { describe, it, expect } from "vitest"
import { parseSource } from "../src/lib/ast-rules/parser"
import { walkAst, type AstNode } from "../src/lib/ast-rules/walker"
import { noSsrf } from "../src/lib/ast-rules/rules/no-ssrf"
import type { AstRuleHit, AstRuleVisitResult } from "../src/lib/ast-rules/types"

function runRule(source: string, path = "src/routes/x.ts"): AstRuleHit[] {
  const r = parseSource(source, ".ts")
  if (!r.ok) throw new Error(`parse failed: ${r.reason}`)
  const out: AstRuleHit[] = []
  const visitors: Record<string, (n: AstNode) => void> = {}
  for (const t of noSsrf.nodeTypes) {
    visitors[t] = (n: AstNode) => {
      const hit: AstRuleVisitResult = noSsrf.visit(n, { path, source, ast: r.ast })
      if (hit) Array.isArray(hit) ? out.push(...hit) : out.push(hit)
    }
  }
  walkAst(r.ast, visitors)
  return out
}

describe("no-ssrf — FIRES on request-controlled fetch authority", () => {
  it("fetch(req.query.url) — whole tainted URL", () => {
    expect(runRule(`app.get("/p", (req, res) => { fetch(req.query.url); });`).length).toBe(1)
  })
  it("taint through a local: const u = req.query.url; fetch(u)", () => {
    expect(runRule(`app.get("/p", (req, res) => { const u = req.query.url; fetch(u); });`).length).toBe(1)
  })
  it("axios.get(req.body.target)", () => {
    expect(runRule(`app.post("/p", (req, res) => { axios.get(req.body.target); });`).length).toBe(1)
  })
  it("tainted host after a scheme literal: fetch('https://' + req.query.host)", () => {
    expect(runRule(`app.get("/p", (req, res) => { fetch("https://" + req.query.host); });`).length).toBe(1)
  })
  it("tainted host in a template: fetch(`https://${req.query.host}/v1`)", () => {
    expect(runRule("app.get('/p', (req, res) => { fetch(`https://${req.query.host}/v1`); });").length).toBe(1)
  })
  it("tainted port on localhost: http.get('http://localhost:' + req.query.port)", () => {
    expect(runRule(`app.get("/p", (req, res) => { http.get("http://localhost:" + req.query.port); });`).length).toBe(1)
  })
  it("Hono: c.req.query into got()", () => {
    const src = `
import { Hono } from "hono";
const app = new Hono();
app.get("/p", (c) => { return got(c.req.query("url")); });`
    expect(runRule(src).length).toBe(1)
  })
  it("Workers: fetch(new URL(request.url).searchParams.get('dest'))", () => {
    const src = `export default { async fetch(request) { return fetch(new URL(request.url).searchParams.get("dest")); } };`
    expect(runRule(src, "src/worker.ts").length).toBe(1)
  })
  it("got.get / ky.get method forms fire", () => {
    expect(runRule(`app.get("/p", (req, res) => { got.get(req.query.url); });`).length).toBe(1)
    expect(runRule(`app.get("/p", (req, res) => { ky.get(req.query.url); });`).length).toBe(1)
  })
})

describe("no-ssrf — FP-safety: does NOT fire on safe fetch code", () => {
  it("a constant URL never fires", () => {
    expect(runRule(`app.get("/p", (req, res) => { fetch("https://api.example.com/health"); });`).length).toBe(0)
  })
  it("fixed host, tainted PATH only: fetch('https://api.stripe.com/v1/' + req.query.id)", () => {
    expect(runRule(`app.get("/p", (req, res) => { fetch("https://api.stripe.com/v1/" + req.query.id); });`).length).toBe(0)
  })
  it("folded literals keep the host fixed: fetch('https://api.x.com' + '/' + req.query.id)", () => {
    expect(runRule(`app.get("/p", (req, res) => { fetch("https://api.x.com" + "/" + req.query.id); });`).length).toBe(0)
  })
  it("same-file const base is resolved: const API='https://api.x.com'; fetch(API + '/v1/' + req.query.id)", () => {
    const src = `const API = "https://api.x.com";
app.get("/p", (req, res) => { fetch(API + "/v1/" + req.query.id); });`
    expect(runRule(src).length).toBe(0)
  })
  // FP cluster A/B/C/D from the internal review: an UNRESOLVABLE leading operand
  // (env var, imported const, template-interpolated const, deep alias) is still a
  // FIXED authority once a path separator closes it before any taint.
  it("env-var base + tainted path: fetch(process.env.UPSTREAM + '/users/' + req.params.id)", () => {
    expect(runRule(`app.get("/p", (req, res) => { fetch(process.env.UPSTREAM + "/users/" + req.params.id); });`).length).toBe(0)
  })
  it("env-var base in a template: fetch(`${process.env.UPSTREAM}/users/${req.params.id}`)", () => {
    expect(runRule("app.get('/p', (req, res) => { fetch(`${process.env.UPSTREAM}/users/${req.params.id}`); });").length).toBe(0)
  })
  it("same-file const host in a TEMPLATE: const H='https://api.x.com'; fetch(`${H}/v1/${req.params.id}`)", () => {
    const src = "const H = 'https://api.x.com';\napp.get('/p', (req, res) => { fetch(`${H}/v1/${req.params.id}`); });"
    expect(runRule(src).length).toBe(0)
  })
  it("imported / undeclared base const + tainted path: fetch(API_BASE + '/v1/' + req.query.id)", () => {
    expect(runRule(`app.get("/p", (req, res) => { fetch(API_BASE + "/v1/" + req.query.id); });`).length).toBe(0)
  })
  it("fixed prefix through a local: const u = 'https://api.x.com/' + req.query.id; fetch(u)", () => {
    const src = `app.get("/p", (req, res) => { const u = "https://api.x.com/" + req.query.id; fetch(u); });`
    expect(runRule(src).length).toBe(0)
  })
  it("same-origin relative path: fetch('/proxy/' + req.query.path)", () => {
    expect(runRule(`app.get("/p", (req, res) => { fetch("/proxy/" + req.query.path); });`).length).toBe(0)
  })
  it("new URL(tainted, fixedBase) pins the origin", () => {
    expect(runRule(`app.get("/p", (req, res) => { fetch(new URL(req.query.path, "https://api.x.com")); });`).length).toBe(0)
  })
  it("config-object form is not analyzed: axios({ url: 'https://api.x', params: req.query })", () => {
    expect(runRule(`app.get("/p", (req, res) => { axios({ url: "https://api.x", params: req.query }); });`).length).toBe(0)
  })
  it("http.get config object: http.get({ hostname: 'api.x', path: '/v1/' + req.query.id })", () => {
    expect(runRule(`app.get("/p", (req, res) => { http.get({ hostname: "api.x", path: "/v1/" + req.query.id }); });`).length).toBe(0)
  })
  it("new Request body taint is not the URL: fetch(new Request('https://api.x/v1', { body: req.body }))", () => {
    expect(runRule(`app.post("/p", (req, res) => { fetch(new Request("https://api.x/v1", { body: req.body })); });`).length).toBe(0)
  })
  it("a host allow-list validator is skipped", () => {
    const src = `app.get("/p", (req, res) => {
      const target = req.query.url;
      if (isAllowedHost(target)) fetch(target);
    });`
    expect(runRule(src).length).toBe(0)
  })
  it("an inline parsed-host check is skipped", () => {
    const src = `app.get("/p", (req, res) => {
      const u = new URL(req.query.url);
      if (u.hostname === "api.example.com") fetch(req.query.url);
    });`
    expect(runRule(src).length).toBe(0)
  })
  it("a non-fetch call never fires: res.json(req.query.url)", () => {
    expect(runRule(`app.get("/p", (req, res) => { res.json(req.query.url); });`).length).toBe(0)
  })
  it("skips test / spec / migration files", () => {
    const src = `app.get("/p", (req, res) => { fetch(req.query.url); });`
    expect(runRule(src, "tests/proxy.test.ts").length).toBe(0)
    expect(runRule(src, "src/migrations/001.ts").length).toBe(0)
  })
})
