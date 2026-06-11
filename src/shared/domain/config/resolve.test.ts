import { describe, expect, it } from "vitest"
import { RUNNER_TOOL_CATALOG } from "@/src/shared/domain/runner-tool-catalog"
import { resolveLintersConfig } from "@/src/shared/domain/config/resolve"
import type { SigilixConfig } from "@/src/shared/domain/config/types"

describe("resolveLintersConfig", () => {
  it("mirrors the runner tool catalog default profile for every known tool", () => {
    const resolved = resolveLintersConfig(null)

    for (const entry of RUNNER_TOOL_CATALOG) {
      expect(resolved[entry.id]).toEqual({ enabled: entry.defaultEnabled })
    }
  })

  it("lets explicit config override catalog defaults while leaving absent tools on the profile", () => {
    const resolved = resolveLintersConfig({
      linters: {
        checkov: { enabled: true },
        semgrep: { enabled: false },
      },
    } as SigilixConfig)

    expect(resolved.checkov).toEqual({ enabled: true })
    expect(resolved.semgrep).toEqual({ enabled: false })
    expect(resolved.trivy).toEqual({ enabled: false })
    expect(resolved.eslint).toEqual({ enabled: true })
  })
})
