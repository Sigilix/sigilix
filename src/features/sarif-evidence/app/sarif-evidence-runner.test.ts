// ARC-188 — runSarifEvidence orchestrator tests.
//
// Codex MAJOR #3 + Kimi MAJOR #1: config-driven filter coverage.
// Codex MINOR #5/7 + Kimi MAJOR #3: caps + stale boundary tests.
// Kimi MINOR #4: SARIF level mapping.

import { describe, it, expect } from "vitest"
import { runSarifEvidence, type ResolvedSarifConfig } from "@/features/sarif-evidence/app/runner"
import type { GitHubClient } from "@/shared/adapters/github"
import type { Env } from "@/shared/types/env"

const CTX = { owner: "o", repo: "r", prNumber: 1, headSha: "h".repeat(40) }
const PATH = ".sigilix/trivy.sarif.json"

const DEFAULT_CONFIG: ResolvedSarifConfig = {
  enabled: true,
  path: PATH,
  severityThreshold: "warning",
  disabledRules: [],
  disabledCategories: [],
}

const makeReport = (results: object[], extras: object = {}): string => JSON.stringify({
  version: "2.1.0",
  runs: [{
    tool: { driver: { name: "Trivy" } },
    results,
    ...extras,
  }],
})

const diffWithChange = (path: string, line: number): string =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${line},0 +${line},1 @@\n+const x = 1\n`

const fakeClient = (raw: string | null): GitHubClient =>
  ({ getFileContent: async () => raw } as unknown as GitHubClient)

const fakeEnv = {} as unknown as Env

describe("runSarifEvidence — skip paths", () => {
  it("disabled-config", async () => {
    const r = await runSarifEvidence({
      env: fakeEnv, client: fakeClient(null), ...CTX, diff: "",
      config: { ...DEFAULT_CONFIG, enabled: false },
    })
    expect(r.skipped).toBe(true)
    if (r.skipped) expect(r.reason).toBe("disabled-config")
  })

  it("no-report (404)", async () => {
    const r = await runSarifEvidence({
      env: fakeEnv, client: fakeClient(null), ...CTX, diff: "",
      config: DEFAULT_CONFIG,
    })
    expect(r.skipped).toBe(true)
    if (r.skipped) expect(r.reason).toBe("no-report")
  })

  it("report-too-large at 8 MB + 1 byte", async () => {
    const big = "x".repeat(8 * 1024 * 1024 + 1)
    const r = await runSarifEvidence({
      env: fakeEnv, client: fakeClient(big), ...CTX, diff: "",
      config: DEFAULT_CONFIG,
    })
    expect(r.skipped).toBe(true)
    if (r.skipped) expect(r.reason).toBe("report-too-large")
  })

  it("parse-failed on malformed JSON", async () => {
    const r = await runSarifEvidence({
      env: fakeEnv, client: fakeClient("not json"), ...CTX, diff: "",
      config: DEFAULT_CONFIG,
    })
    expect(r.skipped).toBe(true)
    if (r.skipped) expect(r.reason).toBe("parse-failed")
  })

  it("unsupported-sarif-version", async () => {
    const bad = JSON.stringify({ version: "2.0.0", runs: [] })
    const r = await runSarifEvidence({
      env: fakeEnv, client: fakeClient(bad), ...CTX, diff: "",
      config: DEFAULT_CONFIG,
    })
    expect(r.skipped).toBe(true)
    if (r.skipped) expect(r.reason).toBe("unsupported-sarif-version")
  })
})

describe("runSarifEvidence — finding emission", () => {
  it("happy path: 1 IaC finding emitted", async () => {
    const report = makeReport([{
      ruleId: "AVD-KSV-0017",
      level: "error",
      message: { text: "Privileged container" },
      locations: [{ physicalLocation: { artifactLocation: { uri: "k8s/dep.yaml" }, region: { startLine: 10 } } }],
    }])
    const r = await runSarifEvidence({
      env: fakeEnv, client: fakeClient(report), ...CTX,
      diff: diffWithChange("k8s/dep.yaml", 10),
      config: DEFAULT_CONFIG,
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    expect(r.findings.length).toBe(1)
    expect(r.findings[0].category).toBe("iac")
    expect(r.findings[0].roleHint).toBe("security")
    expect(r.findings[0].severity).toBe("error")
    expect(r.findings[0].toolName).toBe("Trivy")
  })

  it("path-only fallback for line-less IaC findings", async () => {
    const report = makeReport([{
      ruleId: "AVD-KSV-0017",
      level: "error",
      message: { text: "x" },
      locations: [{ physicalLocation: { artifactLocation: { uri: "k8s/dep.yaml" } } }],
    }])
    const r = await runSarifEvidence({
      env: fakeEnv, client: fakeClient(report), ...CTX,
      diff: diffWithChange("k8s/dep.yaml", 5),
      config: DEFAULT_CONFIG,
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    expect(r.findings.length).toBe(1)
    expect(r.findings[0].line).toBeUndefined()
  })

  it("drops findings whose path is unchanged", async () => {
    const report = makeReport([{
      level: "error", message: { text: "x" },
      locations: [{ physicalLocation: { artifactLocation: { uri: "src/other.ts" } } }],
    }])
    const r = await runSarifEvidence({
      env: fakeEnv, client: fakeClient(report), ...CTX,
      diff: diffWithChange("src/touched.ts", 1),
      config: DEFAULT_CONFIG,
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    expect(r.findings.length).toBe(0)
  })

  it("drops findings with absolute paths via path normalizer", async () => {
    const report = makeReport([{
      level: "error", message: { text: "x" },
      locations: [{ physicalLocation: { artifactLocation: { uri: "/etc/passwd" } } }],
    }])
    const r = await runSarifEvidence({
      env: fakeEnv, client: fakeClient(report), ...CTX,
      diff: "", config: DEFAULT_CONFIG,
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    expect(r.findings.length).toBe(0)
    expect(r.telemetry.filteredOutByPath).toBe(1)
  })
})

describe("runSarifEvidence — config-driven filtering (Codex MAJOR #3 + Kimi MAJOR #1)", () => {
  const baseReport = (extras: object = {}) => makeReport([
    {
      ruleId: "RULE-A",
      level: "error",
      message: { text: "vuln-A" },
      locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 1 } } }],
      ...extras,
    },
    {
      ruleId: "RULE-B",
      level: "note",
      message: { text: "info-B" },
      locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 1 } } }],
    },
  ])
  const diff = diffWithChange("src/a.ts", 1)

  it("disabledRules filters specific rule_id", async () => {
    const r = await runSarifEvidence({
      env: fakeEnv, client: fakeClient(baseReport()), ...CTX, diff,
      config: { ...DEFAULT_CONFIG, disabledRules: ["RULE-A"] },
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    expect(r.findings.find((f) => f.ruleId === "RULE-A")).toBeUndefined()
  })

  it("disabledCategories filters whole class (license)", async () => {
    const reportWithLicense = makeReport([
      {
        ruleId: "LIC-1",
        level: "warning",
        message: { text: "GPL-3.0 not allowed" },
        locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 1 } } }],
      },
    ], {
      tool: { driver: { name: "Trivy", rules: [{ id: "LIC-1", properties: { tags: ["license"] } }] } },
    })
    const r = await runSarifEvidence({
      env: fakeEnv, client: fakeClient(reportWithLicense), ...CTX, diff,
      config: { ...DEFAULT_CONFIG, disabledCategories: ["license"] },
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    expect(r.findings.length).toBe(0)
  })

  it("severityThreshold warning drops note-level findings", async () => {
    const r = await runSarifEvidence({
      env: fakeEnv, client: fakeClient(baseReport()), ...CTX, diff,
      config: { ...DEFAULT_CONFIG, severityThreshold: "warning" },
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    // RULE-A error kept; RULE-B note dropped
    expect(r.findings.length).toBe(1)
    expect(r.findings[0].ruleId).toBe("RULE-A")
  })

  it("severityThreshold info keeps note-level findings", async () => {
    const r = await runSarifEvidence({
      env: fakeEnv, client: fakeClient(baseReport()), ...CTX, diff,
      config: { ...DEFAULT_CONFIG, severityThreshold: "info" },
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    expect(r.findings.length).toBe(2)
    const noteFinding = r.findings.find((f) => f.ruleId === "RULE-B")
    expect(noteFinding?.severity).toBe("info") // note → info mapping
  })

  it("level: 'none' is filtered (Kimi MINOR #4)", async () => {
    const report = makeReport([{
      ruleId: "X", level: "none",
      message: { text: "ignore me" },
      locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 1 } } }],
    }])
    const r = await runSarifEvidence({
      env: fakeEnv, client: fakeClient(report), ...CTX, diff,
      config: { ...DEFAULT_CONFIG, severityThreshold: "info" },
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    expect(r.findings.length).toBe(0)
  })
})

describe("runSarifEvidence — caps", () => {
  it("200-finding cap truncates excess + emits telemetry", async () => {
    const results = Array.from({ length: 250 }, (_, i) => ({
      ruleId: `R-${i}`,
      level: "warning",
      message: { text: `finding ${i}` },
      locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 1 } } }],
    }))
    const r = await runSarifEvidence({
      env: fakeEnv, client: fakeClient(makeReport(results)), ...CTX,
      diff: diffWithChange("src/a.ts", 1),
      config: DEFAULT_CONFIG,
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    expect(r.findings.length).toBe(200)
    expect(r.telemetry.truncatedCount).toBe(50)
  })

  it("under-cap (199) does NOT truncate (boundary)", async () => {
    const results = Array.from({ length: 199 }, (_, i) => ({
      ruleId: `R-${i}`,
      level: "warning",
      message: { text: "x" },
      locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 1 } } }],
    }))
    const r = await runSarifEvidence({
      env: fakeEnv, client: fakeClient(makeReport(results)), ...CTX,
      diff: diffWithChange("src/a.ts", 1),
      config: DEFAULT_CONFIG,
    })
    if (r.skipped) return
    expect(r.findings.length).toBe(199)
    expect(r.telemetry.truncatedCount).toBe(0)
  })

  it("report just under 8 MB does NOT trigger size cap (over-cap test in skip-paths describe)", async () => {
    // Build a valid SARIF report padded just under the 8 MB cap.
    const padding = " ".repeat(8 * 1024 * 1024 - 200)
    const report = JSON.stringify({
      version: "2.1.0",
      $schema: padding,
      runs: [{ tool: { driver: { name: "Trivy" } } }],
    })
    expect(new TextEncoder().encode(report).length).toBeLessThanOrEqual(8 * 1024 * 1024)
    const r = await runSarifEvidence({
      env: fakeEnv, client: fakeClient(report), ...CTX, diff: "",
      config: DEFAULT_CONFIG,
    })
    // Should NOT skip with report-too-large (it parses cleanly)
    if (r.skipped) {
      expect(r.reason).not.toBe("report-too-large")
    }
  })
})

describe("runSarifEvidence — stale-report telemetry (Codex MINOR #7 + Kimi MAJOR #3)", () => {
  const NOW = new Date("2026-05-06T17:00:00Z").getTime()

  it("fires when endTimeUtc > 7 days old", async () => {
    const report = makeReport([], {
      invocations: [{ endTimeUtc: "2026-04-01T00:00:00Z" }],
    })
    const r = await runSarifEvidence({
      env: fakeEnv, client: fakeClient(report), ...CTX, diff: "",
      config: DEFAULT_CONFIG, now: () => NOW,
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    expect(r.telemetry.staleReport).toBeDefined()
    expect(r.telemetry.staleReport!.ageHours).toBeGreaterThan(7 * 24)
  })

  it("does NOT fire when endTimeUtc is fresh (<7d)", async () => {
    const fresh = new Date(NOW - 24 * 60 * 60 * 1000).toISOString()
    const report = makeReport([], { invocations: [{ endTimeUtc: fresh }] })
    const r = await runSarifEvidence({
      env: fakeEnv, client: fakeClient(report), ...CTX, diff: "",
      config: DEFAULT_CONFIG, now: () => NOW,
    })
    if (r.skipped) return
    expect(r.telemetry.staleReport).toBeUndefined()
  })

  it("does NOT fire when endTimeUtc is absent", async () => {
    const r = await runSarifEvidence({
      env: fakeEnv, client: fakeClient(makeReport([])), ...CTX, diff: "",
      config: DEFAULT_CONFIG, now: () => NOW,
    })
    if (r.skipped) return
    expect(r.telemetry.staleReport).toBeUndefined()
  })

  it("does NOT fire when invocations array is missing entirely", async () => {
    const r = await runSarifEvidence({
      env: fakeEnv, client: fakeClient(makeReport([])), ...CTX, diff: "",
      config: DEFAULT_CONFIG, now: () => NOW,
    })
    if (r.skipped) return
    expect(r.telemetry.staleReport).toBeUndefined()
  })

  it("7-day boundary: exactly 7 days old → no fire; +1ms → fires", async () => {
    const exactly7d = new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString()
    const r1 = await runSarifEvidence({
      env: fakeEnv, client: fakeClient(makeReport([], { invocations: [{ endTimeUtc: exactly7d }] })),
      ...CTX, diff: "", config: DEFAULT_CONFIG, now: () => NOW,
    })
    if (!r1.skipped) expect(r1.telemetry.staleReport).toBeUndefined()

    const justOver = new Date(NOW - 7 * 24 * 60 * 60 * 1000 - 1).toISOString()
    const r2 = await runSarifEvidence({
      env: fakeEnv, client: fakeClient(makeReport([], { invocations: [{ endTimeUtc: justOver }] })),
      ...CTX, diff: "", config: DEFAULT_CONFIG, now: () => NOW,
    })
    if (!r2.skipped) expect(r2.telemetry.staleReport).toBeDefined()
  })
})

describe("runSarifEvidence — multi-runs single file", () => {
  it("Trivy + Kubescape findings both emit", async () => {
    const multi = JSON.stringify({
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "Trivy" } },
          results: [{
            ruleId: "CVE-1", level: "error", message: { text: "trivy" },
            locations: [{ physicalLocation: { artifactLocation: { uri: "package.json" }, region: { startLine: 1 } } }],
          }],
        },
        {
          tool: { driver: { name: "Kubescape" } },
          results: [{
            ruleId: "AVD-KSV-0001", level: "error", message: { text: "kubescape" },
            locations: [{ physicalLocation: { artifactLocation: { uri: "k8s/dep.yaml" }, region: { startLine: 1 } } }],
          }],
        },
      ],
    })
    const diff = diffWithChange("package.json", 1) + diffWithChange("k8s/dep.yaml", 1)
    const r = await runSarifEvidence({
      env: fakeEnv, client: fakeClient(multi), ...CTX, diff,
      config: DEFAULT_CONFIG,
    })
    if (r.skipped) return
    expect(r.findings.length).toBe(2)
    expect(r.findings.find((f) => f.toolName === "Trivy")).toBeDefined()
    expect(r.findings.find((f) => f.toolName === "Kubescape")).toBeDefined()
  })
})

describe("runSarifEvidence — license routes to security (NOT logic)", () => {
  it("license finding has roleHint: security", async () => {
    const report = makeReport([{
      ruleId: "LIC-1", level: "warning",
      message: { text: "GPL-3.0 detected" },
      locations: [{ physicalLocation: { artifactLocation: { uri: "package.json" }, region: { startLine: 1 } } }],
    }], {
      tool: { driver: { name: "Trivy", rules: [{ id: "LIC-1", properties: { tags: ["License"] } }] } },
    })
    const r = await runSarifEvidence({
      env: fakeEnv, client: fakeClient(report), ...CTX,
      diff: diffWithChange("package.json", 1),
      config: DEFAULT_CONFIG,
    })
    if (r.skipped) return
    expect(r.findings.length).toBe(1)
    expect(r.findings[0].category).toBe("license")
    expect(r.findings[0].roleHint).toBe("security")
  })
})

describe("runSarifEvidence — SBOM run produces metadata, no findings", () => {
  it("SBOM-flagged run does not contribute findings; sbom.present is true", async () => {
    const report = JSON.stringify({
      version: "2.1.0",
      runs: [{
        tool: { driver: { name: "Trivy", properties: { kind: "sbom" } } },
        artifacts: [{ properties: { name: "lodash", version: "4.17.21", license: "MIT", relationship: "direct" } }],
      }],
    })
    const r = await runSarifEvidence({
      env: fakeEnv, client: fakeClient(report), ...CTX, diff: "",
      config: DEFAULT_CONFIG,
    })
    if (r.skipped) return
    expect(r.findings.length).toBe(0)
    expect(r.sbom.present).toBe(true)
  })
})

describe("runSarifEvidence — push path (rawOverride) parity with pull path (SIG-184 PR 3)", () => {
  it("rawOverride produces byte-identical findings + SBOM to the repo-pull, with NO GitHub fetch", async () => {
    const report = makeReport([
      {
        ruleId: "rule-x",
        level: "error",
        message: { text: "boom" },
        locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 5 } } }],
      },
    ])
    const diff = diffWithChange("src/a.ts", 5)

    // Pull path: the client fetches the SARIF from the repo.
    const pull = await runSarifEvidence({ env: fakeEnv, client: fakeClient(report), ...CTX, diff, config: DEFAULT_CONFIG })

    // Push path: rawOverride supplies it; the client would 404 — proving NO fetch.
    let fetched = false
    const noFetchClient = { getFileContent: async () => { fetched = true; return null } } as unknown as GitHubClient
    const push = await runSarifEvidence({ env: fakeEnv, client: noFetchClient, ...CTX, diff, config: DEFAULT_CONFIG, rawOverride: report })

    expect(fetched).toBe(false) // rawOverride skipped the GitHub fetch
    expect(pull.skipped).toBe(false)
    expect(push.skipped).toBe(false)
    if (!pull.skipped && !push.skipped) {
      // Identical findings shape → stable security-manifest evidenceIds across paths.
      expect(push.findings).toEqual(pull.findings)
      expect(push.sbom).toEqual(pull.sbom)
      // Telemetry identical except the (timing-dependent) durationMs.
      const { durationMs: _pd, ...pushT } = push.telemetry
      const { durationMs: _qd, ...pullT } = pull.telemetry
      expect(pushT).toEqual(pullT)
    }
  })
})
