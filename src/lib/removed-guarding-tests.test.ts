// SIG-452: adversarial-framing "removed guarding test" detector unit tests.

import { describe, it, expect } from "vitest"
import { buildChangedLines, buildDeletedLineTextByLine } from "@/src/features/ast-rules/domain/diff-filter"
import {
  MAX_REMOVED_GUARDING_TESTS,
  buildRemovedGuardingTests,
  deriveChangedExportedSymbols,
  parseAdversarialFramingMode,
  symbolGradeRemovedGuardingTests,
  type ChangedFileMeta,
} from "@/src/lib/removed-guarding-tests"
import type { TestingSiblingMapping } from "@/src/lib/testing-evidence-pack"

describe("parseAdversarialFramingMode", () => {
  it("defaults to off and is conservative", () => {
    expect(parseAdversarialFramingMode(undefined)).toBe("off")
    expect(parseAdversarialFramingMode("")).toBe("off")
    expect(parseAdversarialFramingMode("nonsense")).toBe("off")
    expect(parseAdversarialFramingMode("ON")).toBe("off")
  })
  it("parses shadow + enforce (trim + lowercase)", () => {
    expect(parseAdversarialFramingMode("shadow")).toBe("shadow")
    expect(parseAdversarialFramingMode("  ENFORCE  ")).toBe("enforce")
    expect(parseAdversarialFramingMode("Shadow")).toBe("shadow")
  })
})

// ── helpers ──────────────────────────────────────────────────────────────────

function meta(status: string, previousFilename: string | null = null): ChangedFileMeta {
  return { status, previousFilename }
}

function changedSymbols(entries: Record<string, string[]>): Map<string, Set<string>> {
  return new Map(Object.entries(entries).map(([k, v]) => [k, new Set(v)]))
}

describe("buildRemovedGuardingTests", () => {
  // The A4-shaped case: a covered symbol's behavior changed AND its guarding
  // assertion was deleted in the same modified test file.
  it("FLAGS at symbol-grade an A4-shaped timestamp-precedence flip with a removed test", () => {
    const deleted = new Map<string, ReadonlyMap<number, string>>([
      [
        "src/lib/order.test.ts",
        new Map([
          [12, "expect(resolveTimestamp(order)).toBe(order.created_at)"],
          [13, "// removed precedence assertion"],
        ]),
      ],
    ])
    const signals = buildRemovedGuardingTests({
      deletedLineTextByPath: deleted,
      siblingMappings: [{ source: "src/lib/order.ts", test: "src/lib/order.test.ts" }],
      changedExportedSymbolsBySource: changedSymbols({ "src/lib/order.ts": ["resolveTimestamp"] }),
      fileMetaByPath: new Map([
        ["src/lib/order.ts", meta("modified")],
        ["src/lib/order.test.ts", meta("modified")],
      ]),
    })
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({
      testPath: "src/lib/order.test.ts",
      coveredSource: "src/lib/order.ts",
      coveredSymbol: "resolveTimestamp",
      correlationStrength: "symbol",
    })
    expect(signals[0]!.removedAssertionHint).toContain("resolveTimestamp")
    expect(symbolGradeRemovedGuardingTests(signals)).toHaveLength(1)
  })

  // The A2-shaped case: a data-integrity dedupe change + removed dedupe test.
  it("FLAGS at symbol-grade an A2-shaped dedupe contract change with a removed test", () => {
    const deleted = new Map<string, ReadonlyMap<number, string>>([
      ["tests/dedupe.test.ts", new Map([[20, "expect(dedupeAttempts(rows)).toHaveLength(2) // per-attempt"]])],
    ])
    const signals = buildRemovedGuardingTests({
      deletedLineTextByPath: deleted,
      siblingMappings: [{ source: "src/lib/dedupe.ts", test: "tests/dedupe.test.ts" }],
      changedExportedSymbolsBySource: changedSymbols({ "src/lib/dedupe.ts": ["dedupeAttempts"] }),
      fileMetaByPath: new Map([
        ["src/lib/dedupe.ts", meta("modified")],
        ["tests/dedupe.test.ts", meta("modified")],
      ]),
    })
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ coveredSymbol: "dedupeAttempts", correlationStrength: "symbol" })
  })

  it("does NOT flag when the covered source has no behavioral change (legit refactor)", () => {
    const deleted = new Map<string, ReadonlyMap<number, string>>([
      ["src/lib/order.test.ts", new Map([[12, "expect(resolveTimestamp(order)).toBe(x)"]])],
    ])
    const signals = buildRemovedGuardingTests({
      deletedLineTextByPath: deleted,
      siblingMappings: [{ source: "src/lib/order.ts", test: "src/lib/order.test.ts" }],
      // NO changed symbols for the source → no behavioral change → no signal.
      changedExportedSymbolsBySource: new Map(),
      fileMetaByPath: new Map([["src/lib/order.test.ts", meta("modified")]]),
    })
    expect(signals).toEqual([])
  })

  it("does NOT flag a RENAMED/MOVED test (status renamed) — the guard moved, not dropped", () => {
    // Deleted-line map keys a renamed file by the OLD path.
    const deleted = new Map<string, ReadonlyMap<number, string>>([
      ["src/lib/old-order.test.ts", new Map([[12, "expect(resolveTimestamp(order)).toBe(x)"]])],
    ])
    const signals = buildRemovedGuardingTests({
      deletedLineTextByPath: deleted,
      siblingMappings: [{ source: "src/lib/order.ts", test: "src/lib/order.test.ts" }],
      changedExportedSymbolsBySource: changedSymbols({ "src/lib/order.ts": ["resolveTimestamp"] }),
      // Metadata says the current test was renamed from the old path.
      fileMetaByPath: new Map([
        ["src/lib/order.ts", meta("modified")],
        ["src/lib/order.test.ts", meta("renamed", "src/lib/old-order.test.ts")],
        ["src/lib/old-order.test.ts", meta("renamed", "src/lib/old-order.test.ts")],
      ]),
    })
    expect(signals).toEqual([])
  })

  it("does NOT flag DEAD-CODE removal AT ALL (no symbol- AND no stem-grade signal)", () => {
    const deleted = new Map<string, ReadonlyMap<number, string>>([
      ["src/lib/order.test.ts", new Map([[12, "expect(resolveTimestamp(order)).toBe(x)"]])],
    ])
    const signals = buildRemovedGuardingTests({
      deletedLineTextByPath: deleted,
      siblingMappings: [{ source: "src/lib/order.ts", test: "src/lib/order.test.ts" }],
      // The symbol shows as "changed" (a delete touches its lines) BUT it is in
      // the deleted-symbols set → the assertion references ONLY dead code → the
      // WHOLE signal is suppressed (not downgraded to stem-grade).
      changedExportedSymbolsBySource: changedSymbols({ "src/lib/order.ts": ["resolveTimestamp"] }),
      deletedExportedSymbolsBySource: changedSymbols({ "src/lib/order.ts": ["resolveTimestamp"] }),
      fileMetaByPath: new Map([
        ["src/lib/order.ts", meta("modified")],
        ["src/lib/order.test.ts", meta("modified")],
      ]),
    })
    // Dead-code → NO signal of any grade (Codex review: must not pollute shadow).
    expect(signals).toEqual([])
  })

  it("still emits stem-grade when the source changed but the assertion names neither a changed nor a deleted symbol", () => {
    const deleted = new Map<string, ReadonlyMap<number, string>>([
      // The assertion references `resolveTimestamp` which was DELETED, but ALSO a
      // separate generic assertion that names no symbol — the source has OTHER
      // live changes, so a stem-grade removed-guard still stands. Here we model a
      // deleted symbol that is NOT referenced, plus a live-changed source.
      ["src/lib/order.test.ts", new Map([[12, "expect(result).toBe(2)"]])],
    ])
    const signals = buildRemovedGuardingTests({
      deletedLineTextByPath: deleted,
      siblingMappings: [{ source: "src/lib/order.ts", test: "src/lib/order.test.ts" }],
      changedExportedSymbolsBySource: changedSymbols({ "src/lib/order.ts": ["resolveTimestamp"] }),
      // `resolveTimestamp` is deleted, but the assertion does not name it → not a
      // dead-code match → stem-grade (the source still has a behavioral change).
      deletedExportedSymbolsBySource: changedSymbols({ "src/lib/order.ts": ["resolveTimestamp"] }),
      fileMetaByPath: new Map([
        ["src/lib/order.ts", meta("modified")],
        ["src/lib/order.test.ts", meta("modified")],
      ]),
    })
    expect(signals).toHaveLength(1)
    expect(signals[0]!.correlationStrength).toBe("stem")
  })

  it("emits stem-grade (not symbol) when the deleted assertion names no changed symbol", () => {
    const deleted = new Map<string, ReadonlyMap<number, string>>([
      // The assertion does NOT reference the changed symbol `computeTotal`.
      ["src/lib/billing.test.ts", new Map([[8, "expect(result).toBe(42)"]])],
    ])
    const signals = buildRemovedGuardingTests({
      deletedLineTextByPath: deleted,
      siblingMappings: [{ source: "src/lib/billing.ts", test: "src/lib/billing.test.ts" }],
      changedExportedSymbolsBySource: changedSymbols({ "src/lib/billing.ts": ["computeTotal"] }),
      fileMetaByPath: new Map([
        ["src/lib/billing.ts", meta("modified")],
        ["src/lib/billing.test.ts", meta("modified")],
      ]),
    })
    expect(signals).toHaveLength(1)
    expect(signals[0]!.correlationStrength).toBe("stem")
    expect(signals[0]!.coveredSymbol).toBeNull()
    // Stem-grade is excluded from the enforce-grade subset.
    expect(symbolGradeRemovedGuardingTests(signals)).toEqual([])
  })

  it("does NOT flag when the deleted lines are not test assertions", () => {
    const deleted = new Map<string, ReadonlyMap<number, string>>([
      [
        "src/lib/order.test.ts",
        new Map([
          [3, "import { foo } from './foo'"],
          [4, "const x = 1"],
        ]),
      ],
    ])
    const signals = buildRemovedGuardingTests({
      deletedLineTextByPath: deleted,
      siblingMappings: [{ source: "src/lib/order.ts", test: "src/lib/order.test.ts" }],
      changedExportedSymbolsBySource: changedSymbols({ "src/lib/order.ts": ["resolveTimestamp"] }),
      fileMetaByPath: new Map([["src/lib/order.test.ts", meta("modified")]]),
    })
    expect(signals).toEqual([])
  })

  it("caps the number of emitted signals at MAX_REMOVED_GUARDING_TESTS", () => {
    const deletedEntries: Array<[string, ReadonlyMap<number, string>]> = []
    const mappings: TestingSiblingMapping[] = []
    const changed: Record<string, string[]> = {}
    const fileMeta = new Map<string, ChangedFileMeta>()
    for (let i = 0; i < MAX_REMOVED_GUARDING_TESTS + 5; i++) {
      const src = `src/lib/m${i}.ts`
      const test = `src/lib/m${i}.test.ts`
      deletedEntries.push([test, new Map([[5, `expect(symbol${i}(x)).toBe(1)`]])])
      mappings.push({ source: src, test })
      changed[src] = [`symbol${i}`]
      fileMeta.set(src, meta("modified"))
      fileMeta.set(test, meta("modified"))
    }
    const signals = buildRemovedGuardingTests({
      deletedLineTextByPath: new Map(deletedEntries),
      siblingMappings: mappings,
      changedExportedSymbolsBySource: changedSymbols(changed),
      fileMetaByPath: fileMeta,
    })
    expect(signals.length).toBeLessThanOrEqual(MAX_REMOVED_GUARDING_TESTS)
  })

  it("orders symbol-grade signals before stem-grade", () => {
    const deleted = new Map<string, ReadonlyMap<number, string>>([
      ["src/lib/a.test.ts", new Map([[5, "expect(result).toBe(1)"]])], // stem
      ["src/lib/b.test.ts", new Map([[5, "expect(doThing(x)).toBe(1)"]])], // symbol
    ])
    const signals = buildRemovedGuardingTests({
      deletedLineTextByPath: deleted,
      siblingMappings: [
        { source: "src/lib/a.ts", test: "src/lib/a.test.ts" },
        { source: "src/lib/b.ts", test: "src/lib/b.test.ts" },
      ],
      changedExportedSymbolsBySource: changedSymbols({ "src/lib/a.ts": ["other"], "src/lib/b.ts": ["doThing"] }),
      fileMetaByPath: new Map([
        ["src/lib/a.ts", meta("modified")],
        ["src/lib/a.test.ts", meta("modified")],
        ["src/lib/b.ts", meta("modified")],
        ["src/lib/b.test.ts", meta("modified")],
      ]),
    })
    expect(signals.map((s) => s.correlationStrength)).toEqual(["symbol", "stem"])
  })
})

describe("deriveChangedExportedSymbols", () => {
  it("identifies an EXPORTED symbol whose body overlaps a changed line", () => {
    const head = [
      "export function resolveTimestamp(order) {",
      "  return order.updated_at ?? order.created_at", // changed line
      "}",
      "export function untouched() { return 1 }",
    ].join("\n")
    const diff = [
      "diff --git a/src/lib/order.ts b/src/lib/order.ts",
      "--- a/src/lib/order.ts",
      "+++ b/src/lib/order.ts",
      "@@ -2,1 +2,1 @@",
      "-  return order.created_at ?? order.updated_at",
      "+  return order.updated_at ?? order.created_at",
    ].join("\n")
    const { changedBySource, deletedBySource } = deriveChangedExportedSymbols({
      sourcePaths: ["src/lib/order.ts"],
      headContentByPath: new Map([["src/lib/order.ts", head]]),
      changedLines: buildChangedLines(diff),
      deletedLineTextByPath: buildDeletedLineTextByLine(diff),
    })
    expect([...(changedBySource.get("src/lib/order.ts") ?? [])]).toContain("resolveTimestamp")
    expect([...(changedBySource.get("src/lib/order.ts") ?? [])]).not.toContain("untouched")
    expect(deletedBySource.get("src/lib/order.ts")).toBeUndefined()
  })

  it("identifies a DELETED exported symbol (declaration removed, gone from head)", () => {
    const head = "export function kept() { return 1 }"
    const diff = [
      "diff --git a/src/lib/dead.ts b/src/lib/dead.ts",
      "--- a/src/lib/dead.ts",
      "+++ b/src/lib/dead.ts",
      "@@ -1,4 +1,1 @@",
      "-export function removedSymbol() {",
      "-  return 2",
      "-}",
      " export function kept() { return 1 }",
    ].join("\n")
    const { deletedBySource } = deriveChangedExportedSymbols({
      sourcePaths: ["src/lib/dead.ts"],
      headContentByPath: new Map([["src/lib/dead.ts", head]]),
      changedLines: buildChangedLines(diff),
      deletedLineTextByPath: buildDeletedLineTextByLine(diff),
    })
    expect([...(deletedBySource.get("src/lib/dead.ts") ?? [])]).toContain("removedSymbol")
  })

  it("fails closed (no changed set) for a source with no head content", () => {
    const { changedBySource } = deriveChangedExportedSymbols({
      sourcePaths: ["src/lib/missing.ts"],
      headContentByPath: new Map(),
      changedLines: new Map(),
      deletedLineTextByPath: new Map(),
    })
    expect(changedBySource.get("src/lib/missing.ts")).toBeUndefined()
  })
})

describe("end-to-end: derive → build (the A4 acceptance chain)", () => {
  // The full pipeline the wiring runs: parse the PR diff for changed symbols +
  // deleted test assertions, then correlate. This is the acceptance criterion —
  // an A4-shaped flip + same-PR removed guarding test is FLAGGED at symbol-grade.
  it("FLAGS the A4 timestamp-precedence flip with its removed guarding test", () => {
    const diff = [
      // source: the precedence flips on a changed line.
      "diff --git a/src/lib/order.ts b/src/lib/order.ts",
      "--- a/src/lib/order.ts",
      "+++ b/src/lib/order.ts",
      "@@ -2,1 +2,1 @@ export function resolveTimestamp(order) {",
      "-  return order.created_at ?? order.updated_at",
      "+  return order.updated_at ?? order.created_at",
      // test: the assertion pinning the OLD precedence is removed.
      "diff --git a/src/lib/order.test.ts b/src/lib/order.test.ts",
      "--- a/src/lib/order.test.ts",
      "+++ b/src/lib/order.test.ts",
      "@@ -10,3 +10,0 @@",
      '-  it("prefers created_at", () => {',
      "-    expect(resolveTimestamp(order)).toBe(order.created_at)",
      "-  })",
    ].join("\n")
    const head = [
      "export function resolveTimestamp(order) {",
      "  return order.updated_at ?? order.created_at",
      "}",
    ].join("\n")

    const deletedLineTextByPath = buildDeletedLineTextByLine(diff)
    const { changedBySource, deletedBySource } = deriveChangedExportedSymbols({
      sourcePaths: ["src/lib/order.ts"],
      headContentByPath: new Map([["src/lib/order.ts", head]]),
      changedLines: buildChangedLines(diff),
      deletedLineTextByPath,
    })
    const signals = buildRemovedGuardingTests({
      deletedLineTextByPath,
      siblingMappings: [{ source: "src/lib/order.ts", test: "src/lib/order.test.ts" }],
      changedExportedSymbolsBySource: changedBySource,
      deletedExportedSymbolsBySource: deletedBySource,
      fileMetaByPath: new Map([
        ["src/lib/order.ts", meta("modified")],
        ["src/lib/order.test.ts", meta("modified")],
      ]),
    })
    expect(symbolGradeRemovedGuardingTests(signals)).toHaveLength(1)
    expect(signals[0]).toMatchObject({ coveredSymbol: "resolveTimestamp", correlationStrength: "symbol" })
  })
})
