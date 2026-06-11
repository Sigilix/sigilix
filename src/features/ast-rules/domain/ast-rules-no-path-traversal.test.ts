// no-path-traversal — deterministic path-traversal floor (CWE-22). Positives =
// request-controlled value reaching an IMPORT-RESOLVED filesystem path op with no
// sanitization. Negatives = the FP-safety set (constants, basename/within-root
// guards, root-confined sendFile, non-fs sinks, non-fs `createReadStream`).

import { describe, it, expect } from "vitest"
import { parseSource } from "@/src/features/ast-rules/domain/parser"
import { walkAst, type AstNode } from "@/src/features/ast-rules/domain/walker"
import { noPathTraversal } from "@/src/features/ast-rules/domain/rules/no-path-traversal"
import type { AstRuleHit, AstRuleVisitResult } from "@/src/features/ast-rules/domain/types"

function runRule(source: string, path = "src/routes/files.ts"): AstRuleHit[] {
  const r = parseSource(source, ".ts")
  if (!r.ok) throw new Error(`parse failed: ${r.reason}`)
  const out: AstRuleHit[] = []
  const visitors: Record<string, (n: AstNode) => void> = {}
  for (const t of noPathTraversal.nodeTypes) {
    visitors[t] = (n: AstNode) => {
      const hit: AstRuleVisitResult = noPathTraversal.visit(n, { path, source, ast: r.ast })
      if (hit) Array.isArray(hit) ? out.push(...hit) : out.push(hit)
    }
  }
  walkAst(r.ast, visitors)
  return out
}

// fs / path imports the rule resolves against (most fixtures need a real fs binding).
const FS = `import fs from "fs";\nimport path from "path";\n`

describe("no-path-traversal — FIRES on request-controlled fs paths", () => {
  it("fs.readFile(req.query.file)", () => {
    expect(runRule(FS + `app.get("/f", (req, res) => { fs.readFile(req.query.file, cb); });`).length).toBe(1)
  })
  it("fixed base + tainted tail still fires (../ escapes): fs.readFileSync('./uploads/' + req.params.name)", () => {
    expect(
      runRule(FS + `app.get("/f", (req, res) => { fs.readFileSync("./uploads/" + req.params.name); });`).length,
    ).toBe(1)
  })
  it("taint through path.join: fs.readFile(path.join(BASE, req.query.name))", () => {
    expect(
      runRule(FS + `app.get("/f", (req, res) => { fs.readFile(path.join(BASE, req.query.name), cb); });`).length,
    ).toBe(1)
  })
  it("fs.promises member: fs.promises.readFile(req.query.p)", () => {
    expect(
      runRule(FS + `app.get("/f", async (req, res) => { await fs.promises.readFile(req.query.p); });`).length,
    ).toBe(1)
  })
  it("named import: import { readFile } from 'fs/promises'; readFile(req.query.p)", () => {
    const src = `import { readFile } from "fs/promises";\napp.get("/f", async (req, res) => { await readFile(req.query.p); });`
    expect(runRule(src).length).toBe(1)
  })
  it("bare destructured callee (require): const { createReadStream } = require('fs'); createReadStream(req.query.path)", () => {
    const src = `const { createReadStream } = require("fs");\napp.get("/f", (req, res) => { createReadStream(req.query.path).pipe(res); });`
    expect(runRule(src).length).toBe(1)
  })
  it("Express res.sendFile(req.query.path) inside an (req, res) handler", () => {
    expect(runRule(`app.get("/f", (req, res) => { res.sendFile(req.query.path); });`).length).toBe(1)
  })
  it("a request-controlled { root } is no boundary → still fires (CodeRabbit #350)", () => {
    expect(
      runRule(`app.get("/f", (req, res) => { res.sendFile(req.query.name, { root: req.query.dir }); });`).length,
    ).toBe(1)
  })
  it("alias chain: const a = req.query.f; const b = a; fs.readFileSync(b)", () => {
    expect(
      runRule(FS + `app.get("/f", (req, res) => { const a = req.query.f; const b = a; fs.readFileSync(b); });`).length,
    ).toBe(1)
  })
  it("Deno: Deno.readTextFile(c.req.query('p'))", () => {
    const src = `
import { Hono } from "hono";
const app = new Hono();
app.get("/f", (c) => { return Deno.readTextFile(c.req.query("p")); });`
    expect(runRule(src).length).toBe(1)
  })
})

describe("no-path-traversal — FP-safety: does NOT fire on safe fs code", () => {
  it("a constant path never fires", () => {
    expect(runRule(FS + `app.get("/f", (req, res) => { fs.readFile("./config/app.json", cb); });`).length).toBe(0)
  })
  it("basename-sanitized input is skipped", () => {
    expect(
      runRule(FS + `app.get("/f", (req, res) => { fs.readFile(path.join(BASE, path.basename(req.query.name)), cb); });`)
        .length,
    ).toBe(0)
  })
  it("a within-root startsWith check is skipped", () => {
    const src =
      FS +
      `app.get("/f", (req, res) => {
      const p = path.resolve(BASE, req.query.name);
      if (p.startsWith(BASE)) fs.readFile(p, cb);
    });`
    expect(runRule(src).length).toBe(0)
  })
  it("a '..' rejection is skipped", () => {
    const src =
      FS +
      `app.get("/f", (req, res) => {
      const name = req.query.name;
      if (name.includes("..")) return res.status(400).end();
      fs.readFile(path.join(BASE, name), cb);
    });`
    expect(runRule(src).length).toBe(0)
  })
  it("a replace-based '..' stripper is skipped (FP-3)", () => {
    const src =
      FS +
      `app.post("/f", (req, res) => {
      const safe = req.body.name.replace(/\\.\\./g, "");
      fs.writeFile(path.join(DIR, safe), data, cb);
    });`
    expect(runRule(src).length).toBe(0)
  })
  it("a named validator is skipped: sanitizePath", () => {
    expect(
      runRule(FS + `app.get("/f", (req, res) => { fs.readFile(sanitizePath(req.query.name), cb); });`).length,
    ).toBe(0)
  })
  it("res.sendFile with a { root } option is confined → skipped", () => {
    expect(runRule(`app.get("/f", (req, res) => { res.sendFile(req.query.name, { root: BASE }); });`).length).toBe(0)
  })
  it("non-fs createReadStream (imported from another lib) does NOT fire (FP-1)", () => {
    const src = `import { createReadStream } from "fast-csv";\napp.post("/x", (req, res) => { createReadStream(req.body.config); });`
    expect(runRule(src).length).toBe(0)
  })
  it("res.sendFile outside an Express handler does NOT fire (FP-2)", () => {
    // `res` is not an Express response here (the enclosing fn has no req param).
    const src = `app.get("/f", () => { const res = makeThing(); res.sendFile(req.query.p); });`
    expect(runRule(src).length).toBe(0)
  })
  it("a generic bare callee not imported from fs does not fire: readFile(req.query.f)", () => {
    expect(runRule(`app.get("/f", (req, res) => { readFile(req.query.f); });`).length).toBe(0)
  })
  it("a non-fs sink never fires: res.json(req.query.file)", () => {
    expect(runRule(FS + `app.get("/f", (req, res) => { res.json(req.query.file); });`).length).toBe(0)
  })
  it("skips test / spec / config / migration / script files", () => {
    const src = FS + `app.get("/f", (req, res) => { fs.readFile(req.query.file, cb); });`
    expect(runRule(src, "tests/files.test.ts").length).toBe(0)
    expect(runRule(src, "src/files.spec.ts").length).toBe(0)
    expect(runRule(src, "src/app.config.ts").length).toBe(0)
    expect(runRule(src, "src/migrations/001.ts").length).toBe(0)
    expect(runRule(src, "scripts/seed.ts").length).toBe(0)
  })
})
