// SIG-304 (review CLI) Phase 1b — unit coverage for the pure ANSI primitives.

import { describe, it, expect } from "vitest"
import { hexToRgb, fg, bg, paint, stripAnsi, RESET, BOLD } from "./ansi"

describe("ansi: hexToRgb", () => {
  it("parses #rrggbb and bare rrggbb", () => {
    expect(hexToRgb("#B91C1C")).toEqual({ r: 185, g: 28, b: 28 })
    expect(hexToRgb("3b82f6")).toEqual({ r: 59, g: 130, b: 246 })
  })
  it("throws on malformed input", () => {
    expect(() => hexToRgb("#xyz")).toThrow()
    expect(() => hexToRgb("#12345")).toThrow()
    expect(() => hexToRgb("")).toThrow()
  })
})

describe("ansi: truecolor SGR", () => {
  it("fg/bg emit exact 24-bit sequences", () => {
    expect(fg({ r: 185, g: 28, b: 28 })).toBe("\x1b[38;2;185;28;28m")
    expect(bg({ r: 1, g: 2, b: 3 })).toBe("\x1b[48;2;1;2;3m")
  })
  it("clamps out-of-range channels", () => {
    expect(fg({ r: -5, g: 300, b: 128 })).toBe("\x1b[38;2;0;255;128m")
  })
})

describe("ansi: paint", () => {
  it("prefixes styles and always closes with RESET", () => {
    const out = paint("hi", { fg: "#B91C1C", bold: true })
    expect(out.startsWith(BOLD)).toBe(true)
    expect(out).toContain("\x1b[38;2;185;28;28m")
    expect(out.endsWith(RESET)).toBe(true)
    expect(stripAnsi(out)).toBe("hi")
  })
  it("returns text unchanged with no options", () => {
    expect(paint("plain")).toBe("plain")
  })
})

describe("ansi: stripAnsi", () => {
  it("removes all SGR sequences", () => {
    expect(stripAnsi(`${fg({ r: 1, g: 2, b: 3 })}x${RESET}`)).toBe("x")
    expect(stripAnsi("no-codes")).toBe("no-codes")
  })
})
