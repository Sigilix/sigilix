// SIG-314: no-unauthorized-object-lookup — a deterministic IDOR/BOLA floor.
// Positive cases = the pr/08 backend fixtures the security specialist caught
// only NONDETERMINISTICALLY (B2/B3/B9/B10). Negative cases = the safe sibling
// handlers + an adversarial false-positive set (FP-safety is the whole point:
// this rule must NEVER fire on authz-aware / principal-scoped code).

import { describe, it, expect } from "vitest"
import { parseSource } from "../src/lib/ast-rules/parser"
import { noUnauthorizedObjectLookup } from "../src/lib/ast-rules/rules/no-unauthorized-object-lookup"
import { ALL_RULES } from "../src/lib/ast-rules/rule-registry"
import type { AstRuleHit, AstRuleVisitResult } from "../src/lib/ast-rules/types"

function runRule(source: string, path = "src/routes/x.ts"): AstRuleHit[] {
  const r = parseSource(source, ".ts")
  if (!r.ok) throw new Error(`parse failed: ${r.reason}`)
  const out: AstRuleHit[] = []
  const hit: AstRuleVisitResult = noUnauthorizedObjectLookup.visit(r.ast, { path, source, ast: r.ast })
  if (hit) Array.isArray(hit) ? out.push(...hit) : out.push(hit)
  return out
}

// ── POSITIVES: the pr/08 backend IDORs (must FIRE) ──────────────────────────
describe("no-unauthorized-object-lookup — fires on the real pr/08 IDOR fixtures", () => {
  it("B2 — GET /keys/:id reads a key by req.params.id with no ownership check", () => {
    const src = `
import { Router } from "express";
import { query } from "../db";
export const keys = Router();
keys.get("/keys/:id", async (req, res) => {
  const { rows } = await query(
    "SELECT id, workspace_id, value FROM api_keys WHERE id = $1",
    [req.params.id]
  );
  res.json(rows[0]);
});`
    expect(runRule(src).length).toBe(1)
  })

  it("B10/B4 — GET /keys returns keys for req.query.workspace with no membership check", () => {
    const src = `
import { Router } from "express";
import { query } from "../db";
export const keys = Router();
keys.get("/keys", async (req, res) => {
  const { rows } = await query(
    \`SELECT id, value FROM api_keys WHERE workspace = '\${req.query.workspace}'\`
  );
  res.json(rows);
});`
    expect(runRule(src).length).toBe(1)
  })

  it("B9 — POST /keys creates in req.body.workspace (taint flows through a local) with no check", () => {
    const src = `
import { Router } from "express";
import { query } from "../db";
import { newApiKey } from "../keygen";
export const keys = Router();
keys.post("/keys", async (req, res) => {
  const wsId = String(req.body?.workspace ?? "");
  const value = newApiKey();
  const { rows } = await query(
    "INSERT INTO api_keys (workspace_id, value) VALUES ($1, $2) RETURNING id",
    [wsId, value]
  );
  res.status(201).json(rows[0]);
});`
    expect(runRule(src).length).toBe(1)
  })

  it("B3 — GET /workspaces/:id/members returns members for req.params.id (BOLA)", () => {
    const src = `
import { Router } from "express";
import { query } from "../db";
export const workspaces = Router();
workspaces.get("/workspaces/:id/members", async (req, res) => {
  const { rows } = await query(
    "SELECT member_id FROM workspace_members WHERE workspace_id = $1",
    [req.params.id]
  );
  res.json(rows);
});`
    expect(runRule(src).length).toBe(1)
  })

  it("fires once per unsafe handler — three hits across the full keys.ts fixture", () => {
    // GET /keys + GET /keys/:id + POST /keys fire; /keys/recent (principal) and
    // /keys/:id/revoke (custom verb, not a known data-access call) do not.
    const src = `
import { Router } from "express";
import { query } from "../db";
import { newApiKey } from "../keygen";
export const keys = Router();
async function revokeKey(id) { await query("UPDATE api_keys SET revoked_at = now() WHERE id = $1", [id]); }
keys.get("/keys", async (req, res) => {
  const { rows } = await query(\`SELECT * FROM api_keys WHERE workspace = '\${req.query.workspace}'\`);
  res.json(rows);
});
keys.get("/keys/:id", async (req, res) => {
  const { rows } = await query("SELECT * FROM api_keys WHERE id = $1", [req.params.id]);
  res.json(rows[0]);
});
keys.get("/keys/recent", async (req, res) => {
  const subject = (req).subject;
  const since = String(req.query.since ?? "1970-01-01");
  const { rows } = await query("SELECT * FROM api_keys WHERE workspace_id = $1 AND created_at >= $2", [subject, since]);
  res.json(rows);
});
keys.post("/keys", async (req, res) => {
  const wsId = String(req.body?.workspace ?? "");
  const { rows } = await query("INSERT INTO api_keys (workspace_id) VALUES ($1) RETURNING id", [wsId]);
  res.status(201).json(rows[0]);
});
keys.post("/keys/:id/revoke", (req, res) => {
  revokeKey(req.params.id);
  res.status(202).json({ ok: true });
});`
    expect(runRule(src, "src/routes/keys.ts").length).toBe(3)
  })
})

// ── NEGATIVES: safe siblings + adversarial FPs (must SKIP) ───────────────────
describe("no-unauthorized-object-lookup — FP-safe (skips authz-aware code)", () => {
  it("skips a principal-scoped handler (GET /workspaces — req.subject)", () => {
    const src = `
import { Router } from "express";
import { query } from "../db";
export const workspaces = Router();
workspaces.get("/workspaces", async (req, res) => {
  const subject = (req).subject;
  const { rows } = await query("SELECT id FROM workspaces w JOIN members m ON m.ws = w.id WHERE m.member_id = $1", [subject]);
  res.json(rows);
});`
    expect(runRule(src).length).toBe(0)
  })

  it("skips an id-from-principal ownership scope (req.user.id in the query)", () => {
    const src = `
const router = require("express").Router();
router.get("/orders/:id", async (req, res) => {
  const o = await query("SELECT * FROM orders WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
  res.json(o);
});`
    expect(runRule(src).length).toBe(0)
  })

  it("skips an explicit membership guard (isMember + 403 before the lookup)", () => {
    const src = `
const router = require("express").Router();
router.get("/workspaces/:id/secrets", async (req, res) => {
  if (!(await isMember(req.subject, req.params.id))) return res.status(403).end();
  const s = await query("SELECT * FROM secrets WHERE workspace_id = $1", [req.params.id]);
  res.json(s);
});`
    expect(runRule(src).length).toBe(0)
  })

  it("skips a pagination/search param (req.query.limit is not an object handle)", () => {
    const src = `
const router = require("express").Router();
router.get("/keys", async (req, res) => {
  const rows = await query("SELECT * FROM api_keys LIMIT $1", [req.query.limit]);
  res.json(rows);
});`
    expect(runRule(src).length).toBe(0)
  })

  it("skips an in-memory array .find (not a record lookup) on req.params.id", () => {
    const src = `
const router = require("express").Router();
const items = [];
router.get("/items/:id", (req, res) => {
  const x = items.find((i) => i.id === req.params.id);
  res.json(x);
});`
    expect(runRule(src).length).toBe(0)
  })

  it("does not scan non-handler helper functions", () => {
    const src = `
import { query } from "../db";
export async function loadById(id) {
  return query("SELECT * FROM t WHERE id = $1", [id]);
}`
    expect(runRule(src).length).toBe(0)
  })
})

// ── shape + registration ────────────────────────────────────────────────────
describe("no-unauthorized-object-lookup — registration + emit shape", () => {
  it("is a warning/security emitWhenUnmatched rule (P2-capped, run-invariant floor)", () => {
    expect(noUnauthorizedObjectLookup.severity).toBe("warning")
    expect(noUnauthorizedObjectLookup.roleHint).toBe("security")
    expect(noUnauthorizedObjectLookup.emitWhenUnmatched).toBe(true)
  })
  it("is registered in ALL_RULES", () => {
    expect(ALL_RULES.some((r) => r.id === "no-unauthorized-object-lookup")).toBe(true)
  })
  it("the emitted finding cites IDOR / CWE-639", () => {
    const src = `
const router = require("express").Router();
router.get("/keys/:id", async (req, res) => {
  const r = await query("SELECT * FROM api_keys WHERE id = $1", [req.params.id]);
  res.json(r);
});`
    const hits = runRule(src)
    expect(hits.length).toBe(1)
    expect(hits[0].message).toMatch(/IDOR|CWE-639|object-level authorization/i)
  })
})
