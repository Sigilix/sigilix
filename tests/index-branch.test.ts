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
    expect(encodeBranchName("feature/SIG-35 branch aware")).toBe("feature~2fsig-35~20branch~20aware")
    expect(branchStateRepo("sigilix", "feature/SIG-35")).toBe("sigilix/__branch__/feature~2fsig-35")
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
      stateRepo: "sigilix/__branch__/dev",
      namespace: "arc-and-anchor/sigilix/__branch__/dev",
      isDefault: false,
    })
    expect(isBranchStateRepo("sigilix/__branch__/dev")).toBe(true)
    expect(isBranchStateRepo("sigilix")).toBe(false)
  })

  it("tracks common long-lived branches plus configured names", () => {
    expect(isTrackedLongLivedBranch("dev", undefined)).toBe(true)
    expect(isTrackedLongLivedBranch("release", undefined)).toBe(false)
    expect(isTrackedLongLivedBranch("release", "qa, release")).toBe(true)
    expect(Array.from(parseTrackedBranches(" qa ,, Next ")).sort()).toContain("next")
  })
})
