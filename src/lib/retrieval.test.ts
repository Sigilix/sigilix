// Retrieval — tests the team-key → namespace mapping and the chunk
// formatter. The Vectorize / Workers AI bindings are stubbed; the actual
// network calls are integration-tested manually after deploy.

import { describe, expect, it } from "vitest"
import { teamKeyToNamespace } from "@/src/lib/retrieval"
import { formatChunksForPrompt } from "@/src/lib/retrieval"

describe("teamKeyToNamespace", () => {
  it("returns the default when team key is null", () => {
    expect(teamKeyToNamespace(null)).toBe("rubberfit")
  })

  it("lowercases the team key when no map is given", () => {
    expect(teamKeyToNamespace("ARC")).toBe("arc")
    expect(teamKeyToNamespace("RFD")).toBe("rfd")
  })

  it("uses the explicit map when valid JSON", () => {
    const map = JSON.stringify({ ARC: "rubberfit", RFD: "rubberfit-desktop" })
    expect(teamKeyToNamespace("ARC", map)).toBe("rubberfit")
    expect(teamKeyToNamespace("RFD", map)).toBe("rubberfit-desktop")
  })

  it("falls back to lowercase team key when team is not in map", () => {
    const map = JSON.stringify({ ARC: "rubberfit" })
    expect(teamKeyToNamespace("XYZ", map)).toBe("xyz")
  })

  it("ignores empty / whitespace mapped values", () => {
    const map = JSON.stringify({ ARC: "  " })
    expect(teamKeyToNamespace("ARC", map)).toBe("arc")
  })

  it("falls back to lowercased key on invalid JSON", () => {
    expect(teamKeyToNamespace("ARC", "not-json")).toBe("arc")
  })

  it("falls back when JSON is an array / not a plain object", () => {
    expect(teamKeyToNamespace("ARC", "[]")).toBe("arc")
    expect(teamKeyToNamespace("ARC", "null")).toBe("arc")
    expect(teamKeyToNamespace("ARC", '"a-string"')).toBe("arc")
  })
})

describe("formatChunksForPrompt", () => {
  const chunk = (path: string, body: string, score = 0.5) => ({
    path,
    lineStart: 1,
    lineEnd: 10,
    content: body,
    score,
  })

  it("returns null on empty list", () => {
    expect(formatChunksForPrompt([])).toBeNull()
  })

  it("formats path:line headers and includes content", () => {
    const out = formatChunksForPrompt([chunk("app/foo.ts", "const x = 1")])
    expect(out).toContain("--- app/foo.ts:1-10")
    expect(out).toContain("(score=0.500)")
    expect(out).toContain("const x = 1")
  })

  it("separates multiple chunks with a blank line", () => {
    const out = formatChunksForPrompt([chunk("a.ts", "AAA"), chunk("b.ts", "BBB")])
    expect(out).toContain("AAA")
    expect(out).toContain("BBB")
    expect(out!.indexOf("AAA")).toBeLessThan(out!.indexOf("BBB"))
  })

  it("respects the per-chunk char cap", () => {
    const huge = "x".repeat(10_000)
    const out = formatChunksForPrompt([chunk("big.ts", huge)])
    // Cap is 4_000; output should not contain the full 10k.
    expect(out!.length).toBeLessThan(huge.length)
  })

  it("respects the total chars cap across multiple chunks", () => {
    const big = "y".repeat(5_000)
    const out = formatChunksForPrompt([
      chunk("a.ts", big),
      chunk("b.ts", big),
      chunk("c.ts", big),
      chunk("d.ts", big),
      chunk("e.ts", big),
    ])
    // 5 × ~4_000 (per-chunk cap) = 20_000, but total cap is 18_000 so
    // at least one should be dropped.
    expect(out!.length).toBeLessThan(20_000)
  })
})
