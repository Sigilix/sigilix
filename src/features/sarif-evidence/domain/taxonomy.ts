// ARC-188: SARIF taxonomy resolver.
//
// SARIF producers tag rules / results with category info inconsistently.
// v1 inspects (in order, first-match-wins per spec §3.6):
//   1. result-level `taxa[].toolComponent.guid` — de-referenced
//      against `runs[].taxonomies[]` for the canonical taxonomy name
//   2. `runs[].tool.driver.rules[].properties.tags[]`
//   3. `rule.id` substring matches (e.g. `AVD-KSV-` → Kubescape K8s)
//   4. `rule.name` substring matches
//   5. `rule.shortDescription.text` substring matches
//   6. `runs[].tool.driver.name` (e.g. `"Trivy"`, `"Kubescape"`)
//
// License findings route to `security` (Codex MAJOR #2 + Kimi MAJOR
// #2): Sigilix has no `compliance` roleHint; security is the closest
// superset for governance/compliance signal.
//
// Plan-v1 BLOCKING from Codex: `taxa` lives on `result`, not `rule`.
// Resolver signature takes both + run-level taxa + tool name.

import { parseRunnerMetadata } from "./runner-metadata"
import type { SarifFindingCategory, SarifResult, SarifRule, SarifTaxa, RoleHint, SarifEvidenceSource } from "./types"
import type { RunnerToolId } from "./runner-metadata"

export interface TaxonomyResolution {
  category: SarifFindingCategory
  roleHint: RoleHint
  roleHints?: RoleHint[]
  /** Whether the rule was tagged as SBOM — runner filters these out
   *  of findings (SBOM is metadata, not a finding; spec §3.6a). */
  isSbom: boolean
  toolId?: RunnerToolId
  source?: SarifEvidenceSource
  schemaWarning?: "unknown-schema-version"
}

interface ResolveArgs {
  result: SarifResult
  rule: SarifRule | null
  /** Run-level `runs[].taxonomies[].taxa[]` lookup table. */
  runTaxa?: SarifTaxa[]
  /** Raw `runs[].tool.driver.name`. */
  toolName: string
  /** Raw `runs[].tool.driver.properties`. */
  toolDriverProperties?: Record<string, unknown>
}

const SBOM_KEYWORDS: ReadonlySet<string> = new Set(["sbom"])

const IAC_KEYWORDS = ["kubernetes", "helm", "dockerfile", "terraform", "cloudformation", "iac", "misconfiguration"]
const VULN_KEYWORDS = ["vulnerability", "cve", "ghsa"]
const SECRET_KEYWORDS = ["secret", "credential"]
const LICENSE_KEYWORDS = ["license", "licensing", "spdx"]

function isIaCRuleId(id: string): boolean {
  return /^AVD-KSV-/i.test(id) || /^kubernetes-/i.test(id) || /^terraform-/i.test(id)
}

function isVulnRuleId(id: string): boolean {
  return /^CVE-\d/i.test(id) || /^GHSA-/i.test(id)
}

function pickCategory(haystacks: string[]): SarifFindingCategory | "sbom" | null {
  const blob = haystacks.join(" | ").toLowerCase()
  for (const k of SBOM_KEYWORDS) if (blob.includes(k)) return "sbom"
  for (const k of IAC_KEYWORDS) if (blob.includes(k)) return "iac"
  for (const k of LICENSE_KEYWORDS) if (blob.includes(k)) return "license"
  for (const k of VULN_KEYWORDS) if (blob.includes(k)) return "vulnerability"
  for (const k of SECRET_KEYWORDS) if (blob.includes(k)) return "secret"
  return null
}

function categoryToRoleHint(cat: SarifFindingCategory): RoleHint {
  // License → security (Codex MAJOR #2 + Kimi MAJOR #2). Sigilix
  // has no compliance specialist; security is the closest fit.
  switch (cat) {
    case "iac":
    case "misconfiguration":
    case "vulnerability":
    case "license":
    case "secret":
      return "security"
    case "other":
    default:
      return "security"
  }
}

export function resolveTaxonomy(args: ResolveArgs): TaxonomyResolution {
  const { result, rule, runTaxa, toolName } = args
  const runnerMetadata = parseRunnerMetadata(args.toolDriverProperties)

  // Source 1: result-level taxa references → run-level taxonomy table
  const taxaNames: string[] = []
  if (Array.isArray(result.taxa) && Array.isArray(runTaxa)) {
    for (const ref of result.taxa) {
      const guid = ref?.toolComponent?.guid
      const id = ref?.id
      for (const t of runTaxa) {
        if ((guid && t.guid === guid) || (id && t.id === id)) {
          if (typeof t.name === "string") taxaNames.push(t.name)
          if (typeof t.shortDescription?.text === "string") taxaNames.push(t.shortDescription.text)
        }
      }
    }
  }

  // Source 2: rule properties.tags
  const tags: string[] = Array.isArray(rule?.properties?.tags)
    ? (rule!.properties!.tags as unknown[]).filter((v): v is string => typeof v === "string")
    : []

  // Source 3-5: rule.id, rule.name, rule.shortDescription
  const ruleId = rule?.id ?? result.ruleId ?? ""
  const ruleName = rule?.name ?? ""
  const ruleShort = rule?.shortDescription?.text ?? ""

  // Source 6: tool.driver.name
  const toolKeyword = toolName

  // Quick ID-pattern checks (before keyword-blob match for precision)
  if (isVulnRuleId(ruleId)) {
    return applyRunnerMetadata({ category: "vulnerability", roleHint: "security", isSbom: false }, runnerMetadata)
  }
  if (isIaCRuleId(ruleId)) {
    return applyRunnerMetadata({ category: "iac", roleHint: "security", isSbom: false }, runnerMetadata)
  }

  // Keyword-blob match across all sources, in priority order.
  const sources = [...taxaNames, ...tags, ruleId, ruleName, ruleShort, toolKeyword]
  const cat = pickCategory(sources)
  if (cat === "sbom") {
    return applyRunnerMetadata({ category: "other", roleHint: "security", isSbom: true }, runnerMetadata)
  }
  if (cat !== null) {
    return applyRunnerMetadata({ category: cat, roleHint: categoryToRoleHint(cat), isSbom: false }, runnerMetadata)
  }

  // Default: security/other when nothing matches.
  return applyRunnerMetadata({ category: "other", roleHint: "security", isSbom: false }, runnerMetadata)
}

function applyRunnerMetadata(
  legacy: TaxonomyResolution,
  runnerMetadata: ReturnType<typeof parseRunnerMetadata>,
): TaxonomyResolution {
  if (runnerMetadata.ok) {
    if (legacy.isSbom) {
      return {
        ...legacy,
        toolId: runnerMetadata.metadata.toolId,
        source: runnerMetadata.metadata.source,
      }
    }
    const [primaryRole] = runnerMetadata.metadata.roleHints
    return {
      ...legacy,
      roleHint: primaryRole ?? legacy.roleHint,
      roleHints: [...runnerMetadata.metadata.roleHints],
      toolId: runnerMetadata.metadata.toolId,
      source: runnerMetadata.metadata.source,
    }
  }
  if (runnerMetadata.reason === "unknown-schema-version") {
    return { ...legacy, schemaWarning: "unknown-schema-version" }
  }
  return legacy
}
