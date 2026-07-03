// SIG-303 — usage-meters domain unit tests (pure knobs).

import { describe, it, expect } from "vitest"
import {
  resolveUsageMeterMode,
  resolveUsagePoolCap,
  decideUsagePool,
  usagePct,
  meterPool,
  DEFAULT_POOL_CAPS,
} from "@/src/features/tenancy/domain/usage-meters"
import type { Env } from "@/src/shared/types/env"

describe("resolveUsageMeterMode", () => {
  it("defaults to shadow (absent/unknown/mis-cased)", () => {
    expect(resolveUsageMeterMode({})).toBe("shadow")
    expect(resolveUsageMeterMode({ SIGILIX_USAGE_METER_MODE: "wat" })).toBe("shadow")
    expect(resolveUsageMeterMode({ SIGILIX_USAGE_METER_MODE: "ENFORCE" })).toBe("enforce")
    expect(resolveUsageMeterMode({ SIGILIX_USAGE_METER_MODE: "off" })).toBe("off")
  })
})

describe("meterPool", () => {
  it("maps meters to their pool", () => {
    expect(meterPool("coding_agent")).toBe("seat")
    expect(meterPool("chatbot")).toBe("seat")
    expect(meterPool("pr_reviews")).toBe("org")
    expect(meterPool("linear_triage")).toBe("org")
    expect(meterPool("slack")).toBe("org")
  })
})

describe("resolveUsagePoolCap", () => {
  it("falls back to the default when unset", () => {
    expect(resolveUsagePoolCap({}, "seat", "session")).toBe(DEFAULT_POOL_CAPS.seat.session)
    expect(resolveUsagePoolCap({}, "org", "weekly")).toBe(DEFAULT_POOL_CAPS.org.weekly)
  })
  it("honors an integer env override", () => {
    expect(resolveUsagePoolCap({ SIGILIX_USAGE_CAP_SEAT_SESSION: "7" } as Partial<Env>, "seat", "session")).toBe(7)
  })
  it("treats a negative override as no cap (null)", () => {
    expect(resolveUsagePoolCap({ SIGILIX_USAGE_CAP_ORG_WEEKLY: "-1" } as Partial<Env>, "org", "weekly")).toBeNull()
  })
  it("ignores a non-numeric override", () => {
    expect(resolveUsagePoolCap({ SIGILIX_USAGE_CAP_SEAT_WEEKLY: "abc" } as Partial<Env>, "seat", "weekly")).toBe(
      DEFAULT_POOL_CAPS.seat.weekly,
    )
  })
})

describe("decideUsagePool", () => {
  it("blocks when at/over cap in EITHER window", () => {
    expect(decideUsagePool({ usedSession: 5, capSession: 5, usedWeekly: 0, capWeekly: 100 })).toBe(false)
    expect(decideUsagePool({ usedSession: 0, capSession: 5, usedWeekly: 100, capWeekly: 100 })).toBe(false)
  })
  it("allows when under cap in both windows", () => {
    expect(decideUsagePool({ usedSession: 4, capSession: 5, usedWeekly: 99, capWeekly: 100 })).toBe(true)
  })
  it("fail-open: a null cap never blocks", () => {
    expect(decideUsagePool({ usedSession: 9999, capSession: null, usedWeekly: 9999, capWeekly: null })).toBe(true)
  })
})

describe("usagePct", () => {
  it("rounds 0-100 and returns null for a null/zero cap", () => {
    expect(usagePct(1, 40)).toBe(3)
    expect(usagePct(50, 40)).toBe(100) // clamped
    expect(usagePct(5, null)).toBeNull()
    expect(usagePct(5, 0)).toBeNull()
  })
})
