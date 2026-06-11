import { describe, expect, it } from "vitest"
import {
  RUNNER_TOOL_CATALOG,
  defaultEnabledForRunnerTool,
  isRunnerToolId,
  rolesForRunnerTool,
} from "@/src/shared/domain/runner-tool-catalog"

describe("runner-tool-catalog", () => {
  it("recognizes only cataloged runner tool ids", () => {
    expect(isRunnerToolId("semgrep")).toBe(true)
    expect(isRunnerToolId("trivy")).toBe(true)
    expect(isRunnerToolId("bandit")).toBe(false)
    expect(isRunnerToolId(undefined)).toBe(false)
  })

  it("uses each catalog entry's default-enabled profile", () => {
    for (const entry of RUNNER_TOOL_CATALOG) {
      expect(defaultEnabledForRunnerTool(entry.id)).toBe(entry.defaultEnabled)
    }
    expect(defaultEnabledForRunnerTool("bandit" as never)).toBe(false)
  })

  it("returns role copies instead of mutable catalog arrays", () => {
    const roles = rolesForRunnerTool("ruff")
    roles.push("tests")

    expect(rolesForRunnerTool("ruff")).toEqual(["logic", "performance"])
    expect(rolesForRunnerTool("bandit" as never)).toEqual([])
  })
})
