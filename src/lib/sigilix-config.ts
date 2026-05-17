// Per-repo Sigilix config (ARC-174). Read from `sigilix.json` at the
// PR head SHA via the existing GitHub Contents API helper. Missing
// file = empty config (current behavior unchanged). Malformed JSON =
// empty config + structured warning logged but no failure (don't
// break the review just because config is bad — fail-open is the
// right policy for an opt-in feature).
//
// v1 schema (intentionally minimal — the goal is to ship the
// integration point, not to design the final schema; iterate as real
// usage informs what fields people want):
//
//   {
//     "guidance": "Free-form text prepended to every specialist +
//                  synthesizer prompt. E.g. 'This repo is a TS
//                  Cloudflare Worker. Reject any new class
//                  declarations.'",
//     "rules": {
//       "logic":       "Appended only to logic specialist's prompt.",
//       "security":    "Appended only to security specialist's prompt.",
//       "performance": "Appended only to performance specialist's prompt.",
//       "tests":       "Appended only to tests specialist's prompt."
//     }
//   }
//
// Out of scope for v1 (deferred to follow-up issues):
//   - `ignore` glob patterns (skip files matching) — needs glob matcher
//   - `requireFindings` — needs review-blocker integration
//   - YAML format support — JSON-only for v1
//   - JSON Schema validation — defer until field set stabilizes

import type { GitHubClient } from "./github"
import type { SpecialistRole } from "./ensemble-router"
import { parseDeterministicChecks, type DeterministicCheck } from "./deterministic-checks"

export const SIGILIX_CONFIG_PATH = "sigilix.json"

/**
 * ARC-176: review tone. `chill` (default) only flags must-fix
 * issues; `assertive` includes nits and style. Maps to a one-line
 * prefix on the specialist initial message; the model still weighs
 * context but the floor on flag-worthiness shifts.
 */
export type SigilixProfile = "chill" | "assertive"

export interface SigilixConfig {
  /** Repo-wide guidance prepended to every specialist + synthesizer prompt. */
  guidance?: string
  /**
   * Per-specialist-role rule appended only to that role's prompt. Lets
   * teams encode "the security specialist on this repo should always
   * check for X" without polluting the other roles' prompts.
   */
  rules?: Partial<Record<SpecialistRole, string>>
  /**
   * ARC-193: deterministic regex checks run BEFORE the LLM specialist
   * fanout. Each rule defines a JS regex matched against added diff
   * lines; matches surface as structured findings injected into the
   * specialist prompts as authoritative facts. Pure-LLM detection has
   * higher miss rates on flat patterns (TODO comments, console.log,
   * hardcoded secrets); deterministic checks close that gap cheaply.
   *
   * See `deterministic-checks.ts` for the runner + rendering.
   */
  deterministicChecks?: DeterministicCheck[]
  /**
   * ARC-176: glob-pattern filter that drops files from review BEFORE
   * specialist fanout. Plain pattern excludes; `!pattern` re-includes
   * (overrides earlier excludes). Saves token spend on lockfiles,
   * generated content, etc. AND triggers the existing "router said no
   * specialists" short-circuit when only filtered paths changed.
   *
   * Examples (using "GS" for globstar to avoid closing the JSDoc):
   *   ["dist/GS", "GS/*.lock", "package-lock.json"]
   *   ["GS/*.snap", "!critical/important.snap"]
   *
   * Globstar semantics defined by the shared compileGlob in
   * `path-glob.ts`.
   */
  pathFilters?: string[]
  /**
   * ARC-176: review tone. Default `chill` (only must-fix). Set to
   * `assertive` to also surface nits and style.
   */
  profile?: SigilixProfile
  /**
   * ARC-191: per-repo opt-OUT for `/sigilix describe`. Default
   * (missing field) = enabled. Only `enabled: false` disables;
   * anything else (string, number, undefined) is dropped at parse
   * time and treated as missing → enabled. The slash command is
   * already user-invoked + ACL-gated, so opt-IN was rejected as
   * redundant friction.
   */
  describe?: {
    enabled?: boolean
  }
  /**
   * ARC-185: per-command prompt addendum + model overrides. Each
   * command (`review`, `improve`, `describe`, `ask`) can declare its
   * own `prompt.addendum` (string ≤ 4000 code points appended to the
   * system prompt) AND `model.primary` / `model.fallbacks` (override
   * the default model + retry chain).
   *
   * v1 wires `improve`, `describe`, and the `review` synthesizer.
   * Specialist-level model overrides for `review` remain on the v3.1
   * LOCKED lineup. `ask` schema slot is reserved for the future
   * `/sigilix ask` handler.
   *
   * Validation rules (per spec v3 §5.1):
   *   - unknown command keys → parse error (typo catching)
   *   - addendum length > 4000 code points → parse error
   *   - whitespace-only model.primary → parse error
   *   - >4 fallback entries → parse error
   *   - unknown model name (not in `KNOWN_MODELS`) → parse error
   *   - explicit `fallbacks: []` → treated as missing (use defaults)
   */
  commands?: Partial<Record<SigilixCommandName, SigilixCommandConfig>>
  /**
   * ARC-186: per-repo opt-OUT for the dependency-vulnerability scan.
   * Default (missing field) = enabled. Mirrors the `describe.enabled`
   * shape — strict-bool parsing, only literal `false` disables.
   */
  depVulnScan?: {
    enabled?: boolean
  }
  /**
   * ARC-181: per-repo configuration for the AST rule-pack scanner.
   * All subfields optional. When `astRules` is absent OR any subfield
   * is absent, the runner falls back to locked defaults:
   *   { enabled: true, severityThreshold: "warning",
   *     disabledRules: [], autoInline: false }
   */
  astRules?: {
    enabled?: boolean
    severityThreshold?: "info" | "warning" | "error"
    disabledRules?: string[]
    autoInline?: boolean
  }
  /**
   * ARC-188: per-repo configuration for the SARIF evidence channel
   * (Trivy / Kubescape / any SARIF v2.1.0 producer). Locked defaults
   * when absent: { enabled: true, path: ".sigilix/trivy.sarif.json",
   * severityThreshold: "warning", disabledRules: [],
   * disabledCategories: [] }
   *
   * `path` is a single file path — no globs in v1 (multi-tool
   * aggregation is the user's CI's job; SARIF supports multiple
   * `runs[]` per file).
   */
  sarifEvidence?: {
    enabled?: boolean
    path?: string
    severityThreshold?: "info" | "warning" | "error"
    disabledRules?: string[]
    disabledCategories?: SarifFindingCategoryRef[]
  }

  /**
   * ARC-189: per-repo cross-PR review-memory configuration. Defaults
   * to OFF (opposite polarity from every other scanner) per the
   * ticket's "default off" requirement. Retrieval requires
   * `enabled === true` AND env `OPENCLAW_REVIEW_MEMORY_ENABLED=on`.
   * Capture requires (`enabled === true` OR `captureOnly === true`)
   * AND env `OPENCLAW_REVIEW_MEMORY_CAPTURE=on`. See spec §5.2 truth
   * table.
   */
  reviewMemory?: {
    enabled?: boolean
    captureOnly?: boolean
    categories?: ReviewMemoryCategoryRef[]
    maxInjectedMemories?: number
    minSignalThreshold?: number
    maxSignalAgeDays?: number
  }
  /**
   * ARC-265: customer-defined labels Sigilix's LLM may apply to PRs.
   * Each entry pairs a label `name` (must already exist on the
   * repo OR be auto-creatable — see `handlePrLabels`) with a
   * `description` the LLM uses to judge whether the label fits the
   * PR's diff + title + body.
   *
   * When this field is absent or empty, Sigilix does NOT touch
   * labels at all — zero behavior change for repos without config.
   *
   * Sigilix-managed origin is tracked separately in KV so we never
   * remove human-applied labels on subsequent runs.
   *
   * Example:
   *   "customLabels": [
   *     { "name": "area:security", "description": "Touches auth, secrets handling, or known-sensitive paths" },
   *     { "name": "breaking-change", "description": "Public API or schema migration" }
   *   ]
   */
  customLabels?: Array<{ name: string; description: string }>
}

/**
 * ARC-189: re-exported from `review-memory/types.ts` so the config
 * surface declares the categories without `sigilix-config.ts` pulling
 * the entire review-memory type chain. Same 4-value literal union as
 * `ReviewMemoryCategory`.
 */
export type ReviewMemoryCategoryRef =
  | "security"
  | "logic"
  | "performance"
  | "tests"

/**
 * ARC-188: re-exported from `sarif-evidence/types.ts` so the config
 * surface declares the categories without `sigilix-config.ts`
 * importing the entire SARIF type chain. Kept narrow.
 */
export type SarifFindingCategoryRef =
  | "iac"
  | "misconfiguration"
  | "vulnerability"
  | "license"
  | "secret"
  | "other"

const SARIF_FINDING_CATEGORIES: ReadonlySet<SarifFindingCategoryRef> = new Set([
  "iac", "misconfiguration", "vulnerability", "license", "secret", "other",
])

const DEFAULT_SARIF_PATH = ".sigilix/trivy.sarif.json"

export type SigilixCommandName = "review" | "improve" | "describe" | "ask"

export interface SigilixCommandPromptConfig {
  addendum?: string
}

export interface SigilixCommandModelConfig {
  primary?: string
  fallbacks?: string[]
}

export interface SigilixCommandConfig {
  prompt?: SigilixCommandPromptConfig
  model?: SigilixCommandModelConfig
}

const COMMAND_NAMES: ReadonlySet<SigilixCommandName> = new Set([
  "review",
  "improve",
  "describe",
  "ask",
])

const ADDENDUM_MAX_CODE_POINTS = 4000
const FALLBACKS_MAX_ENTRIES = 4

/**
 * Registry of model names accepted by `commands.<cmd>.model.primary`
 * and `commands.<cmd>.model.fallbacks`. Sourced from:
 *   - the v3.1 LOCKED ensemble per-role lineup in
 *     `triage-pr-review-ensemble.ts`
 *   - the single-shot defaults in `triage-pr-improve.ts`,
 *     `triage-pr-describe.ts`
 *
 * Keep this list aligned with the runtime reality. Adding a new model
 * to the routing table is a code change; that change should also
 * extend this set so user configs can reference it.
 */
export const KNOWN_MODELS: ReadonlySet<string> = new Set([
  "glm-5.1:cloud",
  "kimi-k2.6:cloud",
  "qwen3-coder:480b-cloud",
  "deepseek-v4-pro:cloud",
])

export const EMPTY_CONFIG: SigilixConfig = {}

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
    for (const role of ["logic", "security", "performance", "tests"] as const) {
      const v = rulesIn[role]
      if (typeof v === "string" && v.length > 0) {
        rulesOut[role] = v
      }
    }
    if (Object.keys(rulesOut).length > 0) out.rules = rulesOut
  }
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
    if (Object.keys(rmOut).length > 0) {
      out.reviewMemory = rmOut
    }
  }
  // ARC-265: customLabels parsing. Strict-ish: each entry must be
  // an object with non-empty string name + description. Bad entries
  // are dropped (forward-compat: a typo in one entry shouldn't
  // disable the whole feature). Empty result drops the field
  // entirely so `handlePrLabels` sees `undefined` and no-ops.
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
    if (labels.length > 0) out.customLabels = labels
  }
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
])

const DEFAULT_REVIEW_MEMORY_CATEGORIES: ReadonlyArray<ReviewMemoryCategoryRef> = [
  "security",
  "logic",
  "performance",
  "tests",
]

/**
 * ARC-189: resolve the per-repo `reviewMemory` config to a
 * fully-locked shape with defaults filled in. Pure; never throws.
 *
 * Locked defaults (spec §5.1):
 *   - enabled: false  (default OFF — opposite of every other scanner)
 *   - captureOnly: false
 *   - categories: ALL 4 (empty array also resolves to all 4)
 *   - maxInjectedMemories: 5
 *   - minSignalThreshold: 3
 *   - maxSignalAgeDays: 90
 */
export function resolveReviewMemoryConfig(
  config: SigilixConfig | null,
): {
  enabled: boolean
  captureOnly: boolean
  categories: readonly ReviewMemoryCategoryRef[]
  maxInjectedMemories: number
  minSignalThreshold: number
  maxSignalAgeDays: number
} {
  const cfg = config?.reviewMemory
  const cats = cfg?.categories
  const resolvedCats =
    Array.isArray(cats) && cats.length > 0
      ? cats
      : DEFAULT_REVIEW_MEMORY_CATEGORIES
  return {
    enabled: cfg?.enabled === true,
    captureOnly: cfg?.captureOnly === true,
    categories: resolvedCats,
    maxInjectedMemories: cfg?.maxInjectedMemories ?? 5,
    minSignalThreshold: cfg?.minSignalThreshold ?? 3,
    maxSignalAgeDays: cfg?.maxSignalAgeDays ?? 90,
  }
}

/**
 * ARC-181: resolve the per-repo astRules config to a fully-locked
 * shape with defaults filled in. Pure function; never throws.
 */
export function resolveAstRulesConfig(
  config: SigilixConfig | null,
): {
  enabled: boolean
  severityThreshold: "info" | "warning" | "error"
  disabledRules: string[]
  autoInline: boolean
} {
  const cfg = config?.astRules
  return {
    enabled: cfg?.enabled !== false,
    severityThreshold: cfg?.severityThreshold ?? "warning",
    disabledRules: cfg?.disabledRules ?? [],
    autoInline: cfg?.autoInline === true,
  }
}

/**
 * ARC-188: resolve the per-repo `sarifEvidence` config into a
 * fully-locked shape with defaults filled in. Pure; never throws.
 *
 * Locked defaults (spec §5 + plan v2 Task 2):
 *   - enabled: true
 *   - path: ".sigilix/trivy.sarif.json"
 *   - severityThreshold: "warning"
 *   - disabledRules: []
 *   - disabledCategories: []
 */
export function resolveSarifEvidenceConfig(
  config: SigilixConfig | null,
): {
  enabled: boolean
  path: string
  severityThreshold: "info" | "warning" | "error"
  disabledRules: string[]
  disabledCategories: SarifFindingCategoryRef[]
} {
  const cfg = config?.sarifEvidence
  return {
    enabled: cfg?.enabled !== false,
    path: cfg?.path ?? DEFAULT_SARIF_PATH,
    severityThreshold: cfg?.severityThreshold ?? "warning",
    disabledRules: cfg?.disabledRules ?? [],
    disabledCategories: cfg?.disabledCategories ?? [],
  }
}

/**
 * ARC-185: resolve the per-command override shape from a config.
 * Pure function; never throws. The `modelFallbacks.override` flag
 * lets consumers distinguish "user explicitly set fallbacks" from
 * "use the command's existing default chain" — explicit empty array
 * (`fallbacks: []`) AND missing key both map to `override: false`
 * (per spec v3 §5.1).
 */
export function resolveCommandConfig(
  config: SigilixConfig | null,
  command: SigilixCommandName,
): {
  promptAddendum: string | null
  modelPrimary: string | null
  modelFallbacks: { override: false } | { override: true; models: string[] }
} {
  const cmd = config?.commands?.[command]
  const promptAddendum = cmd?.prompt?.addendum ?? null
  const modelPrimary = cmd?.model?.primary ?? null
  const fallbacks = cmd?.model?.fallbacks
  const modelFallbacks = (fallbacks && fallbacks.length > 0)
    ? { override: true as const, models: fallbacks }
    : { override: false as const }
  return { promptAddendum, modelPrimary, modelFallbacks }
}

/**
 * Fetch and parse the per-repo `sigilix.json` config at the given ref.
 * Always resolves — never throws — so the caller can rely on the
 * return value. Returns `EMPTY_CONFIG` on any of:
 *   - file missing (GitHub 404 → getFileContent returns null)
 *   - file empty / not text
 *   - JSON malformed
 *   - structurally wrong (top-level array, etc.)
 *
 * Callers that want to know whether the config was actually present
 * should compare the result identity with `EMPTY_CONFIG` (it returns
 * the singleton on the missing/error paths and a fresh object only
 * when at least one valid field was extracted).
 */
export async function loadSigilixConfig(
  client: GitHubClient,
  owner: string,
  repo: string,
  ref: string,
): Promise<SigilixConfig> {
  let raw: string | null
  try {
    raw = await client.getFileContent(owner, repo, SIGILIX_CONFIG_PATH, ref)
  } catch {
    return EMPTY_CONFIG
  }
  if (raw === null || raw.trim().length === 0) return EMPTY_CONFIG
  const parsed = parseSigilixConfig(raw)
  return parsed ?? EMPTY_CONFIG
}

/**
 * ARC-185: fetch the raw `sigilix.json` text without parsing. Used
 * by the slash-command dispatch path to feed `parseSigilixConfigDetailed`
 * (which preserves the raw text alongside parse errors so the
 * resulting PR comment can show a snippet). Never throws — returns
 * null on missing file or fetch failure.
 */
export async function loadSigilixConfigRaw(
  client: GitHubClient,
  owner: string,
  repo: string,
  ref: string,
): Promise<string | null> {
  try {
    const raw = await client.getFileContent(owner, repo, SIGILIX_CONFIG_PATH, ref)
    if (raw === null || raw.trim().length === 0) return null
    return raw
  } catch {
    return null
  }
}
