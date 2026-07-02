// Pin the extracted marker-attribution composition: it runs BOTH the
// SDK-guidance and custom-rule gates over BOTH renderable scopes, strips both
// marker kinds, and never changes either array's length.

import { describe, expect, it } from "vitest"

import { applyMarkerAttributions } from "@/src/lib/ensemble/app/marker-attribution-prep"
import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import type { MatchedSdkPack } from "@/src/lib/sdk-packs"
import type { MatchedSigilixCustomRule } from "@/src/lib/sigilix-config"
import type { Env } from "@/src/shared/types/env"

function makeEnv(): Env {
  return { OPENCLAW_SDK_PACKS_MODE: "on", OPENCLAW_CONFIG_AS_CODE_MODE: "on" } as unknown as Env
}

function finding(body: string): PrReviewFinding {
  return { path: "src/x.ts", line: 1, score: 4, category: "security", headline: "h", body } as PrReviewFinding
}

const SDK: MatchedSdkPack = {
  pack: {
    id: "stripe",
    vendor: "Stripe",
    docsUrl: "https://stripe.com/docs",
    matchers: { packages: [], importPatterns: [] },
    rules: [],
  },
  matchedPaths: ["src/x.ts"],
}
const RULE: MatchedSigilixCustomRule = { rule: { id: "no-raw-sql", rule: "Flag raw SQL." }, matchedPaths: ["src/x.ts"] }

describe("applyMarkerAttributions", () => {
  it("strips both marker kinds across both scopes and stamps attribution", () => {
    const precisionKept = [finding("Anchored issue. [sdk:stripe]")]
    const renderableUnanchoredRaw = [finding("Body-only issue. [repo-rule:no-raw-sql]")]
    const result = applyMarkerAttributions({
      env: makeEnv(),
      owner: "o",
      repo: "r",
      prNumber: 1,
      precisionKept,
      renderableUnanchoredRaw,
      matchedSdkPacks: [SDK],
      matchedCustomRules: [RULE],
    })
    expect(result).toBe(precisionKept)
    expect(result[0]!.body).toBe("Anchored issue.")
    expect(result[0]!.sdkGuidance?.packId).toBe("stripe")
    expect(renderableUnanchoredRaw[0]!.body).toBe("Body-only issue.")
    expect(renderableUnanchoredRaw[0]!.repoRule?.id).toBe("no-raw-sql")
  })

  it("never changes either array's length (recall-safety)", () => {
    const precisionKept = [finding("a [sdk:stripe]"), finding("b [repo-rule:no-raw-sql]")]
    const renderableUnanchoredRaw = [finding("c")]
    const result = applyMarkerAttributions({
      env: makeEnv(),
      owner: "o",
      repo: "r",
      prNumber: 1,
      precisionKept,
      renderableUnanchoredRaw,
      matchedSdkPacks: [SDK],
      matchedCustomRules: [RULE],
    })
    expect(result.length).toBe(2)
    expect(renderableUnanchoredRaw.length).toBe(1)
  })

  it("treats missing matched sets as empty (still strips stray markers)", () => {
    const precisionKept = [finding("x [sdk:stripe] [repo-rule:no-raw-sql]")]
    const result = applyMarkerAttributions({
      env: makeEnv(),
      owner: "o",
      repo: "r",
      prNumber: 1,
      precisionKept,
      renderableUnanchoredRaw: [],
    })
    expect(result[0]!.body).not.toContain("[sdk:")
    expect(result[0]!.body).not.toContain("[repo-rule:")
    expect(result[0]!.sdkGuidance).toBeUndefined()
    expect(result[0]!.repoRule).toBeUndefined()
  })
})
