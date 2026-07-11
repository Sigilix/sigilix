// SIG-545 B1: agent-runner mode parser tests.

import { describe, expect, it } from "vitest"
import {
  resolveAgentRunnerMode,
  resolveAgentRunnerEngine,
  resolvePortalEngine,
  resolveLinearAgentRunMode,
} from "@/src/lib/agent-runner/mode"
import type { Env } from "@/src/shared/types/env"

const env = (v: string | undefined): Pick<Env, "OPENCLAW_AGENT_RUNNER_MODE"> =>
  ({ OPENCLAW_AGENT_RUNNER_MODE: v }) as unknown as Pick<Env, "OPENCLAW_AGENT_RUNNER_MODE">

const portalEngineEnv = (v: string | undefined): Pick<Env, "OPENCLAW_PORTAL_FULL_ENGINE_MODE"> =>
  ({ OPENCLAW_PORTAL_FULL_ENGINE_MODE: v }) as unknown as Pick<Env, "OPENCLAW_PORTAL_FULL_ENGINE_MODE">

const engineEnv = (v: string | undefined): Pick<Env, "OPENCLAW_AGENT_RUNNER_ENGINE"> =>
  ({ OPENCLAW_AGENT_RUNNER_ENGINE: v }) as unknown as Pick<Env, "OPENCLAW_AGENT_RUNNER_ENGINE">

const linearEnv = (v: string | undefined): Pick<Env, "OPENCLAW_LINEAR_AGENT_RUN_MODE"> =>
  ({ OPENCLAW_LINEAR_AGENT_RUN_MODE: v }) as unknown as Pick<Env, "OPENCLAW_LINEAR_AGENT_RUN_MODE">

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

describe("resolveAgentRunnerEngine", () => {
  it('returns "full" only for the exact string "full"', () => {
    expect(resolveAgentRunnerEngine(engineEnv("full"))).toBe("full")
  })

  it('defaults to "minimal" when unset', () => {
    expect(resolveAgentRunnerEngine(engineEnv(undefined))).toBe("minimal")
  })

  it('returns "minimal" for uppercase "FULL" (case-sensitive, fail-closed)', () => {
    expect(resolveAgentRunnerEngine(engineEnv("FULL"))).toBe("minimal")
  })

  it('returns "minimal" for arbitrary garbage values', () => {
    expect(resolveAgentRunnerEngine(engineEnv("cli"))).toBe("minimal")
    expect(resolveAgentRunnerEngine(engineEnv(""))).toBe("minimal")
    expect(resolveAgentRunnerEngine(engineEnv("minimal"))).toBe("minimal")
  })
})

describe("resolvePortalEngine", () => {
  it('returns "full" only for the exact string "on"', () => {
    expect(resolvePortalEngine(portalEngineEnv("on"))).toBe("full")
  })

  it('defaults to "minimal" when unset (the safe default — full engine stays gated)', () => {
    expect(resolvePortalEngine(portalEngineEnv(undefined))).toBe("minimal")
  })

  it('returns "minimal" for uppercase "ON" and garbage (case-sensitive, fail-closed)', () => {
    expect(resolvePortalEngine(portalEngineEnv("ON"))).toBe("minimal")
    expect(resolvePortalEngine(portalEngineEnv("full"))).toBe("minimal")
    expect(resolvePortalEngine(portalEngineEnv("true"))).toBe("minimal")
    expect(resolvePortalEngine(portalEngineEnv(""))).toBe("minimal")
  })
})

describe("resolveLinearAgentRunMode", () => {
  it('returns "on" only for the exact string "on"', () => {
    expect(resolveLinearAgentRunMode(linearEnv("on"))).toBe("on")
  })

  it('returns "off" when the var is unset', () => {
    expect(resolveLinearAgentRunMode(linearEnv(undefined))).toBe("off")
  })

  it('returns "off" for uppercase "ON" (case-sensitive, fail-closed)', () => {
    expect(resolveLinearAgentRunMode(linearEnv("ON"))).toBe("off")
  })

  it('returns "off" for arbitrary garbage values', () => {
    expect(resolveLinearAgentRunMode(linearEnv("enabled"))).toBe("off")
    expect(resolveLinearAgentRunMode(linearEnv("true"))).toBe("off")
    expect(resolveLinearAgentRunMode(linearEnv(""))).toBe("off")
    expect(resolveLinearAgentRunMode(linearEnv("off"))).toBe("off")
  })
})
