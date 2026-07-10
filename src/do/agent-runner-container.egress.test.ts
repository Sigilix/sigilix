import { describe, it, expect } from "vitest"
import {
  AgentRunnerContainer,
  AGENT_RUNNER_ALLOWED_HOSTS,
  AGENT_RUNNER_DENIED_HOSTS,
} from "@/src/do/agent-runner-container"
import type { Env } from "@/src/shared/types/env"

// Phase-2 gate B: the container's egress allowlist is security-relevant and also
// governs the LIVE minimal make-PR runner. These tests lock the invariants so an
// accidental edit (dropping a required host, or allowing something dangerous)
// fails CI rather than silently breaking live PRs or widening the attack surface.

const EXPECTED_ALLOWED = [
  "*.githubusercontent.com",
  "api.github.com",
  "api.sigilix.ai",
  "github.com",
  "ollama.com",
  "openrouter.ai",
  "registry.npmjs.org",
]

describe("AgentRunnerContainer egress policy — constants", () => {
  it("allows exactly the hosts a run needs — git, model, grounding/events, provider fetch", () => {
    // Every host the minimal (live) + full engines genuinely reach.
    for (const host of ["github.com", "api.github.com", "openrouter.ai", "ollama.com", "api.sigilix.ai"]) {
      expect(AGENT_RUNNER_ALLOWED_HOSTS).toContain(host)
    }
  })

  it("is a tight allowlist — no wildcard-everything, no unexpected hosts", () => {
    // Never a blanket "*" (that would defeat deny-by-default).
    expect(AGENT_RUNNER_ALLOWED_HOSTS).not.toContain("*")
    // Lock the exact set so adding a new egress host is a deliberate, reviewed change.
    expect([...AGENT_RUNNER_ALLOWED_HOSTS].sort()).toEqual([...EXPECTED_ALLOWED].sort())
  })

  it("denies the cloud-metadata endpoint and never allows it", () => {
    expect(AGENT_RUNNER_DENIED_HOSTS).toContain("169.254.169.254")
    expect(AGENT_RUNNER_ALLOWED_HOSTS).not.toContain("169.254.169.254")
  })
})

// The constants above are only a boundary if the DO actually applies them. These
// assert the class WIRING — a refactor that flips enableInternet back to true, or
// drops the override, must fail here (the constant tests alone would still pass).
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
  it("applies deny-by-default egress on the container instance", () => {
    const runner = makeDO()
    // enableInternet MUST be false — a revert to true silently reopens egress.
    expect(runner.enableInternet).toBe(false)
    // The instance must use the reviewed allowlist / denylist, not some other set.
    expect([...(runner.allowedHosts ?? [])].sort()).toEqual([...EXPECTED_ALLOWED].sort())
    expect(runner.deniedHosts).toContain("169.254.169.254")
  })
})
