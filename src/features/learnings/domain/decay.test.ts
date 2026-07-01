import { describe, expect, it } from "vitest"

import { EPHEMERAL_MEMORY_TYPES, MEMORY_DECAY_WINDOW_DAYS, isMemoryDecayEligible } from "./decay"
import type { LearningEntry } from "./types"

const NOW = Date.parse("2026-06-30T12:00:00.000Z")
const DAY_MS = 24 * 60 * 60 * 1000

/** Days-ago → epoch-ms closure timestamp, relative to the fixed NOW. */
function closedDaysAgo(days: number): number {
  return NOW - days * DAY_MS
}

/**
 * Fresh taxonomy-fields fixture. Mirrors the `entry()` style in
 * `learnings.test.ts`: the taxonomy fields default to ABSENT so the base models
 * a legacy (pre-taxonomy) record; a test opts in via overrides.
 */
function entry(
  overrides: Partial<Pick<LearningEntry, "type" | "lifespanAnchor">> = {},
): Pick<LearningEntry, "type" | "lifespanAnchor"> {
  return {
    ...(overrides.type !== undefined ? { type: overrides.type } : {}),
    ...(overrides.lifespanAnchor !== undefined ? { lifespanAnchor: overrides.lifespanAnchor } : {}),
  }
}

describe("isMemoryDecayEligible", () => {
  it("1. ephemeral_project + pr anchor + closed 22 days ago → eligible", () => {
    expect(
      isMemoryDecayEligible(
        entry({ type: "ephemeral_project", lifespanAnchor: { kind: "pr", prNumber: 7 } }),
        closedDaysAgo(22),
        NOW,
      ),
    ).toBe(true)
  })

  it("2. ephemeral_project + pr anchor + PR still open (null) → keep", () => {
    expect(
      isMemoryDecayEligible(
        entry({ type: "ephemeral_project", lifespanAnchor: { kind: "pr", prNumber: 7 } }),
        null,
        NOW,
      ),
    ).toBe(false)
  })

  it("3. ephemeral_project + pr anchor + closed 5 days ago (< window) → keep", () => {
    expect(
      isMemoryDecayEligible(
        entry({ type: "ephemeral_project", lifespanAnchor: { kind: "pr", prNumber: 7 } }),
        closedDaysAgo(5),
        NOW,
      ),
    ).toBe(false)
  })

  it("4. transient_feedback + pr anchor + closed 22 days ago → eligible", () => {
    expect(
      isMemoryDecayEligible(
        entry({ type: "transient_feedback", lifespanAnchor: { kind: "pr", prNumber: 7 } }),
        closedDaysAgo(22),
        NOW,
      ),
    ).toBe(true)
  })

  it("5. durable_preference + closed 1000 days ago → keep (durable is untouchable)", () => {
    expect(
      isMemoryDecayEligible(
        entry({ type: "durable_preference", lifespanAnchor: { kind: "pr", prNumber: 7 } }),
        closedDaysAgo(1000),
        NOW,
      ),
    ).toBe(false)
  })

  it("6. architectural_fact + closed 1000 days ago → keep (durable is untouchable)", () => {
    expect(
      isMemoryDecayEligible(
        entry({ type: "architectural_fact", lifespanAnchor: { kind: "pr", prNumber: 7 } }),
        closedDaysAgo(1000),
        NOW,
      ),
    ).toBe(false)
  })

  it("7. legacy entry (no type / no lifespanAnchor) → keep even with a closed timestamp", () => {
    expect(isMemoryDecayEligible(entry(), closedDaysAgo(1000), NOW)).toBe(false)
    // Also assert each half of the legacy guard independently.
    expect(isMemoryDecayEligible(entry({ type: "ephemeral_project" }), closedDaysAgo(1000), NOW)).toBe(false)
    expect(
      isMemoryDecayEligible(entry({ lifespanAnchor: { kind: "pr", prNumber: 7 } }), closedDaysAgo(1000), NOW),
    ).toBe(false)
  })

  it("8. ephemeral_project + durable anchor → keep (a classify fallback case)", () => {
    expect(
      isMemoryDecayEligible(
        entry({ type: "ephemeral_project", lifespanAnchor: { kind: "durable" } }),
        closedDaysAgo(1000),
        NOW,
      ),
    ).toBe(false)
  })

  it("9. ephemeral_project + pr anchor + null (API error / unknown state) → keep (fail-safe on ambiguity)", () => {
    // Same code path as case 2 (null), but pinned by name so the
    // fail-safe-on-ambiguity contract is explicit: an unresolved PR state can
    // never reap.
    expect(
      isMemoryDecayEligible(
        entry({ type: "ephemeral_project", lifespanAnchor: { kind: "pr", prNumber: 7 } }),
        null,
        NOW,
      ),
    ).toBe(false)
  })

  it("10. exactly at the boundary (age == window, not >) → keep (> not >=)", () => {
    expect(
      isMemoryDecayEligible(
        entry({ type: "ephemeral_project", lifespanAnchor: { kind: "pr", prNumber: 7 } }),
        closedDaysAgo(MEMORY_DECAY_WINDOW_DAYS),
        NOW,
      ),
    ).toBe(false)
    // One millisecond past the boundary → eligible, confirming the strict `>`.
    expect(
      isMemoryDecayEligible(
        entry({ type: "ephemeral_project", lifespanAnchor: { kind: "pr", prNumber: 7 } }),
        closedDaysAgo(MEMORY_DECAY_WINDOW_DAYS) - 1,
        NOW,
      ),
    ).toBe(true)
  })

  it("11. ephemeral_project + branch anchor → keep (no closure signal today)", () => {
    expect(
      isMemoryDecayEligible(
        entry({ type: "ephemeral_project", lifespanAnchor: { kind: "branch", name: "feat/x" } }),
        closedDaysAgo(1000),
        NOW,
      ),
    ).toBe(false)
  })

  it("exposes the ephemeral tiers and window as named constants", () => {
    expect(MEMORY_DECAY_WINDOW_DAYS).toBe(21)
    expect([...EPHEMERAL_MEMORY_TYPES].sort()).toEqual(["ephemeral_project", "transient_feedback"])
    expect(EPHEMERAL_MEMORY_TYPES.has("durable_preference")).toBe(false)
    expect(EPHEMERAL_MEMORY_TYPES.has("architectural_fact")).toBe(false)
  })
})
