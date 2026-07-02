// SIG-382: pure config types + public/shared consts, carved out of the
// `src/lib/sigilix-config.ts` god-file. No functions, no IO. The shim at
// `src/lib/sigilix-config.ts` re-exports everything here for the existing
// importers. See docs/superpowers/plans/2026-06-09-sig-382-config-split.md.

import type { SpecialistRole } from "@/src/shared/domain/specialist-role"
import type { DeterministicCheck } from "@/src/shared/domain/deterministic-checks"
import { RUNNER_TOOL_IDS, type RunnerToolId } from "@/src/shared/domain/runner-tool-catalog"

export const SIGILIX_CONFIG_PATH_JSON = "sigilix.json"
export const SIGILIX_CONFIG_PATH_YAML = "sigilix.yaml"
export const SIGILIX_CONFIG_PATH_YML = "sigilix.yml"
export const SIGILIX_CONFIG_PATH = SIGILIX_CONFIG_PATH_JSON
export const SIGILIX_CONFIG_PATHS = [
  SIGILIX_CONFIG_PATH_JSON,
  SIGILIX_CONFIG_PATH_YAML,
  SIGILIX_CONFIG_PATH_YML,
] as const

export type SigilixConfigPath = (typeof SIGILIX_CONFIG_PATHS)[number]
export type SigilixConfigFormat = "json" | "yaml"

export interface SigilixConfigSource {
  path: SigilixConfigPath
  format: SigilixConfigFormat
  raw: string
}

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
   * Config-as-code structured rules — the repo-owned, id/scope/severity
   * surface for review criteria. DISTINCT from the free-text `rules`
   * field above: `rules` is per-specialist-role prose; `customRules` is
   * a list of individually-addressable rules with a stable `id`, an
   * optional `scope` glob, an optional `severity` hint, and a per-rule
   * `enabled` toggle.
   *
   * Recall-safety: a rule only ever ADDS review attention on the matched
   * files — it can never suppress, downgrade, or omit a finding the model
   * finds independently. Rules are matched by their `scope` globs against
   * the PR's changed files (same `compileGlob`/`pathMatchesAny` semantics
   * as `pathFilters` / `pathInstructions`); an absent/empty `scope`
   * applies the rule to every changed file.
   *
   * Injected into specialist prompts only when
   * `OPENCLAW_CONFIG_AS_CODE_MODE=on`; a `[repo-rule:<id>]` self-tag
   * attribution marker lets the model attribute a finding a rule informed
   * (mirrors the SDK-pack `[sdk:<id>]` scheme).
   *
   * Example:
   *   "customRules": [
   *     {
   *       "id": "no-raw-sql",
   *       "rule": "Flag string-concatenated SQL; require parameterized queries.",
   *       "scope": ["src/db/**"],
   *       "severity": "P1"
   *     }
   *   ]
   */
  customRules?: SigilixCustomRule[]
  /**
   * Config-as-code disable-by-id list: ids from THIS repo's own
   * `customRules` array that should be skipped at match time (e.g. to
   * turn off a rule without deleting its definition). Cross-subsystem
   * disable-by-id (SDK-pack ids, AST rule ids, etc.) is a possible future
   * extension — NOT built here; this list only affects `customRules`.
   */
  disabledRules?: string[]
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
   * SIG-507: per-repo opt-OUT of contributing anonymized patterns to the cross-repo
   * fleet aggregate. Default ON (contribute). Set `fleet: { contribute: false }` to opt
   * out — surfacing fleet insights is unaffected (benefit is decoupled from contribution).
   */
  fleet?: {
    contribute?: boolean
  }
  /**
   * SIG-112: per-repo opt-IN for customer-visible finding evidence blocks.
   * Default OFF. Dev/dogfood can also force visibility with env
   * `OPENCLAW_SHOW_EVIDENCE=on`.
   */
  evidence?: {
    visible?: boolean
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
   * SIG-107: per-repo enablement for deterministic linter tools run
   * by the runner workflow. Defaults come from the runner tool profile;
   * adding a tool to the catalog does not automatically enable it.
   * Repo config can explicitly enable or disable individual tools with
   * `{ enabled: boolean }` or strict boolean shorthand.
   */
  linters?: Partial<Record<LinterId, LinterConfig>>

  /**
   * SIG-408: per-repo specialist tool permissions. This is an
   * MCP-style, in-process Worker-safe tool surface for PR-review
   * specialists, not an external stdio/server transport. Missing config
   * means no specialist sees tools.
   */
  mcp?: McpConfig

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
    /**
     * SIG-280 Phase 4: per-repo opt-in for claim-driven softening. Strict-bool
     * (literal `true` only). Default off. Phase 4 `soften` mode requires BOTH
     * this AND env `OPENCLAW_REVIEW_MEMORY_CLAIM_SHADOW=soften`. Read-but-not-
     * yet-enforced in PR A (the soften gate lands in Phase 4 PR C).
     */
    claimSoftening?: boolean
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

export const LINTER_IDS = RUNNER_TOOL_IDS

export type LinterId = RunnerToolId

export interface LinterConfig {
  enabled?: boolean
}

export const MCP_TOOL_IDS = ["file_grep", "docs_fetch", "observability_lookup", "browser_check"] as const

export type McpToolId = (typeof MCP_TOOL_IDS)[number]

export interface McpConfig {
  enabled?: boolean
  specialists?: Partial<Record<SpecialistRole, { tools?: McpToolId[] }>>
  tools?: Partial<Record<McpToolId, { enabled?: boolean }>>
}

/**
 * ARC-189: re-exported from `review-memory/types.ts` so the config
 * surface declares the categories without `sigilix-config.ts` pulling
 * the entire review-memory type chain. Same literal union as
 * `ReviewMemoryCategory`. SIG-247 Phase 0 added `"architecture"`.
 */
export type ReviewMemoryCategoryRef = "security" | "logic" | "performance" | "tests" | "architecture"

/**
 * ARC-188: re-exported from `sarif-evidence/types.ts` so the config
 * surface declares the categories without `sigilix-config.ts`
 * importing the entire SARIF type chain. Kept narrow.
 */
export type SarifFindingCategoryRef = "iac" | "misconfiguration" | "vulnerability" | "license" | "secret" | "other"

export interface SigilixPathInstruction {
  paths: string[]
  guidance?: string
  rules?: Partial<Record<SpecialistRole, string>>
}

export interface MatchedSigilixPathInstruction extends SigilixPathInstruction {
  matchedPaths: string[]
}

export type SigilixCustomRuleSeverity = "P1" | "P2" | "P3"

export interface SigilixCustomRule {
  /** Stable id, unique within the repo config. Used as the `[repo-rule:<id>]`
   *  attribution marker and as the disable-by-id key in `disabledRules`.
   *  Must match /^[a-z0-9][a-z0-9-]{0,63}$/ (mirrors the SDK-pack id convention
   *  in sdk-packs/types.ts) — invalid ids are dropped at parse time. */
  id: string
  /** The rule text — 1-3 sentences, review-actionable, injected verbatim as
   *  additional context. Never an instruction to suppress/downgrade a finding. */
  rule: string
  /** Glob patterns (same compileGlob/pathMatchesAny semantics as pathFilters)
   *  scoping this rule to matching changed files. Absent/empty = applies to
   *  every changed file (matches pathMatchesAny's empty-array semantics). */
  scope?: string[]
  /** Soft priority hint for the model — never a score mutation, never a gate.
   *  Mirrors SdkPackRule.severityHint. Default (absent) renders with no tag. */
  severity?: SigilixCustomRuleSeverity
  /** Per-rule enable toggle. Default true — only literal `false` disables. */
  enabled?: boolean
}

export interface MatchedSigilixCustomRule {
  rule: SigilixCustomRule
  matchedPaths: string[]
}

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

export const SPECIALIST_ROLES = [
  "logic",
  "security",
  "performance",
  "tests",
] as const satisfies readonly SpecialistRole[]

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
  // Active primaries + fallbacks in SIG-234 lineup. Validated via
  // curl-format-test against `/api/chat`; only models that returned
  // schema-clean JSON (no ```json``` markdown-fenced output) are
  // listed. Kimi K2.7 Code replaces the legacy K2.6 model id for
  // command overrides. `deepseek-v4-pro:cloud` STAYS because it's still
  // the cross-provider fallback for security.
  "glm-5.1:cloud", // performance primary
  "kimi-k2.7-code:cloud", // current Kimi generalist/code model
  "kimi-k2.5:cloud", // logic + performance fallback
  "qwen3-coder:480b-cloud", // reserved for per-repo overrides
  "qwen3-coder-next:cloud", // logic fallback (was security primary; swapped to a reasoner after pr/07)
  "deepseek-v4-pro:cloud", // logic primary (2026-06-05) + security fallback
  "deepseek-v4-flash:cloud", // security + tests primary (reasoner), synth fallback
  "minimax-m3:cloud", // tests fallback (SIG-349; upgraded from m2.5, 2026-06-05)
  "gpt-oss:120b-cloud", // former synth primary (kept valid for user configs)
  "gemma4:31b", // former synth primary (Ollama; pre-alpha)
  // SIG-406 alpha — the OpenRouter lineup (the live-default review models). User
  // `commands.review.model` configs may name these; the `:cloud` tags above stay
  // valid for non-review command paths + local eval overrides.
  "openai/o3", // legacy logic (API removes it Aug 26 2026)
  "moonshotai/kimi-k2.7-code", // logic primary (SIG-450, replaces o3)
  "deepseek/deepseek-v4-flash", // security + claim-extractor
  "deepseek/deepseek-v4-pro", // tests
  "z-ai/glm-5.1", // performance
  "nvidia/nemotron-3-ultra-550b-a55b", // synth + dynamic dispatcher
])

export const EMPTY_CONFIG: SigilixConfig = {}
