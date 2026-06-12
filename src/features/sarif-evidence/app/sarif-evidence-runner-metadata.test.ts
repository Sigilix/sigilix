import { describe, expect, it } from "vitest"
import { runSarifEvidence, type ResolvedSarifConfig } from "@/src/features/sarif-evidence/app/runner"
import { RUNNER_TOOL_CATALOG } from "@/src/shared/domain/runner-tool-catalog"
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

  it("preserves OpenGrep and Brakeman metadata through the real SARIF path", async () => {
    const toolRuns = [
      { toolId: "opengrep", toolName: "OpenGrep", path: "src/app.ts", line: 4, ruleId: "javascript.lang.security" },
      { toolId: "brakeman", toolName: "Brakeman", path: "app/models/user.rb", line: 9, ruleId: "SQL Injection" },
    ]
    const metadataByTool = new Map(toolRuns.map(({ toolId }) => [toolId, runnerMetadata(toolId)]))
    for (const { toolId } of toolRuns) {
      expect(metadataByTool.get(toolId)).toMatchObject({
        sigilixSchemaVersion: 1,
        sigilixToolId: toolId,
        sigilixSource: "deterministic-tool",
      })
    }
    const report = JSON.stringify({
      version: "2.1.0",
      runs: toolRuns.map(({ toolId, toolName, path, line, ruleId }) => ({
        tool: { driver: { name: toolName, properties: metadataByTool.get(toolId) } },
        results: [
          {
            ruleId,
            level: "warning",
            message: { text: `${toolId} finding` },
            locations: [{ physicalLocation: { artifactLocation: { uri: path }, region: { startLine: line } } }],
          },
        ],
      })),
    })
    const r = await runSarifEvidence({
      env: fakeEnv,
      client: fakeClient(report),
      ...CTX,
      diff: diffWithChanges(toolRuns.map(({ path, line }) => ({ path, line }))),
      config: DEFAULT_CONFIG,
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    const byTool = new Map(r.findings.map((f) => [f.toolId, f]))
    for (const { toolId } of toolRuns) {
      const finding = byTool.get(toolId)
      expect(finding?.toolId).toBe(toolId)
      expect(finding?.roleHint).toBe("security")
      expect(finding?.roleHints).toEqual(["security"])
      expect(finding?.source).toBe("deterministic-tool")
    }
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

  it("accepts current runner tool metadata without runner-supplied role hints", async () => {
    const toolRuns = RUNNER_TOOL_CATALOG.map((entry, index) => ({
      toolId: entry.id,
      toolName: entry.displayName,
      path: `src/${entry.id}.txt`,
      line: index + 1,
      ruleId: `${entry.id}/rule`,
      roleHints: entry.roles,
    }))
    const runs = toolRuns.map(({ toolId, toolName, path, line, ruleId }) => ({
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
      diff: diffWithChanges(toolRuns.map(({ path, line }) => ({ path, line }))),
      config: DEFAULT_CONFIG,
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    const byTool = new Map(r.findings.map((f) => [f.toolId, f]))
    for (const { toolId, roleHints } of toolRuns) {
      expect(byTool.get(toolId)?.roleHints).toEqual(roleHints)
      expect(byTool.get(toolId)?.source).toBe("deterministic-tool")
    }
  })

  it("keeps safe uncataloged runner metadata on the legacy taxonomy path", async () => {
    const report = makeReport(
      [
        {
          ruleId: "future-rule",
          level: "warning",
          message: { text: "future tool finding" },
          locations: [{ physicalLocation: { artifactLocation: { uri: "src/future.txt" }, region: { startLine: 9 } } }],
        },
      ],
      { tool: { driver: { name: "FutureLint", properties: runnerMetadata("future-lint") } } },
    )
    const r = await runSarifEvidence({
      env: fakeEnv,
      client: fakeClient(report),
      ...CTX,
      diff: diffWithChange("src/future.txt", 9),
      config: DEFAULT_CONFIG,
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    expect(r.findings[0]!.toolId).toBeUndefined()
    expect(r.findings[0]!.source).toBeUndefined()
    expect(r.findings[0]!.roleHint).toBe("security")
    expect(r.findings[0]!.roleHints).toBeUndefined()
  })
})
