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
import type { ResolvedPerfBudgets } from "./perf-budgets"
import { parseDeterministicChecks, type DeterministicCheck } from "./deterministic-checks"
import { pathMatchesAny } from "./path-glob"
import {
  DEFAULT_PRE_MERGE_GATES_CONFIG,
  type ResolvedPreMergeGatesConfig,
} from "./pre-merge-gates"

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
   * Path-scoped review guidance. This is the repo-owned equivalent of
   * competitor "path instructions": apply stricter or different review
   * criteria only when a changed file matches the configured globs.
   *
   * Example:
   *   "pathInstructions": [
   *     {
   *       "paths": ["src/auth/**", "workers/**"],
   *       "guidance": "Treat this as a security-sensitive request path.",
   *       "rules": {
   *         "security": "Block unsafe token handling or missing authz checks.",
   *         "tests": "Require integration coverage for auth behavior changes."
   *       }
   *     }
   *   ]
   */
  pathInstructions?: SigilixPathInstruction[]
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
   * SIG-84: per-repo opt-OUT for the pr-overview sticky comment.
   * Default (missing field) = enabled. Only literal `false` disables;
   * anything else (string, number, undefined) is dropped at parse
   * time and treated as missing → enabled.
   *
   * When disabled:
   *   - the webhook handler skips both the stub-post + the
   *     `pr-overview` queue send.
   *   - the pr-review submit path skips the KV-flag wait (it's there
   *     to guarantee the stub posts BEFORE the review; with no stub
   *     there's nothing to wait for).
   *
   * NOT routed through `commands.overview` because the `commands`
   * schema is closed to the four slash-command names
   * (`review`/`improve`/`describe`/`ask`); adding `overview` there
   * would conflate "slash command toggle" with "automatic-feature
   * toggle". Top-level mirrors the polarity of `describe.enabled`.
   */
  overview?: {
    enabled?: boolean
  }
  /**
   * SIG-135: per-repo opt-OUT for automatic PR label application.
   * Default (missing field) = enabled. Only literal `false` disables;
   * anything else is dropped at parse time and treated as enabled.
   *
   * `customLabels` remains the curated allowlist. When it is absent,
   * the label picker uses the repo's existing labels as candidates.
   */
  labels?: {
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
   * SIG-118: per-repo configuration for coverage-diff ingestion. Reads
   * an LCOV coverage artifact from the PR head's GitHub Actions run,
   * intersects uncovered lines with the PR's added lines, and feeds the
   * resulting coverage-gap facts to the tests specialist.
   *
   * Default OFF (`source: "off"`) — opposite polarity from the
   * always-on scanners. Production behavior is unchanged until an
   * operator sets `source: "github-actions-artifact"`.
   *   - source: "off" | "github-actions-artifact" (default "off")
   *   - artifactName: the GitHub Actions artifact name (default
   *     "coverage-lcov")
   *   - entry: the LCOV file within the artifact ZIP (default
   *     "lcov.info")
   */
  coverage?: {
    source?: "github-actions-artifact" | "off"
    artifactName?: string
    entry?: string
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
   * When this field is absent, Sigilix derives candidates from the
   * repo's existing labels unless `labels.enabled:false`.
   * An explicit empty array (`customLabels: []`) is treated as an
   * intentional empty allowlist (no candidates).
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
  /**
   * ARC-273: operator-tunable cost controls. Pre-customer this is a
   * polish surface; for repos with very large PRs or strict budget
   * discipline it's the difference between "review is automatic" and
   * "review eats our Ollama quota."
   *
   * Fields (all optional):
   *   - `maxPatchLength`: hard cap (chars) on the diff string passed
   *     to specialists. Truncates from the END (preserves header +
   *     leading hunks). Defaults to a generous internal value
   *     (resolved by `resolveCostControlsConfig`); explicit caps
   *     between 1_000 and 200_000 chars are accepted, others fall
   *     back to default.
   *   - `runOnLabels`: when non-empty, pr-review fires ONLY for PRs
   *     carrying at least one of these label names. Empty / absent
   *     = no gating (current behavior). Useful for opt-in cost
   *     control on monorepos where most PRs don't need review.
   *
   * `pathFilters` (existing, ARC-176) already covers include/exclude
   * globs and is the path-scoping surface — `costControls` does NOT
   * duplicate it.
   *
   * Validation: bounds-checked + defensively parsed. Bad values are
   * dropped silently (fail-open) so a config typo doesn't disable
   * review.
   *
   * Example:
   *   "costControls": {
   *     "maxPatchLength": 75000,
   *     "runOnLabels": ["sigilix:review"]
   *   }
   */
  costControls?: {
    maxPatchLength?: number
    runOnLabels?: string[]
  }
  /**
   * ARC-272: zero-LLM documentation-coverage check. Runs in the
   * pre-fanout deterministic-check pipeline alongside secret scan,
   * dep-vuln, AST rules, SARIF, and regex deterministic checks. When
   * a PR touches any file matching `architectureGlobs` but DOES NOT
   * touch any file matching `docPaths`, the check emits an
   * authoritative-fact line for the synthesizer + specialists:
   * "PR touches architecture but adds no documentation update."
   *
   * Cheap, deterministic, no model spend. Zero false-positive
   * tolerance is fine because the check is informational — it never
   * blocks merges.
   *
   * Fields (all optional):
   *   - `enabled`: master switch. Default `true`; explicit `false`
   *     disables. Pairs with `architectureGlobs` below — when that
   *     list is empty, the check is a no-op regardless of this
   *     flag, so default-on is safe.
   *   - `architectureGlobs`: glob patterns for architecture-impacting
   *     paths. Default: **empty** — the check ships silent until
   *     the operator opts in by configuring patterns. Avoids noisy
   *     false-positives at scale on repos with non-standard layouts.
   *   - `docPaths`: glob patterns for documentation paths. Default
   *     covers `README.md`, `AGENTS.md`, `CLAUDE.md`, `docs/<gs>`,
   *     `CHANGELOG.md`. Operator can override entirely.
   *
   * Example:
   *   "docsReview": {
   *     "enabled": true,
   *     "architectureGlobs": ["src/lib/<gs>", "wrangler.toml", "package.json"],
   *     "docPaths": ["README.md", "docs/<gs>"]
   *   }
   */
  docsReview?: {
    enabled?: boolean
    architectureGlobs?: string[]
    docPaths?: string[]
  }
  /**
   * SIG-100: deterministic pre-merge quality gates. All three sub-
   * gates are enabled by default with the defaults in
   * `DEFAULT_PRE_MERGE_GATES_CONFIG`. Operators can disable a single
   * gate (e.g. `linkedIssue: { enabled: false }`) or override
   * severity / regex / template per gate. Render in the overview
   * sticky's "Quality gates" checklist; NEVER as inline review
   * comments.
   */
  preMergeGates?: {
    titleFormat?: {
      enabled?: boolean
      severity?: "info" | "warning" | "error"
      /** JavaScript regex source (no flags). Compiled with the `u`
       *  flag at gate-evaluation time. Malformed regex fails OPEN
       *  (gate passes) so an operator typo doesn't break Sigilix. */
      regex?: string
    }
    descriptionCompleteness?: {
      enabled?: boolean
      severity?: "info" | "warning" | "error"
      /** Minimum non-whitespace character count for the description
       *  to pass without satisfying the template. */
      minLength?: number
      /** Required section headings. Body passes when EVERY entry
       *  appears as a line (case-insensitive trim compare). */
      template?: string[]
    }
    linkedIssue?: {
      enabled?: boolean
      severity?: "info" | "warning" | "error"
    }
  }
  /**
   * SIG-110: per-repo performance budgets + hot-path declarations.
   * Read at runtime and injected as a `performance`-scoped
   * authoritative fact: when a PR touches a file matching any
   * `hotPaths` glob, the performance specialist's prompt carries a
   * "this PR modifies a declared hot path" block listing the touched
   * files + the declared budgets (see `perf-budgets.ts`).
   *
   * `hotPaths` are PATH GLOBS (same `compileGlob` semantics as
   * `pathFilters` / `docsReview.architectureGlobs`), NOT function
   * names — the finding-level `hotPathIdentifier` (function + call
   * frequency) stays the LLM specialist's job.
   *
   * All fields optional. When `hotPaths` is absent/empty the check is
   * a no-op (opt-in; zero behavior change for repos without config).
   * The latency / bundle budgets are pure context echoed into the
   * fact block — Sigilix does NOT measure runtime here (live telemetry
   * ingestion is out of scope per the ticket).
   *
   * Validation: bounds-checked numbers (out-of-range dropped silently,
   * fail-open); `hotPaths` trimmed + deduped, empties dropped.
   *
   * Example:
   *   "perfBudgets": {
   *     "p50LatencyBudgetMs": 50,
   *     "p95LatencyBudgetMs": 200,
   *     "bundleSizeBudgetKb": 250,
   *     "hotPaths": ["src/lib/api/<gs>", "src/worker.ts"]
   *   }
   */
  perfBudgets?: {
    p50LatencyBudgetMs?: number
    p95LatencyBudgetMs?: number
    bundleSizeBudgetKb?: number
    hotPaths?: string[]
  }
  /**
   * SIG-224: per-repo dispatcher configuration. Phase 0 surface — the
   * schema lands here for forward-compat, but no call site consumes
   * `dispatcher.*` yet. Phase 1 (SIG-226) wires the shadow dispatcher
   * to read `force` + `safetyNet.additionalPatterns`.
   *
   * Fields (all optional, all additive — the global safety net cannot
   * be removed via this surface):
   *   - `force`: specialists that ALWAYS run for this repo regardless
   *     of the dispatcher's picks. Useful for repos where every PR
   *     must be reviewed by, e.g., security. Maximum of 4 entries
   *     (the role set is closed); unknown role names are dropped at
   *     parse time.
   *   - `safetyNet.additionalPatterns`: per-repo additive entries to
   *     the rule-based safety net. Each entry forces the named role
   *     when any changed file matches the glob. Cannot DELETE the
   *     code-owned global patterns — additive only by design (recall
   *     guarantees are organizational policy, not customer-tunable).
   *     Maximum of 50 entries.
   *
   * See `docs/specs/2026-05-26-sig-224-dispatcher-architecture.md`
   * for the full design + the phase plan that gates `dispatcher.*`
   * consumption.
   *
   * Example:
   *   "dispatcher": {
   *     "force": ["security", "logic"],
   *     "safetyNet": {
   *       "additionalPatterns": [
   *         { "glob": "src/billing/<gs>", "role": "logic" },
   *         { "glob": "src/auth-custom/<gs>", "role": "security" }
   *       ]
   *     }
   *   }
   */
  dispatcher?: DispatcherConfig
}

export interface DispatcherConfig {
  force?: SpecialistRole[]
  safetyNet?: {
    additionalPatterns?: DispatcherSafetyNetPattern[]
  }
}

export interface DispatcherSafetyNetPattern {
  glob: string
  role: SpecialistRole
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

export interface SigilixPathInstruction {
  paths: string[]
  guidance?: string
  rules?: Partial<Record<SpecialistRole, string>>
}

export interface MatchedSigilixPathInstruction extends SigilixPathInstruction {
  matchedPaths: string[]
}

const SARIF_FINDING_CATEGORIES: ReadonlySet<SarifFindingCategoryRef> = new Set([
  "iac", "misconfiguration", "vulnerability", "license", "secret", "other",
])

const DEFAULT_SARIF_PATH = ".sigilix/trivy.sarif.json"

// SIG-118: coverage-diff ingestion defaults.
const DEFAULT_COVERAGE_ARTIFACT_NAME = "coverage-lcov"
const DEFAULT_COVERAGE_ENTRY = "lcov.info"

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
const PATH_INSTRUCTIONS_MAX_ENTRIES = 20
const PATH_INSTRUCTIONS_MAX_PATHS = 50
const PATH_INSTRUCTIONS_TEXT_MAX_CODE_POINTS = 4000

const SPECIALIST_ROLES = ["logic", "security", "performance", "tests"] as const satisfies readonly SpecialistRole[]

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

/**
 * SIG-100: merge user-supplied `preMergeGates` config with the locked
 * defaults from `DEFAULT_PRE_MERGE_GATES_CONFIG`. Returns a fully-
 * resolved config every gate function can consume directly — no
 * per-call defaulting at the gate level.
 *
 * Pure; exported for tests + for the overview handler at call time.
 */
export function resolvePreMergeGatesConfig(
  partial: SigilixConfig["preMergeGates"] | undefined,
): ResolvedPreMergeGatesConfig {
  const d = DEFAULT_PRE_MERGE_GATES_CONFIG
  return {
    titleFormat: {
      enabled: partial?.titleFormat?.enabled ?? d.titleFormat.enabled,
      severity: partial?.titleFormat?.severity ?? d.titleFormat.severity,
      regex: partial?.titleFormat?.regex ?? d.titleFormat.regex,
    },
    descriptionCompleteness: {
      enabled: partial?.descriptionCompleteness?.enabled ?? d.descriptionCompleteness.enabled,
      severity: partial?.descriptionCompleteness?.severity ?? d.descriptionCompleteness.severity,
      minLength: partial?.descriptionCompleteness?.minLength ?? d.descriptionCompleteness.minLength,
      template: partial?.descriptionCompleteness?.template ?? d.descriptionCompleteness.template,
    },
    linkedIssue: {
      enabled: partial?.linkedIssue?.enabled ?? d.linkedIssue.enabled,
      severity: partial?.linkedIssue?.severity ?? d.linkedIssue.severity,
    },
  }
}

// ─── ARC-273: cost control resolution ────────────────────────────────

/**
 * Default cap for the per-review diff payload. Generous enough that
 * typical PRs aren't truncated (median Sigilix PR diff is ~10-25 KB),
 * tight enough that pathological large-rename PRs don't blow through
 * the model's context.
 *
 * Operators tune via `costControls.maxPatchLength`; the parser
 * accepts values in [MIN, MAX] (see constants below).
 */
const DEFAULT_MAX_PATCH_LENGTH = 80_000
const MAX_PATCH_LENGTH_MIN = 1_000
const MAX_PATCH_LENGTH_MAX = 200_000

// SIG-110: perfBudgets numeric bounds. Latency in ms (1ms .. 10min);
// bundle size in KB (1KB .. 1GB). Out-of-range values drop silently.
const LATENCY_BUDGET_MS_MIN = 1
const LATENCY_BUDGET_MS_MAX = 600_000
const BUNDLE_SIZE_KB_MIN = 1
const BUNDLE_SIZE_KB_MAX = 1_000_000

export interface ResolvedCostControls {
  maxPatchLength: number
  /** When non-empty, pr-review only runs for PRs carrying at least
   *  one of these labels. Empty = no gating. */
  runOnLabels: readonly string[]
}

/**
 * ARC-273: resolve cost-control config to a fully-locked shape with
 * defaults filled in. Pure; never throws.
 */
export function resolveCostControlsConfig(
  config: SigilixConfig | null,
): ResolvedCostControls {
  const cc = config?.costControls
  return {
    maxPatchLength: cc?.maxPatchLength ?? DEFAULT_MAX_PATCH_LENGTH,
    runOnLabels: cc?.runOnLabels ?? [],
  }
}

/**
 * ARC-273: label-gate decision. Returns `true` when the PR should
 * be reviewed given its current label set + the operator's
 * `runOnLabels` config. When `runOnLabels` is empty, always returns
 * `true` (current behavior preserved for repos without config).
 *
 * Case-insensitive name match (GitHub label names are case-sensitive
 * at the API level but operators don't always match casing exactly).
 *
 * Pure; exported for unit tests.
 */
export function passesLabelGate(
  labels: ReadonlyArray<string>,
  runOnLabels: ReadonlyArray<string>,
): boolean {
  if (runOnLabels.length === 0) return true
  const labelSet = new Set(labels.map((l) => l.toLowerCase()))
  return runOnLabels.some((g) => labelSet.has(g.toLowerCase()))
}

// ─── Path-scoped review guidance ─────────────────────────────────────

export function resolvePathInstructionsForChangedPaths(
  config: SigilixConfig | null,
  changedPaths: ReadonlyArray<string>,
): MatchedSigilixPathInstruction[] {
  const instructions = config?.pathInstructions ?? []
  if (instructions.length === 0 || changedPaths.length === 0) return []
  const uniqueChangedPaths = [...new Set(
    changedPaths
      .map((p) => p.trim())
      .filter((p) => p.length > 0),
  )]
  const matches: MatchedSigilixPathInstruction[] = []
  for (const instruction of instructions) {
    const matchedPaths = uniqueChangedPaths.filter((path) => pathMatchesAny(path, instruction.paths))
    if (matchedPaths.length === 0) continue
    matches.push({ ...instruction, matchedPaths })
  }
  return matches
}

function renderLimitedList(values: readonly string[], max: number): string {
  const visible = values.slice(0, max)
  const suffix = values.length > max ? `, +${values.length - max} more` : ""
  return `${visible.join(", ")}${suffix}`
}

export function renderPathInstructionsForPrompt(
  matches: ReadonlyArray<MatchedSigilixPathInstruction>,
  role?: SpecialistRole,
): string {
  const blocks: string[] = []
  let renderedIndex = 1
  for (const match of matches) {
    const roleRules = role
      ? match.rules?.[role] ? [[role, match.rules[role]]] as Array<[SpecialistRole, string]> : []
      : SPECIALIST_ROLES
        .map((r): [SpecialistRole, string] | null => match.rules?.[r] ? [r, match.rules[r]] : null)
        .filter((entry): entry is [SpecialistRole, string] => entry !== null)
    if (!match.guidance && roleRules.length === 0) continue

    const lines = [
      `Instruction ${renderedIndex}`,
      `Patterns: ${renderLimitedList(match.paths, 8)}`,
      `Matched changed files: ${renderLimitedList(match.matchedPaths, 8)}`,
    ]
    if (match.guidance) {
      lines.push(`Guidance: ${match.guidance}`)
    }
    for (const [ruleRole, rule] of roleRules) {
      lines.push(`${ruleRole} rule: ${rule}`)
    }
    blocks.push(lines.join("\n"))
    renderedIndex += 1
  }
  if (blocks.length === 0) return ""
  return [
    "[PATH-SCOPED REVIEW GUIDANCE (from sigilix.json)]",
    "These instructions apply only to matching changed files. Do not apply them to unrelated files in the PR.",
    "",
    ...blocks,
  ].join("\n\n")
}

// ─── ARC-272: docs-coverage resolution ───────────────────────────────

/**
 * Default doc-paths recognized when an operator opts into the
 * docs-coverage check without overriding `docPaths`. Covers the
 * common conventions across most repos. Operator can replace by
 * setting their own `docPaths`.
 */
const DEFAULT_DOCS_PATHS: readonly string[] = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "CHANGELOG.md",
  "docs/**",
  "doc/**",
] as const

export interface ResolvedDocsReview {
  enabled: boolean
  /** Architecture-impacting paths. Empty array means the check
   *  is effectively a no-op (no patterns to flag). */
  architectureGlobs: readonly string[]
  /** Documentation paths the check looks for as "if any of these
   *  were ALSO touched, the PR satisfies docs coverage." */
  docPaths: readonly string[]
}

/**
 * ARC-272: resolve docs-review config to a locked shape. Defaults:
 *   - `enabled: true` (opt-OUT, but a no-op until `architectureGlobs`
 *     is non-empty, so default-on doesn't surprise repos without
 *     opt-in.)
 *   - `architectureGlobs: []` (operator must list paths they
 *     consider architecture-impacting; the check has no built-in
 *     opinion to avoid noisy defaults.)
 *   - `docPaths: DEFAULT_DOCS_PATHS` (sensible cross-repo defaults
 *     unless operator overrides.)
 *
 * Pure; never throws.
 */
export function resolveDocsReviewConfig(
  config: SigilixConfig | null,
): ResolvedDocsReview {
  const dr = config?.docsReview
  return {
    enabled: dr?.enabled !== false,
    architectureGlobs: dr?.architectureGlobs ?? [],
    docPaths: dr?.docPaths ?? DEFAULT_DOCS_PATHS,
  }
}

// ─── SIG-110: perf-budgets resolution ───────────────────────────────

/**
 * SIG-110: resolve the per-repo `perfBudgets` config into a fully-
 * locked shape with defaults filled in. Pure; never throws.
 *
 * Locked defaults (opt-in — no-op until the operator declares
 * `hotPaths`):
 *   - p50LatencyBudgetMs: null
 *   - p95LatencyBudgetMs: null
 *   - bundleSizeBudgetKb: null
 *   - hotPaths: []
 */
export function resolvePerfBudgetsConfig(
  config: SigilixConfig | null,
): ResolvedPerfBudgets {
  const pb = config?.perfBudgets
  return {
    p50LatencyBudgetMs: pb?.p50LatencyBudgetMs ?? null,
    p95LatencyBudgetMs: pb?.p95LatencyBudgetMs ?? null,
    bundleSizeBudgetKb: pb?.bundleSizeBudgetKb ?? null,
    hotPaths: pb?.hotPaths ?? [],
  }
}

// ─── SIG-84: pr-overview enablement resolution ──────────────────────

/**
 * SIG-84: resolve the per-repo `overview.enabled` flag to a locked
 * boolean. Default-on (opt-OUT): only an explicit literal `false`
 * disables. Pure; never throws.
 *
 * Consumers:
 *   - webhook handler: gates the stub-post + the `pr-overview`
 *     queue enqueue.
 *   - pr-review submit path: gates the KV-flag wait (disabled
 *     customers shouldn't pay the up-to-2s wait for a stub that
 *     was never posted).
 */
export function isPrOverviewEnabled(config: SigilixConfig | null): boolean {
  return config?.overview?.enabled !== false
}

// ─── SIG-135: pr-labels enablement resolution ────────────────────────

/**
 * SIG-135: resolve the per-repo `labels.enabled` flag to a locked
 * boolean. Default-on (opt-OUT): only an explicit literal `false`
 * disables automatic PR label application.
 */
export function isPrLabelsEnabled(config: SigilixConfig | null): boolean {
  return config?.labels?.enabled !== false
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
 * SIG-118: resolve the per-repo `coverage` config into a fully-locked
 * shape with defaults filled in. Pure; never throws.
 *
 * Locked defaults (default OFF — coverage ingestion is opt-in):
 *   - source: "off"
 *   - artifactName: "coverage-lcov"
 *   - entry: "lcov.info"
 *
 * Only `source: "github-actions-artifact"` opts in; a missing or
 * explicit `"off"` source resolves to "off", so the orchestrator skips
 * the entire ingestion path and production behavior is unchanged.
 */
export function resolveCoverageConfig(
  config: SigilixConfig | null,
): {
  source: "off" | "github-actions-artifact"
  artifactName: string
  entry: string
} {
  const cfg = config?.coverage
  return {
    source: cfg?.source === "github-actions-artifact" ? "github-actions-artifact" : "off",
    artifactName: cfg?.artifactName ?? DEFAULT_COVERAGE_ARTIFACT_NAME,
    entry: cfg?.entry ?? DEFAULT_COVERAGE_ENTRY,
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
