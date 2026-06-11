// ARC-188 — SBOM summary tests.

import { describe, it, expect } from "vitest"
import { buildSbomSummary } from "@/src/features/sarif-evidence/domain/sbom-summary"
import type { SarifReport } from "@/src/features/sarif-evidence/domain/types"

const empty: SarifReport = { version: "2.1.0", runs: [] }

describe("buildSbomSummary", () => {
  it("returns empty/absent when no runs", () => {
    const r = buildSbomSummary(empty)
    expect(r.present).toBe(false)
    expect(r.text).toBe("")
    expect(r.packageCount).toBe(0)
  })

  it("returns absent when no SBOM-flagged run present", () => {
    const r = buildSbomSummary({
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "Trivy" } },
          results: [{ message: { text: "regular finding" }, kind: "fail" }],
        },
      ],
    })
    expect(r.present).toBe(false)
    expect(r.text).toBe("")
  })

  it("detects SBOM via tool.driver.properties.kind", () => {
    const r = buildSbomSummary({
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "Trivy", properties: { kind: "sbom" } } },
          artifacts: [
            {
              properties: {
                name: "lodash",
                version: "4.17.21",
                license: "MIT",
                relationship: "direct",
              },
            },
            {
              properties: {
                name: "underscore",
                version: "1.13.6",
                license: "MIT",
                relationship: "indirect",
              },
            },
          ],
        },
      ],
    })
    expect(r.present).toBe(true)
    expect(r.packageCount).toBe(2)
    expect(r.directDepCount).toBe(1)
    expect(r.licenseCounts).toEqual({ MIT: 2 })
    expect(r.text).toContain("[SBOM SUMMARY — pre-LLM]")
    expect(r.text).toContain("Total packages: 2")
    expect(r.text).toContain("Direct deps: 1 | Transitive: 1")
  })

  it("detects SBOM via result.kind: informational + SBOM taxa signal", () => {
    const r = buildSbomSummary({
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "Trivy" } },
          results: [
            {
              message: { text: "package metadata" },
              kind: "informational",
              taxa: [{ id: "trivy-sbom-component" }],
            },
          ],
          artifacts: [
            {
              properties: {
                name: "react",
                version: "18.2.0",
                license: "MIT",
                relationship: "direct",
              },
            },
          ],
        },
      ],
    })
    expect(r.present).toBe(true)
    expect(r.packageCount).toBe(1)
  })

  it("ignores result.kind: informational without SBOM taxa signal (avoids non-SBOM informational FP)", () => {
    const r = buildSbomSummary({
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "Trivy" } },
          results: [
            {
              message: { text: "suppressed finding" },
              kind: "informational",
            },
          ],
          artifacts: [{ properties: { name: "react", version: "18.2.0" } }],
        },
      ],
    })
    expect(r.present).toBe(false)
    expect(r.packageCount).toBe(0)
  })

  it("multi-run with one SBOM + one regular — only SBOM contributes", () => {
    const r = buildSbomSummary({
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "Trivy", properties: { kind: "sbom" } } },
          artifacts: [{ properties: { name: "x", version: "1.0", license: "MIT", relationship: "direct" } }],
        },
        {
          tool: { driver: { name: "Kubescape" } },
          results: [{ message: { text: "K8s misconfig" } }],
        },
      ],
    })
    expect(r.packageCount).toBe(1)
  })

  it("aggregates licenses + applies Top-N with Other bucket", () => {
    const artifacts = []
    for (let i = 0; i < 10; i++)
      artifacts.push({
        properties: { name: `pkg-mit-${i}`, license: "MIT", relationship: "indirect" },
      })
    for (let i = 0; i < 5; i++)
      artifacts.push({
        properties: { name: `pkg-apache-${i}`, license: "Apache-2.0", relationship: "indirect" },
      })
    for (let i = 0; i < 3; i++)
      artifacts.push({
        properties: { name: `pkg-bsd-${i}`, license: "BSD-3-Clause", relationship: "indirect" },
      })
    for (let i = 0; i < 2; i++)
      artifacts.push({
        properties: { name: `pkg-isc-${i}`, license: "ISC", relationship: "indirect" },
      })
    artifacts.push({
      properties: { name: "pkg-mpl", license: "MPL-2.0", relationship: "indirect" },
    })
    artifacts.push({
      properties: { name: "pkg-gpl", license: "GPL-3.0", relationship: "indirect" },
    })
    artifacts.push({
      properties: { name: "pkg-lgpl", license: "LGPL-2.1", relationship: "indirect" },
    })
    artifacts.push({
      properties: { name: "pkg-cc0", license: "CC0-1.0", relationship: "indirect" },
    })
    const r = buildSbomSummary({
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "Trivy", properties: { kind: "sbom" } } },
          artifacts,
        },
      ],
    })
    expect(r.text).toContain("MIT=10")
    expect(r.text).toContain("Apache-2.0=5")
    expect(r.text).toContain("BSD-3-Clause=3")
    expect(r.text).toContain("Other=") // long-tail bucketed
  })

  it("output stays at ≤20 lines", () => {
    const artifacts = Array.from({ length: 100 }, (_, i) => ({
      properties: {
        name: `pkg-${i}`,
        version: `1.${i}.0`,
        license: "MIT",
        relationship: i < 5 ? "direct" : "indirect",
      },
    }))
    const r = buildSbomSummary({
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "Trivy", properties: { kind: "sbom" } } },
          artifacts,
        },
      ],
    })
    const lineCount = r.text.split("\n").length
    expect(lineCount).toBeLessThanOrEqual(20)
  })

  it("top-N package list is deterministic (sorted by name)", () => {
    const r = buildSbomSummary({
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "Trivy", properties: { kind: "sbom" } } },
          artifacts: [
            { properties: { name: "zod", version: "3.22.0", relationship: "direct" } },
            { properties: { name: "axios", version: "1.6.0", relationship: "direct" } },
            { properties: { name: "lodash", version: "4.17.21", relationship: "direct" } },
          ],
        },
      ],
    })
    expect(r.text).toMatch(/axios@1\.6\.0, lodash@4\.17\.21, zod@3\.22\.0/)
  })
})
