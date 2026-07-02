// SIG-298 follow-on — applySdkGuidanceAttribution: the off/shadow/on mode
// contract (byte-identical in off/shadow), marker strip + attribution stamp
// in `on`, and the "don't attribute a marker for a pack that wasn't actually
// injected" safety property.

import { describe, expect, it } from "vitest"

import { applySdkGuidanceAttribution } from "@/src/lib/ensemble/app/sdk-guidance-attribution-prep"
import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import type { MatchedSdkPack } from "@/src/lib/sdk-packs"
import type { Env } from "@/src/shared/types/env"

function makeEnv(mode: string | undefined): Env {
  return { OPENCLAW_SDK_PACKS_MODE: mode } as unknown as Env
}

function finding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "src/checkout.ts",
    line: 10,
    score: 4,
    category: "security",
    headline: "Missing webhook signature verification",
    body: "This handler trusts the payload without verifying it. [sdk:stripe]",
    ...overrides,
  } as PrReviewFinding
}

const STRIPE_MATCH: MatchedSdkPack = {
  pack: {
    id: "stripe",
    vendor: "Stripe",
    docsUrl: "https://stripe.com/docs",
    matchers: { packages: ["stripe"], importPatterns: [] },
    rules: [],
  },
  matchedPaths: ["src/checkout.ts"],
}

describe("applySdkGuidanceAttribution", () => {
  it("off: returns the kept array untouched (bodies keep any raw marker)", () => {
    const f = finding()
    const kept = applySdkGuidanceAttribution({
      env: makeEnv("off"),
      owner: "o",
      repo: "r",
      prNumber: 1,
      kept: [f],
      matchedSdkPacks: [STRIPE_MATCH],
    })
    expect(kept).toEqual([f])
    expect(kept[0]!.body).toContain("[sdk:stripe]")
    expect(kept[0]!.sdkGuidance).toBeUndefined()
  })

  it("shadow: does not strip the marker or attribute (byte-identical to off)", () => {
    const f = finding()
    const kept = applySdkGuidanceAttribution({
      env: makeEnv("shadow"),
      owner: "o",
      repo: "r",
      prNumber: 1,
      kept: [f],
      matchedSdkPacks: [STRIPE_MATCH],
    })
    expect(kept[0]!.body).toContain("[sdk:stripe]")
    expect(kept[0]!.sdkGuidance).toBeUndefined()
  })

  it("on: strips the marker from the body and stamps sdkGuidance attribution", () => {
    const f = finding()
    const kept = applySdkGuidanceAttribution({
      env: makeEnv("on"),
      owner: "o",
      repo: "r",
      prNumber: 1,
      kept: [f],
      matchedSdkPacks: [STRIPE_MATCH],
    })
    expect(kept[0]!.body).not.toContain("[sdk:")
    expect(kept[0]!.body).toBe("This handler trusts the payload without verifying it.")
    expect(kept[0]!.sdkGuidance).toEqual({
      packId: "stripe",
      vendor: "Stripe",
      docsUrl: "https://stripe.com/docs",
    })
  })

  it("on: strips a marker but does NOT attribute when the packId wasn't actually injected", () => {
    const f = finding({ body: "Some finding body. [sdk:supabase]" })
    const kept = applySdkGuidanceAttribution({
      env: makeEnv("on"),
      owner: "o",
      repo: "r",
      prNumber: 1,
      // Only stripe was injected into this review's context — the model
      // hallucinated a supabase marker.
      kept: [f],
      matchedSdkPacks: [STRIPE_MATCH],
    })
    expect(kept[0]!.body).not.toContain("[sdk:")
    expect(kept[0]!.sdkGuidance).toBeUndefined()
  })

  it("on: a finding with no marker is left untouched (no spurious attribution)", () => {
    const f = finding({ body: "Plain finding, no SDK marker." })
    const kept = applySdkGuidanceAttribution({
      env: makeEnv("on"),
      owner: "o",
      repo: "r",
      prNumber: 1,
      kept: [f],
      matchedSdkPacks: [STRIPE_MATCH],
    })
    expect(kept[0]!.body).toBe("Plain finding, no SDK marker.")
    expect(kept[0]!.sdkGuidance).toBeUndefined()
  })

  it("on: never removes, demotes, or otherwise changes a finding's severity", () => {
    const f = finding({ score: 5 })
    const kept = applySdkGuidanceAttribution({
      env: makeEnv("on"),
      owner: "o",
      repo: "r",
      prNumber: 1,
      kept: [f],
      matchedSdkPacks: [STRIPE_MATCH],
    })
    expect(kept).toHaveLength(1)
    expect(kept[0]!.score).toBe(5)
  })

  it("on with no matched packs: still strips a stray marker but attributes nothing", () => {
    const f = finding()
    const kept = applySdkGuidanceAttribution({
      env: makeEnv("on"),
      owner: "o",
      repo: "r",
      prNumber: 1,
      kept: [f],
      matchedSdkPacks: [],
    })
    expect(kept[0]!.body).not.toContain("[sdk:")
    expect(kept[0]!.sdkGuidance).toBeUndefined()
  })
})
