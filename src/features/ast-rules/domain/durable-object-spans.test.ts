// SIG-141 — durableObjectClassSpans: AST-based detection of
// `class … extends DurableObject` line spans (not raw-text regex).

import { describe, expect, it } from "vitest"
import { durableObjectClassSpans, lineInDurableObjectClass } from "@/src/features/ast-rules/domain/durable-object-spans"

const m = (path: string, src: string) => new Map([[path, src]])

describe("durableObjectClassSpans", () => {
  it("detects a class extends DurableObject and records its line span", () => {
    const src = [
      "import { DurableObject } from 'cloudflare:workers'", // 1
      "export class FooDO extends DurableObject {", // 2
      "  foo() { return 1 }", // 3
      "}", // 4
    ].join("\n")
    const spans = durableObjectClassSpans(m("src/do/foo.ts", src))
    const fooSpans = spans.get("src/do/foo.ts")
    expect(fooSpans).toHaveLength(1)
    expect(fooSpans?.[0]).toEqual({ start: 2, end: 4 })
  })

  it("detects a namespaced base (extends ns.DurableObject)", () => {
    const src = "export class BarDO extends cf.DurableObject {\n  bar() {}\n}"
    expect(durableObjectClassSpans(m("src/do/bar.ts", src)).has("src/do/bar.ts")).toBe(true)
  })

  it("does NOT match 'extends DurableObject' in a comment or string (AST, not regex)", () => {
    const src = [
      "// class Fake extends DurableObject — this is just a comment", // 1
      "const note = 'class X extends DurableObject'", // 2
      "export class RealHelper extends BaseThing {", // 3 (not a DO)
      "  go() {}", // 4
      "}", // 5
    ].join("\n")
    expect(durableObjectClassSpans(m("src/lib/note.ts", src)).size).toBe(0)
  })

  it("skips non-JS/TS files", () => {
    expect(durableObjectClassSpans(m("README.md", "class X extends DurableObject {}")).size).toBe(0)
  })

  it("skips files that fail to parse (never throws)", () => {
    expect(durableObjectClassSpans(m("src/do/broken.ts", "class X extends {{{ DurableObject")).size).toBe(0)
  })
})

describe("lineInDurableObjectClass", () => {
  const spans = [{ start: 10, end: 50 }, { start: 80, end: 90 }]
  it("true inside a span (inclusive bounds)", () => {
    expect(lineInDurableObjectClass(spans, 10)).toBe(true)
    expect(lineInDurableObjectClass(spans, 50)).toBe(true)
    expect(lineInDurableObjectClass(spans, 85)).toBe(true)
  })
  it("false outside all spans", () => {
    expect(lineInDurableObjectClass(spans, 9)).toBe(false)
    expect(lineInDurableObjectClass(spans, 60)).toBe(false)
  })
  it("false for undefined spans", () => {
    expect(lineInDurableObjectClass(undefined, 5)).toBe(false)
  })
})
