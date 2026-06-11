// ARC-186 — scanner orchestrator + render tests.

import { describe, it, expect, vi } from "vitest"
import { runDepVulnScan, type DepVulnFinding } from "@/src/features/dep-vulns"
import { renderDepVulnFindingsForPrompt } from "@/src/features/dep-vulns"
import type { GitHubClient } from "@/src/shared/adapters/github"
import type { Env } from "@/src/shared/types/env"

function fakeClient(getFileContent: GitHubClient["getFileContent"]): GitHubClient {
  return { getFileContent } as unknown as GitHubClient
}

const fakeEnv = {} as unknown as Env

const v6Lock = (deps: Record<string, string>) =>
  JSON.stringify({
    lockfileVersion: 1,
    dependencies: Object.fromEntries(Object.entries(deps).map(([k, v]) => [k, { version: v }])),
  })

const minimalPkgJson = (deps: Record<string, string>) =>
  JSON.stringify({ name: "test", version: "1.0.0", dependencies: deps })

describe("runDepVulnScan — skip paths", () => {
  it("skipped:disabled-config when enabled=false", async () => {
    const result = await runDepVulnScan({
      env: fakeEnv,
      client: fakeClient(async () => null),
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "h",
      baseSha: "b",
      enabled: false,
    })
    expect(result).toEqual({ skipped: true, reason: "disabled-config" })
  })

  it("skipped:missing-package-json when head package.json doesn't exist", async () => {
    const get = vi.fn(async (_o: string, _r: string, path: string) => {
      if (path === "package.json") return null
      return v6Lock({ lodash: "4.17.20" })
    })
    const result = await runDepVulnScan({
      env: fakeEnv,
      client: fakeClient(get),
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "h",
      baseSha: "b",
    })
    expect(result).toEqual({ skipped: true, reason: "missing-package-json" })
  })

  it("skipped:parse-failed when package.json is malformed", async () => {
    const get = vi.fn(async (_o: string, _r: string, path: string) => {
      if (path === "package.json") return "{not json"
      return null
    })
    const result = await runDepVulnScan({
      env: fakeEnv,
      client: fakeClient(get),
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "h",
      baseSha: "b",
    })
    expect(result).toEqual({ skipped: true, reason: "parse-failed" })
  })

  it("skipped:missing-lockfile when head package-lock.json is absent", async () => {
    const get = vi.fn(async (_o: string, _r: string, path: string) => {
      if (path === "package.json") return minimalPkgJson({ lodash: "^4.17.0" })
      return null
    })
    const result = await runDepVulnScan({
      env: fakeEnv,
      client: fakeClient(get),
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "h",
      baseSha: "b",
    })
    expect(result).toEqual({ skipped: true, reason: "missing-lockfile" })
  })
})

describe("runDepVulnScan — finding emission", () => {
  it("emits a finding for a vulnerable lodash version (head adds, base doesn't have it)", async () => {
    const get = vi.fn(async (_o: string, _r: string, path: string, ref: string) => {
      if (path === "package.json" && ref === "h") return minimalPkgJson({ lodash: "^4.17.0" })
      if (path === "package-lock.json" && ref === "h") return v6Lock({ lodash: "4.17.20" })
      if (path === "package-lock.json" && ref === "b") return v6Lock({})
      return null
    })
    const result = await runDepVulnScan({
      env: fakeEnv,
      client: fakeClient(get),
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "h",
      baseSha: "b",
    })
    expect(result.skipped).toBe(false)
    if (result.skipped) return
    expect(result.findings.length).toBeGreaterThan(0)
    const lodash = result.findings.find((f) => f.package_name === "lodash")
    expect(lodash?.advisory_id).toMatch(/GHSA/)
    expect(lodash?.severity).toBe("critical")
    expect(lodash?.match_type).toBe("range-vulnerable")
  })

  it("suppresses a patched lodash version (base + head both at 4.17.21)", async () => {
    const get = vi.fn(async (_o: string, _r: string, path: string, _ref: string) => {
      if (path === "package.json") return minimalPkgJson({ lodash: "^4.17.0" })
      if (path === "package-lock.json") return v6Lock({ lodash: "4.17.21" })
      return null
    })
    const result = await runDepVulnScan({
      env: fakeEnv,
      client: fakeClient(get),
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "h",
      baseSha: "b",
    })
    expect(result.skipped).toBe(false)
    if (result.skipped) return
    expect(result.findings.length).toBe(0)
  })

  it("LOCKFILE-ONLY upgrade: head bumps lodash to vulnerable version while base was patched → finding", async () => {
    const get = vi.fn(async (_o: string, _r: string, path: string, ref: string) => {
      if (path === "package.json") return minimalPkgJson({ lodash: "^4.17.0" })
      if (path === "package-lock.json" && ref === "h") return v6Lock({ lodash: "4.17.20" })
      if (path === "package-lock.json" && ref === "b") return v6Lock({ lodash: "4.17.21" })
      return null
    })
    const result = await runDepVulnScan({
      env: fakeEnv,
      client: fakeClient(get),
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "h",
      baseSha: "b",
    })
    expect(result.skipped).toBe(false)
    if (result.skipped) return
    expect(result.findings.length).toBe(1)
  })

  it("MISSING BASE LOCKFILE → all head deps treated as 'added' (first lockfile PR)", async () => {
    const get = vi.fn(async (_o: string, _r: string, path: string, ref: string) => {
      if (path === "package.json") return minimalPkgJson({ lodash: "^4.17.0" })
      if (path === "package-lock.json" && ref === "h") return v6Lock({ lodash: "4.17.20" })
      if (path === "package-lock.json" && ref === "b") return null
      return null
    })
    const result = await runDepVulnScan({
      env: fakeEnv,
      client: fakeClient(get),
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "h",
      baseSha: "b",
    })
    expect(result.skipped).toBe(false)
    if (result.skipped) return
    expect(result.findings.length).toBeGreaterThan(0)
  })

  it("hoist filter: transitives in lockfile but not in package.json don't surface findings", async () => {
    const get = vi.fn(async (_o: string, _r: string, path: string, ref: string) => {
      if (path === "package.json") return minimalPkgJson({ "some-other-pkg": "^1.0.0" })
      if (path === "package-lock.json" && ref === "h") return v6Lock({ lodash: "4.17.20", "some-other-pkg": "1.0.0" })
      if (path === "package-lock.json" && ref === "b") return v6Lock({})
      return null
    })
    const result = await runDepVulnScan({
      env: fakeEnv,
      client: fakeClient(get),
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "h",
      baseSha: "b",
    })
    expect(result.skipped).toBe(false)
    if (result.skipped) return
    // lodash is hoisted (not in package.json) → filtered out → no finding
    expect(result.findings.find((f) => f.package_name === "lodash")).toBeUndefined()
  })
})

describe("renderDepVulnFindingsForPrompt", () => {
  it("returns empty string for zero findings (omit section)", () => {
    expect(renderDepVulnFindingsForPrompt([])).toBe("")
  })

  it("renders a structured block with all required fields", () => {
    const finding: DepVulnFinding = {
      ecosystem: "npm",
      package_name: "lodash",
      version: "4.17.20",
      source_path: "package-lock.json",
      advisory_id: "GHSA-test",
      advisory_source: "github",
      vulnerable_range: ">=0.0.0 <4.17.21",
      patched_in: "4.17.21",
      severity: "critical",
      summary: "Prototype pollution",
      fix_guidance: "Upgrade to >=4.17.21",
      match_type: "range-vulnerable",
    }
    const out = renderDepVulnFindingsForPrompt([finding])
    expect(out).toContain("[DEPENDENCY VULNERABILITIES — pre-LLM]")
    expect(out).toContain("lodash@4.17.20")
    expect(out).toContain("GHSA-test")
    expect(out).toContain("github")
    expect(out).toContain("critical")
    expect(out).toContain("Prototype pollution")
    expect(out).toContain(">=0.0.0 <4.17.21")
    expect(out).toContain("4.17.21")
    expect(out).toContain("Upgrade to >=4.17.21")
    // LOCK the literal match_type string (Kimi MINOR #5)
    expect(out).toContain("match_type: range-vulnerable")
  })

  it("locks the literal match_type: range-vulnerable string (drift guard)", () => {
    const finding: DepVulnFinding = {
      ecosystem: "npm",
      package_name: "x",
      version: "1.0.0",
      source_path: "package-lock.json",
      advisory_id: "X",
      advisory_source: "github",
      vulnerable_range: "x",
      patched_in: "y",
      severity: "low",
      summary: "x",
      fix_guidance: null,
      match_type: "range-vulnerable",
    }
    expect(renderDepVulnFindingsForPrompt([finding])).toMatch(/match_type: range-vulnerable/)
  })
})
