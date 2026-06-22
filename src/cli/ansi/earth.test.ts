// SIG-304 (review CLI) Phase 1b — the procedural spinning globe.

import { describe, it, expect } from "vitest"
import { renderEarth } from "./earth"

describe("renderEarth", () => {
  it("renders ceil(d/2) char rows × d cols", () => {
    const g = renderEarth(0, 16)
    expect(g).toHaveLength(8)
    for (const row of g) expect(row).toHaveLength(16)
  })

  it("is pure / deterministic for a given frame", () => {
    expect(renderEarth(5, 16)).toEqual(renderEarth(5, 16))
  })

  it("is a disc: transparent corners, painted center", () => {
    const g = renderEarth(0, 16)
    expect(g[0]![0]!.ch).toBe(" ") // corner outside the disc
    const mid = g[Math.floor(g.length / 2)]!
    expect(mid[8]!.ch).not.toBe(" ") // center is on the globe
    expect(mid[8]!.fg).toMatch(/^#[0-9a-f]{6}$/) // truecolor fill
  })

  it("spins: a mid-globe row changes color as the frame advances", () => {
    const a = renderEarth(0, 16)[4]!
      .map((c) => c.fg)
      .join(",")
    const b = renderEarth(10, 16)[4]!
      .map((c) => c.fg)
      .join(",")
    expect(a).not.toBe(b)
  })
})
