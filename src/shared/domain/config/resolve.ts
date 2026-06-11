// SIG-382: SigilixConfig → resolved/rendered shapes, carved out of the
// `src/lib/sigilix-config.ts` god-file. Pure (no IO). The shim at
// `src/lib/sigilix-config.ts` re-exports everything here for the existing
// importers. See docs/superpowers/plans/2026-06-09-sig-382-config-split.md.

import type { SpecialistRole } from "@/src/shared/domain/specialist-role"
import type { ResolvedPerfBudgets } from "@/src/shared/domain/perf-budgets"
import { DEFAULT_PRE_MERGE_GATES_CONFIG, type ResolvedPreMergeGatesConfig } from "@/src/shared/domain/pre-merge-gates"
import { pathMatchesAny } from "@/src/shared/util/path-glob"
import {
  LINTER_IDS,
  SPECIALIST_ROLES,
  type LinterId,
  type MatchedSigilixPathInstruction,
  type ReviewMemoryCategoryRef,
  type SarifFindingCategoryRef,
  type SigilixCommandName,
  type SigilixConfig,
} from "./types"

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
export function resolveCostControlsConfig(config: SigilixConfig | null): ResolvedCostControls {
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
export function passesLabelGate(labels: ReadonlyArray<string>, runOnLabels: ReadonlyArray<string>): boolean {
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
  const uniqueChangedPaths = [...new Set(changedPaths.map((p) => p.trim()).filter((p) => p.length > 0))]
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
      ? match.rules?.[role]
        ? ([[role, match.rules[role]]] as Array<[SpecialistRole, string]>)
        : []
      : SPECIALIST_ROLES.map((r): [SpecialistRole, string] | null =>
          match.rules?.[r] ? [r, match.rules[r]] : null,
        ).filter((entry): entry is [SpecialistRole, string] => entry !== null)
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
export function resolveDocsReviewConfig(config: SigilixConfig | null): ResolvedDocsReview {
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
export function resolvePerfBudgetsConfig(config: SigilixConfig | null): ResolvedPerfBudgets {
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

// ─── SIG-112: evidence block visibility resolution ───────────────────

/**
 * Resolve the customer-visible evidence block flag. Default-off: only
 * `sigilix.json` with `evidence.visible: true` or dev/dogfood env
 * `OPENCLAW_SHOW_EVIDENCE=on` enables rendering.
 */
export function isFindingEvidenceVisible(
  config: SigilixConfig | null,
  env: { OPENCLAW_SHOW_EVIDENCE?: string },
): boolean {
  return env.OPENCLAW_SHOW_EVIDENCE === "on" || config?.evidence?.visible === true
}

/**
 * SIG-247 Phase 0: default now covers ALL 5 specialist categories.
 * Was `["performance", "tests"]` until 2026-05-27; the narrower
 * default missed the three patterns where the bot's specialists
 * over-fire most often (security architectural-misunderstanding,
 * logic chunker-windowing hallucination, architecture cross-tenant
 * confusion — all surfaced by today's PR #202/#203 dogfooding).
 * Wider capture defaults are the prerequisite for the learning loop
 * to accumulate signal on the categories that actually need it.
 */
const DEFAULT_REVIEW_MEMORY_CATEGORIES: ReadonlyArray<ReviewMemoryCategoryRef> = [
  "security",
  "logic",
  "performance",
  "tests",
  "architecture",
]

/**
 * ARC-189: resolve the per-repo `reviewMemory` config to a
 * fully-locked shape with defaults filled in. Pure; never throws.
 *
 * Locked defaults (spec §5.1):
 *   - enabled: false  (default OFF — opposite of every other scanner)
 *   - captureOnly: false
 *   - categories: ALL 5 (empty array also resolves to all 5) — SIG-247
 *                 Phase 0 expanded from 4 to include "architecture"
 *   - maxInjectedMemories: 5
 *   - minSignalThreshold: 3
 *   - maxSignalAgeDays: 90
 */
export function resolveReviewMemoryConfig(config: SigilixConfig | null): {
  enabled: boolean
  captureOnly: boolean
  categories: readonly ReviewMemoryCategoryRef[]
  maxInjectedMemories: number
  minSignalThreshold: number
  maxSignalAgeDays: number
  claimSoftening: boolean
} {
  const cfg = config?.reviewMemory
  const cats = cfg?.categories
  const resolvedCats = Array.isArray(cats) && cats.length > 0 ? cats : DEFAULT_REVIEW_MEMORY_CATEGORIES
  return {
    enabled: cfg?.enabled === true,
    captureOnly: cfg?.captureOnly === true,
    categories: resolvedCats,
    maxInjectedMemories: cfg?.maxInjectedMemories ?? 5,
    minSignalThreshold: cfg?.minSignalThreshold ?? 3,
    maxSignalAgeDays: cfg?.maxSignalAgeDays ?? 90,
    // SIG-280 Phase 4 PR A: strict-bool, default off. Surfaced for the
    // Phase 4 soften gate; nothing reads it for behavior yet.
    claimSoftening: cfg?.claimSoftening === true,
  }
}

/**
 * ARC-181: resolve the per-repo astRules config to a fully-locked
 * shape with defaults filled in. Pure function; never throws.
 */
export function resolveAstRulesConfig(config: SigilixConfig | null): {
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
export function resolveSarifEvidenceConfig(config: SigilixConfig | null): {
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

export type ResolvedLintersConfig = Record<LinterId, { enabled: boolean }>

/**
 * SIG-107: resolve linter enablement to a complete known-tool map.
 * Default-on: only an explicit `enabled: false` disables a tool.
 */
export function resolveLintersConfig(config: SigilixConfig | null): ResolvedLintersConfig {
  const cfg = config?.linters
  const out = {} as ResolvedLintersConfig
  for (const id of LINTER_IDS) {
    // Missing entries, including invalid entries dropped by the parser, default on.
    out[id] = { enabled: cfg?.[id]?.enabled !== false }
  }
  return out
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
export function resolveCoverageConfig(config: SigilixConfig | null): {
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
  const modelFallbacks =
    fallbacks && fallbacks.length > 0 ? { override: true as const, models: fallbacks } : { override: false as const }
  return { promptAddendum, modelPrimary, modelFallbacks }
}

const DEFAULT_SARIF_PATH = ".sigilix/trivy.sarif.json"

// SIG-118: coverage-diff ingestion defaults.
const DEFAULT_COVERAGE_ARTIFACT_NAME = "coverage-lcov"
const DEFAULT_COVERAGE_ENTRY = "lcov.info"
