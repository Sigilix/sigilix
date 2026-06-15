export const FINDING_MORE_INFO_SECTION_KEYS = [
  "threatModel",
  "codeCitations",
  "existingProtections",
  "mitigation",
  "alternatives",
  "severityCalibration",
] as const

export type FindingMoreInfoSectionKey = (typeof FINDING_MORE_INFO_SECTION_KEYS)[number]

export const FINDING_MORE_INFO_SECTION_LABELS: Record<FindingMoreInfoSectionKey, string> = {
  threatModel: "Threat model",
  codeCitations: "Specific code citations",
  existingProtections: "Existing protections",
  mitigation: "Proposed mitigation",
  alternatives: "Alternative mitigations considered",
  severityCalibration: "Severity calibration",
}

export type FindingMoreInfo = Partial<Record<FindingMoreInfoSectionKey, string>>

export const FINDING_MORE_INFO_DETAIL_LIMIT = 2000

export function normalizeMoreInfoSection(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  let clean = value.trim()
  const fenced = clean.match(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```(?:\r?\n([\s\S]*))?$/)
  if (fenced)
    clean = [fenced[1], fenced[2]]
      .filter((part): part is string => typeof part === "string")
      .join("\n")
      .trim()
  if (clean.length === 0) return undefined
  if (clean.length > FINDING_MORE_INFO_DETAIL_LIMIT) {
    clean = clean.slice(0, FINDING_MORE_INFO_DETAIL_LIMIT).trimEnd()
  }
  return clean.length > 0 ? clean : undefined
}

export function normalizeFindingMoreInfo(value: unknown): FindingMoreInfo | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const normalized: FindingMoreInfo = {}
  for (const key of FINDING_MORE_INFO_SECTION_KEYS) {
    const section = normalizeMoreInfoSection(record[key])
    if (section) normalized[key] = section
  }
  return hasFindingMoreInfo(normalized) ? normalized : undefined
}

export function hasFindingMoreInfo(value: FindingMoreInfo | undefined): value is FindingMoreInfo {
  return (
    value !== undefined &&
    FINDING_MORE_INFO_SECTION_KEYS.some((key) => {
      const section = value[key]
      return typeof section === "string" && section.trim().length > 0
    })
  )
}
