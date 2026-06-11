// SIG-318 (PR 0b): golden-output harness serde round-trip tests.
//
// Proves `decode(encode(x))` reconstructs the non-JSON-native shapes the two
// captured ensemble seams carry — Map (incl. nested `Map<number, string>` like
// `addedLineTextByLine` and `Map<string, …>` like `reviewable`), Set
// (`coverageGaps` / `droppedPaths`), mixed nesting, and the function-drop →
// recording-no-op-stub behavior (the `on*Dropped` telemetry callbacks).
//
// The round-trip goes through JSON (encode → stringify → parse → decode) — the
// real pipeline path (the capture hook logs `JSON.stringify(encode(payload))`
// and a fixture is the parsed JSON) — so this also proves the encoded form is
// JSON-stable.

import { describe, it, expect } from "vitest"
import { encode, decode, type RecordingStub } from "@/src/lib/ensemble-golden-capture"

/** The production path: encode → JSON text → parse → decode. */
function roundTrip(value: unknown): unknown {
  return decode(JSON.parse(JSON.stringify(encode(value))))
}

describe("ensemble-golden serde round-trip", () => {
  it("preserves a flat Map<string, …> (reviewable-like)", () => {
    const input = new Map<string, { line: number; side: string }[]>([
      ["src/a.ts", [{ line: 10, side: "RIGHT" }]],
      [
        "src/b.ts",
        [
          { line: 1, side: "RIGHT" },
          { line: 2, side: "LEFT" },
        ],
      ],
    ])
    const out = roundTrip(input)
    expect(out).toBeInstanceOf(Map)
    expect(out).toEqual(input)
    // Spot-check the reconstructed Map is genuinely keyed (not a plain object).
    expect((out as Map<string, unknown>).get("src/a.ts")).toEqual([{ line: 10, side: "RIGHT" }])
  })

  it("preserves a nested Map<string, Map<number, string>> (addedLineTextByLine)", () => {
    const input = new Map<string, Map<number, string>>([
      [
        "src/a.ts",
        new Map<number, string>([
          [10, "const x = 1"],
          [11, "return x"],
        ]),
      ],
      ["src/b.ts", new Map<number, string>([[1, "import y"]])],
    ])
    const out = roundTrip(input)
    expect(out).toBeInstanceOf(Map)
    const inner = (out as Map<string, unknown>).get("src/a.ts")
    expect(inner).toBeInstanceOf(Map)
    // Numeric keys must survive as numbers (JSON object keys would coerce to
    // strings — the Map encoding keeps them numeric).
    expect((inner as Map<number, string>).get(10)).toBe("const x = 1")
    expect([...(inner as Map<number, string>).keys()]).toEqual([10, 11])
    expect(out).toEqual(input)
  })

  it("preserves a Set (coverageGaps-like)", () => {
    const input = new Set<string>(["src/a.ts:10", "src/b.ts:3"])
    const out = roundTrip(input)
    expect(out).toBeInstanceOf(Set)
    expect(out).toEqual(input)
    expect((out as Set<string>).has("src/a.ts:10")).toBe(true)
  })

  it("preserves mixed nesting (object → array → Map/Set → object)", () => {
    const input = {
      securityManifest: new Map<string, { cweId: number; tags: Set<string> }>([
        ["ev-1", { cweId: 89, tags: new Set(["sqli", "high"]) }],
      ]),
      coverageGaps: new Set<string>(["src/x.ts:5"]),
      findings: [{ path: "src/x.ts", line: 5, byLine: new Map<number, string>([[5, "raw sql"]]) }],
      mode: "shadow",
      count: 3,
      flag: false,
    }
    const out = roundTrip(input) as typeof input
    expect(out).toEqual(input)
    expect(out.securityManifest).toBeInstanceOf(Map)
    expect(out.securityManifest.get("ev-1")?.tags).toBeInstanceOf(Set)
    expect(out.coverageGaps).toBeInstanceOf(Set)
    expect(out.findings[0]?.byLine).toBeInstanceOf(Map)
    expect(out.findings[0]?.byLine.get(5)).toBe("raw sql")
  })

  it("drops a function on encode and reconstitutes it as a callable recording no-op stub", () => {
    let realCalled = false
    const input = {
      mode: "enforce",
      onDropped: (_finding: unknown, _info: unknown) => {
        realCalled = true
        return "should never reach the fixture"
      },
    }
    const out = roundTrip(input) as { mode: string; onDropped: RecordingStub }
    // The non-function siblings survive.
    expect(out.mode).toBe("enforce")
    // The function became a stub (a function value), not the original.
    expect(typeof out.onDropped).toBe("function")
    expect(out.onDropped).not.toBe(input.onDropped)
    // The stub is a no-op: callable, returns undefined, never runs the original
    // body, and records its calls for diagnosis.
    const ret = out.onDropped({ path: "src/a.ts" }, { reason: "x", dropped: true })
    out.onDropped("second")
    expect(ret).toBeUndefined()
    expect(realCalled).toBe(false)
    expect(out.onDropped.calls).toEqual([[{ path: "src/a.ts" }, { reason: "x", dropped: true }], ["second"]])
  })

  it("preserves an explicit `undefined` object property through the JSON round-trip", () => {
    // JSON.stringify silently drops `undefined` properties; the encoder tags
    // them so an optional-present-as-undefined field round-trips identically.
    const input = { a: 1, b: undefined as unknown }
    const out = roundTrip(input) as Record<string, unknown>
    expect("b" in out).toBe(true)
    expect(out.b).toBeUndefined()
    expect(out).toEqual(input)
  })

  it("preserves an `undefined` hole inside an array", () => {
    const input = ["a", undefined as unknown, "c"]
    const out = roundTrip(input)
    expect(out).toEqual(["a", undefined, "c"])
    expect((out as unknown[]).length).toBe(3)
  })

  it("passes through plain primitives and null unchanged", () => {
    expect(roundTrip("hi")).toBe("hi")
    expect(roundTrip(42)).toBe(42)
    expect(roundTrip(true)).toBe(true)
    expect(roundTrip(null)).toBe(null)
    expect(roundTrip([])).toEqual([])
    expect(roundTrip({})).toEqual({})
  })

  it("preserves an empty Map and an empty Set as their reconstructed types", () => {
    const map = roundTrip(new Map())
    const set = roundTrip(new Set())
    expect(map).toBeInstanceOf(Map)
    expect((map as Map<unknown, unknown>).size).toBe(0)
    expect(set).toBeInstanceOf(Set)
    expect((set as Set<unknown>).size).toBe(0)
  })
})
