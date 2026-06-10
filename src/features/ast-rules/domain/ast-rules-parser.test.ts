// ARC-181: parser + walker — parse-only TS-surface fixture coverage.
// Smoke rule (`no-eval-call`) tests live in tests/ast-rules-no-eval-call.test.ts
// (Task 3). This file asserts ONLY: (a) parseSource returns { ok: true }
// for each TS-surface fixture, (b) walkAst traverses without throwing.

import { describe, it, expect } from "vitest"
import { parseSource } from "@/src/features/ast-rules/domain/parser"
import { walkAst } from "@/src/features/ast-rules/domain/walker"

function assertParsesAndWalks(code: string, ext: ".js" | ".jsx" | ".ts" | ".tsx" | ".mts" | ".cts" | ".mjs" | ".cjs"): void {
  const r = parseSource(code, ext)
  expect(r.ok, r.ok ? "" : `parse failed: ${(r as { reason: string }).reason}`).toBe(true)
  if (!r.ok) return
  let nodeCount = 0
  walkAst(r.ast, {
    Program() { nodeCount++ },
    Identifier() { nodeCount++ },
    Literal() { nodeCount++ },
  })
  expect(nodeCount).toBeGreaterThan(0)
}

describe("parseSource — JS surface", () => {
  it("parses .js with module syntax", () => {
    assertParsesAndWalks(`import x from "y"; export const a = 1;`, ".js")
  })

  it("parses .mjs with hashbang", () => {
    assertParsesAndWalks(`#!/usr/bin/env node\nconst x = 1;`, ".mjs")
  })

  it("parses .cjs", () => {
    assertParsesAndWalks(`const x = require("y");`, ".cjs")
  })

  it("parses .jsx with JSX", () => {
    assertParsesAndWalks(`const el = <div className="x">hi</div>;`, ".jsx")
  })
})

describe("parseSource — TS surface (Codex MAJOR #6)", () => {
  it("parses .ts type annotations", () => {
    assertParsesAndWalks(`const x: number = 1; function f(a: string): boolean { return a.length > 0; }`, ".ts")
  })

  it("parses .tsx", () => {
    assertParsesAndWalks(`const el: JSX.Element = <div>hi</div>;`, ".tsx")
  })

  it("parses decorators", () => {
    assertParsesAndWalks(`function Cached() { return (target: unknown) => target; } @Cached() class X {}`, ".ts")
  })

  it("parses import attributes (with-syntax)", () => {
    assertParsesAndWalks(`import data from "./d.json" with { type: "json" };`, ".ts")
  })

  it("parses satisfies operator", () => {
    assertParsesAndWalks(`const x = { a: 1 } satisfies { a: number };`, ".ts")
  })

  it("parses enums", () => {
    assertParsesAndWalks(`enum Color { Red, Green, Blue }`, ".ts")
  })

  it("parses namespaces", () => {
    assertParsesAndWalks(`namespace Foo { export const x = 1; }`, ".ts")
  })

  it("parses mixed JSX-in-TS", () => {
    assertParsesAndWalks(`type Props = { x: number }; const C = (p: Props): JSX.Element => <div>{p.x}</div>;`, ".tsx")
  })

  it("parses generic-arrow-with-comma-disambiguation", () => {
    assertParsesAndWalks(`const id = <T,>(x: T): T => x;`, ".tsx")
  })

  it("parses .mts", () => {
    assertParsesAndWalks(`export const x: number = 1;`, ".mts")
  })

  it("parses .cts", () => {
    assertParsesAndWalks(`const x: number = 1;`, ".cts")
  })
})

describe("parseSource — error handling", () => {
  it("returns { ok: false, reason } on syntax error", () => {
    const r = parseSource(`const x = ;`, ".js")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBeTruthy()
    }
  })

  it("never throws on garbage input", () => {
    expect(() => parseSource(`#!@#$@#`, ".js")).not.toThrow()
  })

  it("rejects non-string code", () => {

    const r = parseSource(123 as any, ".js")
    expect(r.ok).toBe(false)
  })
})
