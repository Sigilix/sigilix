// ARC-189 Task 11 — prompt-version stale suppression tests.

import { describe, expect, it } from "vitest"
import {
  evaluatePromptVersionSuppression,
  filterReasonsForSuppression,
} from "@/src/lib/triage-pr-stale-mark"
import type { Env } from "@/src/shared/types/env"
import type { StaleReason } from "@/src/lib/review-manifest"

function envWith(over: Partial<Env> = {}): Env {
  return {
    OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE: undefined,
    OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE_SET_AT: undefined,
    ...over,
  } as unknown as Env
}

const NOW = 1_000_000_000_000  // arbitrary fixed clock (UNIX ms)
const NOW_SEC = NOW / 1000
const HOUR_SEC = 3600

describe("evaluatePromptVersionSuppression — env unset", () => {
  it("env unset → applies: false, reason: off, no telemetry", () => {
    const r = evaluatePromptVersionSuppression(envWith(), NOW)
    expect(r.applies).toBe(false)
    expect(r.reason).toBe("off")
  })

  it("env explicit 'off' → applies: false, reason: off", () => {
    const env = envWith({ OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE: "off" })
    const r = evaluatePromptVersionSuppression(env, NOW)
    expect(r.applies).toBe(false)
    expect(r.reason).toBe("off")
  })
})

describe("evaluatePromptVersionSuppression — SET_AT validation (fail-closed)", () => {
  it("env on, SET_AT unset → set-at-missing (fail-closed: ignore suppression)", () => {
    const env = envWith({ OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE: "on" })
    const r = evaluatePromptVersionSuppression(env, NOW)
    expect(r.applies).toBe(false)
    expect(r.reason).toBe("set-at-missing")
  })

  it("env on, SET_AT non-numeric → set-at-malformed", () => {
    const env = envWith({
      OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE: "on",
      OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE_SET_AT: "notanumber",
    })
    const r = evaluatePromptVersionSuppression(env, NOW)
    expect(r.applies).toBe(false)
    expect(r.reason).toBe("set-at-malformed")
  })

  it("env on, SET_AT 5 minutes in the future (clock-skew > 60s) → set-at-future", () => {
    const env = envWith({
      OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE: "on",
      OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE_SET_AT: String(NOW_SEC + 5 * 60),
    })
    const r = evaluatePromptVersionSuppression(env, NOW)
    expect(r.applies).toBe(false)
    expect(r.reason).toBe("set-at-future")
  })

  it("env on, SET_AT 30s in the future (within clock-skew tolerance) → applies", () => {
    const env = envWith({
      OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE: "on",
      OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE_SET_AT: String(NOW_SEC + 30),
    })
    const r = evaluatePromptVersionSuppression(env, NOW)
    expect(r.applies).toBe(true)
    expect(r.reason).toBe("applies")
  })
})

describe("evaluatePromptVersionSuppression — age + log-level escalation", () => {
  function envOn(setAtSec: number): Env {
    return envWith({
      OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE: "on",
      OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE_SET_AT: String(setAtSec),
    })
  }

  it("1h ago → applies, level info", () => {
    const r = evaluatePromptVersionSuppression(envOn(NOW_SEC - HOUR_SEC), NOW)
    expect(r.applies).toBe(true)
    expect(r.heartbeatLevel).toBe("info")
  })

  it("25h ago → applies, level warn", () => {
    const r = evaluatePromptVersionSuppression(envOn(NOW_SEC - 25 * HOUR_SEC), NOW)
    expect(r.applies).toBe(true)
    expect(r.heartbeatLevel).toBe("warn")
  })

  it("73h ago → fail-safe activated: applies false, reason set-at-stale", () => {
    const r = evaluatePromptVersionSuppression(envOn(NOW_SEC - 73 * HOUR_SEC), NOW)
    expect(r.applies).toBe(false)
    expect(r.reason).toBe("set-at-stale")
  })

  it("exactly 72h ago → still applies (boundary)", () => {
    const r = evaluatePromptVersionSuppression(envOn(NOW_SEC - 72 * HOUR_SEC), NOW)
    expect(r.applies).toBe(true)
    expect(r.heartbeatLevel).toBe("warn")
  })
})

describe("filterReasonsForSuppression — surgical prompt-version drop", () => {
  it("filters prompt-version when suppression applies + leaves other reasons", () => {
    const reasons: StaleReason[] = ["head", "prompt-version", "file-list"]
    const filtered = filterReasonsForSuppression(reasons, true)
    expect(filtered).toEqual(["head", "file-list"])
  })

  it("returns empty array when prompt-version was the ONLY reason", () => {
    const reasons: StaleReason[] = ["prompt-version"]
    const filtered = filterReasonsForSuppression(reasons, true)
    expect(filtered).toEqual([])
  })

  it("returns reasons unchanged when suppression does NOT apply", () => {
    const reasons: StaleReason[] = ["head", "prompt-version"]
    const filtered = filterReasonsForSuppression(reasons, false)
    expect(filtered).toEqual(["head", "prompt-version"])
  })

  it("idempotent: empty input → empty output", () => {
    expect(filterReasonsForSuppression([], true)).toEqual([])
    expect(filterReasonsForSuppression([], false)).toEqual([])
  })

  it("idempotent: array with no prompt-version + suppression on → unchanged", () => {
    const reasons: StaleReason[] = ["head", "base"]
    expect(filterReasonsForSuppression(reasons, true)).toEqual(["head", "base"])
  })
})
