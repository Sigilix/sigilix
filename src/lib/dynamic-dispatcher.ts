// SIG-226 / SIG-224 Phase 1 — dynamic specialist dispatcher.
//
// SIG-376 (SIG-318 Tier-1 3/8): this file is the dispatcher CORE — the
// public API types, the Tier-1 rule layer, the reconcile step, and the
// top-level orchestration. The pure path/content pattern cluster was
// lifted to `dynamic-dispatcher-patterns.ts` and the Tier-2 LLM classifier
// to `dynamic-dispatcher-llm.ts` so this file stays under the 1,000-line
// budget. The moved bodies are byte-identical relocations; only `export`
// keywords + import paths differ. The core re-exports the previously-public
// symbols that moved (`DISPATCHER_LLM_TIMEOUT_MS`, `DISPATCHER_LLM_MODEL`,
// `DispatcherLlmOutcome`) so every importer of `@/lib/dynamic-dispatcher`
// is unchanged. Dependency rule: the core imports both leaves; neither leaf
// imports the core (leaf 2 may import leaf 1), so there is no cycle.
//
// Two-tier hybrid dispatcher per the Phase 0 spec
// (`docs/specs/2026-05-26-sig-224-dispatcher-architecture.md`):
//
//   Tier 1 (rules, pure, fast):
//     - Extended safety-net path patterns (env files, CI/deploy
//       config, web security primitives, RLS, webhook handlers) force
//       `security`. Migrations + payment/billing/public-API +
//       parser/regex/concurrency paths force `logic`.
//     - Per-repo `sigilix.json::dispatcher.force` adds forced roles.
//     - Per-repo `sigilix.json::dispatcher.safetyNet.additionalPatterns`
//       extends (cannot remove) the global pattern set.
//     - Content-regex on added diff lines for dangerous JS sinks
//       (`eval(`, `innerHTML`, `dangerouslySetInnerHTML`, `new Function`,
//       child-process spawning, SQL template tags) → force `security`.
//     - Docs-only-no-fences → safe-skip ALL roles.
//     - CSS-only → force `performance`, safe-skip the other three.
//
//   Tier 2 (LLM, async, ≤ 8s):
//     - Only fires when at least one role is in NEITHER forced NOR
//       safe-skip after the rule layer.
//     - `deepseek-v4-flash:cloud` with a JSON-schema-constrained
//       response (chat.format). Temperature 0.
//     - Fail-closed: timeout, invalid JSON, low confidence on
//       protected roles → return ALL_SPECIALISTS for the ambiguous
//       set (i.e. run everything still ambiguous).
//
//   Reconcile:
//     - Forced wins over safe-skip when both fire (shouldn't happen
//       with the rule layer, but defensive).
//     - For ambiguous PROTECTED roles (security, logic) in normal
//       trust: consensus-to-skip. Run unless BOTH rules explicitly
//       safe-skip AND LLM says skip. The rule layer's "didn't
//       mention" is NOT a safe-skip vote, so LLM alone cannot
//       skip a protected role in normal trust.
//     - For ambiguous non-protected roles (performance, tests): LLM
//       decides directly.
//
// Phase 1 wiring (`triage-pr-review-ensemble.ts`): when
// `OPENCLAW_DYNAMIC_DISPATCHER_MODE === "shadow"`, the orchestrator
// computes a DispatcherDecision in parallel with the existing
// `decideSpecialists` and logs telemetry (`dispatcher-shadow-decision`
// + `dispatcher-llm-disagreement` when picks differ). The legacy
// router's picks still drive fan-out. Phase 2 (SIG-227) graduates
// non-protected enforcement; Phase 3 (SIG-228) graduates protected
// enforcement after shadow data clears the Wilson 99%-CI bar.
//
// All exports are pure-function-friendly: the only async/IO surface
// is the LLM call, which composes the caller's AbortSignal so the
// dispatcher can never outlive the orchestrator's 8s budget.

import type { Env } from "@/src/shared/types/env"
import type { ClassifiedDiffFile } from "./diff-file-classify"
import { ALL_SPECIALISTS, type DiffSignals, type SpecialistRole } from "./ensemble-router"
import type { DispatcherConfig, SigilixConfig } from "./sigilix-config"
import {
  anyMatchesPath,
  BEHAVIOR_CHANGE_RE,
  classifyFileTypes,
  CONTENT_SECURITY_PATTERNS,
  diffContainsExecutableMarkdownFences,
  GLOBAL_LOGIC_PATH_PATTERNS,
  GLOBAL_SECURITY_PATH_PATTERNS,
  matchAdditionalPatterns,
  touchesMigrationsOrSchema,
  touchesPackagesOrLockfile,
  truncate,
} from "./dynamic-dispatcher-patterns"
import { callLlmClassifier, type DispatcherLlmOutcome, type LlmClassifierResult } from "./dynamic-dispatcher-llm"

// Re-export the previously in-file public LLM surface so existing
// importers of `@/lib/dynamic-dispatcher` (e.g. the co-located test) are
// unchanged after the SIG-376 relocation.
export { DISPATCHER_LLM_MODEL, DISPATCHER_LLM_TIMEOUT_MS } from "./dynamic-dispatcher-llm"
export type { DispatcherLlmOutcome } from "./dynamic-dispatcher-llm"

// ─── Public types ─────────────────────────────────────────────────────

export interface DispatcherPerRoleVote {
  /** Final action after reconcile — does this role run? */
  action: "run" | "skip"
  /** 1-5 self-assessed confidence in the action. Comes from the LLM
   *  when the role was ambiguous; otherwise inherited from rule
   *  certainty (5 for forced/safe-skip rules). */
  confidence: 1 | 2 | 3 | 4 | 5
  /** Short audit trail. Empty for `dispatcher_disabled` paths. */
  reasons: string[]
}

export interface DispatcherLayerVotes {
  /** Roles forced ON by the global rule layer. */
  rulesForced: SpecialistRole[]
  /** Roles forced OFF by the global rule layer (shape-specific safe-skips). */
  rulesSafeSkip: SpecialistRole[]
  /** Roles forced ON by `sigilix.json::dispatcher.force`. */
  repoConfigForced: SpecialistRole[]
  /** LLM's picks among the ambiguous roles (empty array means LLM
   *  voted to skip every ambiguous role). */
  llmPicks: SpecialistRole[]
  /** Why the LLM call returned what it did. */
  llmOutcome: DispatcherLlmOutcome
}

export interface DispatcherDecision {
  /** Final fan-out set after rules + LLM + reconcile. */
  specialists: SpecialistRole[]
  /** Aggregated human-readable rationale for shadow-mode telemetry +
   *  the customer-visible review surface (Phase 2 will embed in
   *  `[DISPATCH COVERAGE]`). */
  reasoning: string
  /** Per-role audit trail. Always includes one entry per
   *  `SpecialistRole` so downstream consumers don't need to default. */
  perRole: Record<SpecialistRole, DispatcherPerRoleVote>
  /** Layer attribution (for shadow-mode FN analysis + replay). */
  layerVotes: DispatcherLayerVotes
  /** Wall-clock spent inside the dispatcher (excluding caller setup).
   *  Counts the LLM round-trip when fired. */
  elapsedMs: number
}

export interface DispatcherInputs {
  signals: DiffSignals
  classified: readonly ClassifiedDiffFile[]
  /**
   * Combined commit-message string (`${prTitle}\n\n${prBody}`) used by
   * the RULE LAYER's keyword-regex checks (e.g. `BEHAVIOR_CHANGE_RE`).
   * Safe to pass user-controlled content here because the regex runs
   * against the literal string and never reaches an LLM.
   */
  commitMessage: string
  /**
   * SIG-230 (prompt-injection hardening): when present, the dispatcher
   * LLM prompt wraps `prTitle` + `prBody` in a `<pr_metadata>` XML
   * envelope and the system prompt instructs the model to treat
   * `<pr_metadata>` content as data, not instructions. Each field is
   * separately sanitized via `sanitizeDispatcherMetadata`. When
   * absent (back-compat for unit tests that only go through the rule
   * layer), the LLM falls back to using `commitMessage` as the body —
   * still sanitized + wrapped, but without a separate `<title>`.
   */
  prTitle?: string
  prBody?: string
  repoConfig: SigilixConfig
  /** Read by the LLM-call branch only. Slice the Env so unit tests
   *  can construct minimal stubs. */
  env: Pick<Env, "OLLAMA_API_KEY" | "OLLAMA_CHAT_ENABLE" | "OPENCLAW_DYNAMIC_DISPATCHER_MODE">
  /** Composed with the dispatcher's internal 8s timeout so the
   *  caller (orchestrator) can abort us if the outer budget is
   *  blown. */
  signal?: AbortSignal
}

// ─── Tunables ─────────────────────────────────────────────────────────

const PROTECTED_ROLES: ReadonlySet<SpecialistRole> = new Set(["security", "logic"])

// ─── Tier 1 — rule layer ──────────────────────────────────────────────

interface RuleLayerResult {
  forcedRoles: Set<SpecialistRole>
  safeSkipRoles: Set<SpecialistRole>
  /** Per-role reason attribution. Keyed by role; values are the
   *  reason strings that fired for THAT role (not a shared global
   *  list). CodeRabbit M1 fix: prior shared `reasons: string[]`
   *  leaked unrelated rule attributions into every forced role's
   *  audit trail in `buildPerRoleVotes`. */
  roleReasons: Map<SpecialistRole, string[]>
}

/**
 * Pure rule layer. No I/O, no env reads beyond what the caller
 * passes in via `inputs`. Returns the forced + safe-skip role sets
 * plus per-role reason attribution for telemetry.
 *
 * NOTE: `repoConfig.dispatcher.force` is NOT consumed here —
 * `decideSpecialistsDynamic` reads it directly into `repoConfigForced`
 * to preserve layer separation (rule layer vs repo overrides).
 * `safetyNet.additionalPatterns` IS consumed here because those are
 * the per-repo extensions of the global safety net, which is rule-
 * layer territory.
 *
 * Exported for unit testing — the orchestrator goes through
 * `decideSpecialistsDynamic`.
 */
export function computeRuleLayer(
  inputs: Pick<DispatcherInputs, "signals" | "classified" | "commitMessage" | "repoConfig">,
): RuleLayerResult {
  const { signals, classified, commitMessage, repoConfig } = inputs
  const forced = new Set<SpecialistRole>()
  const safeSkip = new Set<SpecialistRole>()
  const roleReasons = new Map<SpecialistRole, string[]>()

  const recordReason = (role: SpecialistRole, reason: string): void => {
    const existing = roleReasons.get(role)
    if (existing) existing.push(reason)
    else roleReasons.set(role, [reason])
  }

  const paths = signals.paths
  const lowerPaths = paths.map((p) => p.toLowerCase())

  // ─── Docs-only-no-fences shortcut ───
  // Matches existing `ensemble-router.ts::decideSpecialists` semantics:
  // pure-docs (.md/.mdx/.txt/.rst/.adoc) AND no executable fenced
  // blocks in the added diff lines → no specialist applies.
  const fileTypes = classifyFileTypes(paths, classified)
  if (fileTypes.allDocsOnly) {
    const hasSuspiciousFences = signals.diffText === undefined || diffContainsExecutableMarkdownFences(signals.diffText)
    if (!hasSuspiciousFences) {
      for (const role of ALL_SPECIALISTS) {
        safeSkip.add(role)
        recordReason(role, "docs_only_no_executable_fences")
      }
      // Path-level safety overrides happen after — they can still
      // FORCE a role back on (e.g. a docs PR that touches
      // `.github/workflows/deploy.md` should still get security).
    }
  }

  // ─── CSS-only shortcut ───
  if (fileTypes.allCssOnly) {
    forced.add("performance")
    recordReason("performance", "css_only_perf_only")
    for (const role of ALL_SPECIALISTS) {
      if (role !== "performance") {
        safeSkip.add(role)
        recordReason(role, "css_only_safe_skip")
      }
    }
  }

  // ─── SIG-227a — lockfile-only shortcut ───
  // Pure dep-bump PR: every diffed file is a lockfile, no source /
  // config / docs / test changes. `touchesPackagesOrLockfile` below
  // also force-includes `security` for supply-chain review, so the
  // skip set is safe — security still runs.
  if (fileTypes.allLockfilesOnly) {
    for (const role of ALL_SPECIALISTS) {
      if (role !== "security") {
        safeSkip.add(role)
        recordReason(role, "lockfile_only_safe_skip")
      }
    }
  }

  // ─── SIG-227a — .d.ts-only shortcut ───
  // Pure TypeScript declaration changes describe types; runtime
  // behavior isn't affected, so security/logic/perf have nothing to
  // find. Keep tests on the lineup because type-only changes can
  // still affect assertion shape in dependent tests.
  if (fileTypes.allDtsOnly) {
    for (const role of ["security", "logic", "performance"] as const) {
      safeSkip.add(role)
      recordReason(role, "dts_only_safe_skip")
    }
  }

  // ─── SIG-227a — test-files-only shortcut ───
  // Pure test-coverage-add PR: every diffed file is a test file
  // (`*.test.*`, `*.spec.*`, `__tests__/**` per `diff-file-classify`).
  //
  // Safe-skip `performance` ONLY. Earlier draft also safe-skipped
  // `security`, but Sigilix bot finding on PR #185 correctly flagged
  // this: test files COMMONLY contain hardcoded API keys, mock
  // credentials, integration-test tokens that look real, and JWTs
  // with hardcoded payloads. Skipping security would silently route
  // accidental secret commits past the review pipeline.
  //
  // Wall-time impact of leaving security on: minimal. Logic still
  // dominates the critical path (~100-270s on `deepseek-v4-pro`),
  // and security on `deepseek-v4-flash` (~30-60s) finishes first in
  // parallel — costs only tokens, not wall-time. The wall-time win
  // from this shortcut comes from skipping performance (which has
  // genuinely no surface on test diffs).
  //
  // Logic stays on (test correctness IS logic; assertion-order
  // bugs, mock-vs-prod divergence) plus the tests specialist
  // obviously.
  if (fileTypes.allTestFilesOnly) {
    safeSkip.add("performance")
    recordReason("performance", "test_files_only_safe_skip_perf")
  }

  // ─── Global security force patterns ───
  if (anyMatchesPath(lowerPaths, GLOBAL_SECURITY_PATH_PATTERNS)) {
    forced.add("security")
    recordReason("security", "security_path_pattern")
  }
  if (touchesPackagesOrLockfile(lowerPaths)) {
    forced.add("security")
    recordReason("security", "supply_chain_lockfile")
  }
  // Content-level security forces (regex on added diff lines).
  if (signals.diffText && CONTENT_SECURITY_PATTERNS.some((re) => re.test(signals.diffText ?? ""))) {
    forced.add("security")
    recordReason("security", "security_content_pattern")
  }

  // ─── Global logic force patterns ───
  if (anyMatchesPath(lowerPaths, GLOBAL_LOGIC_PATH_PATTERNS)) {
    forced.add("logic")
    recordReason("logic", "logic_path_pattern")
  }
  if (touchesMigrationsOrSchema(lowerPaths)) {
    forced.add("security")
    forced.add("logic")
    recordReason("security", "schema_or_migration")
    recordReason("logic", "schema_or_migration")
  }
  // Behavior-change keywords in commit message on source files.
  if (classified.some((f) => f.kind === "source") && BEHAVIOR_CHANGE_RE.test(commitMessage)) {
    forced.add("logic")
    recordReason("logic", "source_change_with_behavior_commit")
  }

  // ─── Per-repo additionalPatterns (purely additive) ───
  // Note: `dispatcher.force` is intentionally NOT consumed here.
  // `decideSpecialistsDynamic` reads it directly into
  // `repoConfigForced` so the layer-attribution telemetry stays
  // clean (rule layer vs repo override vs LLM).
  const dispatcherConfig: DispatcherConfig | undefined = repoConfig.dispatcher
  if (dispatcherConfig?.safetyNet?.additionalPatterns) {
    const hitsByRole = matchAdditionalPatterns(paths, dispatcherConfig.safetyNet.additionalPatterns)
    for (const [role, matchedGlobs] of hitsByRole) {
      forced.add(role)
      for (const glob of matchedGlobs) {
        recordReason(role, `repo_additional_pattern=${glob}`)
      }
    }
  }

  // ─── Forced wins over safe-skip when both fire ───
  // Defensive: the shape shortcuts above only safe-skip; the global
  // forces only force. A real-world collision would be e.g. a
  // docs-only PR that touches `.github/workflows/foo.md` — the
  // docs shortcut says safe-skip-all, the workflow pattern force-
  // adds security. Force wins.
  for (const role of forced) safeSkip.delete(role)

  // When forced wins over safe-skip, the safe-skip reasons stay in
  // `roleReasons` because they're still an honest audit trail of
  // what the rules computed before the resolution. The role's
  // `action` in `buildPerRoleVotes` is the truth — reasons explain
  // why all the layers voted what they voted.
  return { forcedRoles: forced, safeSkipRoles: safeSkip, roleReasons }
}

// ─── Reconcile ────────────────────────────────────────────────────────

interface ReconcileInputs {
  rulesForced: ReadonlySet<SpecialistRole>
  repoConfigForced: ReadonlySet<SpecialistRole>
  rulesSafeSkip: ReadonlySet<SpecialistRole>
  ambiguous: ReadonlySet<SpecialistRole>
  llmPicks: ReadonlySet<SpecialistRole>
  llmConfidence: 1 | 2 | 3 | 4 | 5
  llmOutcome: DispatcherLlmOutcome
}

function reconcile(inp: ReconcileInputs): Set<SpecialistRole> {
  const final = new Set<SpecialistRole>()
  for (const role of ALL_SPECIALISTS) {
    if (inp.rulesForced.has(role) || inp.repoConfigForced.has(role)) {
      final.add(role)
      continue
    }
    if (inp.rulesSafeSkip.has(role)) {
      // Hard rules safe-skip — respect even for protected roles.
      // Rules-driven shape shortcuts (docs-only, CSS-only) are
      // intentional and the LLM doesn't override them.
      continue
    }
    if (!inp.ambiguous.has(role)) {
      // Belt-and-braces: a role that's neither forced, safe-skipped,
      // nor in the ambiguous set shouldn't exist; default to RUN so
      // we never silently drop a specialist.
      final.add(role)
      continue
    }
    // Ambiguous role.
    if (PROTECTED_ROLES.has(role)) {
      // Phase 1 consensus-to-skip in normal trust: an ambiguous
      // protected role ALWAYS runs (the rule layer's "didn't
      // mention" is NOT a safe-skip vote, so the LLM alone can't
      // skip security/logic). SIG-228 (Phase 3) will introduce
      // per-repo `trustLevel: "high"` to unlock LLM-overrides-rules
      // + a confidence floor; until then we converge here. The
      // dispatcher still threads `llmOutcome` + `llmConfidence`
      // through `buildPerRoleVotes` for shadow-mode telemetry —
      // those signals are preserved upstream of this reconcile, not
      // dead.
      final.add(role)
      continue
    }
    // Non-protected ambiguous role: LLM decides directly.
    if (inp.llmPicks.has(role)) final.add(role)
  }
  return final
}

// ─── Top-level orchestration ──────────────────────────────────────────

const DISABLED_DECISION_REASONING = "dispatcher_disabled"

/**
 * Top-level dispatcher entry. Computes the rule layer, fires the LLM
 * (if applicable), reconciles, and returns a single `DispatcherDecision`.
 *
 * Phase 1 callers (the orchestrator) treat this as advisory in
 * shadow mode (log the decision, don't change fan-out). Phase 2/3
 * callers will use `.specialists` directly for fan-out.
 *
 * Never throws — every failure path returns a decision (with the
 * appropriate `llmOutcome`) so the caller can rely on a non-null
 * result.
 */
export async function decideSpecialistsDynamic(inputs: DispatcherInputs): Promise<DispatcherDecision> {
  const t0 = Date.now()
  const mode = inputs.env.OPENCLAW_DYNAMIC_DISPATCHER_MODE
  if (mode !== "shadow" && mode !== "enforce" && mode !== "enforce_rules") {
    return makeDisabledDecision(t0)
  }
  // SIG-227a: `enforce_rules` runs the rule layer ONLY (no LLM call)
  // and uses its picks for fan-out. The orchestrator wires this in
  // by replacing `router.specialists` with this decision's picks.
  // Ambiguous roles (not forced + not safe-skipped) default to RUN
  // — the same conservative behavior as the legacy router.
  const rulesOnly = mode === "enforce_rules"

  // ─── Tier 1 ───
  const rules = computeRuleLayer(inputs)
  const repoConfigForced = new Set<SpecialistRole>(inputs.repoConfig.dispatcher?.force ?? [])
  const ambiguous = new Set<SpecialistRole>()
  for (const role of ALL_SPECIALISTS) {
    if (rules.forcedRoles.has(role)) continue
    if (rules.safeSkipRoles.has(role)) continue
    if (repoConfigForced.has(role)) continue
    ambiguous.add(role)
  }

  // ─── Tier 2 ───
  // SIG-227a: enforce_rules mode skips the LLM entirely — protected
  // ambiguous roles default to RUN per the reconciler's existing
  // consensus-to-skip semantic. The synthetic LLM result here makes
  // downstream reconcile/telemetry treat ambiguous non-protected
  // roles as "run by default" (picks = all ambiguous) since the rule
  // layer didn't actively safe-skip them.
  let llm: LlmClassifierResult
  if (rulesOnly) {
    llm = {
      outcome: "skipped_rules_only_mode",
      picks: [...ambiguous],
      confidence: 5,
      reasoning: "rules_only_mode_no_llm_call",
    }
  } else if (ambiguous.size === 0) {
    llm = {
      outcome: "skipped_no_ambiguous",
      picks: [],
      confidence: 5,
      reasoning: "rules decided every role",
    }
  } else if (inputs.env.OLLAMA_CHAT_ENABLE !== "on") {
    llm = {
      outcome: "disabled",
      picks: [...ambiguous],
      confidence: 1,
      reasoning: "OLLAMA_CHAT_ENABLE=off; failing closed to ambiguous-all",
    }
  } else {
    llm = await callLlmClassifier({
      signals: inputs.signals,
      classified: inputs.classified,
      commitMessage: inputs.commitMessage,
      // SIG-230: thread the separated title/body so the LLM prompt
      // sees them inside <pr_metadata> XML envelope. Falls back to
      // splitting commitMessage when absent (back-compat).
      ...(inputs.prTitle !== undefined ? { prTitle: inputs.prTitle } : {}),
      ...(inputs.prBody !== undefined ? { prBody: inputs.prBody } : {}),
      ambiguous: [...ambiguous],
      apiKey: inputs.env.OLLAMA_API_KEY,
      ...(inputs.signal ? { signal: inputs.signal } : {}),
      onSanitized: (sanitized) => {
        // SIG-230: telemetry hook fires once the metadata is
        // sanitized but BEFORE the chat() call. Emits a structured
        // event the dashboard can grep to see prompt-injection
        // patterns in the wild — high-frequency hits suggest an
        // actual attacker probing, low-frequency hits are typical
        // false positives from legitimate engineering language
        // (e.g. PR body says "ignore the test failure for now").
        const s = sanitized.stripped
        const totalHits =
          s.titleRoleTokenHits + s.titleInjectionTriggerHits + s.bodyRoleTokenHits + s.bodyInjectionTriggerHits
        if (totalHits === 0) return
        console.log(
          JSON.stringify({
            event: "dispatcher-prompt-sanitized",
            titleRoleTokenHits: s.titleRoleTokenHits,
            titleInjectionTriggerHits: s.titleInjectionTriggerHits,
            bodyRoleTokenHits: s.bodyRoleTokenHits,
            bodyInjectionTriggerHits: s.bodyInjectionTriggerHits,
            sampleTriggers: s.sampleTriggers,
            totalHits,
          }),
        )
      },
    })
  }

  // ─── Reconcile ───
  const finalSet = reconcile({
    rulesForced: rules.forcedRoles,
    repoConfigForced,
    rulesSafeSkip: rules.safeSkipRoles,
    ambiguous,
    llmPicks: new Set(llm.picks),
    llmConfidence: llm.confidence,
    llmOutcome: llm.outcome,
  })
  const specialists: SpecialistRole[] = ALL_SPECIALISTS.filter((r) => finalSet.has(r))

  // ─── Per-role audit trail ───
  const perRole = buildPerRoleVotes({
    rules,
    repoConfigForced,
    ambiguous,
    llm,
    finalSet,
  })

  return {
    specialists,
    reasoning: composeReasoning(rules, llm, repoConfigForced),
    perRole,
    layerVotes: {
      rulesForced: [...rules.forcedRoles],
      rulesSafeSkip: [...rules.safeSkipRoles],
      repoConfigForced: [...repoConfigForced],
      llmPicks: [...llm.picks],
      llmOutcome: llm.outcome,
    },
    elapsedMs: Date.now() - t0,
  }
}

function makeDisabledDecision(t0: number): DispatcherDecision {
  // Match ALL_SPECIALISTS for the "specialists" field so a Phase 2+
  // enforce-mode caller never accidentally drops everything when the
  // mode flag is misconfigured.
  return {
    specialists: [...ALL_SPECIALISTS],
    reasoning: DISABLED_DECISION_REASONING,
    perRole: makeUniformPerRole("run", 5, [DISABLED_DECISION_REASONING]),
    layerVotes: {
      rulesForced: [],
      rulesSafeSkip: [],
      repoConfigForced: [],
      llmPicks: [],
      llmOutcome: "disabled",
    },
    elapsedMs: Date.now() - t0,
  }
}

function makeUniformPerRole(
  action: "run" | "skip",
  confidence: 1 | 2 | 3 | 4 | 5,
  reasons: string[],
): Record<SpecialistRole, DispatcherPerRoleVote> {
  const out = {} as Record<SpecialistRole, DispatcherPerRoleVote>
  for (const role of ALL_SPECIALISTS) {
    out[role] = { action, confidence, reasons: [...reasons] }
  }
  return out
}

function buildPerRoleVotes(args: {
  rules: RuleLayerResult
  repoConfigForced: ReadonlySet<SpecialistRole>
  ambiguous: ReadonlySet<SpecialistRole>
  llm: LlmClassifierResult
  finalSet: ReadonlySet<SpecialistRole>
}): Record<SpecialistRole, DispatcherPerRoleVote> {
  const out = {} as Record<SpecialistRole, DispatcherPerRoleVote>
  const llmPickSet = new Set(args.llm.picks)
  for (const role of ALL_SPECIALISTS) {
    const reasons: string[] = []
    // CodeRabbit M1 fix: pull reasons from the per-role attribution
    // map. Previously we copied the entire shared `rules.reasons`
    // list into every forced role's audit trail, which leaked
    // unrelated rule attribution across roles in shadow telemetry.
    const perRoleRuleReasons = args.rules.roleReasons.get(role)
    if (args.rules.forcedRoles.has(role)) {
      reasons.push("rules_forced")
      if (perRoleRuleReasons) reasons.push(...perRoleRuleReasons)
    }
    if (args.repoConfigForced.has(role)) reasons.push("repo_config_force")
    if (args.rules.safeSkipRoles.has(role)) {
      reasons.push("rules_safe_skip")
      // Safe-skip reasons (docs_only / css_only) are also per-role;
      // include them when the role wasn't ALSO forced (force-wins
      // collision case already added the force reasons above).
      if (perRoleRuleReasons && !args.rules.forcedRoles.has(role)) {
        reasons.push(...perRoleRuleReasons)
      }
    }
    if (args.ambiguous.has(role)) {
      reasons.push(`llm_outcome=${args.llm.outcome}`)
      reasons.push(llmPickSet.has(role) ? "llm_says_run" : "llm_says_skip")
    }
    const action: "run" | "skip" = args.finalSet.has(role) ? "run" : "skip"
    // Confidence: forced/safe-skip = 5 (rule-certain); ambiguous =
    // inherit LLM confidence.
    const confidence: 1 | 2 | 3 | 4 | 5 = args.ambiguous.has(role) ? args.llm.confidence : 5
    out[role] = { action, confidence, reasons }
  }
  return out
}

function composeReasoning(
  rules: RuleLayerResult,
  llm: LlmClassifierResult,
  repoConfigForced: ReadonlySet<SpecialistRole>,
): string {
  const parts: string[] = []
  if (rules.roleReasons.size > 0) {
    // Flatten the per-role reason map into a top-level summary
    // string. Each role's reasons are grouped under the role name so
    // the top-level dispatcher reasoning stays readable for shadow
    // telemetry while still distinguishing per-role attribution.
    const grouped: string[] = []
    for (const [role, reasons] of rules.roleReasons) {
      if (reasons.length > 0) grouped.push(`${role}=${reasons.join(",")}`)
    }
    if (grouped.length > 0) parts.push(`rules[${grouped.join(" ; ")}]`)
  }
  if (repoConfigForced.size > 0) parts.push(`repo_force: ${[...repoConfigForced].join(",")}`)
  parts.push(`llm[${llm.outcome}, conf=${llm.confidence}]: ${truncate(llm.reasoning, 200)}`)
  return parts.join(" | ")
}
