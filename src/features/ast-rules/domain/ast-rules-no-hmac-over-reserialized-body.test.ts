// no-hmac-over-reserialized-body — deterministic recall floor (CWE-345/347).
// Positive = an HMAC `.update()` fed `JSON.stringify(req.body)` (the b20 case the
// security specialist never emits, 0/12 even prompted). Negatives = the FP-safety
// set (raw-buffer HMAC, stringify-not-into-HMAC, stringify of a non-body value,
// test files).

import { describe, it, expect } from "vitest"
import { parseSource } from "@/src/features/ast-rules/domain/parser"
import { walkAst, type AstNode } from "@/src/features/ast-rules/domain/walker"
import { noHmacOverReserializedBody } from "@/src/features/ast-rules/domain/rules/no-hmac-over-reserialized-body"
import { ALL_RULES } from "@/src/features/ast-rules/domain/rule-registry"
import type { AstRuleHit, AstRuleVisitResult } from "@/src/features/ast-rules/domain/types"

function runRule(source: string, path = "server/payments.ts"): AstRuleHit[] {
  const r = parseSource(source, ".ts")
  if (!r.ok) throw new Error(`parse failed: ${r.reason}`)
  const out: AstRuleHit[] = []
  const visitors: Record<string, (n: AstNode) => void> = {}
  for (const t of noHmacOverReserializedBody.nodeTypes) {
    visitors[t] = (n: AstNode) => {
      const hit: AstRuleVisitResult = noHmacOverReserializedBody.visit(n, { path, source, ast: r.ast })
      if (hit) Array.isArray(hit) ? out.push(...hit) : out.push(hit)
    }
  }
  walkAst(r.ast, visitors)
  return out
}

describe("no-hmac-over-reserialized-body — FIRES on HMAC over re-serialized body", () => {
  it("the b20 case: const raw = JSON.stringify(req.body); createHmac(...).update(raw)", () => {
    const src = `
      const raw = JSON.stringify(req.body);
      const expected = createHmac("sha256", SECRET).update(raw).digest("hex");
    `
    expect(runRule(src).length).toBe(1)
  })

  it("inline: createHmac(...).update(JSON.stringify(req.body))", () => {
    expect(runRule(`const e = createHmac("sha256", S).update(JSON.stringify(req.body)).digest("hex");`).length).toBe(1)
  })

  it("crypto.createHmac member form + request.body", () => {
    const src = `const sig = crypto.createHmac("sha256", S).update(JSON.stringify(request.body)).digest("base64");`
    expect(runRule(src).length).toBe(1)
  })

  it("does not double-count one update call", () => {
    const src = `
      const raw = JSON.stringify(req.body);
      const a = createHmac("sha256", S).update(raw).digest("hex");
    `
    expect(runRule(src).length).toBe(1)
  })
})

describe("no-hmac-over-reserialized-body — FP-safe (does NOT fire)", () => {
  it("HMAC over the RAW request buffer (the correct pattern)", () => {
    const src = `const expected = createHmac("sha256", SECRET).update(req.rawBody).digest("hex");`
    expect(runRule(src).length).toBe(0)
  })

  it("JSON.stringify(req.body) NOT fed into an HMAC (e.g. logging)", () => {
    expect(runRule(`logger.info(JSON.stringify(req.body));`).length).toBe(0)
  })

  it("HMAC over JSON.stringify of a NON-body value (cache key / ETag)", () => {
    const src = `const key = createHmac("sha256", S).update(JSON.stringify(queryParams)).digest("hex");`
    expect(runRule(src).length).toBe(0)
  })

  it("a plain .update(raw) on a non-HMAC receiver (stream write)", () => {
    const src = `const raw = JSON.stringify(req.body); fileStream.update(raw);`
    expect(runRule(src).length).toBe(0)
  })

  it("test / fixture files are skipped", () => {
    const src = `const raw = JSON.stringify(req.body); createHmac("sha256", S).update(raw).digest("hex");`
    expect(runRule(src, "server/payments.test.ts").length).toBe(0)
    expect(runRule(src, "fixtures/webhook.ts").length).toBe(0)
  })
})

describe("no-hmac-over-reserialized-body — registration", () => {
  it("is registered in ALL_RULES, security/warning, emitWhenUnmatched", () => {
    const r = ALL_RULES.find((x) => x.id === "no-hmac-over-reserialized-body")
    expect(r).toBeDefined()
    expect(r?.severity).toBe("warning")
    expect(r?.roleHint).toBe("security")
    expect(r?.emitWhenUnmatched).toBe(true)
  })
})
