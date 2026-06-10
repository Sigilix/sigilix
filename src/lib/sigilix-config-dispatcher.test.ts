// SIG-224 Phase 0 — `dispatcher` config field: parse behavior.
//
// Fail-open contract: a malformed dispatcher block must NEVER break a
// review — bad values drop silently, never a parse error. Schema lands
// in Phase 0 but no call site consumes it yet; tests pin the parser
// contract so Phase 1 (SIG-225) can rely on it.

import { describe, it, expect } from "vitest"
import { parseSigilixConfig } from "@/src/lib/sigilix-config"

describe("parseSigilixConfig — dispatcher", () => {
  it("parses a fully populated dispatcher block", () => {
    const cfg = parseSigilixConfig(JSON.stringify({
      dispatcher: {
        force: ["security", "logic"],
        safetyNet: {
          additionalPatterns: [
            { glob: "src/billing/**", role: "logic" },
            { glob: "src/auth-custom/**", role: "security" },
          ],
        },
      },
    }))
    expect(cfg?.dispatcher).toEqual({
      force: ["security", "logic"],
      safetyNet: {
        additionalPatterns: [
          { glob: "src/billing/**", role: "logic" },
          { glob: "src/auth-custom/**", role: "security" },
        ],
      },
    })
  })

  it("returns undefined when dispatcher is missing", () => {
    const cfg = parseSigilixConfig(JSON.stringify({ guidance: "x" }))
    expect(cfg?.dispatcher).toBeUndefined()
  })

  it("returns undefined when dispatcher is present but empty", () => {
    const cfg = parseSigilixConfig(JSON.stringify({ dispatcher: {} }))
    expect(cfg?.dispatcher).toBeUndefined()
  })

  it("returns undefined when dispatcher is not an object", () => {
    expect(parseSigilixConfig(JSON.stringify({ dispatcher: "nope" }))?.dispatcher).toBeUndefined()
    expect(parseSigilixConfig(JSON.stringify({ dispatcher: [] }))?.dispatcher).toBeUndefined()
    expect(parseSigilixConfig(JSON.stringify({ dispatcher: null }))?.dispatcher).toBeUndefined()
  })

  describe("force", () => {
    it("accepts every known specialist role", () => {
      const cfg = parseSigilixConfig(JSON.stringify({
        dispatcher: { force: ["logic", "security", "performance", "tests"] },
      }))
      expect(cfg?.dispatcher?.force).toEqual(["logic", "security", "performance", "tests"])
    })

    it("drops unknown role names silently", () => {
      const cfg = parseSigilixConfig(JSON.stringify({
        dispatcher: { force: ["security", "ux", "deploy", "logic"] },
      }))
      expect(cfg?.dispatcher?.force).toEqual(["security", "logic"])
    })

    it("dedupes repeated roles preserving first-seen order", () => {
      const cfg = parseSigilixConfig(JSON.stringify({
        dispatcher: { force: ["security", "logic", "security", "logic"] },
      }))
      expect(cfg?.dispatcher?.force).toEqual(["security", "logic"])
    })

    it("trims whitespace before role validation", () => {
      const cfg = parseSigilixConfig(JSON.stringify({
        dispatcher: { force: [" security ", "logic"] },
      }))
      expect(cfg?.dispatcher?.force).toEqual(["security", "logic"])
    })

    it("drops non-string entries silently", () => {
      const cfg = parseSigilixConfig(JSON.stringify({
        dispatcher: { force: ["security", 42, null, "logic", true] },
      }))
      expect(cfg?.dispatcher?.force).toEqual(["security", "logic"])
    })

    it("omits force when no valid entries remain", () => {
      const cfg = parseSigilixConfig(JSON.stringify({
        dispatcher: { force: ["ux", 42, null] },
      }))
      expect(cfg?.dispatcher).toBeUndefined()
    })

    it("ignores force when it's not an array", () => {
      const cfg = parseSigilixConfig(JSON.stringify({
        dispatcher: { force: "security" },
      }))
      expect(cfg?.dispatcher).toBeUndefined()
    })
  })

  describe("safetyNet.additionalPatterns", () => {
    it("parses entries with valid glob + role", () => {
      const cfg = parseSigilixConfig(JSON.stringify({
        dispatcher: {
          safetyNet: {
            additionalPatterns: [
              { glob: "src/billing/**", role: "logic" },
              { glob: "infra/**", role: "security" },
            ],
          },
        },
      }))
      expect(cfg?.dispatcher?.safetyNet?.additionalPatterns).toEqual([
        { glob: "src/billing/**", role: "logic" },
        { glob: "infra/**", role: "security" },
      ])
    })

    it("drops entries missing glob or role", () => {
      const cfg = parseSigilixConfig(JSON.stringify({
        dispatcher: {
          safetyNet: {
            additionalPatterns: [
              { glob: "src/billing/**" },
              { role: "logic" },
              { glob: "src/billing/**", role: "logic" },
            ],
          },
        },
      }))
      expect(cfg?.dispatcher?.safetyNet?.additionalPatterns).toEqual([
        { glob: "src/billing/**", role: "logic" },
      ])
    })

    it("drops entries whose role is not a known specialist", () => {
      const cfg = parseSigilixConfig(JSON.stringify({
        dispatcher: {
          safetyNet: {
            additionalPatterns: [
              { glob: "src/billing/**", role: "ux" },
              { glob: "src/billing/**", role: "logic" },
            ],
          },
        },
      }))
      expect(cfg?.dispatcher?.safetyNet?.additionalPatterns).toEqual([
        { glob: "src/billing/**", role: "logic" },
      ])
    })

    it("drops entries with empty / whitespace-only glob", () => {
      const cfg = parseSigilixConfig(JSON.stringify({
        dispatcher: {
          safetyNet: {
            additionalPatterns: [
              { glob: "", role: "logic" },
              { glob: "   ", role: "logic" },
              { glob: "src/x", role: "logic" },
            ],
          },
        },
      }))
      expect(cfg?.dispatcher?.safetyNet?.additionalPatterns).toEqual([
        { glob: "src/x", role: "logic" },
      ])
    })

    it("caps at 50 entries (defensive bound)", () => {
      const many = Array.from({ length: 75 }, (_, i) => ({
        glob: `src/p${i}/**`,
        role: "logic" as const,
      }))
      const cfg = parseSigilixConfig(JSON.stringify({
        dispatcher: { safetyNet: { additionalPatterns: many } },
      }))
      expect(cfg?.dispatcher?.safetyNet?.additionalPatterns).toHaveLength(50)
    })

    it("omits safetyNet when no valid patterns remain", () => {
      const cfg = parseSigilixConfig(JSON.stringify({
        dispatcher: {
          safetyNet: {
            additionalPatterns: [
              { glob: "", role: "logic" },
              { role: "logic" },
            ],
          },
        },
      }))
      expect(cfg?.dispatcher).toBeUndefined()
    })

    it("ignores safetyNet when it's not an object", () => {
      expect(parseSigilixConfig(JSON.stringify({
        dispatcher: { safetyNet: "no" },
      }))?.dispatcher).toBeUndefined()
      expect(parseSigilixConfig(JSON.stringify({
        dispatcher: { safetyNet: [] },
      }))?.dispatcher).toBeUndefined()
    })

    // SIG-224 Phase 0 code-review L2: pin the parser's dedupe contract
    // so the Phase 1 (SIG-225) consumer isn't surprised. The parser
    // PRESERVES identical {glob, role} pairs verbatim — dedupe is the
    // consumer's responsibility (a match-index builder can dedupe at
    // its own layer where the right key shape is known; the parser
    // doesn't know whether `{src/x, logic}` + `{src/x, logic}` is a
    // typo or intentional ordering for a future rule taxonomy).
    it("preserves identical {glob, role} pairs (Phase 1 dedupe is the consumer's job)", () => {
      const cfg = parseSigilixConfig(JSON.stringify({
        dispatcher: {
          safetyNet: {
            additionalPatterns: [
              { glob: "src/x", role: "logic" },
              { glob: "src/x", role: "logic" },
              { glob: "src/y", role: "security" },
            ],
          },
        },
      }))
      expect(cfg?.dispatcher?.safetyNet?.additionalPatterns).toEqual([
        { glob: "src/x", role: "logic" },
        { glob: "src/x", role: "logic" },
        { glob: "src/y", role: "security" },
      ])
    })
  })

  describe("coexistence", () => {
    it("keeps force when only safetyNet is invalid", () => {
      const cfg = parseSigilixConfig(JSON.stringify({
        dispatcher: {
          force: ["logic"],
          safetyNet: "garbage",
        },
      }))
      expect(cfg?.dispatcher).toEqual({ force: ["logic"] })
    })

    it("keeps safetyNet when only force is invalid", () => {
      const cfg = parseSigilixConfig(JSON.stringify({
        dispatcher: {
          force: ["nope"],
          safetyNet: { additionalPatterns: [{ glob: "src/x", role: "logic" }] },
        },
      }))
      expect(cfg?.dispatcher).toEqual({
        safetyNet: { additionalPatterns: [{ glob: "src/x", role: "logic" }] },
      })
    })

    it("preserves dispatcher alongside other config fields", () => {
      const cfg = parseSigilixConfig(JSON.stringify({
        guidance: "this is a TS Cloudflare worker",
        dispatcher: { force: ["security"] },
        perfBudgets: { p50LatencyBudgetMs: 50 },
      }))
      expect(cfg?.guidance).toBe("this is a TS Cloudflare worker")
      expect(cfg?.dispatcher).toEqual({ force: ["security"] })
      expect(cfg?.perfBudgets?.p50LatencyBudgetMs).toBe(50)
    })
  })
})
