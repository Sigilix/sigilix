// ARC-188: SARIF evidence scan orchestrator.
//
// Pipeline:
//   1. Skip if disabled-config
//   2. Fetch SARIF at the configured path; 404 → silent skip
//   3. Reject reports > REPORT_SIZE_CAP_BYTES BEFORE parse
//   4. Parse via `parseSarif` (defensive)
//   5. Walk runs/results: normalize path → resolve taxonomy →
//      filter by changed-line set → emit finding
//   6. Cap emitted findings at MAX_FINDINGS_PER_SCAN (truncate excess)
//   7. Build SBOM summary
//   8. Stale-report telemetry when invocations.endTimeUtc > 7d
//
// Returns `{ findings, sbom, telemetry }`. The runner does NOT post
// inline comments — that's deferred to v2 (auto-inline NOT wired in
// v1 per spec §3.5).

import type { GitHubClient } from "../github"
import type { Env } from "../../index"
import { parseSarif } from "./sarif-parser"
import { normalizeSarifPath } from "./path-normalize"
import { resolveTaxonomy } from "./taxonomy"
import { buildSbomSummary } from "./sbom-summary"
import { buildChangedLines, nodeOverlapsChanged } from "./diff-lines"
import type {
  SarifFinding,
  SarifFindingCategory,
  SarifReport,
  SarifResult,
  SarifRule,
  SbomSummary,
  Severity,
} from "./types"

const REPORT_SIZE_CAP_BYTES = 2 * 1024 * 1024
const MAX_FINDINGS_PER_SCAN = 200
const STALE_REPORT_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000
const EVIDENCE_MAX_CHARS = 200
const RULE_HELP_MAX_CHARS = 500

export type ScanSkipReason =
  | "disabled-config"
  | "no-report"
  | "report-too-large"
  | "parse-failed"
  | "unsupported-sarif-version"

export type ScanResult =
  | { skipped: true; reason: ScanSkipReason; sbom: SbomSummary; telemetry: RunnerTelemetry }
  | { skipped: false; findings: SarifFinding[]; sbom: SbomSummary; telemetry: RunnerTelemetry }

export interface RunnerTelemetry {
  scanned: boolean
  skipReason?: ScanSkipReason
  /** Total `result` entries traversed across all runs. */
  resultsConsidered: number
  /** Findings emitted post-cap (telemetry reflects emitted count, not pre-cap). */
  findingsCount: number
  /** Number of findings dropped by the 200-finding cap. */
  truncatedCount: number
  /** Findings dropped by changed-line filter (path/line not in PR diff). */
  filteredOutByDiff: number
  /** Findings dropped by path normalization. */
  filteredOutByPath: number
  /** Findings dropped by config (disabledRules, disabledCategories, severityThreshold). */
  filteredOutByConfig: number
  durationMs: number
  staleReport?: { ageHours: number }
}

export interface ResolvedSarifConfig {
  enabled: boolean
  path: string
  severityThreshold: "info" | "warning" | "error"
  disabledRules: string[]
  disabledCategories: SarifFindingCategory[]
}

export interface RunSarifEvidenceArgs {
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  headSha: string
  /** Unified diff for the PR. */
  diff: string
  /** Resolved SARIF config (defaults already filled in). */
  config: ResolvedSarifConfig
  /** For stale-report telemetry. Defaults to `Date.now()`; injectable for tests. */
  now?: () => number
}

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2 }

function emit(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }))
}

function levelToSeverity(level: SarifResult["level"]): Severity | "skipped" {
  switch (level) {
    case "error": return "error"
    case "warning": return "warning"
    case "note": return "info"
    case "none": return "skipped"
    default: return "warning" // SARIF default when omitted
  }
}

function clampString(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

function resolveRule(rules: SarifRule[] | undefined, ruleId: string | undefined): SarifRule | null {
  if (!rules || !ruleId) return null
  return rules.find((r) => r.id === ruleId) ?? null
}

function findStaleReportAgeMs(report: SarifReport, nowMs: number): number | null {
  let mostRecent: number | null = null
  for (const run of report.runs) {
    if (!Array.isArray(run.invocations)) continue
    for (const inv of run.invocations) {
      if (typeof inv.endTimeUtc !== "string") continue
      const t = Date.parse(inv.endTimeUtc)
      if (!Number.isFinite(t)) continue
      if (mostRecent === null || t > mostRecent) mostRecent = t
    }
  }
  if (mostRecent === null) return null
  return nowMs - mostRecent
}

function emitStaleTelemetryIfNeeded(
  report: SarifReport,
  nowMs: number,
  ctx: { owner: string; repo: string; prNumber: number },
): { ageHours: number } | undefined {
  const ageMs = findStaleReportAgeMs(report, nowMs)
  if (ageMs === null || ageMs <= STALE_REPORT_THRESHOLD_MS) return undefined
  const ageHours = Math.round(ageMs / (60 * 60 * 1000))
  emit("sarif-evidence-stale-report", { ...ctx, ageHours })
  return { ageHours }
}

async function fetchReportRaw(
  client: GitHubClient,
  owner: string,
  repo: string,
  path: string,
  headSha: string,
): Promise<string | null> {
  try {
    const raw = await client.getFileContent(owner, repo, path, headSha)
    if (raw === null) return null
    if (raw.length === 0) return null
    return raw
  } catch {
    return null
  }
}

export async function runSarifEvidence(args: RunSarifEvidenceArgs): Promise<ScanResult> {
  const { client, owner, repo, prNumber, headSha, diff, config } = args
  const nowMs = (args.now ?? Date.now)()
  const ctx = { owner, repo, prNumber }
  const t0 = Date.now()

  const baseTelemetry: RunnerTelemetry = {
    scanned: false,
    resultsConsidered: 0,
    findingsCount: 0,
    truncatedCount: 0,
    filteredOutByDiff: 0,
    filteredOutByPath: 0,
    filteredOutByConfig: 0,
    durationMs: 0,
  }

  const emptySbom: SbomSummary = {
    text: "", present: false, packageCount: 0, directDepCount: 0, licenseCounts: {},
  }

  if (!config.enabled) {
    emit("sarif-evidence-scan-skipped", { ...ctx, reason: "disabled-config" })
    return {
      skipped: true,
      reason: "disabled-config",
      sbom: emptySbom,
      telemetry: { ...baseTelemetry, skipReason: "disabled-config", durationMs: Date.now() - t0 },
    }
  }

  const raw = await fetchReportRaw(client, owner, repo, config.path, headSha)
  if (raw === null) {
    emit("sarif-evidence-scan-skipped", { ...ctx, reason: "no-report", path: config.path })
    return {
      skipped: true,
      reason: "no-report",
      sbom: emptySbom,
      telemetry: { ...baseTelemetry, skipReason: "no-report", durationMs: Date.now() - t0 },
    }
  }

  // Pre-parse size cap (Codex MINOR #5). Use byte length, not char
  // length, to match the cap unit.
  const reportBytes = new TextEncoder().encode(raw).length
  if (reportBytes > REPORT_SIZE_CAP_BYTES) {
    emit("sarif-evidence-scan-skipped", { ...ctx, reason: "report-too-large", sizeBytes: reportBytes })
    return {
      skipped: true,
      reason: "report-too-large",
      sbom: emptySbom,
      telemetry: { ...baseTelemetry, skipReason: "report-too-large", durationMs: Date.now() - t0 },
    }
  }

  const parsed = parseSarif(raw)
  if (!parsed.ok) {
    const reason: ScanSkipReason = parsed.reason.startsWith("unsupported-sarif-version")
      ? "unsupported-sarif-version"
      : "parse-failed"
    emit(reason === "unsupported-sarif-version" ? "unsupported-sarif-version" : "sarif-evidence-parse-failed", {
      ...ctx, errMessage: parsed.reason,
    })
    return {
      skipped: true,
      reason,
      sbom: emptySbom,
      telemetry: { ...baseTelemetry, skipReason: reason, durationMs: Date.now() - t0 },
    }
  }

  const report = parsed.report
  const sbom = buildSbomSummary(report)
  const stale = emitStaleTelemetryIfNeeded(report, nowMs, ctx)
  const changedLines = buildChangedLines(diff)
  const minRank = SEVERITY_RANK[config.severityThreshold]
  const disabledRules = new Set(config.disabledRules)
  const disabledCategories = new Set(config.disabledCategories)

  const findings: SarifFinding[] = []
  let resultsConsidered = 0
  let filteredOutByDiff = 0
  let filteredOutByPath = 0
  let filteredOutByConfig = 0
  let truncatedCount = 0

  for (const run of report.runs) {
    const rules = run.tool?.driver?.rules
    const runTaxa = run.taxonomies?.flatMap((t) => t.taxa ?? []) ?? []
    const toolName = run.tool?.driver?.name ?? "unknown"

    for (const result of run.results ?? []) {
      resultsConsidered++

      // Severity mapping
      const sev = levelToSeverity(result.level)
      if (sev === "skipped") {
        filteredOutByConfig++
        continue
      }
      if (SEVERITY_RANK[sev] < minRank) {
        filteredOutByConfig++
        continue
      }

      // Rule + taxonomy
      const rule = resolveRule(rules, result.ruleId)
      const taxonomy = resolveTaxonomy({ result, rule, runTaxa, toolName })
      if (taxonomy.isSbom) continue // SBOM is metadata, not a finding

      // Config-driven filter (disabledRules + disabledCategories)
      if (result.ruleId && disabledRules.has(result.ruleId)) {
        filteredOutByConfig++
        continue
      }
      if (disabledCategories.has(taxonomy.category)) {
        filteredOutByConfig++
        continue
      }

      // Path normalization (location[0] is canonical for SARIF)
      const loc = result.locations?.[0]?.physicalLocation
      const artLoc = loc?.artifactLocation
      const normalized = normalizeSarifPath(artLoc?.uri, {
        ...(artLoc?.uriBaseId !== undefined ? { uriBaseId: artLoc.uriBaseId } : {}),
        ...(artLoc?.index !== undefined ? { index: artLoc.index } : {}),
        ...(run.artifacts ? { artifacts: run.artifacts } : {}),
      })
      if (!normalized.ok) {
        filteredOutByPath++
        continue
      }
      const path = normalized.path

      // Diff-line filter
      const startLine = loc?.region?.startLine
      const endLine = loc?.region?.endLine ?? startLine
      if (typeof startLine === "number") {
        if (!nodeOverlapsChanged(changedLines, path, startLine, endLine ?? startLine)) {
          filteredOutByDiff++
          continue
        }
      } else {
        // Path-only fallback (spec §4.5): keep when ANY line in the
        // file is changed. IaC findings are often file-level.
        const changes = changedLines.get(path)
        if (!changes || changes.size === 0) {
          filteredOutByDiff++
          continue
        }
      }

      // Cap check before push
      if (findings.length >= MAX_FINDINGS_PER_SCAN) {
        truncatedCount++
        continue
      }

      const messageText = normalizeWhitespace(result.message?.text ?? "")
      const evidenceRaw = loc?.region?.snippet?.text
      const evidence = typeof evidenceRaw === "string"
        ? clampString(normalizeWhitespace(evidenceRaw), EVIDENCE_MAX_CHARS)
        : undefined

      const finding: SarifFinding = {
        ruleId: result.ruleId ?? "unknown-rule",
        severity: sev,
        roleHint: taxonomy.roleHint,
        category: taxonomy.category,
        path,
        message: messageText,
        toolName,
      }
      if (typeof startLine === "number") finding.line = startLine
      if (rule?.name) finding.ruleName = rule.name
      const helpText = rule?.help?.text ?? rule?.fullDescription?.text
      if (typeof helpText === "string" && helpText.length > 0) {
        finding.ruleHelpText = clampString(normalizeWhitespace(helpText), RULE_HELP_MAX_CHARS)
      }
      if (evidence !== undefined) finding.evidence = evidence
      findings.push(finding)

      emit("sarif-evidence-finding", {
        ...ctx,
        ruleId: finding.ruleId,
        severity: finding.severity,
        category: finding.category,
        roleHint: finding.roleHint,
        path: finding.path,
      })
    }
  }

  if (truncatedCount > 0) {
    emit("sarif-evidence-truncated", { ...ctx, droppedCount: truncatedCount, cap: MAX_FINDINGS_PER_SCAN })
  }

  const durationMs = Date.now() - t0
  emit("sarif-evidence-scan-ran", {
    ...ctx,
    findingsCount: findings.length,
    resultsConsidered,
    durationMs,
  })

  return {
    skipped: false,
    findings,
    sbom,
    telemetry: {
      scanned: true,
      resultsConsidered,
      findingsCount: findings.length,
      truncatedCount,
      filteredOutByDiff,
      filteredOutByPath,
      filteredOutByConfig,
      durationMs,
      ...(stale ? { staleReport: stale } : {}),
    },
  }
}
