import { describe, expect, it } from "vitest"
import { RUNNER_TOOL_CATALOG } from "@/src/shared/domain/runner-tool-catalog"
import { resolveLintersConfig, resolveDisabledLinterIds } from "@/src/shared/domain/config/resolve"
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

describe("resolveDisabledLinterIds (SIG-107 — the SARIF drop seam)", () => {
  it("returns [] when no linters config is present (nothing dropped)", () => {
    expect(resolveDisabledLinterIds(null)).toEqual([])
    expect(resolveDisabledLinterIds({} as SigilixConfig)).toEqual([])
  })

  it("returns ONLY explicitly-disabled ids", () => {
    const disabled = resolveDisabledLinterIds({
      linters: { eslint: { enabled: false }, ruff: { enabled: true } },
    } as SigilixConfig)
    expect(disabled).toEqual(["eslint"])
  })

  it("does NOT return a catalog default-OFF tool unless the repo explicitly disables it (recall-safe)", () => {
    // `trivy`/`checkov`/`trufflehog` are default-OFF in the catalog; absent an
    // explicit `enabled: false` they must NOT be dropped — dropping a tool the
    // customer never opted out of would silently hide (often security) findings.
    const defaultOff = ["trivy", "checkov", "trufflehog"]
    for (const id of defaultOff) {
      expect(resolveLintersConfig(null)[id as keyof ReturnType<typeof resolveLintersConfig>]).toEqual({
        enabled: false,
      })
    }
    expect(resolveDisabledLinterIds(null)).toEqual([])
    // …but an explicit opt-out IS honored.
    expect(resolveDisabledLinterIds({ linters: { trivy: { enabled: false } } } as SigilixConfig)).toEqual(["trivy"])
  })
})
