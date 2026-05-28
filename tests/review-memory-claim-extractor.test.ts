// SIG-276 Phase 2 — write-time claim extractor tests.

import { describe, it, expect, vi } from "vitest"
import {
  parseClaimExtractionResponse,
  buildClaimExtractionPrompt,
  extractClaims,
  CLAIM_EXTRACTOR_VERSION,
  MIN_CLAIM_CONFIDENCE,
  MAX_CLAIMS_PER_FINDING,
  type ClaimExtractionFinding,
} from "../src/lib/review-memory/claim-extractor"

const finding = (headline: string): ClaimExtractionFinding => ({
  headline,
  body: `body for ${headline}`,
  category: "tests",
})

describe("parseClaimExtractionResponse — validation", () => {
  it("parses a valid response into index-aligned claim lists", () => {
    const content = JSON.stringify({
      findings: [
        {
          index: 0,
          claims: [{ type: "structural-glue-not-test-target", confidence: 0.8 }],
        },
        { index: 1, claims: [] },
      ],
    })
    const out = parseClaimExtractionResponse(content, 2)
    expect(out).toEqual([
      [
        {
          type: "structural-glue-not-test-target",
          confidence: 0.8,
          extractorVersion: CLAIM_EXTRACTOR_VERSION,
        },
      ],
      [],
    ])
  })

  it("returns an array of exactly findingCount entries, defaulting to []", () => {
    const content = JSON.stringify({
      findings: [{ index: 1, claims: [{ type: "auth-gate-is-boundary", confidence: 0.9 }] }],
    })
    const out = parseClaimExtractionResponse(content, 3)
    expect(out).toHaveLength(3)
    expect(out?.[0]).toEqual([])
    expect(out?.[2]).toEqual([])
    expect(out?.[1]).toHaveLength(1)
  })

  it("drops an unknown claim type", () => {
    const content = JSON.stringify({
      findings: [
        {
          index: 0,
          claims: [
            { type: "not-a-real-claim", confidence: 0.95 },
            { type: "auth-gate-is-boundary", confidence: 0.7 },
          ],
        },
      ],
    })
    const out = parseClaimExtractionResponse(content, 1)
    expect(out?.[0]).toEqual([
      { type: "auth-gate-is-boundary", confidence: 0.7, extractorVersion: CLAIM_EXTRACTOR_VERSION },
    ])
  })

  it("drops a claim below MIN_CLAIM_CONFIDENCE", () => {
    const content = JSON.stringify({
      findings: [
        {
          index: 0,
          claims: [{ type: "auth-gate-is-boundary", confidence: MIN_CLAIM_CONFIDENCE - 0.01 }],
        },
      ],
    })
    const out = parseClaimExtractionResponse(content, 1)
    expect(out?.[0]).toEqual([])
  })

  it("drops a claim with out-of-range or non-numeric confidence", () => {
    const content = JSON.stringify({
      findings: [
        {
          index: 0,
          claims: [
            { type: "auth-gate-is-boundary", confidence: 1.5 },
            { type: "rethrowing-catch-not-swallowed", confidence: "high" },
          ],
        },
      ],
    })
    const out = parseClaimExtractionResponse(content, 1)
    expect(out?.[0]).toEqual([])
  })

  it("caps at MAX_CLAIMS_PER_FINDING", () => {
    const claims = [
      { type: "auth-gate-is-boundary", confidence: 0.9 },
      { type: "structural-glue-not-test-target", confidence: 0.9 },
      { type: "globally-unique-id-is-tenant-isolation", confidence: 0.9 },
      { type: "rethrowing-catch-not-swallowed", confidence: 0.9 },
    ]
    const content = JSON.stringify({ findings: [{ index: 0, claims }] })
    const out = parseClaimExtractionResponse(content, 1)
    expect(out?.[0]).toHaveLength(MAX_CLAIMS_PER_FINDING)
  })

  it("skips an out-of-range finding index", () => {
    const content = JSON.stringify({
      findings: [{ index: 9, claims: [{ type: "auth-gate-is-boundary", confidence: 0.9 }] }],
    })
    const out = parseClaimExtractionResponse(content, 1)
    expect(out).toEqual([[]])
  })

  it("returns null on invalid JSON", () => {
    expect(parseClaimExtractionResponse("not json", 1)).toBeNull()
  })

  it("returns null when `findings` is missing or not an array", () => {
    expect(parseClaimExtractionResponse(JSON.stringify({ foo: 1 }), 1)).toBeNull()
    expect(parseClaimExtractionResponse(JSON.stringify({ findings: "x" }), 1)).toBeNull()
  })

  it("output carries no free-text fields (privacy contract)", () => {
    const content = JSON.stringify({
      findings: [
        {
          index: 0,
          claims: [
            {
              type: "auth-gate-is-boundary",
              confidence: 0.8,
              evidence: "raw reviewer text that must not survive",
            },
          ],
        },
      ],
    })
    const out = parseClaimExtractionResponse(content, 1)
    expect(Object.keys(out![0]![0]!).sort()).toEqual([
      "confidence",
      "extractorVersion",
      "type",
    ])
  })
})

describe("buildClaimExtractionPrompt — pure prompt", () => {
  it("includes each finding's index and headline in the user message", () => {
    const { user } = buildClaimExtractionPrompt([finding("Helper has no test"), finding("Auth missing")])
    expect(user).toContain("Helper has no test")
    expect(user).toContain("Auth missing")
    expect(user).toMatch(/\b0\b/)
    expect(user).toMatch(/\b1\b/)
  })

  it("lists the allowed claim types in the system message", () => {
    const { system } = buildClaimExtractionPrompt([finding("x")])
    expect(system).toContain("auth-gate-is-boundary")
    expect(system).toContain("structural-glue-not-test-target")
  })
})

describe("extractClaims — fail-open orchestration", () => {
  it("returns [] and never calls the classifier for zero findings", async () => {
    const runClassifier = vi.fn()
    const out = await extractClaims({ findings: [], runClassifier })
    expect(out).toEqual([])
    expect(runClassifier).not.toHaveBeenCalled()
  })

  it("fails open (all-empty, aligned) when the classifier throws", async () => {
    const out = await extractClaims({
      findings: [finding("a"), finding("b")],
      runClassifier: async () => {
        throw new Error("model down")
      },
    })
    expect(out).toEqual([[], []])
  })

  it("fails open when the classifier returns null", async () => {
    const out = await extractClaims({
      findings: [finding("a")],
      runClassifier: async () => null,
    })
    expect(out).toEqual([[]])
  })

  it("fails open when the classifier returns unparseable content", async () => {
    const out = await extractClaims({
      findings: [finding("a")],
      runClassifier: async () => "garbage not json",
    })
    expect(out).toEqual([[]])
  })

  it("returns parsed claims on a valid classifier response", async () => {
    const out = await extractClaims({
      findings: [finding("a"), finding("b")],
      runClassifier: async () =>
        JSON.stringify({
          findings: [{ index: 1, claims: [{ type: "auth-gate-is-boundary", confidence: 0.8 }] }],
        }),
    })
    expect(out).toEqual([
      [],
      [{ type: "auth-gate-is-boundary", confidence: 0.8, extractorVersion: CLAIM_EXTRACTOR_VERSION }],
    ])
  })
})
