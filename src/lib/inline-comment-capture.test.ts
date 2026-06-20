// SIG-473 — tests for the pure fingerprint→comment-id capture helper.

import { describe, it, expect } from "vitest"

import { buildFingerprintToCommentId } from "@/src/lib/inline-comment-capture"

const FP_A = "a".repeat(64)
const FP_B = "b".repeat(64)

const withFp = (fp: string): string => `body text <!-- sigilix:fingerprint:${fp} -->`

describe("buildFingerprintToCommentId", () => {
  it("maps each comment's parsed fingerprint to its id", () => {
    const map = buildFingerprintToCommentId([
      { id: 1, body: withFp(FP_A) },
      { id: 2, body: withFp(FP_B) },
    ])
    expect(map.get(FP_A)).toBe(1)
    expect(map.get(FP_B)).toBe(2)
    expect(map.size).toBe(2)
  })

  it("skips comments with no fingerprint or a malformed one", () => {
    const map = buildFingerprintToCommentId([
      { id: 1, body: "no marker here" },
      { id: 2, body: "<!-- sigilix:fingerprint:not-hex -->" },
      { id: 3, body: "<!-- sigilix:fingerprint:tooshort -->" },
      { id: 4, body: withFp(FP_A) },
    ])
    expect(map.size).toBe(1)
    expect(map.get(FP_A)).toBe(4)
  })

  it("keeps the first id on a duplicate fingerprint (first wins)", () => {
    const map = buildFingerprintToCommentId([
      { id: 10, body: withFp(FP_A) },
      { id: 20, body: withFp(FP_A) },
    ])
    expect(map.get(FP_A)).toBe(10)
    expect(map.size).toBe(1)
  })
})
