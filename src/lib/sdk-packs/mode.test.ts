// SIG-298 follow-on — resolveSdkPacksMode: off/shadow/on parsing contract,
// mirroring resolveLearningsMode's shape (off-by-default fallthrough).

import { describe, expect, it } from "vitest"

import { resolveSdkPacksMode } from "./mode"

describe("resolveSdkPacksMode", () => {
  it("defaults to off when unset", () => {
    expect(resolveSdkPacksMode(undefined)).toBe("off")
  })

  it("defaults to off for any unrecognized value", () => {
    expect(resolveSdkPacksMode("enforce")).toBe("off")
    expect(resolveSdkPacksMode("")).toBe("off")
    expect(resolveSdkPacksMode("true")).toBe("off")
  })

  it("parses shadow", () => {
    expect(resolveSdkPacksMode("shadow")).toBe("shadow")
  })

  it("parses on", () => {
    expect(resolveSdkPacksMode("on")).toBe("on")
  })

  it("trims whitespace and is case-insensitive", () => {
    expect(resolveSdkPacksMode("  ON  ")).toBe("on")
    expect(resolveSdkPacksMode("Shadow")).toBe("shadow")
  })
})
