import { describe, expect, it } from "vitest"

import {
  branchStateRepo,
  encodeBranchName,
  isBranchStateRepo,
  isTrackedLongLivedBranch,
  parseTrackedBranches,
  resolveIndexTarget,
} from "../src/lib/index-branch"

describe("index branch helpers", () => {
  it("encodes branch names into one stable state segment", () => {
    expect(encodeBranchName("feature/SIG-35 branch aware")).toBe(
      "h666561747572652f5349472d3335206272616e6368206177617265",
    )
    expect(branchStateRepo("sigilix", "feature/SIG-35")).toBe("sigilix/__branch__/h666561747572652f5349472d3335")
  })

  it("keeps branch encodings collision-free under lowercased namespaces", () => {
    expect(encodeBranchName("Feature/X")).toBe("h466561747572652f58")
    expect(encodeBranchName("feature/x")).toBe("h666561747572652f78")
    expect(encodeBranchName("a%")).toBe("h6125")
    expect(encodeBranchName("a~25")).toBe("h617e3235")
    expect(encodeBranchName("emoji/ñ")).toBe("h656d6f6a692fc3b1")
  })

  it("resolves default branches to the existing repo namespace", () => {
    expect(resolveIndexTarget({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      defaultBranch: "main",
      branch: "main",
    })).toMatchObject({
      branch: "main",
      stateRepo: "sigilix",
      namespace: "arc-and-anchor/sigilix",
      isDefault: true,
    })
  })

  it("resolves non-default branches to isolated state and namespace", () => {
    expect(resolveIndexTarget({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      defaultBranch: "main",
      branch: "dev",
    })).toMatchObject({
      branch: "dev",
      stateRepo: "sigilix/__branch__/h646576",
      namespace: "arc-and-anchor/sigilix/__branch__/h646576",
      isDefault: false,
    })
    expect(isBranchStateRepo("sigilix/__branch__/h646576")).toBe(true)
    expect(isBranchStateRepo("sigilix")).toBe(false)
    expect(isBranchStateRepo("my__branch__repo")).toBe(false)
    expect(isBranchStateRepo("sigilix/nested/__branch__/dev")).toBe(false)
  })

  it("tracks common long-lived branches plus configured names", () => {
    expect(isTrackedLongLivedBranch("dev", undefined)).toBe(true)
    expect(isTrackedLongLivedBranch("release", undefined)).toBe(false)
    expect(isTrackedLongLivedBranch("release", "qa, release")).toBe(true)
    expect(Array.from(parseTrackedBranches(" qa ,, Next ")).sort()).toContain("next")
  })
})
