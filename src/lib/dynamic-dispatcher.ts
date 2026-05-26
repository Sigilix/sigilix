// SIG-226 / SIG-224 Phase 1 — dynamic specialist dispatcher.
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

import type { Env } from "../index"
import type { ClassifiedDiffFile } from "./diff-file-classify"
import {
  ALL_SPECIALISTS,
  type DiffSignals,
  type SpecialistRole,
} from "./ensemble-router"
import { chat } from "./ollama-chat"
import type { DispatcherConfig, DispatcherSafetyNetPattern, SigilixConfig } from "./sigilix-config"
import { compileGlob } from "./path-glob"

// ─── Public types ─────────────────────────────────────────────────────

export type DispatcherLlmOutcome =
  | "ok"
  | "timeout"
  | "invalid_json"
  | "disabled"           // OLLAMA_CHAT_ENABLE=off OR mode=off
  | "skipped_no_ambiguous"  // rules decided everything
  | "no_api_key"
  | "chat_error"         // any chat() throw other than abort: HTTP error,
                         // stream error, missing body, etc. Renamed from
                         // `http_error` per code-review H2 — the original
                         // name was too narrow.

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
  commitMessage: string
  repoConfig: SigilixConfig
  /** Read by the LLM-call branch only. Slice the Env so unit tests
   *  can construct minimal stubs. */
  env: Pick<
    Env,
    "OLLAMA_API_KEY" | "OLLAMA_CHAT_ENABLE" | "OPENCLAW_DYNAMIC_DISPATCHER_MODE"
  >
  /** Composed with the dispatcher's internal 8s timeout so the
   *  caller (orchestrator) can abort us if the outer budget is
   *  blown. */
  signal?: AbortSignal
}

// ─── Tunables ─────────────────────────────────────────────────────────

/** Hard cap on the LLM call. Per spec Q1: dispatcher must fit inside
 *  the 5-10s budget. 8s leaves 2s headroom for the orchestrator to
 *  observe a fail-closed return. */
export const DISPATCHER_LLM_TIMEOUT_MS = 8_000

/** Model used for the LLM classifier. In-fleet (same provider as the
 *  tests specialist); changing this is a routing-table edit. */
export const DISPATCHER_LLM_MODEL = "deepseek-v4-flash:cloud"

/** Per-file diff-snippet cap fed into the LLM prompt. The prompt-
 *  budget target is ~1500 input tokens; with 4 files at ~200 chars
 *  per snippet + classification block + commit message we stay well
 *  under cap. */
const DIFF_SNIPPET_MAX_LINES = 20
const DIFF_SNIPPET_MAX_FILES = 8

const PROTECTED_ROLES: ReadonlySet<SpecialistRole> = new Set(["security", "logic"])

// ─── Tier 1 — rule layer ──────────────────────────────────────────────

interface RuleLayerResult {
  forcedRoles: Set<SpecialistRole>
  safeSkipRoles: Set<SpecialistRole>
  /** Audit trail per fired pattern. */
  reasons: string[]
}

/**
 * Pure rule layer. No I/O, no env reads beyond what the caller
 * passes in via `inputs`. Returns the forced + safe-skip role sets
 * plus a human-readable reason list for telemetry.
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
  const reasons: string[] = []

  const paths = signals.paths
  const lowerPaths = paths.map((p) => p.toLowerCase())

  // ─── Docs-only-no-fences shortcut ───
  // Matches existing `ensemble-router.ts::decideSpecialists` semantics:
  // pure-docs (.md/.mdx/.txt/.rst/.adoc) AND no executable fenced
  // blocks in the added diff lines → no specialist applies.
  const fileTypes = classifyFileTypes(paths)
  if (fileTypes.allDocsOnly) {
    const hasSuspiciousFences = signals.diffText === undefined
      || diffContainsExecutableMarkdownFences(signals.diffText)
    if (!hasSuspiciousFences) {
      for (const role of ALL_SPECIALISTS) safeSkip.add(role)
      reasons.push("docs_only_no_executable_fences")
      // Path-level safety overrides happen after — they can still
      // FORCE a role back on (e.g. a docs PR that touches
      // `.github/workflows/deploy.md` should still get security).
    }
  }

  // ─── CSS-only shortcut ───
  if (fileTypes.allCssOnly) {
    forced.add("performance")
    for (const role of ALL_SPECIALISTS) {
      if (role !== "performance") safeSkip.add(role)
    }
    reasons.push("css_only_perf_only")
  }

  // ─── Global security force patterns ───
  if (anyMatchesPath(lowerPaths, GLOBAL_SECURITY_PATH_PATTERNS)) {
    forced.add("security")
    reasons.push("security_path_pattern")
  }
  if (touchesPackagesOrLockfile(lowerPaths)) {
    forced.add("security")
    reasons.push("supply_chain_lockfile")
  }
  // Content-level security forces (regex on added diff lines).
  if (signals.diffText && CONTENT_SECURITY_PATTERNS.some((re) => re.test(signals.diffText ?? ""))) {
    forced.add("security")
    reasons.push("security_content_pattern")
  }

  // ─── Global logic force patterns ───
  if (anyMatchesPath(lowerPaths, GLOBAL_LOGIC_PATH_PATTERNS)) {
    forced.add("logic")
    reasons.push("logic_path_pattern")
  }
  if (touchesMigrationsOrSchema(lowerPaths)) {
    forced.add("security")
    forced.add("logic")
    reasons.push("schema_or_migration")
  }
  // Behavior-change keywords in commit message on source files.
  if (
    classified.some((f) => f.kind === "source")
    && BEHAVIOR_CHANGE_RE.test(commitMessage)
  ) {
    forced.add("logic")
    reasons.push("source_change_with_behavior_commit")
  }

  // ─── Per-repo dispatcher.force ───
  const dispatcherConfig: DispatcherConfig | undefined = repoConfig.dispatcher
  if (dispatcherConfig?.force) {
    for (const role of dispatcherConfig.force) {
      forced.add(role)
    }
    if (dispatcherConfig.force.length > 0) {
      reasons.push(`repo_config_force=${dispatcherConfig.force.join(",")}`)
    }
  }

  // ─── Per-repo additionalPatterns (purely additive) ───
  if (dispatcherConfig?.safetyNet?.additionalPatterns) {
    const hits = matchAdditionalPatterns(paths, dispatcherConfig.safetyNet.additionalPatterns)
    for (const role of hits) {
      forced.add(role)
    }
    if (hits.size > 0) {
      reasons.push(`repo_additional_patterns=${[...hits].join(",")}`)
    }
  }

  // ─── Forced wins over safe-skip when both fire ───
  // Defensive: the shape shortcuts above only safe-skip; the global
  // forces only force. A real-world collision would be e.g. a
  // docs-only PR that touches `.github/workflows/foo.md` — the
  // docs shortcut says safe-skip-all, the workflow pattern force-
  // adds security. Force wins.
  for (const role of forced) safeSkip.delete(role)

  return { forcedRoles: forced, safeSkipRoles: safeSkip, reasons }
}

// ─── Tier 2 — LLM classifier ──────────────────────────────────────────

interface LlmClassifierResult {
  outcome: DispatcherLlmOutcome
  picks: SpecialistRole[]
  confidence: 1 | 2 | 3 | 4 | 5
  reasoning: string
  rawAnswer?: string
}

/** JSON schema used to constrain the LLM's response. Field set
 *  intentionally narrow — the dispatcher emits per-role telemetry
 *  itself; the LLM only needs to say which subset of the ambiguous
 *  roles should run. Typed as `Record<string, unknown>` (rather than
 *  the literal-typed `as const` shape) so `chat()`'s `format?:
 *  Record<string, unknown>` parameter type-checks without a
 *  double-cast through `unknown` (TS-pro #3). */
const DISPATCHER_LLM_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    specialists: {
      type: "array",
      items: { type: "string", enum: ["logic", "security", "performance", "tests"] },
      uniqueItems: true,
    },
    reasoning: { type: "string", maxLength: 500 },
    confidence: { type: "integer", minimum: 1, maximum: 5 },
  },
  required: ["specialists", "reasoning", "confidence"],
}

async function callLlmClassifier(args: {
  signals: DiffSignals
  classified: readonly ClassifiedDiffFile[]
  commitMessage: string
  ambiguous: readonly SpecialistRole[]
  apiKey: string
  signal?: AbortSignal
}): Promise<LlmClassifierResult> {
  if (!args.apiKey) {
    return {
      outcome: "no_api_key",
      picks: [...args.ambiguous],
      confidence: 1,
      reasoning: "OLLAMA_API_KEY missing; failing closed to ambiguous-all",
    }
  }

  // Compose the orchestrator's signal with our internal 8s budget so
  // either source can abort the chat. Match the pattern used in
  // `ollama-chat.ts::chat`.
  const internalCtrl = new AbortController()
  const timer = setTimeout(() => internalCtrl.abort(), DISPATCHER_LLM_TIMEOUT_MS)
  const onExternalAbort = (): void => internalCtrl.abort()
  args.signal?.addEventListener("abort", onExternalAbort, { once: true })
  if (args.signal?.aborted) internalCtrl.abort()

  try {
    const result = await chat({
      model: DISPATCHER_LLM_MODEL,
      apiKey: args.apiKey,
      messages: buildLlmMessages(args),
      format: DISPATCHER_LLM_SCHEMA,
      temperature: 0,
      timeoutMs: DISPATCHER_LLM_TIMEOUT_MS,
      signal: internalCtrl.signal,
      // Caller already gated on env.OLLAMA_CHAT_ENABLE === "on" before
      // reaching this branch; the literal here is a re-affirmation,
      // not a bypass. See `decideSpecialistsDynamic` upstream.
      chatEnabled: "on",
    })
    const parsed = parseLlmAnswer(result.message.content)
    if (!parsed) {
      return {
        outcome: "invalid_json",
        picks: [...args.ambiguous],
        confidence: 1,
        reasoning: "LLM output did not match schema; failing closed to ambiguous-all",
        rawAnswer: result.message.content.slice(0, 2000),
      }
    }
    // Validate that the LLM's picks are a SUBSET of the ambiguous
    // set. Defensive: if the model returns a role it shouldn't be
    // deciding (e.g. a forced role), we drop it here. The reconciler
    // re-applies forces anyway, so this is mostly hygiene.
    const ambiguousSet = new Set(args.ambiguous)
    const filteredPicks = parsed.specialists.filter((r) => ambiguousSet.has(r))
    return {
      outcome: "ok",
      picks: filteredPicks,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
      rawAnswer: result.message.content.slice(0, 2000),
    }
  } catch (err) {
    const errStr = err instanceof Error ? err.message : String(err)
    // Timeout vs HTTP error: chat() throws "aborted" on signal abort
    // and "Ollama HTTP <status>: ..." on HTTP failures. Map them.
    const isAbort = /abort/i.test(errStr) || internalCtrl.signal.aborted
    return {
      outcome: isAbort ? "timeout" : "chat_error",
      picks: [...args.ambiguous],
      confidence: 1,
      reasoning: `LLM call failed (${errStr.slice(0, 200)}); failing closed to ambiguous-all`,
    }
  } finally {
    clearTimeout(timer)
    args.signal?.removeEventListener("abort", onExternalAbort)
  }
}

function buildLlmMessages(args: {
  signals: DiffSignals
  classified: readonly ClassifiedDiffFile[]
  commitMessage: string
  ambiguous: readonly SpecialistRole[]
}): Array<{ role: "system" | "user"; content: string }> {
  const fileSummary = args.classified.slice(0, DIFF_SNIPPET_MAX_FILES).map((f) => {
    const siblingNote =
      f.kind === "source" && f.testsSibling
        ? ` (covered by test ${f.testsSibling})`
        : f.kind === "source" && !f.testsSibling
          ? " (no sibling test in this diff)"
          : ""
    return `- [${f.kind}] ${f.path}${siblingNote}`
  }).join("\n")

  const diffSample = args.signals.diffText
    ? extractDiffSample(args.signals.diffText, DIFF_SNIPPET_MAX_LINES * DIFF_SNIPPET_MAX_FILES)
    : "(diff text unavailable)"

  const system = [
    "You are the Sigilix specialist-dispatcher. Decide which of the listed AMBIGUOUS review specialists should run on this PR diff.",
    "Roles you can pick from:",
    "  - logic: correctness, control-flow, off-by-one, edge-case handling, concurrency, retries.",
    "  - security: authz/authn, secret handling, injection, supply-chain, CORS/CSP/CSRF, deserialization.",
    "  - performance: latency, allocation, N+1, cache behavior, render thrash.",
    "  - tests: coverage gaps, missing assertions, fragile patterns.",
    "Return ONLY roles that are likely to find a real issue on THIS diff. Empty array is valid when nothing applies.",
    "Confidence: 5 = very confident, 1 = wild guess.",
  ].join("\n")

  const user = [
    `AMBIGUOUS roles (decide each): ${args.ambiguous.join(", ")}`,
    "",
    `Commit message: ${truncate(args.commitMessage, 400)}`,
    "",
    `Changed files (${args.classified.length}):`,
    fileSummary,
    "",
    "Diff sample (first hunk of first files, truncated):",
    "```",
    diffSample,
    "```",
  ].join("\n")

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ]
}

function parseLlmAnswer(raw: string): { specialists: SpecialistRole[]; confidence: 1 | 2 | 3 | 4 | 5; reasoning: string } | null {
  if (!raw || typeof raw !== "string") return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const rec = parsed as Record<string, unknown>
  if (!Array.isArray(rec.specialists)) return null
  const specialists: SpecialistRole[] = []
  for (const v of rec.specialists) {
    if (typeof v !== "string") continue
    if (v === "logic" || v === "security" || v === "performance" || v === "tests") {
      if (!specialists.includes(v)) specialists.push(v)
    }
  }
  const confRaw = rec.confidence
  const confidence: 1 | 2 | 3 | 4 | 5 =
    typeof confRaw === "number" && confRaw >= 1 && confRaw <= 5 && Number.isInteger(confRaw)
      ? (confRaw as 1 | 2 | 3 | 4 | 5)
      : 3
  const reasoning =
    typeof rec.reasoning === "string" ? rec.reasoning.slice(0, 500) : ""
  return { specialists, confidence, reasoning }
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
export async function decideSpecialistsDynamic(
  inputs: DispatcherInputs,
): Promise<DispatcherDecision> {
  const t0 = Date.now()
  const mode = inputs.env.OPENCLAW_DYNAMIC_DISPATCHER_MODE
  if (mode !== "shadow" && mode !== "enforce") {
    return makeDisabledDecision(t0)
  }

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
  let llm: LlmClassifierResult
  if (ambiguous.size === 0) {
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
      ambiguous: [...ambiguous],
      apiKey: inputs.env.OLLAMA_API_KEY,
      ...(inputs.signal ? { signal: inputs.signal } : {}),
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
    if (args.rules.forcedRoles.has(role)) {
      reasons.push("rules_forced")
      reasons.push(...args.rules.reasons)
    }
    if (args.repoConfigForced.has(role)) reasons.push("repo_config_force")
    if (args.rules.safeSkipRoles.has(role)) reasons.push("rules_safe_skip")
    if (args.ambiguous.has(role)) {
      reasons.push(`llm_outcome=${args.llm.outcome}`)
      reasons.push(llmPickSet.has(role) ? "llm_says_run" : "llm_says_skip")
    }
    const action: "run" | "skip" = args.finalSet.has(role) ? "run" : "skip"
    // Confidence: forced/safe-skip = 5 (rule-certain); ambiguous =
    // inherit LLM confidence.
    const confidence: 1 | 2 | 3 | 4 | 5 = args.ambiguous.has(role)
      ? args.llm.confidence
      : 5
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
  if (rules.reasons.length > 0) parts.push(`rules: ${rules.reasons.join("; ")}`)
  if (repoConfigForced.size > 0) parts.push(`repo_force: ${[...repoConfigForced].join(",")}`)
  parts.push(`llm[${llm.outcome}, conf=${llm.confidence}]: ${truncate(llm.reasoning, 200)}`)
  return parts.join(" | ")
}

// ─── Path / content pattern helpers ──────────────────────────────────

const DOCS_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"])
const CSS_EXTENSIONS = new Set([".css", ".scss", ".sass", ".less"])

function classifyFileTypes(paths: readonly string[]): { allDocsOnly: boolean; allCssOnly: boolean } {
  if (paths.length === 0) return { allDocsOnly: false, allCssOnly: false }
  let docs = 0
  let css = 0
  for (const p of paths) {
    const ext = extOf(p)
    if (DOCS_EXTENSIONS.has(ext)) docs++
    else if (CSS_EXTENSIONS.has(ext)) css++
  }
  return {
    allDocsOnly: docs === paths.length,
    allCssOnly: css === paths.length,
  }
}

function extOf(path: string): string {
  const slash = path.lastIndexOf("/")
  const name = slash >= 0 ? path.slice(slash + 1) : path
  const dot = name.lastIndexOf(".")
  return dot >= 0 ? name.slice(dot).toLowerCase() : ""
}

/**
 * Expanded SECURITY safety-net path patterns. Code-owned, additive
 * via per-repo config (never deletable). Order matters only for
 * telemetry — a hit anywhere short-circuits.
 *
 * Each pattern is matched against the LOWERCASED path.
 *
 * Pattern style: long substrings that commonly appear as prefixes in
 * compound filenames use `\bfoo\w*` to catch camelCase / dash
 * variants (`authorize.ts`, `auth0-helper.ts`, `jwtDecode.ts`,
 * `passwordReset.ts`). Short acronyms (`saml`, `oidc`, `rbac`,
 * `acl`, `iam`) use `\b...\b` because they're rarely a prefix of
 * unrelated words. Safety-net errs on false-positive force-include
 * over false-negative miss (per spec Q5: "safety net wins silently
 * when it disagrees with the LLM"). Code-review M1 fix: the prior
 * `\bauth\b` etc. missed `authorize`, `auth0-*`, `jwtDecode`,
 * `passwordReset` — material recall hole for the protected-role
 * graduation bar.
 */
const GLOBAL_SECURITY_PATH_PATTERNS: readonly RegExp[] = [
  // Auth / authn / authz family — match as prefix to catch
  // `authorize`, `authentication`, `auth0`, etc.
  /\bauth\w*/,
  /\biam\b/,
  /\bpermission\w*/,
  /\bpolic(?:y|ies|ying)\b/,
  /\bsecurity\w*/,
  // Tokens, sessions, secrets — prefix match
  /\bjwt\w*/,
  /\boauth\w*/,
  /\bsession\w*/,
  /\bcookie\w*/,
  /\bpassword\w*/,
  /\btoken\w*/,
  /\bsecret\w*/,
  /\bcrypto\w*/,
  /\bcredential\w*/,
  /\bvault\b/,
  // Short acronyms — kept as full word match (rare as prefixes)
  /\bsaml\b/,
  /\boidc\b/,
  /\brbac\b/,
  /\bacl\b/,
  // Web-security middleware primitives
  /\bmiddleware\w*/,
  /\bguard\w*/,
  /\bcors\b/,
  /\bcsp\b/,
  /\bcsrf\b/,
  /\bxss\b/,
  // Env / credential files
  /(?:^|\/)\.env(?:\.|$)/,
  /\.(pem|key|crt|cer|p12|pfx|jks)$/,
  // CI / deploy / infra-as-code (executable in CI context)
  /(?:^|\/)\.github\/workflows\//,
  /(?:^|\/)dockerfile(?:\.|$|\b)/,
  /\.(tf|hcl|tfvars)$/,
  /(?:^|\/)(k8s|kubernetes|helm)\//,
  /(?:^|\/)nginx\.conf$/,
  // Webhooks + RLS policy files
  /\bwebhook\w*/,
  /\.policy\.[a-z0-9]+$/,
  /(?:^|\/)policies\//,
]

/**
 * Expanded LOGIC safety-net path patterns. Mirrors the spec's Q5
 * list — correctness-sensitive code surfaces where a "logic
 * specialist not invoked" miss would be expensive.
 */
const GLOBAL_LOGIC_PATH_PATTERNS: readonly RegExp[] = [
  // Parsers, serializers, regex / state-machine code
  /\b(parser|parsers|serialize(?:r)?|deserialize(?:r)?|regex|state[-_]?machine)\b/,
  // Retry / cache / queue / concurrency primitives
  /\b(retry|backoff|cache(?!\.test)|queue(?!\.test)|lock|mutex|semaphore|concurren\w*)\b/,
  // Billing / payments / public API contracts
  /(?:^|\/)(billing|payment|payments|stripe|invoice|invoices)\//,
  /(?:^|\/)(api|routes?|public)\//,
]

// Known evasion gaps (code-review M3): these regexes catch the common
// dangerous-sink shapes in real-world JS/TS code, but they ARE NOT a
// complete sandbox. Multi-line template literals (`eval` text on a
// non-`+` line), string-construction (`globalThis["ev"+"al"]`),
// `Reflect.construct(Function, ...)`, and indirect calls
// (`(0, eval)(...)`) all slip through. The dispatcher's safety net is
// intentionally coarse + additive — Phase 2 will surface evasion-rate
// telemetry so we can tighten the regexes when shadow data shows real
// false negatives in production.
const CONTENT_SECURITY_PATTERNS: readonly RegExp[] = [
  // JavaScript / TS dangerous sinks. Anchor with `+` so we only see
  // added lines.
  /^\+.*\beval\s*\(/m,
  /^\+.*\.innerHTML\s*=/m,
  /^\+.*\bdangerouslySetInnerHTML\b/m,
  /^\+.*\bnew\s+Function\s*\(/m,
  // Process spawning (often a sign of shell-injection risk)
  /^\+.*\b(child_process|spawn|exec|execSync|execFileSync)\b/m,
  // SQL template literal tag (raw query construction)
  /^\+.*\bsql`/m,
  // Hardcoded high-entropy secrets — caught by `secret-scan.ts` too,
  // but this is a coarse safety-net hint that forces security review
  // even if the secret-scan deduper missed it.
  /^\+.*\b(PRIVATE\s*KEY|PASSWORD|SECRET|API_KEY)\b/m,
]

const BEHAVIOR_CHANGE_RE = /\b(fix|fixes|fixed|change|changes|changed|break|breaking|behavior|behaviour|refactor|rewrite|migrate|deprecat\w*)\b/i

function anyMatchesPath(lowerPaths: readonly string[], patterns: readonly RegExp[]): boolean {
  for (const path of lowerPaths) {
    for (const re of patterns) {
      if (re.test(path)) return true
    }
  }
  return false
}

function touchesPackagesOrLockfile(lowerPaths: readonly string[]): boolean {
  return lowerPaths.some((p) => {
    const name = p.split("/").pop() ?? p
    return (
      name === "package.json" ||
      name === "package-lock.json" ||
      name === "yarn.lock" ||
      name === "pnpm-lock.yaml" ||
      name === "cargo.toml" ||
      name === "cargo.lock" ||
      name === "go.mod" ||
      name === "go.sum" ||
      name === "requirements.txt" ||
      name === "pyproject.toml" ||
      name === "poetry.lock" ||
      name === "gemfile.lock"
    )
  })
}

function touchesMigrationsOrSchema(lowerPaths: readonly string[]): boolean {
  return lowerPaths.some((p) => {
    return (
      p.includes("/migrations/") ||
      p.includes("/migrate/") ||
      p.endsWith(".sql") ||
      p.endsWith("schema.prisma") ||
      p.endsWith("schema.rb") ||
      /\bschema\b\.[a-z0-9]+$/.test(p) ||
      /\bmigration\b/.test(p)
    )
  })
}

const SUSPICIOUS_FENCE_LANGUAGES = new Set([
  "sh", "bash", "shell", "zsh", "fish", "powershell", "ps", "ps1",
  "yaml", "yml", "json",
  "dockerfile", "docker",
  "hcl", "tf", "terraform",
  "groovy",
  "ts", "typescript", "js", "javascript",
  "py", "python",
  "rb", "ruby",
  "go",
  "rs", "rust",
  "sql",
  "nginx", "apache",
])

function diffContainsExecutableMarkdownFences(diff: string): boolean {
  if (!diff || typeof diff !== "string") return false
  const lines = diff.split("\n")
  for (const line of lines) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue
    const content = line.slice(1).trimStart()
    const match = content.match(/^```(\w+)/)
    if (!match) continue
    const lang = match[1]?.toLowerCase()
    if (lang && SUSPICIOUS_FENCE_LANGUAGES.has(lang)) return true
  }
  return false
}

function matchAdditionalPatterns(
  paths: readonly string[],
  patterns: readonly DispatcherSafetyNetPattern[],
): Set<SpecialistRole> {
  const hits = new Set<SpecialistRole>()
  for (const pat of patterns) {
    let re: RegExp
    try {
      re = compileGlob(pat.glob)
    } catch {
      // Malformed glob in user config — skip (fail-open per the
      // sigilix-config contract).
      continue
    }
    if (paths.some((p) => re.test(p))) {
      hits.add(pat.role)
    }
  }
  return hits
}

function extractDiffSample(diff: string, maxLines: number): string {
  const lines = diff.split("\n").slice(0, maxLines * 4) // pre-trim raw
  const sample: string[] = []
  for (const line of lines) {
    sample.push(line)
    if (sample.length >= maxLines) break
  }
  return sample.join("\n")
}

function truncate(s: string, maxChars: number): string {
  if (!s) return ""
  return s.length <= maxChars ? s : `${s.slice(0, maxChars - 1)}…`
}
