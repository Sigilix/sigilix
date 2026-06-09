// SIG-382: the raw → SigilixConfig parser, carved out of the
// `src/lib/sigilix-config.ts` god-file. Pure (no IO). The shim at
// `src/lib/sigilix-config.ts` re-exports everything here for the existing
// importers. See docs/superpowers/plans/2026-06-09-sig-382-config-split.md.

import type { SpecialistRole } from "@/shared/domain/specialist-role"
import { parseDeterministicChecks } from "@/shared/domain/deterministic-checks"
import {
  KNOWN_MODELS,
  SPECIALIST_ROLES,
  type DispatcherConfig,
  type DispatcherSafetyNetPattern,
  type ReviewMemoryCategoryRef,
  type SarifFindingCategoryRef,
  type SigilixCommandConfig,
  type SigilixCommandModelConfig,
  type SigilixCommandName,
  type SigilixConfig,
  type SigilixPathInstruction,
} from "./types"

const SARIF_FINDING_CATEGORIES: ReadonlySet<SarifFindingCategoryRef> = new Set([
  "iac", "misconfiguration", "vulnerability", "license", "secret", "other",
])

const COMMAND_NAMES: ReadonlySet<SigilixCommandName> = new Set([
  "review",
  "improve",
  "describe",
  "ask",
])

const ADDENDUM_MAX_CODE_POINTS = 4000
const FALLBACKS_MAX_ENTRIES = 4
const PATH_INSTRUCTIONS_MAX_ENTRIES = 20
const PATH_INSTRUCTIONS_MAX_PATHS = 50
const PATH_INSTRUCTIONS_TEXT_MAX_CODE_POINTS = 4000

// SIG-110: perfBudgets numeric bounds. Latency in ms (1ms .. 10min);
// bundle size in KB (1KB .. 1GB). Out-of-range values drop silently.
const LATENCY_BUDGET_MS_MIN = 1
const LATENCY_BUDGET_MS_MAX = 600_000
const BUNDLE_SIZE_KB_MIN = 1
const BUNDLE_SIZE_KB_MAX = 1_000_000

// ARC-273: cost-control patch-length bounds. The parser accepts
// `costControls.maxPatchLength` only within [MIN, MAX]; out-of-range
// values fall back to the default (resolved in resolve.ts).
const MAX_PATCH_LENGTH_MIN = 1_000
const MAX_PATCH_LENGTH_MAX = 200_000

/**
 * ARC-185: tagged result of `parseSigilixConfigDetailed`. The detail
 * surface is the new entry point — preserves the parse-error reason
 * so the caller can post a PR comment with a specific message rather
 * than a generic "config invalid". Existing call sites that don't
 * need the reason keep using the legacy `parseSigilixConfig`
 * signature (which is now a thin wrapper).
 */
export type ParseResult =
  | { ok: true; config: SigilixConfig }
  | { ok: false; reason: string; raw: string }

function codePointLength(s: string): number {
  let n = 0
  for (const _ of s) n += 1
  return n
}

function takeCodePoints(s: string, max: number): string {
  if (codePointLength(s) <= max) return s
  return [...s].slice(0, max).join("")
}

function parseOptionalInstructionText(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined
  const trimmed = v.trim()
  if (trimmed.length === 0) return undefined
  return takeCodePoints(trimmed, PATH_INSTRUCTIONS_TEXT_MAX_CODE_POINTS)
}

function parseInstructionPaths(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? [v] : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== "string") continue
    const trimmed = item.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
    if (out.length >= PATH_INSTRUCTIONS_MAX_PATHS) break
  }
  return out
}

function parseRoleRules(v: unknown): Partial<Record<SpecialistRole, string>> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined
  const rulesIn = v as Record<string, unknown>
  const rulesOut: Partial<Record<SpecialistRole, string>> = {}
  for (const role of SPECIALIST_ROLES) {
    const rule = parseOptionalInstructionText(rulesIn[role])
    if (rule) rulesOut[role] = rule
  }
  return Object.keys(rulesOut).length > 0 ? rulesOut : undefined
}

function parsePathInstructions(v: unknown): SigilixPathInstruction[] {
  if (!Array.isArray(v)) return []
  const out: SigilixPathInstruction[] = []
  for (const item of v) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const rec = item as Record<string, unknown>
    const paths = parseInstructionPaths(rec.paths ?? rec.path)
    if (paths.length === 0) continue
    const guidance = parseOptionalInstructionText(rec.guidance ?? rec.instructions)
    const rules = parseRoleRules(rec.rules)
    if (!guidance && !rules) continue
    out.push({
      paths,
      ...(guidance ? { guidance } : {}),
      ...(rules ? { rules } : {}),
    })
    if (out.length >= PATH_INSTRUCTIONS_MAX_ENTRIES) break
  }
  return out
}

const SPECIALIST_ROLE_SET: ReadonlySet<SpecialistRole> = new Set(SPECIALIST_ROLES)

const DISPATCHER_MAX_ADDITIONAL_PATTERNS = 50

/**
 * SIG-224: parse the optional `dispatcher` block of `sigilix.json`.
 * Fail-open like the rest of the config parser — bad entries are
 * dropped silently, missing fields default to undefined. Returns
 * undefined when nothing parseable remains so the caller can skip
 * writing the field (keeps the resulting `SigilixConfig` minimal).
 *
 * Phase 0 (SIG-224) ships the schema only — no call site consumes the
 * parsed value yet. Phase 1 (SIG-226) wires the shadow dispatcher.
 */
function parseDispatcherConfig(v: unknown): DispatcherConfig | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined
  const rec = v as Record<string, unknown>
  const out: DispatcherConfig = {}

  if (Array.isArray(rec.force)) {
    const force: SpecialistRole[] = []
    const seen = new Set<SpecialistRole>()
    for (const entry of rec.force) {
      if (typeof entry !== "string") continue
      const trimmed = entry.trim() as SpecialistRole
      if (!SPECIALIST_ROLE_SET.has(trimmed)) continue
      if (seen.has(trimmed)) continue
      seen.add(trimmed)
      force.push(trimmed)
    }
    if (force.length > 0) out.force = force
  }

  if (rec.safetyNet && typeof rec.safetyNet === "object" && !Array.isArray(rec.safetyNet)) {
    const sn = rec.safetyNet as Record<string, unknown>
    if (Array.isArray(sn.additionalPatterns)) {
      const patterns: DispatcherSafetyNetPattern[] = []
      for (const entry of sn.additionalPatterns) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
        const e = entry as Record<string, unknown>
        if (typeof e.glob !== "string") continue
        const glob = e.glob.trim()
        if (glob.length === 0) continue
        if (typeof e.role !== "string") continue
        const role = e.role.trim() as SpecialistRole
        if (!SPECIALIST_ROLE_SET.has(role)) continue
        patterns.push({ glob, role })
        if (patterns.length >= DISPATCHER_MAX_ADDITIONAL_PATTERNS) break
      }
      if (patterns.length > 0) {
        out.safetyNet = { additionalPatterns: patterns }
      }
    }
  }

  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Defensively parse a candidate `sigilix.json` body. Returns null on
 * any structural problem (not JSON, not an object, fields wrong type)
 * so the caller can fall back to `EMPTY_CONFIG` and log a warning.
 *
 * Unknown fields are ignored (forward-compatible). Known fields with
 * wrong types are dropped silently in v1 — strict mode can come later
 * once the schema stabilizes.
 */
export function parseSigilixConfig(raw: string): SigilixConfig | null {
  const result = parseSigilixConfigDetailed(raw)
  return result.ok ? result.config : null
}

/**
 * ARC-185: detailed parser used by the slash-command dispatch path
 * to surface a parse-error PR comment with a specific reason. The
 * legacy `parseSigilixConfig` is now a thin wrapper over this
 * function (see above) — single source of truth for validation.
 *
 * Returns:
 *   - `{ok: true, config}` when raw is parseable AND every field
 *     respects the schema contract
 *   - `{ok: false, reason, raw}` on any structural / validation
 *     failure. `raw` is preserved so the caller can include the
 *     first-N-chars in a parse-error PR comment.
 *
 * Validation strictness for ARC-185 fields is documented inline.
 * Pre-ARC-185 fields keep the v1 forgiving-on-unknown semantics so
 * existing valid configs don't regress.
 */
export function parseSigilixConfigDetailed(raw: string): ParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : "JSON parse failed"
    return { ok: false, reason: `JSON parse failed: ${msg}`, raw }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: "Top-level value must be a JSON object (got array or non-object)",
      raw,
    }
  }
  const obj = parsed as Record<string, unknown>
  const out: SigilixConfig = {}
  if (typeof obj.guidance === "string" && obj.guidance.length > 0) {
    out.guidance = obj.guidance
  }
  if (obj.rules && typeof obj.rules === "object" && !Array.isArray(obj.rules)) {
    const rulesIn = obj.rules as Record<string, unknown>
    const rulesOut: Partial<Record<SpecialistRole, string>> = {}
    for (const role of SPECIALIST_ROLES) {
      const v = rulesIn[role]
      if (typeof v === "string" && v.length > 0) {
        rulesOut[role] = v
      }
    }
    if (Object.keys(rulesOut).length > 0) out.rules = rulesOut
  }
  // Path-scoped review instructions. Mirrors the competitor pattern
  // of path-specific guidance while preserving Sigilix's existing
  // fail-open parser contract: bad entries are dropped, not fatal.
  const pathInstructions = parsePathInstructions(obj.pathInstructions)
  if (pathInstructions.length > 0) out.pathInstructions = pathInstructions
  // ARC-193: deterministicChecks parsing delegated to the runner module
  // so the schema stays co-located with the runtime that consumes it.
  if (obj.deterministicChecks !== undefined) {
    const checks = parseDeterministicChecks(obj.deterministicChecks)
    if (checks.length > 0) out.deterministicChecks = checks
  }
  // ARC-176: pathFilters — glob-pattern include/exclude with `!`
  // negation. Drop entries that aren't strings; bad globs are
  // tolerated downstream (compileGlob throws → caller skips).
  if (Array.isArray(obj.pathFilters)) {
    const filters = obj.pathFilters.filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    )
    if (filters.length > 0) out.pathFilters = filters
  }
  // ARC-176: profile — accept only the two known values; anything
  // else falls back to default (omitted = chill behavior).
  if (obj.profile === "chill" || obj.profile === "assertive") {
    out.profile = obj.profile
  }
  // ARC-191: describe.enabled — strict boolean parsing only.
  // `Boolean(v)` would treat the string `"false"` as truthy. Only
  // a literal JavaScript boolean `true` or `false` is recognized;
  // anything else drops the field, which the handler treats as
  // missing = enabled. Unknown subfields under describe are
  // ignored (forward-compat for future fields like describe.tone,
  // describe.maxWords, etc., which would land under a separate
  // Linear issue, e.g. ARC-185).
  if (
    obj.describe &&
    typeof obj.describe === "object" &&
    !Array.isArray(obj.describe)
  ) {
    const describeIn = obj.describe as Record<string, unknown>
    if (typeof describeIn.enabled === "boolean") {
      out.describe = { enabled: describeIn.enabled }
    }
  }
  // SIG-84: overview.enabled — strict boolean parsing, same shape as
  // describe.enabled. Forward-compat: unknown subfields under
  // `overview` are ignored so future additions (overview.maxFiles,
  // overview.profile, etc.) can ship without breaking older configs.
  if (
    obj.overview &&
    typeof obj.overview === "object" &&
    !Array.isArray(obj.overview)
  ) {
    const overviewIn = obj.overview as Record<string, unknown>
    if (typeof overviewIn.enabled === "boolean") {
      out.overview = { enabled: overviewIn.enabled }
    }
  }
  // SIG-112: evidence.visible — strict-bool opt-IN. Unknown subfields
  // are ignored so future evidence settings can ship compatibly.
  if (
    obj.evidence &&
    typeof obj.evidence === "object" &&
    !Array.isArray(obj.evidence)
  ) {
    const evidenceIn = obj.evidence as Record<string, unknown>
    if (typeof evidenceIn.visible === "boolean") {
      out.evidence = { visible: evidenceIn.visible }
    }
  }
  // SIG-135: labels.enabled — strict boolean parsing, same opt-OUT
  // polarity as overview.enabled. Unknown subfields under `labels`
  // are ignored so future label settings can ship compatibly.
  if (
    obj.labels &&
    typeof obj.labels === "object" &&
    !Array.isArray(obj.labels)
  ) {
    const labelsIn = obj.labels as Record<string, unknown>
    if (typeof labelsIn.enabled === "boolean") {
      out.labels = { enabled: labelsIn.enabled }
    }
  }
  // ARC-185: commands.<cmd>.{prompt.addendum, model.{primary, fallbacks}}
  if (obj.commands !== undefined) {
    if (typeof obj.commands !== "object" || obj.commands === null || Array.isArray(obj.commands)) {
      return { ok: false, reason: "`commands` must be an object", raw }
    }
    const commandsIn = obj.commands as Record<string, unknown>
    const commandsOut: Partial<Record<SigilixCommandName, SigilixCommandConfig>> = {}
    for (const [key, value] of Object.entries(commandsIn)) {
      if (!COMMAND_NAMES.has(key as SigilixCommandName)) {
        return {
          ok: false,
          reason: `unknown command \`${key}\` in \`commands\`. Valid commands: ${[...COMMAND_NAMES].join(", ")}`,
          raw,
        }
      }
      const cmdName = key as SigilixCommandName
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {
          ok: false,
          reason: `\`commands.${key}\` must be an object`,
          raw,
        }
      }
      const cmdIn = value as Record<string, unknown>
      const cmdOut: SigilixCommandConfig = {}
      if (cmdIn.prompt !== undefined) {
        if (typeof cmdIn.prompt !== "object" || cmdIn.prompt === null || Array.isArray(cmdIn.prompt)) {
          return { ok: false, reason: `\`commands.${key}.prompt\` must be an object`, raw }
        }
        const promptIn = cmdIn.prompt as Record<string, unknown>
        if (promptIn.addendum !== undefined) {
          if (typeof promptIn.addendum !== "string") {
            return { ok: false, reason: `\`commands.${key}.prompt.addendum\` must be a string`, raw }
          }
          if (codePointLength(promptIn.addendum) > ADDENDUM_MAX_CODE_POINTS) {
            return {
              ok: false,
              reason: `\`commands.${key}.prompt.addendum\` exceeds maximum length of ${ADDENDUM_MAX_CODE_POINTS} code points`,
              raw,
            }
          }
          if (promptIn.addendum.length > 0) {
            cmdOut.prompt = { addendum: promptIn.addendum }
          }
        }
      }
      if (cmdIn.model !== undefined) {
        if (typeof cmdIn.model !== "object" || cmdIn.model === null || Array.isArray(cmdIn.model)) {
          return { ok: false, reason: `\`commands.${key}.model\` must be an object`, raw }
        }
        const modelIn = cmdIn.model as Record<string, unknown>
        const modelOut: SigilixCommandModelConfig = {}
        if (modelIn.primary !== undefined) {
          if (typeof modelIn.primary !== "string") {
            return { ok: false, reason: `\`commands.${key}.model.primary\` must be a string`, raw }
          }
          const trimmed = modelIn.primary.trim()
          if (trimmed.length === 0) {
            return {
              ok: false,
              reason: `\`commands.${key}.model.primary\` must be a non-empty string after trimming`,
              raw,
            }
          }
          if (!KNOWN_MODELS.has(trimmed)) {
            return {
              ok: false,
              reason: `\`commands.${key}.model.primary\` references an unknown model \`${trimmed}\` (not in routing registry). Check the spelling, or contact ops if it should be supported.`,
              raw,
            }
          }
          modelOut.primary = trimmed
        }
        if (modelIn.fallbacks !== undefined) {
          if (!Array.isArray(modelIn.fallbacks)) {
            return { ok: false, reason: `\`commands.${key}.model.fallbacks\` must be an array of strings`, raw }
          }
          if (modelIn.fallbacks.length > FALLBACKS_MAX_ENTRIES) {
            return {
              ok: false,
              reason: `\`commands.${key}.model.fallbacks\` accepts at most ${FALLBACKS_MAX_ENTRIES} entries`,
              raw,
            }
          }
          const fb: string[] = []
          for (const item of modelIn.fallbacks) {
            if (typeof item !== "string") {
              return {
                ok: false,
                reason: `\`commands.${key}.model.fallbacks\` entries must be strings`,
                raw,
              }
            }
            const trimmed = item.trim()
            if (trimmed.length === 0) {
              return {
                ok: false,
                reason: `\`commands.${key}.model.fallbacks\` entries must be non-empty after trimming`,
                raw,
              }
            }
            if (!KNOWN_MODELS.has(trimmed)) {
              return {
                ok: false,
                reason: `\`commands.${key}.model.fallbacks\` references an unknown model \`${trimmed}\` (not in routing registry).`,
                raw,
              }
            }
            fb.push(trimmed)
          }
          modelOut.fallbacks = fb
        }
        if (Object.keys(modelOut).length > 0) {
          cmdOut.model = modelOut
        }
      }
      if (Object.keys(cmdOut).length > 0) {
        commandsOut[cmdName] = cmdOut
      }
    }
    if (Object.keys(commandsOut).length > 0) {
      out.commands = commandsOut
    }
  }
  // ARC-186: depVulnScan.enabled — same strict-bool semantics as
  // describe.enabled. Unknown subfields ignored (forward-compat).
  if (
    obj.depVulnScan &&
    typeof obj.depVulnScan === "object" &&
    !Array.isArray(obj.depVulnScan)
  ) {
    const depIn = obj.depVulnScan as Record<string, unknown>
    if (typeof depIn.enabled === "boolean") {
      out.depVulnScan = { enabled: depIn.enabled }
    }
  }
  // ARC-181: astRules — locked defaults at resolveAstRulesConfig time.
  if (
    obj.astRules &&
    typeof obj.astRules === "object" &&
    !Array.isArray(obj.astRules)
  ) {
    const astIn = obj.astRules as Record<string, unknown>
    const astOut: NonNullable<SigilixConfig["astRules"]> = {}
    if (typeof astIn.enabled === "boolean") {
      astOut.enabled = astIn.enabled
    }
    if (
      astIn.severityThreshold === "info" ||
      astIn.severityThreshold === "warning" ||
      astIn.severityThreshold === "error"
    ) {
      astOut.severityThreshold = astIn.severityThreshold
    }
    if (Array.isArray(astIn.disabledRules)) {
      const ids = [...new Set(
        astIn.disabledRules
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter((v) => v.length > 0),
      )]
      astOut.disabledRules = ids
    }
    if (typeof astIn.autoInline === "boolean") {
      astOut.autoInline = astIn.autoInline
    }
    if (Object.keys(astOut).length > 0) {
      out.astRules = astOut
    }
  }
  // ARC-188: sarifEvidence — single-file SARIF channel config.
  if (
    obj.sarifEvidence &&
    typeof obj.sarifEvidence === "object" &&
    !Array.isArray(obj.sarifEvidence)
  ) {
    const sarifIn = obj.sarifEvidence as Record<string, unknown>
    const sarifOut: NonNullable<SigilixConfig["sarifEvidence"]> = {}
    if (typeof sarifIn.enabled === "boolean") {
      sarifOut.enabled = sarifIn.enabled
    }
    if (typeof sarifIn.path === "string" && sarifIn.path.trim().length > 0) {
      sarifOut.path = sarifIn.path.trim()
    }
    if (
      sarifIn.severityThreshold === "info" ||
      sarifIn.severityThreshold === "warning" ||
      sarifIn.severityThreshold === "error"
    ) {
      sarifOut.severityThreshold = sarifIn.severityThreshold
    }
    if (Array.isArray(sarifIn.disabledRules)) {
      const ids = [...new Set(
        sarifIn.disabledRules
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter((v) => v.length > 0),
      )]
      sarifOut.disabledRules = ids
    }
    if (Array.isArray(sarifIn.disabledCategories)) {
      const cats = [...new Set(
        sarifIn.disabledCategories
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter((v): v is SarifFindingCategoryRef => SARIF_FINDING_CATEGORIES.has(v as SarifFindingCategoryRef)),
      )]
      sarifOut.disabledCategories = cats
    }
    if (Object.keys(sarifOut).length > 0) {
      out.sarifEvidence = sarifOut
    }
  }
  // SIG-118: coverage — coverage-diff ingestion (default OFF). Only the
  // literal "github-actions-artifact" opts in; anything else (including
  // the explicit "off") leaves the resolver on its default-OFF path.
  if (
    obj.coverage &&
    typeof obj.coverage === "object" &&
    !Array.isArray(obj.coverage)
  ) {
    const covIn = obj.coverage as Record<string, unknown>
    const covOut: NonNullable<SigilixConfig["coverage"]> = {}
    if (covIn.source === "github-actions-artifact" || covIn.source === "off") {
      covOut.source = covIn.source
    }
    if (typeof covIn.artifactName === "string" && covIn.artifactName.trim().length > 0) {
      covOut.artifactName = covIn.artifactName.trim()
    }
    if (typeof covIn.entry === "string" && covIn.entry.trim().length > 0) {
      covOut.entry = covIn.entry.trim()
    }
    if (Object.keys(covOut).length > 0) {
      out.coverage = covOut
    }
  }
  // ARC-189: reviewMemory — cross-PR review memory (default OFF).
  if (
    obj.reviewMemory &&
    typeof obj.reviewMemory === "object" &&
    !Array.isArray(obj.reviewMemory)
  ) {
    const rmIn = obj.reviewMemory as Record<string, unknown>
    const rmOut: NonNullable<SigilixConfig["reviewMemory"]> = {}
    // Strict-bool: only literal true opts in. Truthy non-bool (1, "true")
    // is silently dropped — the default-OFF polarity makes the strict
    // check semantically meaningful.
    if (rmIn.enabled === true || rmIn.enabled === false) {
      rmOut.enabled = rmIn.enabled
    }
    if (rmIn.captureOnly === true || rmIn.captureOnly === false) {
      rmOut.captureOnly = rmIn.captureOnly
    }
    if (Array.isArray(rmIn.categories)) {
      const seen = new Set<ReviewMemoryCategoryRef>()
      for (const v of rmIn.categories) {
        if (typeof v !== "string") continue
        const trimmed = v.trim()
        if (REVIEW_MEMORY_CATEGORIES.has(trimmed as ReviewMemoryCategoryRef)) {
          seen.add(trimmed as ReviewMemoryCategoryRef)
        }
      }
      rmOut.categories = [...seen]
    }
    if (typeof rmIn.maxInjectedMemories === "number") {
      rmOut.maxInjectedMemories = clamp(rmIn.maxInjectedMemories, 1, 10)
    }
    if (typeof rmIn.minSignalThreshold === "number") {
      rmOut.minSignalThreshold = clamp(rmIn.minSignalThreshold, 2, 20)
    }
    if (typeof rmIn.maxSignalAgeDays === "number") {
      rmOut.maxSignalAgeDays = clamp(rmIn.maxSignalAgeDays, 7, 365)
    }
    // SIG-280: strict-bool, mirroring enabled/captureOnly. Without this copy
    // the field is dropped by the whitelist and `resolveReviewMemoryConfig`
    // (which reads `cfg?.claimSoftening`) always sees false on the real
    // sigilix.json load path (CodeRabbit catch on PR #210).
    if (rmIn.claimSoftening === true || rmIn.claimSoftening === false) {
      rmOut.claimSoftening = rmIn.claimSoftening
    }
    if (Object.keys(rmOut).length > 0) {
      out.reviewMemory = rmOut
    }
  }
  // ARC-265/SIG-135: customLabels parsing. Strict-ish: each entry
  // must be an object with non-empty string name + description. Bad
  // entries are dropped (forward-compat: a typo in one entry shouldn't
  // disable the whole feature). Preserve only an explicit empty array
  // as an empty allowlist; a non-empty array with zero valid entries
  // is treated as missing config so repo-label fallback still works.
  if (Array.isArray(obj.customLabels)) {
    const labels: NonNullable<SigilixConfig["customLabels"]> = []
    const seen = new Set<string>()
    for (const item of obj.customLabels) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue
      const rec = item as Record<string, unknown>
      const name = typeof rec.name === "string" ? rec.name.trim() : ""
      const description = typeof rec.description === "string" ? rec.description.trim() : ""
      if (name.length === 0 || description.length === 0) continue
      if (seen.has(name)) continue // dedupe by name within config
      seen.add(name)
      labels.push({ name, description })
    }
    if (obj.customLabels.length === 0 || labels.length > 0) {
      out.customLabels = labels
    }
  }
  // ARC-273: costControls parsing. Strict bounds on numbers + string
  // arrays; bad entries dropped silently (fail-open per the existing
  // sigilix-config convention).
  if (obj.costControls && typeof obj.costControls === "object" && !Array.isArray(obj.costControls)) {
    const ccIn = obj.costControls as Record<string, unknown>
    const ccOut: NonNullable<SigilixConfig["costControls"]> = {}
    if (typeof ccIn.maxPatchLength === "number" && Number.isFinite(ccIn.maxPatchLength)) {
      const v = Math.round(ccIn.maxPatchLength)
      if (v >= MAX_PATCH_LENGTH_MIN && v <= MAX_PATCH_LENGTH_MAX) {
        ccOut.maxPatchLength = v
      }
    }
    if (Array.isArray(ccIn.runOnLabels)) {
      const labels = [...new Set(
        ccIn.runOnLabels
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter((v) => v.length > 0),
      )]
      if (labels.length > 0) ccOut.runOnLabels = labels
    }
    if (Object.keys(ccOut).length > 0) out.costControls = ccOut
  }
  // ARC-272: docsReview parsing. Strict-bool `enabled`; string arrays
  // with trim+dedupe for both glob lists.
  if (obj.docsReview && typeof obj.docsReview === "object" && !Array.isArray(obj.docsReview)) {
    const drIn = obj.docsReview as Record<string, unknown>
    const drOut: NonNullable<SigilixConfig["docsReview"]> = {}
    if (typeof drIn.enabled === "boolean") {
      drOut.enabled = drIn.enabled
    }
    if (Array.isArray(drIn.architectureGlobs)) {
      const globs = [...new Set(
        drIn.architectureGlobs
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter((v) => v.length > 0),
      )]
      if (globs.length > 0) drOut.architectureGlobs = globs
    }
    if (Array.isArray(drIn.docPaths)) {
      const paths = [...new Set(
        drIn.docPaths
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter((v) => v.length > 0),
      )]
      if (paths.length > 0) drOut.docPaths = paths
    }
    if (Object.keys(drOut).length > 0) out.docsReview = drOut
  }
  // SIG-100: preMergeGates parsing. Each sub-gate independently
  // validated; unknown fields dropped silently (matches the rest of
  // the parser's "v1 forgiving-on-unknown" semantics). Severity is
  // an enum; bad values fall through to the runtime default via
  // `resolvePreMergeGatesConfig`.
  if (obj.preMergeGates && typeof obj.preMergeGates === "object" && !Array.isArray(obj.preMergeGates)) {
    const gatesIn = obj.preMergeGates as Record<string, unknown>
    const gatesOut: NonNullable<SigilixConfig["preMergeGates"]> = {}
    const validSeverity = (v: unknown): v is "info" | "warning" | "error" =>
      v === "info" || v === "warning" || v === "error"
    if (gatesIn.titleFormat && typeof gatesIn.titleFormat === "object" && !Array.isArray(gatesIn.titleFormat)) {
      const tIn = gatesIn.titleFormat as Record<string, unknown>
      const tOut: NonNullable<NonNullable<SigilixConfig["preMergeGates"]>["titleFormat"]> = {}
      if (typeof tIn.enabled === "boolean") tOut.enabled = tIn.enabled
      if (validSeverity(tIn.severity)) tOut.severity = tIn.severity
      if (typeof tIn.regex === "string" && tIn.regex.length > 0) tOut.regex = tIn.regex
      if (Object.keys(tOut).length > 0) gatesOut.titleFormat = tOut
    }
    if (gatesIn.descriptionCompleteness && typeof gatesIn.descriptionCompleteness === "object" && !Array.isArray(gatesIn.descriptionCompleteness)) {
      const dIn = gatesIn.descriptionCompleteness as Record<string, unknown>
      const dOut: NonNullable<NonNullable<SigilixConfig["preMergeGates"]>["descriptionCompleteness"]> = {}
      if (typeof dIn.enabled === "boolean") dOut.enabled = dIn.enabled
      if (validSeverity(dIn.severity)) dOut.severity = dIn.severity
      if (typeof dIn.minLength === "number" && Number.isFinite(dIn.minLength) && dIn.minLength >= 0) {
        dOut.minLength = Math.floor(dIn.minLength)
      }
      if (Array.isArray(dIn.template)) {
        const sections = dIn.template
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter((v) => v.length > 0)
        if (sections.length > 0) dOut.template = sections
      }
      if (Object.keys(dOut).length > 0) gatesOut.descriptionCompleteness = dOut
    }
    if (gatesIn.linkedIssue && typeof gatesIn.linkedIssue === "object" && !Array.isArray(gatesIn.linkedIssue)) {
      const lIn = gatesIn.linkedIssue as Record<string, unknown>
      const lOut: NonNullable<NonNullable<SigilixConfig["preMergeGates"]>["linkedIssue"]> = {}
      if (typeof lIn.enabled === "boolean") lOut.enabled = lIn.enabled
      if (validSeverity(lIn.severity)) lOut.severity = lIn.severity
      if (Object.keys(lOut).length > 0) gatesOut.linkedIssue = lOut
    }
    if (Object.keys(gatesOut).length > 0) out.preMergeGates = gatesOut
  }
  // SIG-110: perfBudgets parsing. Bounds-checked latency / bundle
  // numbers (out-of-range dropped silently, fail-open); hotPaths
  // trimmed + deduped with empties dropped (mirrors architectureGlobs).
  if (obj.perfBudgets && typeof obj.perfBudgets === "object" && !Array.isArray(obj.perfBudgets)) {
    const pbIn = obj.perfBudgets as Record<string, unknown>
    const pbOut: NonNullable<SigilixConfig["perfBudgets"]> = {}
    const readLatency = (v: unknown): number | undefined => {
      if (typeof v !== "number" || !Number.isFinite(v)) return undefined
      const n = Math.round(v)
      return n >= LATENCY_BUDGET_MS_MIN && n <= LATENCY_BUDGET_MS_MAX ? n : undefined
    }
    const p50 = readLatency(pbIn.p50LatencyBudgetMs)
    if (p50 !== undefined) pbOut.p50LatencyBudgetMs = p50
    const p95 = readLatency(pbIn.p95LatencyBudgetMs)
    if (p95 !== undefined) pbOut.p95LatencyBudgetMs = p95
    if (typeof pbIn.bundleSizeBudgetKb === "number" && Number.isFinite(pbIn.bundleSizeBudgetKb)) {
      const kb = Math.round(pbIn.bundleSizeBudgetKb)
      if (kb >= BUNDLE_SIZE_KB_MIN && kb <= BUNDLE_SIZE_KB_MAX) {
        pbOut.bundleSizeBudgetKb = kb
      }
    }
    if (Array.isArray(pbIn.hotPaths)) {
      const paths = [...new Set(
        pbIn.hotPaths
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter((v) => v.length > 0),
      )]
      if (paths.length > 0) pbOut.hotPaths = paths
    }
    if (Object.keys(pbOut).length > 0) out.perfBudgets = pbOut
  }
  // SIG-224: dispatcher parsing. Fail-open like every other section —
  // bad entries are dropped silently. The schema lands here so users
  // can write `dispatcher.*` ahead of Phase 1 wiring; Phase 0 ignores
  // the parsed value but does NOT reject it. See
  // `docs/specs/2026-05-26-sig-224-dispatcher-architecture.md`.
  const dispatcher = parseDispatcherConfig(obj.dispatcher)
  if (dispatcher !== undefined) out.dispatcher = dispatcher
  return { ok: true, config: out }
}

/** Pure clamp helper for the reviewMemory numeric fields. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)))
}

const REVIEW_MEMORY_CATEGORIES: ReadonlySet<ReviewMemoryCategoryRef> = new Set([
  "security",
  "logic",
  "performance",
  "tests",
  "architecture",
])
