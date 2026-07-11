import { describe, it, expect } from "vitest"
import { AgentRunnerContainer, AGENT_RUNNER_DENIED_HOSTS } from "@/src/do/agent-runner-container"
import type { Env } from "@/src/shared/types/env"

// Phase-2 gate B — DENYLIST-ONLY egress. A deny-by-default allowlist
// (enableInternet=false + allowedHosts) starves CF container boot (#858 → 500,
// reverted #867), so we keep enableInternet=true and block only the cloud-metadata
// IP via deniedHosts. These tests lock that boot-safe shape so a future change
// can't silently reintroduce the boot-breaking allowlist or drop the metadata block.

describe("AgentRunnerContainer egress policy — constants", () => {
  it("denies the cloud-metadata endpoint (the #1 credential-theft vector)", () => {
    expect(AGENT_RUNNER_DENIED_HOSTS).toContain("169.254.169.254")
  })

  it("is a tight denylist — no wildcards, no allowlist smuggled in", () => {
    expect(AGENT_RUNNER_DENIED_HOSTS).not.toContain("*")
    // Lock the exact set so adding/removing a denied host is a deliberate change.
    expect([...AGENT_RUNNER_DENIED_HOSTS]).toEqual(["169.254.169.254"])
  })
})

/** Minimal ctx so the DO constructs; we only read its egress class fields. */
function makeDO(): AgentRunnerContainer {
  const ctx = {
    storage: {
      async get() {
        return undefined
      },
      async put() {},
      async delete() {
        return false
      },
    },
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
  } as unknown as ConstructorParameters<typeof AgentRunnerContainer>[0]
  return new AgentRunnerContainer(ctx, {} as Env)
}

describe("AgentRunnerContainer egress policy — class wiring", () => {
  it("keeps internet enabled (boot-safe) and blocks the metadata IP via deniedHosts", () => {
    const runner = makeDO()
    // MUST stay true — enableInternet=false starves CF container boot.
    expect(runner.enableInternet).toBe(true)
    // No allowlist — a deny-by-default allowlist also starves boot.
    expect(runner.allowedHosts).toBeUndefined()
    // The metadata IP is blocked unconditionally.
    expect(runner.deniedHosts).toContain("169.254.169.254")
  })
})
