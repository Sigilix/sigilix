// SIG-392 (b8): no-double-cast-through-unknown — flags a value laundered
// through `as unknown as T` / `as any as T` into a named typed shape (the
// b8 benchmark case: `rows as unknown as Payment[]`).

import { describe, it, expect } from "vitest"
import { parseSource } from "@/src/features/ast-rules/domain/parser"
import { walkAst } from "@/src/features/ast-rules/domain/walker"
import { noDoubleCastThroughUnknown } from "@/src/features/ast-rules/domain/rules/no-double-cast-through-unknown"
import type { AstRuleHit, AstRuleVisitResult } from "@/src/features/ast-rules/domain/types"

function append(out: AstRuleHit[], hit: AstRuleVisitResult): void {
  if (!hit) return
  Array.isArray(hit) ? out.push(...hit) : out.push(hit)
}
function runRule(source: string): AstRuleHit[] {
  const r = parseSource(source, ".ts")
  if (!r.ok) throw new Error(`parse failed: ${r.reason}`)
  const hits: AstRuleHit[] = []
  walkAst(r.ast, {
    TSAsExpression(node) {
      append(hits, noDoubleCastThroughUnknown.visit(node, { path: "t.ts", source, ast: r.ast }))
    },
  })
  return hits
}

describe("no-double-cast-through-unknown — positive (launder into a named type)", () => {
  it("flags the b8 case: rows as unknown as Payment[] (array of a type ref)", () => {
    const hits = runRule(`const body = rows as unknown as Payment[];`)
    expect(hits.length).toBe(1)
    expect(hits[0]!.message).toContain("as unknown as Payment[]")
  })
  it("flags as any as T (any laundering, named type)", () => {
    const hits = runRule(`const x = a as any as Foo;`)
    expect(hits.length).toBe(1)
    expect(hits[0]!.message).toContain("as any as Foo")
  })
  it("fires exactly once per double cast (only the outer node)", () => {
    expect(runRule(`const a = x as unknown as A; const b = y as unknown as B;`).length).toBe(2)
  })
  it("sets endLine on a multi-line double cast", () => {
    const hits = runRule("const body =\n  rows as\n  unknown as\n  Payment[];")
    expect(hits.length).toBe(1)
    expect(hits[0]!.endLine).toBeGreaterThan(hits[0]!.line)
  })
})

describe("no-double-cast-through-unknown — negative (no flag)", () => {
  it("does NOT flag a single assertion (x as T)", () => {
    expect(runRule(`const x = rows as Payment[];`).length).toBe(0)
  })
  it("does NOT flag a launder back to a primitive (x as unknown as string)", () => {
    expect(runRule(`const x = a as unknown as string;`).length).toBe(0)
  })
  it("does NOT flag a launder back to unknown/any only (x as unknown as any)", () => {
    expect(runRule(`const x = a as unknown as any;`).length).toBe(0)
  })
  it("does NOT flag a plain double-of-the-same-type without unknown/any (x as A as B)", () => {
    expect(runRule(`const x = a as A as B;`).length).toBe(0)
  })
  it("does NOT flag when there is no cast at all", () => {
    expect(runRule(`const x = rows; res.json(x);`).length).toBe(0)
  })
})

describe("no-double-cast-through-unknown — rule contract", () => {
  it("is logic/warning and emits when unmatched (FP-safe deterministic surface)", () => {
    expect(noDoubleCastThroughUnknown.roleHint).toBe("logic")
    expect(noDoubleCastThroughUnknown.severity).toBe("warning")
    expect(noDoubleCastThroughUnknown.emitWhenUnmatched).toBe(true)
  })
})
