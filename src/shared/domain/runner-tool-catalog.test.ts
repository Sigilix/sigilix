import { describe, expect, it } from "vitest"
import {
  RUNNER_TOOL_CATALOG,
  RUNNER_TOOL_IDS,
  defaultEnabledForRunnerTool,
  isRunnerToolId,
  isSafeRunnerToolId,
  rolesForRunnerTool,
} from "@/src/shared/domain/runner-tool-catalog"

describe("runner-tool-catalog", () => {
  const expectedCatalog = [
    ["semgrep", true, ["security"]],
    ["opengrep", true, ["security"]],
    ["eslint", true, ["logic"]],
    ["tsc", true, ["logic"]],
    ["ruff", true, ["logic", "performance"]],
    ["brakeman", true, ["security"]],
    ["pylint", true, ["logic"]],
    ["flake8", true, ["logic"]],
    ["knip", true, ["logic"]],
    ["golangci-lint", true, ["logic"]],
    ["buf", true, ["logic"]],
    ["sqlfluff", true, ["logic"]],
    ["prisma-lint", true, ["logic"]],
    ["rubocop", true, ["logic"]],
    ["phpstan", true, ["logic"]],
    ["phpmd", true, ["logic"]],
    ["phpcs", true, ["logic"]],
    ["clippy", true, ["logic"]],
    ["detekt", true, ["logic"]],
    ["swiftlint", true, ["logic"]],
    ["actionlint", true, ["logic", "security"]],
    ["shellcheck", true, ["security", "logic"]],
    ["gitleaks", true, ["security"]],
    ["osv-scanner", true, ["security"]],
    ["checkov", false, ["security"]],
    ["trivy", false, ["security"]],
    ["trufflehog", false, ["security"]],
    ["zizmor", true, ["security", "logic"]],
    ["hadolint", true, ["logic", "security"]],
    ["tflint", true, ["logic", "security"]],
    ["biome", true, ["logic"]],
    ["oxlint", true, ["logic"]],
    ["ast-grep", true, ["logic"]],
    ["regal", true, ["security", "logic"]],
    ["htmlhint", true, ["logic"]],
    ["stylelint", true, ["logic"]],
    ["yamllint", true, ["logic"]],
    ["markdownlint", true, ["logic"]],
    ["dotenv-linter", true, ["security", "logic"]],
    ["checkmake", true, ["logic"]],
  ] as const

  it("mirrors the current runner tool ids, defaults, and role routing", () => {
    expect(RUNNER_TOOL_CATALOG).toHaveLength(40)
    expect(RUNNER_TOOL_CATALOG.map(({ id, defaultEnabled, roles }) => [id, defaultEnabled, roles])).toEqual(
      expectedCatalog,
    )
    expect(RUNNER_TOOL_IDS).toEqual(expectedCatalog.map(([id]) => id))
  })

  it("recognizes only cataloged runner tool ids", () => {
    expect(isRunnerToolId("semgrep")).toBe(true)
    expect(isRunnerToolId("opengrep")).toBe(true)
    expect(isRunnerToolId("tsc")).toBe(true)
    expect(isRunnerToolId("brakeman")).toBe(true)
    expect(isRunnerToolId("buf")).toBe(true)
    expect(isRunnerToolId("phpstan")).toBe(true)
    expect(isRunnerToolId("swiftlint")).toBe(true)
    expect(isRunnerToolId("biome")).toBe(true)
    expect(isRunnerToolId("checkmake")).toBe(true)
    expect(isRunnerToolId("trivy")).toBe(true)
    expect(isRunnerToolId("bandit")).toBe(false)
    expect(isRunnerToolId(undefined)).toBe(false)
  })

  it("recognizes safe future runner ids without adding them to the catalog", () => {
    expect(isSafeRunnerToolId("future-lint")).toBe(true)
    expect(isSafeRunnerToolId("tool-42")).toBe(true)
    expect(isSafeRunnerToolId("abc")).toBe(true)
    expect(isSafeRunnerToolId("ab")).toBe(false)
    expect(isSafeRunnerToolId("a".repeat(64))).toBe(true)
    expect(isSafeRunnerToolId("a".repeat(65))).toBe(false)
    expect(isSafeRunnerToolId("FutureLint")).toBe(false)
    expect(isSafeRunnerToolId("bad/tool")).toBe(false)
    expect(isSafeRunnerToolId("-tool")).toBe(false)
    expect(isSafeRunnerToolId("tool-")).toBe(false)
    expect(isSafeRunnerToolId("tool--lint")).toBe(false)
    expect(isSafeRunnerToolId("-")).toBe(false)
    expect(isSafeRunnerToolId("")).toBe(false)
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
