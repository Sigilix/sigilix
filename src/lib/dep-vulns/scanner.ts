// ARC-186: dependency-vulnerability scan orchestrator. Runs BEFORE
// the LLM specialist fanout — pure GitHub-side metadata + bundled
// advisory DB lookup. Findings are injected into the security
// specialist + synthesizer prompts as authoritative facts.
//
// Strict v1 contract:
//   - npm only (Python deferred to v2)
//   - Top-level deps only (transitive deferred to v2)
//   - Lockfile required (no package.json-only fallback in v1)
//   - Range-aware patch evaluation (multi-major advisories)
//
// Spec: docs/superpowers/specs/2026-05-06-arc-186-dep-vulns-design.md

import type { GitHubClient } from "../../shared/adapters/github"
import type { Env } from "../../shared/types/env"
import { loadAdvisoryDb, type AdvisoryRecord } from "./advisory-db"
import {
  parsePackageJson,
  parsePackageLock,
  rootDepNames,
} from "./manifest-parsers"
import { matchVersion } from "./version-matcher"

const PACKAGE_JSON_PATH = "package.json"
const PACKAGE_LOCK_PATH = "package-lock.json"

export interface DepVulnFinding {
  ecosystem: "npm"
  package_name: string
  version: string
  source_path: string
  advisory_id: string
  advisory_source: AdvisoryRecord["source"]
  vulnerable_range: string
  patched_in: string
  severity: AdvisoryRecord["severity_class"]
  summary: string
  fix_guidance: string | null
  match_type: "range-vulnerable"
}

export type ScanSkipReason =
  | "disabled-config"
  | "missing-package-json"
  | "missing-lockfile"
  | "parse-failed"

export type ScanResult =
  | { skipped: true; reason: ScanSkipReason }
  | { skipped: false; findings: DepVulnFinding[]; depsScanned: number; manifestsScanned: number }

export interface RunDepVulnScanArgs {
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  headSha: string
  baseSha: string
  /** Whether the per-repo `sigilix.json` enabled the scan. Default treated as enabled. */
  enabled?: boolean
}

export async function runDepVulnScan(args: RunDepVulnScanArgs): Promise<ScanResult> {
  const { client, owner, repo, prNumber, headSha, baseSha, enabled = true } = args
  void args.env // reserved for env-driven kill-switch in v2
  const t0 = Date.now()

  if (!enabled) {
    console.log(JSON.stringify({
      event: "dep-vuln-scan-skipped",
      reason: "disabled-config",
      owner, repo, prNumber,
    }))
    return { skipped: true, reason: "disabled-config" }
  }

  const headPkgJsonRaw = await safeFetch(client, owner, repo, PACKAGE_JSON_PATH, headSha)
  if (headPkgJsonRaw === null) {
    console.log(JSON.stringify({
      event: "dep-vuln-scan-skipped",
      reason: "missing-package-json",
      owner, repo, prNumber,
    }))
    return { skipped: true, reason: "missing-package-json" }
  }

  const headPkgJson = parsePackageJson(headPkgJsonRaw)
  if (headPkgJson === null) {
    console.log(JSON.stringify({
      event: "dep-vuln-scan-skipped",
      reason: "parse-failed",
      detail: "package.json",
      owner, repo, prNumber,
    }))
    return { skipped: true, reason: "parse-failed" }
  }

  const headLockRaw = await safeFetch(client, owner, repo, PACKAGE_LOCK_PATH, headSha)
  if (headLockRaw === null) {
    console.log(JSON.stringify({
      event: "dep-vuln-scan-skipped",
      reason: "missing-lockfile",
      owner, repo, prNumber,
    }))
    return { skipped: true, reason: "missing-lockfile" }
  }

  const rootDeps = rootDepNames(headPkgJson)
  const headResolved = parsePackageLock(headLockRaw, rootDeps)

  // Optional base-side fetch — used to compute "added or changed" set.
  // If base lockfile is missing or fails, fall through to scanning all
  // head deps (treats this as the first PR introducing the lockfile).
  const baseLockRaw = baseSha ? await safeFetch(client, owner, repo, PACKAGE_LOCK_PATH, baseSha) : null
  const baseResolved = baseLockRaw ? parsePackageLock(baseLockRaw, rootDeps) : new Map<string, string>()

  // Compute added/upgraded set: name + version pair must differ from base.
  const targets: Array<{ name: string; version: string }> = []
  for (const [name, version] of headResolved.entries()) {
    if (baseResolved.get(name) !== version) {
      targets.push({ name, version })
    }
  }

  const db = loadAdvisoryDb()
  console.log(JSON.stringify({
    event: "dep-vuln-snapshot-meta",
    snapshotDate: db.metadata.snapshotDate,
    sourceHash: db.metadata.sourceHash,
    advisoryCount: db.metadata.advisoryCount,
    schemaVersion: db.metadata.schemaVersion,
    owner, repo, prNumber,
  }))

  const findings: DepVulnFinding[] = []
  for (const { name, version } of targets) {
    for (const advisory of db.advisories) {
      if (advisory.package_name !== name) continue
      const result = matchVersion(version, advisory)
      if (result.match !== "range-vulnerable") continue
      const finding: DepVulnFinding = {
        ecosystem: "npm",
        package_name: advisory.package_name,
        version,
        source_path: PACKAGE_LOCK_PATH,
        advisory_id: advisory.id,
        advisory_source: advisory.source,
        vulnerable_range: result.matchedRange ?? "",
        patched_in: result.patchedIn ?? "",
        severity: advisory.severity_class,
        summary: advisory.summary,
        fix_guidance: advisory.fix_guidance ?? null,
        match_type: "range-vulnerable",
      }
      findings.push(finding)
      console.log(JSON.stringify({
        event: "dep-vuln-finding",
        owner, repo, prNumber,
        package_name: finding.package_name,
        version: finding.version,
        advisory_id: finding.advisory_id,
        severity: finding.severity,
      }))
    }
  }

  console.log(JSON.stringify({
    event: "dep-vuln-scan-ran",
    owner, repo, prNumber,
    manifestsScanned: 1,
    depsScanned: targets.length,
    findingsCount: findings.length,
    durationMs: Date.now() - t0,
  }))

  return {
    skipped: false,
    findings,
    depsScanned: targets.length,
    manifestsScanned: 1,
  }
}

async function safeFetch(
  client: GitHubClient,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const raw = await client.getFileContent(owner, repo, path, ref)
    if (raw === null) return null
    if (raw.trim().length === 0) return null
    return raw
  } catch {
    return null
  }
}
