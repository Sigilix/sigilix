// SIG-477 PR-0: no-redos rule — FP-discipline is the point. The rule must flag
// the classic nested-unbounded-quantifier catastrophic shape and NOTHING else,
// and it must NEVER auto-emit (emitWhenUnmatched is false) — it only grounds a
// model-raised ReDoS finding.

import { describe, it, expect } from "vitest"
import { parseSource } from "@/src/features/ast-rules/domain/parser"
import { walkAst } from "@/src/features/ast-rules/domain/walker"
import { noRedos } from "@/src/features/ast-rules/domain/rules/no-redos"
import type { AstRuleHit, AstRuleVisitResult } from "@/src/features/ast-rules/domain/types"

function appendHits(out: AstRuleHit[], hit: AstRuleVisitResult): void {
  if (!hit) return
  if (Array.isArray(hit)) out.push(...hit)
  else out.push(hit)
}

function runRule(source: string, ext: ".js" | ".ts" = ".js"): AstRuleHit[] {
  const r = parseSource(source, ext)
  if (!r.ok) throw new Error(`parse failed: ${r.reason}`)
  const hits: AstRuleHit[] = []
  walkAst(r.ast, {
    Literal(node) {
      const hit = noRedos.visit(node, { path: "test.js", source, ast: r.ast })
      appendHits(hits, hit)
    },
  })
  return hits
}

describe("no-redos — FLAGS (nested unbounded quantifier)", () => {
  it("flags /^(a+)+$/ (classic catastrophic shape)", () => {
    expect(runRule(`const re = /^(a+)+$/`).length).toBe(1)
  })
  it("flags /(a*)*/ (star within star)", () => {
    expect(runRule(`const re = /(a*)*/`).length).toBe(1)
  })
  it("flags /^(\\w+\\s?)+$/ (inner \\w+ within an outer +)", () => {
    expect(runRule(String.raw`const re = /^(\w+\s?)+$/`).length).toBe(1)
  })
  it("flags /(.*)*/ (dot-star within star)", () => {
    expect(runRule(`const re = /(.*)*/`).length).toBe(1)
  })
  it("flags /(a+)*/ (plus within star)", () => {
    expect(runRule(`const re = /(a+)*/`).length).toBe(1)
  })
})

describe("no-redos — DOES NOT FLAG (FP guards)", () => {
  it("does NOT flag /a+/ (simple quantifier, no group)", () => {
    expect(runRule(`const re = /a+/`).length).toBe(0)
  })
  it("does NOT flag /[a-z]+/ (char class + quantifier, no nesting)", () => {
    expect(runRule(`const re = /[a-z]+/`).length).toBe(0)
  })
  it("does NOT flag /\\d{1,3}/ (bounded quantifier)", () => {
    expect(runRule(String.raw`const re = /\d{1,3}/`).length).toBe(0)
  })
  it("does NOT flag /(abc)+/ (group with NO inner quantifier)", () => {
    expect(runRule(`const re = /(abc)+/`).length).toBe(0)
  })
  it("does NOT flag /a*b*/ (sequential, not nested)", () => {
    expect(runRule(`const re = /a*b*/`).length).toBe(0)
  })
  it("does NOT flag /(a+){1,3}/ (outer quantifier is BOUNDED)", () => {
    expect(runRule(`const re = /(a+){1,3}/`).length).toBe(0)
  })
  it("does NOT flag /\\(a+\\)+/ (escaped parens — literal, no group)", () => {
    expect(runRule(String.raw`const re = /\(a+\)+/`).length).toBe(0)
  })
  it("does NOT flag /[+*]+/ (quantifier chars inside a char class are literal)", () => {
    expect(runRule(`const re = /[+*]+/`).length).toBe(0)
  })
  it("does NOT flag a non-regex Literal (string)", () => {
    expect(runRule(`const s = "(a+)+"`).length).toBe(0)
  })
  it("does NOT flag /^abc$/ (anchored simple pattern, no quantifier)", () => {
    expect(runRule(`const re = /^abc$/`).length).toBe(0)
  })
})

describe("no-redos — never auto-emits", () => {
  it("emitWhenUnmatched is false (only grounds a model finding)", () => {
    expect(noRedos.emitWhenUnmatched).toBe(false)
  })
})
