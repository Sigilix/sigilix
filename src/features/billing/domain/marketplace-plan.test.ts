// sig-github-marketplace-billing — pure mapper + interpreter unit tests.

import { describe, it, expect } from "vitest"
import {
  parseMarketplacePlanMap,
  resolveMarketplaceTier,
  extractSeats,
  interpretMarketplaceEvent,
} from "@/src/features/billing/domain/marketplace-plan"

describe("parseMarketplacePlanMap", () => {
  it("parses a valid plan-id → tier JSON map", () => {
    expect(parseMarketplacePlanMap('{"101":"pro","102":"teams","103":"ultra"}')).toEqual({
      "101": "pro",
      "102": "teams",
      "103": "ultra",
    })
  })

  it("returns {} for absent / blank input", () => {
    expect(parseMarketplacePlanMap(undefined)).toEqual({})
    expect(parseMarketplacePlanMap(null)).toEqual({})
    expect(parseMarketplacePlanMap("   ")).toEqual({})
  })

  it("returns {} for invalid JSON (fail-soft)", () => {
    expect(parseMarketplacePlanMap("{not json")).toEqual({})
  })

  it("returns {} for a non-object (array / scalar)", () => {
    expect(parseMarketplacePlanMap('["pro"]')).toEqual({})
    expect(parseMarketplacePlanMap('"pro"')).toEqual({})
  })

  it("drops entries whose value is not a valid Marketplace tier — including enterprise (fail-closed)", () => {
    expect(parseMarketplacePlanMap('{"1":"pro","2":"enterprise","3":"bogus","4":"MAX"}')).toEqual({
      "1": "pro",
      "4": "max", // normalized (trim + lowercase)
    })
  })
})

describe("resolveMarketplaceTier", () => {
  const planMap = { "500": "teams" as const, "501": "ultra" as const }

  it("exact plan-id in the env map takes precedence over the name heuristic", () => {
    // id 500 → teams even though the name says "Pro".
    expect(resolveMarketplaceTier({ planId: "500", planName: "Pro Plan", planMap })).toBe("teams")
  })

  it("falls back to the case-insensitive name heuristic when the id is not mapped", () => {
    expect(resolveMarketplaceTier({ planId: "999", planName: "Sigilix ULTRA", planMap })).toBe("ultra")
    expect(resolveMarketplaceTier({ planId: null, planName: "Max monthly", planMap })).toBe("max")
    expect(resolveMarketplaceTier({ planId: null, planName: "Team", planMap })).toBe("teams")
    expect(resolveMarketplaceTier({ planId: null, planName: "Teams", planMap })).toBe("teams")
    expect(resolveMarketplaceTier({ planId: null, planName: "pro", planMap })).toBe("pro")
    expect(resolveMarketplaceTier({ planId: null, planName: "Free forever", planMap })).toBe("free")
  })

  it("highest tier wins when a name could match multiple tokens", () => {
    expect(resolveMarketplaceTier({ planId: null, planName: "Ultra Pro Max", planMap })).toBe("ultra")
    expect(resolveMarketplaceTier({ planId: null, planName: "Max Team", planMap })).toBe("max")
  })

  it("does NOT match a tier token buried inside another word", () => {
    // "approved" contains "pro" but not as a token → free.
    expect(resolveMarketplaceTier({ planId: null, planName: "approved plan", planMap })).toBe("free")
    // "maximum" contains "max" but not as a token → free.
    expect(resolveMarketplaceTier({ planId: null, planName: "maximum value", planMap })).toBe("free")
  })

  it("unknown / blank plan falls closed to free", () => {
    expect(resolveMarketplaceTier({ planId: null, planName: null, planMap })).toBe("free")
    expect(resolveMarketplaceTier({ planId: "unmapped", planName: "Business Deluxe", planMap })).toBe("free")
    expect(resolveMarketplaceTier({ planId: "", planName: "", planMap })).toBe("free")
  })

  it("never returns enterprise even if a name says enterprise", () => {
    expect(resolveMarketplaceTier({ planId: null, planName: "Enterprise", planMap })).toBe("free")
  })
})

describe("extractSeats", () => {
  it("returns a positive integer unit_count", () => {
    expect(extractSeats(5)).toBe(5)
    expect(extractSeats("12")).toBe(12)
  })
  it("returns null for zero / negative / non-integer / absent / malformed", () => {
    expect(extractSeats(0)).toBeNull()
    expect(extractSeats(-3)).toBeNull()
    expect(extractSeats(1.5)).toBeNull()
    expect(extractSeats(undefined)).toBeNull()
    expect(extractSeats(null)).toBeNull()
    expect(extractSeats("abc")).toBeNull()
  })
})

describe("interpretMarketplaceEvent", () => {
  const planMap = { "700": "pro" as const }

  it("purchased → apply active tier from the mapper, with account + seats", () => {
    const r = interpretMarketplaceEvent(
      {
        action: "purchased",
        marketplace_purchase: {
          account: { id: 42, login: "acme", type: "Organization" },
          unit_count: 8,
          plan: { id: 700, name: "Whatever" },
        },
      },
      planMap,
    )
    expect(r).toEqual({
      kind: "apply",
      action: "purchased",
      accountId: 42,
      accountLogin: "acme",
      accountType: "Organization",
      tier: "pro",
      seats: 8,
      subscriptionStatus: "active",
    })
  })

  it("changed → apply active tier (resolved via name when id unmapped)", () => {
    const r = interpretMarketplaceEvent(
      {
        action: "changed",
        marketplace_purchase: {
          account: { id: 43, login: "beta", type: "User" },
          plan: { id: 9999, name: "Ultra" },
        },
      },
      planMap,
    )
    expect(r).toMatchObject({
      kind: "apply",
      action: "changed",
      tier: "ultra",
      subscriptionStatus: "active",
      seats: null,
    })
  })

  it("cancelled → apply free / canceled", () => {
    const r = interpretMarketplaceEvent(
      {
        action: "cancelled",
        marketplace_purchase: { account: { id: 44, login: "gamma" }, plan: { id: 700, name: "Pro" } },
      },
      planMap,
    )
    expect(r).toMatchObject({ kind: "apply", action: "cancelled", tier: "free", subscriptionStatus: "canceled" })
  })

  it("pending_change / pending_change_cancelled → defer (no tier change)", () => {
    expect(interpretMarketplaceEvent({ action: "pending_change" }, planMap)).toEqual({
      kind: "defer",
      reason: "pending_change",
    })
    expect(interpretMarketplaceEvent({ action: "pending_change_cancelled" }, planMap)).toEqual({
      kind: "defer",
      reason: "pending_change_cancelled",
    })
  })

  it("missing action → ignore", () => {
    expect(interpretMarketplaceEvent({}, planMap)).toEqual({ kind: "ignore", reason: "missing-action" })
  })

  it("unknown action → ignore", () => {
    expect(interpretMarketplaceEvent({ action: "exploded" }, planMap)).toEqual({
      kind: "ignore",
      reason: "unhandled:exploded",
    })
  })

  it("missing marketplace_purchase on an actionable event → ignore (never throws)", () => {
    expect(interpretMarketplaceEvent({ action: "purchased" }, planMap)).toEqual({
      kind: "ignore",
      reason: "missing-marketplace_purchase",
    })
  })

  it("malformed account fields degrade to null, never throw", () => {
    const r = interpretMarketplaceEvent(
      {
        action: "purchased",
        marketplace_purchase: {
          account: { id: "not-a-number" as unknown as number, login: "" },
          plan: { name: "Pro" },
        },
      },
      planMap,
    )
    expect(r).toMatchObject({ kind: "apply", accountId: null, accountLogin: null, tier: "pro" })
  })
})
