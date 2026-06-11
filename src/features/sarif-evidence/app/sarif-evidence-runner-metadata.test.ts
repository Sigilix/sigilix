import { describe, expect, it } from "vitest"
import { runSarifEvidence, type ResolvedSarifConfig } from "@/src/features/sarif-evidence/app/runner"
import type { GitHubClient } from "@/src/shared/adapters/github"
import type { Env } from "@/src/shared/types/env"

const CTX = { owner: "o", repo: "r", prNumber: 1, headSha: "h".repeat(40) }
const PATH = ".sigilix/trivy.sarif.json"

const DEFAULT_CONFIG: ResolvedSarifConfig = {
  enabled: true,
  path: PATH,
  severityThreshold: "warning",
  disabledRules: [],
  disabledCategories: [],
}

const runnerMetadata = (toolId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  sigilixSchemaVersion: 1,
  sigilixToolId: toolId,
  sigilixSource: "deterministic-tool",
  ...extra,
})

const makeReport = (results: object[], extras: object = {}): string =>
  JSON.stringify({
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "Trivy" } },
        results,
        ...extras,
      },
    ],
  })

const diffWithChange = (path: string, line: number): string =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${line},0 +${line},1 @@\n+const x = 1\n`

const diffWithChanges = (entries: Array<{ path: string; line: number }>): string =>
  entries.map(({ path, line }) => diffWithChange(path, line)).join("\n")

const fakeClient = (raw: string | null): GitHubClient =>
  ({ getFileContent: async () => raw }) as unknown as GitHubClient

const fakeEnv = {} as unknown as Env

describe("runSarifEvidence — runner metadata", () => {
  it("preserves valid ESLint runner metadata through the real SARIF path", async () => {
    const report = makeReport(
      [
        {
          ruleId: "no-undef",
          level: "error",
          message: { text: "missing symbol" },
          locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 1 } } }],
        },
      ],
      { tool: { driver: { name: "ESLint", properties: runnerMetadata("eslint") } } },
    )
    const r = await runSarifEvidence({
      env: fakeEnv,
      client: fakeClient(report),
      ...CTX,
      diff: diffWithChange("src/a.ts", 1),
      config: DEFAULT_CONFIG,
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    expect(r.findings[0]!.roleHint).toBe("logic")
    expect(r.findings[0]!.roleHints).toEqual(["logic"])
    expect(r.findings[0]!.toolId).toBe("eslint")
    expect(r.findings[0]!.source).toBe("deterministic-tool")
  })

  it("preserves valid Ruff multi-role metadata with logic as the primary role", async () => {
    const report = makeReport(
      [
        {
          ruleId: "PERF401",
          level: "warning",
          message: { text: "prefer list comprehension" },
          locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.py" }, region: { startLine: 3 } } }],
        },
      ],
      { tool: { driver: { name: "Ruff", properties: runnerMetadata("ruff") } } },
    )
    const r = await runSarifEvidence({
      env: fakeEnv,
      client: fakeClient(report),
      ...CTX,
      diff: diffWithChange("src/a.py", 3),
      config: DEFAULT_CONFIG,
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    expect(r.findings[0]!.roleHint).toBe("logic")
    expect(r.findings[0]!.roleHints).toEqual(["logic", "performance"])
  })

  it("falls back to legacy taxonomy and records a schema warning for unknown metadata schema", async () => {
    const report = makeReport(
      [
        {
          ruleId: "CVE-2024-1234",
          level: "error",
          message: { text: "vulnerable dependency" },
          locations: [{ physicalLocation: { artifactLocation: { uri: "package.json" }, region: { startLine: 1 } } }],
        },
      ],
      {
        tool: {
          driver: {
            name: "ESLint",
            properties: runnerMetadata("eslint", { sigilixSchemaVersion: 2 }),
          },
        },
      },
    )
    const r = await runSarifEvidence({
      env: fakeEnv,
      client: fakeClient(report),
      ...CTX,
      diff: diffWithChange("package.json", 1),
      config: DEFAULT_CONFIG,
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    expect(r.findings[0]!.roleHint).toBe("security")
    expect(r.findings[0]!.category).toBe("vulnerability")
    expect(r.findings[0]!.schemaWarning).toBe("unknown-schema-version")
  })

  it("captures valid dropped-result metadata for later rendering", async () => {
    const report = makeReport(
      [
        {
          ruleId: "no-alert",
          level: "warning",
          message: { text: "unexpected alert" },
          locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 2 } } }],
        },
      ],
      {
        tool: {
          driver: {
            name: "ESLint",
            properties: runnerMetadata("eslint", { sigilixDroppedResults: { droppedCount: 4, keptCount: 1 } }),
          },
        },
      },
    )
    const r = await runSarifEvidence({
      env: fakeEnv,
      client: fakeClient(report),
      ...CTX,
      diff: diffWithChange("src/a.ts", 2),
      config: DEFAULT_CONFIG,
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    expect(r.findings[0]!.droppedResults).toEqual({
      toolId: "eslint",
      droppedCount: 4,
      keptCount: 1,
    })
  })

  it("ignores dropped-result metadata when keptCount does not match the run result count", async () => {
    const report = makeReport(
      [
        {
          ruleId: "no-alert",
          level: "warning",
          message: { text: "unexpected alert" },
          locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 2 } } }],
        },
      ],
      {
        tool: {
          driver: {
            name: "ESLint",
            properties: runnerMetadata("eslint", { sigilixDroppedResults: { droppedCount: 4, keptCount: 9 } }),
          },
        },
      },
    )
    const r = await runSarifEvidence({
      env: fakeEnv,
      client: fakeClient(report),
      ...CTX,
      diff: diffWithChange("src/a.ts", 2),
      config: DEFAULT_CONFIG,
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    expect(r.findings[0]!.droppedResults).toBeUndefined()
  })

  it("preserves large dropped-result counts on the emitted finding", async () => {
    const report = makeReport(
      [
        {
          ruleId: "no-alert",
          level: "warning",
          message: { text: "unexpected alert" },
          locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 2 } } }],
        },
      ],
      {
        tool: {
          driver: {
            name: "ESLint",
            properties: runnerMetadata("eslint", { sigilixDroppedResults: { droppedCount: 1001, keptCount: 1 } }),
          },
        },
      },
    )
    const r = await runSarifEvidence({
      env: fakeEnv,
      client: fakeClient(report),
      ...CTX,
      diff: diffWithChange("src/a.ts", 2),
      config: DEFAULT_CONFIG,
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    expect(r.findings[0]!.droppedResults).toEqual({
      toolId: "eslint",
      droppedCount: 1001,
      keptCount: 1,
    })
  })

  it("attaches dropped-result metadata only once per run", async () => {
    const report = makeReport(
      [
        {
          ruleId: "no-alert",
          level: "warning",
          message: { text: "unexpected alert" },
          locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 2 } } }],
        },
        {
          ruleId: "no-debugger",
          level: "warning",
          message: { text: "unexpected debugger" },
          locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 2 } } }],
        },
      ],
      {
        tool: {
          driver: {
            name: "ESLint",
            properties: runnerMetadata("eslint", { sigilixDroppedResults: { droppedCount: 4, keptCount: 2 } }),
          },
        },
      },
    )
    const r = await runSarifEvidence({
      env: fakeEnv,
      client: fakeClient(report),
      ...CTX,
      diff: diffWithChange("src/a.ts", 2),
      config: DEFAULT_CONFIG,
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    expect(r.findings.map((f) => f.droppedResults).filter(Boolean)).toHaveLength(1)
  })

  it("accepts runner first-slice tool metadata without runner-supplied role hints", async () => {
    const runs = [
      {
        toolId: "semgrep",
        toolName: "Semgrep",
        path: "src/security.ts",
        line: 1,
        ruleId: "typescript.express.security",
      },
      { toolId: "eslint", toolName: "ESLint", path: "src/app.js", line: 2, ruleId: "no-undef" },
      { toolId: "ruff", toolName: "Ruff", path: "src/app.py", line: 3, ruleId: "PERF401" },
      {
        toolId: "actionlint",
        toolName: "actionlint",
        path: ".github/workflows/ci.yml",
        line: 4,
        ruleId: "syntax-check",
      },
      { toolId: "shellcheck", toolName: "ShellCheck", path: "scripts/build.sh", line: 5, ruleId: "SC2086" },
      { toolId: "gitleaks", toolName: "gitleaks", path: "src/secrets.ts", line: 6, ruleId: "gitleaks:generic" },
      { toolId: "osv-scanner", toolName: "OSV-Scanner", path: "package-lock.json", line: 7, ruleId: "GHSA-xxxx" },
      { toolId: "checkov", toolName: "Checkov", path: "main.tf", line: 8, ruleId: "CKV_AWS_1" },
    ].map(({ toolId, toolName, path, line, ruleId }) => ({
      tool: { driver: { name: toolName, properties: runnerMetadata(toolId) } },
      results: [
        {
          ruleId,
          level: "warning",
          message: { text: `${toolId} finding` },
          locations: [{ physicalLocation: { artifactLocation: { uri: path }, region: { startLine: line } } }],
        },
      ],
    }))
    const report = JSON.stringify({ version: "2.1.0", runs })
    const r = await runSarifEvidence({
      env: fakeEnv,
      client: fakeClient(report),
      ...CTX,
      diff: diffWithChanges([
        { path: "src/security.ts", line: 1 },
        { path: "src/app.js", line: 2 },
        { path: "src/app.py", line: 3 },
        { path: ".github/workflows/ci.yml", line: 4 },
        { path: "scripts/build.sh", line: 5 },
        { path: "src/secrets.ts", line: 6 },
        { path: "package-lock.json", line: 7 },
        { path: "main.tf", line: 8 },
      ]),
      config: DEFAULT_CONFIG,
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    const byTool = new Map(r.findings.map((f) => [f.toolId, f]))
    expect(byTool.get("semgrep")?.roleHints).toEqual(["security"])
    expect(byTool.get("eslint")?.roleHints).toEqual(["logic"])
    expect(byTool.get("ruff")?.roleHints).toEqual(["logic", "performance"])
    expect(byTool.get("actionlint")?.roleHints).toEqual(["logic", "security"])
    expect(byTool.get("shellcheck")?.roleHints).toEqual(["security", "logic"])
    expect(byTool.get("gitleaks")?.roleHints).toEqual(["security"])
    expect(byTool.get("osv-scanner")?.roleHints).toEqual(["security"])
    expect(byTool.get("checkov")?.roleHints).toEqual(["security"])
    for (const toolId of [
      "semgrep",
      "eslint",
      "ruff",
      "actionlint",
      "shellcheck",
      "gitleaks",
      "osv-scanner",
      "checkov",
    ]) {
      expect(byTool.get(toolId)?.source).toBe("deterministic-tool")
    }
  })
})
