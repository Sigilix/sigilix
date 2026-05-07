// ARC-188 — SARIF parser tests.

import { describe, it, expect } from "vitest"
import { parseSarif } from "../src/lib/sarif-evidence/sarif-parser"

const minimalReport = {
  version: "2.1.0",
  runs: [
    {
      tool: { driver: { name: "Trivy" } },
      results: [
        {
          ruleId: "AVD-KSV-0017",
          level: "error",
          message: { text: "Privileged container" },
        },
      ],
    },
  ],
}

describe("parseSarif — happy paths", () => {
  it("parses a minimal valid report", () => {
    const r = parseSarif(JSON.stringify(minimalReport))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.report.version).toBe("2.1.0")
      expect(r.report.runs.length).toBe(1)
      expect(r.report.runs[0]?.results?.length).toBe(1)
    }
  })

  it("preserves $schema when present", () => {
    const withSchema = { ...minimalReport, $schema: "https://example.com/sarif" }
    const r = parseSarif(JSON.stringify(withSchema))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.report.$schema).toBe("https://example.com/sarif")
  })

  it("multi-runs (Trivy + Kubescape) in a single file", () => {
    const multi = {
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "Trivy" } },
          results: [{ message: { text: "CVE-1" } }],
        },
        {
          tool: { driver: { name: "Kubescape" } },
          results: [{ message: { text: "RBAC-1" } }],
        },
      ],
    }
    const r = parseSarif(JSON.stringify(multi))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.report.runs.length).toBe(2)
      expect(r.report.runs[0]?.tool.driver.name).toBe("Trivy")
      expect(r.report.runs[1]?.tool.driver.name).toBe("Kubescape")
    }
  })

  it("preserves invocations.endTimeUtc for stale-report telemetry", () => {
    const stamped = {
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "Trivy" } },
          results: [{ message: { text: "x" } }],
          invocations: [{ endTimeUtc: "2026-04-01T00:00:00Z" }],
        },
      ],
    }
    const r = parseSarif(JSON.stringify(stamped))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.report.runs[0]?.invocations?.[0]?.endTimeUtc).toBe("2026-04-01T00:00:00Z")
    }
  })

  it("preserves both taxa and properties.tags on results", () => {
    const tagged = {
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "Trivy",
              rules: [
                { id: "X", properties: { tags: ["Kubernetes", "Misconfiguration"] } },
              ],
            },
          },
          results: [
            {
              ruleId: "X",
              message: { text: "x" },
              taxa: [{ id: "K8S", toolComponent: { guid: "abc" } }],
            },
          ],
        },
      ],
    }
    const r = parseSarif(JSON.stringify(tagged))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.report.runs[0]?.tool.driver.rules?.[0]?.properties?.tags).toEqual([
        "Kubernetes", "Misconfiguration",
      ])
      expect(r.report.runs[0]?.results?.[0]?.taxa?.[0]?.id).toBe("K8S")
    }
  })
})

describe("parseSarif — error paths", () => {
  it("rejects non-string input", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = parseSarif(123 as any)
    expect(r.ok).toBe(false)
  })

  it("rejects malformed JSON", () => {
    const r = parseSarif("not json")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/JSON parse failed/i)
  })

  it("rejects non-object root (array)", () => {
    expect(parseSarif("[]").ok).toBe(false)
  })

  it("rejects unsupported version 2.0.0", () => {
    const bad = { ...minimalReport, version: "2.0.0" }
    const r = parseSarif(JSON.stringify(bad))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/unsupported-sarif-version/)
  })

  it("rejects when runs is not an array", () => {
    const bad = { version: "2.1.0", runs: "nope" }
    const r = parseSarif(JSON.stringify(bad))
    expect(r.ok).toBe(false)
  })

  it("accepts empty runs array (top-level valid even if empty)", () => {
    const empty = { version: "2.1.0", runs: [] }
    const r = parseSarif(JSON.stringify(empty))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.report.runs.length).toBe(0)
  })

  it("drops runs missing tool.driver.name (instead of failing the whole report)", () => {
    const partial = {
      version: "2.1.0",
      runs: [
        { tool: { driver: { name: "Trivy" } }, results: [{ message: { text: "ok" } }] },
        { tool: {} },           // missing driver
        { tool: { driver: {} } },  // missing driver.name
      ],
    }
    const r = parseSarif(JSON.stringify(partial))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.report.runs.length).toBe(1)
      expect(r.report.runs[0]?.tool.driver.name).toBe("Trivy")
    }
  })

  it("drops results with no message.text (keeps surrounding run)", () => {
    const partial = {
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "Trivy" } },
          results: [
            { message: { text: "kept" } },
            { ruleId: "X" }, // no message — dropped
            { message: {} }, // no text — dropped
          ],
        },
      ],
    }
    const r = parseSarif(JSON.stringify(partial))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.report.runs[0]?.results?.length).toBe(1)
      expect(r.report.runs[0]?.results?.[0]?.message?.text).toBe("kept")
    }
  })
})
