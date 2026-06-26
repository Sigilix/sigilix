import { describe, it, expect } from "vitest"
import { resolveFairnessConfig } from "./config"

function env(mode?: string, cap?: string): { SIGILIX_FAIRNESS_MODE?: string; SIGILIX_TENANT_CONCURRENCY_CAP?: string } {
  const out: { SIGILIX_FAIRNESS_MODE?: string; SIGILIX_TENANT_CONCURRENCY_CAP?: string } = {}
  if (mode !== undefined) out.SIGILIX_FAIRNESS_MODE = mode
  if (cap !== undefined) out.SIGILIX_TENANT_CONCURRENCY_CAP = cap
  return out
}

describe("resolveFairnessConfig — mode", () => {
  it("enforce → mode=enforce", () => {
    expect(resolveFairnessConfig(env("enforce", "2")).mode).toBe("enforce")
  })

  it("shadow → mode=shadow", () => {
    expect(resolveFairnessConfig(env("shadow", "2")).mode).toBe("shadow")
  })

  it("off → mode=off", () => {
    expect(resolveFairnessConfig(env("off", "2")).mode).toBe("off")
  })

  it("unset → mode=off", () => {
    expect(resolveFairnessConfig(env(undefined, "2")).mode).toBe("off")
  })

  it("unknown string → mode=off", () => {
    expect(resolveFairnessConfig(env("on", "2")).mode).toBe("off")
  })
})

describe("resolveFairnessConfig — cap", () => {
  it("valid integer string → that value", () => {
    expect(resolveFairnessConfig(env("off", "5")).cap).toBe(5)
  })

  it("NaN string → 2", () => {
    expect(resolveFairnessConfig(env("off", "abc")).cap).toBe(2)
  })

  it('"0" → 2 (zero is not positive)', () => {
    expect(resolveFairnessConfig(env("off", "0")).cap).toBe(2)
  })

  it("negative string → 2", () => {
    expect(resolveFairnessConfig(env("off", "-1")).cap).toBe(2)
  })

  it("unset → 2", () => {
    expect(resolveFairnessConfig(env("off", undefined)).cap).toBe(2)
  })
})
