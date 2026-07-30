// The default-ON contract. If any of these invert, shipping the migration silently
// switches off every existing customer's apps.

import { describe, it, expect } from "vitest"

import { resolveOrgAppPolicy, isOrgAppEnabled } from "@/src/features/org-apps/domain/resolve"
import { ORG_APP_IDS, isOrgAppId, type OrgAppPolicyRow } from "@/src/features/org-apps/domain/types"

const row = (over: Partial<OrgAppPolicyRow> = {}): OrgAppPolicyRow => ({
  appId: "slack",
  enabled: false,
  version: 1,
  updatedBy: "gh:1",
  updatedAtMs: 1000,
  ...over,
})

describe("resolveOrgAppPolicy", () => {
  it("NO ROWS = every app ON (the whole point — an org that never toggled keeps working)", () => {
    const policy = resolveOrgAppPolicy([])
    for (const appId of ORG_APP_IDS) {
      expect(policy[appId].enabled).toBe(true)
      expect(policy[appId].version).toBeNull() // null version marks "never explicitly set"
    }
  })

  it("is TOTAL — always returns every app, even when only one row is stored", () => {
    const policy = resolveOrgAppPolicy([row({ appId: "slack", enabled: false })])
    expect(Object.keys(policy).sort()).toEqual([...ORG_APP_IDS].sort())
    expect(policy.slack.enabled).toBe(false)
    expect(policy.pr_review.enabled).toBe(true) // untouched app unaffected
  })

  it("carries the stored provenance for an explicitly-set app", () => {
    const policy = resolveOrgAppPolicy([row({ appId: "linear", enabled: false, version: 3, updatedBy: "gh:9" })])
    expect(policy.linear).toMatchObject({ enabled: false, version: 3, updatedBy: "gh:9" })
  })

  it("ignores an unknown app id (schema drift) instead of throwing", () => {
    const policy = resolveOrgAppPolicy([{ ...row(), appId: "ghost" as never }])
    expect(policy.slack.enabled).toBe(true)
  })

  it("rejects PROTOTYPE keys — an `in` check would let these through", () => {
    // "constructor"/"__proto__" are truthy under `key in obj`, so a naive guard would
    // add a 7th key (breaking totality) or mutate the returned object's prototype.
    const policy = resolveOrgAppPolicy([
      { ...row(), appId: "constructor" as never },
      { ...row(), appId: "__proto__" as never },
    ])
    expect(Object.keys(policy).sort()).toEqual([...ORG_APP_IDS].sort())
    expect(Object.getPrototypeOf(policy)).toBe(Object.prototype)
  })
})

describe("isOrgAppEnabled", () => {
  it("defaults to enabled for an app with no stored state", () => {
    expect(isOrgAppEnabled(resolveOrgAppPolicy([]), "pr_review")).toBe(true)
  })

  it("honors an explicit off", () => {
    expect(isOrgAppEnabled(resolveOrgAppPolicy([row({ appId: "pr_review", enabled: false })]), "pr_review")).toBe(false)
  })

  it("honors an explicit re-enable (off then on is not sticky-off)", () => {
    expect(
      isOrgAppEnabled(resolveOrgAppPolicy([row({ appId: "pr_review", enabled: true, version: 2 })]), "pr_review"),
    ).toBe(true)
  })
})

describe("isOrgAppId", () => {
  it("accepts the real ids and rejects anything else", () => {
    expect(ORG_APP_IDS.every(isOrgAppId)).toBe(true)
    expect(isOrgAppId("slack ")).toBe(false)
    expect(isOrgAppId("github")).toBe(false)
    expect(isOrgAppId(null)).toBe(false)
  })
})
