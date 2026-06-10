import { describe, expect, it } from "vitest"
import { extractFileGraph } from "@/src/lib/graph-extract"

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

describe("extractFileGraph — anonymous default exports (Fix #2)", () => {
  it("anonymous export default function produces a symbol with name 'default'", () => {
    const src = "export default function () { return 1 }"
    const { symbols } = extractFileGraph("src/anon-fn.ts", src)
    const def = symbols.find((s) => s.name === "default")
    expect(def).toBeDefined()
    expect(def).toMatchObject({ kind: "function", exported: true, name: "default" })
  })

  it("anonymous export default class produces a symbol with name 'default'", () => {
    const src = "export default class {}"
    const { symbols } = extractFileGraph("src/anon-cls.ts", src)
    const def = symbols.find((s) => s.name === "default")
    expect(def).toBeDefined()
    expect(def).toMatchObject({ kind: "class", exported: true, name: "default" })
  })

  it("named export default function still uses the function name, not 'default'", () => {
    const src = "export default function foo() {}"
    const { symbols } = extractFileGraph("src/named-default.ts", src)
    const foo = symbols.find((s) => s.name === "foo")
    expect(foo).toBeDefined()
    expect(foo).toMatchObject({ kind: "function", exported: true })
    // Must NOT also emit a 'default' symbol
    expect(symbols.find((s) => s.name === "default")).toBeUndefined()
  })
})

describe("extractFileGraph — call edges", () => {
  it("links same-file and imported-binding calls; drops ambiguous obj.method()", () => {
    const src = [
      "import { fetchUser } from './api'",
      "function helper() { return 1 }",
      "export function run() {",
      "  helper()",
      "  fetchUser()",
      "  obj.method()",
      "}",
    ].join("\n")

    const { callEdges } = extractFileGraph("src/run.ts", src)
    const callees = callEdges.map((c) => ({ name: c.calleeName, kind: c.callKind }))

    expect(callees).toContainEqual({ name: "helper", kind: "same_file" })
    expect(callees).toContainEqual({ name: "fetchUser", kind: "imported_binding" })
    expect(callees.find((c) => c.name === "method")).toBeUndefined()
  })

  it("local function name takes same_file over an unrelated import (separate names, precedence path)", () => {
    // In valid ES modules a name cannot be both a local function and an
    // imported binding in the same scope (duplicate binding = parse error).
    // The `localFns.has` check comes first in the implementation so a name
    // present in localFns is always classified same_file — confirmed by the
    // primary test above. This test verifies the two kinds can coexist in
    // one file without interfering with each other.
    const src = [
      "import { fetchUser } from './api'",
      "function localFn() { return 1 }",
      "export function run() {",
      "  localFn()",
      "  fetchUser()",
      "}",
    ].join("\n")

    const { callEdges } = extractFileGraph("src/shadow.ts", src)

    const localCall = callEdges.find((c) => c.calleeName === "localFn")
    const importCall = callEdges.find((c) => c.calleeName === "fetchUser")

    expect(localCall?.callKind).toBe("same_file")
    expect(importCall?.callKind).toBe("imported_binding")
  })

  it("unknown free identifiers are not tracked", () => {
    const src = [
      "export function go() { console.log('hi'); unknownFn() }",
    ].join("\n")

    const { callEdges } = extractFileGraph("src/free.ts", src)
    // `unknownFn` is neither a local function nor an imported binding
    expect(callEdges.find((c) => c.calleeName === "unknownFn")).toBeUndefined()
  })

  it("call edge carries correct metadata fields", () => {
    const src = [
      "import { fetchUser } from './api'",
      "export function run() { fetchUser() }",
    ].join("\n")

    const { callEdges } = extractFileGraph("src/meta.ts", src)
    const edge = callEdges.find((c) => c.calleeName === "fetchUser")

    expect(edge).toBeDefined()
    expect(edge).toMatchObject({
      sourcePath: "src/meta.ts",
      callerSymbolId: null,
      calleeSymbolId: null,
      calleeName: "fetchUser",
      callKind: "imported_binding",
    })
    expect(typeof edge!.startLine).toBe("number")
    expect(typeof edge!.startCol).toBe("number")
  })

  it("namespace import call is NOT classified as imported_binding (Fix #3)", () => {
    // `import * as ns from './m'; ns()` — ns is a namespace object, not a
    // named/default binding. Classifying ns() as imported_binding is a false
    // edge; prefer missing over false per the codebase's stated policy.
    const src = [
      "import * as ns from './m'",
      "export function run() { ns() }",
    ].join("\n")

    const { callEdges } = extractFileGraph("src/ns-call.ts", src)
    expect(callEdges.find((c) => c.calleeName === "ns")).toBeUndefined()
  })

  it("named/default imports still produce imported_binding edges after Fix #3", () => {
    // Regression guard: the namespace-import filter must not affect named or
    // default imports, which should still be captured as imported_binding.
    const src = [
      "import { f } from './m'",
      "import Default from './d'",
      "export function run() { f(); Default() }",
    ].join("\n")

    const { callEdges } = extractFileGraph("src/named-call.ts", src)
    const fEdge = callEdges.find((c) => c.calleeName === "f")
    const dEdge = callEdges.find((c) => c.calleeName === "Default")
    expect(fEdge?.callKind).toBe("imported_binding")
    expect(dEdge?.callKind).toBe("imported_binding")
  })
})
