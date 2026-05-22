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

describe("extractFileGraph — file edges (raw)", () => {
  it("captures relative imports and re-exports with names and kind", () => {
    const src = [
      "import { add, sub as minus } from './math'",
      "import Default from '../util/log'",
      "export { PI } from './constants'",
      "export * from './all'",
      "import { x } from 'left-pad'",
    ].join("\n")

    const { fileEdgesRaw } = extractFileGraph("src/a.ts", src)
    const imports = fileEdgesRaw.filter((e) => e.edgeKind === "import")

    expect(imports).toContainEqual(expect.objectContaining({
      edgeKind: "import", specifier: "./math", importedName: "add", localName: "add", sourcePath: "src/a.ts",
    }))
    expect(imports).toContainEqual(expect.objectContaining({ specifier: "./math", importedName: "sub", localName: "minus" }))
    expect(fileEdgesRaw).toContainEqual(expect.objectContaining({ edgeKind: "reexport", exportedName: "PI", specifier: "./constants" }))
    expect(fileEdgesRaw).toContainEqual(expect.objectContaining({ edgeKind: "star_reexport", specifier: "./all" }))
    expect(fileEdgesRaw).toContainEqual(expect.objectContaining({ specifier: "left-pad" }))
  })

  it("covers namespace imports, side-effect imports, and named star re-exports", () => {
    const src = [
      "import * as ns from './m'",
      "import './polyfill'",
      "export * as utils from './u'",
    ].join("\n")

    const { fileEdgesRaw } = extractFileGraph("src/ns.ts", src)

    // Namespace import: `import * as ns from './m'`
    expect(fileEdgesRaw).toContainEqual(expect.objectContaining({
      edgeKind: "import",
      specifier: "./m",
      importedName: null,
      localName: "ns",
      sourcePath: "src/ns.ts",
    }))

    // Side-effect import: `import './polyfill'`
    expect(fileEdgesRaw).toContainEqual(expect.objectContaining({
      edgeKind: "import",
      specifier: "./polyfill",
      importedName: null,
      localName: null,
    }))

    // Named star re-export: `export * as utils from './u'`
    expect(fileEdgesRaw).toContainEqual(expect.objectContaining({
      edgeKind: "star_reexport",
      specifier: "./u",
      exportedName: "utils",
    }))
  })
})
