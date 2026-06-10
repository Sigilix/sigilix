// ARC-186 — bundled advisory DB schema + loader tests.

import { describe, it, expect } from "vitest"
import { loadAdvisoryDb } from "@/src/features/dep-vulns/domain/advisory-db"

describe("loadAdvisoryDb", () => {
  const db = loadAdvisoryDb()

  it("loads the bundled DB without throwing", () => {
    expect(db).toBeDefined()
    expect(db.metadata.schemaVersion).toBe(1)
  })

  it("metadata.advisoryCount matches advisories.length", () => {
    expect(db.metadata.advisoryCount).toBe(db.advisories.length)
  })

  it("snapshotDate is an ISO date string", () => {
    expect(db.metadata.snapshotDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it("every advisory has a non-empty id, package_name, summary", () => {
    for (const a of db.advisories) {
      expect(a.id.length).toBeGreaterThan(0)
      expect(a.package_name.length).toBeGreaterThan(0)
      expect(a.summary.length).toBeGreaterThan(0)
    }
  })

  it("every advisory has at least one range with a vulnerable_range + patched_in", () => {
    for (const a of db.advisories) {
      expect(a.ranges.length).toBeGreaterThan(0)
      for (const r of a.ranges) {
        expect(r.vulnerable_range.length).toBeGreaterThan(0)
        expect(r.patched_in.length).toBeGreaterThan(0)
      }
    }
  })

  it("every severity_class is one of the four canonical values", () => {
    const valid = new Set(["low", "medium", "high", "critical"])
    for (const a of db.advisories) {
      expect(valid.has(a.severity_class)).toBe(true)
    }
  })

  it("every advisory's ecosystem is npm (v1 scope)", () => {
    for (const a of db.advisories) {
      expect(a.ecosystem).toBe("npm")
    }
  })

  it("every advisory id is unique", () => {
    const ids = new Set<string>()
    for (const a of db.advisories) {
      expect(ids.has(a.id)).toBe(false)
      ids.add(a.id)
    }
  })
})
