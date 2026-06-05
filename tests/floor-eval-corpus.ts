// Floor eval corpus (SIG-114 ruler). Vulnerable (should FIRE) and safe (should
// NOT fire) code samples per deterministic security floor.
//
// WHY this exists: our own repo is a Cloudflare Worker doing PR review — its
// production code contains none of the vulnerable shapes these floors detect
// (no `db.query("…"+x)`, no `fetch(userUrl)`, no `fs.readFile(taint)`, …), so
// the `*-shadow` logs never accrue on our dogfood. This corpus is the
// measurement that works WITHOUT external traffic.
//
// HONESTY CAVEAT: the rules and this corpus were written by the same author, so
// this is a CO-AUTHORED sanity / regression ruler — it guards against
// regressions and the obvious FP classes, but it is NOT an independent
// third-party benchmark and a clean FP-rate here is not a field FP-rate. (A
// truly independent corpus from CVE PoCs / a published benchmark is the
// follow-up to make this partner-grade.) The safe set deliberately includes the
// known FP traps each floor must survive (parameterized queries, fixed-host
// fetches, basename'd paths, constant templates with tainted data, prose
// containing SQL keywords, `_.render`, …); the vuln set includes a known FN the
// open-redirect floor currently MISSES so the ruler surfaces it.

import type { AstRule } from "../src/lib/ast-rules/types"
import { noUnauthorizedObjectLookup } from "../src/lib/ast-rules/rules/no-unauthorized-object-lookup"
import { noInsecureRandomToken } from "../src/lib/ast-rules/rules/no-insecure-random-token"
import { noOpenRedirect } from "../src/lib/ast-rules/rules/no-open-redirect"
import { noSsrf } from "../src/lib/ast-rules/rules/no-ssrf"
import { noPathTraversal } from "../src/lib/ast-rules/rules/no-path-traversal"
import { noSqlInjection } from "../src/lib/ast-rules/rules/no-sql-injection"
import { noSsti } from "../src/lib/ast-rules/rules/no-ssti"
import { noNosqlInjection } from "../src/lib/ast-rules/rules/no-nosql-injection"
import { noPrototypePollution } from "../src/lib/ast-rules/rules/no-prototype-pollution"

export interface FloorEval {
  id: string
  cwe: string
  rule: AstRule
  vuln: string[] // should FIRE
  safe: string[] // should NOT fire
}

const FS = `import fs from "fs";\nimport path from "path";\n`

export const FLOOR_EVALS: FloorEval[] = [
  {
    id: "no-unauthorized-object-lookup",
    cwe: "CWE-639 IDOR/BOLA",
    rule: noUnauthorizedObjectLookup,
    vuln: [
      `app.get("/documents/:id", (req, res) => { Document.findById(req.params.id).then((d) => res.json(d)); });`,
      `router.get("/api/orders/:orderId", async (req, res) => { const o = await db.collection("orders").findOne({ _id: req.params.orderId }); res.json(o); });`,
      `app.get("/users/:userId/card", (req, res) => { res.json(Card.findOne({ user: req.params.userId })); });`,
      `app.get("/invoice/:invoiceId", async (req, res) => { const inv = await Invoice.findById(req.params.invoiceId); res.send(inv); });`,
      `app.get("/teams/:teamId", (req, res) => { const t = db.query("SELECT * FROM teams WHERE id = ?", [req.params.teamId]); res.json(t); });`,
    ],
    safe: [
      `app.get("/documents/:id", (req, res) => { if (!req.user) return res.status(401).end(); const d = Document.findById(req.params.id); if (d.ownerId !== req.user.id) return res.status(403).end(); res.json(d); });`,
      `router.get("/orders/:id", async (req, res) => { const o = await Order.findOne({ _id: req.params.id, userId: req.user.id }); res.json(o); });`,
      `app.get("/me", (req, res) => { res.json(User.findById(req.user.id)); });`,
      `app.get("/public/:slug", (req, res) => { res.json(Post.findOne({ slug: req.params.slug, published: true })); });`,
      `app.get("/config", (req, res) => { res.json(Settings.findOne({ key: "theme" })); });`,
      `app.get("/doc/:id", (req, res) => { authorize(req, "doc:read"); res.json(Document.findById(req.params.id)); });`,
    ],
  },
  {
    id: "no-insecure-random-token",
    cwe: "CWE-338 weak randomness",
    rule: noInsecureRandomToken,
    vuln: [
      `const resetToken = Math.random().toString(36).slice(2);`,
      `user.apiKey = Math.random().toString(36) + Math.random().toString(36);`,
      `function newSession() { const sessionId = "sess_" + Math.random().toString(16).slice(2); return sessionId; }`,
      `const otp = Math.floor(Math.random() * 1000000).toString();`,
      `obj.csrfToken = Math.random().toString(36).substring(2, 15);`,
    ],
    safe: [
      `const jitter = Math.random() * 1000;`,
      `const idx = Math.floor(Math.random() * items.length);`,
      `const token = crypto.randomBytes(32).toString("hex");`,
      `const delayMs = baseDelay + Math.random() * baseDelay;`,
      `const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];`,
      `const apiKey = await secretsManager.get("STRIPE_KEY");`,
    ],
  },
  {
    id: "no-open-redirect",
    cwe: "CWE-601 open redirect",
    rule: noOpenRedirect,
    vuln: [
      `app.get("/login", (req, res) => { res.redirect(req.query.returnTo); });`,
      `app.get("/out", (req, res) => { res.redirect("//" + req.query.host); });`,
      `app.get("/go", (req, res) => { res.setHeader("Location", req.query.url); res.statusCode = 302; res.end(); });`,
      `app.get("/sso", (req, res) => { const next = req.query.next; res.redirect(next); });`,
      // KNOWN FN (surfaced by this ruler): parses for the host check but then
      // redirects the RAW input, not the validated/parsed value — `//evil` or
      // `/\evil.com` bypasses `u.host === "…"`. The floor SKIPS this because it
      // reads `.host` (its "validation signal = skip" heuristic is too broad).
      // Follow-up: tighten the open-redirect host-guard to a guard-SHAPE check
      // (like SSRF/path-traversal), not any `.host` read.
      `app.get("/x", (req, res) => { const u = new URL(req.query.url, "https://app.example.com"); if (u.host === "app.example.com") res.redirect(req.query.url); });`,
    ],
    safe: [
      `app.get("/login", (req, res) => { res.redirect("/dashboard/" + req.query.tab); });`,
      `app.get("/go", (req, res) => { const u = req.query.url; if (typeof u === "string" && u.startsWith("/")) res.redirect(u); else res.redirect("/"); });`,
      `app.get("/cb", (req, res) => { const dest = isSafeRedirect(req.query.to) ? req.query.to : "/"; res.redirect(dest); });`,
      `app.get("/home", (req, res) => { res.redirect("/account"); });`,
      // genuinely safe: redirects the PARSED, same-origin path, not the raw input.
      `app.get("/x", (req, res) => { const u = new URL(req.query.url, "https://app.example.com"); if (u.host === "app.example.com") res.redirect(u.pathname); });`,
    ],
  },
  {
    id: "no-ssrf",
    cwe: "CWE-918 SSRF",
    rule: noSsrf,
    vuln: [
      `app.get("/fetch", async (req, res) => { const r = await fetch(req.query.url); res.send(await r.text()); });`,
      `app.post("/proxy", (req, res) => { axios.get(req.body.target).then((r) => res.json(r.data)); });`,
      `app.get("/img", (req, res) => { fetch("https://" + req.query.host + "/avatar"); });`,
      `app.get("/p", (req, res) => { http.get("http://localhost:" + req.query.port + "/admin"); });`,
    ],
    safe: [
      `app.get("/stripe", (req, res) => { fetch("https://api.stripe.com/v1/charges/" + req.query.id); });`,
      `app.get("/u", (req, res) => { fetch(process.env.UPSTREAM + "/users/" + req.params.id); });`,
      `app.get("/local", (req, res) => { fetch("/api/proxy/" + req.query.path); });`,
      `app.get("/cfg", (req, res) => { const API = "https://api.internal.co"; fetch(API + "/v1/" + req.query.k); });`,
      `app.get("/safe", (req, res) => { const target = req.query.url; if (isAllowedHost(new URL(target).hostname)) fetch(target); });`,
    ],
  },
  {
    id: "no-path-traversal",
    cwe: "CWE-22 path traversal",
    rule: noPathTraversal,
    vuln: [
      FS + `app.get("/file", (req, res) => { fs.readFile(req.query.name, "utf8", cb); });`,
      FS + `app.get("/dl", (req, res) => { fs.createReadStream("./uploads/" + req.params.file).pipe(res); });`,
      `import fs from "node:fs/promises";\napp.get("/r", async (req, res) => { res.send(await fs.readFile(path.join(BASE, req.query.doc))); });`,
      `app.get("/v", (req, res) => { res.sendFile(req.query.path); });`,
    ],
    safe: [
      FS + `app.get("/file", (req, res) => { fs.readFile(path.join(UPLOADS, path.basename(req.query.name)), cb); });`,
      FS + `app.get("/r", (req, res) => { const p = path.resolve(BASE, req.query.name); if (!p.startsWith(BASE)) return res.status(400).end(); fs.readFile(p, cb); });`,
      FS + `app.get("/c", (req, res) => { fs.readFile("./config/app.json", cb); });`,
      `app.get("/v", (req, res) => { res.sendFile(req.query.name, { root: SAFE_DIR }); });`,
      `import { createReadStream } from "fast-csv";\napp.post("/x", (req, res) => { createReadStream(req.body.config); });`,
    ],
  },
  {
    id: "no-sql-injection",
    cwe: "CWE-89 SQL injection",
    rule: noSqlInjection,
    vuln: [
      `app.get("/u", (req, res) => { db.query("SELECT * FROM users WHERE id = " + req.query.id); });`,
      `app.post("/s", (req, res) => { const sql = "DELETE FROM sessions WHERE token = '" + req.body.token + "'"; pool.execute(sql); });`,
      "app.get('/o', (req, res) => { conn.query(`SELECT * FROM orders WHERE customer = '${req.params.cid}'`); });",
      `app.get("/raw", (req, res) => { prisma.$queryRawUnsafe("SELECT * FROM t WHERE name = '" + req.query.name + "'"); });`,
    ],
    safe: [
      `app.get("/u", (req, res) => { db.query("SELECT * FROM users WHERE id = $1", [req.query.id]); });`,
      `app.get("/u2", (req, res) => { db.execute("SELECT * FROM users WHERE id = ?", [req.query.id]); });`,
      "app.get('/u3', (req, res) => { db.query(sql`SELECT * FROM users WHERE id = ${req.query.id}`); });",
      `app.get("/log", (req, res) => { logger.run("UPDATE FAILED for user " + req.query.id + " SET to retry"); });`,
      `app.get("/cache", (req, res) => { cache.get("user-" + req.query.id); });`,
      `app.get("/esc", (req, res) => { db.query("SELECT * FROM users WHERE name = '" + conn.escape(req.query.name) + "'"); });`,
    ],
  },
  {
    id: "no-ssti",
    cwe: "CWE-1336 SSTI",
    rule: noSsti,
    vuln: [
      `app.get("/r", (req, res) => { const html = handlebars.compile(req.query.tpl)({}); res.send(html); });`,
      `app.post("/p", (req, res) => { res.send(ejs.render(req.body.template, { user: "x" })); });`,
      `app.get("/n", (req, res) => { res.send(nunjucks.renderString(req.query.t, ctx)); });`,
      `app.get("/l", (req, res) => { const fn = _.template(req.query.t); res.send(fn({})); });`,
    ],
    safe: [
      `app.get("/r", (req, res) => { res.send(ejs.render("<h1><%= name %></h1>", { name: req.query.name })); });`,
      `app.get("/h", (req, res) => { const tpl = handlebars.compile("Hi {{name}}"); res.send(tpl({ name: req.query.n })); });`,
      `app.get("/v", (req, res) => { res.render("profile", { user: req.query.u }); });`,
      `app.get("/chart", (req, res) => { art.render(req.query.config); });`,
      `app.get("/comp", (req, res) => { component.render(req.query.x); });`,
      `app.get("/m", (req, res) => { _.map(req.query.items, fn); });`,
    ],
  },
  {
    id: "no-nosql-injection",
    cwe: "CWE-943 NoSQL injection",
    rule: noNosqlInjection,
    vuln: [
      `app.get("/u", (req, res) => { db.collection("users").find(req.query); });`,
      `app.post("/s", (req, res) => { db.collection("orders").findOne(req.body); });`,
      `app.post("/d", (req, res) => { Order.deleteMany(req.body.filter); });`,
      `app.get("/w", (req, res) => { User.find({ $where: req.query.fn }); });`,
      `app.post("/a", (req, res) => { const f = req.body; Account.updateMany(f, { $set: { active: false } }); });`,
    ],
    safe: [
      // fixed-shape literal with a tainted scalar is safe even on a real collection.
      `app.get("/u", (req, res) => { db.collection("users").findOne({ _id: req.params.id }); });`,
      // knex: `.update(obj)` is the column-map and is parameterized — the safe idiom.
      `app.post("/k", (req, res) => { knex("users").where({ id: req.params.id }).update(req.body); });`,
      // Sequelize / TypeORM: ambiguous method names, no Mongo signal → must not fire.
      `app.get("/seq", (req, res) => { User.count(req.query); });`,
      `app.get("/orm", (req, res) => { repo.find(req.query); });`,
      // array `.find(cb)` and lodash in-memory predicate.
      `app.get("/arr", (req, res) => { items.find((x) => x.id === req.query.id); });`,
      `app.get("/lod", (req, res) => { _.find(rows, req.query); });`,
    ],
  },
  {
    id: "no-prototype-pollution",
    cwe: "CWE-1321 prototype pollution",
    rule: noPrototypePollution,
    vuln: [
      `app.post("/m", (req, res) => { _.merge(target, req.body); });`,
      `app.post("/d", (req, res) => { deepmerge(opts, req.query); });`,
      `app.post("/dd", (req, res) => { _.defaultsDeep(settings, req.body.prefs); });`,
      `app.post("/mw", (req, res) => { _.mergeWith(cfg, req.body, customizer); });`,
      `app.post("/a", (req, res) => { const src = req.body; _.merge(target, src); });`,
    ],
    safe: [
      // Object.assign is SHALLOW — copies __proto__ as a plain own prop, not a sink.
      `app.post("/o", (req, res) => { Object.assign(target, req.body); });`,
      // merge of a NON-tainted object.
      `app.post("/c", (req, res) => { _.merge(target, defaults); });`,
      // bare merge on a non-lodash receiver (RxJS) — not a deep-merge sink.
      `app.post("/rx", (req, res) => { rxjs.merge(a$, req.body); });`,
      // a user-keyed dynamic-dict write is DELIBERATELY not flagged (idiomatic).
      `app.post("/cache", (req, res) => { cache[req.query.key] = req.body.value; });`,
      `app.post("/sess", (req, res) => { sessions[req.params.id] = data; });`,
      // a __proto__ sanitization guard means the dev is defending → cleared.
      `app.post("/g", (req, res) => { delete req.body.__proto__; _.merge(target, req.body); });`,
    ],
  },
]
