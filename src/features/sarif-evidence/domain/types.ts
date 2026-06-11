// ARC-188: SARIF v2.1.0 evidence channel — types.
//
// Generic SARIF surface, Trivy + Kubescape are the prototype consumers
// in v1. The shapes preserve the fields the runner + SBOM builder
// actually read; we don't model the full SARIF schema (OASIS spec is
// huge and most fields are irrelevant to our pipeline).

export type Severity = "info" | "warning" | "error"

export type SarifFindingCategory = "iac" | "misconfiguration" | "vulnerability" | "license" | "secret" | "other"

export type RoleHint = "security" | "logic" | "performance" | "tests"
export type SarifEvidenceSource = "deterministic-tool"

export interface SarifDroppedResults {
  toolId: string
  droppedCount: number
  keptCount?: number
}

/** Run-level taxonomy table. SARIF puts the canonical taxonomy
 *  identifiers (e.g. CWE, OWASP, Trivy's misconfiguration registry)
 *  here so per-result `taxa[]` references can be de-referenced into
 *  human-readable names by the resolver (spec §3.6 / Codex BLOCKING #1
 *  on plan v1). */
export interface SarifTaxa {
  guid?: string
  id?: string
  name?: string
  shortDescription?: { text?: string }
  fullDescription?: { text?: string }
}

export interface SarifRule {
  id: string
  name?: string
  shortDescription?: { text?: string }
  fullDescription?: { text?: string }
  helpUri?: string
  help?: { text?: string; markdown?: string }
  properties?: {
    /** Trivy / Snyk pattern: array of taxonomy keywords. Resolver
     *  inspects this BEFORE falling back to ruleId-substring matches. */
    tags?: string[]
    /** SBOM detection signal (spec §3.6a). */
    kind?: string
    [key: string]: unknown
  }
}

export interface SarifArtifact {
  /** SARIF puts the URI under `location.uri`, not at the top level
   *  (Codex BLOCKING #2 on plan v1). */
  location?: {
    uri?: string
    uriBaseId?: string
  }
  description?: { text?: string }
  /** Per-package metadata for SBOM runs: name, version, license,
   *  direct/transitive flag etc. (Codex MAJOR #5 — preserve raw shape
   *  so the SBOM builder doesn't have to re-derive). */
  properties?: Record<string, unknown>
}

export interface SarifLocation {
  physicalLocation?: {
    artifactLocation?: {
      uri?: string
      uriBaseId?: string
      index?: number
    }
    region?: {
      startLine?: number
      endLine?: number
      startColumn?: number
      endColumn?: number
      snippet?: { text?: string }
    }
  }
  logicalLocations?: Array<{ name?: string; fullyQualifiedName?: string; kind?: string }>
}

export interface SarifResult {
  ruleId?: string
  /** SARIF severity tier — `error` / `warning` / `note` / `none`.
   *  v1 maps `note` → `info`, `none` → skipped (spec §3.5). */
  level?: "error" | "warning" | "note" | "none"
  message?: { text?: string; markdown?: string }
  locations?: SarifLocation[]
  /** SARIF SBOM-flavored entries set this to `"informational"`.
   *  Detected by the SBOM builder (spec §3.6a). */
  kind?: string
  /** Result-level taxonomy references — resolver de-references
   *  these against `runs[].taxonomies[]`. */
  taxa?: Array<{ id?: string; toolComponent?: { guid?: string } }>
  properties?: Record<string, unknown>
}

export interface SarifTool {
  driver: {
    name: string
    version?: string
    informationUri?: string
    rules?: SarifRule[]
    properties?: {
      /** SBOM run signal — Trivy SBOM scans set this. */
      kind?: string
      [key: string]: unknown
    }
  }
}

export interface SarifInvocation {
  /** ISO-8601 timestamp. Stale-report telemetry fires when this is
   *  older than 7 days (spec §3.1a). */
  endTimeUtc?: string
  startTimeUtc?: string
  executionSuccessful?: boolean
}

export interface SarifRun {
  tool: SarifTool
  results?: SarifResult[]
  artifacts?: SarifArtifact[]
  /** Run-level taxonomy table de-referenced by the resolver
   *  (spec §3.6, Codex BLOCKING #1 on plan v1). */
  taxonomies?: Array<{
    name?: string
    guid?: string
    taxa?: SarifTaxa[]
  }>
  invocations?: SarifInvocation[]
  properties?: Record<string, unknown>
}

export interface SarifReport {
  version: "2.1.0"
  $schema?: string
  runs: SarifRun[]
}

/** Canonical finding emitted into specialist + synth prompts. */
export interface SarifFinding {
  ruleId: string
  severity: Severity
  roleHint: RoleHint
  /** Multi-role deterministic routing; `roleHint` is the primary role. */
  roleHints?: RoleHint[]
  category: SarifFindingCategory
  /** Stable Sigilix runner tool id when SARIF carries valid runner metadata. */
  toolId?: string
  /** Deterministic source marker when SARIF carries valid runner metadata. */
  source?: SarifEvidenceSource
  /** Non-fatal metadata warning; legacy taxonomy fallback still applies. */
  schemaWarning?: string
  /** Compact run-level summary of deterministic results withheld before SARIF emission. */
  droppedResults?: SarifDroppedResults
  /** Post-normalization repo-relative path (spec §4.4). */
  path: string
  /** 1-based start line. Some IaC findings have no line — runner
   *  keeps them on path-only match (spec §4.5). */
  line?: number
  message: string
  ruleName?: string
  /** Truncated to 500 chars by the runner. */
  ruleHelpText?: string
  /** Raw `runs[].tool.driver.name` (e.g. `"Trivy"`, `"Kubescape"`).
   *  Kept as a free-string per Kimi NIT #6. */
  toolName: string
  /** SARIF `result.locations[].region.snippet.text`, ≤200 chars,
   *  whitespace-normalized + literal-redacted. */
  evidence?: string
}

/** Compact metadata block (spec §3.6a). Synth-only. */
export interface SbomSummary {
  /** Pre-rendered string ≤ 20 lines; empty when no SBOM run. */
  text: string
  /** Whether at least one SBOM run was detected. */
  present: boolean
  /** Counts for telemetry / future expansion. */
  packageCount: number
  directDepCount: number
  licenseCounts: Record<string, number>
}
