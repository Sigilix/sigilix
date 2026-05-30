// SIG-236 — surgical prompt-budget telemetry for the logic specialist.
//
// Production telemetry on PR #188 showed two different model families
// (deepseek-v4-flash + kimi-k2.5) BOTH hit exactly PER_ATTEMPT_TIMEOUT_MS
// = 60_000ms on the logic role. Codex's diagnostic: logic's prompt shape
// is uniquely expensive (full retrieval + SIG-138 graph context + SIG-121
// symbol retrieval), not the models. No model swap fixes this until the
// prompt is budgeted.
//
// This module is the SHADOW-mode telemetry layer of SIG-236. It measures
// the per-section token footprint of the constructed logic prompt and
// emits `logic-prompt-budget` events so we can size the actual cuts in
// a follow-up enforce-mode PR informed by real data. Token estimation
// uses `Math.ceil(chars / 4)` (the existing repo convention from
// `diff-packing.ts:14` and `truncateVerdictToTokens`); no tiktoken /
// js-tiktoken dependency — Codex's recommendation in the design doc
// at `.claude/handoff/codex-sig-236-logic-prompt-budget-design.md`.
//
// Three-state env flag `OPENCLAW_LOGIC_PROMPT_BUDGET` (consumed via
// `applyLogicPromptBudget`, which returns the prompt the model receives):
//   off     — no telemetry, no truncation (default)
//   shadow  — measure + emit `logic-prompt-budget` event, but pass
//             the prompt through untouched. Used to size the win.
//   enforce — SIG-287: TRIM the prompt toward `LOGIC_PROMPT_INPUT_TOKEN_CAP`
//             by dropping low-priority sections (`LOGIC_PROMPT_DROP_ORDER`)
//             until it fits, then emit an enforce event with before/after
//             tokens + the dropped sections. This REDUCES the prompt (live
//             #241: 12009 → 8389 tok) but CANNOT reach the 6000 cap: the
//             mandatory floor (diff+graph+deterministic+scaffolding) exceeds
//             it. So the trim alone does NOT make logic available — the actual
//             availability fix is logic's per-attempt timeout bump to 110s
//             (SIG-236, see `SPECIALIST_CONFIGS.logic.perAttemptTimeoutMs`).
//             The trim still helps (less to process → faster), so it stays.
//
// `maybeEmitLogicPromptBudget` (below) is the shadow-only emitter, kept for
// its unit tests + the shadow path; the fan-out calls `applyLogicPromptBudget`.
//
// Output cap (Codex's recommendation: `findings.maxItems: 3-4` on the
// per-role schema) is a separate lever, still deferred — it requires a
// schema variant + JSON-format validation. Input trimming is the bottleneck.

export type LogicPromptBudgetMode = "off" | "shadow" | "enforce"

/**
 * Default cap (input tokens) the eventual enforce mode will target.
 * 6_000 matches Codex's recommendation. Used in shadow telemetry so
 * dashboard queries can flag prompts that would have been over-budget.
 */
export const LOGIC_PROMPT_INPUT_TOKEN_CAP = 6_000

/**
 * Parser for the `OPENCLAW_LOGIC_PROMPT_BUDGET` env flag. Case-
 * insensitive, whitespace-tolerant, defaults to "off" for any unknown
 * / missing value. The default-off safety net matches the pattern of
 * other Sigilix feature flags (see `parseMinSpecialistsEarlyExitMode`,
 * `isSynthBypassEnabled`).
 */
export function parseLogicPromptBudgetMode(
  raw: string | undefined,
): LogicPromptBudgetMode {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "shadow") return "shadow"
  if (v === "enforce") return "enforce"
  return "off"
}

/**
 * Approximate token count from char length. Matches the existing repo
 * convention (`diff-packing.ts:14` + `truncateVerdictToTokens`) so the
 * dashboard's tokenization is consistent across signals.
 *
 * Provider-specific tokenizers (DeepSeek-BPE, Moonshot's variant) would
 * give exact counts but adding `tiktoken` for a heuristic cap is
 * overkill — Codex's call.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.ceil(text.length / 4)
}

/**
 * Section labels we look for in the constructed logic prompt. Each
 * entry is a header marker the prompt builder injects (case-sensitive
 * — these are template literals, not user input). The order is the
 * Codex-recommended drop priority (LOWEST priority dropped FIRST when
 * enforce-mode lands):
 *
 *   1. Changed files diff + hunk context — never drop (mandatory)
 *   2. Direct dependency edges from SIG-138 graph — keep full
 *   3. Top-N symbol retrieval hits (SIG-121) — cap at N=5
 *   4. Graph blast-radius paths — drop content, keep counts
 *   5. Shared Vectorize retrieval (logic gets it on top of #3)
 *   6. Dynamic evidence block
 *
 * The shadow telemetry just measures presence + token count of each
 * section so we can see what's actually contributing to the bloat.
 */
//
// Marker patterns verified against the actual emitters
// (`pr-review-specialists.ts`, `symbol-retrieval.ts`,
// `review-evidence-pack.ts`, `deterministic-checks.ts`) on
// 2026-05-26 per code-reviewer's C1 finding. Most headers carry a
// trailing " — …" descriptor so the regex uses `\b` after the
// section name and is anchored to line-start (or the literal `[`
// for headers that always appear at column 0 inside a code-block-
// less template). A pure `^\[DIFF\]$/m` anchors avoid false-
// positives from code blocks that happen to mention the bracket
// literal in the user's diff.
const PROMPT_SECTION_MARKERS = {
  diff: /^\[DIFF\]$/m,
  graphContext: /^\[GRAPH CONTEXT\b/m,
  // SIG-121's symbol retrieval is merged into the [RETRIEVAL
  // SNAPSHOT] block via mergeLogicSnapshot — the header it actually
  // emits is `[LOGIC SYMBOL CONTEXT`, NOT the originally-assumed
  // `[SYMBOL RETRIEVAL]`. Reviewer caught the marker drift.
  symbolRetrieval: /^\[LOGIC SYMBOL CONTEXT\b/m,
  vectorizeRetrieval: /^\[RETRIEVAL SNAPSHOT\]$/m,
  dynamicEvidence: /^\[DYNAMIC REVIEW EVIDENCE\b/m,
  deterministicChecks: /^\[DETERMINISTIC CHECKS\b/m,
  // CodeRabbit Major (2026-05-26): all six markers now anchored to
  // start-of-line via `^...` + `/m` flag. Without anchoring, a diff
  // body that happens to mention a marker-like literal (e.g. a code
  // comment editing this very file, a user-authored docstring) would
  // false-positive into the section count and skew shadow telemetry.
} as const

export type PromptSectionLabel = keyof typeof PROMPT_SECTION_MARKERS

export interface LogicPromptSectionStats {
  /** Section was detected in the prompt (header marker matched). */
  present: boolean
  /** Approximate token count if present (0 when absent). */
  tokens: number
}

export interface LogicPromptMeasurement {
  /** Whole-prompt token estimate. */
  totalTokens: number
  /** Per-section breakdown via header-marker presence detection. */
  sections: Record<PromptSectionLabel, LogicPromptSectionStats>
  /** True when totalTokens exceeds LOGIC_PROMPT_INPUT_TOKEN_CAP. */
  overCap: boolean
  /** How many tokens over (or under, negative) the cap. */
  overByTokens: number
}

/**
 * Measure the constructed logic prompt's size + per-section
 * breakdown. Pure function; no env / IO. Used by the shadow-mode
 * telemetry emitter to size the enforce-mode cuts.
 *
 * Section measurement is heuristic — we look for header markers
 * (`[GRAPH CONTEXT]`, `[SYMBOL RETRIEVAL]`, etc.) and estimate the
 * section's size as the chars between this marker and the next one
 * (or end-of-string). False negatives (section present but marker
 * format changed) reduce shadow signal quality but don't affect
 * fan-out behavior — shadow-mode never modifies the prompt.
 */
export function measureLogicPrompt(prompt: string): LogicPromptMeasurement {
  const totalTokens = estimateTokens(prompt)
  const sections: Record<PromptSectionLabel, LogicPromptSectionStats> = {
    diff: { present: false, tokens: 0 },
    graphContext: { present: false, tokens: 0 },
    symbolRetrieval: { present: false, tokens: 0 },
    vectorizeRetrieval: { present: false, tokens: 0 },
    dynamicEvidence: { present: false, tokens: 0 },
    deterministicChecks: { present: false, tokens: 0 },
  }

  // Collect (label, startIndex) for each detected section so we can
  // compute span lengths by next-marker - this-marker.
  const hits: Array<{ label: PromptSectionLabel; start: number }> = []
  for (const [label, regex] of Object.entries(PROMPT_SECTION_MARKERS) as Array<[PromptSectionLabel, RegExp]>) {
    const match = regex.exec(prompt)
    if (match !== null) {
      hits.push({ label, start: match.index })
      sections[label].present = true
    }
  }

  // Sort by start position so each section's end is the next section's
  // start. Last section runs to end-of-prompt.
  hits.sort((a, b) => a.start - b.start)
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!
    const nextStart = i + 1 < hits.length ? hits[i + 1]!.start : prompt.length
    sections[hit.label].tokens = estimateTokens(prompt.slice(hit.start, nextStart))
  }

  return {
    totalTokens,
    sections,
    overCap: totalTokens > LOGIC_PROMPT_INPUT_TOKEN_CAP,
    overByTokens: totalTokens - LOGIC_PROMPT_INPUT_TOKEN_CAP,
  }
}

/**
 * Section drop priority for enforce-mode trimming — LOWEST-value first.
 * Shed the heavy, least-precision-relevant context blocks in this order until
 * the prompt fits: dynamic evidence → shared Vectorize retrieval (broad
 * codebase chunks) → symbol retrieval (last resort). The diff, the deterministic
 * AST checks, AND the graph context (`LOGIC_PROMPT_MANDATORY_SECTIONS`) are
 * NEVER dropped — graph is the small, FP-preventing cross-file signal. A
 * context-reduced logic verdict that RETURNS beats a full-context one that
 * times out (the SIG-287 failure mode), but we shed broad retrieval — not the
 * targeted graph/diff context — to keep that tradeoff precision-safe.
 */
export const LOGIC_PROMPT_DROP_ORDER: readonly PromptSectionLabel[] = [
  "dynamicEvidence",
  "vectorizeRetrieval",
  "symbolRetrieval",
]

/**
 * Sections never dropped. Beyond the diff (review target) + deterministic AST
 * checks, `graphContext` is mandatory too: it's the cross-file dependency
 * signal that PREVENTS false positives ("is this called / does this exist") and
 * is empirically small (~200 tok), so keeping it costs almost nothing and
 * shedding it would risk logic flagging issues the graph would refute (Codex
 * MEDIUM + founder's hallucination concern).
 */
export const LOGIC_PROMPT_MANDATORY_SECTIONS: readonly PromptSectionLabel[] = [
  "diff",
  "deterministicChecks",
  "graphContext",
]

/** Any top-level block header line — `[DIFF]`, `[REPO RULES — …]`, `[OUTPUT SCHEMA]`, etc. */
const BLOCK_HEADER = /^\[[A-Z]/gm

/**
 * [start, end) char span of each DETECTED droppable section, sorted by start.
 * A section's `end` is the NEXT top-level block header (recognized OR not), so
 * dropping it removes ONLY its own block — never the trailing `[CODEBASE
 * NAMESPACE …]` / `[REPO RULES — LOGIC]` / `[OUTPUT SCHEMA]` blocks that follow
 * the last recognized section (Codex HIGH: those were being absorbed into the
 * last section's span and silently dropped). Falls back to EOF only when no
 * later header exists.
 */
function computeSectionSpans(
  prompt: string,
): Array<{ label: PromptSectionLabel; start: number; end: number }> {
  // All block-header line positions, ascending (regex scans left→right).
  const headerPositions: number[] = []
  BLOCK_HEADER.lastIndex = 0
  let hm: RegExpExecArray | null
  while ((hm = BLOCK_HEADER.exec(prompt)) !== null) headerPositions.push(hm.index)

  const hits: Array<{ label: PromptSectionLabel; start: number }> = []
  for (const [label, regex] of Object.entries(PROMPT_SECTION_MARKERS) as Array<[PromptSectionLabel, RegExp]>) {
    const match = regex.exec(prompt)
    if (match !== null) hits.push({ label, start: match.index })
  }
  hits.sort((a, b) => a.start - b.start)
  return hits.map((h) => {
    const next = headerPositions.find((p) => p > h.start)
    return { label: h.label, start: h.start, end: next ?? prompt.length }
  })
}

export interface LogicPromptTrimResult {
  /** The (possibly trimmed) prompt. Unchanged when already within cap. */
  prompt: string
  /** Sections dropped, in the order dropped. */
  trimmed: PromptSectionLabel[]
  beforeTokens: number
  afterTokens: number
}

/**
 * ENFORCE-mode trim. Drops whole low-priority sections (LOGIC_PROMPT_DROP_ORDER)
 * until the prompt fits `cap` tokens or only mandatory sections remain. Pure;
 * never mutates input; whole-section removal (not mid-section truncation) so the
 * prompt never ends up structurally malformed. A no-op when already within cap.
 */
export function trimLogicPrompt(
  prompt: string,
  cap: number = LOGIC_PROMPT_INPUT_TOKEN_CAP,
): LogicPromptTrimResult {
  const beforeTokens = estimateTokens(prompt)
  if (beforeTokens <= cap) return { prompt, trimmed: [], beforeTokens, afterTokens: beforeTokens }

  let working = prompt
  const trimmed: PromptSectionLabel[] = []
  for (const label of LOGIC_PROMPT_DROP_ORDER) {
    if (estimateTokens(working) <= cap) break
    // Recompute spans on the CURRENT working string so prior removals don't
    // invalidate indices.
    const span = computeSectionSpans(working).find((s) => s.label === label)
    if (!span) continue
    working = working.slice(0, span.start) + working.slice(span.end)
    trimmed.push(label)
  }
  return { prompt: working, trimmed, beforeTokens, afterTokens: estimateTokens(working) }
}

export interface MaybeEmitLogicPromptBudgetArgs {
  mode: LogicPromptBudgetMode
  prompt: string
  owner: string
  repo: string
  prNumber: number
  headSha: string
}

/**
 * Telemetry-emitter side-effect helper. No-op when mode === "off"; in
 * shadow / enforce mode emits a `logic-prompt-budget` event with the
 * full per-section breakdown so the dashboard can size the enforce
 * cuts. Does NOT modify the prompt — truncation is a separate concern
 * deferred to a follow-up PR.
 *
 * `enforce` mode is currently a synonym for `shadow` at the runtime
 * level — the event's `mode` field reports `"enforce-pending"` so an
 * accidental flip to enforce is observable (and harmless — the prompt
 * still passes through untouched).
 *
 * Catches its own console.log throws so a degenerate JSON shape can't
 * abort the fan-out path.
 */
export function maybeEmitLogicPromptBudget(args: MaybeEmitLogicPromptBudgetArgs): void {
  if (args.mode === "off") return

  try {
    const measurement = measureLogicPrompt(args.prompt)
    const effectiveMode = args.mode === "enforce" ? "enforce-pending" : "shadow"
    console.log(JSON.stringify({
      event: "logic-prompt-budget",
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      headSha: args.headSha.slice(0, 7),
      mode: effectiveMode,
      capTokens: LOGIC_PROMPT_INPUT_TOKEN_CAP,
      totalTokens: measurement.totalTokens,
      overCap: measurement.overCap,
      overByTokens: measurement.overByTokens,
      sections: measurement.sections,
    }))
  } catch (err) {
    console.error(JSON.stringify({
      event: "logic-prompt-budget-emit-failed",
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      reason: err instanceof Error ? err.message : String(err),
    }))
  }
}

/**
 * SIG-287/SIG-236 enforce: the single entry point the fan-out uses for the
 * logic prompt. Returns the prompt the model should actually receive:
 *   off     — passthrough, no telemetry.
 *   shadow  — passthrough, emit the measurement (sizing) event.
 *   enforce — TRIM to the cap (drop low-priority sections), emit an enforce
 *             event with before/after + trimmed sections, return the trimmed
 *             prompt.
 * Instrumentation MUST NOT break the fan-out: any throw falls back to the
 * ORIGINAL prompt (logic still runs, just un-trimmed).
 */
export function applyLogicPromptBudget(args: MaybeEmitLogicPromptBudgetArgs): string {
  if (args.mode === "off") return args.prompt
  if (args.mode === "shadow") {
    maybeEmitLogicPromptBudget(args)
    return args.prompt
  }
  // enforce
  try {
    const trim = trimLogicPrompt(args.prompt)
    console.log(JSON.stringify({
      event: "logic-prompt-budget",
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      headSha: args.headSha.slice(0, 7),
      mode: "enforce",
      capTokens: LOGIC_PROMPT_INPUT_TOKEN_CAP,
      beforeTokens: trim.beforeTokens,
      afterTokens: trim.afterTokens,
      overCap: trim.afterTokens > LOGIC_PROMPT_INPUT_TOKEN_CAP,
      trimmed: trim.trimmed,
    }))
    return trim.prompt
  } catch (err) {
    console.error(JSON.stringify({
      event: "logic-prompt-budget-enforce-failed",
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      reason: err instanceof Error ? err.message : String(err),
    }))
    return args.prompt // fail-open: logic runs with the un-trimmed prompt
  }
}
