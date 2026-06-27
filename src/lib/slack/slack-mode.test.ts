// SIG-196: unit tests for resolveSlackMode — tri-state parser, fail-closed.

import { describe, expect, it } from "vitest"
import { resolveSlackMode } from "@/src/lib/slack/slack-mode"
import type { Env } from "@/src/shared/types/env"

function makeEnv(mode?: string): Pick<Env, "SIGILIX_SLACK_MODE"> {
  return mode !== undefined ? { SIGILIX_SLACK_MODE: mode } : {}
}

describe("resolveSlackMode", () => {
  it("returns 'off' when SIGILIX_SLACK_MODE is unset", () => {
    expect(resolveSlackMode(makeEnv(undefined))).toBe("off")
  })

  it("returns 'off' for the literal string 'off'", () => {
    expect(resolveSlackMode(makeEnv("off"))).toBe("off")
  })

  it("returns 'shadow' for the literal string 'shadow'", () => {
    expect(resolveSlackMode(makeEnv("shadow"))).toBe("shadow")
  })

  it("returns 'on' for the literal string 'on'", () => {
    expect(resolveSlackMode(makeEnv("on"))).toBe("on")
  })

  it("returns 'off' for 'ON' (wrong case — fail-closed)", () => {
    expect(resolveSlackMode(makeEnv("ON"))).toBe("off")
  })

  it("returns 'off' for 'enforce' (unknown value — fail-closed)", () => {
    expect(resolveSlackMode(makeEnv("enforce"))).toBe("off")
  })

  it("returns 'off' for ' on ' (leading/trailing whitespace — fail-closed)", () => {
    expect(resolveSlackMode(makeEnv(" on "))).toBe("off")
  })
})
