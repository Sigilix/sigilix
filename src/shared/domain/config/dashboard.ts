// SIG-191: the portal-writable review configuration is deliberately a
// separate, closed contract from `SigilixConfig`.
//
// `SigilixConfig` is a forward-compatible config-as-code surface and contains
// fields that can suppress files, scanners, rules, or entire reviews. The
// dashboard API must never accept those fields: an admin UI write has no code
// review and therefore may only shape prompts, presentation, and the existing
// non-blocking pre-merge checklist. Unknown fields are rejected so a portal
// control can never appear to save while doing nothing at review time.

import type { SigilixProfile } from "./types"

const MAX_RAW_BYTES = 65_536

export interface DashboardReviewConfig {
  /** Additive-only review guidance (framed before entering model prompts). */
  guidance?: string
  /** Review tone; never changes P0/P1 handling. */
  profile?: SigilixProfile
  /** Customer-visible sections in the PR overview comment. */
  overview?: {
    showSummary?: boolean
    showWalkthrough?: boolean
    showSequenceDiagram?: boolean
    showConfidence?: boolean
  }
  /** Enablement only. Regex, severity, and templates stay config-as-code. */
  preMergeGates?: {
    titleFormat?: { enabled?: boolean }
    descriptionCompleteness?: { enabled?: boolean }
    linkedIssue?: { enabled?: boolean }
  }
}

export type ParseDashboardReviewConfigResult =
  | { ok: true; config: DashboardReviewConfig }
  | { ok: false; reason: string }

const TOP_LEVEL_FIELDS = new Set(["guidance", "profile", "overview", "preMergeGates"])
const OVERVIEW_FIELDS = new Set(["showSummary", "showWalkthrough", "showSequenceDiagram", "showConfidence"])
const PRE_MERGE_GATE_FIELDS = new Set(["titleFormat", "descriptionCompleteness", "linkedIssue"])
const GATE_FIELDS = new Set(["enabled"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function firstUnknownField(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix: string,
): string | null {
  const key = Object.keys(value).find((candidate) => !allowed.has(candidate))
  return key === undefined ? null : `${prefix}${key}`
}

function parseOverview(value: unknown): ParseDashboardReviewConfigResult {
  if (!isRecord(value)) return { ok: false, reason: "`overview` must be an object" }
  const unknown = firstUnknownField(value, OVERVIEW_FIELDS, "overview.")
  if (unknown) return { ok: false, reason: `unknown dashboard config field \`${unknown}\`` }

  const overview: NonNullable<DashboardReviewConfig["overview"]> = {}
  for (const key of OVERVIEW_FIELDS) {
    if (!(key in value)) continue
    const candidate = value[key]
    if (typeof candidate !== "boolean") {
      return { ok: false, reason: `\`overview.${key}\` must be a boolean` }
    }
    overview[key as keyof typeof overview] = candidate
  }
  return { ok: true, config: Object.keys(overview).length > 0 ? { overview } : {} }
}

function parsePreMergeGates(value: unknown): ParseDashboardReviewConfigResult {
  if (!isRecord(value)) return { ok: false, reason: "`preMergeGates` must be an object" }
  const unknown = firstUnknownField(value, PRE_MERGE_GATE_FIELDS, "preMergeGates.")
  if (unknown) return { ok: false, reason: `unknown dashboard config field \`${unknown}\`` }

  const preMergeGates: NonNullable<DashboardReviewConfig["preMergeGates"]> = {}
  for (const key of PRE_MERGE_GATE_FIELDS) {
    if (!(key in value)) continue
    const candidate = value[key]
    if (!isRecord(candidate)) {
      return { ok: false, reason: `\`preMergeGates.${key}\` must be an object` }
    }
    const unknownGateField = firstUnknownField(candidate, GATE_FIELDS, `preMergeGates.${key}.`)
    if (unknownGateField) {
      return { ok: false, reason: `unknown dashboard config field \`${unknownGateField}\`` }
    }
    if (!("enabled" in candidate)) continue
    if (typeof candidate.enabled !== "boolean") {
      return { ok: false, reason: `\`preMergeGates.${key}.enabled\` must be a boolean` }
    }
    preMergeGates[key as keyof typeof preMergeGates] = { enabled: candidate.enabled }
  }
  return {
    ok: true,
    config: Object.keys(preMergeGates).length > 0 ? { preMergeGates } : {},
  }
}

/** Parse and canonicalize the portal-writable review configuration. */
export function parseDashboardReviewConfig(raw: string): ParseDashboardReviewConfigResult {
  if (new TextEncoder().encode(raw).length > MAX_RAW_BYTES) {
    return { ok: false, reason: "dashboard review config exceeds max size of 64KB" }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : "JSON parse failed"
    return { ok: false, reason: `JSON parse failed: ${message}` }
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: "Top-level value must be a JSON object (got array or non-object)" }
  }

  const unknown = firstUnknownField(parsed, TOP_LEVEL_FIELDS, "")
  if (unknown) return { ok: false, reason: `unknown dashboard config field \`${unknown}\`` }

  const config: DashboardReviewConfig = {}
  if ("guidance" in parsed) {
    if (typeof parsed.guidance !== "string") return { ok: false, reason: "`guidance` must be a string" }
    if (parsed.guidance.length > 0) config.guidance = parsed.guidance
  }
  if ("profile" in parsed) {
    if (parsed.profile !== "chill" && parsed.profile !== "assertive") {
      return { ok: false, reason: "`profile` must be `chill` or `assertive`" }
    }
    config.profile = parsed.profile
  }
  if ("overview" in parsed) {
    const result = parseOverview(parsed.overview)
    if (!result.ok) return result
    if (result.config.overview) config.overview = result.config.overview
  }
  if ("preMergeGates" in parsed) {
    const result = parsePreMergeGates(parsed.preMergeGates)
    if (!result.ok) return result
    if (result.config.preMergeGates) config.preMergeGates = result.config.preMergeGates
  }
  return { ok: true, config }
}
