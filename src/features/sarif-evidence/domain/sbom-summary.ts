// ARC-188: SBOM compact metadata block builder.
//
// Spec §3.6a: emit ≤ 20 lines summarizing what the SARIF report says
// about the dependency tree. Used by the synth (NOT specialists) for
// Fix Plan ordering — direct-dep findings outrank deep-transitive
// findings. Empty string when no SBOM run is present (omit-empty).
//
// Detection: a SARIF run is treated as SBOM when EITHER
//   - `runs[].tool.driver.properties.kind === "sbom"` (Trivy SBOM)
//   - `runs[].results[*].kind === "informational"` carrying a
//     taxonomy reference that resolves to an SBOM keyword
//
// Per-package metadata is read from `runs[].artifacts[*].properties`
// (Trivy emits `name`, `version`, `licenses`, `relationship`).

import type { SarifReport, SbomSummary, SarifArtifact } from "./types"

const TOP_N_PACKAGES = 10
const TOP_N_LICENSES = 6
const SBOM_RESULT_KIND = "informational"
const SBOM_TOOL_KIND = "sbom"

interface SbomPackage {
  name: string
  version?: string
  license?: string
  isDirect: boolean
}

function isSbomRun(run: SarifReport["runs"][number]): boolean {
  if (run.tool?.driver?.properties?.kind === SBOM_TOOL_KIND) return true
  // Result-level detection requires BOTH `kind === "informational"`
  // AND an SBOM taxonomy signal — Trivy emits `kind: "informational"`
  // for many non-SBOM things (suppressed findings, generic notes).
  // The spec header promised this taxa check; CR PR #68 caught the
  // implementation gap.
  if (Array.isArray(run.results)) {
    for (const r of run.results) {
      if (r.kind !== SBOM_RESULT_KIND) continue
      const hasSbomTaxaSignal =
        Array.isArray(r.taxa) && r.taxa.some((t) => typeof t.id === "string" && t.id.toLowerCase().includes("sbom"))
      if (hasSbomTaxaSignal) return true
    }
  }
  return false
}

function readArtifactPackage(a: SarifArtifact): SbomPackage | null {
  const props = a.properties ?? {}
  const name =
    typeof props.name === "string" ? props.name : typeof a.description?.text === "string" ? a.description.text : null
  if (!name) return null
  const version = typeof props.version === "string" ? props.version : undefined
  const licenses = Array.isArray(props.licenses)
    ? (props.licenses as unknown[]).filter((v): v is string => typeof v === "string")
    : typeof props.license === "string"
      ? [props.license]
      : []
  const license = licenses[0]
  const relationship = typeof props.relationship === "string" ? props.relationship : null
  const isDirect = relationship === "direct" || relationship === "root"
  const pkg: SbomPackage = { name, isDirect }
  if (version !== undefined) pkg.version = version
  if (license !== undefined) pkg.license = license
  return pkg
}

export function buildSbomSummary(report: SarifReport): SbomSummary {
  const packages: SbomPackage[] = []
  let foundSbomRun = false

  for (const run of report.runs) {
    if (!isSbomRun(run)) continue
    foundSbomRun = true
    if (!Array.isArray(run.artifacts)) continue
    for (const a of run.artifacts) {
      const pkg = readArtifactPackage(a)
      if (pkg) packages.push(pkg)
    }
  }

  if (!foundSbomRun) {
    return {
      text: "",
      present: false,
      packageCount: 0,
      directDepCount: 0,
      licenseCounts: {},
    }
  }

  const total = packages.length
  const direct = packages.filter((p) => p.isDirect)
  const directCount = direct.length

  // License aggregation
  const licenseCounts: Record<string, number> = {}
  for (const p of packages) {
    if (!p.license) continue
    licenseCounts[p.license] = (licenseCounts[p.license] ?? 0) + 1
  }

  // Top-N license summary string
  const sortedLicenses = Object.entries(licenseCounts).sort((a, b) => b[1] - a[1])
  const topLicenses = sortedLicenses.slice(0, TOP_N_LICENSES)
  const otherCount = sortedLicenses.slice(TOP_N_LICENSES).reduce((acc, [, c]) => acc + c, 0)
  const licenseSummary =
    topLicenses.map(([k, c]) => `${k}=${c}`).join(", ") + (otherCount > 0 ? `, Other=${otherCount}` : "")

  // Top-N direct deps for display (deterministic order: by name asc)
  const directNames = direct
    .map((p) => (p.version ? `${p.name}@${p.version}` : p.name))
    .sort()
    .slice(0, TOP_N_PACKAGES)

  const lines: string[] = []
  lines.push("[SBOM SUMMARY — pre-LLM]")
  lines.push(`Total packages: ${total}`)
  lines.push(`Direct deps: ${directCount} | Transitive: ${total - directCount}`)
  if (licenseSummary.length > 0) {
    lines.push(`License counts: ${licenseSummary}`)
  }
  if (directNames.length > 0) {
    lines.push(`Top-${directNames.length} packages by direct-dep ranking: ${directNames.join(", ")}`)
  }

  return {
    text: lines.join("\n"),
    present: true,
    packageCount: total,
    directDepCount: directCount,
    licenseCounts,
  }
}
