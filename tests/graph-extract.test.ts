import { describe, expect, it } from "vitest"
import { extractFileGraph } from "../src/lib/graph-extract"

describe("extractFileGraph — symbols", () => {
  it("captures function/class/method/exported-var with kind, loc, and exported flag", () => {
    const src = [
      "export function add(a, b) { return a + b }",
      "class Calc {",
      "  multiply(a, b) { return a * b }",
      "}",
      "export const PI = 3.14",
      "function privateHelper() {}",
    ].join("\n")

    const { symbols } = extractFileGraph("src/math.ts", src)
    const byName = new Map(symbols.map((s) => [s.name, s]))

    expect(byName.get("add")).toMatchObject({ kind: "function", exported: true, startLine: 1 })
    expect(byName.get("Calc")).toMatchObject({ kind: "class", exported: false })
    expect(byName.get("multiply")).toMatchObject({ kind: "method", exported: false })
    expect(byName.get("PI")).toMatchObject({ kind: "variable", exported: true })
    expect(byName.get("privateHelper")).toMatchObject({ kind: "function", exported: false })
    expect(byName.get("add")!.symbolId).toBe("src/math.ts function add 1 0")
  })

  it("returns empty result on parse failure without throwing", () => {
    expect(extractFileGraph("broken.ts", "function (").symbols).toEqual([])
  })
})
