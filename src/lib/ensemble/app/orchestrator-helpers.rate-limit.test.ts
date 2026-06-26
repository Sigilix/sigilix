// SIG-455 (PR B Task 5) — SET-ON-429 seam: verify that the orchestrator calls
// setProviderCooldown exactly when cooldownMode !== "off" AND a positive
// providerRateLimitMs was seen. Tests the `applyCooldownFromPhase` helper
// that the orchestrator delegates to so the decision is unit-testable without
// spinning up the full EnsembleHandlerArgs.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

const mockSetProviderCooldown = vi.fn()
vi.mock("@/src/shared/adapters/model/provider-cooldown-client", () => ({
  setProviderCooldown: (...args: unknown[]) => mockSetProviderCooldown(...args),
}))

import { applyCooldownFromPhase } from "./orchestrator-helpers"
import type { Env } from "@/src/shared/types/env"

/** Minimal env stub — only the fields the cooldown helpers read. */
function makeEnv(mode: string | undefined): Pick<Env, "SIGILIX_PROVIDER_COOLDOWN_MODE" | "PROVIDER_COOLDOWN"> {
  return {
    // exactOptionalPropertyTypes: set the field only when defined; never assign undefined explicitly.
    ...(mode !== undefined ? { SIGILIX_PROVIDER_COOLDOWN_MODE: mode } : {}),
    PROVIDER_COOLDOWN: {} as Env["PROVIDER_COOLDOWN"],
  }
}

/** Fake background-runner: collects the pinned promise so tests can await it. */
function makeBackgroundWaitUntil(): { fn: (p: Promise<void>) => void; calls: Promise<void>[] } {
  const calls: Promise<void>[] = []
  return {
    fn: (p: Promise<void>) => {
      calls.push(p)
    },
    calls,
  }
}

describe("applyCooldownFromPhase (SIG-455 Task 5)", () => {
  beforeEach(() => {
    mockSetProviderCooldown.mockReset()
    // setProviderCooldown always returns Promise<void>; default the mock to match.
    mockSetProviderCooldown.mockResolvedValue(undefined)
  })
  afterEach(() => vi.restoreAllMocks())

  it("mode=shadow + positive providerRateLimitMs → setProviderCooldown called with that ms", () => {
    const env = makeEnv("shadow") as unknown as Env
    const bg = makeBackgroundWaitUntil()
    applyCooldownFromPhase(env, 7000, bg.fn)
    expect(mockSetProviderCooldown).toHaveBeenCalledOnce()
    expect(mockSetProviderCooldown).toHaveBeenCalledWith(env, 7000)
    expect(bg.calls).toHaveLength(1)
  })

  it("mode=enforce + positive providerRateLimitMs → setProviderCooldown called", () => {
    const env = makeEnv("enforce") as unknown as Env
    const bg = makeBackgroundWaitUntil()
    applyCooldownFromPhase(env, 9000, bg.fn)
    expect(mockSetProviderCooldown).toHaveBeenCalledOnce()
    expect(mockSetProviderCooldown).toHaveBeenCalledWith(env, 9000)
    expect(bg.calls).toHaveLength(1)
  })

  it("mode=off → setProviderCooldown NOT called even with a positive ms", () => {
    const env = makeEnv("off") as unknown as Env
    const bg = makeBackgroundWaitUntil()
    applyCooldownFromPhase(env, 7000, bg.fn)
    expect(mockSetProviderCooldown).not.toHaveBeenCalled()
    expect(bg.calls).toHaveLength(0)
  })

  it("mode=shadow + providerRateLimitMs undefined → NOT called", () => {
    const env = makeEnv("shadow") as unknown as Env
    const bg = makeBackgroundWaitUntil()
    applyCooldownFromPhase(env, undefined, bg.fn)
    expect(mockSetProviderCooldown).not.toHaveBeenCalled()
    expect(bg.calls).toHaveLength(0)
  })

  it("mode=shadow + providerRateLimitMs === 0 → NOT called", () => {
    const env = makeEnv("shadow") as unknown as Env
    const bg = makeBackgroundWaitUntil()
    applyCooldownFromPhase(env, 0, bg.fn)
    expect(mockSetProviderCooldown).not.toHaveBeenCalled()
    expect(bg.calls).toHaveLength(0)
  })

  it("mode=undefined (default off) → NOT called", () => {
    const env = makeEnv(undefined) as unknown as Env
    const bg = makeBackgroundWaitUntil()
    applyCooldownFromPhase(env, 7000, bg.fn)
    expect(mockSetProviderCooldown).not.toHaveBeenCalled()
    expect(bg.calls).toHaveLength(0)
  })

  it("mode=shadow + positive ms + NO runner → setProviderCooldown still called", () => {
    const env = makeEnv("shadow") as unknown as Env
    applyCooldownFromPhase(env, 5000) // no backgroundWaitUntil
    expect(mockSetProviderCooldown).toHaveBeenCalledOnce()
    expect(mockSetProviderCooldown).toHaveBeenCalledWith(env, 5000)
  })

  it("mode=enforce + positive ms + NO runner → setProviderCooldown still called", () => {
    const env = makeEnv("enforce") as unknown as Env
    applyCooldownFromPhase(env, 8000) // no backgroundWaitUntil
    expect(mockSetProviderCooldown).toHaveBeenCalledOnce()
    expect(mockSetProviderCooldown).toHaveBeenCalledWith(env, 8000)
  })
})
