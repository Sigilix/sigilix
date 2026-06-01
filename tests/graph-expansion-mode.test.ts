// SIG-286 — graph-expansion mode parser + A/B arm assignment.

import { describe, expect, it } from "vitest"
import { graphExpansionMode, injectArm } from "../src/lib/graph-expansion-mode"
import type { Env } from "../src/index"

const env = (v: string | undefined): Env => ({ OPENCLAW_GRAPH_EXPANSION: v }) as unknown as Env

describe("graphExpansionMode", () => {
  it("parses post / shadow / unknown / unset", () => {
    expect(graphExpansionMode(env("post"))).toBe("post")
    expect(graphExpansionMode(env(" POST "))).toBe("post")
    expect(graphExpansionMode(env("shadow"))).toBe("shadow")
    expect(graphExpansionMode(env("nonsense"))).toBe("off")
    expect(graphExpansionMode(env(undefined))).toBe("off")
  })
})

describe("injectArm — SIG-286 PR2 A/B", () => {
  it("is deterministic + stable: the same SHA always returns the same arm", () => {
    const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9001122334"
    expect(injectArm(sha)).toBe(injectArm(sha))
  })

  it("only ever returns 'treatment' or 'control'", () => {
    for (const sha of ["deadbeef", "0000000000", "ffffffffff", "sigilix-head-1"]) {
      expect(["treatment", "control"]).toContain(injectArm(sha))
    }
  })

  it("splits a population of SHAs roughly 50/50 (each arm > 30% over 1000)", () => {
    let treatment = 0
    for (let i = 0; i < 1000; i++) {
      // Vary the SHA deterministically without Math.random (banned in this env).
      const sha = `${i.toString(16).padStart(8, "0")}${(i * 2654435761).toString(16)}`
      if (injectArm(sha) === "treatment") treatment += 1
    }
    expect(treatment).toBeGreaterThan(300)
    expect(treatment).toBeLessThan(700)
  })
})
