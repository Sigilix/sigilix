// SIG-304 (review CLI) Phase 1b — the Mermaid sequenceDiagram → ASCII renderer.

import { describe, it, expect } from "vitest"
import { renderSequenceDiagram } from "./sequence-diagram"
import { stripAnsi } from "@/src/cli/ansi/ansi"

const DIAGRAM = [
  "sequenceDiagram",
  "  Client->>RetryHandler: charge()",
  "  RetryHandler->>PaymentAPI: submit()",
  "  PaymentAPI-->>RetryHandler: 504 timeout",
  "  RetryHandler->>RetryHandler: retry",
  "  Note over PaymentAPI: DUPLICATE charge",
  "  RetryHandler-->>Client: 200 ok",
].join("\n")

describe("renderSequenceDiagram", () => {
  it("renders exactly one box per participant — no phantom boxes from dashed arrows", () => {
    const out = renderSequenceDiagram(DIAGRAM, { color: false })
    expect(out).not.toBeNull()
    const plain = stripAnsi(out as string)
    // 3 participants (Client, RetryHandler, PaymentAPI) → 3 top-left box corners.
    expect((plain.match(/┌/g) ?? []).length).toBe(3)
    // The dashed-arrow regression created "RetryHandler-"/"PaymentAPI-" phantoms.
    expect(plain).not.toMatch(/RetryHandler-\b/)
    expect(plain).not.toMatch(/PaymentAPI-\b/)
  })

  it("draws solid (─) and dashed (┄) message lines and keeps labels + the note", () => {
    const plain = stripAnsi(renderSequenceDiagram(DIAGRAM, { color: false }) as string)
    expect(plain).toContain("charge()")
    expect(plain).toContain("504 timeout")
    expect(plain).toContain("DUPLICATE charge")
    expect(plain).toContain("┄") // dashed return arrow (-->>)
  })

  it("returns null when there are no messages", () => {
    expect(renderSequenceDiagram("sequenceDiagram", { color: false })).toBeNull()
    expect(renderSequenceDiagram("not a diagram at all", { color: false })).toBeNull()
  })

  it("emits ANSI when color:true, none when color:false", () => {
    const colored = renderSequenceDiagram(DIAGRAM, { color: true }) as string
    const plain = renderSequenceDiagram(DIAGRAM, { color: false }) as string
    expect(colored.includes("\x1b[")).toBe(true)
    expect(plain.includes("\x1b[")).toBe(false)
  })
})
