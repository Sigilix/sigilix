// SIG-545 B1: agent-runner mode parser tests.

import { describe, expect, it } from "vitest"
import { resolveAgentRunnerMode } from "@/src/lib/agent-runner/mode"
import type { Env } from "@/src/shared/types/env"

const env = (v: string | undefined): Pick<Env, "OPENCLAW_AGENT_RUNNER_MODE"> =>
  ({ OPENCLAW_AGENT_RUNNER_MODE: v }) as unknown as Pick<Env, "OPENCLAW_AGENT_RUNNER_MODE">

describe("resolveAgentRunnerMode", () => {
  it('returns "on" only for the exact string "on"', () => {
    expect(resolveAgentRunnerMode(env("on"))).toBe("on")
  })

  it('returns "off" when the var is unset', () => {
    expect(resolveAgentRunnerMode(env(undefined))).toBe("off")
  })

  it('returns "off" for uppercase "ON" (case-sensitive, fail-closed)', () => {
    expect(resolveAgentRunnerMode(env("ON"))).toBe("off")
  })

  it('returns "off" for arbitrary garbage values', () => {
    expect(resolveAgentRunnerMode(env("enabled"))).toBe("off")
    expect(resolveAgentRunnerMode(env("true"))).toBe("off")
    expect(resolveAgentRunnerMode(env(""))).toBe("off")
    expect(resolveAgentRunnerMode(env("off"))).toBe("off")
  })
})
